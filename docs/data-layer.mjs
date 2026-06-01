'use strict';
// DATA_LAYER — injectable boundary abstractions for persistence, network, and allocation.
//
// Two operating modes:
//   default — IdbPersistence + null network + SpaAllocator  (IDB-only, no server calls)
//   test    — MockPersistence + MockNetwork + MockAllocator  (injected by test harness)
//
// Usage in index.html (real app):
//   window.__dataLayer = createDataLayer({ idb, allocator });
//
// Usage in tests (page.addInitScript / Vitest):
//   window.__dataLayer = createDataLayer({ mode: 'test', fixtures: { ... } });
//   -- or --
//   window.__dataLayer = { persistence: new MockPersistence(data), network: new MockNetwork(fixtures), allocator: new MockAllocator(result) };

// ── Persistence ─────────────────────────────────────────────────────────────

export class IdbPersistence {
  constructor(idb) {
    this._idb = idb;
  }
  isAvailable() {
    return !!(this._idb && typeof this._idb.isAvailable === 'function' && this._idb.isAvailable());
  }
  async load() {
    if (!this.isAvailable()) return null;
    return this._idb.loadSnapshot();
  }
  async save(data) {
    if (!this.isAvailable()) return;
    return this._idb.saveSnapshot(data);
  }
}

// Spy/stub for tests: holds a static snapshot, records every save call.
export class MockPersistence {
  constructor(initial = null) {
    this._data = initial ? JSON.parse(JSON.stringify(initial)) : null;
    this.calls = { load: 0, save: [] };
  }
  isAvailable() { return true; }
  async load() {
    this.calls.load++;
    return this._data ? JSON.parse(JSON.stringify(this._data)) : null;
  }
  async save(data) {
    this._data = JSON.parse(JSON.stringify(data));
    this.calls.save.push(this._data);
  }
}

// ── Network ──────────────────────────────────────────────────────────────────

export class FetchNetwork {
  constructor(fetchFn) {
    this._fetch = fetchFn || globalThis.fetch.bind(globalThis);
  }
  // Returns parsed JSON; throws on non-2xx.
  async get(url) {
    const r = await this._fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  // Returns the raw Response so callers can inspect .ok / .status / .json().
  async rawFetch(url, opts) {
    return this._fetch(url, opts);
  }
}

// Spy/stub for tests: returns fixtures keyed by "METHOD url" or just url.
// Unmatched GETs return null; unmatched writes return { ok: true, status: 200 }.
export class MockNetwork {
  constructor(fixtures = {}) {
    this._fixtures = fixtures;
    this.calls = [];
  }
  _find(method, url) {
    const exact = `${method} ${url}`;
    if (exact in this._fixtures) return this._fixtures[exact];
    if (url in this._fixtures) return this._fixtures[url];
    // Prefix match for parameterised paths (/api/rounds/5, /api/data/jobs/3, etc.)
    for (const k of Object.keys(this._fixtures)) {
      const kUrl = k.includes(' ') ? k.slice(k.indexOf(' ') + 1) : k;
      if (kUrl !== url && url.startsWith(kUrl)) return this._fixtures[k];
    }
    return undefined;
  }
  async get(url) {
    this.calls.push({ method: 'GET', url });
    const f = this._find('GET', url);
    if (f instanceof Error) throw f;
    return f !== undefined ? f : null;
  }
  async rawFetch(url, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase();
    const body = opts.body ? (() => { try { return JSON.parse(opts.body); } catch (_) { return opts.body; } })() : null;
    this.calls.push({ method, url, body });
    const f = this._find(method, url);
    if (f instanceof Error) throw f;
    const payload = f !== undefined ? f : {};
    return { ok: true, status: 200, json: () => Promise.resolve(payload), headers: { get: () => null } };
  }
}

// ── Allocator ────────────────────────────────────────────────────────────────

export class SpaAllocator {
  constructor(allocatorModule) {
    this._mod = allocatorModule;
  }
  // Synchronous allocator wrapped in a promise for a uniform async interface.
  async allocate(data) {
    return this._mod.allocate(data);
  }
}

export class MockAllocator {
  constructor(response = null) {
    this._response = response;
    this.calls = [];
  }
  async allocate(data) {
    this.calls.push(data);
    // Return the canned response, or echo the input data unchanged.
    return this._response !== null ? this._response : data;
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createDataLayer({ mode, idb, allocator, fetchFn, fixtures } = {}) {
  const fetchImpl = fetchFn || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);

  if (mode === 'test') {
    return {
      persistence: new MockPersistence(),
      network:     new MockNetwork(fixtures || {}),
      allocator:   new MockAllocator(),
    };
  }

  return {
    persistence: new IdbPersistence(idb || null),
    network:     fetchImpl ? new FetchNetwork(fetchImpl) : null,
    allocator:   allocator ? new SpaAllocator(allocator) : null,
  };
}
