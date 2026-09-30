/* Orbit camera shared by main-thread and worker render paths. */
(function (global) {
  "use strict";

  const SCENE_PRESETS = {
    cornell: { yaw: 0.35, pitch: 0.05, distance: 7.5, target: [0, -0.3, -1.5] },
    pillars: { yaw: 0.15, pitch: 0.02, distance: 9.5, target: [0, -0.4, -2.0] },
    mirror: { yaw: 0.55, pitch: 0.08, distance: 6.5, target: [0, -0.5, -1.0] },
  };

  class Camera {
    constructor() {
      this.yaw = 0.35;
      this.pitch = 0.05;
      this.distance = 7.5;
      this.target = [0, -0.3, -1.5];
      this.autoOrbit = true;
      this.fov = (50 * Math.PI) / 180;

      this.eye = new Float32Array(3);
      this.right = new Float32Array(3);
      this.up = new Float32Array(3);
      this.fwd = new Float32Array(3);
      this.view = null;
      this.proj = null;
      this.vp = null;
      this.prevVP = null;
      this.ndcVel = new Float32Array([0, 0]);
    }

    useScene(name) {
      const p = SCENE_PRESETS[name] || SCENE_PRESETS.cornell;
      this.yaw = p.yaw;
      this.pitch = p.pitch;
      this.distance = p.distance;
      this.target[0] = p.target[0];
      this.target[1] = p.target[1];
      this.target[2] = p.target[2];
    }

    orbit(dx, dy) {
      this.yaw -= dx * 0.005;
      this.pitch = Math.max(-1.2, Math.min(1.2, this.pitch - dy * 0.005));
    }

    zoom(d) {
      this.distance = Math.max(2.5, Math.min(18, this.distance + d));
    }

    update(dt, aspect, benchDrift) {
      if (this.autoOrbit || benchDrift) {
        this.yaw += dt * 0.22;
      }
      const cp = Math.cos(this.pitch);
      const dx = Math.sin(this.yaw) * cp * this.distance;
      const dy = Math.sin(this.pitch) * this.distance;
      const dz = Math.cos(this.yaw) * cp * this.distance;
      this.eye[0] = this.target[0] + dx;
      this.eye[1] = this.target[1] + dy;
      this.eye[2] = this.target[2] + dz;

      this.view = global.Mat4.lookAt(this.eye, this.target, [0, 1, 0]);
      this.proj = global.Mat4.perspective(this.fov, aspect, 0.1, 60);
      this.vp = global.Mat4.multiply(this.proj, this.view);

      // 相机基向量（用于 G-buffer 光线重建）。
      this.right[0] = this.view[0]; this.right[1] = this.view[1]; this.right[2] = this.view[2];
      this.up[0] = this.view[4]; this.up[1] = this.view[5]; this.up[2] = this.view[6];
      const fz0 = this.view[2], fz1 = this.view[6], fz2 = this.view[10];
      this.fwd[0] = -fz0; this.fwd[1] = -fz1; this.fwd[2] = -fz2;

      if (!this.prevVP) {
        this.prevVP = this.vp.slice();
        this.lastEye = this.eye.slice();
      }
    }

    commitPrev() {
      this.prevVP = this.vp.slice();
    }
  }

  global.Camera = Camera;
  global.SCENE_PRESETS = SCENE_PRESETS;
})(typeof self !== "undefined" ? self : this);
