export const FULLSCREEN_VERTEX = `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vUv = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(vUv * 2.0 - 1.0, 0.0, 1.0);
}`;

export const COMMON_GLSL = `
uniform mat4 uInvViewProjection;
uniform float uTime;
uniform vec2 uResolution;
uniform int uScene;

struct Material {
  vec3 albedo;
  float metallic;
  float roughness;
  vec3 emissive;
  int id;
};

const int ID_NONE = 0;
const int ID_GALLERY_BALL = 1;
const int ID_GALLERY_DRONE = 2;
const int ID_CORRIDOR_DRONE = 3;
const int ID_ATRIUM_RING = 4;
const int ID_ATRIUM_BALL = 5;

mat3 rotationY(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c);
}

float sdPlane(vec3 p) { return p.y; }

float sdBox(vec3 p, vec3 b) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

float sdSphere(vec3 p, float r) {
  return length(p) - r;
}

float sdTorus(vec3 p, vec2 t) {
  vec2 q = vec2(length(p.xz) - t.x, p.y);
  return length(q) - t.y;
}

float opSmoothUnion(float d1, float d2, float k) {
  float h = clamp(0.5 + 0.5 * (d2 - d1) / k, 0.0, 1.0);
  return mix(d2, d1, h) - k * h * (1.0 - h);
}

vec3 hash3(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
           dot(p, vec3(269.5, 183.3, 246.1)),
           dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453123) * 2.0 - 1.0;
}

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

vec3 reproject(vec2 uv, float depth) {
  vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 world = uInvViewProjection * clip;
  return world.xyz / world.w;
}

float encodeLinearDepth(float linearDepth) {
  return clamp(linearDepth / 30.0, 0.0, 1.0);
}

float linearizeDepth(float d, float near, float far) {
  float z = d * 2.0 - 1.0;
  return (2.0 * near * far) / (far + near - z * (far - near));
}

vec2 encodeVelocity(vec3 velocity) {
  return clamp(velocity.xz * 0.5, vec2(-1.0), vec2(1.0));
}

vec3 worldRay(vec2 uv) {
  vec4 farPoint = uInvViewProjection * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  return normalize(farPoint.xyz / farPoint.w);
}

vec3 proceduralSky(vec3 rayDirection) {
  vec3 sky = mix(vec3(0.025, 0.035, 0.065), vec3(0.34, 0.48, 0.72),
                 clamp(rayDirection.y * 0.7 + 0.38, 0.0, 1.0));
  vec3 sunDirection = normalize(vec3(-0.45, 0.78, -0.35));
  float sun = pow(max(dot(rayDirection, sunDirection), 0.0), 260.0);
  sky += sun * vec3(1.0, 0.72, 0.38) * 2.5;
  sky += vec3(0.04, 0.08, 0.14) * pow(1.0 - abs(rayDirection.y), 3.0);
  return sky;
}
`;
