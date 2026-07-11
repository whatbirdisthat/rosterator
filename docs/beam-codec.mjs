'use strict';

// @front-end
// element: beam-codec
// intent: compression + integrity helpers for TM_DATA transfer, using native Web APIs
//         (CompressionStream + WebCrypto). Pure; works in browsers and Node 18+ (vitest).

const enc = new TextEncoder();
const dec = new TextDecoder();

async function streamThrough(stream, bytes) {
  const writer = stream.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const chunks = [];
  const reader = stream.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export async function gzip(bytes)   { return streamThrough(new CompressionStream('gzip'), bytes); }
export async function gunzip(bytes) { return streamThrough(new DecompressionStream('gzip'), bytes); }

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Snapshot object → gzipped bytes, and back.
export async function encodeSnapshot(snapshot) { return gzip(enc.encode(JSON.stringify(snapshot))); }
export async function decodeSnapshot(bytes)    { return JSON.parse(dec.decode(await gunzip(bytes))); }
