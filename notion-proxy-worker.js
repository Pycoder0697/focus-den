/* ============================================================================
 * Focus Den — Notion proxy (Cloudflare Worker)  ·  TWO-WAY sync
 * ----------------------------------------------------------------------------
 * WHY THIS EXISTS
 *   Focus Den is a static page (GitHub Pages). The browser cannot call
 *   api.notion.com directly — Notion sends no CORS headers, and a secret
 *   integration token must never ship inside the public index.html.
 *   This tiny Worker holds the token server-side and exposes two endpoints:
 *
 *     READ   GET  /?db=<databaseId>
 *            → { ok:true, results:[ {id,title,done,due,url}, … ],
 *                schema:{ titleProp, doneProp:{name,type,doneValue,undoneValue} } }
 *
 *     WRITE  POST /   one of:
 *              { page:"<id>", properties:{…} }   → update a row (done/rename)
 *              { create:"<dbId>", properties:{…} } → insert a NEW row
 *              { page:"<id>", archived:true }     → archive a row (on delete)
 *            → { ok:true, id }
 *
 *   So in Focus Den: checking a card done / renaming updates the Notion row,
 *   adding a card to a synced list creates a Notion row, deleting a card
 *   archives it — and edits made in Notion pull back. Full two-way sync.
 *
 * ----------------------------------------------------------------------------
 * ONE-TIME SETUP (~5 minutes, free)
 *
 *   1. Create a Notion integration
 *      → https://www.notion.so/my-integrations → New integration
 *      → Capabilities: enable **Read content**, **Update content**, AND
 *        **Insert content** (Update = edit/archive rows, Insert = create rows).
 *      → Copy the "Internal Integration Secret" (starts `ntn_` or `secret_`).
 *
 *   2. Share each database with the integration
 *      → Open the database in Notion → ••• (top-right) → Connections →
 *        add your integration. (Without this, queries return nothing.)
 *      → The database ID is the 32-char hex in its URL, before `?v=`.
 *
 *   3. Deploy this Worker
 *      DASHBOARD (easiest):
 *        → dash.cloudflare.com → Workers & Pages → Create → Create Worker
 *        → name it e.g. focus-den-notion → Deploy → "Edit code"
 *        → paste this whole file, Save & Deploy
 *        → Settings → Variables and Secrets → Add → encrypt:
 *              NOTION_TOKEN = <your integration secret>
 *          (optional) ALLOW_ORIGIN = https://pycoder0697.github.io
 *          (optional) SYNC_KEY     = <any long random string>   ← see SECURITY
 *      OR CLI:  `npm i -g wrangler` → `wrangler deploy`
 *               → `wrangler secret put NOTION_TOKEN`  (and SYNC_KEY if used)
 *
 *   4. Copy the Worker URL into Focus Den → Settings → "Notion — proxy URL".
 *      If you set SYNC_KEY, put the same string in "Notion — proxy key".
 *      Then Manage databases → Add → paste the DB id → pick board + list → ⟳.
 *
 * ----------------------------------------------------------------------------
 * SECURITY
 *   Anyone who learns the Worker URL can READ — and now WRITE — the databases
 *   you've shared with the integration. The Worker only ever queries a database
 *   or patches a page's properties (never deletes), but to lock it to just your
 *   app set SYNC_KEY: every request must then carry a matching `x-sync-key`
 *   header, which Focus Den sends from Settings → "Notion — proxy key". Leave
 *   SYNC_KEY unset to keep the Worker open (simplest).
 *
 * MAPPING (auto-detected from the database schema, no per-field config)
 *   title : the Title property.
 *   done  : first checkbox property; else a Status/Select — "done" = the option
 *           in the Complete group / named Done·Complete·Closed·Archived, and
 *           "not done" = an option in the To-do group / the first other option.
 *   due   : first Date property's start (read-only reference).
 * ==========================================================================*/

const NOTION_VERSION = '2022-06-28';
const DONE_WORDS = ['done', 'complete', 'completed', 'closed', 'archived'];

export default {
  async fetch(request, env) {
    const origin = env.ALLOW_ORIGIN || '*';
    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-sync-key',
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors } });

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (!env.NOTION_TOKEN) return json({ ok: false, error: 'Worker missing NOTION_TOKEN secret' }, 500);
    // optional shared-key gate
    if (env.SYNC_KEY && request.headers.get('x-sync-key') !== env.SYNC_KEY)
      return json({ ok: false, error: 'Bad or missing proxy key' }, 401);

    const notion = (path, init) =>
      fetch('https://api.notion.com/v1/' + path, {
        ...init,
        headers: {
          Authorization: `Bearer ${env.NOTION_TOKEN}`,
          'Notion-Version': NOTION_VERSION,
          'Content-Type': 'application/json',
          ...(init && init.headers),
        },
      });

    try {
      // ---- WRITE: create a row, update a row's properties, or archive a row ----
      if (request.method === 'POST') {
        const body = await request.json().catch(() => null);
        if (!body) return json({ ok: false, error: 'POST needs a JSON body' }, 400);
        let r;
        if (body.create) {
          // INSERT: { create:"<databaseId>", properties:{…} } → new row
          if (!body.properties) return json({ ok: false, error: 'create needs { create, properties }' }, 400);
          r = await notion('pages', { method: 'POST', body: JSON.stringify({ parent: { database_id: body.create }, properties: body.properties }) });
        } else if (body.page && body.archived !== undefined) {
          // ARCHIVE / restore: { page:"<pageId>", archived:true|false }
          r = await notion(`pages/${body.page}`, { method: 'PATCH', body: JSON.stringify({ archived: !!body.archived }) });
        } else if (body.page && body.properties) {
          // UPDATE: { page:"<pageId>", properties:{…} }
          r = await notion(`pages/${body.page}`, { method: 'PATCH', body: JSON.stringify({ properties: body.properties }) });
        } else {
          return json({ ok: false, error: 'POST needs {page,properties} | {create,properties} | {page,archived}' }, 400);
        }
        const data = await r.json();
        if (!r.ok) return json({ ok: false, error: data.message || `Notion HTTP ${r.status}` }, 502);
        return json({ ok: true, id: data.id });
      }

      // ---- READ: query a database ----
      if (request.method !== 'GET') return json({ ok: false, error: 'Use GET or POST' }, 405);
      const db = new URL(request.url).searchParams.get('db');
      if (!db) return json({ ok: false, error: 'Missing ?db=<databaseId>' }, 400);

      // 1) learn the schema (which prop is title / done, and the on/off values)
      const metaR = await notion(`databases/${db}`);
      const meta = await metaR.json();
      if (!metaR.ok) return json({ ok: false, error: meta.message || `Notion HTTP ${metaR.status}` }, metaR.status === 404 ? 400 : 502);
      const schema = detectSchema(meta);

      // 2) page through every row
      const results = [];
      let cursor;
      do {
        const r = await notion(`databases/${db}/query`, {
          method: 'POST',
          body: JSON.stringify(cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 }),
        });
        const data = await r.json();
        if (!r.ok) return json({ ok: false, error: data.message || `Notion HTTP ${r.status}` }, 502);
        for (const page of data.results || []) results.push(mapRow(page, schema));
        cursor = data.has_more ? data.next_cursor : null;
      } while (cursor);

      return json({ ok: true, db, schema, results });
    } catch (e) {
      return json({ ok: false, error: 'Proxy error: ' + ((e && e.message) || e) }, 502);
    }
  },
};

/* Inspect a database's properties to pick the title + done props and their values. */
function detectSchema(db) {
  const props = db.properties || {};
  let titleProp = null;
  let doneProp = null;

  for (const name in props) if (props[name].type === 'title') { titleProp = name; break; }

  // prefer a checkbox; then status; then select
  for (const name in props) if (props[name].type === 'checkbox') { doneProp = { name, type: 'checkbox' }; break; }
  if (!doneProp) for (const name in props) {
    const p = props[name];
    if (p.type !== 'status' || !p.status) continue;
    const opts = p.status.options || [];
    const groups = p.status.groups || [];
    const nameOf = (id) => { const o = opts.find((o) => o.id === id); return o && o.name; };
    const completeG = groups.find((g) => /complete|done/i.test(g.name));
    const todoG = groups.find((g) => /to-?do|not started|backlog/i.test(g.name)) || groups.find((g) => g !== completeG);
    const doneValue = (completeG && completeG.option_ids[0] && nameOf(completeG.option_ids[0]))
      || (opts.find((o) => DONE_WORDS.includes(o.name.toLowerCase())) || {}).name || null;
    const undoneValue = (todoG && todoG.option_ids[0] && nameOf(todoG.option_ids[0]))
      || (opts.find((o) => o.name !== doneValue) || {}).name || null;
    doneProp = { name, type: 'status', doneValue, undoneValue };
    break;
  }
  if (!doneProp) for (const name in props) {
    const p = props[name];
    if (p.type !== 'select' || !p.select) continue;
    const opts = p.select.options || [];
    const doneValue = (opts.find((o) => DONE_WORDS.includes(o.name.toLowerCase())) || {}).name || null;
    const undoneValue = (opts.find((o) => o.name !== doneValue) || {}).name || null;
    doneProp = { name, type: 'select', doneValue, undoneValue };
    break;
  }

  return { titleProp, doneProp };
}

/* Turn a raw Notion page into the small shape Focus Den expects. */
function mapRow(page, schema) {
  const props = page.properties || {};
  let title = '';
  if (schema.titleProp && props[schema.titleProp]) title = (props[schema.titleProp].title || []).map((t) => t.plain_text).join('');

  let done = false;
  if (schema.doneProp && props[schema.doneProp.name]) {
    const p = props[schema.doneProp.name];
    if (schema.doneProp.type === 'checkbox') done = !!p.checkbox;
    else if (schema.doneProp.type === 'status') done = !!p.status && (p.status.name === schema.doneProp.doneValue || DONE_WORDS.includes((p.status.name || '').toLowerCase()));
    else if (schema.doneProp.type === 'select') done = !!p.select && (p.select.name === schema.doneProp.doneValue || DONE_WORDS.includes((p.select.name || '').toLowerCase()));
  }

  let due = '';
  for (const k in props) if (props[k].type === 'date' && props[k].date && props[k].date.start) { due = props[k].date.start; break; }

  return { id: page.id, title: title.trim(), done, due, url: page.url || '' };
}
