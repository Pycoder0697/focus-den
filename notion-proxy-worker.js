/* ============================================================================
 * Focus Den — Notion proxy (Cloudflare Worker)  ·  TWO-WAY sync
 * ----------------------------------------------------------------------------
 * WHY THIS EXISTS
 *   Focus Den is a static page (GitHub Pages). The browser cannot call
 *   api.notion.com directly — Notion sends no CORS headers, and a secret
 *   integration token must never ship inside the public index.html.
 *   This tiny Worker holds the token server-side and exposes two endpoints:
 *
 *     READ   GET  /?db=<databaseId>[&date=<prop>][&desc=<prop>]
 *            → { ok:true, results:[ {id,title,done,due,dueEnd,desc,props,url}, … ],
 *                schema:{ titleProp, doneProp:{name,type,doneValue,undoneValue},
 *                         dateProp, descProp },
 *                fields:[ {name,type}, … ] }
 *              `props` = up to 4 extra display-only properties [{name,value}],
 *              TickTick-style — title/done/date/description are excluded (mapped).
 *              `fields` = the database's full property catalog (for the app's
 *              field-mapping config). `date`/`desc` query params override which
 *              property maps to the due date / description (empty = disable).
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
 *   due   : first Date property — start→due, end→dueEnd. TWO-WAY: rescheduling
 *           a synced task in Focus Den writes this date back to Notion, and a
 *           date edited in Notion pulls back. (Date-only; times are truncated.)
 *   desc  : a rich_text property named like a description (Description, Notes,
 *           Details, Summary, …) — TWO-WAY: a task's description edited in Focus
 *           Den writes back here, and a Notion edit pulls back. Auto-detection is
 *           name-matched only (never a random text column); the app's field-
 *           mapping config can override it to any text property (or none).
 *   props : every other property (Text/Number/Select/Multi-Select/Status/Date/
 *           Person/Checkbox/URL/…), up to 4, surfaced read-only on the task —
 *           exactly like TickTick shows up to 4 Notion data points per task.
 * ==========================================================================*/

const NOTION_VERSION = '2022-06-28';
const DONE_WORDS = ['done', 'complete', 'completed', 'closed', 'archived'];
const DESC_WORDS = /^(description|desc|notes?|details?|summary|content|comments?|body|memo)$/i;

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
      const params = new URL(request.url).searchParams;
      const db = params.get('db');
      if (!db) return json({ ok: false, error: 'Missing ?db=<databaseId>' }, 400);

      // 1) learn the schema (which prop is title / done / date / description, and the on/off values)
      const metaR = await notion(`databases/${db}`);
      const meta = await metaR.json();
      if (!metaR.ok) return json({ ok: false, error: meta.message || `Notion HTTP ${metaR.status}` }, metaR.status === 404 ? 400 : 502);
      const schema = detectSchema(meta);
      // optional field-mapping overrides from Focus Den's config (empty value = disable that field)
      if (params.has('date')) schema.dateProp = params.get('date') || null;
      if (params.has('desc')) schema.descProp = params.get('desc') || null;
      // catalog of the database's properties so the app can offer mapping choices
      const fields = Object.keys(meta.properties || {}).map((name) => ({ name, type: meta.properties[name].type }));

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

      return json({ ok: true, db, schema, fields, results });
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

  // first Date property → two-way due date
  let dateProp = null;
  for (const name in props) if (props[name].type === 'date') { dateProp = name; break; }

  // a rich_text property named like a description → two-way task description.
  // Only NAME-MATCHED (never a random text column) so auto-detection can't clobber an unrelated field;
  // the user can override this to any text property (or none) from Focus Den's field-mapping config.
  let descProp = null;
  for (const name in props) if (props[name].type === 'rich_text' && DESC_WORDS.test(name.trim())) { descProp = name; break; }

  return { titleProp, doneProp, dateProp, descProp };
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

  let due = '', dueEnd = '';
  if (schema.dateProp && props[schema.dateProp] && props[schema.dateProp].date) {
    const d = props[schema.dateProp].date;
    due = (d.start || '').slice(0, 10);     // Focus Den dates are date-only (YYYY-MM-DD)
    dueEnd = (d.end || '').slice(0, 10);
  }

  let desc = '';                            // two-way task description (a rich_text property)
  if (schema.descProp && props[schema.descProp] && props[schema.descProp].type === 'rich_text')
    desc = (props[schema.descProp].rich_text || []).map((t) => t.plain_text).join('');

  // up to 4 extra display-only properties (TickTick shows up to 4 data points) — skip the integrated title/done/date/description
  const skip = new Set([schema.titleProp, schema.doneProp && schema.doneProp.name, schema.dateProp, schema.descProp].filter(Boolean));
  const extra = [];
  for (const name in props) {
    if (extra.length >= 4) break;
    if (skip.has(name)) continue;
    const value = propText(props[name]);
    if (value) extra.push({ name, value });
  }

  return { id: page.id, title: title.trim(), done, due, dueEnd, desc, props: extra, url: page.url || '' };
}

/* Render a Notion property to a short display string (for the up-to-4 extra props). */
function propText(p) {
  if (!p) return '';
  switch (p.type) {
    case 'rich_text': return (p.rich_text || []).map((t) => t.plain_text).join('').trim();
    case 'number': return p.number != null ? String(p.number) : '';
    case 'select': return p.select ? p.select.name : '';
    case 'status': return p.status ? p.status.name : '';
    case 'multi_select': return (p.multi_select || []).map((o) => o.name).join(', ');
    case 'date': return p.date ? (p.date.start || '').slice(0, 10) + (p.date.end ? ' → ' + p.date.end.slice(0, 10) : '') : '';
    case 'people': return (p.people || []).map((u) => u.name || '').filter(Boolean).join(', ');
    case 'checkbox': return p.checkbox ? '✓' : '';
    case 'url': return p.url || '';
    case 'email': return p.email || '';
    case 'phone_number': return p.phone_number || '';
    case 'formula': return p.formula ? String(p.formula[p.formula.type] != null ? p.formula[p.formula.type] : '') : '';
    default: return '';
  }
}
