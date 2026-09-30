/* Panel wiring: controls <-> params, benchmark chart/table, banners. */
(function (global) {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const RANGES = [
    ["ssrSteps", (v) => ({ ssr: { steps: v | 0 } }), (v) => String(v | 0)],
    ["ssrThickness", (v) => ({ ssr: { thickness: v } }), (v) => v.toFixed(3)],
    ["ssrMaxDist", (v) => ({ ssr: { maxDist: v } }), (v) => v.toFixed(1)],
    ["ssrRoughBlur", (v) => ({ ssr: { roughBlur: v } }), (v) => v.toFixed(2)],
    ["ssrIntensity", (v) => ({ ssr: { intensity: v } }), (v) => v.toFixed(2)],
    ["ssaoSamples", (v) => ({ ssao: { samples: v | 0 } }), (v) => String(v | 0)],
    ["ssaoRadius", (v) => ({ ssao: { radius: v } }), (v) => v.toFixed(2)],
    ["ssaoBias", (v) => ({ ssao: { bias: v } }), (v) => v.toFixed(3)],
    ["ssaoPower", (v) => ({ ssao: { power: v } }), (v) => v.toFixed(1)],
    ["dofFocus", (v) => ({ dof: { focus: v } }), (v) => v.toFixed(1)],
    ["dofAperture", (v) => ({ dof: { aperture: v } }), (v) => v.toFixed(2)],
    ["dofRange", (v) => ({ dof: { range: v } }), (v) => v.toFixed(1)],
    ["motionSamples", (v) => ({ motion: { samples: v | 0 } }), (v) => String(v | 0)],
    ["motionStrength", (v) => ({ motion: { strength: v } }), (v) => v.toFixed(2)],
  ];

  class UI {
    constructor(handlers) {
      this.h = handlers;
      this.els = {};
      this.suppress = false;
      this._saveTimer = 0;
      this._cache();
      this._bind();
    }

    _cache() {
      ["scene", "quality", "autoDegrade", "forceWorker",
       "fx-ssr", "fx-ssao", "fx-dof", "fx-motion", "autoOrbit",
       "debug", "dofAuto", "pick-focus", "bench-run", "bench-clear",
       "reset-defaults", "bench-status", "bench-table", "bench-chart",
       "hud-fps", "hud-frame", "hud-longtasks", "hud-mode", "hud-gpu",
       "fallback-banner", "degrade-note", "error-panel", "focus-marker", "gl"]
        .forEach((id) => { this.els[id] = $(id); });
    }

    _bind() {
      const e = this.els;
      e.scene.addEventListener("change", () => {
        this.h.onParams({ scene: e.scene.value });
        this.scheduleSave();
      });
      e.quality.addEventListener("change", () => {
        this.h.onParams({ level: +e.quality.value });
        this.scheduleSave();
      });
      e.autoDegrade.addEventListener("change", () => {
        this.h.onParams({ autoDegrade: e.autoDegrade.checked });
        this.scheduleSave();
      });
      e.forceWorker.addEventListener("change", () => {
        this.h.onForceWorker(e.forceWorker.checked);
      });
      e.autoOrbit.addEventListener("change", () => {
        this.h.onAutoOrbit(e.autoOrbit.checked);
      });
      e.dofAuto.addEventListener("change", () => {
        this.h.onParams({ dof: { auto: e.dofAuto.checked } });
        this.scheduleSave();
      });
      [["fx-ssr", "ssr"], ["fx-ssao", "ssao"], ["fx-dof", "dof"], ["fx-motion", "motion"]]
        .forEach(([id, key]) => {
          e[id].addEventListener("change", () => {
            this.h.onParams({ effects: { [key]: e[id].checked } });
            this.scheduleSave();
          });
        });
      e.debug.addEventListener("change", () => {
        this.h.onParams({ debug: +e.debug.value });
      });

      RANGES.forEach(([id, makePatch, fmt]) => {
        const input = $(id);
        const out = $(id + "Out");
        input.addEventListener("input", () => {
          const v = parseFloat(input.value);
          out.textContent = fmt(v);
          this.h.onParams(makePatch(v));
          this.scheduleSave();
        });
      });

      e["pick-focus"].addEventListener("click", () => this.h.onPickMode());
      e["bench-run"].addEventListener("click", () => this.h.onBenchRun());
      e["bench-clear"].addEventListener("click", () => this.h.onBenchClear());
      e["reset-defaults"].addEventListener("click", () => this.h.onReset());
    }

    scheduleSave() {
      clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(() => this.h.onSave(), 500);
    }

    // 由实际参数回填 UI（初始化 / 恢复默认 / 外部降级时）。
    applyParams(p) {
      this.suppress = true;
      const e = this.els;
      e.scene.value = p.scene;
      e.quality.value = String(p.level);
      e.autoDegrade.checked = p.autoDegrade;
      e["fx-ssr"].checked = p.effects.ssr;
      e["fx-ssao"].checked = p.effects.ssao;
      e["fx-dof"].checked = p.effects.dof;
      e["fx-motion"].checked = p.effects.motion;
      e.dofAuto.checked = p.dof.auto;
      e.debug.value = String(p.debug);
      RANGES.forEach(([id, , fmt]) => {
        const path = id.startsWith("ssr") ? ["ssr"] :
                     id.startsWith("ssao") ? ["ssao"] :
                     id.startsWith("dof") ? ["dof"] : ["motion"];
        const key = id.replace(/^(ssr|ssao|dof|motion)/, "");
        const keyMap = { Steps: "steps", Thickness: "thickness", MaxDist: "maxDist",
          RoughBlur: "roughBlur", Intensity: "intensity", Samples: "samples",
          Radius: "radius", Bias: "bias", Power: "power", Focus: "focus",
          Aperture: "aperture", Range: "range", Strength: "strength" };
        const v = p[path[0]][keyMap[key]];
        $(id).value = v;
        $(id + "Out").textContent = fmt(parseFloat(v));
      });
      this.suppress = false;
      this.refreshEnabled(p);
    }

    refreshEnabled(p) {
      const lvl = global.RENDER_LEVELS[p.level];
      for (const key of ["ssr", "ssao", "dof", "motion"]) {
        const group = document.getElementById(key + "-group");
        if (group) group.classList.toggle("disabled", p.level === 0 || !lvl[key]);
      }
      this.els["degrade-note"].textContent =
        p.level === 0 ? "当前为 L0：全部后期 Pass 已关闭（降级到无后期）。" : "";
    }

    setMode(text, isFallback) {
      this.els["hud-mode"].textContent = text;
      this.els["fallback-banner"].hidden = !isFallback;
      if (isFallback) this.els["fallback-banner"].textContent = text;
    }

    setStats(s, longTasks) {
      this.els["hud-fps"].textContent = s.fps.toFixed(0) + " fps";
      this.els["hud-frame"].textContent = s.frameMs.toFixed(2) + " ms/帧";
      this.els["hud-longtasks"].textContent = "长任务 " + longTasks;
    }

    setBenchStatus(text) { this.els["bench-status"].textContent = text; }
    setBenchRunning(running) {
      this.els["bench-run"].disabled = running;
    }

    showError(message) {
      const el = this.els["error-panel"];
      el.hidden = false;
      el.textContent = message;
    }

    showFocusMarker(u, v) {
      const m = this.els["focus-marker"];
      m.hidden = false;
      m.style.left = (u * 100) + "%";
      m.style.top = ((1 - v) * 100) + "%";
    }
    hideFocusMarker() { this.els["focus-marker"].hidden = true; }

    setFocusValue(v) {
      $("dofFocus").value = v;
      $("dofFocusOut").textContent = Number(v).toFixed(1);
    }

    renderBenchmark(records) {
      const latest = records[0];
      if (!latest) {
        this.els["bench-table"].innerHTML = "";
        this._drawChart(null);
        return;
      }
      // 表格
      let html = "<table><thead><tr><th>档位</th><th>FPS</th><th>ms/帧</th><th>Pass</th></tr></thead><tbody>";
      for (const r of latest.results) {
        html += `<tr><td>${r.name}</td><td>${r.fps.toFixed(1)}</td>` +
                `<td>${r.frameMs.toFixed(2)}</td><td>${r.passes}</td></tr>`;
      }
      html += "</tbody></table>";
      html += `<div class="muted" style="margin-top:4px">` +
              `跑分期间主线程长任务：${latest.longTasks} · ${latest.mode} · ${latest.date}</div>`;
      this.els["bench-table"].innerHTML = html;
      this._drawChart(latest);
    }

    _drawChart(record) {
      const canvas = this.els["bench-chart"];
      const dpr = Math.min(global.devicePixelRatio || 1, 2);
      const cssW = canvas.clientWidth || 320;
      const cssH = 150;
      canvas.width = cssW * dpr;
      canvas.height = cssH * dpr;
      const ctx = canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);
      if (!record) {
        ctx.fillStyle = "#8a94a6";
        ctx.font = "12px sans-serif";
        ctx.fillText("暂无跑分数据", 12, 24);
        return;
      }
      const pad = { l: 34, r: 10, t: 14, b: 26 };
      const w = cssW - pad.l - pad.r;
      const h = cssH - pad.t - pad.b;
      const results = record.results;
      const maxFps = Math.max(70, ...results.map((r) => r.fps)) * 1.1;

      ctx.strokeStyle = "#2a313d";
      ctx.lineWidth = 1;
      ctx.font = "10px ui-monospace, monospace";
      ctx.fillStyle = "#8a94a6";
      for (let i = 0; i <= 4; i++) {
        const y = pad.t + (h * i) / 4;
        ctx.beginPath();
        ctx.moveTo(pad.l, y);
        ctx.lineTo(pad.l + w, y);
        ctx.stroke();
        const v = maxFps * (1 - i / 4);
        ctx.fillText(v.toFixed(0), 4, y + 3);
      }

      const bw = w / results.length;
      results.forEach((r, i) => {
        const bh = (r.fps / maxFps) * h;
        const x = pad.l + bw * i + bw * 0.2;
        const y = pad.t + h - bh;
        ctx.fillStyle = ["#ff5d5d", "#ffb020", "#4f9dff", "#36d39a"][i] || "#4f9dff";
        ctx.fillRect(x, y, bw * 0.6, bh);
        ctx.fillStyle = "#d8dee9";
        ctx.fillText(r.name.split(" ")[0], x, cssH - 10);
        ctx.fillStyle = "#8a94a6";
        ctx.fillText(r.fps.toFixed(0), x, y - 4);
      });
    }
  }

  global.AppUI = UI;
})(typeof self !== "undefined" ? self : this);
