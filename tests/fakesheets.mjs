// In-memory fake of the Google Sheets v4 REST endpoints worker.js uses, installed as globalThis.fetch.
// Supports fault injection: faults.push({ match(req) -> bool, mode: 'before'|'after', status, times })
//   'before' = fail without applying; 'after' = apply the change, then return the error (ambiguous).
import { webcrypto, generateKeyPairSync } from 'node:crypto';

export function makeKey() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return privateKey.export({ type: 'pkcs8', format: 'pem' });
}

function colNum(L) { let n = 0; for (const ch of L) n = n * 26 + (ch.charCodeAt(0) - 64); return n; }

export function makeFake(seed) {
  const books = {};   // spreadsheetId -> { tabs: { title: { id, rows: [][], rowCount, colCount } }, order: [] }
  let nextSheetId = 100;
  function book(id) { if (!books[id]) books[id] = { tabs: {}, order: [] }; return books[id]; }
  function addTab(id, title, rows, index) {
    const b = book(id);
    b.tabs[title] = { id: nextSheetId++, rows: (rows || []).map((r) => r.slice()), rowCount: 1000, colCount: 40 };
    if (typeof index === 'number') b.order.splice(index, 0, title); else b.order.push(title);
  }
  for (const [id, tabs] of Object.entries(seed || {})) for (const [title, rows] of Object.entries(tabs)) addTab(id, title, rows);

  const faults = [];
  const log = [];
  function parseRange(r) {
    r = decodeURIComponent(r);
    let tab = r, a1 = '';
    const bang = r.lastIndexOf('!');
    if (bang !== -1) { tab = r.slice(0, bang); a1 = r.slice(bang + 1); }
    tab = tab.replace(/^'/, '').replace(/'$/, '');
    let m;
    const out = { tab, r0: 1, c0: 1, r1: Infinity, c1: Infinity };
    if (!a1) return out;
    if ((m = /^(\d+):(\d+)$/.exec(a1))) { out.r0 = +m[1]; out.r1 = +m[2]; return out; }
    if ((m = /^([A-Z]+)(\d+):([A-Z]+)(\d*)$/.exec(a1))) { out.c0 = colNum(m[1]); out.r0 = +m[2]; out.c1 = colNum(m[3]); out.r1 = m[4] ? +m[4] : Infinity; return out; }
    if ((m = /^([A-Z]+)(\d+)$/.exec(a1))) { out.c0 = colNum(m[1]); out.r0 = +m[2]; out.c1 = out.c0; out.r1 = out.r0; out.cell = true; return out; }
    throw new Error('fake: bad range ' + a1);
  }
  function tabOf(bid, t) { const x = book(bid).tabs[t]; if (!x) { const e = new Error('Unable to parse range: ' + t); e.status = 400; throw e; } return x; }
  function lastRow(rows) { let n = rows.length; while (n > 0 && !(rows[n - 1] || []).some((v) => v !== '' && v != null)) n--; return n; }
  function writeAt(t, r0, c0, values) {
    values.forEach((vr, i) => {
      const ri = r0 - 1 + i;
      if (ri + 1 > t.rowCount) { const e = new Error('Range exceeds grid limits'); e.status = 400; throw e; }
      while (t.rows.length <= ri) t.rows.push([]);
      const row = t.rows[ri];
      vr.forEach((v, j) => { const ci = c0 - 1 + j; while (row.length <= ci) row.push(''); row[ci] = v == null ? '' : v; });
    });
  }
  function readRange(t, pr, formatted) {
    const n = lastRow(t.rows);
    const out = [];
    for (let r = pr.r0; r <= Math.min(pr.r1, n); r++) {
      const row = t.rows[r - 1] || [];
      let cells = row.slice(pr.c0 - 1, pr.c1 === Infinity ? undefined : pr.c1);
      while (cells.length && (cells[cells.length - 1] === '' || cells[cells.length - 1] == null)) cells.pop();
      if (formatted) cells = cells.map((v) => (v == null ? '' : String(v)));
      out.push(cells);
    }
    while (out.length && !out[out.length - 1].length) out.pop();
    return out;
  }

  // Google Drive v3, just what the receivers search uses. drive.files: [{id, name, mimeType,
  // parents, text, createdTime}]; drive.quota = true makes copies fail like a service account
  // copying into a My Drive folder.
  const drive = { files: [], quota: false, next: 1 };
  function driveApply(u, method, body) {
    const p = u.pathname.replace(/^\/drive\/v3\/files/, '');
    const pick = (f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, parents: f.parents, createdTime: f.createdTime, webViewLink: 'https://drive.google.com/file/d/' + f.id + '/view' });
    if (p === '' && method === 'GET') {
      const q = u.searchParams.get('q') || '';
      let list = drive.files.filter((f) => !f.trashed);
      let m;
      if ((m = /fullText contains '"((?:[^"\\]|\\.)*)"'/.exec(q))) { const w = m[1].toUpperCase(); list = list.filter((f) => (' ' + String(f.text || '').toUpperCase().replace(/[^A-Z0-9-]+/g, ' ') + ' ').includes(' ' + w + ' ')); }
      const ins = [...q.matchAll(/'([^']+)' in parents/g)].map((x) => x[1]);
      if (ins.length) list = list.filter((f) => (f.parents || []).some((p) => ins.includes(p)));
      if (/mimeType = 'application\/vnd\.google-apps\.folder'/.test(q)) list = list.filter((f) => f.mimeType === 'application/vnd.google-apps.folder');
      if ((m = /name contains '([^']+)'/.exec(q))) { const w = m[1]; list = list.filter((f) => f.name.includes(w)); }
      if (/mimeType = 'application\/pdf'/.test(q)) list = list.filter((f) => f.mimeType === 'application/pdf' || /^image\//.test(f.mimeType));
      return { files: list.slice(0, Number(u.searchParams.get('pageSize') || 100)).map(pick) };
    }
    let m = /^\/([^/]+)(\/copy)?$/.exec(p);
    if (m) {
      const f = drive.files.find((x) => x.id === decodeURIComponent(m[1]));
      if (!f) { const e = new Error('File not found: ' + m[1]); e.status = 404; throw e; }
      if (!m[2]) return pick(f);
      if (drive.quota) { const e = new Error('Service Accounts do not have storage quota. Leverage shared drives.'); e.status = 403; e.reason = 'storageQuotaExceeded'; throw e; }
      const c = Object.assign({}, f, { id: 'copy-' + (drive.next++), name: body.name, parents: body.parents, createdTime: '2026-10-02T00:00:00Z' });
      drive.files.push(c);
      return pick(c);
    }
    throw new Error('fake: unhandled drive ' + method + ' ' + u.pathname);
  }

  function apply(req) {
    const u = new URL(req.url);
    const method = req.method;
    if (u.pathname.startsWith('/drive/v3/')) return driveApply(u, method, req.body ? JSON.parse(req.body) : null);
    let m = /^\/v4\/spreadsheets\/([^/:]+)(.*)$/.exec(u.pathname);
    if (!m) throw new Error('fake: unknown url ' + req.url);
    const bid = m[1], rest = m[2];
    const body = req.body ? JSON.parse(req.body) : null;
    if (rest === '' && method === 'GET') {
      const b = book(bid);
      return { sheets: b.order.map((title) => ({ properties: { sheetId: b.tabs[title].id, title, gridProperties: { rowCount: b.tabs[title].rowCount, columnCount: b.tabs[title].colCount } } })) };
    }
    if (rest === ':batchUpdate') {
      const replies = [];
      for (const rq of body.requests) {
        if (rq.addSheet) {
          const p = rq.addSheet.properties;
          if (book(bid).tabs[p.title]) { const e = new Error('A sheet with the name "' + p.title + '" already exists.'); e.status = 400; throw e; }
          addTab(bid, p.title, [], p.index);
          if (p.gridProperties) { book(bid).tabs[p.title].rowCount = p.gridProperties.rowCount; book(bid).tabs[p.title].colCount = p.gridProperties.columnCount; }
          replies.push({});
        } else if (rq.appendDimension) {
          const t = Object.values(book(bid).tabs).find((x) => x.id === rq.appendDimension.sheetId);
          if (rq.appendDimension.dimension === 'ROWS') t.rowCount += rq.appendDimension.length; else t.colCount += rq.appendDimension.length;
        } else if (rq.deleteDimension) {
          const g = rq.deleteDimension.range;
          const t = Object.values(book(bid).tabs).find((x) => x.id === g.sheetId);
          t.rows.splice(g.startIndex, g.endIndex - g.startIndex);
        } else throw new Error('fake: unknown batch request ' + JSON.stringify(rq));
      }
      return { replies };
    }
    if (rest === '/values:batchUpdate') {
      for (const d of body.data) { const pr = parseRange(d.range); writeAt(tabOf(bid, pr.tab), pr.r0, pr.c0, d.values); }
      return {};
    }
    m = /^\/values\/(.+?)(:append)?$/.exec(rest);
    if (m) {
      const pr = parseRange(m[1]);
      const t = tabOf(bid, pr.tab);
      if (m[2]) { const at = lastRow(t.rows) + 1; if (at > t.rowCount) t.rowCount = at; writeAt(t, at, 1, body.values); return { updates: { updatedRange: pr.tab + '!A' + at } }; }
      if (method === 'PUT') { writeAt(t, pr.r0, pr.c0, body.values); return {}; }
      const formatted = u.searchParams.get('valueRenderOption') !== 'UNFORMATTED_VALUE';
      return { values: readRange(t, pr, formatted) };
    }
    throw new Error('fake: unhandled ' + method + ' ' + rest);
  }

  async function fetchImpl(input, opts) {
    const url = typeof input === 'string' ? input : input.url;
    opts = opts || {};
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    const req = { url, method: opts.method || 'GET', body: opts.body || null };
    const u = new URL(url);
    req.kind = req.method === 'GET' ? 'read' : (u.pathname.endsWith(':append') ? 'append' : (u.pathname.endsWith(':batchUpdate') && !u.pathname.includes('/values') ? 'struct' : 'write'));
    req.decoded = decodeURIComponent(u.pathname) + ' ' + (req.body || '');
    log.push(req);
    const f = faults.find((x) => x.times > 0 && x.match(req));
    if (f && f.mode === 'before') { f.times--; return new Response(JSON.stringify({ error: { message: 'The service is currently unavailable.' } }), { status: f.status || 503 }); }
    if (f && f.mode === 'html') { f.times--; return new Response('<html>502 Bad Gateway</html>', { status: 502 }); }
    let out;
    try { out = apply(req); }
    catch (e) { return new Response(JSON.stringify({ error: { message: e.message, errors: e.reason ? [{ reason: e.reason }] : undefined } }), { status: e.status || 500 }); }
    if (f && f.mode === 'after') { f.times--; return new Response(JSON.stringify({ error: { message: 'The service is currently unavailable.' } }), { status: f.status || 503 }); }
    return new Response(JSON.stringify(out), { status: 200 });
  }

  return { books, book, faults, log, fetchImpl, drive,
    rows(bid, tab) { const t = book(bid).tabs[tab]; if (!t) return []; const h = t.rows[0] || []; return t.rows.slice(1).filter((r) => r.some((v) => v !== '' && v != null)).map((r) => { const o = {}; h.forEach((k, i) => { o[k] = r[i] == null ? '' : r[i]; }); return o; }); },
  };
}
