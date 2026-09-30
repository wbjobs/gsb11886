/* Dedicated worker: owns the OffscreenCanvas GL context and the render loop.
   The main thread only runs UI + scheduling, so heavy GPU/CPU work is isolated. */
"use strict";

const ROOT = "../js/renderer/";
importScripts(
  ROOT + "mat4.js",
  ROOT + "camera.js",
  ROOT + "scenes.js",
  ROOT + "shaders/chunks.js",
  ROOT + "shaders/gbuffer.js",
  ROOT + "shaders/post.js",
  ROOT + "shaders/legacy.js",
  ROOT + "gl-renderer.js"
);

let renderer = null;
let rafId = 0;
let lastT = performance.now();

function post(msg, transfers) {
  if (transfers && transfers.length) self.postMessage(msg, transfers);
  else self.postMessage(msg);
}

function loop(now) {
  rafId = requestAnimationFrame(loop);
  const dt = (now - lastT) / 1000;
  lastT = now;
  if (!renderer) return;
  const r = renderer.frame(dt || 1 / 60);
  if (!r) return;

  if (renderer.isBenchmarking()) {
    const results = renderer.stepBenchmark(r.ms);
    if (results) post({ type: "bench-results", results });
  }
}

self.onmessage = (e) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case "init": {
        renderer = new self.GLRenderer(msg.canvas, {
          onStats: (s) => post({ type: "stats", stats: s }),
          onEvent: (ev) => post({ type: "event", event: ev }),
        });
        // 先建立缓冲，再应用参数（setLevel 依赖 FBO 已存在）。
        renderer.resize(msg.width, msg.height, msg.dpr);
        if (msg.params) renderer.setParams(msg.params);
        post({
          type: "ready",
          webgl2: renderer.webgl2,
          levelNames: self.RENDER_LEVELS.map((l) => l.name),
        });
        lastT = performance.now();
        rafId = requestAnimationFrame(loop);
        break;
      }
      case "resize":
        if (renderer) renderer.resize(msg.width, msg.height, msg.dpr);
        break;
      case "params":
        if (renderer) renderer.setParams(msg.patch);
        break;
      case "orbit":
        if (renderer) renderer.orbit(msg.dx, msg.dy);
        break;
      case "zoom":
        if (renderer) renderer.zoom(msg.delta);
        break;
      case "auto-orbit":
        if (renderer) renderer.setAutoOrbit(msg.value);
        break;
      case "pick-focus": {
        if (!renderer) break;
        const depth = renderer.pickFocus(msg.u, msg.v);
        post({ type: "focus-result", depth, focus: renderer.getParams().dof.focus });
        break;
      }
      case "bench-start":
        if (renderer) renderer.startBenchmark();
        break;
      case "bench-cancel":
        if (renderer) renderer.cancelBenchmark();
        break;
      case "dispose":
        cancelAnimationFrame(rafId);
        if (renderer) renderer.dispose();
        renderer = null;
        break;
      default:
        break;
    }
  } catch (err) {
    post({ type: "fatal", message: String(err && err.message || err) });
  }
};
