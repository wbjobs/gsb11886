/* Post-processing programs: SSAO, bilateral blur, SSR, DoF, motion blur, output. */
(function (global) {
  "use strict";
  const C = global.ShaderChunks;

  const POST_VERT = C.VERSION + `
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = vec2(p.x, 1.0 - p.y);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

  // ---------------------------------------------------------------- SSAO ----
  const SSAO_FRAG = C.VERSION + C.POST_UNIFORMS + C.POST_UTILS + `
uniform sampler2D uTexNoise;
uniform vec3 uSamples[32];
uniform vec2 uNoiseScale;
uniform float uRadius;
uniform float uBias;
uniform float uPower;
uniform int uSampleCount;
out float oAO;

void main() {
  float linz = linDepthAt(vUv);
  if (linz <= 0.0001) { oAO = 1.0; return; }

  vec3 origin = viewPosFromDepth(vUv, linz);
  vec3 n = viewNormalAt(vUv);
  vec3 rand = texture(uTexNoise, vUv * uNoiseScale).xyz * 2.0 - 1.0;
  vec3 tangent = normalize(rand - n * dot(rand, n));
  vec3 bitangent = cross(n, tangent);
  mat3 tbn = mat3(tangent, bitangent, n);

  float occlusion = 0.0;
  for (int i = 0; i < 32; i++) {
    if (i >= uSampleCount) break;
    vec3 s = tbn * uSamples[i];
    if (dot(s, n) < 0.0) s = -s;
    vec3 sp = origin + s * uRadius;

    vec4 clip = uProj * vec4(sp, 1.0);
    vec2 suv = clip.xy / clip.w * 0.5 + 0.5;
    suv.y = 1.0 - suv.y;
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0. || suv.y > 1.0) continue;

    float sz = -sp.z;                       // 采样点到相机的正向距离
    float sampleZ = linDepthAt(suv);        // 该像素场景表面的距离
    if (sampleZ <= 0.0001) continue;

    // 表面比采样点更远（sampleZ 更大）→ 采样点落在几何体内部 → 被遮蔽。
    float dz = sampleZ - sz;
    if (dz > uBias) {
      float range = 1.0 - smoothstep(0.0, uRadius * 2.5, abs(dz));
      occlusion += range;
    }
  }
  occlusion /= float(uSampleCount);
  oAO = clamp(pow(1.0 - occlusion, uPower), 0.0, 1.0);
}
`;

  // ----------------------------------------------------- 双边模糊（AO）----
  const BLUR_FRAG = C.VERSION + `
precision highp float;
uniform sampler2D uTexAO;
uniform sampler2D uTexData0;
uniform vec2 uTexel;
in vec2 vUv;
out float oAO;
void main() {
  float centerZ = texture(uTexData0, vUv).b;
  float sum = 0.0; float wsum = 0.0;
  float result = 1.0;
  for (int x = -2; x <= 2; x++) {
    for (int y = -2; y <= 2; y++) {
      vec2 off = vec2(float(x), float(y)) * uTexel;
      vec2 uv = vUv + off;
      float z = texture(uTexData0, uv).b;
      float w = exp2(-float(x*x + y*y) * 0.5) *
                (1.0 - smoothstep(0.05, 0.6, abs(z - centerZ)));
      sum += texture(uTexAO, uv).r * w;
      wsum += w;
    }
  }
  if (wsum > 0.0) result = sum / wsum;
  oAO = result;
}
`;

  // ----------------------------------------------------------------- SSR ----
  const SSR_FRAG = C.VERSION + C.POST_UNIFORMS + C.POST_UTILS + `
uniform sampler2D uTexAO;
uniform int uSteps;
uniform int uBinarySteps;
uniform float uThickness;
uniform float uMaxDist;
uniform float uRoughBlur;
uniform float uIntensity;
uniform int uEnableAO;
out vec4 oColor;

vec3 hitColor(vec2 uv) { return texture(uTexColor, uv).rgb; }

void main() {
  float linz = linDepthAt(vUv);
  vec3 base = hitColor(vUv);
  if (uEnableAO == 1) base *= texture(uTexAO, vUv).r;
  if (linz <= 0.0001) { oColor = vec4(base, 0.0); return; }

  vec3 pos = viewPosFromDepth(vUv, linz);
  vec3 n = viewNormalAt(vUv);
  vec4 d1 = texture(uTexData0, vUv);
  vec4 d2 = texture(uTexData1, vUv);
  float rough = d1.a;
  float metal = d2.b;

  vec3 v = normalize(pos);
  vec3 r = reflect(v, n);
  // 反射光朝下/朝镜头后方时早早退出，减少浪费。
  if (r.z > 0.0) { oColor = vec4(base, 0.0); return; }

  vec2 jitter = interleavedGradient(gl_FragCoord.xy);
  float stepLen = uMaxDist / float(uSteps);
  vec3 rp = pos + r * stepLen * (0.4 + jitter.x * 0.6);

  vec2 hitUv = vec2(-1.0);
  for (int i = 0; i < 80; i++) {
    if (i >= uSteps) break;
    vec4 clip = uProj * vec4(rp, 1.0);
    vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
    uv.y = 1.0 - uv.y;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;

    float sceneZ = -viewPosFromDepth(uv, linDepthAt(uv)).z;
    float rayZ = -rp.z;
    if (sceneZ > 0.0001 && rayZ >= sceneZ && rayZ - sceneZ < uThickness * 8.0) {
      // 二分细化，让命中点贴到表面。
      vec3 a = rp - r * stepLen;
      vec3 b = rp;
      for (int k = 0; k < 6; k++) {
        if (k >= uBinarySteps) break;
        vec3 mid = 0.5 * (a + b);
        vec4 c2 = uProj * vec4(mid, 1.0);
        vec2 muv = c2.xy / c2.w * 0.5 + 0.5;
        muv.y = 1.0 - muv.y;
        float mz = -viewPosFromDepth(muv, linDepthAt(muv)).z;
        float rz2 = -mid.z;
        if (mz > 0.0001 && rz2 >= mz) b = mid; else a = mid;
      }
      vec4 hc = uProj * vec4(b, 1.0);
      hitUv = hc.xy / hc.w * 0.5 + 0.5;
      hitUv.y = 1.0 - hitUv.y;
      break;
    }
    rp += r * stepLen;
  }

  float hitMask = 0.0;
  vec3 refl = vec3(0.0);
  if (hitUv.x >= 0.0) {
    // 粗糙度越高，采样半径越大 → 反射模糊。
    float radiusPx = rough * rough * uRoughBlur * 14.0;
    vec2 poisson[6];
    poisson[0] = vec2( 0.00,  0.00);
    poisson[1] = vec2( 0.90, -0.40);
    poisson[2] = vec2(-0.70, -0.65);
    poisson[3] = vec2(-0.45,  0.85);
    poisson[4] = vec2( 0.80,  0.65);
    poisson[5] = vec2(-0.95,  0.25);
    vec3 acc = vec3(0.0);
    float wsum = 0.0;
    for (int i = 0; i < 6; i++) {
      vec2 uv = hitUv + poisson[i] * uTexel * radiusPx;
      float inb = step(0.0, uv.x) * step(uv.x, 1.0)
                * step(0.0, uv.y) * step(uv.y, 1.0);
      acc += hitColor(clamp(uv, vec2(0.001), vec2(0.999))) * inb;
      wsum += inb;
    }
    if (wsum < 0.5) { hitUv = vec2(-1.0); }
    else {
      refl = acc / wsum;
      hitMask = wsum / 6.0;
      hitMask *= 1.0 - smoothstep(0.0, 0.06,
        min(min(hitUv.x, 1.0-hitUv.x), min(hitUv.y, 1.0-hitUv.y)));
    }
    // 掠射角衰减，避免边缘噪点。
    hitMask *= smoothstep(0.05, 0.35, dot(n, -v));
  }

  float fres = pow(1.0 - max(dot(n, -v), 0.0), 5.0);
  float reflWeight = clamp((0.04 + fres) * (1.0 - rough * 0.7) + metal * 0.75, 0.0, 1.0)
                   * uIntensity;

  vec3 col = mix(base, refl, reflWeight * hitMask);
  oColor = vec4(col, hitMask);
}
`;

  // ----------------------------------------------------------------- DoF ----
  const DOF_FRAG = C.VERSION + C.POST_UNIFORMS + C.POST_UTILS + `
uniform float uFocus;
uniform float uAperture;
uniform float uFocusRange;
uniform vec2 uCenterUv;
uniform int uAutoFocus;
out vec4 oColor;

float cocAt(vec2 uv, float z) {
  if (z <= 0.0001) return 1.0; // 天空按远景处理
  float f = uFocus;
  if (uAutoFocus == 1) {
    f = max(linDepthAt(uCenterUv), 0.5);
  }
  float dist = abs(z - f);
  float coc = smoothstep(0.0, uFocusRange, dist) * uAperture;
  return clamp(coc, 0.0, 4.0);
}

void main() {
  float zc = linDepthAt(vUv);
  vec3 center = texture(uTexColor, vUv).rgb;
  float cocC = cocAt(vUv, zc);
  if (cocC < 0.01) {
    oColor = vec4(center, cocC);
    return;
  }

  // 24 tap 双环 Poisson 分布；背景与前景分别累积，前景按其 CoC 覆盖。
  vec2 taps[24];
  taps[0]  = vec2( 0.00,  0.00); taps[1]  = vec2( 0.30,  0.18);
  taps[2]  = vec2(-0.25,  0.32); taps[3]  = vec2(-0.35, -0.20);
  taps[4]  = vec2( 0.20, -0.38); taps[5]  = vec2( 0.55,  0.40);
  taps[6]  = vec2(-0.58,  0.12); taps[7]  = vec2(-0.10,  0.62);
  taps[8]  = vec2( 0.60, -0.18); taps[9]  = vec2( 0.12, -0.62);
  taps[10] = vec2(-0.42, -0.50); taps[11] = vec2( 0.48, -0.52);
  taps[12] = vec2( 0.82,  0.30); taps[13] = vec2( 0.30,  0.86);
  taps[14] = vec2(-0.78,  0.48); taps[15] = vec2(-0.88, -0.10);
  taps[16] = vec2(-0.30, -0.84); taps[17] = vec2( 0.58, -0.72);
  taps[18] = vec2( 0.92, -0.02); taps[19] = vec2(-0.02,  0.98);
  taps[20] = vec2(-0.98,  0.18); taps[21] = vec2( 0.10, -0.98);
  taps[22] = vec2( 0.70,  0.78);  taps[23] = vec2(-0.66, -0.70);

  float maxR = cocC * 16.0;
  vec3 bgAcc = vec3(0.0); float bgW = 0.0;
  vec3 fgAcc = vec3(0.0); float fgW = 0.0;
  for (int i = 0; i < 24; i++) {
    vec2 uv = clamp(vUv + taps[i] * uTexel * maxR, vec2(0.0), vec2(1.0));
    float z = linDepthAt(uv);
    float cocS = cocAt(uv, z);
    vec3 c = texture(uTexColor, uv).rgb;
    if (z > 0.0001 && z < zc - 0.3) {
      float w = cocS;
      fgAcc += c * w; fgW += w;
    } else {
      bgAcc += c; bgW += 1.0;
    }
  }
  vec3 bg = bgW > 0.0 ? bgAcc / bgW : center;
  vec3 col = bg;
  if (fgW > 0.0) {
    vec3 fg = fgAcc / fgW;
    float a = clamp(fgW / float(24) * 2.2, 0.0, 1.0)
            * smoothstep(0.0, 0.5, cocC);
    col = mix(col, fg, a);
  }
  oColor = vec4(col, cocC);
}
`;

  // ------------------------------------------------------- 运动模糊 --------
  const MOTION_FRAG = C.VERSION + C.POST_UNIFORMS + C.POST_UTILS + `
uniform int uSamples;
uniform float uStrength;
out vec4 oColor;

vec2 velAt(vec2 uv) {
  vec4 d = texture(uTexData1, uv);
  vec2 v = d.rg - 0.5;
  v += uCameraVel * 0.5;
  return v;
}

void main() {
  vec2 vel = velAt(vUv);

  // 3x3 邻域取最大速度，缓解物体边缘拖影断裂。
  for (int x = -1; x <= 1; x++) {
    for (int y = -1; y <= 1; y++) {
      if (x == 0 && y == 0) continue;
      vec2 v2 = velAt(vUv + vec2(float(x), float(y)) * uTexel);
      if (dot(v2, v2) > dot(vel, vel)) vel = v2;
    }
  }
  // NDC -> 像素
  vel *= vec2(1.0 / uTexel.x, 1.0 / uTexel.y) * 0.5;
  // 限制最大拖影，避免旋转相机时全屏糊掉。
  float maxPx = 60.0;
  if (length(vel) > maxPx) vel = normalize(vel) * maxPx;
  vel *= uStrength;

  vec3 col = texture(uTexColor, vUv).rgb;
  if (length(vel) < 0.35) { oColor = vec4(col, 1.0); return; }

  float wsum = 1.0;
  for (int i = 1; i < 16; i++) {
    if (i >= uSamples) break;
    float t = float(i) / float(uSamples);
    float j = hash12(gl_FragCoord.xy + float(i)) - 0.5;
    vec2 off = vel * (t - 0.5) + vel / float(uSamples) * j;
    vec2 uv = clamp(vUv + off * uTexel, vec2(0.0), vec2(1.0));
    // 深度跨越大时降权，避免前景拖到背景上。
    float z0 = linDepthAt(vUv);
    float z1 = linDepthAt(uv);
    float w = 1.0 - smoothstep(0.5, 3.0, abs(z0 - z1));
    col += texture(uTexColor, uv).rgb * w;
    wsum += w;
  }
  oColor = vec4(col / wsum, 1.0);
}
`;

  // --------------------------------------------------- 输出 / 调试视图 ------
  const OUTPUT_FRAG = C.VERSION + `
precision highp float;
uniform sampler2D uTexColor;
uniform sampler2D uTexData0;
uniform sampler2D uTexData1;
uniform sampler2D uTexAO;
uniform int uDebug;
uniform float uExposure;
in vec2 vUv;
out vec4 oColor;

vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  vec3 col = texture(uTexColor, vUv).rgb;
  vec4 d0 = texture(uTexData0, vUv);
  vec4 d1 = texture(uTexData1, vUv);

  if (uDebug == 1) {
    col = vec3(pow(clamp(d0.b / 24.0, 0.0, 1.0), 0.6));
  } else if (uDebug == 2) {
    vec2 nxy = d0.rg * 2.0 - 1.0;
    float nz = -sqrt(max(0.0, 1.0 - dot(nxy, nxy)));
    col = vec3(nxy, nz) * 0.5 + 0.5;
  } else if (uDebug == 3) {
    vec2 v = (d1.rg - 0.5);
    col = vec3(v * 6.0 + 0.5, 0.5);
  } else if (uDebug == 4) {
    col = vec3(texture(uTexAO, vUv).r);
  } else if (uDebug == 5) {
    col = vec3(texture(uTexColor, vUv).a);
  } else if (uDebug == 6) {
    float coc = texture(uTexColor, vUv).a;
    col = mix(vec3(0.08, 0.22, 0.12), vec3(0.9, 0.35, 0.1), clamp(coc * 0.5, 0.0, 1.0));
  } else if (uDebug == 7) {
    col = d0.rgb * 0.0; // 占位，main 中无后期时直接给基础色，不会走到这里
  }

  if (uDebug == 0) {
    col *= uExposure;
    col = aces(col);
    col = pow(col, vec3(1.0 / 2.2));
    float vig = smoothstep(1.35, 0.35, length(vUv - 0.5) * 1.2);
    col *= mix(0.82, 1.0, vig);
  }
  oColor = vec4(col, 1.0);
}
`;

  global.PostShaders = {
    POST_VERT, SSAO_FRAG, BLUR_FRAG, SSR_FRAG,
    DOF_FRAG, MOTION_FRAG, OUTPUT_FRAG,
  };
})(typeof self !== "undefined" ? self : this);
