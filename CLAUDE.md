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
- **Unified task model**: one global `tasks` array is the source of truth. Subjects tab and Tasks tab are both filtered views of this array — never reintroduce per-subject todo arrays. **Subjects are tags**: a task carries **`subjectIds: []`** (multi-select), and `t.subjectId` is kept = `subjectIds[0]` (the *primary*, which drives chip colour and the logging bucket) — so the many display/colour/snapshot reads of `t.subjectId` keep working. Mutate via the helpers (`subjectIdsOf`/`setTaskSubjects`/`addTaskSubject`/`removeTaskSubject`/`toggleTaskSubject` near `tasksForSubject`), never by hand. Membership reads (`tasksForSubject`, the Filter, group-by-subject, the focus-picker `subj:` scope) check `subjectIdsOf(t).includes(id)`, so a task shows under **every** subject it's tagged with. A focus session on a multi-subject task **splits its time evenly** across those subjects: `commit` pushes one session row per subject with `share=1/N`, and `sdur(s)=dur(s.start,s.end)*(s.share||1)` is used at every session-duration aggregation (so totals never double-count; single-subject rows have no `share` ⇒ ×1, unchanged). The Log timeline (`renderTimeline`) **re-merges** those per-subject rows (same `start|end|taskId`) into one entry that lists every subject and the full block duration; its delete removes the whole group.
- **Task-first focus (subject is a tag)**: the timer's focus target is chosen **task-first**, with the subject behaving as a tag attached to the task — mirroring TickTick's focus picker. The timer card has NO visible Subject/Task dropdowns; instead a centered `.focus-pick` header (`#focusPick`) above `#clock` shows the current target (`renderFocusHeader()`: task name + its subject on a sub-line, or a bare subject/habit, or "Focus") and opens the picker popover (`#fpickPop`, `openFocusPicker`/`renderFocusPicker`, modelled on `openTaskFilter`). Picker tabs **Recent · Task · Subject · Habit** (`fpickTab`) + a search box; the **Task** tab has a list-selector dropdown (`#fpickListSel` → `#fpickScopeMenu`, `fpickScope`) = Today/Tomorrow/Next 7 Days/Inbox/All, then **Boards** (TickTick "Lists"), then **Subjects** (TickTick "Tags"), with tasks grouped Overdue→by-date. The picker **only selects** (`selectFocusTask`/`selectFocusSubject`/`selectFocusHabit`/`clearFocus` set the binding + header); the existing **Start** button runs the timer. **`#activeSubject` is kept in the DOM but hidden** as the subject source of truth (so `activeSubjectId()`, snapshot/restore, the Subjects-page ▶, and all `.value` reads stay unchanged); the old visible `#activeTask` select and `renderTaskSelect`/`syncSubjectLock` cosmetics are retired (`renderTaskSelect` is now a null-guarded no-op). You can run a **task with no subject** and a **subject with no task**. A habit-bound focus (`currentHabit`) logs its span with no subject and **auto-checks the habit for today** on a completed focus block (guarded in `commit` so it never wraps an already-done habit). Stats/Log stay subject-dominant. `currentHabit` rides `timerSnap`/`restoreTimer`.
- **Storage**: `localStorage` with an in-memory fallback (`mem{}`) for sandboxed iframes (Notion). Cloud sync via Firebase Realtime DB — credentials live in `CLOUD.url` and `CLOUD.key` at the top of the script.
- **Notion database sync (two-way)**: specific Notion databases mirror into specific board lists (`notionSources` = `[{id,name,dbId,boardId,listId,enabled,lastSync,lastErr,count,schema}]`). The static page can't call `api.notion.com` (no CORS, secret token can't ship publicly), so a tiny **Cloudflare Worker** (`notion-proxy-worker.js`, NOT part of index.html) holds the token and exposes `GET ?db=<id>` → `{ok,results,schema}` (read) and `POST` for writes — `{page,properties}` (update), `{create:<dbId>,properties}` (insert new row), `{page,archived:true}` (archive on delete). The Worker URL lives in `settings.notionProxy` + optional shared key `settings.notionKey` (sent as `x-sync-key`); both ride cloud sync to every device + the embed. **Two-way (TickTick parity)**: editing a synced task's **name, done, due date, OR description** pushes back to Notion. Rather than hooking every mutation site, `save()` calls `notionFlushChanges()`, which diffs every synced task against a `_notionShadow` (last-known Notion `{name,done,due,dueEnd,desc}` per pageId) and `notionPushTask(t)`es whatever changed — so the date picker, drag-drop, calendar, timeline, matrix, and the task-detail modal all reflect into Notion for free. The patch is built from the source's `schema` (`{titleProp, doneProp:{name,type,doneValue,undoneValue}, dateProp, descProp}`) by `buildNotionProps` (date set ⇒ `{date:{start,end?}}`, cleared ⇒ `{date:null}`; dates are date-only YYYY-MM-DD; description ⇒ `{rich_text:[…]}`, chunked to 2000-char objects via `notionRichText` so long notes never truncate). `descProp` is auto-detected as a **name-matched** rich_text property (Description/Notes/Details/Summary/…) — never a random text column — and is user-overridable (see field mapping below). `_notionInflight`/`_notionRecent` guard a ~15s window so a racing pull doesn't revert a just-pushed edit; `notionMarkSynced(t)` re-baselines the shadow on every pull so reads never echo-push. **Near-realtime**: pushes are instant; the pull is an adaptive self-rescheduling poll (`scheduleNotionPoll` → ~10s while the tab is visible, 60s hidden, immediate on refocus). To make fast polling safe, `notionSyncOne` returns `{changed}` and `notionSyncAll` only `save()`s + re-renders when something actually changed, and skips entirely while the user is typing in an input (unless `opts.report`). Name + done + due date + description sync both ways; subject/priority/board/checklist/repeat stay app-only. **Field mapping (config)**: the Worker's GET returns a `fields` catalog (`[{name,type}]`) stored on `src.fields`, and accepts optional `&date=`/`&desc=` query params (empty = disabled) that the client sends from `src.map` (`{dateProp?,descProp?}`); the returned `schema` already reflects those overrides, so the client treats `src.schema` as authoritative. The Notion modal (`renderNotionList`) exposes per-source **Description** and **Date** dropdowns (compatible properties + "— None —", defaulting to the auto-detected mapping) — changing one sets `src.map` and re-syncs, exactly like TickTick's "Integrated properties" picker. Tasks carry a `desc` field, edited in the `#ovTodo` detail modal (tap a card → opens it) and previewed as a one-line muted `.tk-note` under the card title. **Insert/delete**: adding a task to a synced list (`notionMaybeCreate`, hooked into board add/drop, the ⋯ board-assign, and `duplicateTask`) creates a new Notion row; deleting a synced task (`notionArchivePage`, hooked into the ⋯ Delete) archives the row so it doesn't resurrect. A `_notionCreating` counter + pending tasks (notionSourceId set, notionPageId empty) keep a racing pull from duplicating/pruning an in-flight create. Synced rows become **ordinary tasks** with `notionSourceId`+`notionPageId` set, plus `notionProps` (up to 4 read-only Notion data points — Text/Number/Select/Multi-Select/Status/Date/Person/Checkbox — surfaced in the task's ⋯ menu under a **Notion** submenu alongside an **Open in Notion** link, exactly like TickTick shows up to 4 data points per task). On first import they land in the pinned board list (boardId/listId from the source) carrying their Notion **due date** (horizon set to `day`) **and description** — and from there they have FULL task functionality, identical to any hand-made task: reschedule, move to inbox/calendar, set priority, edit the note, run a timer, etc. No view excludes them. After import the user owns board placement: each sync mirrors **name + done + due date + description** both ways and never re-touches boardId/listId, so board moves survive re-syncs while dates/notes stay in lock-step with Notion. (Date/description sync each run only when the DB has a mapped Date/text property — otherwise those stay app-only.) Sync upserts by `notionPageId` and prunes rows archived in Notion; a mirror task is only deleted when its whole source is removed (deleting the source in the modal removes its cards). `isNotionTask(t)` is available but no longer gates any view. Auto-syncs on load, every 5 min, and on refocus. UI: Settings → Notion (`ovNotion` modal, `renderNotionList()`).
- **PWA + notifications**: the app is an installable PWA (`manifest.webmanifest`, `sw.js`, PNG icons). `sw.js` is **network-first** for same-origin GETs (so a GitHub Pages push auto-updates with NO cache-version bump — never add one) and stale-while-revalidate for Google Fonts (offline support). SW registration is **skipped inside the Notion iframe** (`window.self!==window.top`). **Timer notifications** have three layers: (1) `chime()`/`flash()` in-app; (2) **local notifications** — `settings.notify` toggle → `fdNotify()` → `reg.showNotification()` (iOS-compatible), fired once per phase end via `signalPhaseChange()` in `tickFn` (works while the app is open/backgrounded-alive); (3) **Web Push backstop for a fully-CLOSED app** (`push-backend/`, NOT part of index.html) — a Cloudflare Worker (`push-worker.js`) on a 1-min cron reads `/push/<CLOUD.key>/<device>` alarms from the RTDB (a SEPARATE subtree so the app's `/focusden/<key>` blob never clobbers it) and sends a VAPID + aes128gcm Web Push (self-contained WebCrypto, no deps). The app writes/clears that alarm via `pushAlarmSync()` (hooked into `saveTimer()`), inlining the `PushSubscription`; since the live app overwrites/clears the alarm before each boundary, only a closed app actually gets a server push (shared `tag:'fd-timer'` collapses any overlap). Client config: `PUSH_VAPID_PUBLIC` const (empty ⇒ push off, local notifs still work) + `ensurePushSub()`. Deploy/keys: `push-backend/README.md` + `generate-vapid.mjs`. iOS web push needs the **Home-Screen-installed** PWA (16.4+); cron granularity ⇒ closed-app push up to ~60s late.
- **Timer is wall-clock-anchored** (not interval-driven): iOS freezes JS timers when the PWA is backgrounded, so `startTimer(anchor)` begins each chained phase at the previous phase's `endStamp` (not "now"), and `tickFn` **loops `completePhase()`** to replay every boundary missed during suspension, then recomputes `remaining`. `endSeg(cap)`/`commit(logIt,cap)` log focus time capped at the phase boundary. `restoreTimer` catches up on reload too. Don't reintroduce `Date.now()`-relative phase starts.
- **Theme**: CSS variables on `html[data-theme="dark|light"]`. Never hardcode colours — always use the CSS vars defined in `:root`.
- **No frameworks**: no React, no Vue, no build tools. Keep it one file.
- **IST timezone**: all date/time logic uses `Asia/Kolkata`. `todayKey()` returns YYYY-MM-DD in IST.

## Key globals
- `tasks` — unified task array
- `notionSources` — Notion DB → board-list mappings (see Notion database sync above). A task with `notionSourceId` set is a synced mirror (`isNotionTask(t)`); `notionSyncOne(src)` reconciles one DB, `notionSyncAll()` runs them all + persists
- `subjects` — subject list (colour, name, id — no todos)
- `sessions` — stopwatch/pomodoro session log (`{id,subjectId,start,end,taskId,share?}`; `share`<1 ⇒ this row is one slice of a multi-subject focus block — sum with `sdur(s)`)
- `currentTask` / `currentHabit` — the timer's bound task / habit (see "Task-first focus"); `$('activeSubject')` (hidden select) holds the bound subject. `fpickTab`/`fpickScope` — focus-picker UI state
- `settings` — user preferences (examDate, urgentDays, theme, focus/short/long mins, etc.)
- **Top-level pages** (nav rail `.railtab` data-tab): subjects · tasks · calendar · **horizon** · **countdown** · stats · log · music. Horizon and Countdown are their OWN pages (not Tasks sub-views). `switchTab(name)` shows `#tab-<name>`; horizon→`renderHorizonTab()`, countdown→`renderCountdownTab()`.
- **Persistent task header** (`.tv-head`): every Tasks view (and the Horizon page) shows a view name + a TickTick-style Filter·Sort·Group icon (`#tvSortBtn`/`#hzSortBtn` → shared `#taskFilterMenu` popover via `openTaskFilter(anchorId,{group,sort})`) + a ⋯ view-options icon. Tasks' ⋯ (`#tvViewMenu`) = list/kanban/timeline + kanban card size (`settings.kanbanSize` small/medium/big, default small) + show-calendar. Horizon's ⋯ (`#hzViewMenu`) = Columns/List layout + panes-shown (`settings.colsVisible`).
- `taskView` — current Tasks tab view: inbox/boards/matrix/dashboard + smart lists all/today/next7 (day/week/month/quarter/year/life/horizon are reachable only inside the Horizon page now; `migrateView` maps stale board/kanban/timeline/calendar/day/horizon → 'all'). Horizon-only sub-renders (`renderCarousel`/`renderDayList`/`renderPeriodView`/`horizonHTML`) call `renderTasks()`, which re-routes to `renderHorizonTab()` while the Horizon page is active.
- `settings.taskLayout` — 'columns' (TimeStripe-style scrollable period columns, default) or 'list'; toggled per time/horizon view. `colOffset` holds the per-view carousel page offset.
- **Full-width takeover**: `isWideView()` decides which views span the whole app (`.wrap.tasks-wide` hides the timer column). Wide = calendar + agenda/dashboard/matrix/timeline always, and day/week/month/quarter/year/horizon/boards in *columns* layout. Inbox & life stay in-panel. `applyTaskWidth()` toggles the class (called in `renderTasks` and on tab switch).
- **Context menus** (`openCtxMenu`): TimeStripe-style ⋯ menu with viewport-clamped flyout submenus (two layers: `#ctxMenu` root + `#ctxSub` flyout, so they never clip in the Notion iframe). `buildTaskMenu(t,re)` / `buildSubjectMenu(s)` define the items; top color-dot row sets task priority / subject colour. `calCursor` = month shown in calendar.
- `boards` — user-created kanban boards: `[{id,name,lists:[{id,name}],layout:'columns'|'list',created}]`. A task carries `boardId`/`listId` (dual placement — keeps its schedule too). `currentBoardId` = active board.
- `taskFilter` / `subjTaskFilter` — active filter: all/active/done
- **Task cards are flat** (no expanding panel): card shows priority dot · check · name · ⋯. There is no inline ▶ on task cards — running a timer for a task lives in the ⋯ menu (`buildTaskMenu`). All editing lives in the ⋯ menu too — clicking the name or ⋯ opens it. Rename is inline (`renameTask`); time-of-day, checklist, repeat, subject, board, schedule etc. are menu items/submenus.
- **Play buttons are mode-aware**: a task's Start (in the ⋯ menu) runs `startTaskTimer` (→ `startTaskStopwatch`/`startTaskPomodoro`); a subject's inline ▶ (Subjects page) runs `startSubjectTimer` (→ `quickStopwatch`/`startSubjectPomodoro`), each following the current timer `mode`. Menus offer both modes explicitly. These both bind **and** start immediately (unchanged); the timer-card focus picker (see "Task-first focus") only *selects* the target and leaves starting to the Start button.
- **TimeStripe free-add**: clicking empty space in a column body (`.ccol-body`) focuses that column's Add input (global pointerdown listener).
- **Task sound** has two voices via `_taskVia`: a bright snap on ＋/Add button-click, a deeper tock on Enter.
- `countdowns` — TickTick-style Countdown page cards: `[{id,name,emoji,date(YYYY-MM-DD),created}]`. Rides cloud sync (snapshot/applyRemote/save). `cdDays(date)` = `daysBetween(today,date)` (>0 future "Days until", <0 past "Days since", 0 "Today"). `renderCountdownTab()` renders the card grid; `+` (`#cdAddBtn`) and per-card ⋯ (Edit/Delete only — no style/notes/archive) drive `openCountdownEdit(c)` / `#ovCountdown` modal.
- `habits` — TickTick-style habit tracker: `[{id,name,emoji,color,freq:'daily'|'weekdays'|'weekly'|'interval',days:[0-6],perWeek,interval,goal,unit,checkType:'auto'|'all',step,goalDays(0=forever),section,checkStyle:'check'|'icon',log:{YYYY-MM-DD:n},notes:{YYYY-MM-DD:str},start,archived,created}]`. Rides cloud sync (all newer fields are optional, defaulted via `||` — no migration). **Own Habits page** (after Countdown) with two views switched in the ⋯ (`settings.habitView` = 'list' | 'calendar'): list = a top "Last 7 days" overall-completion ring strip + **collapsible sections** (Morning · Afternoon · Evening · Night · Others, ordered by `habitSectionsOf`; collapsed names in `settings.hbCollapsed`) of per-habit rows (today check + trailing-7 strip + streak), with the selected habit's detail (4 stat cards + month calendar + **Habit Log** check-in notes) alongside; calendar = per-section grid of per-habit month cards. `+`=`openHabitEdit`/`#ovHabit` modal (Frequency daily/weekdays/weekly/**Every N days**; Goal/day + unit; **When checking** Add-a-step/Complete-all + step, shown only when goal>1; **Duration** Forever/7/21/30/100/365; **Section**); per-habit ⋯ = Edit / **Checked-in style** (check⇄emoji) / Archive / Delete. Helpers: `habitDueOn(h,k)` (honours interval + `habitEndKey` challenge window), `habitDoneOn`/`habitPartOn`, `checkHabit(h,k)` (toggle, or step-increment/complete-all for amount goals), `habitStreak`, `habitsForDay`, `habitDurLabel`, `habitSection`, `habitTick`. **Habits surface elsewhere exactly like TickTick**: a today-only "Habits" section (`habitTodaySectionHTML()`, wired by `wireHabits`) injected into Today + Next 7 days + the Horizon Day section/column — never in All or Inbox; plus completion dots in the month calendar (`habitCellDotsHTML(k)`, today+past only). Any check-in goes through `afterHabitChange()` which re-renders whichever surface is showing.
- `CLOUD` — Firebase config object

## Key functions
- `save()` — persists all state to localStorage + triggers cloudSave()
- `normalizeData()` — ensures task shape, runs migration from legacy s.todos
- `renderSubjects()` — renders the Subjects tab (still shows each subject's tasks + inline "Add task…")
- `renderFocusHeader()` — fills the timer's `.focus-pick` header from `currentTask`/`currentHabit`/`$('activeSubject')`; `openFocusPicker()`/`renderFocusPicker()` drive the picker popover; `selectFocusTask`/`selectFocusSubject`/`selectFocusHabit`/`clearFocus` set the binding (selection only)
- `renderTasks()` — renders the Tasks tab (dispatches to board/matrix/timeline/list)
- `refreshTaskSurfaces()` — re-renders both tabs if visible (call after any task mutation)
- `applyFilter(list, mode)` — filters tasks by all/active/done
- `taskSort(a,b)` — sorts done tasks to bottom, then by priority/due
- `isTaskDone(t)` — respects repeat logic (daily/weekdays/weekly); also returns true for **"Won't Do"** tasks (`t.wontDo`), so abandoned tasks leave the active pool everywhere. `toggleWontDo(t)` abandons/reactivates (mutually exclusive with `done`); `renderTaskList` files them in a separate collapsed **"✗ Won't Do · N"** group (key `…·wd`) below Completed, the card shows a muted ✗ (`.tk-check.wd`), and the Show-tasks filter has a **Won't Do** segment (`applyFilter` mode `wontdo`; `done` excludes won't-do). App-only (not synced to Notion).
- `toggleTask(t)` — toggles done/doneOn respecting repeat
- `quadrant(t)` — returns 0-3 for Eisenhower matrix
- `gateAddTask(t, finalize)` — **the add-friction gate. Every MANUAL task creation must funnel through this** (`finalize()` does the `tasks.push`+`save`+re-render and only runs once the gate clears). Off when `settings.frictionOn===false` or for Notion-mirror tasks (`t.notionSourceId`) — both short-circuit straight to `finalize`. Otherwise it enforces: a window check (`settings.addWindows`, editable in Settings → Task discipline), a daily cap (`settings.maxTasksPerDay`, default 7; `manualTasksToday()` counts non-Notion tasks created today in IST), then the **friction modal** (`#ovFriction`, content built in JS): require priority OR due OR estimated-time, ask "Why does this matter today?" (placeholder hint, stored on `t.why`), and a spoken-oath step ("I will … by … because …"). `canAddNow()` runs just the cheap window+cap gates (used by `duplicateTask`/`addSubtask`, which skip the why/oath). Notion pull/import + the two `normalizeData` migrations push directly and are exempt by design.
- `duplicateTask(t)` — clones a task (fresh id, reset done/checklist), inserts right after the original; `canAddNow()`-gated (counts toward the daily cap + window)
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
  "desc": "free-text description / notes (syncs to a Notion text property)",
  "subjectIds": ["s0", "s3"],
  "subjectId": "s0",
  "due": "YYYY-MM-DD",
  "dueEnd": "YYYY-MM-DD",
  "priority": 0,
  "checklist": [{"id":"c...","text":"string","done":false}],
  "done": false,
  "doneOn": "",
  "wontDo": false,
  "wontDoOn": "",
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