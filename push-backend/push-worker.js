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
const RESERVED = { subs: 1, alarm: 1, live: 1 }; // children of /push/<key> that are NOT legacy per-device alarms
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

  /* ---- SHARED alarm → fan out to every CLOSED device ---------------------
   * The running app writes ONE alarm (/push/<key>/alarm) carrying the whole
   * schedule, and every device registers itself under /push/<key>/subs/<device>
   * with a heartbeat `alive`. For each due boundary we push to every device
   * whose heartbeat is STALE (app closed) and skip fresh ones (app open → it
   * already fired the notification locally), so exactly one banner lands per
   * device no matter which device runs the timer. */
  const subs = (data.subs && typeof data.subs === 'object') ? data.subs : {};
  const alarm = data.alarm;
  const ALIVE_MS = 90 * 1000;  // heartbeat younger than this ⇒ app open ⇒ skip (it self-notifies). Margin over the
                               // 30s client heartbeat so a backgrounded-but-alive tab (timers throttle to ~60s) still reads as open.
  const epOf = (s) => (s && s.sub && s.sub.endpoint) || '';
  if (alarm && Array.isArray(alarm.schedule)) {
    const aRef = `${base}/push/${keyPath}/alarm.json`;
    const items = alarm.schedule.filter(x => x && typeof x.fireAt === 'number');
    const due = items.filter(x => x.fireAt <= now + 2000 && x.fireAt >= now - 3600 * 1000);
    const future = items.filter(x => x.fireAt > now + 2000);
    if (due.length) {
      const fire = due[due.length - 1]; // collapse any missed boundaries into one banner (mirrors the live app's single catch-up chime)
      // Suppress by push ENDPOINT, not device id: a browser keeps the SAME endpoint when its fd_device id
      // churns (cleared storage / in-memory fallback), so a ghost subs/<oldId> with no heartbeat would look
      // "stale" forever and get pushed — landing a duplicate banner on a device that's open and already chimed.
      // Any endpoint owned by a FRESH heartbeat is open ⇒ never push it; also dedup so one endpoint gets at most one push.
      const freshEndpoints = new Set();
      for (const d of Object.keys(subs)) { const ep = epOf(subs[d]); if (ep && now - (subs[d].alive || 0) < ALIVE_MS) freshEndpoints.add(ep); }
      const pushedEndpoints = new Set();
      for (const device of Object.keys(subs)) {
        const s = subs[device];
        if (!s || !s.sub) continue;
        const ep = epOf(s);
        if (ep && freshEndpoints.has(ep)) {                            // app open on this browser (under this or another device id)
          if (now - (s.alive || 0) >= ALIVE_MS) jobs.push(fetch(`${base}/push/${keyPath}/subs/${encodeURIComponent(device)}.json`, { method: 'DELETE' })); // self-heal: drop the stale ghost entry
          continue;
        }
        if (ep && pushedEndpoints.has(ep)) continue;                   // already pushed to this browser in this tick
        if (now - (s.alive || 0) < ALIVE_MS) continue;                 // open (endpointless legacy entry) → it self-notified
        if (ep) pushedEndpoints.add(ep);
        processed++;
        jobs.push((async () => {
          try {
            const res = await sendPush(s.sub, { title: fire.title || 'Focus Den', body: fire.body || '', tag: alarm.tag || 'fd-timer' }, env);
            if (res.status === 404 || res.status === 410) await fetch(`${base}/push/${keyPath}/subs/${encodeURIComponent(device)}.json`, { method: 'DELETE' });
            else if (!(res.status >= 200 && res.status < 300)) { const t = await res.text().catch(() => ''); _DBG.push('push ' + res.status + ': ' + t.slice(0, 200)); }
          } catch (e) { _DBG.push('throw: ' + String(e && e.stack ? e.stack : e)); }
        })());
      }
    }
    // advance the shared alarm: keep only still-future boundaries, or drop it when the run is done
    if (due.length || (items.length && !future.length)) {
      if (future.length) jobs.push(fetch(aRef, { method: 'PUT', body: JSON.stringify({ ...alarm, schedule: future, fireAt: future[0].fireAt, title: future[0].title, body: future[0].body }) }));
      else jobs.push(fetch(aRef, { method: 'DELETE' }));
    }
  }

  /* ---- LEGACY per-device alarms (older clients) -------------------------- */
  for (const device of Object.keys(data)) {
    if (RESERVED[device]) continue;
    const a = data[device];
    if (!a || !a.sub) continue;
    const ref = `${base}/push/${keyPath}/${encodeURIComponent(device)}.json`;
    const del = () => fetch(ref, { method: 'DELETE' });

    // Schedule-based alarm (current client): a list of every upcoming boundary of the run,
    // drained one cron tick at a time so a CLOSED app gets a push at EACH boundary — not just
    // the first. Fire the latest due boundary (collapsing any missed ones into a single banner,
    // mirroring the live app's single chime on catch-up), then persist only the still-future
    // boundaries (or drop the alarm when none remain).
    if (Array.isArray(a.schedule)) {
      const items = a.schedule.filter(x => x && typeof x.fireAt === 'number');
      const due = items.filter(x => x.fireAt <= now + 2000 && x.fireAt >= now - 3600 * 1000);
      const stale = items.filter(x => x.fireAt < now - 3600 * 1000); // >1h late → drop, don't nag
      const future = items.filter(x => x.fireAt > now + 2000);
      if (!due.length && !stale.length) continue;     // nothing actionable yet — leave it
      jobs.push((async () => {
        let gone = false;
        if (due.length) {
          processed++;
          const fire = due[due.length - 1];
          try {
            const res = await sendPush(a.sub, { title: fire.title || 'Focus Den', body: fire.body || '', tag: a.tag || 'fd-timer' }, env);
            if (res.status === 404 || res.status === 410) gone = true;
            else if (!(res.status >= 200 && res.status < 300)) { const t = await res.text().catch(() => ''); _DBG.push('push ' + res.status + ': ' + t.slice(0, 200)); }
          } catch (e) { _DBG.push('throw: ' + String(e && e.stack ? e.stack : e)); }
        }
        if (gone || !future.length) { await del(); }   // subscription dead or run finished → clear
        else { const next = future[0]; await fetch(ref, { method: 'PUT', body: JSON.stringify({ ...a, schedule: future, fireAt: next.fireAt, title: next.title, body: next.body }) }); }
      })());
      continue;
    }

    // Legacy single-boundary alarm (older client / fallback).
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
  try { await reconcileNotionTimers(env, base, keyPath, now); } catch (e) { _DBG.push('notion: ' + String(e && e.stack ? e.stack : e)); }
  return processed;
}

/* ---- Notion Start/Stop buttons → server-owned study sessions -------------------------
 * SINGLE authority for the Notion timer checkbox. Every open client used to react to the same box
 * flip, so the always-open Notion embed AND the laptop each ran their own stopwatch → overlapping,
 * double-logged sessions (and each re-checked the box the other unchecked → "Stop not working").
 * Here ONE cron edge-triggers on the flip and owns the whole session, so it also works with the app
 * fully closed. State + the finished-session queue live under /push/<key>/ntimer ONLY — never the
 * app's /focusden state blob — so a bug here can't corrupt the study log; the app imports finished
 * sessions by id (union-only, never removes). */
async function reconcileNotionTimers(env, base, keyPath, now) {
  const app = `${base}/focusden/${keyPath}`;
  const nt = `${base}/push/${keyPath}/ntimer`;
  const getJson = async (url) => { try { const r = await fetch(url, { cf: { cacheTtl: 0 } }); if (!r.ok) return null; return await r.json(); } catch (e) { return null; } };

  const settings = (await getJson(`${app}/settings.json`)) || {};
  const proxy = String(settings.notionProxy || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(proxy)) return;                         // no Notion proxy configured → nothing to do
  const nkey = String(settings.notionKey || '').trim();
  const sources = await getJson(`${app}/notionSources.json`);
  if (!Array.isArray(sources)) return;
  const timerSources = sources.filter((s) => s && s.enabled !== false && s.dbId && s.schema && s.schema.timerProp);
  if (!timerSources.length) return;

  const tasksArr = await getJson(`${app}/tasks.json`);
  const taskArr = Array.isArray(tasksArr) ? tasksArr : [];
  const findTask = (pid) => taskArr.find((t) => t && t.notionPageId === pid) || null;
  const subjArr = await getJson(`${app}/subjects.json`);
  const subjById = (id) => (Array.isArray(subjArr) ? subjArr.find((s) => s && s.id === id) : null) || null;

  const shadow = (await getJson(`${nt}/shadow.json`)) || {};       // pageId → last-seen box value (persisted edge-trigger memory)
  const state = (await getJson(`${nt}/state.json`)) || {};         // pageId → {start,taskId,subjectIds,taskName} for a running session
  const shadowUpd = {};
  const writes = [];
  const uid = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  // split a finished session across the task's subjects exactly like the app's commit(): one row per
  // subject with share=1/N (single-subject rows carry no share ⇒ ×1), so totals never double-count.
  const rowsFor = (s, start, end) => {
    const subs = Array.isArray(s.subjectIds) ? s.subjectIds.filter(Boolean) : [];
    const b = { start, end, taskId: s.taskId || '' };
    if (!subs.length) return [{ id: uid(), subjectId: '', ...b }];
    if (subs.length === 1) return [{ id: uid(), subjectId: subs[0], ...b }];
    return subs.map((sid) => ({ id: uid(), subjectId: sid, share: 1 / subs.length, ...b }));
  };

  // A Worker can't fetch another same-account Worker via its workers.dev URL (404s), so go through the
  // NOTION service binding when present; the host in the URL is ignored by the binding (only path+query matter).
  const proxyFetch = (u, o) => (env.NOTION ? env.NOTION.fetch(u, o) : fetch(u, o));
  for (const src of timerSources) {
    let url = `${proxy}/?db=${encodeURIComponent(src.dbId)}`;
    const m = src.map || {};
    if (m.timerProp !== undefined) url += `&timer=${encodeURIComponent(m.timerProp || '')}`;
    let data;
    try {
      const r = await proxyFetch(url, { headers: nkey ? { 'x-sync-key': nkey } : {} });
      if (!r.ok) { _DBG.push('notion GET ' + r.status); continue; }
      data = await r.json();
    } catch (e) { _DBG.push('notion fetch throw: ' + String(e && e.message ? e.message : e)); continue; }
    if (!data || data.ok === false || !Array.isArray(data.results)) continue;
    for (const row of data.results) {
      const pid = row.id; if (!pid) continue;
      const checked = !!row.timer;
      const prev = shadow[pid];
      shadowUpd[pid] = checked;
      if (prev === undefined) continue;                            // first sight → baseline only (never auto-start on deploy)
      if (checked === prev) continue;                              // no flip
      if (checked) {                                               // START: record when the session began
        const t = findTask(pid);
        state[pid] = { start: now, taskId: t ? t.id : '', subjectIds: (t && Array.isArray(t.subjectIds)) ? t.subjectIds : [], taskName: t ? t.name : '' };
        writes.push(fetch(`${nt}/state/${encodeURIComponent(pid)}.json`, { method: 'PUT', body: JSON.stringify(state[pid]) }));
      } else {                                                     // STOP: commit the finished session to the import queue
        const s = state[pid];
        if (s && s.start) {
          for (const rr of rowsFor(s, s.start, now)) writes.push(fetch(`${nt}/log/${encodeURIComponent(rr.id)}.json`, { method: 'PUT', body: JSON.stringify(rr) }));
          delete state[pid];
          writes.push(fetch(`${nt}/state/${encodeURIComponent(pid)}.json`, { method: 'DELETE' }));
        }
      }
    }
  }
  // safety: drop any session left running implausibly long (user forgot to press Stop) so it never logs a monster block
  for (const pid of Object.keys(state)) {
    const s = state[pid];
    if (s && s.start && now - s.start > 18 * 3600 * 1000) { delete state[pid]; writes.push(fetch(`${nt}/state/${encodeURIComponent(pid)}.json`, { method: 'DELETE' })); }
  }

  // --- Live-timer mirror: show a running Notion-button session in Focus Den immediately -----------
  // A ▶ Start only records server-side `state` above; a session isn't imported until ⏹ Stop — so with no
  // live feedback, Start reads as "nothing happened". Focus Den already renders /push/<key>/live as a
  // running timer on every idle device (pollTimerState/renderMirror), so publish the running Notion
  // session there (owner:'notion') to surface a live counting stopwatch the instant Start is seen, and
  // clear it on Stop. Refreshed every cron so its `savedAt` never crosses the 120s staleness cutoff.
  // A device running its OWN local timer always wins (fresher record + it ignores this on its own screen),
  // and we skip publishing whenever a real device is broadcasting a fresh live record — so a genuine
  // cross-device session is never stomped.
  const liveRef = `${base}/push/${keyPath}/live.json`;
  const running = Object.keys(state).filter((pid) => state[pid] && state[pid].start);
  let liveRec = null; try { liveRec = await getJson(liveRef); } catch (e) {}
  const realDeviceLive = liveRec && liveRec.owner !== 'notion' && liveRec.savedAt && (now - liveRec.savedAt < 90 * 1000)
    && (liveRec.live !== undefined ? liveRec.live : liveRec.active);
  if (running.length) {
    if (!realDeviceLive) {
      const pid = running.sort((a, b) => (state[b].start || 0) - (state[a].start || 0))[0]; // most recently started
      const s = state[pid];
      const sid = (Array.isArray(s.subjectIds) ? s.subjectIds : [])[0] || '';
      const subj = sid ? subjById(sid) : null;
      writes.push(fetch(liveRef, { method: 'PUT', body: JSON.stringify({
        owner: 'notion', device: 'notion', active: true, live: true, paused: false,
        mode: 'stopwatch', phase: 'focus', endStamp: null, phaseStart: null, remaining: 0,
        roundCount: 0, oneShot: false, n: 0, swBase: 0, segStart: s.start || now,
        taskName: s.taskName || '', subjectName: subj ? subj.name : '', subjectColor: subj ? subj.color : '',
        habitName: '', schedule: [], savedAt: now
      }) }));
    }
  } else if (liveRec && liveRec.owner === 'notion' && (liveRec.live !== undefined ? liveRec.live : liveRec.active)) {
    // our Notion session ended → clear the shared record so idle devices drop the mirror on their next poll
    writes.push(fetch(liveRef, { method: 'PUT', body: JSON.stringify({ owner: 'notion', device: 'notion', active: false, live: false, endedAt: now, savedAt: now }) }));
  }

  if (Object.keys(shadowUpd).length) writes.push(fetch(`${nt}/shadow.json`, { method: 'PATCH', body: JSON.stringify(shadowUpd) }));
  await Promise.all(writes);
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
