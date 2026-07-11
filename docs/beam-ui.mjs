'use strict';

// @front-end
// element: beam-ui
// intent: DOM glue for Beam — Settings "Send to my phone" (sender) + the scanned-QR
//   receiver flow. Lazy-loads the vendored Trystero+QR bundle only when used, so the
//   83KB dep and its relay connections never load on a normal page view. The pairing
//   logic lives in beam.mjs (unit-tested); this only renders QR / SAS / progress / confirm.

import { createBeamSession, randomSecret, b64url, fromB64url } from './beam.mjs';
import { buildTmSnapshot, applyTmSnapshot, summariseSnapshot } from './tm-data.mjs';

let _deps = null;
async function loadDeps() {
  if (window.__beamDeps) return window.__beamDeps;           // test hook: {joinRoom, qrToDataURL}
  if (!_deps) _deps = await import('./vendor/beam-deps.mjs');
  return _deps;
}

let ctx = null;                                              // app deps injected by index.js
const el = id => document.getElementById(id);
const hasWebRTC = () => typeof RTCPeerConnection !== 'undefined';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let _wakeLock = null;
const keepAwake = async () => { try { _wakeLock = await navigator.wakeLock?.request('screen'); } catch (_) {} };
const releaseAwake = () => { try { _wakeLock?.release(); } catch (_) {} _wakeLock = null; };

function overlay() {
  let p = el('beamOverlay');
  if (!p) { p = document.createElement('div'); p.id = 'beamOverlay'; p.className = 'beam-overlay'; document.body.appendChild(p); }
  return p;
}
function closeOverlay() { releaseAwake(); const p = el('beamOverlay'); if (p) p.remove(); }
function card(p, inner) { p.innerHTML = `<div class="beam-card">${inner}</div>`; }

function errText(reason) {
  return {
    'no-peer': "Couldn't reach your other device. Make sure both are on the same Wi-Fi, and the sending device's screen shows the code.",
    'multi-peer': 'Another device scanned the code — for safety, start again with a fresh code.',
    'peer-left': 'The other device disconnected.',
    'integrity': 'The transfer was corrupted — please try again.',
    'invalid': 'The received data was not a valid team file.',
  }[reason] || 'Something went wrong — please try again.';
}

export function initBeamUI(appCtx) {
  ctx = appCtx;
  const btn = el('btnBeamSend');
  if (btn) btn.addEventListener('click', () => startSend().catch(() => {}));
  const m = String(location.hash || '').match(/[#&]beam=([A-Za-z0-9\-_]+)/);
  if (m) {
    const secretB64 = m[1];
    try { history.replaceState(null, '', location.pathname + location.search); } catch (_) {}
    startReceive(secretB64).catch(() => {});
  }
}

// ── Sender (desktop shows the QR) ───────────────────────────────────────────────
async function startSend() {
  const p = overlay();
  if (!hasWebRTC()) { card(p, `<h3>Send to my phone</h3><p class="beam-err">This browser can't make device-to-device connections.</p><button class="btn" id="beamX">Close</button>`); el('beamX').onclick = closeOverlay; return; }
  const { joinRoom, qrToDataURL } = await loadDeps();
  const secret = randomSecret();
  const url = `${location.origin}${location.pathname}#beam=${b64url(secret)}`;
  const qr = await qrToDataURL(url);
  await keepAwake();

  let session = null;
  const withClose = html => { card(p, html + `<button class="beam-close" aria-label="Close">×</button>`); const x = p.querySelector('.beam-close'); if (x) x.onclick = () => { session?.cancel(); closeOverlay(); }; };

  withClose(`<h3>Send to my phone</h3><p>On your phone (same Wi-Fi), open the Camera app and scan this:</p>
    <img class="beam-qr" src="${qr}" alt="Pairing QR code"><p class="beam-status" role="status">Waiting for your phone…</p>`);

  session = createBeamSession({
    role: 'send', joinRoom, secret, getSnapshot: async () => buildTmSnapshot(ctx.getData()),
    onEvent: e => {
      if (e.type === 'sas') {
        withClose(`<h3>Send to my phone</h3><p>Both screens should show this code:</p>
          <div class="beam-sas">${esc(e.code)}</div>
          <button class="btn btn-primary" id="beamApprove">Codes match — Send</button>
          <p class="beam-status" role="status"></p>`);
        el('beamApprove').onclick = () => { session.approve(); const s = p.querySelector('.beam-status'); if (s) s.textContent = 'Sending…'; el('beamApprove').disabled = true; };
      } else if (e.type === 'progress') { const s = p.querySelector('.beam-status'); if (s) s.textContent = `Sending… ${e.pct || 0}%`; }
      else if (e.type === 'sent') { withClose(`<h3>Send to my phone</h3><p class="beam-done">✓ Sent to your phone.</p>`); releaseAwake(); }
      else if (e.type === 'error') { withClose(`<h3>Send to my phone</h3><p class="beam-err">${esc(errText(e.reason))}</p><p>Or use <b>Export TM data</b> to share the file instead.</p>`); releaseAwake(); }
    },
  });
}

// ── Receiver (phone opened via scanned QR) ──────────────────────────────────────
async function startReceive(secretB64) {
  const p = overlay();
  if (!hasWebRTC()) { card(p, `<h3>Receive team data</h3><p class="beam-err">Open this link in Safari or Chrome (not an in-app browser) to receive.</p><button class="btn" id="beamX">Close</button>`); el('beamX').onclick = closeOverlay; return; }
  const { joinRoom } = await loadDeps();
  const secret = fromB64url(secretB64);
  await keepAwake();
  card(p, `<h3>Receive team data</h3><p>Connecting to your other device…</p><p class="beam-status" role="status"></p>`);

  const session = createBeamSession({
    role: 'receive', joinRoom, secret,
    onEvent: e => {
      if (e.type === 'sas') { const s = p.querySelector('.beam-status'); if (s) s.textContent = `Check this matches the other screen: ${e.code}`; }
      else if (e.type === 'incoming') {
        const local = ctx.getData() ? summariseSnapshot(buildTmSnapshot(ctx.getData())) : { team_name: '(nothing yet)' };
        const when = e.metadata?._exported_at ? ` · exported ${new Date(e.metadata._exported_at).toLocaleString()}` : '';
        card(p, `<h3>Receive team data</h3>
          <p>Incoming: <b>${esc(e.metadata?.team_name || 'team')}</b>${esc(when)}</p>
          <p class="beam-warn">This <b>replaces everything</b> on this device (now: ${esc(local.team_name)}).</p>
          <button class="btn btn-primary" id="beamImport">Import &amp; replace</button> <button class="btn" id="beamCancel">Cancel</button>`);
        el('beamCancel').onclick = () => { session.cancel(); closeOverlay(); };
        el('beamImport').onclick = () => {
          el('beamImport').disabled = true;
          e.accept(async norm => {
            await applyTmSnapshot(norm, { persist: ctx.persist, whenPersisted: ctx.whenPersisted, dispatch: ctx.dispatch, backup: ctx.backupCurrentForUndo });
            ctx.render();
          });
        };
      } else if (e.type === 'received') {
        card(p, `<h3>Receive team data</h3><p class="beam-done">✓ Imported.</p>
          <button class="btn" id="beamUndo">Undo import</button> <button class="btn btn-primary" id="beamOk">Done</button>`);
        releaseAwake();
        el('beamOk').onclick = closeOverlay;
        el('beamUndo').onclick = async () => { try { await ctx.undoBeamImport(); } catch (_) {} closeOverlay(); };
      } else if (e.type === 'error') { card(p, `<h3>Receive team data</h3><p class="beam-err">${esc(errText(e.reason))}</p><button class="btn" id="beamX">Close</button>`); releaseAwake(); const x = el('beamX'); if (x) x.onclick = closeOverlay; }
    },
  });
}
