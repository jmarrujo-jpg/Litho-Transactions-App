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

// ---- Material-loading / receiving tabs (self-created on first touch) ----
const DEPARTMENTS = 'Departments';
const MACHINES = 'Machines';
const MATERIALS = 'Materials';
const LOTS = 'Lots';
const STEEL_RECEIVING = 'Steel Receiving';
const MATERIALS_RECEIVING = 'Materials Receiving';
const MATERIAL_LOADS = 'Material Loads';

// Header rows for each managed tab. The first list in each pair also tells ensureTab what to
// seed (only Departments seeds data rows). Steel and materials receiving are deliberately two
// separate tabs so the two receiving trails never mix.
const TAB_HEADERS = {
  [DEPARTMENTS]: ['Name', 'Active', 'Created At', 'Created By'],
  [MACHINES]: ['Machine', 'Type', 'Department', 'Active', 'Created At', 'Created By'],
  [MATERIALS]: ['Material', 'Kind', 'Department', 'Active', 'Created At', 'Created By'],
  [LOTS]: ['Lot', 'Material', 'Kind', 'Qty', 'Department', 'Received Date', 'Received By', 'Created At'],
  [STEEL_RECEIVING]: ['Timestamp', 'Op ID', 'Lot', 'Material', 'Qty', 'Received By', 'Department', 'Notes'],
  [MATERIALS_RECEIVING]: ['Timestamp', 'Op ID', 'Lot', 'Material', 'Qty', 'Received By', 'Department', 'Notes'],
  [MATERIAL_LOADS]: ['Timestamp', 'Op ID', 'Department', 'Machine', 'Material', 'Lot', 'Qty', 'Operator', 'Notes'],
};
const DEFAULT_DEPARTMENTS = ['Metals', 'Litho', 'Plastics'];

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
    // ---- material loading / receiving / setup ----
    case 'getLoadingSetup': return getLoadingSetup(sheets);
    case 'getReceivingLog': return getReceivingLog(sheets, args[0], args[1]);
    case 'getLoadsLog': return getLoadsLog(sheets, args[0], args[1]);
    case 'addSetupEntry': return addSetupEntry(sheets, args[0], args[1], args[2]);
    case 'setSetupActive': return setSetupActive(sheets, args[0], args[1], args[2], args[3]);
    case 'recordReceiving': return recordReceiving(sheets, args[0], args[1], args[2]);
    case 'recordLoad': return recordLoad(sheets, args[0], args[1]);
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
    async tabTitles() {
      const j = await call(base + '?fields=' + encodeURIComponent('sheets.properties.title'), { headers: auth });
      return (j.sheets || []).map((s) => s.properties && s.properties.title).filter(Boolean);
    },
    async addTabs(titles) {
      if (!titles.length) return;
      return call(base + ':batchUpdate',
        { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests: titles.map((t) => ({ addSheet: { properties: { title: t } } })) }) });
    },
  };
}

// Ensures every managed loading/receiving tab exists with its header row, creating any that are
// missing (one metadata read + at most one addSheet batch + header writes). Departments is seeded
// with the three default departments on first creation. Safe to call before every read/write.
let loadingTabsReady = false;
async function ensureLoadingTabs(sheets) {
  if (loadingTabsReady) return;
  const titles = await sheets.tabTitles();
  const have = {};
  titles.forEach((t) => { have[t] = true; });
  const missing = Object.keys(TAB_HEADERS).filter((t) => !have[t]);
  if (missing.length) await sheets.addTabs(missing);
  // Write header rows for any tab that is missing or has an empty first cell.
  for (const tab of Object.keys(TAB_HEADERS)) {
    const headers = TAB_HEADERS[tab];
    let firstRow = [];
    if (!missing.includes(tab)) {
      try { firstRow = (await sheets.read(tab + '!1:1'))[0] || []; } catch (e) { firstRow = []; }
    }
    if (!firstRow.length || !String(firstRow[0] || '').trim()) {
      await sheets.update(tab + '!A1', [headers]);
      if (tab === DEPARTMENTS) {
        const now = nowStamp();
        for (const name of DEFAULT_DEPARTMENTS) {
          await sheets.append(DEPARTMENTS, [name, 'Yes', now, 'system']);
        }
      }
    }
  }
  loadingTabsReady = true;
}

function nowStamp() {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date()).replace(',', '');
  } catch (e) { return new Date().toISOString().slice(0, 19).replace('T', ' '); }
}
function truthy(v) { const s = String(v == null ? '' : v).trim().toLowerCase(); return s === 'yes' || s === 'true' || s === '1' || s === 'y' || s === 'active'; }
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

// ============================================================================================
// Material loading, receiving, and setup (Departments / Machines / Materials / Lots).
// These tabs are self-created; Departments seeds Metals / Litho / Plastics on first touch.
// ============================================================================================

function clean(v) { return v == null ? '' : String(v).trim(); }
async function opIdSeen(sheets, tab, opId) {
  if (!opId) return false;
  const { headers, rows } = await readObjects(sheets, tab);
  if (headers.indexOf('Op ID') === -1) return false;
  return rows.some((r) => clean(r['Op ID']) === clean(opId));
}

// Returns every setup list (active + inactive) so the Setup screen can show and reactivate
// everything; the Loading/Receiving screens filter to Active themselves.
async function getLoadingSetup(sheets) {
  await ensureLoadingTabs(sheets);
  const dep = await readObjects(sheets, DEPARTMENTS);
  const mac = await readObjects(sheets, MACHINES);
  const mat = await readObjects(sheets, MATERIALS);
  const lot = await readObjects(sheets, LOTS);
  return {
    departments: dep.rows.filter((r) => clean(r['Name'])).map((r) => ({
      name: clean(r['Name']), active: truthy(r['Active']) })),
    machines: mac.rows.filter((r) => clean(r['Machine'])).map((r) => ({
      machine: clean(r['Machine']), type: clean(r['Type']), department: clean(r['Department']), active: truthy(r['Active']) })),
    materials: mat.rows.filter((r) => clean(r['Material'])).map((r) => ({
      material: clean(r['Material']), kind: clean(r['Kind']) || 'Material', department: clean(r['Department']), active: truthy(r['Active']) })),
    lots: lot.rows.filter((r) => clean(r['Lot'])).map((r) => ({
      lot: clean(r['Lot']), material: clean(r['Material']), kind: clean(r['Kind']) || 'Material',
      qty: clean(r['Qty']), department: clean(r['Department']), receivedDate: clean(r['Received Date']) })),
  };
}

async function getReceivingLog(sheets, kind, limit) {
  await ensureLoadingTabs(sheets);
  const tab = String(kind) === 'steel' ? STEEL_RECEIVING : MATERIALS_RECEIVING;
  const { rows } = await readObjects(sheets, tab);
  const out = rows.filter((r) => clean(r['Timestamp']) || clean(r['Material'])).map((r) => ({
    timestamp: clean(r['Timestamp']), lot: clean(r['Lot']), material: clean(r['Material']),
    qty: clean(r['Qty']), receivedBy: clean(r['Received By']), department: clean(r['Department']), notes: clean(r['Notes']) }));
  out.reverse();
  return limit ? out.slice(0, limit) : out;
}

async function getLoadsLog(sheets, dept, limit) {
  await ensureLoadingTabs(sheets);
  const { rows } = await readObjects(sheets, MATERIAL_LOADS);
  let out = rows.filter((r) => clean(r['Timestamp']) || clean(r['Machine'])).map((r) => ({
    timestamp: clean(r['Timestamp']), department: clean(r['Department']), machine: clean(r['Machine']),
    material: clean(r['Material']), lot: clean(r['Lot']), qty: clean(r['Qty']), operator: clean(r['Operator']), notes: clean(r['Notes']) }));
  if (dept) out = out.filter((r) => r.department === clean(dept));
  out.reverse();
  return limit ? out.slice(0, limit) : out;
}

// kind: 'department' | 'machine' | 'material' | 'lot'. Dedupes by natural key (case-insensitive).
async function addSetupEntry(sheets, kind, data, opId) {
  await ensureLoadingTabs(sheets);
  data = data || {};
  const now = nowStamp();
  const by = clean(data.by) || 'app';
  if (kind === 'department') {
    const name = clean(data.name);
    if (!name) throw new Error('Department name is required.');
    const { rows } = await readObjects(sheets, DEPARTMENTS);
    if (rows.some((r) => clean(r['Name']).toLowerCase() === name.toLowerCase())) return { ok: true, duplicate: true };
    await sheets.append(DEPARTMENTS, [name, 'Yes', now, by]);
    return { ok: true, name };
  }
  if (kind === 'machine') {
    const machine = clean(data.machine);
    if (!machine) throw new Error('Machine name is required.');
    const { rows } = await readObjects(sheets, MACHINES);
    if (rows.some((r) => clean(r['Machine']).toLowerCase() === machine.toLowerCase())) return { ok: true, duplicate: true };
    await sheets.append(MACHINES, [machine, clean(data.type), clean(data.department), 'Yes', now, by]);
    return { ok: true, machine };
  }
  if (kind === 'material') {
    const material = clean(data.material);
    if (!material) throw new Error('Material name is required.');
    const kindVal = clean(data.kind) === 'Steel' ? 'Steel' : 'Material';
    const { rows } = await readObjects(sheets, MATERIALS);
    if (rows.some((r) => clean(r['Material']).toLowerCase() === material.toLowerCase())) return { ok: true, duplicate: true };
    await sheets.append(MATERIALS, [material, kindVal, clean(data.department), 'Yes', now, by]);
    return { ok: true, material };
  }
  if (kind === 'lot') {
    const lot = clean(data.lot);
    if (!lot) throw new Error('Lot number is required.');
    const { rows } = await readObjects(sheets, LOTS);
    if (rows.some((r) => clean(r['Lot']).toLowerCase() === lot.toLowerCase())) return { ok: true, duplicate: true };
    const kindVal = clean(data.kind) === 'Steel' ? 'Steel' : 'Material';
    await sheets.append(LOTS, [lot, clean(data.material), kindVal, clean(data.qty), clean(data.department), clean(data.receivedDate), clean(data.receivedBy), now]);
    return { ok: true, lot };
  }
  throw new Error('Unknown setup kind: ' + kind);
}

// Flips the Active column for one setup row (soft delete / reactivate).
async function setSetupActive(sheets, kind, key, active, opId) {
  await ensureLoadingTabs(sheets);
  const map = { department: [DEPARTMENTS, 'Name'], machine: [MACHINES, 'Machine'], material: [MATERIALS, 'Material'], lot: [LOTS, 'Lot'] };
  const spec = map[kind];
  if (!spec) throw new Error('Unknown setup kind: ' + kind);
  const [tab, keyCol] = spec;
  const { headers, rows } = await readObjects(sheets, tab);
  const activeCol = headers.indexOf('Active');
  if (activeCol === -1) throw new Error(tab + ' has no Active column.');
  const row = rows.find((r) => clean(r[keyCol]).toLowerCase() === clean(key).toLowerCase());
  if (!row) throw new Error(kind + ' not found: ' + key);
  const colLetter = colToLetter(activeCol + 1);
  await sheets.update(tab + '!' + colLetter + row.__row, [[active ? 'Yes' : 'No']]);
  return { ok: true };
}

function colToLetter(n) { let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; }

// Records a receiving event into the steel OR materials log (kept separate), and upserts the Lot.
async function recordReceiving(sheets, kind, data, opId) {
  await ensureLoadingTabs(sheets);
  const isSteel = String(kind) === 'steel';
  const tab = isSteel ? STEEL_RECEIVING : MATERIALS_RECEIVING;
  if (await opIdSeen(sheets, tab, opId)) return { ok: true, duplicate: true };
  data = data || {};
  const material = clean(data.material);
  if (!material) throw new Error('Material is required.');
  const lot = clean(data.lot);
  const qty = clean(data.qty);
  const receivedBy = clean(data.receivedBy);
  const department = clean(data.department);
  const notes = clean(data.notes);
  const now = nowStamp();
  const date = clean(data.receivedDate) || todayYMD();
  await sheets.append(tab, [now, clean(opId), lot, material, qty, receivedBy, department, notes]);
  // Upsert the lot so it shows up for loading. New lot -> create; existing -> leave as-is.
  if (lot) {
    const { rows } = await readObjects(sheets, LOTS);
    if (!rows.some((r) => clean(r['Lot']).toLowerCase() === lot.toLowerCase())) {
      await sheets.append(LOTS, [lot, material, isSteel ? 'Steel' : 'Material', qty, department, date, receivedBy, now]);
    }
  }
  return { ok: true, timestamp: now };
}

async function recordLoad(sheets, data, opId) {
  await ensureLoadingTabs(sheets);
  if (await opIdSeen(sheets, MATERIAL_LOADS, opId)) return { ok: true, duplicate: true };
  data = data || {};
  const machine = clean(data.machine);
  const material = clean(data.material);
  if (!machine) throw new Error('Machine is required.');
  if (!material) throw new Error('Material is required.');
  const now = nowStamp();
  await sheets.append(MATERIAL_LOADS, [now, clean(opId), clean(data.department), machine, material, clean(data.lot), clean(data.qty), clean(data.operator), clean(data.notes)]);
  return { ok: true, timestamp: now };
}
