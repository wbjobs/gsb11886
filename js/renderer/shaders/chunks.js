/* GLSL ES 3.00 shader source chunks shared by the G-buffer & post passes. */
(function (global) {
  "use strict";

  const MAX_OBJ = 24;

  // Used by every WebGL2 program. Must remain the very first statement.
  const VERSION = `#version 300 es
precision highp float;
`;

  // ---------------------------------------------------------------------------
  // G-buffer raymarch scene: SDF primitives + procedural bump ("深度/法线纹理"
  // 由 SDF 程序化生成，无需外部贴图资源）。
  // ---------------------------------------------------------------------------
  const SCENE_UNIFORMS = `
uniform mat4  uView;
uniform mat4  uProj;
uniform vec3  uCamPos;
uniform float uTime;
uniform float uDt;
uniform int   uObjCount;
uniform int   uMoveId;       // 运动物体下标，-1 表示无
uniform vec3  uMoveVel;      // 世界空间速度（单位/秒）
uniform vec4  uObjA[${MAX_OBJ}];   // xyz: 位置, w: 类型(1球 2盒 3圆角盒)
uniform vec4  uObjB[${MAX_OBJ}];   // xyz: 半尺寸, w: 圆角半径
uniform vec4  uObjColor[${MAX_OBJ}]; // rgb: 反照率, a: 金属度
uniform vec4  uObjMat[${MAX_OBJ}];   // x: 粗糙度, y: 自发光
`;

  const SDF_GLSL = `
const int MAX_OBJ = ${MAX_OBJ};

struct HitInfo { float d; int id; };

float sdSphere(vec3 p, vec3 c, float r) { return length(p - c) - r; }

float sdRoundBox(vec3 p, vec3 c, vec3 b, float rad) {
  vec3 q = abs(p - c) - b + vec3(rad);
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - rad;
}

HitInfo mapScene(vec3 p) {
  HitInfo h = HitInfo(1e9, 0);

  // 房间：地面 / 天花板 / 后墙 / 左右墙（正面 z=+6 开放，可见天空）。
  float dd = p.y + 2.0;
  float dc = 2.0 - p.y;
  float db = p.z + 6.0;
  float dl = p.x + 4.0;
  float dr = 4.0 - p.x;
  float wall = min(min(dd, dc), min(min(db, dl), dr));
  h.d = wall; h.id = 0;

  for (int i = 0; i < MAX_OBJ; i++) {
    if (i >= uObjCount) break;
    vec4 a = uObjA[i];
    vec4 b = uObjB[i];
    float d = 1e9;
    if (a.w < 1.5) {
      d = sdSphere(p, a.xyz, b.x);
    } else if (a.w < 2.5) {
      d = sdRoundBox(p, a.xyz, b.xyz, 0.0);
    } else {
      d = sdRoundBox(p, a.xyz, b.xyz, max(b.w, 0.001));
    }
    if (d < h.d) { h.d = d; h.id = i + 1; }
  }
  return h;
}

HitInfo trace(vec3 ro, vec3 rd) {
  float t = 0.05;
  HitInfo h = HitInfo(-1.0, -1);
  for (int i = 0; i < 96; i++) {
    vec3 p = ro + rd * t;
    HitInfo q = mapScene(p);
    if (q.d < 0.0015 * (1.0 + t * 0.15)) { h.d = t; h.id = q.id; return h; }
    t += clamp(q.d * 0.9, 0.004, 0.35);
    if (t > 48.0) break;
  }
  return h;
}
`;

  // 程序化噪声：给平面/几何加上细微凹凸，形成"深度纹理/法线纹理"细节。
  const NOISE_GLSL = `
float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash31(i + vec3(0,0,0));
  float n100 = hash31(i + vec3(1,0,0));
  float n010 = hash31(i + vec3(0,1,0));
  float n110 = hash31(i + vec3(1,1,0));
  float n001 = hash31(i + vec3(0,0,1));
  float n101 = hash31(i + vec3(1,0,1));
  float n011 = hash31(i + vec3(0,1,1));
  float n111 = hash31(i + vec3(1,1,1));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z);
}

// 仅对房间大平面（id==0）施加微表面凹凸，返回偏移后的法线。
vec3 bumpNormal(vec3 p, vec3 n, int id) {
  if (id != 0) return n;
  float amp = 0.18;
  vec3 q = p * 2.5;
  float e = 0.08;
  float h0 = vnoise(q);
  float hx = vnoise(q + vec3(e, 0, 0));
  float hy = vnoise(q + vec3(0, e, 0));
  float hz = vnoise(q + vec3(0, 0, e));
  vec3 grad = vec3(hx - h0, hy - h0, hz - h0) / e;
  return normalize(n - grad * amp);
}
`;

  // 材质 + 光照（供 G-buffer 基础着色使用）。
  const MATERIAL_GLSL = `
vec3 skyColor(vec3 rd) {
  float up = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(vec3(0.05, 0.07, 0.11), vec3(0.30, 0.46, 0.68), up);
  vec3 sunDir = normalize(vec3(-0.55, 0.75, 0.35));
  float s = max(dot(rd, sunDir), 0.0);
  col += vec3(1.0, 0.85, 0.6) * pow(s, 220.0) * 3.0;
  col += vec3(1.0, 0.8, 0.55) * pow(s, 8.0) * 0.12;
  return col;
}

void getMaterial(int id, vec3 p, vec3 n, out vec3 albedo, out float rough, out float metal) {
  if (id == 0) {
    bool floorx = n.y > 0.5;
    bool ceilx  = n.y < -0.5;
    bool back   = abs(n.z) > 0.5 && !floorx && !ceilx;
    if (floorx) {
      // 棋盘格地面，金属度高，供 SSR 反射。
      vec2 q = floor(p.xz * 0.5);
      float chk = mod(q.x + q.y, 2.0);
      albedo = mix(vec3(0.75), vec3(0.16), chk);
      rough = 0.14; metal = 0.75;
    } else if (ceilx) {
      albedo = vec3(0.82); rough = 0.9; metal = 0.0;
    } else if (back) {
      albedo = vec3(0.78, 0.76, 0.7); rough = 0.85; metal = 0.0;
    } else if (n.x > 0.0) {
      albedo = vec3(0.62, 0.22, 0.18); rough = 0.9; metal = 0.0;
    } else {
      albedo = vec3(0.2, 0.34, 0.62); rough = 0.9; metal = 0.0;
    }
    return;
  }
  int k = id - 1;
  vec4 c = uObjColor[k];
  vec4 m = uObjMat[k];
  albedo = c.rgb;
  rough = clamp(m.x, 0.02, 1.0);
  metal = c.a;
}

vec3 shadeSurface(vec3 p, vec3 n, vec3 v, vec3 albedo, float rough, float metal, float emit) {
  vec3 L = normalize(vec3(-0.55, 0.8, 0.4));
  float ndl = max(dot(n, L), 0.0);
  vec3 H = normalize(L + v);
  float shin = mix(16.0, 400.0, pow(1.0 - rough, 2.0));
  vec3 specColor = mix(vec3(0.04), albedo, metal);
  vec3 spec = specColor * pow(max(dot(n, H), 0.0), shin) * ndl * 1.2;
  vec3 ambient = albedo * (0.22 + 0.10 * (n.y * 0.5 + 0.5));
  vec3 col = ambient + albedo * ndl * 2.1 + spec + albedo * emit * 2.5;
  // 菲涅尔边缘光，金属更明显。
  float fres = pow(1.0 - max(dot(n, v), 0.0), 5.0);
  col += specColor * fres * (0.25 + metal * 0.5);
  return col;
}
`;

  // ---------------------------------------------------------------------------
  // Post passes: 深度/投影工具。
  // ---------------------------------------------------------------------------
  const POST_UNIFORMS = `
uniform sampler2D uTexColor;
uniform sampler2D uTexData0; // rg: 视图法线*0.5+0.5, b: 线性深度(-viewZ), a: roughness
uniform sampler2D uTexData1; // rg: 速度(NDC), b: 金属度, a: 物体id/24
uniform vec2  uTexel;
uniform mat4  uProj;
uniform mat4  uInvProj;
uniform vec2  uCameraVel;     // NDC/秒（相机自身运动）
uniform float uTime;
`;

  const POST_UTILS = `
float linDepthAt(vec2 uv) { return texture(uTexData0, uv).b; }

vec3 viewPosFromDepth(vec2 uv, float linz) {
  vec2 ndc = uv * 2.0 - 1.0;
  vec4 p = uInvProj * vec4(ndc, -1.0, 1.0);
  return p.xyz / p.w * linz;
}

// data0 只打包了法线 xy；视图空间正面法线 z 恒为负，据此重建。
vec3 viewNormalAt(vec2 uv) {
  vec2 xy = texture(uTexData0, uv).rg * 2.0 - 1.0;
  float z = -sqrt(max(0.0, 1.0 - dot(xy, xy)));
  return normalize(vec3(xy, z));
}

// 低差异抖动（用于 SSR / DoF / 运动模糊采样）。
vec2 interleavedGradient(vec2 px) {
  px = floor(px);
  float x = fract(0.5 * fract(px.x * 0.5) + fract(px.y * 0.375));
  float y = fract(0.5 * fract(px.x * 0.375) + fract(px.y * 0.5));
  return vec2(x, y);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

  global.ShaderChunks = {
    VERSION,
    MAX_OBJ,
    SCENE_UNIFORMS,
    SDF_GLSL,
    NOISE_GLSL,
    MATERIAL_GLSL,
    POST_UNIFORMS,
    POST_UTILS,
  };
})(typeof self !== "undefined" ? self : this);
