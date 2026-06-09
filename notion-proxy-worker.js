/* ============================================================================
 * Focus Den — Notion proxy (Cloudflare Worker)
 * ----------------------------------------------------------------------------
 * WHY THIS EXISTS
 *   Focus Den is a static page (GitHub Pages). The browser cannot call
 *   api.notion.com directly — Notion sends no CORS headers, and a secret
 *   integration token must never ship inside the public index.html.
 *   This tiny Worker sits in the middle: it holds the token as a server-side
 *   secret and exposes ONE read-only endpoint the app can fetch:
 *
 *       GET  https://<your-worker>.workers.dev/?db=<databaseId>
 *       →    { ok:true, results:[ {id, title, done, due, url}, … ] }
 *       →    { ok:false, error:"…" }            (on failure, HTTP 4xx/5xx)
 *
 *   It only ever READS Notion (databases.query). It never writes.
 *
 * ----------------------------------------------------------------------------
 * ONE-TIME SETUP (~5 minutes, free)
 *
 *   1. Create a Notion integration
 *      → https://www.notion.so/my-integrations → New integration
 *      → Capabilities: "Read content" is enough. Copy the "Internal
 *        Integration Secret" (starts with `ntn_` or `secret_`).
 *
 *   2. Share each database with the integration
 *      → Open the database in Notion → ••• (top-right) → Connections →
 *        add your integration. (Without this, queries return nothing.)
 *      → The database ID is the 32-char hex in its URL:
 *          notion.so/workspace/<32charid>?v=...   ← the part before `?v=`
 *        Paste that into Focus Den → Settings → Notion databases.
 *
 *   3. Deploy this Worker
 *      EASIEST (dashboard):
 *        → dash.cloudflare.com → Workers & Pages → Create → Create Worker
 *        → name it e.g. focus-den-notion → Deploy → "Edit code"
 *        → paste this whole file, Save & Deploy
 *        → Settings → Variables → "Add variable" → encrypt:
 *              NOTION_TOKEN = <your integration secret>
 *          (optional) ALLOW_ORIGIN = https://pycoder0697.github.io
 *          Leave ALLOW_ORIGIN unset to allow any origin (simplest).
 *      OR (CLI):  `npm i -g wrangler` → `wrangler deploy` →
 *                 `wrangler secret put NOTION_TOKEN`
 *
 *   4. Copy the Worker URL (https://focus-den-notion.<you>.workers.dev)
 *      into Focus Den → Settings → "Notion — proxy URL" → Save.
 *      Then "Manage databases" → Add database → paste the DB id → pick a
 *      board + list → ⟳. Rows sync into that list every ~5 min.
 *
 * ----------------------------------------------------------------------------
 * MAPPING (auto-detected, no per-field config needed)
 *   title : the database's Title property (plain text).
 *   done  : first checkbox property; else a Status/Select whose current value
 *           is one of Done/Complete/Completed/Closed/Archived.
 *   due   : first Date property's start date (returned for reference; Focus Den
 *           keeps Notion rows pinned to their list and out of the planner).
 * ==========================================================================*/

const NOTION_VERSION = '2022-06-28';
const DONE_WORDS = ['done', 'complete', 'completed', 'closed', 'archived'];

export default {
  async fetch(request, env) {
    const origin = env.ALLOW_ORIGIN || '*';
    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json', ...cors },
      });

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'GET') return json({ ok: false, error: 'Use GET' }, 405);
    if (!env.NOTION_TOKEN) return json({ ok: false, error: 'Worker missing NOTION_TOKEN secret' }, 500);

    const db = new URL(request.url).searchParams.get('db');
    if (!db) return json({ ok: false, error: 'Missing ?db=<databaseId>' }, 400);

    try {
      const results = [];
      let cursor;
      // paginate through the whole database (Notion caps each page at 100 rows)
      do {
        const r = await fetch(`https://api.notion.com/v1/databases/${db}/query`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.NOTION_TOKEN}`,
            'Notion-Version': NOTION_VERSION,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 }),
        });
        const data = await r.json();
        if (!r.ok) {
          return json({ ok: false, error: data.message || `Notion HTTP ${r.status}` }, r.status === 404 || r.status === 400 ? 400 : 502);
        }
        for (const page of data.results || []) results.push(mapRow(page));
        cursor = data.has_more ? data.next_cursor : null;
      } while (cursor);

      return json({ ok: true, db, results });
    } catch (e) {
      return json({ ok: false, error: 'Proxy error: ' + (e && e.message || e) }, 502);
    }
  },
};

/* Turn a raw Notion page into the small shape Focus Den expects. */
function mapRow(page) {
  const props = page.properties || {};
  let title = '';
  let done = false;
  let doneFromCheckbox = false;
  let due = '';

  for (const key in props) {
    const p = props[key];
    if (!p) continue;
    switch (p.type) {
      case 'title':
        title = (p.title || []).map((t) => t.plain_text).join('');
        break;
      case 'checkbox':
        // first checkbox wins as the "done" signal
        if (!doneFromCheckbox) { done = !!p.checkbox; doneFromCheckbox = true; }
        break;
      case 'status':
        if (!doneFromCheckbox && p.status && DONE_WORDS.includes((p.status.name || '').toLowerCase())) done = true;
        break;
      case 'select':
        if (!doneFromCheckbox && p.select && DONE_WORDS.includes((p.select.name || '').toLowerCase())) done = true;
        break;
      case 'date':
        if (!due && p.date && p.date.start) due = p.date.start;
        break;
    }
  }

  return { id: page.id, title: title.trim(), done, due, url: page.url || '' };
}
