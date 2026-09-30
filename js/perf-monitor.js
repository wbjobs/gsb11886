/* Main-thread performance monitoring via PerformanceObserver.
   Tracks long tasks (>50ms) so we can quantify "主线程不卡": worker rendering
   must yield ~0 long tasks, the forced main-thread path is the control group. */
(function (global) {
  "use strict";

  class PerfMonitor {
    constructor() {
      this.supported = typeof PerformanceObserver !== "undefined" &&
        typeof PerformanceObserver.supportedEntryTypes !== "undefined" &&
        PerformanceObserver.supportedEntryTypes.indexOf("longtask") >= 0;
      this.total = 0;
      this.windowCount = 0;
      this._mark = 0;
      this._obs = null;
    }

    start() {
      this.total = 0;
      this.windowCount = 0;
      if (!this.supported) return;
      try {
        this._obs = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            this.total++;
            this.windowCount++;
          }
        });
        this._obs.observe({ entryTypes: ["longtask"] });
      } catch (e) {
        this.supported = false;
      }
    }

    // 跑分区间：记录区间内长任务数，与 worker 侧帧耗时合并。
    mark() { this._mark = this.total; }
    sinceMark() { return this.total - this._mark; }

    drainWindow() {
      const n = this.windowCount;
      this.windowCount = 0;
      return n;
    }

    stop() {
      if (this._obs) this._obs.disconnect();
      this._obs = null;
    }
  }

  global.PerfMonitor = PerfMonitor;
})(typeof self !== "undefined" ? self : this);
