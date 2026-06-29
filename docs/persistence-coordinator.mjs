'use strict';

// ── Persistence write coordinator ────────────────────────────────────────────
// OFF-005a/c/d/f. Serializes and coalesces snapshot writes so the LATEST state
// always wins and writes never interleave, exposes an observable "settled"
// signal, and surfaces persistent failures instead of swallowing them.
//
// Background: dispatch() used to call persistence.save(data) fire-and-forget,
// which (a) lost the last write on an immediate reload, (b) let rapid dispatches
// race so IDB could end up with a stale snapshot, and (c) hid failures. This
// coordinator fixes all three while keeping dispatch() synchronous.
//
// Pure and dependency-injected (saveFn, schedule, callbacks) so it unit-tests
// with no real IndexedDB or timers.
//
//   const co = createPersistenceCoordinator(data => persistence.save(data), {
//     onError: (err, failures) => showSaveError(err, failures),
//   });
//   co.enqueue(snapshot);        // newest snapshot wins; never blocks the caller
//   await co.whenSettled();      // resolves once the latest snapshot is durable
//   await co.flush();            // force a drain + wait (e.g. on tab hide)

/**
 * @param {(data:any)=>Promise<any>} saveFn  performs one durable write; resolves on commit.
 * @param {object} [opts]
 * @param {(err:Error, failures:number)=>void} [opts.onError]  called on EVERY failed write.
 * @param {(fn:Function, ms:number)=>void} [opts.schedule]     retry scheduler (default setTimeout).
 * @param {number} [opts.maxRetries]                           retries before giving up on a snapshot.
 * @param {(n:number)=>number} [opts.backoff]                  retry delay (ms) for failure #n.
 */
export function createPersistenceCoordinator(saveFn, opts = {}) {
  const onError   = opts.onError || null;
  const schedule  = opts.schedule || ((fn, ms) => setTimeout(fn, ms));
  const maxRetries = Number.isFinite(opts.maxRetries) ? opts.maxRetries : 5;
  const backoff   = opts.backoff || ((n) => Math.min(1000, 100 * 2 ** (n - 1)));

  let pending = null;       // newest snapshot awaiting a write
  let hasPending = false;   // explicit flag (snapshot may legitimately be falsy)
  let inFlight = false;     // a write is currently running
  let failures = 0;         // consecutive failures for the current snapshot
  let waiters = [];         // whenSettled() resolvers

  function settleIfIdle() {
    if (!inFlight && !hasPending) {
      const w = waiters;
      waiters = [];
      for (const resolve of w) resolve();
    }
  }

  function start() {
    if (inFlight || !hasPending) { settleIfIdle(); return; }
    const data = pending;
    pending = null;
    hasPending = false;
    inFlight = true;
    // Call saveFn synchronously (the write starts immediately on enqueue), but
    // wrap so a synchronous throw is handled by the same failure path.
    let writePromise;
    try { writePromise = Promise.resolve(saveFn(data)); }
    catch (err) { writePromise = Promise.reject(err); }
    writePromise.then(
      () => {
        inFlight = false;
        failures = 0;
        start();                       // write any newer pending; else settle
      },
      (err) => {
        inFlight = false;
        failures += 1;
        try { if (onError) onError(err, failures); } catch (_) { /* never throw from here */ }
        if (failures <= maxRetries) {
          if (!hasPending) { pending = data; hasPending = true; }  // retry this snapshot unless superseded
          schedule(start, backoff(failures));
          settleIfIdle();              // still hasPending → no-op; waiters keep waiting
        } else {
          failures = 0;                // give up on this snapshot (already surfaced via onError)
          start();                     // attempt any newer pending; else settle waiters
        }
      },
    );
  }

  return {
    /** Queue a snapshot to persist. Newest wins (coalesced). Never blocks. */
    enqueue(data) {
      pending = data;
      hasPending = true;
      start();
    },
    /** Force a drain and resolve once the queue is durably settled (or given up). */
    flush() {
      start();
      return this.whenSettled();
    },
    /** Resolves when no write is in flight and nothing is pending. */
    whenSettled() {
      if (!inFlight && !hasPending) return Promise.resolve();
      return new Promise((resolve) => waiters.push(resolve));
    },
    get isIdle() { return !inFlight && !hasPending; },
  };
}
