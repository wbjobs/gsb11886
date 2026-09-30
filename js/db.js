/* IndexedDB persistence: last-used effect parameters + benchmark history. */
(function (global) {
  "use strict";

  const DB_NAME = "ssfx-lab";
  const DB_VERSION = 1;
  const STORE = "kv";

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function request(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function withStore(mode, fn) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const store = t.objectStore(STORE);
        let ret;
        t.oncomplete = () => resolve(ret);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
        Promise.resolve(fn(store)).then((v) => { ret = v; }).catch(reject);
      });
    } finally {
      db.close();
    }
  }

  async function get(key, fallback) {
    try {
      const v = await withStore("readonly", (s) => request(s.get(key)));
      return v === undefined || v === null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  async function put(key, value) {
    try {
      await withStore("readwrite", (s) => request(s.put(value, key)));
    } catch (e) {
      // 隐私模式等场景下 IndexedDB 可能不可用，静默降级为内存态。
      console.warn("IndexedDB 写入失败", e);
    }
  }

  const SettingsDB = {
    loadParams: () => get("params", null),
    saveParams: (p) => put("params", p),
    loadBenchmarks: () => get("benchmarks", []),
    saveBenchmarks: (list) => put("benchmarks", list),
    async addBenchmark(record) {
      const list = await SettingsDB.loadBenchmarks();
      list.unshift(record);
      await SettingsDB.saveBenchmarks(list.slice(0, 20));
      return list;
    },
    clearBenchmarks: () => put("benchmarks", []),
  };

  global.SettingsDB = SettingsDB;
})(typeof self !== "undefined" ? self : this);
