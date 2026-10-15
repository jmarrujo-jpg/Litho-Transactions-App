/**
 * Litho Floor App — Cloudflare Worker (BACKEND)
 * ------------------------------------------------------------------------------------------
 * Front end is on GitHub Pages; this Worker is the backend. The browser POSTs {fn, args} here
 * and this reads/writes the Google Sheet directly using a service account (no Apps Script).
 *
 * Self-contained: paste this whole file into a dashboard Worker (Create Worker > Edit code),
 * or deploy with wrangler. Set these variables (Settings > Variables and Secrets):
 *   GCP_SA_EMAIL        (secret)  service account email  (client_email in the key JSON)
 *   GCP_SA_PRIVATE_KEY  (secret)  the private_key from the key JSON (PEM; literal \n is fine)
 *   SHEET_ID            (var)     spreadsheet id (optional; defaults to the known one)
 *   ALLOWED_ORIGIN      (var)     e.g. https://jmarrujo-jpg.github.io  (optional; default *)
 *   API_TOKEN           (secret)  optional shared token; if set, the client must send it
 *
 * STAGE 1: read endpoints are live. Write endpoints return a clear "Stage 2" message so the
 * Apps Script app stays the writer until the migration is finished.
 */

const DEFAULT_SHEET_ID = '12Irb-isWOO14SrlGglcgnHc8oi0mLwW54LNo7pBHKjg';
const TZ = 'America/Los_Angeles';
const MASTER = 'Steel Tickets';
const TRANSACTIONS = 'Litho Transactions';
const JOBS = 'Litho Jobs';
const RATE = 'Litho Rate Table';

const ADDON_SOURCE_GROUP = 'Specialty / Low Volume / Setup';
const ADDON_ITEM_NAMES = ['SIZE', 'ENAMEL ONE SIDE', 'WHITE BASE COAT',
  'VARNISH WET-STANDARD', 'VARNISH WET-PEBBLE', 'VARNISH DRY-STANDARD', 'VARNISH DRY-PEBBLE', 'WAX ONLY',
  'LITHO PRINT SINGLE COLOR - ONE', 'LITHO PRINT SINGLE COLOR - TWO', 'LITHO PRINT SINGLE COLOR - THREE',
  'LITHO PRINT SINGLE COLOR - FOUR', 'LITHO PRINT SINGLE COLOR - FIVE', 'LITHO PRINT SINGLE COLOR - SIX',
  'LITHO PRINT TWO COLOR - ONE', 'LITHO PRINT TWO COLOR - TWO', 'LITHO PRINT TWO COLOR - THREE',
  'LITHO PRINT TWO COLOR - FOUR', 'LITHO PRINT TWO COLOR - FIVE', 'LITHO PRINT TWO COLOR - SIX'];

const WRITE_FNS = ['applyCoating', 'createManualTicket', 'updateWipLithoCost', 'editTicketCoating',
  'removeTicketCoating', 'updateTicketDetails', 'createJob', 'jobAddTicket', 'addCoatingToJob',
  'removeTicketFromJob', 'approveJob'];

export default {
  async fetch(request, env) {
    // Echo the caller's Origin so the CORS header always matches (avoids a misconfigured
    // ALLOWED_ORIGIN silently blocking the app). If ALLOWED_ORIGIN is set to a specific origin,
    // only that origin is allowed; otherwise any origin is echoed back.
    const reqOrigin = request.headers.get('Origin') || '*';
    const allowOrigin = (env.ALLOWED_ORIGIN && env.ALLOWED_ORIGIN !== '*')
      ? (env.ALLOWED_ORIGIN === reqOrigin ? reqOrigin : env.ALLOWED_ORIGIN)
      : reqOrigin;
    const cors = {
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
    const json = (obj, status) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method === 'GET') return json({ ok: true, service: 'litho-api', stage: 'reads', build: 'cors-echo-2' }, 200);
    if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

    let payload;
    try { payload = JSON.parse((await request.text()) || '{}'); }
    catch (e) { return json({ ok: false, error: 'Bad request body' }, 400); }

    if (env.API_TOKEN && String(payload.secret || '') !== String(env.API_TOKEN)) {
      return json({ ok: false, error: 'Unauthorized' }, 200);
    }
    try {
      const result = await handle(payload.fn, payload.args || [], env);
      return json({ ok: true, result }, 200);
    } catch (e) {
      return json({ ok: false, error: e && e.message ? e.message : String(e) }, 200);
    }
  },
};

// ---------------- dispatcher ----------------
async function handle(fn, args, env) {
  const sheets = await makeSheets(env);
  args = args || [];
  switch (fn) {
    case 'getRateTree': return getRateTree(sheets);
    case 'getAllTickets': return getAllTickets(sheets);
    case 'getOperatorNames': return [];
    case 'getTicketCard': return getTicketCard(sheets, args[0]);
    case 'getJobsForDate': return getJobsForDate(sheets, args[0]);
    case 'getJobDetail': return getJobDetail(sheets, args[0]);
    default:
      if (WRITE_FNS.indexOf(fn) !== -1) {
        throw new Error('"' + fn + '" isn\'t on the new backend yet (Stage 2). Use the Apps Script app to make changes for now.');
      }
      throw new Error('Unknown function: ' + fn);
  }
}

// ---------------- Google auth + Sheets ----------------
let cachedToken = null;

function b64urlBytes(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlStr(str) { return b64urlBytes(new TextEncoder().encode(str)); }
function pemToPkcs8(pem) {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s+/g, '');
  const raw = atob(body);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf.buffer;
}
async function mintToken(env) {
  const email = env.GCP_SA_EMAIL;
  const key = (env.GCP_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('Service account not configured (GCP_SA_EMAIL / GCP_SA_PRIVATE_KEY).');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = { iss: email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 };
  const unsigned = b64urlStr(JSON.stringify(header)) + '.' + b64urlStr(JSON.stringify(claim));
  const ck = await crypto.subtle.importKey('pkcs8', pemToPkcs8(key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', ck, new TextEncoder().encode(unsigned));
  const jwt = unsigned + '.' + b64urlBytes(new Uint8Array(sig));
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + encodeURIComponent(jwt),
  });
  const data = await resp.json();
  if (!resp.ok || !data.access_token) throw new Error('Token exchange failed: ' + (data.error_description || data.error || resp.status));
  return { token: data.access_token, exp: now + (data.expires_in || 3600) };
}
async function getToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.token;
  cachedToken = await mintToken(env);
  return cachedToken.token;
}
async function makeSheets(env) {
  const token = await getToken(env);
  const id = env.SHEET_ID || DEFAULT_SHEET_ID;
  const base = 'https://sheets.googleapis.com/v4/spreadsheets/' + id;
  const auth = { Authorization: 'Bearer ' + token };
  async function call(url, opts) {
    const r = await fetch(url, opts);
    const t = await r.text();
    let j; try { j = t ? JSON.parse(t) : {}; } catch (e) { throw new Error('Sheets API non-JSON: ' + t.slice(0, 200)); }
    if (!r.ok) throw new Error('Sheets API ' + r.status + ': ' + (j.error && j.error.message ? j.error.message : t.slice(0, 200)));
    return j;
  }
  return {
    id,
    async read(rangeA1, unformatted) {
      const q = unformatted ? '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER' : '?valueRenderOption=FORMATTED_VALUE';
      const j = await call(base + '/values/' + encodeURIComponent(rangeA1) + q, { headers: auth });
      return j.values || [];
    },
    async append(rangeA1, row) {
      return call(base + '/values/' + encodeURIComponent(rangeA1) + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
        { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [row] }) });
    },
    async update(rangeA1, values) {
      return call(base + '/values/' + encodeURIComponent(rangeA1) + '?valueInputOption=RAW',
        { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ values }) });
    },
    async batchUpdate(data) {
      return call(base + '/values:batchUpdate',
        { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ valueInputOption: 'RAW', data }) });
    },
  };
}
function serialToYMD(serial, tz) {
  if (!serial && serial !== 0) return '';
  const ms = Math.round((Number(serial) - 25569) * 86400 * 1000);
  const d = new Date(ms);
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }
  catch (e) { return d.toISOString().slice(0, 10); }
}
function todayYMD() {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
  catch (e) { return new Date().toISOString().slice(0, 10); }
}

// ---------------- backend reads (ported from Code.gs) ----------------
function num(v) { return Number(v) || 0; }
async function readObjects(sheets, tab, unformatted) {
  const values = await sheets.read(tab, unformatted);
  if (!values.length) return { headers: [], rows: [] };
  const headers = values[0].map((h) => String(h));
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i] || [];
    const o = {};
    headers.forEach((h, c) => { if (h) o[h] = r[c] !== undefined && r[c] !== null ? r[c] : ''; });
    o.__row = i + 1;
    rows.push(o);
  }
  return { headers, rows };
}
async function getRateTree(sheets) {
  const { rows } = await readObjects(sheets, RATE);
  const groups = []; const tree = {};
  rows.forEach((r) => {
    const group = r['Group']; if (!group) return;
    if (!tree[group]) { tree[group] = { subs: [], items: {} }; groups.push(group); }
    const node = tree[group];
    const subKey = r['Sub-Variant'] || '';
    if (!node.items[subKey]) { node.items[subKey] = []; node.subs.push(r['Sub-Variant'] || ''); }
    node.items[subKey].push({ item: r['Item'], chemCode: r['Chem Code'], appCost: num(r['Application Cost']), lineCost: num(r['Line Cost']), totalCost: num(r['Total Cost']) });
  });
  const addons = ((tree[ADDON_SOURCE_GROUP] && tree[ADDON_SOURCE_GROUP].items['']) || []).filter((it) => ADDON_ITEM_NAMES.indexOf(it.item) !== -1);
  return { groups, tree, addonGroup: ADDON_SOURCE_GROUP, addons };
}
async function rateGroups(sheets) {
  const { rows } = await readObjects(sheets, RATE);
  const seen = {}; const out = [];
  rows.forEach((r) => { if (r['Group'] && !seen[r['Group']]) { seen[r['Group']] = true; out.push(r['Group']); } });
  return out;
}
function guessGroupForEndUse(endUse, groups) {
  if (!endUse) return null;
  const normalized = String(endUse).toUpperCase().replace(/\s+/g, '');
  let best = null;
  groups.forEach((g) => {
    String(g).toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean).forEach((tok) => { if (tok.length >= 3 && normalized.indexOf(tok) !== -1) best = g; });
  });
  return best;
}
async function getAllTickets(sheets) {
  const { rows } = await readObjects(sheets, MASTER);
  return rows.filter((o) => o['Ticket'] || o['Skid ID']).map((o) => ({
    skidId: o['Skid ID'] || '', ticket: o['Ticket'], supplier: o['Supplier'], endUse: o['End Use'],
    width: o['Width'], length: o['Length'], weight: o['Weight'], qty: o['QTY/LOAD'],
    bw: o['BW'], type: o['TC'], temper: o['TM'], litho: num(o['Litho']), status: o['Status'] || 'Current',
  }));
}
function activeCoatings(history) {
  const voided = {};
  (history || []).forEach((h) => { const m = /^VOID#(\d+):/.exec(String(h.notes || '')); if (m) voided[m[1]] = true; });
  return (history || []).filter((h) => String(h.group || '').trim() !== '' && num(h.passTotal) > 0 && !voided[String(h.passNumber)])
    .map((h) => ({ passNumber: h.passNumber, group: h.group, sub: h.sub, item: h.item, chemCode: h.chemCode, cost: num(h.passTotal) }));
}
async function getTransactionHistory(sheets, skidId, ticket) {
  const { rows } = await readObjects(sheets, TRANSACTIONS);
  return rows.filter((r) => {
    const sid = String(r['Skid ID'] || '').trim();
    if (sid) return skidId && sid === String(skidId).trim();
    return ticket && String(r['Ticket']).trim() === String(ticket).trim();
  }).map((r) => ({
    timestamp: r['Timestamp'], ticket: r['Ticket'], passNumber: num(r['Pass Number']), operator: r['Operator'],
    group: r['Group'], sub: r['Sub-Variant'], item: r['Item'], chemCode: r['Chem Code'],
    appCost: r['Application Cost'], lineCost: r['Line Cost'], passTotal: r['Pass Total Cost'],
    runningTotal: r['Running Total After Pass'], notes: r['Notes'], jobName: r['Job Name'], skidId: r['Skid ID'],
  })).sort((a, b) => a.passNumber - b.passNumber);
}
async function getTicketCard(sheets, skidId) {
  const { rows } = await readObjects(sheets, MASTER);
  const obj = rows.filter((o) => String(o['Skid ID']).trim() === String(skidId).trim())[0];
  if (!obj) throw new Error('Skid not found: ' + skidId);
  const history = await getTransactionHistory(sheets, skidId, obj['Ticket']);
  const active = activeCoatings(history);
  const groups = await rateGroups(sheets);
  return { skidId, ticket: obj['Ticket'], status: obj['Status'] || 'Current', steel: obj, litho: num(obj['Litho']),
    passCount: active.length, suggestedGroup: guessGroupForEndUse(obj['End Use'], groups), coatings: active, transactions: history };
}
async function getJobsForDate(sheets, dateStr) {
  const { rows } = await readObjects(sheets, JOBS, true);
  const target = dateStr || todayYMD();
  return rows.filter((o) => o['Job ID']).filter((o) => serialToYMD(o['Created At'], TZ) === target).map((o) => ({
    jobId: o['Job ID'], createdBy: o['Created By'], createdAt: serialToYMD(o['Created At'], TZ),
    description: o['Description'], coatings: o['Coatings'], ticketCount: o['Ticket Count'], status: o['Status'],
  }));
}
async function getJobDetail(sheets, jobId) {
  const jobs = await readObjects(sheets, JOBS, true);
  const job = jobs.rows.filter((o) => String(o['Job ID']).trim() === String(jobId).trim())[0];
  if (!job) throw new Error('Job not found: ' + jobId);
  let recipe = []; try { recipe = JSON.parse(job['Coatings JSON'] || '[]') || []; } catch (e) { recipe = []; }
  const master = await readObjects(sheets, MASTER);
  const tickets = master.rows.filter((o) => String(o['Job ID']).trim() === String(jobId).trim()).map((o) => ({
    skidId: o['Skid ID'], ticket: o['Ticket'], status: o['Status'], litho: num(o['Litho']), bw: o['BW'], type: o['TC'], temper: o['TM'], endUse: o['End Use'],
  }));
  return { jobId: job['Job ID'], description: job['Description'], createdBy: job['Created By'], createdAt: serialToYMD(job['Created At'], TZ),
    status: job['Status'], approvedAt: job['Approved At'] ? serialToYMD(job['Approved At'], TZ) : '', approvedBy: job['Approved By'],
    coatings: recipe, coatingsSummary: job['Coatings'], notes: job['Notes'], tickets };
}
