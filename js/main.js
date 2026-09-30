/* Bootstrap: choose worker(OffscreenCanvas) vs main-thread render path,
   wire UI, camera input, resize, persistence and benchmark aggregation. */
(function () {
  "use strict";

  const canvas = document.getElementById("gl");
  const wrap = document.getElementById("canvas-wrap");
  const perf = new PerfMonitor();
  let ui;
  let currentParams = JSON.parse(JSON.stringify(RENDER_DEFAULTS));
  let backend = null;       // WorkerBackend | MainBackend
  let pickMode = false;
  let benchStartLongTasks = 0;
  let benchActive = false;

  // ------------------------------------------------------------- 后端抽象
  class WorkerBackend {
    constructor(cv, params) {
      this.worker = new Worker("worker/render-worker.js");
      this.worker.onmessage = (e) => onWorkerMessage(e.data);
      const off = cv.transferControlToOffscreen();
      const size = cssSize();
      this.worker.postMessage({
        type: "init", canvas: off, width: size.w, height: size.h,
        dpr: dpr(), params,
      }, [off]);
    }
    send(msg, transfer) {
      this.worker.postMessage(msg, transfer || []);
    }
    resize(w, h) { this.send({ type: "resize", width: w, height: h, dpr: dpr() }); }
    params(patch) { this.send({ type: "params", patch }); }
    orbit(dx, dy) { this.send({ type: "orbit", dx, dy }); }
    zoom(d) { this.send({ type: "zoom", delta: d }); }
    autoOrbit(v) { this.send({ type: "auto-orbit", value: v }); }
    pickFocus(u, v) { this.send({ type: "pick-focus", u, v }); }
    benchStart() { this.send({ type: "bench-start" }); }
    dispose() { this.send({ type: "dispose" }); this.worker.terminate(); }
  }

  class MainBackend {
    constructor(cv, params) {
      const size = cssSize();
      this.renderer = new GLRenderer(cv, {
        onStats: (s) => ui.setStats(s, perf.total),
        onEvent: (ev) => handleRendererEvent(ev),
      });
      this.renderer.resize(size.w, size.h, dpr());
      this.renderer.setParams(params);
      let last = performance.now();
      this._loop = (now) => {
        this._raf = requestAnimationFrame(this._loop);
        const dt = (now - last) / 1000;
        last = now;
        const r = this.renderer.frame(dt || 1 / 60);
        if (r && this.renderer.isBenchmarking()) {
          const results = this.renderer.stepBenchmark(r.ms);
          if (results) finishBenchmark(results);
        }
      };
      this._raf = requestAnimationFrame(this._loop);
    }
    resize(w, h) { this.renderer.resize(w, h, dpr()); }
    params(patch) { this.renderer.setParams(patch); }
    orbit(dx, dy) { this.renderer.orbit(dx, dy); }
    zoom(d) { this.renderer.zoom(d); }
    autoOrbit(v) { this.renderer.setAutoOrbit(v); }
    pickFocus(u, v) {
      const depth = this.renderer.pickFocus(u, v);
      if (depth !== null) {
        ui.setFocusValue(this.renderer.getParams().dof.focus);
      }
    }
    benchStart() { this.renderer.startBenchmark(); }
    dispose() {
      cancelAnimationFrame(this._raf);
      this.renderer.dispose();
    }
  }

  function dpr() { return Math.min(window.devicePixelRatio || 1, 2); }
  function cssSize() {
    const r = wrap.getBoundingClientRect();
    return { w: Math.max(2, r.width), h: Math.max(2, r.height) };
  }

  function supportsWorkerOffscreen() {
    return typeof Worker !== "undefined" &&
           typeof OffscreenCanvas !== "undefined" &&
           typeof canvas.transferControlToOffscreen === "function";
  }

  async function boot(forceMain) {
    ui = new AppUI({
      onParams: applyParams,
      onForceWorker: (checked) => {
        // OffscreenCanvas 控制权只能移交一次，跨模式切换通过整页刷新完成。
        if (checked) localStorage.setItem("ssfx-force-main", "1");
        else localStorage.removeItem("ssfx-force-main");
        location.reload();
      },
      onAutoOrbit: (v) => {
        if (backend) backend.autoOrbit(v);
        currentParams.autoOrbit = v;
      },
      onPickMode: () => { pickMode = true; canvas.style.cursor = "crosshair"; },
      onBenchRun: startBenchmark,
      onBenchClear: clearBenchmarks,
      onReset: resetDefaults,
      onSave: () => SettingsDB.saveParams(currentParams),
    });
    ui.applyParams(currentParams);

    perf.start();
    setInterval(() => {
      perf.drainWindow();
      const el = document.getElementById("hud-longtasks");
      if (el && !benchActive) el.textContent = "长任务 " + perf.total;
    }, 1000);

    const saved = await SettingsDB.loadParams();
    if (saved && saved.effects) {
      currentParams = mergeDeep(JSON.parse(JSON.stringify(RENDER_DEFAULTS)), saved);
      ui.applyParams(currentParams);
    }
    const history = await SettingsDB.loadBenchmarks();
    if (history && history.length) ui.renderBenchmark(history);

    createBackend(forceMain);
    bindCameraInput();
    bindResize();
    document.addEventListener("visibilitychange", () => {
      // 后台标签自动暂停渲染由 rAF 节流完成，这里只同步状态显示。
    });
  }

  function createBackend(forceMain) {
    const useMain = forceMain || !supportsWorkerOffscreen();
    try {
      if (useMain) {
        backend = new MainBackend(canvas, currentParams);
        const isFallback = !forceMain;
        ui.setMode(
          forceMain ? "主线程渲染（对照模式）" : "降级：不支持 OffscreenCanvas，改在主线程渲染",
          true
        );
      } else {
        backend = new WorkerBackend(canvas, currentParams);
        ui.setMode("Worker + OffscreenCanvas", false);
      }
    } catch (err) {
      if (!useMain) {
        // Worker 路径初始化失败（如 webview 限制），退回主线程。
        ui.setMode("Worker 初始化失败，降级到主线程: " + err.message, true);
        createBackend(true);
      } else {
        ui.showError("WebGL 初始化失败：" + err.message +
          "。请使用支持 WebGL2 的现代浏览器（Chrome/Edge/Firefox/Safari 15+）。");
      }
    }
  }

  function mergeDeep(base, override) {
    Object.keys(override).forEach((k) => {
      if (base[k] && typeof base[k] === "object" && typeof override[k] === "object") {
        mergeDeep(base[k], override[k]);
      } else base[k] = override[k];
    });
    return base;
  }

  function applyParams(patch) {
    currentParams = mergeDeep(currentParams, JSON.parse(JSON.stringify(patch)));
    if (backend) backend.params(patch);
    if (ui) ui.refreshEnabled(currentParams);
    SettingsDB.saveParams(currentParams);
  }

  function resetDefaults() {
    currentParams = JSON.parse(JSON.stringify(RENDER_DEFAULTS));
    ui.applyParams(currentParams);
    if (backend) backend.params(currentParams);
    SettingsDB.saveParams(currentParams);
  }

  // ------------------------------------------------------------- 相机输入
  function bindCameraInput() {
    let dragging = false;
    let lastX = 0, lastY = 0;
    const target = document.getElementById("gl");
    target.addEventListener("pointerdown", (e) => {
      if (pickMode) {
        const r = target.getBoundingClientRect();
        const u = (e.clientX - r.left) / r.width;
        const v = 1 - (e.clientY - r.top) / r.height;
        ui.showFocusMarker(u, v);
        backend.pickFocus(u, v);
        pickMode = false;
        target.style.cursor = "grab";
        return;
      }
      dragging = true;
      lastX = e.clientX; lastY = e.clientY;
      target.classList.add("dragging");
      target.setPointerCapture(e.pointerId);
    });
    target.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      backend.orbit(dx, dy);
    });
    const endDrag = () => { dragging = false; target.classList.remove("dragging"); };
    target.addEventListener("pointerup", endDrag);
    target.addEventListener("pointercancel", endDrag);
    target.addEventListener("wheel", (e) => {
      e.preventDefault();
      backend.zoom(e.deltaY * 0.01);
    }, { passive: false });
  }

  function bindResize() {
    const ro = new ResizeObserver(() => {
      if (!backend) return;
      const s = cssSize();
      backend.resize(s.w, s.h);
    });
    ro.observe(wrap);
  }

  // ------------------------------------------------------------- Worker 消息
  function onWorkerMessage(msg) {
    switch (msg.type) {
      case "ready":
        if (!msg.webgl2) {
          ui.setMode("降级：不支持 WebGL2，使用 WebGL1 前向路径（无后期）", true);
        }
        break;
      case "stats":
        ui.setStats(msg.stats, perf.total);
        if (typeof msg.stats.level === "number" &&
            msg.stats.level !== currentParams.level) {
          currentParams.level = msg.stats.level;
          document.getElementById("quality").value = String(msg.stats.level);
          ui.refreshEnabled(currentParams);
        }
        break;
      case "event":
        handleRendererEvent(msg.event);
        break;
      case "focus-result":
        if (msg.depth !== null) ui.setFocusValue(msg.focus);
        break;
      case "bench-results":
        finishBenchmark(msg.results);
        break;
      case "fatal":
        ui.showError("渲染线程错误：" + msg.message);
        break;
      default:
        break;
    }
  }

  function handleRendererEvent(ev) {
    if (ev.type === "degrade") {
      ui.setMode(ev.message, true);
      applyParams({ level: ev.level });
      document.getElementById("quality").value = String(ev.level);
    } else if (ev.type === "warn") {
      ui.setMode(ev.message, true);
    } else if (ev.type === "bench-start") {
      ui.setBenchRunning(true);
      ui.setBenchStatus("预热中…");
    } else if (ev.type === "bench-progress") {
      ui.setBenchStatus(`L${ev.level} 测量中 ${ev.frames}/${ev.total}`);
    } else if (ev.type === "bench-end") {
      ui.setBenchRunning(false);
    }
  }

  // ------------------------------------------------------------- Benchmark
  function startBenchmark() {
    benchActive = true;
    benchStartLongTasks = perf.total;
    perf.mark();
    ui.setBenchRunning(true);
    ui.setBenchStatus("预热中…");
    backend.benchStart();
  }

  async function finishBenchmark(results) {
    const longTasks = perf.total - benchStartLongTasks;
    const record = {
      date: new Date().toLocaleString(),
      mode: backend instanceof WorkerBackend ? "Worker" : "主线程",
      webgl2: !!global.WebGL2RenderingContext,
      longTasks,
      results,
    };
    const list = await SettingsDB.addBenchmark(record);
    benchActive = false;
    ui.setBenchRunning(false);
    ui.setBenchStatus(
      "完成：L0 " + results[0].fps.toFixed(0) + "fps → L3 " +
      results[3].fps.toFixed(0) + "fps；区间长任务 " + longTasks
    );
    ui.renderBenchmark(list);
  }

  async function clearBenchmarks() {
    await SettingsDB.clearBenchmarks();
    ui.renderBenchmark([]);
    ui.setBenchStatus("记录已清除");
  }


  window.addEventListener("DOMContentLoaded", () => {
    const force = localStorage.getItem("ssfx-force-main") === "1";
    document.getElementById("forceWorker").checked = force;
    boot(force).catch((err) => {
      const el = document.getElementById("error-panel");
      el.hidden = false;
      el.textContent = "启动失败：" + err.message;
    });
  });
})();
