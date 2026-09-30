/* Procedural scene definitions for the raymarched G-buffer.
   Object: { type: 1 sphere | 2 box | 3 round box, pos[3], size[3], radius,
             color[3], metal, rough, emissive } */
(function (global) {
  "use strict";

  function sphere(pos, r, color, rough, metal, emissive) {
    return { type: 1, pos, size: [r, 0, 0], radius: 0, color, rough, metal, emissive: emissive || 0 };
  }
  function box(pos, size, color, rough, metal, emissive) {
    return { type: 2, pos, size, radius: 0, color, rough, metal, emissive: emissive || 0 };
  }
  function rbox(pos, size, radius, color, rough, metal, emissive) {
    return { type: 3, pos, size, radius, color, rough, metal, emissive: emissive || 0 };
  }

  const SCENES = {
    cornell: {
      // 粗糙度/金属度渐变的球 + 一个往复运动的红球（运动模糊主体）。
      base: [
        sphere([-2.3, -1.25, -3.4], 0.75, [0.85, 0.32, 0.22], 0.05, 0.9),
        sphere([0.1, -1.45, -4.3], 0.55, [0.88, 0.78, 0.45], 0.12, 1.0),
        sphere([2.1, -1.35, -2.6], 0.65, [0.55, 0.62, 0.7], 0.55, 0.1),
        rbox([-1.1, -1.7, -0.9], [0.7, 0.3, 0.7], 0.08, [0.72, 0.2, 0.78], 0.35, 0.0),
        rbox([1.4, -1.55, -0.4], [0.45, 0.45, 0.45], 0.1, [0.2, 0.8, 0.65], 0.25, 0.0),
      ],
      mover: { index: 5, axis: "x", amp: 2.6, cy: -1.35, cz: -1.6, r: 0.55,
               color: [0.95, 0.25, 0.2], rough: 0.08, metal: 0.3 },
    },

    pillars: {
      // 立柱走廊：大量窄缝与夹角，突出 SSAO 与法线缓冲。
      base: [
        rbox([-2.7, -0.5, -2.0], [0.45, 1.5, 0.45], 0.05, [0.7, 0.68, 0.62], 0.85, 0),
        rbox([ 2.7, -0.5, -2.2], [0.45, 1.5, 0.45], 0.05, [0.62, 0.66, 0.72], 0.85, 0),
        rbox([-2.4, -0.8, -4.6], [0.55, 1.2, 0.55], 0.05, [0.55, 0.5, 0.45], 0.9, 0),
        rbox([ 2.3, -0.9, -4.8], [0.6,  1.1, 0.6],  0.05, [0.5, 0.55, 0.5], 0.9, 0),
        rbox([0.0, -1.6, -3.2], [0.9, 0.4, 0.9], 0.12, [0.3, 0.4, 0.55], 0.7, 0),
        sphere([-0.9, -1.35, -1.2], 0.5, [0.8, 0.82, 0.85], 0.3, 0.4),
        sphere([1.0, -1.4, -1.4], 0.45, [0.3, 0.85, 0.9], 0.15, 0.6),
      ],
      mover: { index: 7, axis: "z", amp: 1.8, cx: 0.0, cy: -1.5, cz: -3.0, r: 0.4,
               color: [1.0, 0.7, 0.2], rough: 0.2, metal: 0.5 },
    },

    mirror: {
      // 镜面大厅：高金属度物体密集，突出 SSR 与反射模糊差异。
      base: [
        rbox([-2.2, -1.5, -2.0], [0.5, 0.5, 0.5], 0.5, [0.9, 0.9, 0.95], 0.03, 1.0),
        rbox([ 2.2, -1.6, -2.8], [0.4, 0.4, 0.4], 0.4, [0.95, 0.85, 0.5], 0.06, 1.0),
        rbox([0.0, -1.7, -4.8], [1.2, 0.3, 0.5], 0.1, [0.7, 0.75, 0.85], 0.08, 0.9),
        sphere([-1.0, -1.4, -0.8], 0.6, [0.92, 0.92, 0.95], 0.02, 1.0),
        sphere([1.3, -1.5, -0.6], 0.5, [0.8, 0.85, 1.0], 0.25, 0.9),
        box([0.0, -1.2, -2.2], [0.25, 0.8, 0.25], [0.95, 0.4, 0.9], 0.15, 0.4),
        sphere([0.0, 1.4, -4.5], 0.28, [1.0, 0.95, 0.8], 0.4, 0.0, 1.6),
      ],
      mover: null,
    },
  };

  function buildFrame(name, time) {
    const def = SCENES[name] || SCENES.cornell;
    const objs = def.base.map((o) => ({
      type: o.type,
      pos: o.pos.slice(),
      size: o.size.slice(),
      radius: o.radius,
      color: o.color.slice(),
      rough: o.rough,
      metal: o.metal,
      emissive: o.emissive,
    }));
    let moveId = -1;
    let vel = [0, 0, 0];
    if (def.mover) {
      const m = def.mover;
      const phase = time * 0.9;
      const s = Math.sin(phase);
      const c = Math.cos(phase);
      const pos = [
        m.cx !== undefined ? m.cx + (m.axis === "x" ? s * m.amp : 0) : s * m.amp,
        m.cy,
        m.cz + (m.axis === "z" ? s * m.amp : 0),
      ];
      const speed = 0.9 * m.amp;
      vel = [
        m.axis === "x" ? c * speed : 0,
        0,
        m.axis === "z" ? c * speed : 0,
      ];
      objs[m.index] = sphere(pos, m.r, m.color, m.rough, m.metal);
      moveId = m.index;
    }
    return { objs, moveId, vel };
  }

  global.ScreenspaceScenes = { SCENES, buildFrame };
})(typeof self !== "undefined" ? self : this);
