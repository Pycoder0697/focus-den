# Focus Den — Web Push backend

Real notifications when the app is **fully closed**: a Cloudflare Worker runs once a
minute, reads pending "alarms" from the same Firebase Realtime DB the app already uses,
and sends a Web Push for any focus/break that has ended. This is the backstop for the
in-app local notifications (which only fire while the app is open/backgrounded-alive).

Works on the **installed** PWA only: macOS dock app, and iOS Home-Screen app (iOS 16.4+).
Not in a browser tab, not in the Notion iframe.

## How it fits together
- App (`index.html`) → on a running pomodoro, writes `/push/<KEY>/<device> = {fireAt, title, body, sub}`
  to the RTDB and clears/overwrites it as phases change. (Separate `/push` subtree, so the
  app's state blob never clobbers it.)
- Worker (`push-worker.js`) → every minute, sends a push for any alarm whose `fireAt` has
  arrived, then deletes it. Self-contained VAPID (RFC 8292) + aes128gcm (RFC 8291) via WebCrypto.
- Service worker (`../sw.js`) → `push` handler shows the banner; `notificationclick` focuses/opens
  the app.

Because the live app advances the alarm before each boundary, a **closed** app is the only
one that actually receives a server push — no duplicate with the local notification (and the
shared `tag: fd-timer` collapses any overlap anyway).

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
- Manual worker trigger (don't wait for cron): visit `https://<your-worker>.workers.dev/run`.

## Notes
- **Timing:** cron granularity is 1 minute, so the closed-app push can be up to ~60 s late.
  The local notification (app open) is exact; this is only the closed-app backstop.
- **Scope:** the server pings the *next* boundary after you leave; it does not run the whole
  pomodoro chain in the cloud (when you're away from the app you're not doing the cycle anyway).
- **Cost:** Cloudflare Workers free tier (cron triggers included). No Firebase Blaze needed —
  the worker talks to the RTDB over REST, same as the app.
- **Security:** only the VAPID *public* key ships to the client. The private JWK lives solely
  as a worker secret. Push subscriptions stored in `/push` are not sensitive.
