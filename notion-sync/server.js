/**
 * Focus Den ⇄ Notion two-way sync.
 *
 * Focus Den stores its whole state as one JSON snapshot in a Firebase Realtime DB.
 * This server bridges that snapshot with a Notion database, so tasks stay in sync
 * even when the app/tab is closed. No SDKs — Node 18+ global fetch only.
 *
 * Mapping:
 *   - Each Focus Den task carries `notionId` (the Notion page id). The app preserves
 *     unknown task fields, so this round-trips safely through the app's own saves.
 *   - Sync bookkeeping (content hash + Notion last-edited time) lives in a SEPARATE
 *     Firebase path the app never reads/writes, so the app can't clobber it.
 *
 * Conflict policy (per task, between sync runs):
 *   - only Focus Den changed  → push to Notion
 *   - only Notion changed     → pull to Focus Den
 *   - both changed            → CONFLICT_WINNER decides
 */

import http from 'node:http';
import { readFileSync } from 'node:fs';

// ---- tiny .env loader (no dependency) ----
try {
  const env = readFileSync(new URL('./.env', import.meta.url), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env file — rely on real env vars (e.g. on a host) */ }

const {
  NOTION_TOKEN, NOTION_DB_ID, FIREBASE_URL, FOCUSDEN_KEY,
  SYNC_INTERVAL_MS = '30000', CONFLICT_WINNER = 'notion',
  MIRROR_DELETES = 'true', PORT = '8787',
} = process.env;

for (const [k, v] of Object.entries({ NOTION_TOKEN, NOTION_DB_ID, FIREBASE_URL, FOCUSDEN_KEY })) {
  if (!v) { console.error(`Missing required env var: ${k}`); process.exit(1); }
}
const INTERVAL = Math.max(5000, +SYNC_INTERVAL_MS || 30000);
const MIRROR = String(MIRROR_DELETES) === 'true';
const NOTION_VERSION = '2022-06-28';
const PRIORITIES = ['None', 'Low', 'Medium', 'High'];          // index = Focus Den priority 0..3

const log = (...a) => console.log(new Date().toISOString(), ...a);
let lastStatus = { ok: false, lastRun: null, pushed: 0, pulled: 0, created: 0, errors: [] };

// ---------------------------------------------------------------- Firebase
const fdMainUrl = () => `${FIREBASE_URL.replace(/\/+$/, '')}/focusden/${encodeURIComponent(FOCUSDEN_KEY)}.json`;
const fdSyncUrl = () => `${FIREBASE_URL.replace(/\/+$/, '')}/focusden_notionsync/${encodeURIComponent(FOCUSDEN_KEY)}.json`;

async function fbGet(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Firebase GET ${r.status}`);
  return r.json();
}
async function fbPut(url, body) {
  const r = await fetch(url, { method: 'PUT', body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Firebase PUT ${r.status}`);
  return r.json();
}

// ---------------------------------------------------------------- Notion
async function notion(path, { method = 'GET', body } = {}) {
  const r = await fetch(`https://api.notion.com/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`Notion ${method} ${path} → ${r.status} ${await r.text()}`);
  return r.json();
}

// the DB's title property can be named anything — discover it, and make sure our props exist.
// runs only once per process (cached) so the hot sync loop stays light.
let TITLE_PROP = 'Name';
let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return;
  const db = await notion(`databases/${NOTION_DB_ID}`);
  const props = db.properties || {};
  TITLE_PROP = Object.keys(props).find(k => props[k].type === 'title') || 'Name';
  const want = {
    Done: { checkbox: {} },
    Due: { date: {} },
    Priority: { select: { options: PRIORITIES.map(name => ({ name })) } },
    Subject: { select: {} },
    Repeat: { select: {} },
    FocusDenID: { rich_text: {} },
  };
  const missing = {};
  for (const [name, def] of Object.entries(want)) if (!props[name]) missing[name] = def;
  if (Object.keys(missing).length) {
    log('Adding missing Notion properties:', Object.keys(missing).join(', '));
    await notion(`databases/${NOTION_DB_ID}`, { method: 'PATCH', body: { properties: missing } });
  }
  schemaReady = true;
}

async function notionQueryAll() {
  const out = [];
  let cursor;
  do {
    const page = await notion(`databases/${NOTION_DB_ID}/query`, {
      method: 'POST', body: cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 },
    });
    out.push(...page.results);
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);
  return out;
}

// ---------------------------------------------------------------- mapping
const rich = s => (s ? [{ text: { content: String(s).slice(0, 1900) } }] : []);
const readText = p => (p?.rich_text?.[0]?.plain_text) || '';
const readTitle = p => (p?.title || []).map(t => t.plain_text).join('') || '';

// Focus Den task -> Notion properties
function taskToProps(task, subjectName) {
  return {
    [TITLE_PROP]: { title: [{ text: { content: task.name || 'Untitled' } }] },
    Done: { checkbox: !!task.done },
    Due: { date: task.due ? { start: task.due } : null },
    Priority: { select: { name: PRIORITIES[task.priority || 0] } },
    Subject: { select: subjectName ? { name: subjectName } : null },
    Repeat: { select: task.repeat && task.repeat !== 'none' ? { name: task.repeat } : null },
    FocusDenID: { rich_text: rich(task.id) },
  };
}

// Notion page -> the subset of Focus Den fields it owns
function pageToFields(page) {
  const p = page.properties || {};
  return {
    name: readTitle(p[TITLE_PROP]),
    done: !!(p.Done?.checkbox),
    due: p.Due?.date?.start ? String(p.Due.date.start).slice(0, 10) : '',
    priority: Math.max(0, PRIORITIES.indexOf(p.Priority?.select?.name || 'None')),
    subjectName: p.Subject?.select?.name || '',
    repeat: p.Repeat?.select?.name || 'none',
    focusDenId: readText(p.FocusDenID),
  };
}

// stable fingerprint of the fields we sync (so we can tell which side changed)
function hashTask(task, subjectName) {
  return JSON.stringify([
    task.name || '', !!task.done, task.due || '', task.priority || 0,
    subjectName || '', (task.repeat && task.repeat !== 'none') ? task.repeat : 'none',
  ]);
}
function hashFields(f) {
  return JSON.stringify([
    f.name || '', !!f.done, f.due || '', f.priority || 0,
    f.subjectName || '', (f.repeat && f.repeat !== 'none') ? f.repeat : 'none',
  ]);
}

// ---------------------------------------------------------------- subjects
function subjectNameOf(doc, id) {
  return (doc.subjects || []).find(s => s.id === id)?.name || '';
}
// resolve a Notion subject name to a Focus Den subject id, creating one if needed
function subjectIdOf(doc, name) {
  if (!name) return '';
  const found = (doc.subjects || []).find(s => s.name.toLowerCase() === name.toLowerCase());
  if (found) return found.id;
  const id = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const palette = ['#f5a623', '#ff7a33', '#2f9bff', '#e0218a', '#ff6b4a', '#4f8cff', '#c026d3', '#5fc24a', '#3fb36b', '#a78bfa', '#5fd3c4'];
  doc.subjects = doc.subjects || [];
  doc.subjects.push({ id, name, color: palette[doc.subjects.length % palette.length], todos: [] });
  return id;
}

// ---------------------------------------------------------------- core sync
async function syncOnce() {
  const errors = [];
  let pushed = 0, pulled = 0, created = 0;

  await ensureSchema();

  const doc = await fbGet(fdMainUrl());
  if (!doc || !Array.isArray(doc.tasks)) { throw new Error('Focus Den doc not found / has no tasks[] — is the cloud key correct?'); }
  const docStamp = doc._updatedAt;                                    // to detect app writes mid-run
  const state = (await fbGet(fdSyncUrl())) || { map: {} };            // { map: { taskId: {page, hash, edited} } }
  state.map = state.map || {};

  const pages = await notionQueryAll();
  const pageById = new Map(pages.map(p => [p.id, p]));
  const pageByFdId = new Map();
  for (const pg of pages) { const fid = readText(pg.properties?.FocusDenID); if (fid) pageByFdId.set(fid, pg); }

  let docDirty = false;
  const liveTaskIds = new Set(doc.tasks.map(t => t.id));

  // ---- pass 1: Focus Den tasks → Notion (and pull Notion-side edits) ----
  for (const task of doc.tasks) {
    if (task.parentId) continue;                                     // keep v1 flat: sync only top-level tasks
    const subjName = subjectNameOf(doc, task.subjectId);
    const fdHash = hashTask(task, subjName);
    let pg = task.notionId ? pageById.get(task.notionId) : pageByFdId.get(task.id);
    const rec = state.map[task.id] || {};

    if (!pg) {
      // create a Notion page for this task
      try {
        const res = await notion('pages', { method: 'POST', body: { parent: { database_id: NOTION_DB_ID }, properties: taskToProps(task, subjName) } });
        task.notionId = res.id; docDirty = true; created++;
        state.map[task.id] = { page: res.id, hash: fdHash, edited: res.last_edited_time };
      } catch (e) { errors.push(`create ${task.id}: ${e.message}`); }
      continue;
    }
    if (task.notionId !== pg.id) { task.notionId = pg.id; docDirty = true; }   // heal + persist a missing link
    const nf = pageToFields(pg);
    const notionHash = hashFields(nf);
    // rec.hash is the agreed-on fingerprint from the last sync. If Focus Den's current
    // Decide who (if anyone) needs updating. rec.hash is the agreed content from the
    // last sync (undefined on a fresh link). If the two sides already match, it's a no-op.
    let winner = null;
    if (fdHash === notionHash) {
      winner = null;                                                  // identical content → already in sync
    } else if (rec.hash === undefined) {
      winner = CONFLICT_WINNER;                                       // differ with no history → policy decides
    } else {
      const fdChanged = rec.hash !== fdHash;
      const notionChanged = rec.hash !== notionHash;
      if (fdChanged && notionChanged) winner = CONFLICT_WINNER;       // both edited since last sync
      else if (fdChanged) winner = 'focusden';
      else winner = 'notion';
    }

    if (winner === 'focusden') {
      try {
        await notion(`pages/${pg.id}`, { method: 'PATCH', body: { properties: taskToProps(task, subjName) } });
        pushed++;
        state.map[task.id] = { page: pg.id, hash: fdHash, edited: new Date().toISOString() };
      } catch (e) { errors.push(`push ${task.id}: ${e.message}`); }
    } else if (winner === 'notion') {
      task.name = nf.name || task.name;
      task.done = nf.done;
      if (!task.done) task.doneOn = '';
      else if (!task.doneOn) task.doneOn = nf.due || new Date().toISOString().slice(0, 10);
      task.due = nf.due;
      if (task.due) { task.horizon = 'day'; task.hkey = ''; }
      task.priority = nf.priority;
      task.repeat = nf.repeat || 'none';
      task.subjectId = subjectIdOf(doc, nf.subjectName);
      docDirty = true; pulled++;
      state.map[task.id] = { page: pg.id, hash: hashTask(task, subjectNameOf(doc, task.subjectId)), edited: pg.last_edited_time };
    } else {
      // in sync — just refresh the recorded edited stamp
      state.map[task.id] = { page: pg.id, hash: fdHash, edited: pg.last_edited_time };
    }
  }

  // ---- pass 2: Notion pages with no Focus Den task → create a task ----
  for (const pg of pages) {
    if (pg.archived) continue;
    const fid = readText(pg.properties?.FocusDenID);
    if (fid && liveTaskIds.has(fid)) continue;                       // already linked
    if (fid && state.map[fid]) continue;                             // was linked but task deleted → handled in pass 3
    const nf = pageToFields(pg);
    if (!nf.name) continue;
    const id = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const task = {
      id, name: nf.name, subjectId: subjectIdOf(doc, nf.subjectName),
      due: nf.due, dueEnd: '', priority: nf.priority, checklist: [],
      done: nf.done, doneOn: nf.done ? (nf.due || new Date().toISOString().slice(0, 10)) : '',
      repeat: nf.repeat || 'none', start: '', dur: 0, created: Date.now(),
      horizon: nf.due ? 'day' : '', hkey: '', parentId: '', boardId: '', listId: '',
      notionId: pg.id,
    };
    doc.tasks.push(task); docDirty = true; created++;
    // backfill the FocusDenID on the Notion page so it links next time
    try { await notion(`pages/${pg.id}`, { method: 'PATCH', body: { properties: { FocusDenID: { rich_text: rich(id) } } } }); } catch (e) { errors.push(`link ${pg.id}: ${e.message}`); }
    state.map[id] = { page: pg.id, hash: hashTask(task, subjectNameOf(doc, task.subjectId)), edited: pg.last_edited_time };
  }

  // ---- pass 3: deletions ----
  if (MIRROR) {
    // task removed in Focus Den but still mapped → archive its Notion page
    for (const [taskId, rec] of Object.entries(state.map)) {
      if (liveTaskIds.has(taskId)) continue;
      const pg = pageById.get(rec.page);
      if (pg && !pg.archived) { try { await notion(`pages/${rec.page}`, { method: 'PATCH', body: { archived: true } }); } catch (e) { errors.push(`archive ${rec.page}: ${e.message}`); } }
      delete state.map[taskId];
    }
    // page archived in Notion but task still alive → remove the Focus Den task
    for (const task of [...doc.tasks]) {
      if (!task.notionId) continue;
      const pg = pageById.get(task.notionId);
      if (pg && pg.archived) { doc.tasks = doc.tasks.filter(t => t.id !== task.id); docDirty = true; delete state.map[task.id]; }
    }
  }

  // ---- write back ----
  if (docDirty) {
    const fresh = await fbGet(fdMainUrl());
    if (fresh && fresh._updatedAt && fresh._updatedAt !== docStamp) {
      // the app wrote to the cloud during this run. Don't clobber it — instead MERGE our
      // Notion links (and any tasks we created from Notion) onto the fresh doc, so the
      // notionId links are never lost (losing them is what caused duplicate-page churn).
      fresh.tasks = Array.isArray(fresh.tasks) ? fresh.tasks : [];
      const freshById = new Map(fresh.tasks.map(t => [t.id, t]));
      for (const t of doc.tasks) {
        const f = freshById.get(t.id);
        if (f) { if (t.notionId && f.notionId !== t.notionId) f.notionId = t.notionId; }
        else fresh.tasks.push(t);                    // a task we created from a Notion page this run
      }
      const fsubj = new Set((fresh.subjects || []).map(s => s.id));
      for (const s of (doc.subjects || [])) if (!fsubj.has(s.id)) (fresh.subjects = fresh.subjects || []).push(s);
      fresh._updatedAt = Date.now(); fresh._device = 'notion-sync';
      await fbPut(fdMainUrl(), fresh);
      log('merged Notion links onto a concurrently-updated Focus Den doc.');
    } else {
      doc._updatedAt = Date.now();
      doc._device = 'notion-sync';
      await fbPut(fdMainUrl(), doc);
    }
  }
  state.lastRun = Date.now();
  await fbPut(fdSyncUrl(), state);

  lastStatus = { ok: true, lastRun: new Date().toISOString(), pushed, pulled, created, errors };
  log(`sync ok — pushed ${pushed}, pulled ${pulled}, created ${created}` + (errors.length ? `, ${errors.length} errors` : ''));
  if (errors.length) errors.forEach(e => log('  !', e));
}

let syncing = false;                     // mutex: never let two reconciliations overlap
async function safeSync() {
  if (syncing) return;                   // a previous cycle is still running — skip this tick
  syncing = true;
  try { await syncOnce(); }
  catch (e) { lastStatus = { ...lastStatus, ok: false, lastRun: new Date().toISOString(), errors: [e.message] }; log('sync FAILED:', e.message); }
  finally { syncing = false; }
}

// ---------------------------------------------------------------- run
const runOnce = process.argv.includes('--once');
if (runOnce) {
  safeSync().then(() => process.exit(lastStatus.ok ? 0 : 1));
} else {
  http.createServer((req, res) => {
    if (req.url === '/sync' && req.method === 'POST') { safeSync(); res.writeHead(202).end('syncing'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(lastStatus, null, 2));
  }).listen(+PORT, () => log(`Focus Den ⇄ Notion sync on :${PORT} (every ${INTERVAL}ms). Status at GET /, trigger with POST /sync`));
  safeSync();
  setInterval(safeSync, INTERVAL);
}
