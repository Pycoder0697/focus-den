# Focus Den — Security

## Threat model (read this first)

Focus Den is a **public static page** (GitHub Pages) that the Notion embed also loads.
Because the page is public, `CLOUD.url` and `CLOUD.key` in `index.html` are visible to anyone
who views source. The app has **no user login**, so the only thing protecting your data is the
**Firebase Realtime Database security rules** plus the access keys on the two Cloudflare Workers.

This document covers **Tier 1 hardening**: it contains the blast radius (no database-wide reads
or wipes, no enumeration, no cross-path access) and gates the workers. It does **not** make the
data private from someone who reads the page source — the `CLOUD.key` is still in the page. The
only way to get full privacy is to add real authentication (Firebase Auth, rules keyed to your
UID). Tier 1 was chosen deliberately to avoid a login screen and to keep Notion sync untouched.

Nothing here changes the app's behaviour or the Notion sync — it's all backend configuration.

---

## Action checklist (only you can do these — they live in consoles, not the repo)

### 1. Lock down Firebase rules  ⬅ most important
Firebase console → **Realtime Database → Rules** → paste the contents of
[`firebase.rules.json`](firebase.rules.json) → **Publish**.

What it does:
- `".read"/".write": false` at the root → **no one can read the whole DB, list keys, or wipe it**.
- Access is scoped to exactly `/focusden/<key>` (the app's data) and `/push/<key>/<device>`
  (the push alarms). Both still work for the app and the push worker.
- `".validate": "newData.hasChildren()"` forces writes to be objects → blocks a stray giant
  string being written to bloat your free tier.

If your rules were previously `".read": true, ".write": true` (test mode), publishing this is
the single biggest improvement — it closes a world-readable/writable database.

### 2. Lock the Notion proxy worker to your app  ⬅ important
The worker holds your Notion integration token. Without a key, anyone who learns the worker URL
can read **and write** every database you shared with the integration.

1. Cloudflare dash → your `focus-den-notion` worker → **Settings → Variables and Secrets**:
   - Add (encrypted) `SYNC_KEY` = a long random string.
   - (Already defaulted in code) `ALLOW_ORIGIN` only needs setting if you serve the app from a
     domain other than `https://pycoder0697.github.io`.
2. **Redeploy** the worker (so the new `ALLOW_ORIGIN` default in `notion-proxy-worker.js` ships).
3. In the app: **Settings → Notion → "proxy key"** → paste the same `SYNC_KEY` string.
   (It rides cloud sync to all your devices + the embed automatically.)

After this, every proxy request must carry the matching `x-sync-key` header — the app already
sends it, so sync keeps working; outsiders get `401`.

### 3. Redeploy the push worker
`cd push-backend && wrangler deploy` (or paste `push-worker.js` in the dashboard).
This ships the gated `/run` endpoint. Optionally set a key to keep the manual test trigger:
```
wrangler secret put RUN_KEY      # then call /run?key=<RUN_KEY>
```
With `RUN_KEY` unset, `/run` returns 404. Normal push delivery (the 1-min cron) is unaffected.

### 4. (Optional) Rotate `CLOUD.key`
The current key (`Jacr06973kx`) has been public in the repo. Rotating cuts off anyone who may
have copied it — but note the **new** key goes right back into the public page, so this only
helps as a one-time "kick out current abusers," not a durable fix (that's what real auth is for).
If you rotate, you must change it in **three** places together or sync breaks:
1. `CLOUD.key` in `index.html`,
2. the push worker's `RTDB_KEY` secret (`wrangler secret put RTDB_KEY`),
3. then reload every device (the new key starts an empty path; the first device reseeds it).

---

## What's already safe (no action needed)
- No real secrets are committed: the Notion token, VAPID private key, and `.env` files are
  gitignored and never entered git history.
- The Notion token and VAPID private key live only as worker secrets, never in the public page.
- User and Notion content is HTML-escaped (`esc()`) everywhere it's rendered — no XSS sink
  (no `eval`, `document.write`, or untrusted-URL `innerHTML`); external links use `noopener`.

## If you ever want full privacy (Tier 2)
Add Firebase Authentication (email/password, just your account), set the rules to
`".read"/".write": "auth.uid === '<your-uid>'"`, and have the app send the ID token with each
RTDB request. The Notion embed would also need to authenticate or carry a token. This is the
only configuration where a public page source no longer exposes your data.
