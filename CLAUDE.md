# Focus Den — Project Context for Claude Code

## What this is
A single-file HTML study productivity app for a UPSC Civil Services aspirant.
Live at: https://pycoder0697.github.io/focus-den/
Repo: https://github.com/Pycoder0697/focus-den
Embedded in Notion via iframe.

## File structure
One file only: `index.html`
- All CSS is in a `<style>` block in the `<head>`
- All JS is in a single `<script>` block at the bottom of `<body>`
- No build step, no framework, no dependencies — pure vanilla HTML/CSS/JS
- Deploy = commit index.html → GitHub Pages auto-deploys in ~1 min

## Architecture decisions (do not change without discussion)
- **Unified task model**: one global `tasks` array is the source of truth. Each task has a `subjectId`. Subjects tab and Tasks tab are both filtered views of this array — never reintroduce per-subject todo arrays.
- **Storage**: `localStorage` with an in-memory fallback (`mem{}`) for sandboxed iframes (Notion). Cloud sync via Firebase Realtime DB — credentials live in `CLOUD.url` and `CLOUD.key` at the top of the script.
- **Theme**: CSS variables on `html[data-theme="dark|light"]`. Never hardcode colours — always use the CSS vars defined in `:root`.
- **No frameworks**: no React, no Vue, no build tools. Keep it one file.
- **IST timezone**: all date/time logic uses `Asia/Kolkata`. `todayKey()` returns YYYY-MM-DD in IST.

## Key globals
- `tasks` — unified task array
- `subjects` — subject list (colour, name, id — no todos)
- `sessions` — stopwatch/pomodoro session log
- `settings` — user preferences (examDate, urgentDays, theme, focus/short/long mins, etc.)
- `taskView` — current Tasks tab view: today/tomorrow/inbox/board/matrix/timeline
- `taskFilter` / `subjTaskFilter` — active filter: all/active/done
- `expandedTask` (Set) — which task cards are expanded
- `CLOUD` — Firebase config object

## Key functions
- `save()` — persists all state to localStorage + triggers cloudSave()
- `normalizeData()` — ensures task shape, runs migration from legacy s.todos
- `renderSubjects()` — renders the Subjects tab
- `renderTasks()` — renders the Tasks tab (dispatches to board/matrix/timeline/list)
- `refreshTaskSurfaces()` — re-renders both tabs if visible (call after any task mutation)
- `applyFilter(list, mode)` — filters tasks by all/active/done
- `taskSort(a,b)` — sorts done tasks to bottom, then by priority/due
- `isTaskDone(t)` — respects repeat logic (daily/weekdays/weekly)
- `toggleTask(t)` — toggles done/doneOn respecting repeat
- `quadrant(t)` — returns 0-3 for Eisenhower matrix
- `applyTheme()` — applies saved theme to html element
- `pollCloud()` — pulls remote changes (runs every 15s and on tab refocus)
- `snapshot()` — returns full state object with _updatedAt timestamp
- `FD` — global debug object: FD.state, FD.render(), FD.pull(), FD.reset()

## Task object shape
```json
{
  "id": "t...",
  "name": "string",
  "subjectId": "s0",
  "due": "YYYY-MM-DD",
  "dueEnd": "YYYY-MM-DD",
  "priority": 0,
  "checklist": [{"id":"c...","text":"string","done":false}],
  "done": false,
  "doneOn": "",
  "repeat": "none|daily|weekdays|weekly",
  "start": "HH:MM",
  "dur": 0,
  "created": 1234567890
}
```

## Views in the Tasks tab
- **today / tomorrow / inbox** — flat filtered lists
- **board** — kanban with columns: Overdue, Today, Next 7 days, Inbox
- **matrix** — Eisenhower grid (Important×Urgent). Important = priority ≥ 2. Urgent = due today/overdue or within `settings.urgentDays` days.
- **timeline** — Gantt chart. Drag bar to reschedule, drag right edge to extend span. Split into To-do / Done sections.

## Coding conventions
- Use `$('id')` for getElementById
- Use `esc(str)` for HTML-escaping user content
- Use `uid('prefix')` for generating unique IDs
- Use `todayKey()` for today's date in IST
- Use `addDays(key, n)` for date arithmetic
- Use `to12(hhmm)` for displaying times (12h format)
- Template literals for HTML generation — no innerHTML with string concat
- Never use `sudo npm` or any package manager — no dependencies

## Debug
Open browser console and type `FD`:
- `FD.state` — live data snapshot
- `FD.render()` — force re-render all surfaces
- `FD.pull()` — manually trigger cloud poll
- `FD.reset()` — wipe localStorage and reload (destructive)
- `FD.version` — current version string

## Owner
Justin Jose — UPSC CSE aspirant, Trivandrum. PSIR optional.