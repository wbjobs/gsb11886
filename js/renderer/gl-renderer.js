/* GLRenderer: WebGL2 deferred-style screen-space pipeline with quality levels,
   benchmarking and auto degradation. Falls back to a WebGL1 forward path that
   skips all post-processing (降级到无后期). */
(function (global) {
  "use strict";

  const LEVELS = [
    { name: "L0 无后期", scale: 1.0, ssr: false, ssao: false, dof: false, motion: false,
      ssrSteps: 0, ssaoSamples: 0, dofTaps: 0, motionSamples: 0 },
    { name: "L1 低（半分辨率）", scale: 0.5, ssr: true, ssao: true, dof: true, motion: true,
      ssrSteps: 16, ssaoSamples: 8, dofTaps: 12, motionSamples: 4 },
    { name: "L2 中", scale: 0.75, ssr: true, ssao: true, dof: true, motion: true,
      ssrSteps: 28, ssaoSamples: 16, dofTaps: 20, motionSamples: 8 },
    { name: "L3 高", scale: 1.0, ssr: true, ssao: true, dof: true, motion: true,
      ssrSteps: 40, ssaoSamples: 28, dofTaps: 24, motionSamples: 12 },
  ];

  const DEFAULTS = {
    scene: "cornell",
    level: 3,
    autoDegrade: true,
    effects: { ssr: true, ssao: true, dof: true, motion: true },
    ssr: { steps: 32, thickness: 0.06, maxDist: 12, roughBlur: 1.0, intensity: 1.0 },
    ssao: { samples: 16, radius: 0.8, bias: 0.025, power: 2.0 },
    dof: { focus: 6.0, aperture: 1.2, range: 1.6, auto: false },
    motion: { samples: 8, strength: 1.0 },
    debug: 0,
    exposure: 1.0,
  };

  const GL = () => {
    const c = (typeof WebGL2RenderingContext !== "undefined") ? WebGL2RenderingContext : null;
    return c;
  };

  class GLRenderer {
    constructor(canvas, opts) {
      this.canvas = canvas;
      this.onStats = opts.onStats || function () {};
      this.onEvent = opts.onEvent || function () {};
      this.params = JSON.parse(JSON.stringify(DEFAULTS));
      this.level = this.params.level;

      this.time = 0;
      this.running = true;
      this._bench = null;
      this._fpsAccum = { frames: 0, ms: 0, since: 0, lowWindows: 0, lastDrop: 0 };

      this.ctxLost = false;
      this._tryInit();
    }

    _tryInit() {
      const attrs = { antialias: false, depth: false, stencil: false,
                      alpha: false, powerPreference: "high-performance",
                      preserveDrawingBuffer: false };
      let gl = this.canvas.getContext("webgl2", attrs);
      this.webgl2 = !!gl;
      if (gl) {
        this.floatExt = gl.getExtension("EXT_color_buffer_float");
        if (!this.floatExt) {
          // RGBA16F 不可写时仍可跑（回退到 RGBA8），精度下降但不中断。
          this.onEvent({ type: "warn", message: "不支持 EXT_color_buffer_float，HDR 精度下降" });
        }
        this.gl = gl;
        this._initWebGL2();
      } else {
        gl = this.canvas.getContext("webgl", attrs) ||
             this.canvas.getContext("experimental-webgl", attrs);
        if (!gl) throw new Error("当前浏览器不支持 WebGL");
        this.gl = gl;
        this.webgl2 = false;
        this._initLegacy();
      }
      this._bindContextLoss();
    }

    _bindContextLoss() {
      this.canvas.addEventListener("webglcontextlost", (e) => {
        e.preventDefault();
        this.ctxLost = true;
        this.onEvent({ type: "warn", message: "WebGL 上下文丢失，已暂停" });
      });
      this.canvas.addEventListener("webglcontextrestored", () => {
        this.ctxLost = false;
        this._tryInit();
      });
    }

    // ------------------------------------------------------------ WebGL2 初始化
    _initWebGL2() {
      const gl = this.gl;
      this.programs = {};
      this._buildPrograms();
      this._buildNoise();
      this._buildKernels();
      this._quadVAO = gl.createVertexArray();
      this.camera = new global.Camera();
      this.camera.useScene(this.params.scene);
      this.camera.autoOrbit = true;
      this.resize(this.canvas.clientWidth, this.canvas.clientHeight, 1);
    }

    _compile(vsSrc, fsSrc) {
      const gl = this.gl;
      const compile = (type, src) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
          const log = gl.getShaderInfoLog(sh);
          gl.deleteShader(sh);
          throw new Error("着色器编译失败: " + log);
        }
        return sh;
      };
      const vs = compile(gl.VERTEX_SHADER, vsSrc);
      const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
      const p = gl.createProgram();
      gl.attachShader(p, vs);
      gl.attachShader(p, fs);
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        throw new Error("程序链接失败: " + gl.getProgramInfoLog(p));
      }
      gl.deleteShader(vs);
      gl.deleteShader(fs);

      const prog = { handle: p, uniforms: {} };
      const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) {
        const info = gl.getActiveUniform(p, i);
        const name = info.name.replace(/\[0\]$/, "");
        prog.uniforms[name] = gl.getUniformLocation(p, name);
      }
      return prog;
    }

    _buildPrograms() {
      const S = global.PostShaders;
      const G = global.GBufferShaders;
      this.programs.gbuffer = this._compile(G.VERT, G.FRAG);
      this.programs.ssao = this._compile(S.POST_VERT, S.SSAO_FRAG);
      this.programs.blur = this._compile(S.POST_VERT, S.BLUR_FRAG);
      this.programs.ssr = this._compile(S.POST_VERT, S.SSR_FRAG);
      this.programs.dof = this._compile(S.POST_VERT, S.DOF_FRAG);
      this.programs.motion = this._compile(S.POST_VERT, S.MOTION_FRAG);
      this.programs.output = this._compile(S.POST_VERT, S.OUTPUT_FRAG);
    }

    _buildNoise() {
      const gl = this.gl;
      const size = 4;
      const data = new Uint8Array(size * size * 4);
      let seed = 1234;
      const rnd = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      for (let i = 0; i < size * size; i++) {
        // SSAO 旋转噪声：x/y 为随机向量，z 不使用。
        const a = rnd() * Math.PI * 2;
        data[i * 4] = Math.round((Math.cos(a) * 0.5 + 0.5) * 255);
        data[i * 4 + 1] = Math.round((Math.sin(a) * 0.5 + 0.5) * 255);
        data[i * 4 + 2] = 0;
        data[i * 4 + 3] = 255;
      }
      this.noiseTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.noiseTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    }

    _buildKernels() {
      const n = 32;
      this.ssaoKernel = new Float32Array(n * 3);
      let seed = 9876;
      const rnd = () => {
        seed = (seed * 1664525 + 1013904223) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      for (let i = 0; i < n; i++) {
        let x = rnd() * 2 - 1, y = rnd() * 2 - 1, z = rnd();
        const len = Math.hypot(x, y, z);
        x /= len; y /= len; z /= len;
        // 核偏向近点，分布更平滑。
        const scale = i / n;
        const k = scale * scale * 0.9 + 0.1;
        this.ssaoKernel[i * 3] = x * k;
        this.ssaoKernel[i * 3 + 1] = y * k;
        this.ssaoKernel[i * 3 + 2] = z * k;
      }
    }

    // ------------------------------------------------------------ FBO / 资源
    _createTarget(w, h, internal, format, type, filter) {
      const gl = this.gl;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return tex;
    }

    _destroyTarget(tex) {
      if (tex) this.gl.deleteTexture(tex);
    }

    resize(cssW, cssH, dpr) {
      dpr = Math.min(dpr || 1, 2);
      this.cssW = Math.max(2, Math.round(cssW));
      this.cssH = Math.max(2, Math.round(cssH));
      this.dpr = dpr;
      if (!this.webgl2) {
        this.canvas.width = this.cssW;
        this.canvas.height = this.cssH;
        return;
      }
      this._releaseFBOs();
      this._buildFBOs();
    }

    _releaseFBOs() {
      const gl = this.gl;
      if (!this.targets) return;
      const t = this.targets;
      [t.color, t.data0, t.data1, t.ao, t.aoBlur, t.pingA, t.pingB]
        .forEach((tex) => this._destroyTarget(tex));
      [t.gbuf, t.fboAO, t.fboBlur, t.pingFboA, t.pingFboB]
        .forEach((f) => f && gl.deleteFramebuffer(f));
      this.targets = null;
    }

    _buildFBOs() {
      const gl = this.gl;
      const scale = LEVELS[this.level].scale;
      const W = Math.max(2, Math.round(this.cssW * this.dpr * scale));
      const H = Math.max(2, Math.round(this.cssH * this.dpr * scale));
      this.bufW = W;
      this.bufH = H;
      this.canvas.width = W;
      this.canvas.height = H;

      const hdr = this.floatExt
        ? { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT }
        : { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };

      const mk = (spec, filter) =>
        this._createTarget(W, H, spec.internal, spec.format, spec.type, filter || gl.LINEAR);
      const color = mk(hdr);
      const dataSpec = this.floatExt
        ? { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT }
        : { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
      const data0 = mk(dataSpec, gl.NEAREST);
      const data1 = mk(dataSpec, gl.NEAREST);

      const gbuf = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, gbuf);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, data0, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, data1, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        // MRT+float 组合在极个别驱动上失败：放弃 HDR，整体回 RGBA8。
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        this._destroyTarget(color); this._destroyTarget(data0); this._destroyTarget(data1);
        gl.deleteFramebuffer(gbuf);
        this.floatExt = null;
        return this._buildFBOs();
      }

      const ao = this._createTarget(W, H, gl.R8, gl.RED, gl.UNSIGNED_BYTE, gl.NEAREST);
      const aoBlur = this._createTarget(W, H, gl.R8, gl.RED, gl.UNSIGNED_BYTE, gl.LINEAR);
      const fboAO = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboAO);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, ao, 0);
      const fboBlur = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboBlur);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, aoBlur, 0);

      const pingA = mk(hdr);
      const pingB = mk(hdr);
      const pingFboA = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, pingFboA);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pingA, 0);
      const pingFboB = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, pingFboB);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pingB, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      this.targets = {
        color, data0, data1, ao, aoBlur, pingA, pingB,
        gbuf, fboAO, fboBlur, pingFboA, pingFboB,
      };
      // 默认 AO 为全亮，AO 关闭时 output 读到的遮蔽恒为 1。
      this._fillWhiteAO();
    }

    _fillWhiteAO() {
      const gl = this.gl;
      const t = this.targets;
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fboBlur);
      gl.clearColor(1, 1, 1, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    setLevel(level) {
      level = Math.max(0, Math.min(LEVELS.length - 1, level | 0));
      if (level === this.level && this.targets) return;
      this.level = level;
      this.params.level = level;
      if (this.webgl2) this._buildFBOs();
    }
    // ------------------------------------------------------------ 每帧调度
    _u(prog, name) { return prog.uniforms[name]; }

    _setSceneUniforms(prog, frame, moveVel) {
      const gl = this.gl;
      const C2 = global.ShaderChunks;
      const max = C2.MAX_OBJ;
      const a = new Float32Array(max * 4);
      const b = new Float32Array(max * 4);
      const col = new Float32Array(max * 4);
      const mat = new Float32Array(max * 4);
      frame.objs.forEach((o, i) => {
        a[i * 4] = o.pos[0]; a[i * 4 + 1] = o.pos[1]; a[i * 4 + 2] = o.pos[2];
        a[i * 4 + 3] = o.type;
        b[i * 4] = o.size[0]; b[i * 4 + 1] = o.size[1]; b[i * 4 + 2] = o.size[2];
        b[i * 4 + 3] = o.radius;
        col[i * 4] = o.color[0]; col[i * 4 + 1] = o.color[1];
        col[i * 4 + 2] = o.color[2]; col[i * 4 + 3] = o.metal;
        mat[i * 4] = o.rough; mat[i * 4 + 1] = o.emissive;
      });
      gl.uniform1i(this._u(prog, "uObjCount"), frame.objs.length);
      gl.uniform1i(this._u(prog, "uMoveId"), frame.moveId);
      gl.uniform3fv(this._u(prog, "uMoveVel"), moveVel);
      gl.uniform4fv(this._u(prog, "uObjA"), a);
      gl.uniform4fv(this._u(prog, "uObjB"), b);
      gl.uniform4fv(this._u(prog, "uObjColor"), col);
      gl.uniform4fv(this._u(prog, "uObjMat"), mat);
    }

    _drawTri() { this.gl.drawArrays(this.gl.TRIANGLES, 0, 3); }

    _gbufferPass(frame, dt, moveVel, benchDrift) {
      const gl = this.gl;
      const cam = this.camera;
      cam.update(dt, this.bufW / this.bufH, benchDrift);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets.gbuf);
      gl.viewport(0, 0, this.bufW, this.bufH);
      const prog = this.programs.gbuffer;
      gl.useProgram(prog.handle);
      gl.uniformMatrix4fv(this._u(prog, "uView"), false, cam.view);
      gl.uniformMatrix4fv(this._u(prog, "uProj"), false, cam.proj);
      gl.uniformMatrix4fv(this._u(prog, "uVP"), false, cam.vp);
      gl.uniformMatrix4fv(this._u(prog, "uPrevVP"), false, cam.prevVP);
      gl.uniform3fv(this._u(prog, "uCamPos"), cam.eye);
      gl.uniform3fv(this._u(prog, "uCamRight"), cam.right);
      gl.uniform3fv(this._u(prog, "uCamUp"), cam.up);
      gl.uniform3fv(this._u(prog, "uCamFwd"), cam.fwd);
      gl.uniform2f(this._u(prog, "uFrustum"), Math.tan(cam.fov / 2), this.bufW / this.bufH);
      gl.uniform1f(this._u(prog, "uTime"), this.time);
      gl.uniform1f(this._u(prog, "uDt"), dt);
      this._setSceneUniforms(prog, frame, moveVel);
      gl.activeTexture(gl.TEXTURE0);
      this._drawTri();

      // 相机 NDC 速度：当前眼位置投影到上一帧 VP。
      const prevEye = cam.lastEye;
      const cur = global.Mat4.transformVec3(cam.vp, cam.eye, true);
      const prv = global.Mat4.transformVec3(cam.prevVP, prevEye, true);
      this.camNdcVel = [cur[0] - prv[0], cur[1] - prv[1]];
      cam.commitPrev();
    }

    _ssaoPass() {
      const gl = this.gl;
      const t = this.targets;
      const p = this.params.ssao;

      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fboAO);
      gl.viewport(0, 0, this.bufW, this.bufH);
      const prog = this.programs.ssao;
      gl.useProgram(prog.handle);
      gl.uniform1i(this._u(prog, "uTexNoise"), 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.noiseTex);
      gl.uniform1i(this._u(prog, "uTexData0"), 1);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, t.data0);
      gl.uniform2f(this._u(prog, "uTexel"), 1 / this.bufW, 1 / this.bufH);
      gl.uniformMatrix4fv(this._u(prog, "uProj"), false, this.camera.proj);
      gl.uniformMatrix4fv(this._u(prog, "uInvProj"), false, global.Mat4.invert(this.camera.proj));
      gl.uniform3fv(this._u(prog, "uSamples"), this.ssaoKernel);
      gl.uniform2f(this._u(prog, "uNoiseScale"), this.bufW / 4, this.bufH / 4);
      gl.uniform1f(this._u(prog, "uRadius"), p.radius);
      gl.uniform1f(this._u(prog, "uBias"), p.bias);
      gl.uniform1f(this._u(prog, "uPower"), p.power);
      gl.uniform1i(this._u(prog, "uSampleCount"), p.samples | 0);
      gl.uniform1f(this._u(prog, "uTime"), this.time);
      this._drawTri();

      // 双边模糊：模糊结果写入 aoBlur，合成阶段只读它。
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fboBlur);
      const bp = this.programs.blur;
      gl.useProgram(bp.handle);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, t.ao);
      gl.uniform1i(this._u(bp, "uTexAO"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, t.data0);
      gl.uniform1i(this._u(bp, "uTexData0"), 1);
      gl.uniform2f(this._u(bp, "uTexel"), 1 / this.bufW, 1 / this.bufH);
      this._drawTri();
    }

    _ssrPass(dstFbo, dstTex, ssaoEnabled) {
      const gl = this.gl;
      const t = this.targets;
      const p = this.params.ssr;
      gl.bindFramebuffer(gl.FRAMEBUFFER, dstFbo);
      gl.viewport(0, 0, this.bufW, this.bufH);
      const prog = this.programs.ssr;
      gl.useProgram(prog.handle);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, t.color);
      gl.uniform1i(this._u(prog, "uTexColor"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, t.data0);
      gl.uniform1i(this._u(prog, "uTexData0"), 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, t.data1);
      gl.uniform1i(this._u(prog, "uTexData1"), 2);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, ssaoEnabled ? t.aoBlur : this._whiteView());
      gl.uniform1i(this._u(prog, "uTexAO"), 3);

      gl.uniform2f(this._u(prog, "uTexel"), 1 / this.bufW, 1 / this.bufH);
      gl.uniformMatrix4fv(this._u(prog, "uProj"), false, this.camera.proj);
      gl.uniformMatrix4fv(this._u(prog, "uInvProj"), false, global.Mat4.invert(this.camera.proj));
      gl.uniform2fv(this._u(prog, "uCameraVel"), this.camNdcVel || [0, 0]);
      gl.uniform1f(this._u(prog, "uTime"), this.time);
      gl.uniform1i(this._u(prog, "uSteps"), p.steps | 0);
      gl.uniform1i(this._u(prog, "uBinarySteps"), 5);
      gl.uniform1f(this._u(prog, "uThickness"), p.thickness);
      gl.uniform1f(this._u(prog, "uMaxDist"), p.maxDist);
      gl.uniform1f(this._u(prog, "uRoughBlur"), p.roughBlur);
      gl.uniform1f(this._u(prog, "uIntensity"), p.intensity);
      gl.uniform1i(this._u(prog, "uEnableAO"), ssaoEnabled ? 1 : 0);
      this._drawTri();
    }


    _whiteView() {
      const gl = this.gl;
      if (this._whiteTex) return this._whiteTex;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE,
                    new Uint8Array([255]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      this._whiteTex = tex;
      return tex;
    }
    _dofPass(srcFbo, srcTex, dstFbo) {
      const gl = this.gl;
      const t = this.targets;
      const p = this.params.dof;
      gl.bindFramebuffer(gl.FRAMEBUFFER, dstFbo);
      gl.viewport(0, 0, this.bufW, this.bufH);
      const prog = this.programs.dof;
      gl.useProgram(prog.handle);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.uniform1i(this._u(prog, "uTexColor"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, t.data0);
      gl.uniform1i(this._u(prog, "uTexData0"), 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, t.data1);
      gl.uniform1i(this._u(prog, "uTexData1"), 2);
      gl.uniform2f(this._u(prog, "uTexel"), 1 / this.bufW, 1 / this.bufH);
      gl.uniformMatrix4fv(this._u(prog, "uProj"), false, this.camera.proj);
      gl.uniformMatrix4fv(this._u(prog, "uInvProj"), false, global.Mat4.invert(this.camera.proj));
      gl.uniform2fv(this._u(prog, "uCameraVel"), this.camNdcVel || [0, 0]);
      gl.uniform1f(this._u(prog, "uTime"), this.time);
      gl.uniform1f(this._u(prog, "uFocus"), p.focus);
      gl.uniform1f(this._u(prog, "uAperture"), p.aperture);
      gl.uniform1f(this._u(prog, "uFocusRange"), p.range);
      gl.uniform2f(this._u(prog, "uCenterUv"), 0.5, 0.5);
      gl.uniform1i(this._u(prog, "uAutoFocus"), p.auto ? 1 : 0);
      this._drawTri();
    }

    _motionPass(srcTex, dstFbo) {
      const gl = this.gl;
      const t = this.targets;
      const p = this.params.motion;
      gl.bindFramebuffer(gl.FRAMEBUFFER, dstFbo);
      gl.viewport(0, 0, this.bufW, this.bufH);
      const prog = this.programs.motion;
      gl.useProgram(prog.handle);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.uniform1i(this._u(prog, "uTexColor"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, t.data0);
      gl.uniform1i(this._u(prog, "uTexData0"), 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, t.data1);
      gl.uniform1i(this._u(prog, "uTexData1"), 2);
      gl.uniform2f(this._u(prog, "uTexel"), 1 / this.bufW, 1 / this.bufH);
      gl.uniformMatrix4fv(this._u(prog, "uProj"), false, this.camera.proj);
      gl.uniformMatrix4fv(this._u(prog, "uInvProj"), false, global.Mat4.invert(this.camera.proj));
      gl.uniform2fv(this._u(prog, "uCameraVel"), this.camNdcVel || [0, 0]);
      gl.uniform1f(this._u(prog, "uTime"), this.time);
      gl.uniform1i(this._u(prog, "uSamples"), p.samples | 0);
      gl.uniform1f(this._u(prog, "uStrength"), p.strength);
      this._drawTri();
    }

    _outputPass(srcTex, isHdr) {
      const gl = this.gl;
      const t = this.targets;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.bufW, this.bufH);
      const prog = this.programs.output;
      gl.useProgram(prog.handle);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.uniform1i(this._u(prog, "uTexColor"), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, t.data0);
      gl.uniform1i(this._u(prog, "uTexData0"), 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, t.data1);
      gl.uniform1i(this._u(prog, "uTexData1"), 2);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, t.aoBlur);
      gl.uniform1i(this._u(prog, "uTexAO"), 3);
      // 基础着色调试：强制读取 G-buffer HDR 原色。
      const debug = this.params.debug === 7 ? 0 : this.params.debug;
      gl.uniform1i(this._u(prog, "uDebug"), debug);
      gl.uniform1f(this._u(prog, "uExposure"), this.params.exposure);
      this._drawTri();
    }

    _renderFrameWebGL2(dt, benchDrift) {
      const gl = this.gl;
      const lv = LEVELS[this.level];
      const fx = this.params.effects;
      const t = this.targets;
      const frame = global.ScreenspaceScenes.buildFrame(this.params.scene, this.time);
      const moveVel = frame.vel;

      // 跑分期间由质量档位统一采样预算，保证 L0→L3 对照唯一变量是档位。
      if (this._bench) {
        if (lv.ssrSteps) this.params.ssr.steps = lv.ssrSteps;
        if (lv.ssaoSamples) this.params.ssao.samples = lv.ssaoSamples;
        if (lv.motionSamples) this.params.motion.samples = lv.motionSamples;
      }

      this._gbufferPass(frame, dt, moveVel, benchDrift);

      const ssaoOn = lv.ssao && fx.ssao;
      const ssrOn = lv.ssr && fx.ssr;
      const dofOn = lv.dof && fx.dof;
      const motionOn = lv.motion && fx.motion;

      if (ssaoOn) this._ssaoPass();
      else this._fillWhiteAO();
      this._savedIntensity = this.params.ssr.intensity;

      // 颜色 ping-pong：两块浮点纹理交替作为读/写目标，杜绝同纹理读写。
      const bufA = { tex: t.pingA, fbo: t.pingFboA };
      const bufB = { tex: t.pingB, fbo: t.pingFboB };
      let src = { tex: t.color, fbo: t.gbuf };
      let dst = bufA;

      if (ssrOn || ssaoOn) {
        if (!ssrOn) this.params.ssr.intensity = 0;
        this._ssrPass(dst.fbo, dst.tex, ssaoOn);
        if (!ssrOn) this.params.ssr.intensity = this._savedIntensity;
        const used = dst;
        src = used;
        dst = (used === bufA) ? bufB : bufA;
      }

      if (dofOn) {
        this._dofPass(null, src.tex, dst.fbo);
        const used = dst;
        dst = src; src = used;
      }

      if (motionOn) {
        this._motionPass(src.tex, dst.fbo);
        const used = dst;
        dst = src; src = used;
      }

      let outTex = src.tex;
      if (this.params.debug === 7) outTex = t.color;
      this._outputPass(outTex, true);
    }
    // ------------------------------------------------------------ WebGL1 降级
    _initLegacy() {
      const gl = this.gl;
      const L = global.LegacyShaders;
      const vs = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vs, L.VERT);
      gl.compileShader(vs);
      const fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, L.FRAG);
      gl.compileShader(fs);
      const p = gl.createProgram();
      gl.attachShader(p, vs);
      gl.attachShader(p, fs);
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        throw new Error("WebGL1 降级程序链接失败: " + gl.getProgramInfoLog(p));
      }
      this.legacyProg = p;
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(p, "aPos");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

      this.camera = new global.Camera();
      this.camera.useScene(this.params.scene);
      this.legacyLoc = {};
      ["uCamPos", "uCamRight", "uCamUp", "uCamFwd", "uFrustum", "uTime",
       "uObjCount", "uObjA", "uObjB", "uObjColor", "uObjMat"].forEach((n) => {
        this.legacyLoc[n] = gl.getUniformLocation(p, n);
      });
    }

    _renderFrameLegacy(dt) {
      const gl = this.gl;
      const W = this.canvas.width, H = this.canvas.height;
      this.camera.update(dt, W / H, false);
      this.camera.commitPrev();
      gl.viewport(0, 0, W, H);
      gl.useProgram(this.legacyProg);
      const U = this.legacyLoc;
      gl.uniform3fv(U.uCamPos, this.camera.eye);
      gl.uniform3fv(U.uCamRight, this.camera.right);
      gl.uniform3fv(U.uCamUp, this.camera.up);
      gl.uniform3fv(U.uCamFwd, this.camera.fwd);
      gl.uniform2f(U.uFrustum, Math.tan(this.camera.fov / 2), W / H);
      gl.uniform1f(U.uTime, this.time);

      const frame = global.ScreenspaceScenes.buildFrame(this.params.scene, this.time);
      const max = global.LegacyShaders.MAX_OBJ;
      const a = new Float32Array(max * 4), b = new Float32Array(max * 4);
      const col = new Float32Array(max * 4), mat = new Float32Array(max * 4);
      frame.objs.forEach((o, i) => {
        a[i * 4] = o.pos[0]; a[i * 4 + 1] = o.pos[1]; a[i * 4 + 2] = o.pos[2];
        a[i * 4 + 3] = o.type;
        b[i * 4] = o.size[0]; b[i * 4 + 1] = o.size[1]; b[i * 4 + 2] = o.size[2];
        b[i * 4 + 3] = o.radius;
        col[i * 4] = o.color[0]; col[i * 4 + 1] = o.color[1];
        col[i * 4 + 2] = o.color[2]; col[i * 4 + 3] = o.metal;
        mat[i * 4] = o.rough; mat[i * 4 + 1] = o.emissive;
      });
      gl.uniform1i(U.uObjCount, frame.objs.length);
      gl.uniform4fv(U.uObjA, a);
      gl.uniform4fv(U.uObjB, b);
      gl.uniform4fv(U.uObjColor, col);
      gl.uniform4fv(U.uObjMat, mat);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // ------------------------------------------------------------ 公共 API
    setParams(patch) {
      const merge = (dst, src) => {
        Object.keys(src || {}).forEach((k) => {
          if (dst[k] && typeof dst[k] === "object" && !Array.isArray(dst[k]) &&
              typeof src[k] === "object") {
            merge(dst[k], src[k]);
          } else dst[k] = src[k];
        });
      };
      merge(this.params, patch);
      if (patch.scene && this.camera) this.camera.useScene(patch.scene);
      if (typeof patch.level === "number") this.setLevel(patch.level);
    }

    getParams() { return JSON.parse(JSON.stringify(this.params)); }

    pickFocus(uPx, uPy) {
      // uPx/uPy: 相对画布的 0..1 坐标，y 向上。返回线性深度（天空返回 null）。
      if (!this.webgl2 || !this.targets) return null;
      const gl = this.gl;
      const x = Math.floor(uPx * this.bufW);
      const y = Math.floor((1 - uPy) * this.bufH);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets.gbuf);
      let depth = 0;
      if (this.floatExt) {
        const buf = new Float32Array(4);
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, buf);
        depth = buf[2];
      } else {
        // RGBA8 回退：深度没有专门通道，用 data1 无法得到线性深度，
        // 此时取焦退化为不支持并提示调用方。
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return null;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (!depth || depth < 0.01) return null;
      this.params.dof.focus = Math.round(depth * 10) / 10;
      return depth;
    }

    frame(dt) {
      if (this.ctxLost) return null;
      dt = Math.min(Math.max(dt, 1 / 240), 0.1);
      this.time += dt;
      const benchDrift = !!(this._bench && this._bench.drift);
      const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
      if (this.webgl2) this._renderFrameWebGL2(dt, benchDrift);
      else this._renderFrameLegacy(dt);
      const t1 = (typeof performance !== "undefined" ? performance.now() : Date.now());
      const ms = t1 - t0;
      this._trackFps(ms, dt);
      return { ms, dt };
    }
    // ------------------------------------------------------------ FPS / 降级
    _trackFps(ms, dt) {
      if (this._bench) return; // 跑分期间不做自动降级与统计污染
      const a = this._fpsAccum;
      a.frames++;
      a.ms += ms;
      a.since += dt;
      if (a.since >= 1.0) {
        const fps = a.frames / a.since;
        const avgMs = a.ms / a.frames;
        this.onStats({ fps, frameMs: avgMs, passes: this._passCount(), level: this.level });
        a.frames = 0; a.ms = 0; a.since = 0;

        if (this.params.autoDegrade && this.webgl2 && this.level > 0) {
          const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
          if (fps < 45) {
            a.lowWindows++;
            if (a.lowWindows >= 2 && now - a.lastDrop > 2500) {
              a.lastDrop = now;
              a.lowWindows = 0;
              this.setLevel(this.level - 1);
              this.onEvent({
                type: "degrade",
                message: "持续低于 45fps，已自动降级到 " + LEVELS[this.level].name,
                level: this.level,
              });
            }
          } else {
            a.lowWindows = 0;
          }
        }
      }
    }

    _passCount() {
      if (!this.webgl2) return 1;
      const lv = LEVELS[this.level];
      const fx = this.params.effects;
      let n = 1; // gbuffer
      if (lv.ssao && fx.ssao) n += 2;
      if (lv.ssr && fx.ssr) n += 1;
      if (lv.dof && fx.dof) n += 1;
      if (lv.motion && fx.motion) n += 1;
      n += 1; // output
      return n;
    }

    // ------------------------------------------------------------ Benchmark
    // 依次测试 L0..L3，每级 warmup 60 帧 + 测量 240 帧；期间自动环绕强制开启。
    startBenchmark() {
      const saved = {
        level: this.level,
        autoDegrade: this.params.autoDegrade,
        autoOrbit: this.camera.autoOrbit,
        effects: JSON.parse(JSON.stringify(this.params.effects)),
        ssrSteps: this.params.ssr.steps,
        ssaoSamples: this.params.ssao.samples,
        motionSamples: this.params.motion.samples,
      };
      this._benchSaved = saved;
      this.params.autoDegrade = false;
      this.camera.autoOrbit = false;
      this._bench = {
        level: 0, phase: "warmup", frames: 0, warmup: 60, measure: 240,
        msSum: 0, results: [], t0: performance.now(), drift: true,
      };
      this._levelOverride = true;
      this.setLevel(0);
      this.params.effects = { ssr: true, ssao: true, dof: true, motion: true };
      this.onEvent({ type: "bench-start" });
    }

    // 返回 null 表示未完成，返回数组表示跑分结束。
    stepBenchmark(ms) {
      const b = this._bench;
      if (!b) return null;
      b.frames++;
      if (b.phase === "warmup") {
        if (b.frames >= b.warmup) { b.phase = "measure"; b.frames = 0; b.msSum = 0; }
        return null;
      }
      b.msSum += ms;
      this.onEvent({
        type: "bench-progress",
        level: b.level,
        frames: b.frames,
        total: b.measure,
      });
      if (b.frames < b.measure) return null;

      const avgMs = b.msSum / b.measure;
      const fxAll = { ssr: true, ssao: true, dof: true, motion: true };
      const lv0 = LEVELS[b.level];
      const passes = 1 + (lv0.ssao ? 2 : 0) + (lv0.ssr ? 1 : 0) +
                    (lv0.dof ? 1 : 0) + (lv0.motion ? 1 : 0) + 1;
      b.results.push({
        level: b.level,
        name: LEVELS[b.level].name,
        fps: 1000 / avgMs,
        frameMs: avgMs,
        passes,
        scale: LEVELS[b.level].scale,
        ssrSteps: LEVELS[b.level].ssrSteps,
        ssaoSamples: LEVELS[b.level].ssaoSamples,
        motionSamples: LEVELS[b.level].motionSamples,
      });
      if (b.level < LEVELS.length - 1) {
        b.level++;
        b.phase = "warmup";
        b.frames = 0;
        this.setLevel(b.level);
        return null;
      }
      const results = b.results;
      this._finishBenchmark();
      return results;
    }

    _finishBenchmark() {
      const s = this._benchSaved;
      this._bench = null;
      this.params.autoDegrade = s.autoDegrade;
      this.camera.autoOrbit = s.autoOrbit;
      this.params.effects = s.effects;
      this.params.ssr.steps = s.ssrSteps;
      this.params.ssao.samples = s.ssaoSamples;
      this.params.motion.samples = s.motionSamples;
      this.setLevel(s.level);
      this.onEvent({ type: "bench-end" });
    }

    cancelBenchmark() {
      if (this._bench) this._finishBenchmark();
    }

    isBenchmarking() { return !!this._bench; }

    setAutoOrbit(v) {
      if (this.camera && !(this._bench)) this.camera.autoOrbit = !!v;
    }

    orbit(dx, dy) { if (this.camera) this.camera.orbit(dx, dy); }
    zoom(d) { if (this.camera) this.camera.zoom(d); }

    dispose() {
      if (this.webgl2 && this.targets) this._releaseFBOs();
      const lose = this.gl.getExtension("WEBGL_lose_context");
      if (lose) lose.loseContext();
    }
  }
  global.GLRenderer = GLRenderer;
  global.RENDER_LEVELS = LEVELS;
  global.RENDER_DEFAULTS = DEFAULTS;
})(typeof self !== "undefined" ? self : this);
