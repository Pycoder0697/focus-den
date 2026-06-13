/* Focus Den — Web Push backend (Cloudflare Worker, cron-driven).
 *
 * Runs once a minute. Reads pending "alarms" from the same Firebase Realtime DB
 * the app already syncs to (a SEPARATE /push subtree so the app's state blob never
 * clobbers it), and for every alarm whose fire time has arrived it sends a real
 * Web Push to that device — so the focus/break-end banner lands even when the
 * Focus Den PWA is fully closed (Mac dock app / iOS Home-Screen app, iOS 16.4+).
 *
 * The app writes an alarm when a pomodoro phase is running and clears/overwrites it
 * when it handles the boundary itself — so while the app is alive it advances the
 * alarm before this cron fires (no duplicate), and only a closed app relies on us.
 *
 * Self-contained: VAPID (RFC 8292) JWT + aes128gcm payload encryption (RFC 8291)
 * via WebCrypto — no npm deps, single file, mirrors notion-proxy-worker.js style.
 *
 * Secrets (wrangler secret put …):
 *   RTDB_URL           https://…firebasedatabase.app   (no trailing path)
 *   RTDB_KEY           the app's CLOUD.key (secret path segment)
 *   VAPID_PUBLIC       base64url, 65-byte P-256 point (also goes in index.html)
 *   VAPID_PRIVATE_JWK  JSON string of the EC private JWK  (KEEP PRIVATE)
 *   VAPID_SUBJECT      mailto:you@example.com
 * Generate the VAPID pair once with:  node push-backend/generate-vapid.mjs
 */

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(runCron(env)); },
  async fetch(req, env) {
    const u = new URL(req.url);
    // Manual trigger for testing, GATED by a secret so it can't be hit (or used to leak the
    // _DBG diagnostics) by anyone who learns the worker URL. Set it once:
    //   wrangler secret put RUN_KEY
    // then call /run?key=<RUN_KEY>. With RUN_KEY unset the endpoint is disabled entirely.
    // Normal closed-app push delivery is the cron `scheduled()` handler above and is unaffected.
    if (u.pathname === '/run') {
      if (!env.RUN_KEY || u.searchParams.get('key') !== env.RUN_KEY)
        return new Response('Not found', { status: 404 });
      try { const n = await runCron(env); return json({ ran: true, processed: n, debug: _DBG }); }
      catch (e) { return json({ error: String(e && e.stack ? e.stack : e), debug: _DBG }, 500); }
    }
    return new Response('Focus Den push worker', { headers: { 'content-type': 'text/plain' } });
  }
};

let _DBG = [];
async function runCron(env) {
  _DBG = [];
  const base = (env.RTDB_URL || '').replace(/\/+$/, '');
  const keyPath = encodeURIComponent(env.RTDB_KEY || '');
  if (!base || !env.RTDB_KEY) return 0;
  const r = await fetch(`${base}/push/${keyPath}.json`, { cf: { cacheTtl: 0 } }); // Workers fetch: no 'cache' init field — use cf.cacheTtl
  if (!r.ok) return 0;
  const data = await r.json();
  if (!data || typeof data !== 'object') return 0;
  const now = Date.now();
  let processed = 0;
  const jobs = [];
  for (const device of Object.keys(data)) {
    const a = data[device];
    if (!a || !a.sub) continue;
    const del = () => fetch(`${base}/push/${keyPath}/${encodeURIComponent(device)}.json`, { method: 'DELETE' });
    if (!a.fireAt) continue;
    if (a.fireAt > now + 2000) continue;              // not due yet
    if (a.fireAt < now - 3600 * 1000) { jobs.push(del()); continue; } // >1h stale → drop, don't nag
    processed++;
    jobs.push((async () => {
      try {
        const res = await sendPush(a.sub, { title: a.title || 'Focus Den', body: a.body || '', tag: a.tag || 'fd-timer' }, env);
        if (!(res.status >= 200 && res.status < 300)) { const t = await res.text().catch(() => ''); _DBG.push('push ' + res.status + ': ' + t.slice(0, 200)); }
        // Delete on success or if the subscription is gone (404/410) so we never repeat.
        if ((res.status >= 200 && res.status < 300) || res.status === 404 || res.status === 410) await del();
      } catch (e) { _DBG.push('throw: ' + String(e && e.stack ? e.stack : e)); }
    })());
  }
  await Promise.all(jobs);
  return processed;
}

/* ----------------------------- Web Push send ----------------------------- */

async function sendPush(sub, payloadObj, env) {
  const body = await encryptPayload(sub, JSON.stringify(payloadObj));
  return fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'TTL': '300',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'Urgency': 'high',
      'Authorization': await vapidAuth(sub.endpoint, env)
    },
    body
  });
}

// VAPID (RFC 8292): signed JWT in the Authorization header, public key in the k= param.
async function vapidAuth(endpoint, env) {
  const aud = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = { aud, exp: now + 12 * 3600, sub: env.VAPID_SUBJECT || 'mailto:focusden@example.com' };
  const signingInput = b64url(utf8(JSON.stringify(header))) + '.' + b64url(utf8(JSON.stringify(payload)));
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(signingInput))); // raw r||s == JWS ES256
  return 'vapid t=' + signingInput + '.' + b64url(sig) + ', k=' + env.VAPID_PUBLIC;
}

// aes128gcm content encryption for Web Push (RFC 8291 + RFC 8188).
async function encryptPayload(sub, plaintextStr) {
  const uaPublic = b64urlToBytes(sub.keys.p256dh);   // 65-byte client public point
  const authSecret = b64urlToBytes(sub.keys.auth);   // 16-byte client auth secret

  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey)); // 65 bytes
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256)); // 32 bytes

  const salt = crypto.getRandomValues(new Uint8Array(16));

  // Combine ECDH secret with the auth secret (RFC 8291 §3.4)
  const prkKey = await hmac(authSecret, ecdh);
  const keyInfo = concat(utf8('WebPush: info\0'), uaPublic, asPublic);
  const ikm = (await hmac(prkKey, concat(keyInfo, U8(1)))).slice(0, 32);

  // Derive content-encryption key + nonce (RFC 8188)
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(utf8('Content-Encoding: aes128gcm\0'), U8(1)))).slice(0, 16);
  const nonce = (await hmac(prk, concat(utf8('Content-Encoding: nonce\0'), U8(1)))).slice(0, 12);

  // Single record: plaintext || 0x02 delimiter (last record), no extra padding
  const record = concat(utf8(plaintextStr), U8(2));
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, record));

  // Header: salt(16) | rs(4, BE) | idlen(1) | keyid(as_public,65) | ciphertext
  const rs = 4096;
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs, false);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ct);
}

/* ------------------------------- helpers -------------------------------- */
const enc = new TextEncoder();
function utf8(s) { return enc.encode(s); }
function U8() { return new Uint8Array(Array.prototype.slice.call(arguments)); }
function concat(...arr) { let n = 0; for (const a of arr) n += a.length; const o = new Uint8Array(n); let p = 0; for (const a of arr) { o.set(a, p); p += a.length; } return o; }
async function hmac(keyBytes, dataBytes) {
  const k = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, dataBytes));
}
function b64url(bytes) { let s = ''; const a = new Uint8Array(bytes); for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64urlToBytes(str) { str = String(str).replace(/-/g, '+').replace(/_/g, '/'); const pad = str.length % 4 ? 4 - (str.length % 4) : 0; str += '='.repeat(pad); const bin = atob(str); const o = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i); return o; }
function json(o, status) { return new Response(JSON.stringify(o), { status: status || 200, headers: { 'content-type': 'application/json' } }); }
