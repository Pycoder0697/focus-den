# Focus Den ⇄ Notion sync

A tiny, dependency-free Node service that keeps a **Notion database** and your **Focus Den** tasks in two-way sync — the same idea as TickTick's Notion integration, but self-hosted and free.

It works by bridging **Firebase ↔ Notion**. Focus Den already saves its whole state to a Firebase Realtime DB (the in-app cloud sync). This service reads that snapshot and reconciles it with a Notion database, so sync keeps happening even when the app/tab is closed. The Focus Den app needs **no changes** — it just keeps writing to Firebase as usual.

```
Focus Den (browser)  ──writes──►  Firebase RTDB  ◄──reconciles──►  Notion DB
        ▲                                                              │
        └──────────────── pulls Notion-side edits back ───────────────┘
```

## What syncs

Per top-level task (subtasks are left local in v1):

| Focus Den        | Notion property        |
|------------------|------------------------|
| task name        | Title                  |
| done             | `Done` (checkbox)      |
| due date         | `Due` (date)           |
| priority 0–3     | `Priority` (select: None/Low/Medium/High) |
| subject          | `Subject` (select)     |
| repeat           | `Repeat` (select)      |
| task id (hidden) | `FocusDenID` (text)    |

- New task in Focus Den → new Notion page (and vice-versa).
- Edit either side → the other updates.
- Delete either side → the other is removed/archived (set `MIRROR_DELETES=false` to keep).
- New subjects coming from Notion are created in Focus Den automatically.

The server **auto-creates any missing properties** on your Notion database the first time it runs, so you only need an (even empty) database to point it at.

## Setup (≈5 min)

1. **Create a Notion integration** → https://www.notion.so/my-integrations → *New integration* (internal). Copy the **Internal Integration Secret** (`secret_…`).
2. **Create / pick a Notion database** (a full-page database). Open its **•••  → Connections → Connect to → your integration**.
3. **Get the database ID** from its URL:
   `https://www.notion.so/<workspace>/`**`<32-char-id>`**`?v=…`
4. **Get your Focus Den cloud values** — the `CLOUD.url` and `CLOUD.key` from the top of `index.html` (or the in-app cloud-sync setup). These are `FIREBASE_URL` and `FOCUSDEN_KEY`.
5. `cp .env.example .env` and fill it in.
6. Run it (Node 18+):

```bash
cd notion-sync
node server.js          # runs forever, syncing every SYNC_INTERVAL_MS
# or a single reconcile:
node server.js --once
```

Check health at `http://localhost:8787/` (last run, counts, errors). Force a sync with `curl -X POST localhost:8787/sync`.

## Always-on hosting (free tiers)

It's one file with no dependencies, so any Node host works:

- **Render / Railway / Fly.io** — "Background Worker" / web service, start command `node server.js`, set the env vars from `.env` in the dashboard. (On Render Free, a web service idles; the built-in HTTP status server keeps it warm, or use a cron-job pinger.)
- **A cron box / Raspberry Pi / any VPS** — `node server.js --once` on a `*/2 * * * *` cron is the simplest reliable setup.

## Conflict handling & limits (v1, be aware)

- Conflicts are detected with a content **hash** per task plus Notion's `last_edited_time`. If **both** sides changed the same task between two runs, `CONFLICT_WINNER` (`notion` | `focusden`) decides.
- Focus Den has no per-task "modified" timestamp, so detection is best-effort, not transactional. Pick a sync interval (default 30s) comfortably longer than how fast you edit the same task in two places at once.
- Only **top-level** tasks sync (subtasks/checklists stay in Focus Den). Period-horizon tasks (week/month/quarter/year) sync as **undated** in Notion; setting a date in Notion converts them to a day task.
- Boards, sessions, stats, and timer data are **not** synced — this is tasks only.

> ⚠️ This module ships untested against live credentials. Do a first run with `--once` and a throwaway Notion database, confirm the counts/health output look right, then point it at your real DB.
