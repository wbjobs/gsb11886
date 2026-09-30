/* G-buffer pass: full-screen raymarched scene written to 3 MRT color targets. */
(function (global) {
  "use strict";
  const C = global.ShaderChunks;

  const VERT = C.VERSION + `
out vec2 vUv;
out vec3 vRo;
out vec3 vRd;

uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform vec2 uFrustum; // x: tan(fovy/2), y: aspect

void main() {
  // gl_VertexID 驱动的全屏三角形（WebGL2，无需 VAO/顶点缓冲）。
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = vec2(p.x, 1.0 - p.y);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);

  vec2 nd = vUv * 2.0 - 1.0;
  vRo = uCamPos;
  vRd = normalize(uCamFwd
      + uCamRight * (nd.x * uFrustum.x * uFrustum.y)
      + uCamUp    * (nd.y * uFrustum.x));
}
`;

  const FRAG = C.VERSION +
    C.SCENE_UNIFORMS +
    C.SDF_GLSL +
    C.NOISE_GLSL +
    C.MATERIAL_GLSL + `
in vec2 vUv;
in vec3 vRo;
in vec3 vRd;

uniform mat4  uVP;
uniform mat4  uPrevVP;

layout(location = 0) out vec4 oColor;   // HDR 基础着色
layout(location = 1) out vec4 oData0;   // rg 视图法线, b 线性深度, a 粗糙度
layout(location = 2) out vec4 oData1;   // rg NDC 速度, b 金属度, a 物体 id

void main() {
  HitInfo hit = trace(vRo, vRd);

  if (hit.id < 0) {
    // 未命中：天空。深度写 0，后续 Pass 据此跳过。
    oColor = vec4(skyColor(vRd), 1.0);
    oData0 = vec4(0.5, 0.5, 0.0, 1.0); // xy=0 重建为 (0,0,-1)
    oData1 = vec4(0.5, 0.5, 0.0, 0.0);
    return;
  }

  vec3 p = vRo + vRd * hit.d;
  vec3 nRaw = normalize(vec3(
      mapScene(p + vec3(0.002, 0, 0)).d - mapScene(p - vec3(0.002, 0, 0)).d,
      mapScene(p + vec3(0, 0.002, 0)).d - mapScene(p - vec3(0, 0.002, 0)).d,
      mapScene(p + vec3(0, 0, 0.002)).d - mapScene(p - vec3(0, 0, 0.002)).d));
  vec3 n = bumpNormal(p, nRaw, hit.id == 0 ? 0 : 1);
  vec3 v = -vRd;

  vec3 albedo; float rough; float metal;
  getMaterial(hit.id, p, n, albedo, rough, metal);
  float emit = hit.id > 0 ? uObjMat[hit.id - 1].y : 0.0;
  vec3 color = shadeSurface(p, n, v, albedo, rough, metal, emit);

  vec3 vp = (uView * vec4(p, 1.0)).xyz;
  vec3 vn = normalize(mat3(uView) * n);
  float linz = -vp.z;

  // ---- 屏幕空间速度（NDC/帧）---------------------------------------------
  vec3 wpPrev = (uMoveId >= 0 && hit.id == uMoveId + 1) ? p - uMoveVel * uDt : p;
  vec4 cCur = uVP * vec4(p, 1.0);
  vec4 cPrev = uPrevVP * vec4(wpPrev, 1.0);
  vec2 ndcCur = cCur.xy / cCur.w;
  vec2 ndcPrev = cPrev.xy / cPrev.w;
  vec2 velN = ndcCur - ndcPrev;

  oColor = vec4(color, 1.0);
  oData0 = vec4(vn * 0.5 + 0.5, linz, rough);
  oData1 = vec4(velN * 0.5 + 0.5, metal, float(hit.id) / 24.0);
}
`;

  global.GBufferShaders = { VERT, FRAG };
})(typeof self !== "undefined" ? self : this);
