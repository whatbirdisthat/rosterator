'use strict';

// @front-end
// element: beam
// intent: serverless P2P TM_DATA pairing + transfer between a user's OWN devices.
//   A pure state machine — NO DOM, NO vendor import (joinRoom is injected) — so it
//   unit-tests against a FakeRoom. The UI (QR, SAS card, confirm, banners) is in index.js.
// customer: developer
// binding: event-driven (onEvent)
// breadcrumbs:
//   - "security = exactly-one-peer gate + a 6-digit SAS both screens must match + single-use secret"
//   - "no TURN: data flows only over the direct DTLS DataChannel; never relayed"
//   - "0.25.2 Trystero surface: room.onPeerJoin= ; action.send(data,{target,metadata,onProgress}); action.onMessage=(d,{peerId,metadata})=>"

import { encodeSnapshot, decodeSnapshot, sha256Hex } from './beam-codec.mjs';
import { validateTmSnapshot } from './tm-data.mjs';

export const BEAM_APP_ID = 'footy-manager-beam-v1';
const PEER_TIMEOUT_MS = 30000;
const te = new TextEncoder();

// ── pure crypto/encoding helpers (exported for unit tests) ──────────────────────
export function randomSecret() { return crypto.getRandomValues(new Uint8Array(16)); }

export function b64url(bytes) {
  const s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function fromB64url(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
async function sha256(bytes) { return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)); }
const hex = a => [...a].map(b => b.toString(16).padStart(2, '0')).join('');

// Domain-separated room id + signaling password from a pairing secret.
export async function deriveRoom(secret) {
  return {
    roomId: hex(await sha256(te.encode('beam.room|' + b64url(secret)))).slice(0, 20),
    password: hex(await sha256(te.encode('beam.pw|' + b64url(secret)))),
  };
}

// 6-digit short-auth-string from two nonces exchanged over the E2E channel.
export async function sasFromNonces(a, b) {
  const [x, y] = [b64url(a), b64url(b)].sort();
  const d = await sha256(te.encode(x + '|' + y));
  return String(((d[0] << 16) | (d[1] << 8) | d[2]) % 1000000).padStart(6, '0');
}

const asBytes = d => (d instanceof Uint8Array ? d : new Uint8Array(d));

// ── the session ─────────────────────────────────────────────────────────────
// createBeamSession({ role:'send'|'receive', joinRoom, secret, getSnapshot?, appId?, peerTimeoutMs?, onEvent })
// onEvent emits: {type:'waiting'} · {type:'sas',code} · {type:'progress',pct} ·
//   {type:'incoming',metadata,accept} · {type:'sent'|'received'|'cancelled'} · {type:'error',reason}
// Returns { approve(), cancel() }. Sender: approve() after the human confirms the SAS.
export function createBeamSession({ role, joinRoom, secret, getSnapshot, appId = BEAM_APP_ID, peerTimeoutMs = PEER_TIMEOUT_MS, onEvent = () => {} }) {
  const st = { room: null, peerId: null, done: false, approved: false, sas: null,
               myNonce: crypto.getRandomValues(new Uint8Array(16)), timer: null };
  const act = {};

  function stop(type, extra) {
    if (st.done) return;
    st.done = true;
    clearTimeout(st.timer);
    try { st.room?.leave(); } catch (_) {}
    onEvent({ type, ...extra });
  }
  const fail = reason => stop('error', { reason });

  async function maybeSend() {
    if (role !== 'send' || !st.approved || !st.sas || !st.peerId || st.done) return;
    const snapshot = await getSnapshot();
    const bytes = await encodeSnapshot(snapshot);
    const sha256hex = await sha256Hex(bytes);
    act.tm.send(bytes, {
      target: st.peerId,
      metadata: { sha256: sha256hex, bytes: bytes.length, team_name: snapshot?.user_team?.team_name,
                  _exported_at: snapshot?._exported_at, _schema_version: 1 },
      onProgress: pct => onEvent({ type: 'progress', pct }),
    });
  }

  function onPeer(id) {
    if (st.done) return;
    if (st.peerId && id !== st.peerId) return fail('multi-peer'); // exactly one peer
    if (st.peerId) return;
    st.peerId = id;
    clearTimeout(st.timer);
    act.hs.send(st.myNonce, { target: id });
  }

  async function onHs(data, from) {
    if (from !== st.peerId) return fail('multi-peer');
    st.sas = await sasFromNonces(st.myNonce, asBytes(data));
    onEvent({ type: 'sas', code: st.sas });
    maybeSend();
  }

  async function onTm(data, from, metadata) {
    if (from !== st.peerId || role !== 'receive' || st.done) return;
    try {
      const bytes = asBytes(data);
      if (metadata?.sha256 && (await sha256Hex(bytes)) !== metadata.sha256) return fail('integrity');
      const { ok, normalized } = validateTmSnapshot(await decodeSnapshot(bytes));
      if (!ok) return fail('invalid');
      onEvent({ type: 'incoming', metadata, accept: async applier => {
        await applier(normalized);
        try { act.ack.send({ ok: true }, { target: st.peerId }); } catch (_) {}
        stop('received');
      } });
    } catch (_) { fail('decode'); }
  }

  (async () => {
    const { roomId, password } = await deriveRoom(secret);
    st.room = joinRoom({ appId, password }, roomId);
    act.hs = st.room.makeAction('hs');
    act.tm = st.room.makeAction('tmdata');
    act.ack = st.room.makeAction('ack');
    st.room.onPeerJoin = onPeer;
    st.room.onPeerLeave = id => { if (id === st.peerId) fail('peer-left'); };
    act.hs.onMessage = (d, m) => onHs(d, m.peerId);
    act.tm.onReceiveProgress = pct => onEvent({ type: 'progress', pct });
    act.tm.onMessage = (d, m) => onTm(d, m.peerId, m.metadata);
    act.ack.onMessage = (d, m) => { if (m.peerId === st.peerId && role === 'send') stop('sent'); };
    onEvent({ type: 'waiting' });
    st.timer = setTimeout(() => fail('no-peer'), peerTimeoutMs);
  })().catch(() => fail('init'));

  return {
    approve() { st.approved = true; maybeSend(); },
    cancel() { stop('cancelled'); },
  };
}
