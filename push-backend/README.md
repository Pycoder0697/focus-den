# Focus Den — Web Push backend

Real notifications when the app is **fully closed**: a Cloudflare Worker runs once a
minute, reads pending "alarms" from the same Firebase Realtime DB the app already uses,
and sends a Web Push for any focus/break that has ended. This is the backstop for the
in-app local notifications (which only fire while the app is open/backgrounded-alive).

Works on the **installed** PWA only: macOS dock app, and iOS Home-Screen app (iOS 16.4+).
Not in a browser tab, not in the Notion iframe.

## How it fits together (cross-device fan-out)
Notifications now land on **every** device regardless of which one runs the timer. Three keys
live under the `/push/<KEY>` subtree (separate from the app's state blob, so neither clobbers
the other):
- `/push/<KEY>/subs/<device> = {sub, alive, device}` — each device registers its PushSubscription
  here plus a liveness **heartbeat** (`alive`, refreshed every ~30 s while the app is visible).
- `/push/<KEY>/alarm = {schedule:[{fireAt,title,body}…], tag, owner, savedAt}` — the device running
  the pomodoro writes ONE shared alarm carrying every upcoming boundary, overwriting it as phases change.
- `/push/<KEY>/live = {…live timer state…}` — the running device mirrors its live timer here so other
  devices can **see** the running session (handled in-app, not by the worker).

Worker (`push-worker.js`) → every minute, for each due boundary in `alarm.schedule` it pushes to
**every device whose `alive` heartbeat is STALE** (app closed) and **skips fresh ones** (app open →
it already fired the notification locally). So exactly one banner lands per device — the running
device and any open device notify locally; closed devices get the server push. Dead subscriptions
(404/410) are pruned from `subs`. Self-contained VAPID (RFC 8292) + aes128gcm (RFC 8291) via WebCrypto.
Legacy per-device `/push/<KEY>/<device>` alarms from older clients are still drained for back-compat.

Service worker (`../sw.js`) → `push` handler shows the banner; `notificationclick` focuses/opens
the app. The shared `tag: fd-timer` collapses any overlap.

## One-time setup

### 1. Generate VAPID keys
```bash
node generate-vapid.mjs
```
Copy the two values it prints.

### 2. Put the public key in the app
In `index.html`, set:
```js
const PUSH_VAPID_PUBLIC='<the VAPID_PUBLIC value>';
```
Commit + push (GitHub Pages redeploys). Until this is set, push stays off and only local
notifications fire.

### 3. Deploy the worker
```bash
cd push-backend
npm i -g wrangler         # if you don't have it
wrangler login
wrangler deploy           # creates the worker + the every-minute cron trigger
```

### 4. Set the worker secrets
```bash
wrangler secret put VAPID_PUBLIC        # same base64url public key as in index.html
wrangler secret put VAPID_PRIVATE_JWK   # the JSON private JWK — keep private
wrangler secret put VAPID_SUBJECT       # mailto:you@example.com
wrangler secret put RTDB_URL            # https://focus-den-default-rtdb.<region>.firebasedatabase.app
wrangler secret put RTDB_KEY            # the app's CLOUD.key (currently 'Jacr06973kx')
```

### 5. Enable + test on the device
- Open the **installed** PWA → Settings → turn on **Session-end notifications** → Allow.
- Start a short focus block, then fully close the app.
- Within ~1 minute of the block ending you should get the banner.
- Manual worker trigger (don't wait for cron): set a key with `wrangler secret put RUN_KEY`,
  then visit `https://<your-worker>.workers.dev/run?key=<RUN_KEY>`. Without `RUN_KEY` set the
  `/run` endpoint is disabled (returns 404) so it can't be hit by anyone who learns the URL.

## Notes
- **Timing:** cron granularity is 1 minute, so the closed-app push can be up to ~60 s late.
  The local notification (app open) is exact; this is only the closed-app backstop.
- **Scope:** the server drains `alarm.schedule` one boundary per cron tick, fanning each out to all
  closed devices; it does not run the pomodoro chain in the cloud.
- **Cross-device:** start a session on the laptop and the phone shows a live "Running on your other
  device" panel and chimes at each boundary (open) or gets a push (closed), and vice-versa — no
  Firebase-rules change needed (everything is under the already-permitted `/push` subtree).
- **Cost:** Cloudflare Workers free tier (cron triggers included). No Firebase Blaze needed —
  the worker talks to the RTDB over REST, same as the app.
- **Security:** only the VAPID *public* key ships to the client. The private JWK lives solely
  as a worker secret. Push subscriptions stored in `/push` are not sensitive.
