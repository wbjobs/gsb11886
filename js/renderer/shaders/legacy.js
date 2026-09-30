/* WebGL1 fallback shader: forward raymarch + direct tonemap, no post passes.
   Used only when WebGL2 is unavailable (降级到无后期）。 */
(function (global) {
  "use strict";

  const MAX_OBJ = 24;

  const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, aPos.y * 0.5 + 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

  const FRAG = `
precision highp float;
varying vec2 vUv;

uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform vec2 uFrustum;
uniform float uTime;
uniform int uObjCount;
uniform vec4 uObjA[${MAX_OBJ}];
uniform vec4 uObjB[${MAX_OBJ}];
uniform vec4 uObjColor[${MAX_OBJ}];
uniform vec4 uObjMat[${MAX_OBJ}];

struct Hit { float d; int id; };
float sdSphere(vec3 p, vec3 c, float r){ return length(p-c)-r; }
float sdRoundBox(vec3 p, vec3 c, vec3 b, float rad){
  vec3 q = abs(p-c)-b+vec3(rad);
  return length(max(q,0.0))+min(max(q.x,max(q.y,q.z)),0.0)-rad;
}
Hit mapScene(vec3 p){
  Hit h;
  float dd=p.y+2.0, dc=2.0-p.y, db=p.z+6.0, dl=p.x+4.0, dr=4.0-p.x;
  h.d=min(min(dd,dc),min(min(db,dl),dr)); h.id=0;
  for(int i=0;i<${MAX_OBJ};i++){
    if(i>=uObjCount) break;
    vec4 a=uObjA[i]; vec4 b=uObjB[i]; float d=1e9;
    if(a.w<1.5) d=sdSphere(p,a.xyz,b.x);
    else if(a.w<2.5) d=sdRoundBox(p,a.xyz,b.xyz,0.0);
    else d=sdRoundBox(p,a.xyz,b.xyz,max(b.w,0.001));
    if(d<h.d){ h.d=d; h.id=i+1; }
  }
  return h;
}
Hit trace(vec3 ro, vec3 rd){
  Hit h; h.d=-1.0; h.id=-1;
  float t=0.05;
  for(int i=0;i<80;i++){
    vec3 p=ro+rd*t; Hit q=mapScene(p);
    if(q.d<0.002*(1.0+t*0.15)){ h.d=t; h.id=q.id; return h; }
    t+=clamp(q.d*0.9,0.004,0.35);
    if(t>48.0) break;
  }
  return h;
}
vec3 sky(vec3 rd){
  float up=clamp(rd.y*0.5+0.5,0.0,1.0);
  vec3 col=mix(vec3(0.05,0.07,0.11),vec3(0.30,0.46,0.68),up);
  vec3 sd=normalize(vec3(-0.55,0.75,0.35));
  float s=max(dot(rd,sd),0.0);
  col+=vec3(1.0,0.85,0.6)*pow(s,220.0)*3.0;
  return col;
}
void main(){
  vec2 nd=vUv*2.0-1.0;
  vec3 ro=uCamPos;
  vec3 rd=normalize(uCamFwd+uCamRight*(nd.x*uFrustum.x*uFrustum.y)
      +uCamUp*(nd.y*uFrustum.x));
  Hit hit=trace(ro,rd);
  vec3 col;
  if(hit.id<0){ col=sky(rd); }
  else {
    vec3 p=ro+rd*hit.d;
    vec3 n=normalize(vec3(
      mapScene(p+vec3(0.002,0,0)).d-mapScene(p-vec3(0.002,0,0)).d,
      mapScene(p+vec3(0,0.002,0)).d-mapScene(p-vec3(0,0.002,0)).d,
      mapScene(p+vec3(0,0,0.002)).d-mapScene(p-vec3(0,0,0.002)).d));
    vec3 alb; float rough=0.5, metal=0.0, emit=0.0;
    if(hit.id==0){
      if(n.y>0.5){ vec2 q=floor(p.xz*0.5); float c=mod(q.x+q.y,2.0);
        alb=mix(vec3(0.75),vec3(0.16),c); rough=0.14; metal=0.75; }
      else if(n.y<-0.5){ alb=vec3(0.82); rough=0.9; }
      else if(abs(n.z)>0.5){ alb=vec3(0.78,0.76,0.7); rough=0.85; }
      else if(n.x>0.0){ alb=vec3(0.62,0.22,0.18); rough=0.9; }
      else { alb=vec3(0.2,0.34,0.62); rough=0.9; }
    } else {
      int k=hit.id-1;
      alb=uObjColor[k].rgb; metal=uObjColor[k].a;
      rough=uObjMat[k].x; emit=uObjMat[k].y;
    }
    vec3 v=-rd;
    vec3 L=normalize(vec3(-0.55,0.8,0.4));
    float ndl=max(dot(n,L),0.0);
    vec3 H=normalize(L+v);
    float shin=mix(16.0,400.0,pow(1.0-rough,2.0));
    vec3 specC=mix(vec3(0.04),alb,metal);
    col=alb*0.22 + alb*ndl*2.1
       + specC*pow(max(dot(n,H),0.0),shin)*ndl*1.2
       + alb*emit*2.5;
  }
  col=col/(col+vec3(0.6))*1.6;
  col=pow(clamp(col,0.0,1.0),vec3(1.0/2.2));
  gl_FragColor=vec4(col,1.0);
}
`;

  global.LegacyShaders = { VERT, FRAG, MAX_OBJ };
})(typeof self !== "undefined" ? self : this);
