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
- **Notion database sync**: specific Notion databases mirror into specific board lists (`notionSources` = `[{id,name,dbId,boardId,listId,enabled,lastSync,lastErr,count}]`). The static page can't call `api.notion.com` (no CORS, secret token can't ship publicly), so a tiny **Cloudflare Worker** (`notion-proxy-worker.js`, NOT part of index.html) holds the token and exposes `GET ?db=<id>` → `{ok,results:[{id,title,done,due,url}]}`. The Worker URL lives in `settings.notionProxy` (rides cloud sync to every device + the embed). Synced rows become **ordinary tasks** with `notionSourceId`+`notionPageId` set. On first import they land in the pinned board list (boardId/listId from the source) with no date — but from there they have FULL task functionality, identical to any hand-made task: schedule to a day, move to inbox/calendar, set priority, run a timer, etc. No view excludes them. After import the user owns placement: each sync only mirrors **name + done** from Notion and never re-touches boardId/listId/due/horizon, so moves and scheduled dates survive re-syncs. Sync upserts by `notionPageId` and prunes rows archived in Notion; a mirror task is only deleted when its whole source is removed (deleting the source in the modal removes its cards). `isNotionTask(t)` is available but no longer gates any view. Auto-syncs on load, every 5 min, and on refocus. UI: Settings → Notion (`ovNotion` modal, `renderNotionList()`).
- **Theme**: CSS variables on `html[data-theme="dark|light"]`. Never hardcode colours — always use the CSS vars defined in `:root`.
- **No frameworks**: no React, no Vue, no build tools. Keep it one file.
- **IST timezone**: all date/time logic uses `Asia/Kolkata`. `todayKey()` returns YYYY-MM-DD in IST.

## Key globals
- `tasks` — unified task array
- `notionSources` — Notion DB → board-list mappings (see Notion database sync above). A task with `notionSourceId` set is a synced mirror (`isNotionTask(t)`); `notionSyncOne(src)` reconciles one DB, `notionSyncAll()` runs them all + persists
- `subjects` — subject list (colour, name, id — no todos)
- `sessions` — stopwatch/pomodoro session log
- `settings` — user preferences (examDate, urgentDays, theme, focus/short/long mins, etc.)
- `taskView` — current Tasks tab view: day/week/month/quarter/year/life/horizon/inbox/boards/board/calendar/dashboard/matrix/timeline (no more "tomorrow"; "board" = the date-kanban "Agenda", "boards" = user kanban boards, "calendar" = TimeStripe-style month grid)
- `settings.taskLayout` — 'columns' (TimeStripe-style scrollable period columns, default) or 'list'; toggled per time/horizon view. `colOffset` holds the per-view carousel page offset.
- **Full-width takeover**: `isWideView()` decides which views span the whole app (`.wrap.tasks-wide` hides the timer column). Wide = calendar + agenda/dashboard/matrix/timeline always, and day/week/month/quarter/year/horizon/boards in *columns* layout. Inbox & life stay in-panel. `applyTaskWidth()` toggles the class (called in `renderTasks` and on tab switch).
- **Context menus** (`openCtxMenu`): TimeStripe-style ⋯ menu with viewport-clamped flyout submenus (two layers: `#ctxMenu` root + `#ctxSub` flyout, so they never clip in the Notion iframe). `buildTaskMenu(t,re)` / `buildSubjectMenu(s)` define the items; top color-dot row sets task priority / subject colour. `calCursor` = month shown in calendar.
- `boards` — user-created kanban boards: `[{id,name,lists:[{id,name}],layout:'columns'|'list',created}]`. A task carries `boardId`/`listId` (dual placement — keeps its schedule too). `currentBoardId` = active board.
- `taskFilter` / `subjTaskFilter` — active filter: all/active/done
- **Task cards are flat** (no expanding panel): card shows priority dot · check · name · ▶ · ⋯. All editing lives in the ⋯ menu (`buildTaskMenu`) — clicking the name or ⋯ opens it. Rename is inline (`renameTask`); time-of-day, checklist, repeat, subject, board, schedule etc. are menu items/submenus.
- **Play buttons are mode-aware**: a task ▶ runs `startTaskTimer` (→ `startTaskStopwatch`/`startTaskPomodoro`); a subject ▶ runs `startSubjectTimer` (→ `quickStopwatch`/`startSubjectPomodoro`), each following the current timer `mode`. Menus offer both modes explicitly.
- **TimeStripe free-add**: clicking empty space in a column body (`.ccol-body`) focuses that column's Add input (global pointerdown listener).
- **Task sound** has two voices via `_taskVia`: a bright snap on ＋/Add button-click, a deeper tock on Enter.
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
- `duplicateTask(t)` — clones a task (fresh id, reset done/checklist), inserts right after the original
- `taskSound()` — mechanical "tock" via WebAudio on task creation (called inside `newTask()`; respects `settings.taskSound`, default on)
- `calendarHTML()` / `wireCalendar()` — month-grid calendar view: simple chips with hover-+ add, ⋯ for full menu, drag a chip to another day to reschedule
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
  "repeat": "none|daily|weekdays|weekly|monthly|quarterly|yearly",
  "start": "HH:MM",
  "dur": 0,
  "horizon": "''|day|week|month|quarter|year|life",
  "hkey": "period key for week/month/quarter/year",
  "parentId": "goal-tree link",
  "boardId": "", "listId": "",
  "created": 1234567890
}
```
Repeat can't be finer than the task's horizon (`repeatOptsFor`/`clampRepeat`); time-of-day (`start`/`dur`) only applies to day-level tasks. Scheduling is set via the TimeStripe-style date picker (`openDatePicker`), not raw inputs.

## Views in the Tasks tab
- **day / week / month / quarter / year** — TimeStripe-style scrollable period columns by default (`renderCarousel`); each has a Columns⇄List toggle (`settings.taskLayout`) and a ‹Today› pager. List mode falls back to `renderPeriodView` (day list mode = today's tasks).
- **life / inbox** — flat lists (always in-panel, never full-width)
- **calendar** — TimeStripe-style month grid (`calendarHTML`/`wireCalendar`): Life/Year/Month horizon cards on top, day cells below with chips; hover-+ to add, ⋯ menu per chip, drag chips between days. Always full-width.
- **horizon** — broad→narrow horizons; stacked sections (`horizonHTML`) or columns (`horizonColsHTML`) via the layout toggle
- **boards** — user kanban boards (`boardsHTML`/`wireBoards`): board tabs, per-board lists, list/column layout, drag tasks between lists
- **board** — the date-kanban "Agenda": Overdue, Today, Next 7 days, Inbox
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