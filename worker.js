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
const TRANSACTIONS = 'Transactions';
const JOBS = 'Litho Jobs';
const RATE = 'Litho Rate Table';
const PRODUCTION = 'Production Runs';
const PRODUCTION_HEADERS = ['Run ID', 'Created On', 'Operator', 'Machine', 'Status', 'Skid Count', 'Notes', 'Submitted On', 'Finished On', 'Op ID'];

// Slitter Department: a log-only traceability module. A session is one cutting sitting on a
// Slitter #; each output pallet is its own row carrying an operator-entered count and a
// Composition (JSON [{skidId,ticket,mill,qty}]) so a pallet cut from 2-3 source skids records
// its mixed mill numbers. NOTHING here touches Steel Tickets inventory.
const SLITTER_SESSIONS = 'Slitter Sessions';
const SLITTER_SESSION_HEADERS = ['Session ID', 'Slitter', 'Kind', 'Operator', 'Created On', 'Status', 'Pallet Count', 'Active Skid', 'Active Ticket', 'Active Mill', 'Pallet Coils', 'Notes', 'Op ID'];
const SLITTER_PALLETS = 'Slitter Pallets';
const SLITTER_PALLET_HEADERS = ['Pallet ID', 'Session ID', 'Created On', 'Output Count', 'Composition', 'Skid ID', 'Load #', 'Notes', 'Op ID'];

const ADDON_SOURCE_GROUP = 'Specialty / Low Volume / Setup';
const ADDON_ITEM_NAMES = ['SIZE', 'ENAMEL ONE SIDE', 'WHITE BASE COAT',
  'VARNISH WET-STANDARD', 'VARNISH WET-PEBBLE', 'VARNISH DRY-STANDARD', 'VARNISH DRY-PEBBLE', 'WAX ONLY',
  'LITHO PRINT SINGLE COLOR - ONE', 'LITHO PRINT SINGLE COLOR - TWO', 'LITHO PRINT SINGLE COLOR - THREE',
  'LITHO PRINT SINGLE COLOR - FOUR', 'LITHO PRINT SINGLE COLOR - FIVE', 'LITHO PRINT SINGLE COLOR - SIX',
  'LITHO PRINT TWO COLOR - ONE', 'LITHO PRINT TWO COLOR - TWO', 'LITHO PRINT TWO COLOR - THREE',
  'LITHO PRINT TWO COLOR - FOUR', 'LITHO PRINT TWO COLOR - FIVE', 'LITHO PRINT TWO COLOR - SIX'];

const STATUS = { CURRENT: 'Current', PENDING: 'Pending', WIP: 'WIP', IN_PRODUCTION: 'In Production', USED: 'Used', MISSING: 'Missing', CUT: 'Cut' };

// Guided physical count: a two-stage session (Current walk -> WIP walk) tracked server-side so
// it can span days and resume on any device. Stage is 'Current' | 'WIP' | 'Done'.
const COUNTS = 'Count Sessions';
const COUNT_HEADERS = ['Session ID', 'Started At', 'Started By', 'Stage', 'Ended At', 'Ended By',
  'Current Found', 'Promoted', 'WIP Found', 'Missing Marked', 'Op ID'];
const COUNT_TALLY_COLS = ['Current Found', 'Promoted', 'WIP Found', 'Missing Marked'];

// Editable steel-spec columns captured on Add Ticket and Edit ticket details (mirrors the
// paper ticket; QTY first). B/C and Mill are new columns created on demand.
const TICKET_DETAIL_COLS = ['QTY/LOAD', 'Weight', 'B/C', 'TC', 'Length', 'Mill', 'BW', 'C/S', 'End Use', 'Supplier', 'TM', 'Width', 'Comments'];
const TICKET_COL_LABELS = { 'QTY/LOAD': 'QTY', 'Weight': 'Weight', 'B/C': 'B/C', 'TC': 'Type', 'Length': 'Length', 'Mill': 'Mill', 'BW': 'Basis Weight', 'C/S': 'Coil / Sheet', 'End Use': 'End Use', 'Supplier': 'Supplier', 'TM': 'Temper', 'Width': 'Width', 'Comments': 'Comments', 'Row': 'Row', 'Spoilage': 'Spoilage' };
const TICKET_NUMERIC_COLS = { 'QTY/LOAD': true, 'Weight': true, 'Spoilage': true };

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
    if (request.method === 'GET') return json({ ok: true, service: 'litho-api', stage: 'full', build: 'count-39' }, 200);
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
    case 'getUsedTickets': return getUsedTickets(sheets);
    case 'getOperatorNames': return [];
    case 'getTicketCard': return getTicketCard(sheets, args[0]);
    case 'getJobsForDate': return getJobsForDate(sheets, args[0]);
    case 'getOpenJobs': return getOpenJobs(sheets, args[0]);
    case 'snapshotCurrentWip': // (opId) -> writes a dated Current+WIP tab into the snapshots spreadsheet
      return snapshotCurrentWip(sheets, env, args[0]);
    case 'getJobDetail': return getJobDetail(sheets, args[0]);
    // ---- writes (Stage 2) ----
    case 'applyCoating': // (skidId, group, sub, item, operator, notes, sheetsRun, isPartialSkid, lithoNote, jobName, opId, coatedTicket)
      return applyCoating(sheets, args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7], args[8], args[9], args[10], undefined, undefined, args[11]);
    case 'createManualTicket': // (ticket, fields, operator, opId)
      return createManualTicket(sheets, args[0], args[1], args[2], args[3]);
    case 'updateWipLithoCost': // (skidId, newCost, operator, notes, opId)
      return updateWipLithoCost(sheets, args[0], args[1], args[2], args[3], args[4]);
    case 'updateTicketDetails': // (skidId, fields, operator, opId)
      return updateTicketDetails(sheets, args[0], args[1], args[2], args[3]);
    case 'editTicketCoating': // (skidId, passNumber, group, sub, item, operator, opId)
      return editTicketCoating(sheets, args[0], args[1], args[2], args[3], args[4], args[5], args[6]);
    case 'removeTicketCoating': // (skidId, passNumber, operator, opId)
      return removeTicketCoating(sheets, args[0], args[1], args[2], args[3]);
    case 'createJob': // (description, operator, coatings, notes, opId)
      return createJob(sheets, args[0], args[1], args[2], args[3], args[4]);
    case 'jobAddTicket': // (jobId, skidId, sheetsRun, isPartialSkid, lithoNote, operator, opId, coatedTicket)
      return jobAddTicket(sheets, args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7]);
    case 'addCoatingToJob': // (jobId, coating, operator, opId)
      return addCoatingToJob(sheets, args[0], args[1], args[2], args[3]);
    case 'removeTicketFromJob': // (jobId, skidId, operator, opId)
      return removeTicketFromJob(sheets, args[0], args[1], args[2], args[3]);
    case 'approveJob': // (jobId, operator, opId)
      return approveJob(sheets, args[0], args[1]);
    case 'deleteJob': // (jobId, operator, opId)
      return deleteJob(sheets, args[0], args[1], args[2]);
    // ---- production ----
    case 'getProductionRuns': // (dateStr, scope)
      return getProductionRuns(sheets, args[0], args[1]);
    case 'getRunDetail': // (runId)
      return getRunDetail(sheets, args[0]);
    case 'createRun': // (machine, operator, notes, opId)
      return createRun(sheets, args[0], args[1], args[2], args[3]);
    case 'runAddSkid': // (runId, skidId, operator, opId)
      return runAddSkid(sheets, args[0], args[1], args[2], args[3]);
    case 'runRemoveSkid': // (runId, skidId, operator, opId)
      return runRemoveSkid(sheets, args[0], args[1], args[2], args[3]);
    case 'updateRun': // (runId, fields, operator, opId)
      return updateRun(sheets, args[0], args[1], args[2], args[3]);
    case 'updateRunSkid': // (runId, skidId, fields, operator, opId)
      return updateRunSkid(sheets, args[0], args[1], args[2], args[3], args[4]);
    case 'swapRunSkid': // (runId, oldSkidId, newSkidId, operator, opId)
      return swapRunSkid(sheets, args[0], args[1], args[2], args[3], args[4]);
    case 'submitRun': // (runId, operator, opId)
      return submitRun(sheets, args[0], args[1], args[2]);
    case 'runSkidPartial': // (runId, skidId, sheetsRan, operator, opId)
      return runSkidPartial(sheets, args[0], args[1], args[2], args[3], args[4]);
    case 'finishRun': // (runId, usedMap, operator, opId)
      return finishRun(sheets, args[0], args[1], args[2], args[3]);
    case 'markUsedDirect': // (skidIds[], usedDate, opId)
      return markUsedDirect(sheets, args[0], args[1], args[2]);
    case 'cutCoil': // (coilSkidId, cutDate, coilLine, skids[{weight,qty}], finish, opId)
      return cutCoil(sheets, args[0], args[1], args[2], args[3], args[4], args[5]);
    case 'getRawTable': // (tableKey: 'steel' | 'tx')
      return getRawTable(sheets, args[0]);
    case 'updateRawRow': // (tableKey, rowNum, fields, opId)
      return updateRawRow(sheets, args[0], args[1], args[2], args[3]);
    case 'importStaging': // (opId) fresh-start import from the 'Current' + 'WIP' tabs
      return importStaging(sheets, args[0]);
    // ---- slitter (log-only) ----
    case 'getSlitterSessions': // (kind, dateStr, scope)
      return getSlitterSessions(sheets, args[0], args[1], args[2]);
    case 'getSlitterDetail': // (sessionId)
      return getSlitterDetail(sheets, args[0]);
    case 'createSlitterSession': // (kind, slitter, operator, notes, opId)
      return createSlitterSession(sheets, args[0], args[1], args[2], args[3], args[4]);
    case 'slitterLoadSkid': // (sessionId, skidId, operator, opId)
      return slitterLoadSkid(sheets, args[0], args[1], args[2], args[3]);
    case 'slitterSwitchSkid': // (sessionId, stripsOnPalletNow, newSkidId, operator, opId)
      return slitterSwitchSkid(sheets, args[0], args[1], args[2], args[3], args[4]);
    case 'slitterFinishPallet': // (sessionId, stripsOnPalletNow, notes, operator, opId)
      return slitterFinishPallet(sheets, args[0], args[1], args[2], args[3], args[4]);
    case 'removeSlitterPallet': // (sessionId, palletId, operator, opId)
      return removeSlitterPallet(sheets, args[0], args[1], args[2], args[3]);
    case 'finishSlitterSession': // (sessionId, operator, opId)
      return finishSlitterSession(sheets, args[0], args[1], args[2]);
    // ---- reports ----
    case 'getLithoReport': // (startYMD, endYMD)
      return getLithoReport(sheets, args[0], args[1]);
    case 'getMetalsReport': // (startYMD, endYMD)
      return getMetalsReport(sheets, args[0], args[1]);
    case 'getDepartmentReport': // (startYMD, endYMD, dept)
      return getDepartmentReport(sheets, args[0], args[1], args[2]);
    // ---- steel count ----
    case 'setSkidCounted': // (skidId, counted, operator, opId)
      return setSkidCounted(sheets, args[0], args[1], args[2], args[3]);
    case 'setSkidsCounted': // (skidIds[], counted, operator, opId)
      return setSkidsCounted(sheets, args[0], args[1], args[2], args[3]);
    case 'getActiveCount': // ()
      return getActiveCount(sheets);
    case 'startCount': // (operator, opId)
      return startCount(sheets, args[0], args[1]);
    case 'setCountStage': // (sessionId, stage, operator, opId)
      return setCountStage(sheets, args[0], args[1], args[2], args[3]);
    case 'endCount': // (sessionId, operator, summary, opId)
      return endCount(sheets, args[0], args[1], args[2], args[3]);
    case 'clearAllCounts': // (operator, opId)
      return clearAllCounts(sheets, args[0], args[1]);
    case 'getCountHistory': // ()
      return getCountHistory(sheets);
    case 'promoteUnfoundToWip': // (skidIds[], operator, opId)
      return promoteUnfoundToWip(sheets, args[0], args[1], args[2]);
    case 'markSkidsMissing': // (skidIds[], operator, opId)
      return markSkidsMissing(sheets, args[0], args[1], args[2]);
    case 'restoreMissing': // (skidId, toStatus, operator, opId)
      return restoreMissing(sheets, args[0], args[1], args[2], args[3]);
    default:
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
    async addSheet(title) {
      return call(base + ':batchUpdate',
        { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }) });
    },
    async meta() {
      return call(base + '?fields=' + encodeURIComponent('sheets.properties(sheetId,title,gridProperties)'), { headers: auth });
    },
    async appendColumns(sheetId, count) {
      return call(base + ':batchUpdate',
        { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ requests: [{ appendDimension: { sheetId, dimension: 'COLUMNS', length: count } }] }) });
    },
    async appendRows(sheetId, count) {
      return call(base + ':batchUpdate',
        { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ requests: [{ appendDimension: { sheetId, dimension: 'ROWS', length: count } }] }) });
    },
    async deleteRows(sheetId, startIndex, endIndex) {   // 0-based, half-open [startIndex, endIndex)
      return call(base + ':batchUpdate',
        { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ requests: [{ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex, endIndex } } }] }) });
    },
    // ---- cross-spreadsheet helpers (write to a DIFFERENT spreadsheet the SA has been shared on;
    //      used for the snapshots archive). Only the `spreadsheets` scope is needed. ----
    async metaOf(spreadsheetId) {
      return call('https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId + '?fields=' + encodeURIComponent('sheets.properties(title)'), { headers: auth });
    },
    async addSheetTo(spreadsheetId, title, rowCount, columnCount) {
      return call('https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId + ':batchUpdate',
        { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests: [{ addSheet: { properties: { title, gridProperties: { rowCount: Math.max(rowCount, 1), columnCount: Math.max(columnCount, 1) } } } }] }) });
    },
    async writeValues(spreadsheetId, rangeA1, values) {
      return call('https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId + '/values/' + encodeURIComponent(rangeA1) + '?valueInputOption=RAW',
        { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ values }) });
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
// Tolerates thousands-separator commas ("4,405" -> 4405) which appear in some weight cells;
// plain Number() would read those as NaN and silently treat the weight as 0.
function num(v) { return Number(String(v == null ? '' : v).replace(/,/g, '')) || 0; }
// The skid's "used" date/time lives in 'Used At'. Historically it was 'Finished On' (date only);
// we still read that as a fallback so pre-migration rows keep counting until the old column is gone.
function usedAt(o) { return o['Used At'] || o['Finished On'] || ''; }
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
    row: o['Row'] != null ? o['Row'] : '', mill: o['Mill'] || '', cutType: o['Cut Type'] || '', loadNo: o['Load #'] || '', cost: num(o['Cost']), countedOn: toYMD(o['Counted At']),
    cs: String(o['C/S'] || o['Coil/Sheet'] || '').trim(), splitOf: o['Split Of'] || '',
    missingOn: toYMD(o['Missing At']), missingBy: o['Missing By'] || '',
  }));
}

// Only the skids that have gone through production — Used (consumed) or In Production (on a
// machine now). Loaded on demand by the global search screen's "Used in production" section
// so the day-to-day active-inventory fetch never has to carry this ever-growing history.
async function getUsedTickets(sheets) {
  const { rows } = await readObjects(sheets, MASTER);
  return rows.filter((o) => {
    const s = o['Status'] || '';
    return s === STATUS.USED || s === STATUS.IN_PRODUCTION;
  }).map((o) => ({
    skidId: o['Skid ID'] || '', ticket: o['Ticket'], supplier: o['Supplier'], endUse: o['End Use'],
    width: o['Width'], length: o['Length'], weight: o['Weight'], qty: o['QTY/LOAD'],
    bw: o['BW'], type: o['TC'], temper: o['TM'], litho: num(o['Litho']), status: o['Status'] || STATUS.USED,
    row: o['Row'] != null ? o['Row'] : '', runId: o['Run ID'] || '',
    finishedOn: toYMD(usedAt(o)), usedBy: o['Used By'] || '',
  })).sort((a, b) => String(b.finishedOn).localeCompare(String(a.finishedOn)));
}

// The "split family" of a ticket: every skid that traces back to the same original ticket
// (the original plus all -LR#/-MR# remainders), so from any one skid you can see the parent
// and every piece that came off it, and what became of each. Grouped by base ticket number,
// which baseTicketOf() strips remainder suffixes down to; Split Of carries the exact parent.
function familyOf(rows, ticket) {
  const base = baseTicketOf(ticket);
  if (!base) return { base: '', members: [] };
  const members = rows.filter((o) => (o['Ticket'] || o['Skid ID']) && baseTicketOf(o['Ticket']) === base)
    .map((o) => {
      const tk = o['Ticket'] || '';
      return {
        skidId: o['Skid ID'] || '', ticket: tk, status: o['Status'] || STATUS.CURRENT,
        qty: o['QTY/LOAD'] != null ? o['QTY/LOAD'] : '', weight: o['Weight'] != null ? o['Weight'] : '',
        litho: num(o['Litho']), splitOf: o['Split Of'] || '', isOriginal: String(tk).trim() === String(base).trim(),
        runId: o['Run ID'] || '', finishedOn: toYMD(usedAt(o)), usedBy: o['Used By'] || '',
        missingOn: toYMD(o['Missing At']),
      };
    });
  // Original first, then remainders in ticket order (…-LR1, …-LR2, …-MR1).
  members.sort((a, b) => (a.isOriginal === b.isOriginal)
    ? String(a.ticket).localeCompare(String(b.ticket))
    : (a.isOriginal ? -1 : 1));
  return { base, members };
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
    runningTotal: r['Running Total After Pass'], notes: r['Notes'], jobName: r['Job Name'], jobId: r['Job ID'] || '', skidId: r['Skid ID'],
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
    passCount: active.length, suggestedGroup: guessGroupForEndUse(obj['End Use'], groups), coatings: active, transactions: history,
    family: familyOf(rows, obj['Ticket']) };
}
async function getJobsForDate(sheets, dateStr) {
  const { rows } = await readObjects(sheets, JOBS, true);
  const target = dateStr || todayYMD();
  return rows.filter((o) => o['Job ID']).filter((o) => toYMD(o['Created At']) === target).map((o) => ({
    jobId: o['Job ID'], createdBy: o['Created By'], createdAt: toYMD(o['Created At']),
    description: o['Description'], coatings: o['Coatings'], ticketCount: o['Ticket Count'], status: o['Status'],
  }));
}
// Jobs newest first, across all dates. Pending only by default (powers the "open jobs" tiles on
// the main Litho screen and the Review Jobs list); pass includeApproved to also return approved
// jobs (Review Jobs "All" view). Carries both the created date and the approved ("ran") date.
async function getOpenJobs(sheets, includeApproved) {
  const { rows } = await readObjects(sheets, JOBS, true);
  return rows
    .filter((o) => o['Job ID'] && (includeApproved || String(o['Status'] || '').trim() !== 'Approved'))
    .map((o) => ({
      jobId: o['Job ID'], createdBy: o['Created By'], createdAt: toYMD(o['Created At']),
      approvedAt: o['Approved At'] ? toYMD(o['Approved At']) : '',
      description: o['Description'], coatings: o['Coatings'], ticketCount: num(o['Ticket Count']), status: o['Status'],
    }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}
// Point-in-time snapshot: writes the current Current + WIP rows (exactly as they are, all columns)
// into a NEW dated tab in a separate "snapshots" spreadsheet you own and have shared with the
// service account (SNAPSHOT_SHEET_ID). Each tab is right-sized to the data so the archive uses the
// fewest cells possible. Only the spreadsheets scope is required.
async function snapshotCurrentWip(sheets, env, opId) {
  const snapId = (env && env.SNAPSHOT_SHEET_ID) || '';
  if (!snapId) {
    throw new Error('No snapshots spreadsheet is set up yet. Create a Google Sheet, share it with the service account as Editor, and set SNAPSHOT_SHEET_ID to its ID.');
  }
  const master = await readObjects(sheets, MASTER);
  const headers = master.headers.slice();
  const rows = master.rows.filter((o) => {
    const s = String(o['Status'] || '').trim();
    return s === STATUS.CURRENT || s === STATUS.WIP;
  });
  const current = rows.filter((o) => String(o['Status']).trim() === STATUS.CURRENT).length;
  const wip = rows.filter((o) => String(o['Status']).trim() === STATUS.WIP).length;
  // Grid = header row + one row per skid, values in header order.
  const grid = [headers];
  rows.forEach((o) => grid.push(headers.map((h) => (o[h] == null ? '' : o[h]))));
  // Tab name = today's date; if a snapshot already exists for today, add "(2)", "(3)"...
  let existing = new Set();
  try { existing = new Set(((await sheets.metaOf(snapId)).sheets || []).map((s) => s.properties.title)); }
  catch (e) { throw new Error('Could not open the snapshots spreadsheet (' + snapId + '). Make sure it is shared with the service account as Editor. ' + e.message); }
  const dateName = todayYMD();
  let title = dateName; let n = 2;
  while (existing.has(title)) { title = dateName + ' (' + n + ')'; n++; }
  await sheets.addSheetTo(snapId, title, grid.length, headers.length);
  await sheets.writeValues(snapId, "'" + title + "'!A1", grid);
  return { ok: true, tab: title, current, wip, total: rows.length, spreadsheetId: snapId };
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
  return { jobId: job['Job ID'], description: job['Description'], createdBy: job['Created By'], createdAt: toYMD(job['Created At']),
    status: job['Status'], approvedAt: job['Approved At'] ? toYMD(job['Approved At']) : '', approvedBy: job['Approved By'],
    coatings: recipe, coatingsSummary: job['Coatings'], notes: job['Notes'], tickets };
}

// ================= WRITES (Stage 2) =================================================
// Pragmatic concurrency: IDs are derived from the sheet and retries are deduped by opId
// (recorded in an "Op ID" column on Transactions). Good for a few tablets; if true
// simultaneous writes ever become an issue we can add a Durable Object.

function colLetter(n) { let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; }

function nowStamp() {
  const d = new Date();
  try {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(d);
    const g = (t) => (p.find((x) => x.type === t) || {}).value;
    return g('year') + '-' + g('month') + '-' + g('day') + ' ' + g('hour') + ':' + g('minute') + ':' + g('second');
  } catch (e) { return d.toISOString().slice(0, 19).replace('T', ' '); }
}

function mapOf(headers) { const m = {}; headers.forEach((h, i) => { if (h) m[h] = i + 1; }); return m; }

// Reads a whole tab into {headers, rows, map}; rows carry __row (1-based sheet row).
async function readTab(sheets, tab, unformatted) {
  const r = await readObjects(sheets, tab, unformatted);
  return { headers: r.headers, rows: r.rows, map: mapOf(r.headers) };
}

// Writes a set of named cells on one row in a single batch.
async function stampCells(sheets, tab, rowNum, map, fields) {
  const data = [];
  Object.keys(fields).forEach((name) => {
    if (map[name]) data.push({ range: "'" + tab + "'!" + colLetter(map[name]) + rowNum, values: [[fields[name]]] });
  });
  if (data.length) await sheets.batchUpdate(data);
}

// Appends a row built from an object, in the sheet's header order.
async function appendRowObj(sheets, tab, headers, obj) {
  const row = headers.map((h) => (obj.hasOwnProperty(h) ? obj[h] : ''));
  await sheets.append(tab, row);
}

// Looks up a tab's sheetId and current grid width so we can widen it before writing past
// the last column (a bare values.update past the grid edge fails with "exceeds grid limits").
async function sheetGrid(sheets, title) {
  const m = await sheets.meta();
  const sh = (m.sheets || []).find((s) => s.properties && s.properties.title === title);
  if (!sh) return null;
  const gp = sh.properties.gridProperties || {};
  return { sheetId: sh.properties.sheetId, columnCount: gp.columnCount || 0, rowCount: gp.rowCount || 0 };
}

// Ensures a column exists on a tab; returns refreshed {headers, map}. Widens the sheet grid
// first if the new column would fall outside it (otherwise Sheets rejects the write).
async function ensureColumn(sheets, tab, headers, name) {
  const map = mapOf(headers);
  if (map[name]) return { headers, map };
  const col = headers.length + 1;
  try {
    const grid = await sheetGrid(sheets, tab);
    if (grid && grid.columnCount && col > grid.columnCount) {
      await sheets.appendColumns(grid.sheetId, col - grid.columnCount);
    }
  } catch (e) { /* best-effort widen; fall through to the write, which surfaces any real error */ }
  await sheets.update("'" + tab + "'!" + colLetter(col) + '1', [[name]]);
  const h2 = headers.concat([name]);
  return { headers: h2, map: mapOf(h2) };
}

async function findRate(sheets, group, sub, item) {
  const { rows } = await readObjects(sheets, RATE);
  const norm = (x) => (x || '');
  let m = rows.filter((r) => r['Group'] === group && norm(r['Sub-Variant']) === norm(sub) && r['Item'] === item)[0];
  if (!m) m = rows.filter((r) => r['Group'] === ADDON_SOURCE_GROUP && norm(r['Sub-Variant']) === '' && r['Item'] === item && ADDON_ITEM_NAMES.indexOf(item) !== -1)[0];
  if (!m) return null;
  return { item: m['Item'], chemCode: m['Chem Code'], appCost: num(m['Application Cost']), lineCost: num(m['Line Cost']), totalCost: num(m['Total Cost']) };
}

function maxIdNumber(rows, col, prefix) {
  let max = 0;
  rows.forEach((o) => { const v = String(o[col] || ''); if (v.indexOf(prefix) === 0) { const n = parseInt(v.slice(prefix.length), 10); if (!isNaN(n) && n > max) max = n; } });
  return max;
}
function fmtId(prefix, n) { return prefix + ('000000' + n).slice(-6); }

async function nextSkidId(sheets) {
  const { rows } = await readTab(sheets, MASTER);
  return fmtId('SKD-', maxIdNumber(rows, 'Skid ID', 'SKD-') + 1);
}

// Strip any remainder suffix back to the ORIGINAL ticket, so a remainder of a remainder is
// named off the base (e.g. 042426-207-LR1 -> base 042426-207), never stacked (…-R-R-R).
// Handles the legacy "-R"/"-R2" suffixes as well as the current "-LR#"/"-MR#".
function baseTicketOf(ticket) {
  let t = String(ticket || '').trim(), prev;
  do { prev = t; t = t.replace(/-(R\d*|LR\d+|MR\d+)$/, ''); } while (t !== prev);
  return t;
}
// Next free remainder ticket for a base + kind. kind 'LR' = litho partial, 'MR' = metals/production
// partial. Numbered per base+kind (LR1, LR2, … / MR1, MR2, …) and checked unique on the sheet.
async function findRemainderTicketId(masterRows, ticket, kind) {
  const base = baseTicketOf(ticket);
  const pre = kind === 'MR' ? 'MR' : 'LR';
  for (let i = 1; i <= 999; i++) {
    const cand = base + '-' + pre + i;
    if (!masterRows.some((o) => String(o['Ticket']).trim() === cand)) return cand;
  }
  throw new Error('Too many existing splits of ticket ' + base + '. Rename manually.');
}

// opId dedup via an "Op ID" column on Transactions (strongly consistent; catches the
// retry case where a first attempt succeeded but its response was lost).
async function opAlreadyDone(sheets, opId) {
  if (!opId) return false;
  const { rows, map } = await readTab(sheets, TRANSACTIONS);
  if (!map['Op ID']) return false;
  return rows.some((r) => String(r['Op ID'] || '').trim() === String(opId).trim());
}

async function appendTx(sheets, obj, opId) {
  let { headers } = await readTab(sheets, TRANSACTIONS);
  if (headers.indexOf('Op ID') === -1) { const e = await ensureColumn(sheets, TRANSACTIONS, headers, 'Op ID'); headers = e.headers; }
  if (headers.indexOf('Job ID') === -1) { const e = await ensureColumn(sheets, TRANSACTIONS, headers, 'Job ID'); headers = e.headers; }
  obj['Op ID'] = opId || '';
  await appendRowObj(sheets, TRANSACTIONS, headers, obj);
}
async function logCoatingTx(sheets, o, opId) {
  await appendTx(sheets, {
    'Timestamp': nowStamp(), 'Ticket': o.ticket, 'Pass Number': o.passNumber, 'Operator': o.operator || '',
    'Group': o.group || '', 'Sub-Variant': o.sub || '', 'Item': o.item, 'Chem Code': o.match.chemCode || '',
    'Application Cost': o.match.appCost, 'Line Cost': o.match.lineCost, 'Pass Total Cost': o.match.totalCost,
    'Running Total After Pass': o.runningTotal, 'Notes': o.notes || '', 'Job Name': o.jobName || '', 'Job ID': o.jobId || '', 'Skid ID': o.skidId || '',
  }, opId);
}
async function eventTx(sheets, o, opId) {
  await appendTx(sheets, {
    'Timestamp': o.timestamp || nowStamp(), 'Ticket': o.ticket, 'Pass Number': 0, 'Operator': o.operator || '',
    'Group': '', 'Sub-Variant': '', 'Item': o.itemText, 'Chem Code': '', 'Application Cost': 0, 'Line Cost': 0,
    'Pass Total Cost': 0, 'Running Total After Pass': o.runningTotal || 0, 'Notes': o.note || '', 'Job Name': '', 'Job ID': o.jobId || '', 'Skid ID': o.skidId || '',
  }, opId);
}

// Assigns Skid IDs / Status to freshly pasted intake rows.
async function normalizeMasterRows(sheets) {
  const { rows, map } = await readTab(sheets, MASTER);
  if (!map['Ticket'] || !map['Skid ID'] || !map['Status']) return;
  let nextN = maxIdNumber(rows, 'Skid ID', 'SKD-');
  for (const o of rows) {
    if (!String(o['Ticket']).trim()) continue;
    const fields = {};
    if (!String(o['Skid ID']).trim()) { nextN++; fields['Skid ID'] = fmtId('SKD-', nextN); }
    if (!String(o['Status']).trim()) { fields['Status'] = STATUS.CURRENT; fields['Last Updated At'] = nowStamp(); fields['Last Updated By'] = 'intake'; }
    if (Object.keys(fields).length) await stampCells(sheets, MASTER, o.__row, map, fields);
  }
}

async function ticketCardResult(sheets, skidId) { return getTicketCard(sheets, skidId); }

// ---- applyCoating: the core write (Current -> WIP/Pending, or add a coat to WIP/Pending) ----
async function applyCoating(sheets, skidId, group, sub, itemName, operatorName, notes, sheetsRun, isPartialSkid, lithoNote, jobName, opId, firstStatus, jobId, coatedTicket) {
  if (await opAlreadyDone(sheets, opId)) return { duplicate: true, skidId };
  if (!group || !itemName) throw new Error('Pick a size/group and coating item.');
  const match = await findRate(sheets, group, sub, itemName);
  if (!match) throw new Error('Could not find rate for item: ' + itemName);
  await normalizeMasterRows(sheets);

  const master = await readTab(sheets, MASTER);
  const map = master.map;
  if (!map['Litho']) throw new Error('Steel Tickets sheet has no Litho column.');
  const obj = master.rows.filter((o) => String(o['Skid ID']).trim() === String(skidId).trim())[0];
  if (!obj) throw new Error('Skid not found: ' + skidId);
  const row = obj.__row;
  const ticket = obj['Ticket'];
  const status = obj['Status'] || STATUS.CURRENT;
  const lithoNoteClean = String(lithoNote || '').trim();

  const hist = await getTransactionHistory(sheets, skidId, ticket);
  const nextPass = hist.length ? Math.max.apply(null, hist.map((h) => num(h.passNumber))) + 1 : 1;

  async function appendLithoNote(text) {
    if (!text || !map['Litho Notes']) return;
    const existing = obj['Litho Notes'] || '';
    await stampCells(sheets, MASTER, row, map, { 'Litho Notes': (existing ? existing + ' | ' : '') + text });
  }

  const result = { skidId, ticket, sheetsRun: null, estimatedWeightUsed: null, isPartial: false,
    remainderTicket: null, remainderSheets: 0, remainderWeight: 0, scrapSheets: 0, scrapWeight: 0 };

  // Another coat on a Pending/WIP skid: stack the cost on top of what it already has. When this
  // happens inside a job (jobId provided) — i.e. an already-coated WIP skid is added to a job for
  // another pass — also ATTACH it: move it into the job as Pending so it rides the normal
  // review/approve flow (approve -> WIP). Ad-hoc re-coats from the card pass no jobId and just add cost.
  if (status === STATUS.WIP || status === STATUS.PENDING) {
    const newTotal = Math.round(((num(obj['Litho'])) + match.totalCost) * 100) / 100;
    const stamp = { 'Litho': newTotal, 'Last Updated At': nowStamp(), 'Last Updated By': operatorName || '' };
    if (jobId) { stamp['Status'] = firstStatus || STATUS.PENDING; stamp['Job ID'] = jobId; stamp['Row'] = ''; }   // attached to a job -> leaving its storage row
    await stampCells(sheets, MASTER, row, map, stamp);
    await appendLithoNote(lithoNoteClean);
    await logCoatingTx(sheets, { skidId, ticket, passNumber: nextPass, operator: operatorName, group, sub, item: itemName, match, runningTotal: newTotal, notes, jobName, jobId: jobId || obj['Job ID'] || '' }, opId);
    result.litho = newTotal;
    result.detail = await ticketCardResult(sheets, skidId);
    return result;
  }
  if (status !== STATUS.CURRENT) throw new Error('Ticket ' + ticket + ' is "' + status + '" — coatings can only be logged while Current, Pending or WIP.');

  // First coating on a Current skid.
  const originalQty = num(obj['QTY/LOAD']);
  const originalWeight = num(obj['Weight']);
  const weightPerSheet = originalQty > 0 ? originalWeight / originalQty : 0;
  let sheets_ = (sheetsRun === undefined || sheetsRun === null || sheetsRun === '') ? originalQty : Number(sheetsRun);
  if (originalQty > 0) {
    if (isNaN(sheets_) || sheets_ <= 0) throw new Error('Enter a valid number of sheets run for ' + ticket + '.');
    if (sheets_ > originalQty) throw new Error('Sheets run (' + sheets_ + ') exceeds sheets available (' + originalQty + ') for ' + ticket + '.');
  } else { sheets_ = 0; }
  const usedFewer = originalQty > 0 && sheets_ < originalQty;
  isPartialSkid = usedFewer && !!isPartialSkid;
  const estimatedWeightUsed = weightPerSheet > 0 ? Math.round(sheets_ * weightPerSheet * 100) / 100 : originalWeight;

  // Partial-skid split (litho): the COATED portion becomes a new "-LR#" ticket and moves to WIP;
  // the leftover KEEPS the original ticket and stays in Current. The operator can name the -LR#
  // (coatedTicket) in the prompt; otherwise we auto-assign the next free suffix. This mirrors the
  // physical reality — the pallet still on the floor carries the original paper ticket, and each
  // coated batch is a new derived piece. baseTicketOf ties every piece back to the original.
  const base = baseTicketOf(ticket);
  let coatedTicketFinal = ticket;   // full skid / scrap: ticket is unchanged
  let leftoverTicket = null;
  if (usedFewer && isPartialSkid) {
    coatedTicketFinal = String(coatedTicket || '').trim() || await findRemainderTicketId(master.rows, ticket, 'LR');
    const pref = base + '-LR';
    const okName = coatedTicketFinal.indexOf(pref) === 0 && /^\d+$/.test(coatedTicketFinal.slice(pref.length));
    if (!okName) throw new Error('New ticket must look like ' + base + '-LR1 (the original number plus -LR and a number).');
    if (master.rows.some((o) => o !== obj && String(o['Ticket']).trim() === coatedTicketFinal)) {
      throw new Error('Ticket ' + coatedTicketFinal + ' is already in use — pick a different number.');
    }
    // Leftover keeps the bare original ticket, unless some other live row already holds it.
    const baseFree = !master.rows.some((o) => o !== obj && String(o['Ticket']).trim() === base);
    leftoverTicket = baseFree ? base : await findRemainderTicketId(master.rows.concat([{ 'Ticket': coatedTicketFinal }]), ticket, 'LR');
  }

  const stamp = { 'Status': firstStatus || STATUS.WIP, 'Job ID': jobId || '', 'Litho': match.totalCost, 'Row': '',   // coated -> moved out of its storage row
    'First Coated At': nowStamp(), 'First Coated By': operatorName || '', 'Last Updated At': nowStamp(), 'Last Updated By': operatorName || '' };
  if (usedFewer) { stamp['QTY/LOAD'] = sheets_; stamp['Weight'] = estimatedWeightUsed; }
  if (usedFewer && isPartialSkid) { stamp['Ticket'] = coatedTicketFinal; } // this record becomes the coated -LR# piece
  await stampCells(sheets, MASTER, row, map, stamp);

  let scrapNote = '';
  if (usedFewer && isPartialSkid) {
    result.remainderTicket = leftoverTicket;   // the ORIGINAL ticket, returned to Current
    result.coatedTicket = coatedTicketFinal;
    result.remainderSheets = originalQty - sheets_;
    result.remainderWeight = Math.round((originalWeight - estimatedWeightUsed) * 100) / 100;
    const remainderSkid = await nextSkidId(sheets);
    const ensSN = await ensureColumn(sheets, MASTER, master.headers, 'System Notes');
    master.headers = ensSN.headers; master.map = ensSN.map;
    const remObj = {};
    master.headers.forEach((h) => { if (obj.hasOwnProperty(h)) remObj[h] = obj[h]; });
    delete remObj.__row;
    Object.assign(remObj, {
      'Ticket': leftoverTicket, 'Skid ID': remainderSkid, 'Status': STATUS.CURRENT, 'Job ID': '', 'Split Of': skidId,
      'QTY/LOAD': result.remainderSheets, 'Weight': result.remainderWeight, 'Litho': '',
      'Comments': obj['Comments'] || '',                      // carry the human comment; system note goes to System Notes
      'System Notes': (obj['System Notes'] ? obj['System Notes'] + ' | ' : '') + 'Leftover of ' + base + ' after coating ' + sheets_ + ' of ' + originalQty + ' sheets (coated batch is ' + coatedTicketFinal + ') on ' + nowStamp().slice(0, 10),
      'First Coated At': '', 'First Coated By': '', 'Litho Notes': '', 'Last Updated At': nowStamp(), 'Last Updated By': operatorName || '',
    });
    await appendRowObj(sheets, MASTER, master.headers, remObj);
    await eventTx(sheets, { skidId: remainderSkid, ticket: leftoverTicket, itemText: 'SPLIT REMAINDER CREATED', operator: operatorName, note: result.remainderSheets + ' sheets (~' + result.remainderWeight + ' lbs, estimated) of ' + base + ' left in Current; coated ' + sheets_ + ' became ' + coatedTicketFinal, runningTotal: 0 }, '');
  } else if (usedFewer) {
    result.scrapSheets = originalQty - sheets_;
    result.scrapWeight = Math.round((originalWeight - estimatedWeightUsed) * 100) / 100;
    scrapNote = 'Scrapped ' + result.scrapSheets + ' sheets (~' + result.scrapWeight + ' lbs, estimated) of ' + originalQty + ' on hand';
    if (map['Spoilage']) await stampCells(sheets, MASTER, row, map, { 'Spoilage': num(obj['Spoilage']) + result.scrapSheets });
  }

  await appendLithoNote([lithoNoteClean, scrapNote].filter(Boolean).join(' | '));
  await logCoatingTx(sheets, { skidId, ticket: coatedTicketFinal, passNumber: nextPass, operator: operatorName, group, sub, item: itemName, match, runningTotal: match.totalCost, notes: [notes, scrapNote].filter(Boolean).join(' | '), jobName, jobId: jobId || '' }, opId);

  result.ticket = coatedTicketFinal;   // the coated piece now carries the -LR# ticket (obj kept its SKD)
  result.sheetsRun = sheets_;
  result.estimatedWeightUsed = estimatedWeightUsed;
  result.isPartial = isPartialSkid;
  result.litho = match.totalCost;
  result.detail = await ticketCardResult(sheets, skidId);
  return result;
}

// ---- createManualTicket: add a Current row with steel specs from the paper ticket ----
// ticket may be blank ("ticket not available" bypass); fields carries the steel specs.
async function createManualTicket(sheets, ticket, fields, operatorName, opId) {
  if (await opAlreadyDone(sheets, opId)) return { duplicate: true, ticket };
  ticket = String(ticket || '').trim();
  fields = fields || {};
  await normalizeMasterRows(sheets);
  let master = await readTab(sheets, MASTER);
  let headers = master.headers;
  for (const k of TICKET_DETAIL_COLS) { if (headers.indexOf(k) === -1) { const e = await ensureColumn(sheets, MASTER, headers, k); headers = e.headers; } }

  // A known ticket number that's already on the floor routes to the existing skid instead of
  // duplicating (Current -> open it; Pending -> it's tied up in a job). Bypassed tickets always
  // make a fresh skid.
  if (ticket) {
    for (const o of master.rows) {
      if (String(o['Ticket']).trim() !== ticket) continue;
      const st = o['Status'] || STATUS.CURRENT;
      if (st === STATUS.CURRENT) return getTicketCard(sheets, o['Skid ID']);
      if (st === STATUS.PENDING) throw new Error('Ticket ' + ticket + ' is already active (Pending in a job, skid ' + o['Skid ID'] + '). Open it from the list.');
      // WIP/other: fall through and create a fresh Current row.
    }
  }

  const skidId = await nextSkidId(sheets);
  const row = { 'Ticket': ticket, 'Skid ID': skidId, 'Status': STATUS.CURRENT, 'Last Updated At': nowStamp(), 'Last Updated By': operatorName || '' };
  TICKET_DETAIL_COLS.forEach((k) => { if (fields.hasOwnProperty(k) && String(fields[k]).trim() !== '') row[k] = fields[k]; });
  await appendRowObj(sheets, MASTER, headers, row);
  await eventTx(sheets, { skidId, ticket, itemText: 'MANUAL TICKET CREATED', operator: operatorName,
    note: ticket ? 'Ticket manually created in app' : 'Skid created without a ticket number (ticket not available)', runningTotal: 0 }, opId);
  return getTicketCard(sheets, skidId);
}

// yyyy-MM-dd from either a Google serial (Apps-Script-created dates) or a "yyyy-MM-dd ..."
// string (Worker-created timestamps).
function toYMD(v) {
  if (typeof v === 'number') return serialToYMD(v, TZ);
  const s = String(v || '');
  return s.length >= 10 ? s.slice(0, 10) : '';
}

function coatingSummary(coatings) {
  return (coatings || []).map((c) => c.item + (c.sub ? ' (' + c.sub + ')' : '')).join(' | ');
}
async function validateCoatings(sheets, coatings) {
  if (!coatings || !coatings.length) throw new Error('Add at least one coating to the job.');
  const { rows } = await readObjects(sheets, RATE);
  const norm = (x) => (x || '');
  coatings.forEach((c) => {
    if (!c || !c.group || !c.item) throw new Error('Each coating needs a size/group and a coating item.');
    const ok = rows.some((r) => r['Group'] === c.group && norm(r['Sub-Variant']) === norm(c.sub) && r['Item'] === c.item)
      || (ADDON_ITEM_NAMES.indexOf(c.item) !== -1 && rows.some((r) => r['Group'] === ADDON_SOURCE_GROUP && r['Item'] === c.item));
    if (!ok) throw new Error('No rate found for coating: ' + c.item);
  });
}

// ---- ticket-level edits ----
async function updateWipLithoCost(sheets, skidId, newCost, operator, notes, opId) {
  if (await opAlreadyDone(sheets, opId)) return { duplicate: true, skidId };
  await normalizeMasterRows(sheets);
  const master = await readTab(sheets, MASTER);
  if (!master.map['Litho']) throw new Error('Steel Tickets sheet has no Litho column.');
  const obj = master.rows.filter((o) => String(o['Skid ID']).trim() === String(skidId).trim())[0];
  if (!obj) throw new Error('Skid not found: ' + skidId);
  const oldCost = num(obj['Litho']);
  const n = Number(newCost);
  if (isNaN(n) || n < 0) throw new Error('Enter a valid non-negative cost.');
  await stampCells(sheets, MASTER, obj.__row, master.map, { 'Litho': n, 'Last Updated At': nowStamp(), 'Last Updated By': operator || '' });
  const hist = await getTransactionHistory(sheets, skidId, obj['Ticket']);
  const nextPass = hist.length ? Math.max.apply(null, hist.map((h) => num(h.passNumber))) + 1 : 1;
  await appendTx(sheets, { 'Timestamp': nowStamp(), 'Ticket': obj['Ticket'], 'Pass Number': nextPass, 'Operator': operator || '',
    'Group': '', 'Sub-Variant': '', 'Item': 'MANUAL COST ADJUSTMENT', 'Chem Code': '', 'Application Cost': 0, 'Line Cost': 0,
    'Pass Total Cost': Math.round((n - oldCost) * 100) / 100, 'Running Total After Pass': n,
    'Notes': 'Litho cost changed from ' + oldCost.toFixed(2) + ' to ' + n.toFixed(2) + (notes ? ' — ' + notes : ''), 'Job Name': '', 'Skid ID': skidId }, opId);
  return getTicketCard(sheets, skidId);
}

async function updateTicketDetails(sheets, skidId, fields, operator, opId) {
  if (await opAlreadyDone(sheets, opId)) return { duplicate: true, skidId };
  await normalizeMasterRows(sheets);
  fields = fields || {};
  const editable = TICKET_DETAIL_COLS.concat(['Row', 'Spoilage']);
  let master = await readTab(sheets, MASTER);
  let headers = master.headers;
  for (const k of editable) { if (fields.hasOwnProperty(k) && headers.indexOf(k) === -1) { const e = await ensureColumn(sheets, MASTER, headers, k); headers = e.headers; } }
  master = await readTab(sheets, MASTER);
  const obj = master.rows.filter((o) => String(o['Skid ID']).trim() === String(skidId).trim())[0];
  if (!obj) throw new Error('Skid not found: ' + skidId);

  const changes = {}, notes = [];
  for (const k of editable) {
    if (!fields.hasOwnProperty(k)) continue;
    const label = TICKET_COL_LABELS[k] || k;
    if (TICKET_NUMERIC_COLS[k]) {
      const raw = fields[k];
      if (raw === '' || raw == null) continue; // leave numeric fields untouched when blank
      const nv = Number(raw);
      if (isNaN(nv) || nv < 0) throw new Error(label + ' must be a non-negative number.');
      const ov = num(obj[k]);
      if (nv !== ov) { changes[k] = nv; notes.push(label + ' ' + ov + ' -> ' + nv); }
    } else {
      const nv = String(fields[k] == null ? '' : fields[k]).trim();
      const ov = String(obj[k] == null ? '' : obj[k]).trim();
      if (nv !== ov) { changes[k] = nv; notes.push(label + ' "' + ov + '" -> "' + nv + '"'); }
    }
  }
  if (!Object.keys(changes).length) return getTicketCard(sheets, skidId);
  changes['Last Updated At'] = nowStamp(); changes['Last Updated By'] = operator || '';
  await stampCells(sheets, MASTER, obj.__row, master.map, changes);
  await eventTx(sheets, { skidId, ticket: obj['Ticket'], itemText: 'TICKET DETAILS EDITED', operator, note: notes.join('; '), runningTotal: num(obj['Litho']) }, opId);
  return getTicketCard(sheets, skidId);
}

async function loadCoatingForEdit(sheets, skidId, passNumber) {
  await normalizeMasterRows(sheets);
  const master = await readTab(sheets, MASTER);
  const obj = master.rows.filter((o) => String(o['Skid ID']).trim() === String(skidId).trim())[0];
  if (!obj) throw new Error('Skid not found: ' + skidId);
  const history = await getTransactionHistory(sheets, skidId, obj['Ticket']);
  const active = activeCoatings(history);
  const target = active.filter((c) => String(c.passNumber) === String(passNumber))[0];
  if (!target) throw new Error('That coating is no longer on the ticket (it may have already been changed).');
  const nextPass = history.length ? Math.max.apply(null, history.map((h) => num(h.passNumber))) + 1 : 1;
  return { map: master.map, row: obj.__row, obj, target, nextPass };
}

async function editTicketCoating(sheets, skidId, passNumber, group, sub, item, operator, opId) {
  if (await opAlreadyDone(sheets, opId)) return { duplicate: true, skidId };
  if (!group || !item) throw new Error('Pick a size/group and coating item.');
  const match = await findRate(sheets, group, sub, item);
  if (!match) throw new Error('Could not find rate for item: ' + item);
  const ctx = await loadCoatingForEdit(sheets, skidId, passNumber);
  const oldCost = num(ctx.target.cost), newCost = num(match.totalCost);
  const currentLitho = num(ctx.obj['Litho']);
  const afterVoid = Math.round((currentLitho - oldCost) * 100) / 100;
  const afterNew = Math.round((afterVoid + newCost) * 100) / 100;
  const ticket = ctx.obj['Ticket'], jobId = ctx.obj['Job ID'] || '';
  await appendTx(sheets, { 'Timestamp': nowStamp(), 'Ticket': ticket, 'Pass Number': ctx.nextPass, 'Operator': operator || '',
    'Group': '', 'Sub-Variant': '', 'Item': 'COATING CHANGED (VOID)', 'Chem Code': '', 'Application Cost': 0, 'Line Cost': 0,
    'Pass Total Cost': -oldCost, 'Running Total After Pass': afterVoid,
    'Notes': 'VOID#' + passNumber + ': corrected ' + ctx.target.item + ' (' + oldCost.toFixed(2) + ') -> ' + item + ' (' + newCost.toFixed(2) + ')', 'Job Name': jobId, 'Job ID': jobId, 'Skid ID': skidId }, opId);
  await logCoatingTx(sheets, { skidId, ticket, passNumber: ctx.nextPass + 1, operator, group, sub, item, match, runningTotal: afterNew, notes: 'Correction of pass ' + passNumber, jobName: jobId, jobId }, '');
  await stampCells(sheets, MASTER, ctx.row, ctx.map, { 'Litho': afterNew, 'Last Updated At': nowStamp(), 'Last Updated By': operator || '' });
  return getTicketCard(sheets, skidId);
}

async function removeTicketCoating(sheets, skidId, passNumber, operator, opId) {
  if (await opAlreadyDone(sheets, opId)) return { duplicate: true, skidId };
  const ctx = await loadCoatingForEdit(sheets, skidId, passNumber);
  const oldCost = num(ctx.target.cost);
  const afterVoid = Math.round((num(ctx.obj['Litho']) - oldCost) * 100) / 100;
  await appendTx(sheets, { 'Timestamp': nowStamp(), 'Ticket': ctx.obj['Ticket'], 'Pass Number': ctx.nextPass, 'Operator': operator || '',
    'Group': '', 'Sub-Variant': '', 'Item': 'COATING REMOVED (VOID)', 'Chem Code': '', 'Application Cost': 0, 'Line Cost': 0,
    'Pass Total Cost': -oldCost, 'Running Total After Pass': afterVoid,
    'Notes': 'VOID#' + passNumber + ': removed ' + ctx.target.item + ' (' + oldCost.toFixed(2) + ')', 'Job Name': ctx.obj['Job ID'] || '', 'Job ID': ctx.obj['Job ID'] || '', 'Skid ID': skidId }, opId);
  await stampCells(sheets, MASTER, ctx.row, ctx.map, { 'Litho': afterVoid, 'Last Updated At': nowStamp(), 'Last Updated By': operator || '' });
  return getTicketCard(sheets, skidId);
}

// ---- jobs ----
async function createJob(sheets, description, operator, coatings, notes, opId) {
  const jobs0 = await readTab(sheets, JOBS);
  if (opId && jobs0.headers.indexOf('Op ID') !== -1 && jobs0.rows.some((r) => String(r['Op ID'] || '').trim() === String(opId).trim())) {
    return { duplicate: true };
  }
  await validateCoatings(sheets, coatings);
  const jobId = fmtId('JOB-', maxIdNumber(jobs0.rows, 'Job ID', 'JOB-') + 1);
  const ens = await ensureColumn(sheets, JOBS, jobs0.headers, 'Op ID');
  await appendRowObj(sheets, JOBS, ens.headers, {
    'Job ID': jobId, 'Created At': nowStamp(), 'Created By': operator || '', 'Description': description || '',
    'Coatings': coatingSummary(coatings), 'Coatings JSON': JSON.stringify(coatings), 'Ticket Count': 0, 'Status': 'Pending',
    'Notes': notes || '', 'Op ID': opId || '',
  });
  return { jobId, description: description || '', coatings, status: 'Pending' };
}

async function jobAddTicket(sheets, jobId, skidId, sheetsRun, isPartialSkid, lithoNote, operator, opId, coatedTicket) {
  await normalizeMasterRows(sheets);
  const jobs = await readTab(sheets, JOBS);
  const job = jobs.rows.filter((o) => String(o['Job ID']).trim() === String(jobId).trim())[0];
  if (!job) throw new Error('Job not found: ' + jobId);
  if (String(job['Status']) === 'Approved') throw new Error('Job ' + jobId + ' is approved and locked.');
  let recipe = []; try { recipe = JSON.parse(job['Coatings JSON'] || '[]') || []; } catch (e) { recipe = []; }
  if (!recipe.length) throw new Error('Job ' + jobId + ' has no coatings.');
  const desc = job['Description'];
  const master0 = await readTab(sheets, MASTER);
  const existing = master0.rows.filter((o) => String(o['Skid ID']).trim() === String(skidId).trim())[0];
  if (existing && String(existing['Job ID']).trim() === String(jobId).trim() && (existing['Status'] || STATUS.CURRENT) !== STATUS.CURRENT) {
    throw new Error('Ticket ' + (existing['Ticket'] || skidId) + ' is already on job ' + jobId + '.');
  }
  let result = null;
  for (let i = 0; i < recipe.length; i++) {
    const c = recipe[i];
    const r = await applyCoating(sheets, skidId, c.group, c.sub, c.item, operator, '',
      i === 0 ? sheetsRun : '', i === 0 ? isPartialSkid : false, i === 0 ? lithoNote : '',
      desc, i === 0 ? opId : '', STATUS.PENDING, jobId, i === 0 ? coatedTicket : '');
    if (i === 0) { if (r && r.duplicate) return { duplicate: true, skidId }; result = r; }
    else if (r && r.litho !== undefined) result.litho = r.litho;
  }
  const count = (await readTab(sheets, MASTER)).rows.filter((o) => String(o['Job ID']).trim() === String(jobId).trim()).length;
  await stampCells(sheets, JOBS, job.__row, jobs.map, { 'Ticket Count': count });
  result = result || { skidId };
  result.jobId = jobId;
  return result;
}

async function addCoatingToJob(sheets, jobId, coating, operator, opId) {
  if (await opAlreadyDone(sheets, opId)) return getJobDetail(sheets, jobId);
  await validateCoatings(sheets, [coating]);
  const jobs = await readTab(sheets, JOBS);
  const job = jobs.rows.filter((o) => String(o['Job ID']).trim() === String(jobId).trim())[0];
  if (!job) throw new Error('Job not found: ' + jobId);
  if (String(job['Status']) === 'Approved') throw new Error('Job is approved and locked.');
  let recipe = []; try { recipe = JSON.parse(job['Coatings JSON'] || '[]') || []; } catch (e) { recipe = []; }
  recipe.push({ group: coating.group, sub: coating.sub || '', item: coating.item });
  await stampCells(sheets, JOBS, job.__row, jobs.map, { 'Coatings JSON': JSON.stringify(recipe), 'Coatings': coatingSummary(recipe) });
  const desc = job['Description'];
  const pend = (await readTab(sheets, MASTER)).rows.filter((o) => String(o['Job ID']).trim() === String(jobId).trim() && (o['Status'] || '') === STATUS.PENDING);
  for (let i = 0; i < pend.length; i++) {
    await applyCoating(sheets, pend[i]['Skid ID'], coating.group, coating.sub, coating.item, operator, '', '', false, '', desc, i === 0 ? opId : '', STATUS.PENDING, jobId);
  }
  return getJobDetail(sheets, jobId);
}

async function reabsorbSplitRemainders(sheets, parentSkid, parentObj, master, operator) {
  if (!master.map['Split Of']) return;
  let addQty = 0, addWeight = 0;
  for (const o of master.rows) {
    if (String(o['Split Of']).trim() !== String(parentSkid).trim()) continue;
    if ((o['Status'] || STATUS.CURRENT) !== STATUS.CURRENT) continue;
    if (num(o['Litho']) > 0) continue;
    addQty += num(o['QTY/LOAD']); addWeight += num(o['Weight']);
    await stampCells(sheets, MASTER, o.__row, master.map, { 'Status': 'Void', 'QTY/LOAD': 0, 'Weight': 0, 'Last Updated At': nowStamp(), 'Last Updated By': operator || '' });
    await eventTx(sheets, { skidId: o['Skid ID'], ticket: o['Ticket'], itemText: 'SPLIT REABSORBED', operator, note: 'Remainder folded back into ' + parentSkid + ' when its ticket left the job', runningTotal: 0 }, '');
  }
  if (addQty || addWeight) {
    await stampCells(sheets, MASTER, parentObj.__row, master.map, {
      'QTY/LOAD': num(parentObj['QTY/LOAD']) + addQty,
      'Weight': Math.round((num(parentObj['Weight']) + addWeight) * 100) / 100,
    });
  }
}

async function removeTicketFromJob(sheets, jobId, skidId, operator, opId) {
  if (await opAlreadyDone(sheets, opId)) return getJobDetail(sheets, jobId);
  const jobs = await readTab(sheets, JOBS);
  const job = jobs.rows.filter((o) => String(o['Job ID']).trim() === String(jobId).trim())[0];
  if (!job) throw new Error('Job not found: ' + jobId);
  if (String(job['Status']) === 'Approved') throw new Error('Job is approved and locked.');
  const master = await readTab(sheets, MASTER);
  const obj = master.rows.filter((o) => String(o['Skid ID']).trim() === String(skidId).trim())[0];
  if (!obj) throw new Error('Skid not found: ' + skidId);
  if (String(obj['Job ID']).trim() !== String(jobId).trim()) throw new Error('Skid is not part of this job.');
  const litho = num(obj['Litho']);
  await stampCells(sheets, MASTER, obj.__row, master.map, { 'Status': STATUS.CURRENT, 'Job ID': '', 'Litho': '',
    'First Coated At': '', 'First Coated By': '', 'Last Updated At': nowStamp(), 'Last Updated By': operator || '' });
  const hist = await getTransactionHistory(sheets, skidId, obj['Ticket']);
  const nextPass = hist.length ? Math.max.apply(null, hist.map((h) => num(h.passNumber))) + 1 : 1;
  await appendTx(sheets, { 'Timestamp': nowStamp(), 'Ticket': obj['Ticket'], 'Pass Number': nextPass, 'Operator': operator || '',
    'Group': '', 'Sub-Variant': '', 'Item': 'REMOVED FROM JOB (VOID)', 'Chem Code': '', 'Application Cost': 0, 'Line Cost': 0,
    'Pass Total Cost': -litho, 'Running Total After Pass': 0, 'Notes': 'Removed from job ' + jobId + ' before approval; pending coatings voided', 'Job Name': '', 'Skid ID': skidId }, opId);
  await reabsorbSplitRemainders(sheets, skidId, obj, master, operator);
  const count = (await readTab(sheets, MASTER)).rows.filter((o) => String(o['Job ID']).trim() === String(jobId).trim()).length;
  await stampCells(sheets, JOBS, job.__row, jobs.map, { 'Ticket Count': count });
  return getJobDetail(sheets, jobId);
}

async function approveJob(sheets, jobId, operator) {
  // No opId guard: approval is idempotent (already-WIP skipped, Approved job returns early),
  // so a retry after a partial run just finishes the rest.
  const jobs = await readTab(sheets, JOBS);
  const job = jobs.rows.filter((o) => String(o['Job ID']).trim() === String(jobId).trim())[0];
  if (!job) throw new Error('Job not found: ' + jobId);
  if (String(job['Status']) === 'Approved') return getJobDetail(sheets, jobId);
  const master = await readTab(sheets, MASTER);
  for (const o of master.rows) {
    if (String(o['Job ID']).trim() !== String(jobId).trim()) continue;
    if ((o['Status'] || '') !== STATUS.PENDING) continue;
    await stampCells(sheets, MASTER, o.__row, master.map, { 'Status': STATUS.WIP, 'Approved At': nowStamp(), 'Approved By': operator || '', 'Last Updated At': nowStamp(), 'Last Updated By': operator || '' });
    await eventTx(sheets, { skidId: o['Skid ID'], ticket: o['Ticket'], itemText: 'JOB APPROVED', operator, note: 'Approved in job ' + jobId + ' — moved to WIP', jobId: jobId, runningTotal: num(o['Litho']) }, '');
  }
  await stampCells(sheets, JOBS, job.__row, jobs.map, { 'Status': 'Approved', 'Approved At': nowStamp(), 'Approved By': operator || '' });
  return getJobDetail(sheets, jobId);
}

// Delete a job created by mistake. Only unapproved jobs with NO tickets can be deleted — an
// approved job's tickets are already in WIP (can't be undone here), and a job still holding
// tickets must have them removed first (each returns to Current). Naturally idempotent: a
// retry after the row is gone just reports it already deleted.
async function deleteJob(sheets, jobId, operator, opId) {
  const jobs = await readTab(sheets, JOBS);
  const job = jobs.rows.filter((o) => String(o['Job ID']).trim() === String(jobId).trim())[0];
  if (!job) return { ok: true, jobId, alreadyGone: true };
  if (String(job['Status']).trim() === 'Approved') {
    throw new Error('Job ' + jobId + ' is approved — its tickets are already in WIP and cannot be deleted here.');
  }
  const master = await readTab(sheets, MASTER);
  const onJob = master.rows.filter((o) => String(o['Job ID']).trim() === String(jobId).trim());
  if (onJob.length) {
    throw new Error('Job ' + jobId + ' still has ' + onJob.length + ' ticket(s). Remove them first (each returns to Current), then delete the job.');
  }
  const grid = await sheetGrid(sheets, JOBS);
  if (!grid) throw new Error('Could not locate the Litho Jobs tab.');
  await sheets.deleteRows(grid.sheetId, job.__row - 1, job.__row);   // job.__row is 1-based; deleteRows is 0-based half-open
  return { ok: true, jobId, description: job['Description'] || '' };
}

// ================= PRODUCTION ======================================================
// Tracks which steel skid is used on which machine and when. A "run" (Production Runs tab,
// mirrors Litho Jobs) is one Line/Press; skids are loaded onto it (Status -> In Production,
// Loaded On stamped), the run is submitted for review, then Finish Work marks the skids Used
// (with partial-usage split) and stamps Finished On. Dates only — no times. Reuses the same
// readTab/stampCells/ensureColumn/appendRowObj/opAlreadyDone/fmtId/eventTx scaffolding.

// Creates the tab with headers if it doesn't exist yet (first run ever).
async function ensureTab(sheets, title, headers) {
  let vals = null;
  try { vals = await sheets.read(title); } catch (e) { vals = null; }
  if (vals === null) {
    await sheets.addSheet(title);
    await sheets.update("'" + title + "'!A1", [headers]);
    return;
  }
  if (!vals.length) await sheets.update("'" + title + "'!A1", [headers]);
}

async function runDetailSkids(masterRows, runId) {
  return masterRows.filter((o) => String(o['Run ID']).trim() === String(runId).trim()).map((o) => ({
    skidId: o['Skid ID'], ticket: o['Ticket'], status: o['Status'] || '', loadedOn: toYMD(o['Loaded On']),
    finishedOn: toYMD(usedAt(o)), qty: num(o['QTY/LOAD']), weight: num(o['Weight']),
    bw: o['BW'], type: o['TC'], temper: o['TM'], endUse: o['End Use'], width: o['Width'], length: o['Length'],
    litho: num(o['Litho']), notes: o['Litho Notes'] || '',
  }));
}

async function getProductionRuns(sheets, dateStr, scope) {
  let rows;
  try { rows = (await readObjects(sheets, PRODUCTION, true)).rows; } catch (e) { return []; }
  const target = dateStr || todayYMD();
  return rows.filter((o) => o['Run ID']).filter((o) => {
    const st = o['Status'] || 'Open';
    if (scope === 'open') return st === 'Open';                                   // open runs always visible (ignore date)
    if (scope === 'submitted') return st === 'Submitted' && toYMD(o['Created On']) === target;
    if (scope === 'finished') return st === 'Finished' && toYMD(o['Created On']) === target;
    return toYMD(o['Created On']) === target;
  }).map((o) => ({
    runId: o['Run ID'], createdOn: toYMD(o['Created On']), operator: o['Operator'], machine: o['Machine'],
    status: o['Status'] || 'Open', skidCount: o['Skid Count'], notes: o['Notes'],
    submittedOn: o['Submitted On'] ? toYMD(o['Submitted On']) : '', finishedOn: o['Finished On'] ? toYMD(o['Finished On']) : '',
  }));
}

async function getRunDetail(sheets, runId) {
  const runs = await readObjects(sheets, PRODUCTION, true);
  const run = runs.rows.filter((o) => String(o['Run ID']).trim() === String(runId).trim())[0];
  if (!run) throw new Error('Run not found: ' + runId);
  const master = await readObjects(sheets, MASTER);
  const skids = await runDetailSkids(master.rows, runId);
  return { runId: run['Run ID'], createdOn: toYMD(run['Created On']), operator: run['Operator'], machine: run['Machine'],
    status: run['Status'] || 'Open', notes: run['Notes'],
    submittedOn: run['Submitted On'] ? toYMD(run['Submitted On']) : '', finishedOn: run['Finished On'] ? toYMD(run['Finished On']) : '',
    skidCount: skids.length, skids };
}

async function createRun(sheets, machine, operator, notes, opId) {
  machine = String(machine || '').trim();
  if (!machine) throw new Error('Pick a Line or Press and enter its number.');
  await ensureTab(sheets, PRODUCTION, PRODUCTION_HEADERS);
  const runs0 = await readTab(sheets, PRODUCTION);
  if (opId && runs0.headers.indexOf('Op ID') !== -1) {
    const ex = runs0.rows.filter((r) => String(r['Op ID'] || '').trim() === String(opId).trim())[0];
    if (ex) return { duplicate: true, runId: ex['Run ID'], machine: ex['Machine'], operator: ex['Operator'], status: ex['Status'] || 'Open' };
  }
  const runId = fmtId('RUN-', maxIdNumber(runs0.rows, 'Run ID', 'RUN-') + 1);
  const ens = await ensureColumn(sheets, PRODUCTION, runs0.headers, 'Op ID');
  await appendRowObj(sheets, PRODUCTION, ens.headers, {
    'Run ID': runId, 'Created On': todayYMD(), 'Operator': operator || '', 'Machine': machine,
    'Status': 'Open', 'Skid Count': 0, 'Notes': notes || '', 'Submitted On': '', 'Finished On': '', 'Op ID': opId || '',
  });
  return { runId, machine, operator: operator || '', status: 'Open' };
}

async function recountRun(sheets, runId, runRow, runsMap) {
  const count = (await readTab(sheets, MASTER)).rows.filter((o) => String(o['Run ID']).trim() === String(runId).trim()).length;
  await stampCells(sheets, PRODUCTION, runRow, runsMap, { 'Skid Count': count });
  return count;
}

async function runAddSkid(sheets, runId, skidId, operator, opId) {
  if (await opAlreadyDone(sheets, opId)) return { duplicate: true, skidId, runId };
  await normalizeMasterRows(sheets);
  const runs = await readTab(sheets, PRODUCTION);
  const run = runs.rows.filter((o) => String(o['Run ID']).trim() === String(runId).trim())[0];
  if (!run) throw new Error('Run not found: ' + runId);
  if (String(run['Status']) === 'Finished') throw new Error('Run ' + runId + ' is finished and locked.');
  let master = await readTab(sheets, MASTER);
  let ens = await ensureColumn(sheets, MASTER, master.headers, 'Run ID');
  ens = await ensureColumn(sheets, MASTER, ens.headers, 'Loaded On');
  master = await readTab(sheets, MASTER);
  const obj = master.rows.filter((o) => String(o['Skid ID']).trim() === String(skidId).trim())[0];
  if (!obj) throw new Error('Skid not found: ' + skidId);
  const st = obj['Status'] || STATUS.CURRENT;
  if (st === STATUS.USED) throw new Error('Skid ' + (obj['Ticket'] || skidId) + ' is already marked Used.');
  const onRun = String(obj['Run ID'] || '').trim();
  if (onRun) {
    if (onRun === String(runId).trim()) throw new Error('Skid ' + (obj['Ticket'] || skidId) + ' is already on this run.');
    throw new Error('Skid ' + (obj['Ticket'] || skidId) + ' is already on run ' + onRun + '.');
  }
  await stampCells(sheets, MASTER, obj.__row, master.map, {
    'Status': STATUS.IN_PRODUCTION, 'Run ID': runId, 'Loaded On': todayYMD(), 'Row': '',   // loaded onto a run -> off its storage row
    'Last Updated At': nowStamp(), 'Last Updated By': operator || '' });
  await eventTx(sheets, { skidId, ticket: obj['Ticket'], itemText: 'ADDED TO PRODUCTION', operator,
    note: 'Loaded on ' + (run['Machine'] || '') + ' (run ' + runId + ')', runningTotal: num(obj['Litho']) }, opId);
  await recountRun(sheets, runId, run.__row, runs.map);
  return { runId, skidId, ticket: obj['Ticket'], status: STATUS.IN_PRODUCTION, loadedOn: todayYMD(),
    qty: num(obj['QTY/LOAD']), bw: obj['BW'], type: obj['TC'], temper: obj['TM'], endUse: obj['End Use'] };
}

async function runRemoveSkid(sheets, runId, skidId, operator, opId) {
  if (await opAlreadyDone(sheets, opId)) return getRunDetail(sheets, runId);
  const runs = await readTab(sheets, PRODUCTION);
  const run = runs.rows.filter((o) => String(o['Run ID']).trim() === String(runId).trim())[0];
  if (!run) throw new Error('Run not found: ' + runId);
  if (String(run['Status']) === 'Finished') throw new Error('Run ' + runId + ' is finished and locked.');
  const master = await readTab(sheets, MASTER);
  const obj = master.rows.filter((o) => String(o['Skid ID']).trim() === String(skidId).trim())[0];
  if (!obj) throw new Error('Skid not found: ' + skidId);
  if (String(obj['Run ID']).trim() !== String(runId).trim()) throw new Error('Skid is not on this run.');
  const restore = num(obj['Litho']) > 0 ? STATUS.WIP : STATUS.CURRENT;   // coated skids return to WIP, raw ones to Current
  await stampCells(sheets, MASTER, obj.__row, master.map, {
    'Status': restore, 'Run ID': '', 'Loaded On': '', 'Last Updated At': nowStamp(), 'Last Updated By': operator || '' });
  await eventTx(sheets, { skidId, ticket: obj['Ticket'], itemText: 'REMOVED FROM PRODUCTION', operator,
    note: 'Removed from run ' + runId + ' (back to ' + restore + ')', runningTotal: num(obj['Litho']) }, opId);
  await recountRun(sheets, runId, run.__row, runs.map);
  return getRunDetail(sheets, runId);
}

async function updateRun(sheets, runId, fields, operator, opId) {
  const runs = await readTab(sheets, PRODUCTION);
  const run = runs.rows.filter((o) => String(o['Run ID']).trim() === String(runId).trim())[0];
  if (!run) throw new Error('Run not found: ' + runId);
  if (String(run['Status']) === 'Finished') throw new Error('Run ' + runId + ' is finished and locked.');
  fields = fields || {};
  const changes = {};
  if (fields.hasOwnProperty('Operator')) changes['Operator'] = String(fields.Operator || '').trim();
  if (fields.hasOwnProperty('Machine')) { const m = String(fields.Machine || '').trim(); if (!m) throw new Error('Machine cannot be blank.'); changes['Machine'] = m; }
  if (fields.hasOwnProperty('Notes')) changes['Notes'] = String(fields.Notes || '');
  if (Object.keys(changes).length) await stampCells(sheets, PRODUCTION, run.__row, runs.map, changes);
  return getRunDetail(sheets, runId);
}

async function updateRunSkid(sheets, runId, skidId, fields, operator, opId) {
  if (await opAlreadyDone(sheets, opId)) return getRunDetail(sheets, runId);
  let master = await readTab(sheets, MASTER);
  const ens = await ensureColumn(sheets, MASTER, master.headers, 'Litho Notes');
  master = await readTab(sheets, MASTER);
  const obj = master.rows.filter((o) => String(o['Skid ID']).trim() === String(skidId).trim())[0];
  if (!obj) throw new Error('Skid not found: ' + skidId);
  if (String(obj['Run ID']).trim() !== String(runId).trim()) throw new Error('Skid is not on this run.');
  const note = String((fields || {}).notes || '').trim();
  if (note) {
    const existing = obj['Litho Notes'] || '';
    await stampCells(sheets, MASTER, obj.__row, master.map, {
      'Litho Notes': (existing ? existing + ' | ' : '') + note, 'Last Updated At': nowStamp(), 'Last Updated By': operator || '' });
    await eventTx(sheets, { skidId, ticket: obj['Ticket'], itemText: 'PRODUCTION NOTE', operator, note, runningTotal: num(obj['Litho']) }, opId);
  }
  return getRunDetail(sheets, runId);
}

async function swapRunSkid(sheets, runId, oldSkidId, newSkidId, operator, opId) {
  if (await opAlreadyDone(sheets, opId)) return getRunDetail(sheets, runId);
  const master = await readTab(sheets, MASTER);
  const oldObj = master.rows.filter((o) => String(o['Skid ID']).trim() === String(oldSkidId).trim())[0];
  if (oldObj && String(oldObj['Run ID']).trim() === String(runId).trim()) {
    await runRemoveSkid(sheets, runId, oldSkidId, operator, '');
  }
  await runAddSkid(sheets, runId, newSkidId, operator, opId);   // carries opId so a retry dedups on the add
  return getRunDetail(sheets, runId);
}

async function submitRun(sheets, runId, operator, opId) {
  const runs = await readTab(sheets, PRODUCTION);
  const run = runs.rows.filter((o) => String(o['Run ID']).trim() === String(runId).trim())[0];
  if (!run) throw new Error('Run not found: ' + runId);
  if (String(run['Status']) === 'Finished') throw new Error('Run ' + runId + ' is already finished.');
  if (String(run['Status']) === 'Submitted') return { runId, status: 'Submitted' };
  const count = (await readTab(sheets, MASTER)).rows.filter((o) => String(o['Run ID']).trim() === String(runId).trim()).length;
  if (!count) throw new Error('Add at least one skid before submitting run ' + runId + '.');
  await stampCells(sheets, PRODUCTION, run.__row, runs.map, { 'Status': 'Submitted', 'Submitted On': todayYMD(), 'Skid Count': count });
  return { runId, status: 'Submitted' };
}

// Splits a skid: keep `keepSheets` on the given row (qty/weight reduced) and spin the leftover
// off as a fresh available skid back in inventory (Current if raw, WIP if coated). Reused by
// Finish Work and the submit-time partial entry. `master` must be a live readTab result; the
// new row is pushed onto master.rows so repeated splits pick unique remainder tickets and Skid IDs.
async function splitSkidRemainder(sheets, master, obj, keepSheets, operator, context) {
  const skidId = obj['Skid ID'];
  const ticket = obj['Ticket'];
  const base = baseTicketOf(ticket);
  const onHand = num(obj['QTY/LOAD']);
  const totalWeight = num(obj['Weight']);
  const weightPerSheet = onHand > 0 ? totalWeight / onHand : 0;
  const keepWeight = weightPerSheet > 0 ? Math.round(keepSheets * weightPerSheet * 100) / 100 : totalWeight;
  const remQty = onHand - keepSheets;
  const remWeight = Math.round((totalWeight - keepWeight) * 100) / 100;
  // No suffix on the consumed portion. The SKD number is the real primary key, and Run ID +
  // Finished On already record exactly which skid ran which day — so the piece that ran keeps its
  // original ticket, and the leftover returning to inventory (a distinct new SKD) also carries the
  // original ticket. Both trace back through the shared base ticket and the Split Of link. This is
  // intentionally different from litho's -LR#: a ran metals skid is terminal (it goes to Used and
  // drops out of every active picker), so there's no active duplicate to disambiguate.
  const remSkid = await nextSkidId(sheets);
  const ensSN = await ensureColumn(sheets, MASTER, master.headers, 'System Notes');
  master.headers = ensSN.headers; master.map = ensSN.map;
  const remObj = {};
  master.headers.forEach((h) => { if (obj.hasOwnProperty(h)) remObj[h] = obj[h]; });
  delete remObj.__row;
  Object.assign(remObj, {
    'Ticket': base, 'Skid ID': remSkid, 'Status': (num(obj['Litho']) > 0 ? STATUS.WIP : STATUS.CURRENT),
    'Run ID': '', 'Loaded On': '', 'Finished On': '', 'Used At': '', 'Used By': '', 'Split Of': skidId,
    'QTY/LOAD': remQty, 'Weight': remWeight, 'Counted At': '', 'Counted By': '',
    'Comments': obj['Comments'] || '',                        // carry the human comment; system note goes to System Notes
    'System Notes': (obj['System Notes'] ? obj['System Notes'] + ' | ' : '') + 'Leftover of ' + base + ' (' + context + ') on ' + todayYMD(),
    'Last Updated At': nowStamp(), 'Last Updated By': operator || '',
  });
  await appendRowObj(sheets, MASTER, master.headers, remObj);
  master.rows.push(remObj);
  await eventTx(sheets, { skidId: remSkid, ticket: base, itemText: 'PRODUCTION SPLIT REMAINDER', operator,
    note: remQty + ' sheets (~' + remWeight + ' lbs, estimated) of ' + base + ' returned to inventory (' + context + ')', runningTotal: 0 }, '');
  // The consumed skid keeps its ticket; just shrink it to what actually ran.
  await stampCells(sheets, MASTER, obj.__row, master.map, { 'QTY/LOAD': keepSheets, 'Weight': keepWeight });
  obj['QTY/LOAD'] = keepSheets; obj['Weight'] = keepWeight; // keep in-memory row consistent
  return { remSkid, remTicket: base, usedTicket: obj['Ticket'], remQty, remWeight };
}

// Submit-time partial: record that a still-in-production skid ran fewer sheets than on hand.
// Splits the leftover back to inventory now; the skid stays In Production with qty = ran, so
// Finish Work later marks exactly what ran as Used.
async function runSkidPartial(sheets, runId, skidId, sheetsRan, operator, opId) {
  if (await opAlreadyDone(sheets, opId)) return getRunDetail(sheets, runId);
  const runs = await readTab(sheets, PRODUCTION);
  const run = runs.rows.filter((o) => String(o['Run ID']).trim() === String(runId).trim())[0];
  if (!run) throw new Error('Run not found: ' + runId);
  if (String(run['Status']) === 'Finished') throw new Error('Run ' + runId + ' is finished and locked.');
  let master = await readTab(sheets, MASTER);
  const ens = await ensureColumn(sheets, MASTER, master.headers, 'Split Of');
  master = await readTab(sheets, MASTER);
  const obj = master.rows.filter((o) => String(o['Skid ID']).trim() === String(skidId).trim())[0];
  if (!obj) throw new Error('Skid not found: ' + skidId);
  if (String(obj['Run ID']).trim() !== String(runId).trim()) throw new Error('Skid is not on this run.');
  if ((obj['Status'] || '') !== STATUS.IN_PRODUCTION) throw new Error('Skid is not in production.');
  const onHand = num(obj['QTY/LOAD']);
  const ran = Number(sheetsRan);
  if (isNaN(ran) || ran <= 0) throw new Error('Enter how many sheets ran.');
  if (onHand > 0 && ran > onHand) throw new Error('Sheets ran (' + ran + ') exceeds on hand (' + onHand + ').');
  if (!(onHand > 0) || ran >= onHand) return getRunDetail(sheets, runId); // full skid — nothing to split
  await splitSkidRemainder(sheets, master, obj, ran, operator, 'partial run: ' + ran + ' of ' + onHand);
  await eventTx(sheets, { skidId, ticket: obj['Ticket'], itemText: 'PARTIAL RUN', operator,
    note: 'Ran ' + ran + ' of ' + onHand + ' sheets on ' + (run['Machine'] || '') + ' (run ' + runId + '); leftover returned to inventory', runningTotal: num(obj['Litho']) }, opId);
  return getRunDetail(sheets, runId);
}

// Finish Work: mark the run's In-Production skids Used, stamp Finished On. Partial support —
// usedMap = { skidId: sheetsUsed }; if used < on-hand, split the remainder off as a new
// available skid. Idempotent like approveJob.
async function finishRun(sheets, runId, usedMap, operator, opId) {
  const runs = await readTab(sheets, PRODUCTION);
  const run = runs.rows.filter((o) => String(o['Run ID']).trim() === String(runId).trim())[0];
  if (!run) throw new Error('Run not found: ' + runId);
  if (String(run['Status']) === 'Finished') return getRunDetail(sheets, runId);
  usedMap = usedMap || {};
  let master = await readTab(sheets, MASTER);
  let ens = await ensureColumn(sheets, MASTER, master.headers, 'Used At');
  ens = await ensureColumn(sheets, MASTER, ens.headers, 'Used By');
  ens = await ensureColumn(sheets, MASTER, ens.headers, 'Split Of');
  master = await readTab(sheets, MASTER);
  const onRun = master.rows.filter((o) => String(o['Run ID']).trim() === String(runId).trim() && (o['Status'] || '') === STATUS.IN_PRODUCTION);
  for (const obj of onRun) {
    const skidId = obj['Skid ID'];
    const ticket = obj['Ticket'];
    const onHand = num(obj['QTY/LOAD']);
    let used = usedMap[skidId];
    used = (used === undefined || used === null || used === '') ? onHand : Number(used);
    if (isNaN(used) || used < 0) used = onHand;
    if (onHand > 0 && used > onHand) used = onHand;
    const usedFewer = onHand > 0 && used < onHand;

    if (usedFewer) {
      await splitSkidRemainder(sheets, master, obj, used, operator, 'production: ' + used + ' of ' + onHand + ' used');
    }

    await stampCells(sheets, MASTER, obj.__row, master.map, {
      'Status': STATUS.USED, 'Used At': nowStamp(), 'Used By': operator || '',
      'Last Updated At': nowStamp(), 'Last Updated By': operator || '' });
    await eventTx(sheets, { skidId, ticket, itemText: 'USED IN PRODUCTION', operator,
      note: 'Used ' + used + (onHand ? ' of ' + onHand : '') + ' sheets on ' + (run['Machine'] || '') + ' (run ' + runId + ')', runningTotal: num(obj['Litho']) }, '');
  }
  await stampCells(sheets, PRODUCTION, run.__row, runs.map, { 'Status': 'Finished', 'Finished On': todayYMD() });
  return getRunDetail(sheets, runId);
}

// Quick "Used in Production" shortcut — flips a batch of skids straight to Used with today's date,
// WITHOUT a production run / slitter session. No operator or machine is recorded (by request); the
// only stamps are Status=Used, Used At=<date>, and Used Via='Direct' (the marker the report
// keys off so these show up in their own department-report section, separate from run completions
// and slitter sources). Already-Used or unknown skids are skipped, not errored, so one bad row in
// a batch never blocks the rest. opId-deduped like the other mutations.
// usedDate (YYYY-MM-DD) is the date the operator chose in the selector (defaults to today when blank
// or malformed). By request, this flow is date-only: the chosen date is the single source of truth —
// it lands in 'Used At' (and the audit entry) with NO wall-clock time recorded anywhere. (Runs write
// a full date+time into 'Used At'; this quick-mark deliberately writes date only.)
async function markUsedDirect(sheets, skidIds, usedDate, opId) {
  if (opId && await opAlreadyDone(sheets, opId)) return { ok: true, marked: 0, reused: 0, skipped: 0, duplicate: true, results: [] };
  const ids = (skidIds || []).map((s) => String(s).trim()).filter(Boolean);
  if (!ids.length) throw new Error('No skids to mark.');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(usedDate || '').trim()) ? String(usedDate).trim() : todayYMD();
  let master = await readTab(sheets, MASTER);
  let ens = await ensureColumn(sheets, MASTER, master.headers, 'Used At');
  ens = await ensureColumn(sheets, MASTER, ens.headers, 'Used Via');
  ens = await ensureColumn(sheets, MASTER, ens.headers, 'System Notes');   // re-uses are appended here
  master = await readTab(sheets, MASTER);
  const results = [];
  let opRecorded = false;
  for (const skidId of ids) {
    const obj = master.rows.filter((o) => String(o['Skid ID']).trim() === skidId)[0];
    if (!obj) { results.push({ skidId, ok: false, reason: 'not found' }); continue; }
    if (String(obj['Status']) === STATUS.USED) {
      // Re-use: some skids get used on more than one occasion. Rather than rework the row into a
      // second Used record (the report reads one row per skid), we log the extra use two ways —
      // append "Re-used <date>" to System Notes (NOT Comments, which is the human "who it's for"
      // field), and write a transaction-audit entry — then refresh 'Used At' to this latest date.
      const prior = String(obj['System Notes'] || '').trim();
      const merged = (prior ? prior + '; ' : '') + 'Re-used ' + date;
      await stampCells(sheets, MASTER, obj.__row, master.map, {
        'Used At': date, 'Used Via': 'Direct', 'System Notes': merged, 'Last Updated At': date });
      await eventTx(sheets, { skidId, ticket: obj['Ticket'], itemText: 'USED IN PRODUCTION AGAIN (DIRECT)',
        operator: '', note: 'Re-used in Production (direct) for ' + date, timestamp: date, runningTotal: num(obj['Litho']) }, opRecorded ? '' : (opId || ''));
      opRecorded = true;
      results.push({ skidId, ticket: obj['Ticket'], ok: true, reused: true });
      continue;
    }
    await stampCells(sheets, MASTER, obj.__row, master.map, {
      'Status': STATUS.USED, 'Used At': date, 'Used Via': 'Direct', 'Last Updated At': date });
    await eventTx(sheets, { skidId, ticket: obj['Ticket'], itemText: 'USED IN PRODUCTION (DIRECT)',
      operator: '', note: 'Marked Used in Production (direct) for ' + date, timestamp: date, runningTotal: num(obj['Litho']) }, opRecorded ? '' : (opId || ''));
    opRecorded = true;
    results.push({ skidId, ticket: obj['Ticket'], ok: true });
  }
  return { ok: true, marked: results.filter((r) => r.ok && !r.reused).length, reused: results.filter((r) => r.reused).length,
    skipped: results.filter((r) => !r.ok).length, usedDate: date, results };
}

// ================= COIL LINE (cut a received coil into child skids) ==================
// We receive steel COILS (C/S = 'C'). When one is cut, it's marked Used and each resulting skid
// becomes a brand-new Steel Tickets row that RETAINS every spec of the coil — Mill is the link back
// to it — EXCEPT: Ticket, Weight, QTY/LOAD (the operator-entered ones) and C/S, which flips to 'S'
// because a cut skid is a sheet, not a coil. The Ticket is MMDDYY-<line><NN>: the cut date, then a
// 3-char suffix whose first digit is the coil line (1 or 2) and last two are that line's running
// cut number for the day — e.g. 080126-101, 080126-102 on line 1; 080126-201 on line 2. Children
// start as Current stock with Split Of = the coil. Date-only, no operator. skids = [{ weight, qty }].
async function cutCoil(sheets, coilSkidId, cutDate, coilLine, skids, finish, opId) {
  if (opId && await opAlreadyDone(sheets, opId)) return { ok: true, duplicate: true, created: 0, tickets: [] };
  coilSkidId = String(coilSkidId || '').trim();
  if (!coilSkidId) throw new Error('Pick a coil to cut.');
  const list = (skids || []).map((s) => ({ weight: num(s && s.weight), qty: num(s && s.qty) }));
  if (!list.length) throw new Error('Add at least one cut skid.');
  const finished = finish === false ? false : true;        // false = more to cut later; keep the coil open
  const line = Math.max(1, parseInt(coilLine, 10) || 1);   // coil line number -> first digit of the suffix
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(cutDate || '').trim()) ? String(cutDate).trim() : todayYMD();
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const mmddyy = dm[2] + dm[3] + dm[1].slice(2);            // 2026-08-01 -> 080126
  const prefix = mmddyy + '-' + line;                      // 080126-1
  let master = await readTab(sheets, MASTER);
  let ens = await ensureColumn(sheets, MASTER, master.headers, 'Split Of');
  ens = await ensureColumn(sheets, MASTER, ens.headers, 'Used At');
  ens = await ensureColumn(sheets, MASTER, ens.headers, 'Used Via');
  ens = await ensureColumn(sheets, MASTER, ens.headers, 'System Notes');   // cut-from-coil note lands here, not Comments
  master = await readTab(sheets, MASTER);
  const coil = master.rows.filter((o) => String(o['Skid ID']).trim() === coilSkidId)[0];
  if (!coil) throw new Error('Coil not found: ' + coilSkidId);
  if (String(coil['Status']) === STATUS.USED) throw new Error('That coil is already marked Used.');
  const coilTicket = coil['Ticket'] || '';
  const coilMill = coil['Mill'] || '';
  // Next Skid ID and next running cut number for THIS date + line (existing MMDDYY-<line>NN tickets).
  let nextN = maxIdNumber(master.rows, 'Skid ID', 'SKD-');
  const seqRe = new RegExp('^' + prefix + '(\\d+)$');
  let seq = 0;
  master.rows.forEach((o) => { const m = seqRe.exec(String(o['Ticket'] || '').trim()); if (m) { const n = parseInt(m[1], 10); if (!isNaN(n) && n > seq) seq = n; } });
  // Columns that must NOT carry over to a fresh child (identity / lifecycle / the ones that change).
  const RESET = ['Row', 'Skid ID', 'Status', 'Ticket', 'Weight', 'QTY/LOAD', 'C/S', 'Coil/Sheet', 'Split Of', 'Comments', 'System Notes', 'Used At', 'Used By', 'Used Via',
    'Run ID', 'Loaded On', 'Finished On', 'Counted At', 'Counted By', 'First Coated At', 'First Coated By',
    'Approved At', 'Approved By', 'Missing At', 'Missing By', 'Job ID', 'Spoilage', 'Cut Type', 'Load #', 'Last Updated At', 'Last Updated By'];
  const hasCS = master.headers.indexOf('C/S') !== -1;
  // Place children by EXACT row via values.update at column A — NOT values.append. Google's append
  // runs its own "table" detection and, on this sheet, was drifting each new row further to the
  // right (a staircase: -103 aligned, -104 shifted right, -105 further still). Writing to
  // A<firstEmptyRow> pins every child to column A, header-aligned like every other row.
  let writeRow = master.rows.length + 2;                 // header is row 1, then N data rows -> first empty row
  try {
    const grid = await sheetGrid(sheets, MASTER);
    const need = writeRow + list.length - 1;             // last row we'll touch
    if (grid && grid.rowCount && need > grid.rowCount) await sheets.appendRows(grid.sheetId, need - grid.rowCount);
  } catch (e) { /* best-effort grow; the write below surfaces any real grid error */ }
  const tickets = [];
  for (const s of list) {
    nextN += 1; seq += 1;
    const skidId = fmtId('SKD-', nextN);
    const ticket = prefix + (seq < 10 ? '0' + seq : String(seq));   // MMDDYY-<line>NN (2-digit min)
    const row = {};
    master.headers.forEach((h) => { if (h && RESET.indexOf(h) === -1 && coil[h] != null && coil[h] !== '') row[h] = coil[h]; });   // retain every spec
    row['Skid ID'] = skidId;
    row['Ticket'] = ticket;
    row['Status'] = STATUS.CURRENT;
    row['Weight'] = s.weight || '';
    row['QTY/LOAD'] = s.qty || '';
    if (hasCS) row['C/S'] = 'S';                 // a cut skid is a sheet, not a coil
    row['Split Of'] = coilSkidId;
    row['Comments'] = coil['Comments'] || '';                 // carry the coil's human comment (who it's for)
    row['System Notes'] = 'Cut from coil ' + coilTicket + (coilMill ? ' [mill ' + coilMill + ']' : '') + ' on ' + date + ' (coil line ' + line + ')';
    row['Last Updated At'] = date; row['Last Updated By'] = 'coil line';
    // Header-aligned row written at an exact position (A<writeRow>), so it lands in the same columns
    // as every existing row — no append table-detection, no rightward drift.
    const rowArr = master.headers.map((h) => (row.hasOwnProperty(h) ? row[h] : ''));
    await sheets.update("'" + MASTER + "'!A" + writeRow, [rowArr]);
    writeRow += 1;
    tickets.push({ skidId, ticket, weight: s.weight, qty: s.qty });
  }
  // Only mark the coil Used when it's FINISHED. If there's more to cut later, leave it available
  // (Status untouched) so it can be selected again the next day and resume — the running tickets
  // just continue under that day's date. Either way, stamp when it was last touched.
  if (finished) {
    await stampCells(sheets, MASTER, coil.__row, master.map, {
      'Status': STATUS.USED, 'Used At': date, 'Used Via': 'Coil', 'Last Updated At': date });   // 'Coil' distinguishes it from the direct quick-mark
  } else {
    await stampCells(sheets, MASTER, coil.__row, master.map, { 'Last Updated At': date });
  }
  await eventTx(sheets, { skidId: coilSkidId, ticket: coilTicket,
    itemText: finished ? 'COIL CUT — USED' : 'COIL PARTIALLY CUT', operator: '',
    note: 'Cut on coil line ' + line + ' into ' + tickets.length + ' skid(s) on ' + date +
      (finished ? '' : ' — coil left open for more cutting') + ': ' + tickets.map((t) => t.ticket).join(', '),
    timestamp: date, runningTotal: 0 }, opId || '');
  return { ok: true, created: tickets.length, coilSkidId, coilTicket, coilLine: line, finished, usedDate: finished ? date : '', tickets };
}

// ================= DATABASE (raw table viewer / manual editor) ======================
// A guarded audit surface: view every column of a whitelisted tab and correct values BY COLUMN
// NAME, so edits stay aligned with how the app itself reads the sheet (the same last-occurrence
// resolution) even if the header row has stray duplicate columns. Only these tables are exposed —
// nothing else can be read or written through here.
const DB_TABLES = { steel: MASTER, tx: TRANSACTIONS };

// Return { tab, tableKey, headers, rows } for a whitelisted table. headers is de-duplicated to the
// first occurrence of each name (blank headers dropped), in sheet order; each row is a plain object
// keyed by header name plus __row (its sheet row number, used to target edits). Values are exactly
// what the app reads for that row. Fully-blank trailing rows are skipped.
async function getRawTable(sheets, tableKey) {
  const tab = DB_TABLES[String(tableKey || '')];
  if (!tab) throw new Error('Unknown table: ' + tableKey);
  const r = await readObjects(sheets, tab);
  const seen = {};
  const headers = [];
  r.headers.forEach((h) => { const n = String(h || '').trim(); if (n && !seen[n]) { seen[n] = true; headers.push(n); } });
  const rows = r.rows.map((o) => {
    const row = { __row: o.__row };
    headers.forEach((h) => { row[h] = (o[h] == null ? '' : o[h]); });
    return row;
  }).filter((row) => headers.some((h) => String(row[h]).trim() !== ''));
  return { tab, tableKey, headers, rows };
}

// Edit named cells on ONE row of a whitelisted table, targeted by its sheet row number. Only columns
// that exist on the tab are written (by name, last-occurrence — matching app reads). On Steel Tickets
// it also stamps Last Updated and logs a MANUAL EDIT audit line with old->new values so every manual
// correction is traceable. Returns the list of changes actually applied.
async function updateRawRow(sheets, tableKey, rowNum, fields, opId) {
  if (opId && await opAlreadyDone(sheets, opId)) return { ok: true, duplicate: true, updated: 0, changes: [] };
  const tab = DB_TABLES[String(tableKey || '')];
  if (!tab) throw new Error('Unknown table: ' + tableKey);
  rowNum = parseInt(rowNum, 10);
  if (!(rowNum > 1)) throw new Error('Bad row number.');
  fields = fields || {};
  const t = await readTab(sheets, tab);
  const cur = t.rows.filter((o) => o.__row === rowNum)[0];
  if (!cur) throw new Error('That row was not found — reload the table and try again.');
  const write = {};
  const changes = [];
  Object.keys(fields).forEach((k) => {
    if (!t.map[k]) return;                                   // ignore unknown columns
    const nv = fields[k] == null ? '' : fields[k];
    const ov = cur[k] == null ? '' : cur[k];
    if (String(nv) !== String(ov)) { write[k] = nv; changes.push(k + ': "' + ov + '" → "' + nv + '"'); }
  });
  if (!changes.length) return { ok: true, updated: 0, changes: [] };
  if (tab === MASTER && t.map['Last Updated At']) {
    write['Last Updated At'] = nowStamp();
    if (t.map['Last Updated By']) write['Last Updated By'] = 'database edit';
  }
  await stampCells(sheets, tab, rowNum, t.map, write);
  if (tab === MASTER) {
    await eventTx(sheets, { skidId: cur['Skid ID'] || '', ticket: cur['Ticket'] || '', itemText: 'MANUAL EDIT (DATABASE)',
      operator: '', note: changes.join('; '), runningTotal: num(cur['Litho']) }, opId || '');
  }
  return { ok: true, updated: changes.length, changes };
}

// ================= FRESH-START IMPORT (convert 'Current' + 'WIP' tabs) ===============
// The operator pastes their Access data into two staging tabs — 'Current' and 'WIP' — one per
// state. This wipes Steel Tickets + Transactions and rebuilds Steel Tickets from those tabs:
// every row becomes a CLEAN single-column Steel Tickets row (fresh SKD id, Status taken from which
// tab it came from), mapped BY COLUMN NAME so it tolerates whatever columns each tab actually has.
// Rows are written at exact positions (no append drift), and the header is rebuilt clean — so this
// also permanently escapes the duplicate-column / staircase mess. Repeatable: re-run it whenever the
// Access data is refreshed. Transactions is cleared too, so a reused SKD id can't inherit an
// old skid's history. opId-deduped like the other mutations.
const IMPORT_TABS = [['Current', STATUS.CURRENT], ['WIP', STATUS.WIP]];

// Lifecycle / bookkeeping columns the app writes over a skid's life. They aren't in the source tabs,
// but we pre-create them (blank) so the fresh Steel Tickets header is complete — the app never has to
// widen the sheet later and nothing reads as a "missing header". Names are exact (from the code that
// stamps them), so no phantom duplicates get created.
const IMPORT_LIFECYCLE_COLS = ['System Notes', 'Split Of', 'Cut Type', 'Load #', 'Run ID', 'Job ID', 'Litho', 'Litho Notes',
  'First Coated At', 'First Coated By', 'Used At', 'Used By', 'Used Via', 'Loaded On', 'Finished On',
  'Counted At', 'Counted By', 'Approved At', 'Approved By', 'Missing At', 'Missing By', 'Spoilage'];

// Deletes every data row on a tab (keeps row 1). Returns nothing.
async function clearTabData(sheets, tab) {
  const grid = await sheetGrid(sheets, tab);
  const t = await readTab(sheets, tab);
  const lastDataRow = t.rows.length + 1;                 // header is row 1; data rows follow
  if (grid && lastDataRow >= 2) await sheets.deleteRows(grid.sheetId, 1, lastDataRow);   // remove rows 2..lastDataRow
}

// Wipes a tab's data rows and overwrites row 1 with `header`, padding with blanks so any stray
// trailing (duplicate) header cells are erased — leaving a clean, single-column schema.
async function resetTabToHeader(sheets, tab, header) {
  const grid = await sheetGrid(sheets, tab);
  const t = await readTab(sheets, tab);
  const lastDataRow = t.rows.length + 1;
  if (grid && lastDataRow >= 2) await sheets.deleteRows(grid.sheetId, 1, lastDataRow);
  const width = Math.max(header.length, (grid && grid.columnCount) || 0, t.headers.length);
  const row1 = header.slice();
  while (row1.length < width) row1.push('');
  await sheets.update("'" + tab + "'!A1", [row1]);
}

async function importStaging(sheets, opId) {
  if (opId && await opAlreadyDone(sheets, opId)) return { ok: true, duplicate: true, current: 0, wip: 0, total: 0 };

  // 1) Read both staging tabs (each by its own headers). Only rows with a Ticket count.
  const parts = [];
  for (const [tabName, status] of IMPORT_TABS) {
    let data;
    try { data = await readObjects(sheets, tabName); }
    catch (e) { throw new Error('Could not read a "' + tabName + '" tab. Create tabs named Current and WIP and paste your data into them, then try again.'); }
    if (!data.headers.length || data.headers.indexOf('Ticket') === -1) {
      throw new Error('The "' + tabName + '" tab needs a header row with a "Ticket" column.');
    }
    const rows = data.rows.filter((o) => String(o['Ticket'] || '').trim() !== '');
    parts.push({ tabName, status, headers: data.headers, rows });
  }

  // 2) Clean Steel Tickets header: Ticket, Skid ID, Status, then every source column (union across
  //    tabs, in order), then the app's lifecycle columns (blank for now) and the bookkeeping columns.
  //    Built with a running "seen" set so nothing is duplicated. Source Skid ID/Status never carry.
  const header = [];
  const seen = {};
  const add = (name) => { const n = String(name || '').trim(); if (n && !seen[n]) { seen[n] = true; header.push(n); } };
  ['Ticket', 'Skid ID', 'Status'].forEach(add);
  parts.forEach((p) => p.headers.forEach(add));                 // every source column, in order
  IMPORT_LIFECYCLE_COLS.forEach(add);                           // app columns, pre-created blank
  ['Last Updated At', 'Last Updated By'].forEach(add);
  // Keep System Notes right next to Comments (Comments = human "who it's for"; System Notes = auto notes).
  const ci = header.indexOf('Comments'), si = header.indexOf('System Notes');
  if (ci !== -1 && si !== -1 && si !== ci + 1) { header.splice(si, 1); header.splice(header.indexOf('Comments') + 1, 0, 'System Notes'); }

  // 3) Reset Steel Tickets (clean header) + clear the audit log.
  const date = todayYMD();
  await resetTabToHeader(sheets, MASTER, header);
  await clearTabData(sheets, TRANSACTIONS);

  // 4) Make sure the grid has room, then write each converted row at an exact A<row>.
  const total = parts.reduce((n, p) => n + p.rows.length, 0);
  const grid = await sheetGrid(sheets, MASTER);
  if (grid) {
    if (grid.columnCount && header.length > grid.columnCount) await sheets.appendColumns(grid.sheetId, header.length - grid.columnCount);
    const needRows = 1 + total;
    if (grid.rowCount && needRows > grid.rowCount) await sheets.appendRows(grid.sheetId, needRows - grid.rowCount);
  }
  // Build EVERY row first, then write them in a few big batches — NOT one API call per row. A Cloudflare
  // Worker caps how many subrequests it can make per request, so a per-row write blows the cap on a real
  // import and stops partway (leaving the wiped sheet half-filled). One values.update per chunk is a
  // single subrequest regardless of how many rows it carries.
  const allRows = [];
  let n = 0;
  const counts = { Current: 0, WIP: 0 };
  for (const p of parts) {
    for (const o of p.rows) {
      n += 1;
      const rec = {};
      header.forEach((h) => { rec[h] = (o[h] == null ? '' : o[h]); });   // carry every source field by name
      rec['Ticket'] = o['Ticket'];
      rec['Skid ID'] = fmtId('SKD-', n);
      rec['Status'] = p.status;
      rec['Last Updated At'] = date;
      rec['Last Updated By'] = 'import';
      allRows.push(header.map((h) => (rec[h] == null ? '' : rec[h])));
      counts[p.tabName] = (counts[p.tabName] || 0) + 1;
    }
  }
  const CHUNK = 500;                                            // rows per write call (keeps payloads sane, subrequests few)
  for (let i = 0; i < allRows.length; i += CHUNK) {
    await sheets.update("'" + MASTER + "'!A" + (2 + i), allRows.slice(i, i + CHUNK));
  }
  // Log the import into the (freshly cleared) audit tab. This doubles as the opId dedup marker, so a
  // double-submit of the same import is caught instead of wiping and reloading twice.
  await eventTx(sheets, { skidId: '', ticket: '', itemText: 'FRESH IMPORT', operator: '',
    note: 'Imported ' + n + ' skids from staging (Current ' + (counts['Current'] || 0) + ', WIP ' + (counts['WIP'] || 0) + ')',
    timestamp: date, runningTotal: 0 }, opId || '');
  return { ok: true, current: counts['Current'] || 0, wip: counts['WIP'] || 0, total: n,
    firstSkid: n ? fmtId('SKD-', 1) : '', lastSkid: n ? fmtId('SKD-', n) : '', columns: header.length };
}

// ================= SLITTER / SCROLL (skid-at-a-time cutting) =========================
// A session ('Slitter Sessions', Kind = 'Slitter' | 'Scroll') groups the child pallets cut on one
// machine. One source skid is "loaded" (Active Skid) at a time and cut into the in-progress child
// pallet. When it runs out mid-pallet the operator switches to the next skid (that source flips to
// Used, and its piece count is closed onto the pallet's 'Pallet Coils'); when the pallet is full it
// becomes a runnable Steel Tickets skid (Status 'Cut') carrying the exact per-ticket strip split, so
// slit pallets run on the Metal Lines and scroll pallets on the Press. The still-running skid carries
// over to the next pallet. Source sheet counts are NOT tracked — only the child output (cut pieces:
// 'Body Blanks' on slitters, 'Strips' on scrolls).

function parseComposition(v) {
  try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}

async function getSlitterSessions(sheets, kind, dateStr, scope) {
  let rows;
  try { rows = (await readObjects(sheets, SLITTER_SESSIONS, true)).rows; } catch (e) { return []; }
  const target = dateStr || todayYMD();
  const wantKind = kind === 'Scroll' ? 'Scroll' : 'Slitter';
  return rows.filter((o) => o['Session ID']).filter((o) => (o['Kind'] || 'Slitter') === wantKind).filter((o) => {
    const st = o['Status'] || 'Open';
    if (scope === 'open') return st === 'Open';                                   // open sessions always visible
    if (scope === 'finished') return st === 'Finished' && toYMD(o['Created On']) === target;
    return toYMD(o['Created On']) === target;
  }).map((o) => ({
    sessionId: o['Session ID'], slitter: o['Slitter'], kind: o['Kind'] || 'Slitter', operator: o['Operator'], createdOn: toYMD(o['Created On']),
    status: o['Status'] || 'Open', palletCount: o['Pallet Count'], notes: o['Notes'],
  }));
}

async function slitterPalletsOf(sheets, sessionId) {
  let rows;
  try { rows = (await readObjects(sheets, SLITTER_PALLETS, true)).rows; } catch (e) { return []; }
  return rows.filter((o) => String(o['Session ID']).trim() === String(sessionId).trim()).map((o) => ({
    palletId: o['Pallet ID'], sessionId: o['Session ID'], createdOn: toYMD(o['Created On']),
    outputCount: num(o['Output Count']), composition: parseComposition(o['Composition']), skidId: o['Skid ID'] || '', loadNo: o['Load #'] || '', notes: o['Notes'] || '',
  }));
}

// The unit for cut pieces differs by machine: Slitter cuts "Body Blanks", Scroll cuts "Strips".
function cutUnit(kind) { return kind === 'Scroll' ? 'Strips' : 'Body Blanks'; }

async function getSlitterDetail(sheets, sessionId) {
  const sessions = await readObjects(sheets, SLITTER_SESSIONS, true);
  const s = sessions.rows.filter((o) => String(o['Session ID']).trim() === String(sessionId).trim())[0];
  if (!s) throw new Error('Slitter session not found: ' + sessionId);
  const pallets = await slitterPalletsOf(sheets, sessionId);
  const kind = s['Kind'] || 'Slitter';
  const coils = parseComposition(s['Pallet Coils']);                 // skids already closed onto the in-progress pallet
  const stripsSoFar = coils.reduce((a, c) => a + num(c.strips != null ? c.strips : c.qty), 0);
  return { sessionId: s['Session ID'], slitter: s['Slitter'], kind, unit: cutUnit(kind), operator: s['Operator'], createdOn: toYMD(s['Created On']),
    status: s['Status'] || 'Open', notes: s['Notes'], palletCount: pallets.length, pallets,
    activeSkid: s['Active Skid'] || '', activeTicket: s['Active Ticket'] || '', activeMill: s['Active Mill'] || '',
    palletCoils: coils, palletStripsSoFar: stripsSoFar };
}

async function createSlitterSession(sheets, kind, slitter, operator, notes, opId) {
  slitter = String(slitter || '').trim();
  kind = kind === 'Scroll' ? 'Scroll' : 'Slitter';
  if (!slitter) throw new Error('Pick a ' + kind + ' machine.');
  await ensureTab(sheets, SLITTER_SESSIONS, SLITTER_SESSION_HEADERS);
  let s0 = await readTab(sheets, SLITTER_SESSIONS);
  if (opId && s0.headers.indexOf('Op ID') !== -1) {
    const ex = s0.rows.filter((r) => String(r['Op ID'] || '').trim() === String(opId).trim())[0];
    if (ex) return { duplicate: true, sessionId: ex['Session ID'], slitter: ex['Slitter'], kind: ex['Kind'] || 'Slitter', operator: ex['Operator'], status: ex['Status'] || 'Open' };
  }
  const sessionId = fmtId('SLT-', maxIdNumber(s0.rows, 'Session ID', 'SLT-') + 1);
  let ens = await ensureColumn(sheets, SLITTER_SESSIONS, s0.headers, 'Kind');
  ens = await ensureColumn(sheets, SLITTER_SESSIONS, ens.headers, 'Active Skid');
  ens = await ensureColumn(sheets, SLITTER_SESSIONS, ens.headers, 'Active Ticket');
  ens = await ensureColumn(sheets, SLITTER_SESSIONS, ens.headers, 'Active Mill');
  ens = await ensureColumn(sheets, SLITTER_SESSIONS, ens.headers, 'Pallet Coils');
  ens = await ensureColumn(sheets, SLITTER_SESSIONS, ens.headers, 'Op ID');
  await appendRowObj(sheets, SLITTER_SESSIONS, ens.headers, {
    'Session ID': sessionId, 'Slitter': slitter, 'Kind': kind, 'Operator': operator || '', 'Created On': todayYMD(),
    'Status': 'Open', 'Pallet Count': 0, 'Active Skid': '', 'Active Ticket': '', 'Active Mill': '', 'Pallet Coils': '[]', 'Notes': notes || '', 'Op ID': opId || '',
  });
  return { sessionId, slitter, kind, operator: operator || '', status: 'Open' };
}

async function recountSlitter(sheets, sessionId) {
  const sessions = await readTab(sheets, SLITTER_SESSIONS);
  const s = sessions.rows.filter((o) => String(o['Session ID']).trim() === String(sessionId).trim())[0];
  if (!s) return 0;
  let count = 0;
  try { count = (await readObjects(sheets, SLITTER_PALLETS, true)).rows.filter((o) => String(o['Session ID']).trim() === String(sessionId).trim()).length; } catch (e) { count = 0; }
  await stampCells(sheets, SLITTER_SESSIONS, s.__row, sessions.map, { 'Pallet Count': count });
  return count;
}

// Cut/child pallets get a short, app-generated Load # (starts at 1001) that an operator can write
// on the physical pallet; it becomes the pallet's primary ticket number. Sequenced off the max
// existing load number so it never collides, independent of the SKD- / SLT- id spaces.
// Source of truth is the cut skid's Ticket (column A — always read cleanly and it IS the load
// number); the 'Load #' column is honored too but only as a secondary signal, since it can sit far
// to the right where a ragged header read might miss it.
function nextLoadNumber(rows) {
  let max = 1000;
  for (const o of rows) {
    if (!o) continue;
    // A cut pallet's numeric Ticket is its load number (old SLT-xxxxxx-P# ids are ignored here).
    if (o['Cut Type'] && /^\d+$/.test(String(o['Ticket'] || '').trim())) {
      const t = parseInt(String(o['Ticket']).trim(), 10);
      if (!isNaN(t) && t > max) max = t;
    }
    const v = parseInt(String(o['Load #'] || '').replace(/[^0-9]/g, ''), 10);
    if (!isNaN(v) && v > max) max = v;
  }
  return max + 1;
}

// Mint a runnable Steel Tickets skid for a cut pallet. Status 'Cut' keeps it out of the Litho /
// Count / Job screens (which only look at Current/WIP/Pending) while making it selectable in the
// metals run picker. Its Ticket IS the app-generated Load # — the primary, writable pallet number;
// the parent tickets/mills live in Mill + Comments and the full composition stays on the Slitter
// Pallets row. Cost and Litho are carried down as the simple average of the parent skids' values
// (two independent averages — never combined; blanks/zeros skipped). Weight is deferred. Returns
// { skidId, loadNo }.
async function createCutSkid(sheets, palletId, cutType, outputCount, comp, machine) {
  let master = await readTab(sheets, MASTER);
  let ens = await ensureColumn(sheets, MASTER, master.headers, 'Mill');
  ens = await ensureColumn(sheets, MASTER, ens.headers, 'Cut Type');
  ens = await ensureColumn(sheets, MASTER, ens.headers, 'Load #');
  ens = await ensureColumn(sheets, MASTER, ens.headers, 'Cost');
  ens = await ensureColumn(sheets, MASTER, ens.headers, 'Litho');
  ens = await ensureColumn(sheets, MASTER, ens.headers, 'System Notes');
  master = await readTab(sheets, MASTER);
  const skidId = fmtId('SKD-', maxIdNumber(master.rows, 'Skid ID', 'SKD-') + 1);
  const loadNo = nextLoadNumber(master.rows);
  // Gather every parent skid this pallet was cut from (for spec copy + cost/litho averaging).
  const parentRows = [];
  comp.forEach((c) => {
    if (!c || !c.skidId) return;
    const p = master.rows.filter((o) => String(o['Skid ID']).trim() === String(c.skidId).trim())[0];
    if (p) parentRows.push(p);
  });
  const src = parentRows[0] || null;                    // first parent seeds the steel specs
  // Simple average of a parent field across the parents that actually carry a value (>0).
  const avgOf = (field) => {
    const vals = [];
    parentRows.forEach((p) => { const v = num(p[field]); if (v > 0) vals.push(v); });
    if (!vals.length) return null;
    return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
  };
  const costAvg = avgOf('Cost');
  const lithoAvg = avgOf('Litho');
  const mills = comp.map((c) => String((c && c.mill) || '').trim()).filter(Boolean).filter((m, i, a) => a.indexOf(m) === i);
  const stripsOf = (c) => (c && c.strips != null ? c.strips : (c && c.qty) || 0);
  const parents = comp.map((c) => (c && c.ticket ? c.ticket : 'Mill ' + (c && c.mill)) + ' (' + stripsOf(c) + ')').join(', ');
  const row = {
    'Skid ID': skidId, 'Ticket': String(loadNo), 'Load #': loadNo, 'Status': STATUS.CUT, 'QTY/LOAD': num(outputCount),
    'Mill': mills.join(' / '), 'Cut Type': cutType,
    'System Notes': cutType + ' pallet (Load ' + loadNo + ') cut on ' + (machine || '') + ' from: ' + parents,
    'Last Updated At': nowStamp(), 'Last Updated By': 'cut',
  };
  if (costAvg != null) row['Cost'] = costAvg;            // averaged steel cost of the parents
  if (lithoAvg != null) row['Litho'] = lithoAvg;         // averaged litho cost of the parents (kept separate)
  if (src) {
    ['BW', 'TC', 'TM', 'Width', 'Length', 'End Use', 'Supplier', 'B/C', 'C/S'].forEach((k) => { if (src[k] != null && src[k] !== '') row[k] = src[k]; });
  }
  // Append the positional row, then STAMP the identity cells by column name onto the new row. The
  // positional append can misalign when the live header row reads back ragged (wider/narrower than
  // our copy) — that dropped the Load #/Ticket/Skid ID into the wrong column, so it read back blank
  // and every pallet came out 1001. Stamping by the column map guarantees these land correctly
  // regardless of the append's alignment.
  const rowArr = master.headers.map((h) => (row.hasOwnProperty(h) ? row[h] : ''));
  const res = await sheets.append(MASTER, rowArr);
  const updRange = res && res.updates && res.updates.updatedRange ? String(res.updates.updatedRange) : '';
  const rm = updRange.match(/(\d+)\s*$/);
  if (rm) await stampCells(sheets, MASTER, parseInt(rm[1], 10), master.map, row);   // stamp every field by column name
  return { skidId: skidId, loadNo: loadNo };
}

// Read a session row, making sure the in-progress-pallet state columns exist and the session is open.
async function readSlitterSession(sheets, sessionId) {
  await ensureTab(sheets, SLITTER_SESSIONS, SLITTER_SESSION_HEADERS);
  let t = await readTab(sheets, SLITTER_SESSIONS);
  let headers = t.headers;
  for (const c of ['Active Skid', 'Active Ticket', 'Active Mill', 'Pallet Coils']) {
    if (headers.indexOf(c) === -1) { const e = await ensureColumn(sheets, SLITTER_SESSIONS, headers, c); headers = e.headers; }
  }
  t = await readTab(sheets, SLITTER_SESSIONS);
  const s = t.rows.filter((o) => String(o['Session ID']).trim() === String(sessionId).trim())[0];
  if (!s) throw new Error('Slitter session not found: ' + sessionId);
  if (String(s['Status']) === 'Finished') throw new Error('Session ' + sessionId + ' is finished and locked.');
  return { tab: t, s };
}

// Look up a source skid's ticket + mill from the master, for loading it onto a session.
async function skidSourceInfo(sheets, skidId) {
  const { rows } = await readObjects(sheets, MASTER);
  const o = rows.filter((r) => String(r['Skid ID']).trim() === String(skidId).trim())[0];
  if (!o) throw new Error('Skid not found: ' + skidId);
  return { skidId: o['Skid ID'], ticket: o['Ticket'] || '', mill: o['Mill'] || '' };
}

// Flip a fully-cut source skid to Used. No sheet-count math — value tracking is deferred; we only
// record that the source has been entirely cut up into child pallets.
async function markSkidUsed(sheets, skidId, operator, note) {
  if (!skidId) return;
  const master = await readTab(sheets, MASTER);
  const o = master.rows.filter((r) => String(r['Skid ID']).trim() === String(skidId).trim())[0];
  if (!o || String(o['Status']) === STATUS.USED) return;
  let ens = await ensureColumn(sheets, MASTER, master.headers, 'Used By');
  ens = await ensureColumn(sheets, MASTER, ens.headers, 'Used At');
  // Slitter/Scroll sources are cut up, not "finished" like a line/press run — record date only.
  await stampCells(sheets, MASTER, o.__row, ens.map, {
    'Status': STATUS.USED, 'Used At': todayYMD(), 'Used By': operator || '',
    'Last Updated At': nowStamp(), 'Last Updated By': operator || '' });
  await eventTx(sheets, { skidId, ticket: o['Ticket'], itemText: 'FULLY CUT — SOURCE USED', operator, note: note || '' }, '');
}

// LOAD a source skid as the session's currently-running skid (the first skid of a pallet, or after
// one is emptied without a swap). Closes no strips; just sets the active skid.
async function slitterLoadSkid(sheets, sessionId, skidId, operator, opId) {
  const { tab, s } = await readSlitterSession(sheets, sessionId);
  const info = await skidSourceInfo(sheets, skidId);
  await stampCells(sheets, SLITTER_SESSIONS, s.__row, tab.map, {
    'Active Skid': info.skidId, 'Active Ticket': info.ticket, 'Active Mill': info.mill });
  return getSlitterDetail(sheets, sessionId);
}

// SKID EMPTY / SWITCH: the running skid ran out before the pallet was full. Record how many pieces
// are on the pallet right now (closing out the emptied skid's contribution), mark that source Used,
// and load the next skid — which now also feeds the same in-progress pallet (the mixed case).
async function slitterSwitchSkid(sheets, sessionId, stripsOnPalletNow, newSkidId, operator, opId) {
  if (opId && await opAlreadyDone(sheets, opId)) return getSlitterDetail(sheets, sessionId);
  const { tab, s } = await readSlitterSession(sheets, sessionId);
  const coils = parseComposition(s['Pallet Coils']);
  const soFar = coils.reduce((a, c) => a + num(c.strips), 0);
  const now = num(stripsOnPalletNow);
  const active = { skidId: s['Active Skid'] || '', ticket: s['Active Ticket'] || '', mill: s['Active Mill'] || '' };
  if (active.skidId) {
    const contribution = now - soFar;
    if (contribution > 0) coils.push({ skidId: active.skidId, ticket: active.ticket, mill: active.mill, strips: contribution });
    await markSkidUsed(sheets, active.skidId, operator, 'emptied on ' + (s['Slitter'] || '') + ' (' + sessionId + ')');
  }
  const info = await skidSourceInfo(sheets, newSkidId);
  await stampCells(sheets, SLITTER_SESSIONS, s.__row, tab.map, {
    'Pallet Coils': JSON.stringify(coils),
    'Active Skid': info.skidId, 'Active Ticket': info.ticket, 'Active Mill': info.mill });
  if (opId) await eventTx(sheets, { skidId: active.skidId, ticket: active.ticket, itemText: 'SLITTER SKID SWITCH', operator, note: 'switch to ' + info.ticket }, opId);
  return getSlitterDetail(sheets, sessionId);
}

// PALLET FULL: record the final piece count, mint the runnable LOAD Cut skid with the exact
// per-ticket strip split, and start the next pallet already loaded with the still-running skid
// (the finished skids auto-drop — they belonged to the pallet just closed).
async function slitterFinishPallet(sheets, sessionId, stripsOnPalletNow, notes, operator, opId) {
  await ensureTab(sheets, SLITTER_PALLETS, SLITTER_PALLET_HEADERS);
  const p0 = await readTab(sheets, SLITTER_PALLETS);
  if (opId && p0.headers.indexOf('Op ID') !== -1) {
    const ex = p0.rows.filter((r) => String(r['Op ID'] || '').trim() === String(opId).trim())[0];
    if (ex) return Object.assign({ duplicate: true }, await getSlitterDetail(sheets, sessionId));
  }
  const { tab, s } = await readSlitterSession(sheets, sessionId);
  const coils = parseComposition(s['Pallet Coils']);
  const soFar = coils.reduce((a, c) => a + num(c.strips), 0);
  const total = num(stripsOnPalletNow);
  if (total <= 0) throw new Error('Enter how many pieces are on the pallet.');
  const active = { skidId: s['Active Skid'] || '', ticket: s['Active Ticket'] || '', mill: s['Active Mill'] || '' };
  const finalComp = coils.slice();
  if (active.skidId) {
    const contribution = total - soFar;
    if (contribution > 0) finalComp.push({ skidId: active.skidId, ticket: active.ticket, mill: active.mill, strips: contribution });
  }
  if (!finalComp.length) throw new Error('Load a skid before finishing the pallet.');
  const kind = s['Kind'] || 'Slitter';
  const cutType = kind === 'Scroll' ? 'Scroll' : 'Slit';
  // Pallet ID (internal, session-scoped) — collision-safe.
  const existing = p0.rows.filter((o) => String(o['Session ID']).trim() === String(sessionId).trim());
  let n = existing.length + 1;
  while (existing.some((o) => String(o['Pallet ID']).trim() === sessionId + '-P' + n)) n++;
  const palletId = sessionId + '-P' + n;
  const cut = await createCutSkid(sheets, palletId, cutType, total, finalComp, s['Slitter']);
  let ens = await ensureColumn(sheets, SLITTER_PALLETS, p0.headers, 'Skid ID');
  ens = await ensureColumn(sheets, SLITTER_PALLETS, ens.headers, 'Load #');
  ens = await ensureColumn(sheets, SLITTER_PALLETS, ens.headers, 'Op ID');
  await appendRowObj(sheets, SLITTER_PALLETS, ens.headers, {
    'Pallet ID': palletId, 'Session ID': sessionId, 'Created On': todayYMD(),
    'Output Count': total, 'Composition': JSON.stringify(finalComp), 'Skid ID': cut.skidId, 'Load #': cut.loadNo, 'Notes': notes || '', 'Op ID': opId || '',
  });
  // Reset the in-progress pallet; the still-running Active Skid carries over to the next pallet.
  await stampCells(sheets, SLITTER_SESSIONS, s.__row, tab.map, { 'Pallet Coils': '[]' });
  // Audit log: record that a pallet was made, so daily/department activity is complete.
  const parents = finalComp.map((c) => (c.ticket || ('Mill ' + c.mill)) + ' (' + (c.strips != null ? c.strips : (c.qty || 0)) + ')').join(', ');
  await eventTx(sheets, { skidId: cut.skidId, ticket: String(cut.loadNo), itemText: 'PALLET MADE — LOAD ' + cut.loadNo, operator, note: cutType + ' pallet on ' + (s['Slitter'] || '') + ' (' + total + ') from: ' + parents }, opId);
  await recountSlitter(sheets, sessionId);
  const detail = await getSlitterDetail(sheets, sessionId);
  detail.newLoadNo = cut.loadNo;
  return detail;
}

async function removeSlitterPallet(sheets, sessionId, palletId, operator, opId) {
  const p = await readTab(sheets, SLITTER_PALLETS);
  const row = p.rows.filter((o) => String(o['Pallet ID']).trim() === String(palletId).trim())[0];
  if (!row) return getSlitterDetail(sheets, sessionId);
  // Blank the row's identity so it drops out of the session (kept simple: no physical row delete).
  await stampCells(sheets, SLITTER_PALLETS, row.__row, p.map, { 'Pallet ID': '', 'Session ID': '', 'Composition': '', 'Output Count': '' });
  await recountSlitter(sheets, sessionId);
  return getSlitterDetail(sheets, sessionId);
}

async function finishSlitterSession(sheets, sessionId, operator, opId) {
  const sessions = await readTab(sheets, SLITTER_SESSIONS);
  const s = sessions.rows.filter((o) => String(o['Session ID']).trim() === String(sessionId).trim())[0];
  if (!s) throw new Error('Slitter session not found: ' + sessionId);
  if (String(s['Status']) !== 'Finished') {
    await stampCells(sheets, SLITTER_SESSIONS, s.__row, sessions.map, { 'Status': 'Finished' });
  }
  return getSlitterDetail(sheets, sessionId);
}

// ================= STEEL COUNT =====================================================
// Physical floor count: check a skid off (stamp Counted At today / clear it). Location and
// sheet-count changes reuse updateTicketDetails (Row / QTY/LOAD). No tx-log spam per check.
// Mark one or many skids counted/uncounted in a SINGLE read + SINGLE write. Kept read-light
// on purpose: counting fires lots of these, and Sheets caps reads at 60/min/user. No
// normalizeMasterRows (the skids already exist), and we only re-read if a column was just added.
async function setSkidsCounted(sheets, skidIds, counted, operator, opId) {
  skidIds = (skidIds || []).map(function (s) { return String(s).trim(); });
  let master = await readTab(sheets, MASTER); // 1 read
  let reread = false;
  if (master.headers.indexOf('Counted At') === -1) { const e = await ensureColumn(sheets, MASTER, master.headers, 'Counted At'); master.headers = e.headers; reread = true; }
  if (master.headers.indexOf('Counted By') === -1) { const e = await ensureColumn(sheets, MASTER, master.headers, 'Counted By'); master.headers = e.headers; reread = true; }
  if (reread) master = await readTab(sheets, MASTER); // only the very first count ever
  const map = master.map;
  const cAt = map['Counted At'], cBy = map['Counted By'];
  const want = {};
  skidIds.forEach(function (id) { want[id] = true; });
  const valAt = counted ? todayYMD() : '';
  const valBy = counted ? (operator || '') : '';
  const data = [];
  master.rows.forEach(function (o) {
    if (!want[String(o['Skid ID']).trim()]) return;
    if (cAt) data.push({ range: "'" + MASTER + "'!" + colLetter(cAt) + o.__row, values: [[valAt]] });
    if (cBy) data.push({ range: "'" + MASTER + "'!" + colLetter(cBy) + o.__row, values: [[valBy]] });
  });
  if (data.length) await sheets.batchUpdate(data); // 1 write for the whole batch
  return { updated: skidIds.length, countedOn: counted ? todayYMD() : '' };
}
async function setSkidCounted(sheets, skidId, counted, operator, opId) {
  return setSkidsCounted(sheets, [skidId], counted, operator, opId);
}

// ================= GUIDED COUNT SESSION ============================================
// A count session walks Current -> WIP. "Found this session" is decided client-side by
// comparing a skid's Counted At date to the session's Started On date (>= start = found),
// so starting a new session naturally resets the walk and a count can span several days
// without a mass rewrite of Counted At.
function sessionOut(o) {
  return {
    sessionId: o['Session ID'], startedAt: String(o['Started At'] || ''), startedOn: toYMD(o['Started At']),
    startedBy: o['Started By'] || '', stage: o['Stage'] || 'Current',
    endedOn: o['Ended At'] ? toYMD(o['Ended At']) : '', endedBy: o['Ended By'] || '',
    currentFound: num(o['Current Found']), promoted: num(o['Promoted']),
    wipFound: num(o['WIP Found']), missing: num(o['Missing Marked']),
  };
}
function newestOpen(rows) {
  const open = rows.filter((o) => o['Session ID'] && String(o['Stage'] || '') !== 'Done');
  let best = null, bestN = -1;
  open.forEach((o) => { const n = parseInt(String(o['Session ID']).slice(4), 10) || 0; if (n > bestN) { bestN = n; best = o; } });
  return best;
}
async function getActiveCount(sheets) {
  let rows;
  try { rows = (await readObjects(sheets, COUNTS, true)).rows; } catch (e) { return null; }
  const best = newestOpen(rows);
  return best ? sessionOut(best) : null;
}
async function startCount(sheets, operator, opId) {
  await ensureTab(sheets, COUNTS, COUNT_HEADERS);
  const t = await readTab(sheets, COUNTS);
  if (opId && t.headers.indexOf('Op ID') !== -1) {
    const ex = t.rows.filter((r) => String(r['Op ID'] || '').trim() === String(opId).trim())[0];
    if (ex) return sessionOut(ex);
  }
  const open = newestOpen(t.rows);           // resume a still-open session instead of stacking a new one
  if (open) return sessionOut(open);
  const sid = fmtId('CNT-', maxIdNumber(t.rows, 'Session ID', 'CNT-') + 1);
  const ts = nowStamp();
  const ens = await ensureColumn(sheets, COUNTS, t.headers, 'Op ID');
  await appendRowObj(sheets, COUNTS, ens.headers, {
    'Session ID': sid, 'Started At': ts, 'Started By': operator || '', 'Stage': 'Current',
    'Ended At': '', 'Ended By': '', 'Op ID': opId || '',
  });
  return { sessionId: sid, startedAt: ts, startedOn: toYMD(ts), startedBy: operator || '', stage: 'Current', endedOn: '' };
}
async function setCountStage(sheets, sessionId, stage, operator, opId) {
  const t = await readTab(sheets, COUNTS);
  const o = t.rows.filter((r) => String(r['Session ID']).trim() === String(sessionId).trim())[0];
  if (!o) throw new Error('Count session not found: ' + sessionId);
  const fields = { 'Stage': stage };
  if (stage === 'Done') { fields['Ended At'] = nowStamp(); fields['Ended By'] = operator || ''; }
  await stampCells(sheets, COUNTS, o.__row, t.map, fields);
  return sessionOut(Object.assign({}, o, fields));
}
// Finish a count: save the tallies as a permanent record on the session row, then clear every
// Counted At/By on the master so the next count starts with a clean slate. `summary` carries the
// client's running tallies { currentFound, promoted, wipFound, missing }.
async function endCount(sheets, sessionId, operator, summary, opId) {
  summary = summary || {};
  let t = await readTab(sheets, COUNTS);
  let re = false;
  for (const c of COUNT_TALLY_COLS) { if (t.headers.indexOf(c) === -1) { const e = await ensureColumn(sheets, COUNTS, t.headers, c); t.headers = e.headers; re = true; } }
  if (re) t = await readTab(sheets, COUNTS);
  const o = t.rows.filter((r) => String(r['Session ID']).trim() === String(sessionId).trim())[0];
  if (!o) throw new Error('Count session not found: ' + sessionId);
  const fields = {
    'Stage': 'Done', 'Ended At': nowStamp(), 'Ended By': operator || '',
    'Current Found': num(summary.currentFound), 'Promoted': num(summary.promoted),
    'WIP Found': num(summary.wipFound), 'Missing Marked': num(summary.missing),
  };
  await stampCells(sheets, COUNTS, o.__row, t.map, fields);
  const cleared = await clearAllCounts(sheets, operator, opId);
  return Object.assign(sessionOut(Object.assign({}, o, fields)), { cleared: cleared.cleared });
}

// Blank every Counted At / Counted By on the master in ONE read + ONE batched write.
async function clearAllCounts(sheets, operator, opId) {
  const master = await readTab(sheets, MASTER);
  const cAt = master.map['Counted At'], cBy = master.map['Counted By'];
  if (!cAt && !cBy) return { cleared: 0 };
  const data = [];
  let n = 0;
  master.rows.forEach(function (o) {
    const has = (cAt && String(o['Counted At'] || '').trim()) || (cBy && String(o['Counted By'] || '').trim());
    if (!has) return;
    n++;
    if (cAt) data.push({ range: "'" + MASTER + "'!" + colLetter(cAt) + o.__row, values: [['']] });
    if (cBy) data.push({ range: "'" + MASTER + "'!" + colLetter(cBy) + o.__row, values: [['']] });
  });
  if (data.length) await sheets.batchUpdate(data);
  return { cleared: n };
}

// Past counts (newest first) for the Count History view.
async function getCountHistory(sheets) {
  let rows;
  try { rows = (await readObjects(sheets, COUNTS, true)).rows; } catch (e) { return []; }
  return rows.filter((o) => o['Session ID']).map(sessionOut)
    .sort((a, b) => (a.sessionId < b.sessionId ? 1 : a.sessionId > b.sessionId ? -1 : 0));
}
// Bulk status change in ONE read + ONE batched write (kept read-light like the count check-off).
// `fromStatus` (optional) only flips rows currently in that status; rows already at newStatus are
// skipped so promote/mark/restore are naturally idempotent under the client retry wrapper.
async function bulkSetStatus(sheets, skidIds, newStatus, extra, operator, fromStatus) {
  skidIds = (skidIds || []).map((s) => String(s).trim()).filter(Boolean);
  if (!skidIds.length) return { updated: 0, skidIds: [] };
  extra = extra || {};
  let master = await readTab(sheets, MASTER);
  let reread = false;
  for (const c of Object.keys(extra)) {
    if (master.headers.indexOf(c) === -1) { const e = await ensureColumn(sheets, MASTER, master.headers, c); master.headers = e.headers; reread = true; }
  }
  if (reread) master = await readTab(sheets, MASTER);
  const map = master.map;
  const want = {}; skidIds.forEach((id) => { want[id] = true; });
  const ts = nowStamp();
  const data = [];
  const done = [];
  master.rows.forEach((o) => {
    const id = String(o['Skid ID']).trim();
    if (!want[id]) return;
    const cur = String(o['Status'] || '');
    if (cur === newStatus) return;                              // already there — no-op
    if (fromStatus && cur !== fromStatus) return;              // guard against re-flipping
    const fields = Object.assign({ 'Status': newStatus, 'Last Updated At': ts, 'Last Updated By': operator || '' }, extra);
    Object.keys(fields).forEach((name) => { if (map[name]) data.push({ range: "'" + MASTER + "'!" + colLetter(map[name]) + o.__row, values: [[fields[name]]] }); });
    done.push(id);
  });
  if (data.length) await sheets.batchUpdate(data);
  return { updated: done.length, skidIds: done };
}

// End of the Current walk: the pallets not physically found are assumed to have been moved to
// WIP without being recorded, so flip them Current -> WIP (they then reappear, unchecked, in the
// WIP walk for a second physical confirmation).
async function promoteUnfoundToWip(sheets, skidIds, operator, opId) {
  return bulkSetStatus(sheets, skidIds, STATUS.WIP, {}, operator, STATUS.CURRENT);
}
// End of the WIP walk: pallets still not found anywhere are marked Missing (row kept for the
// audit trail + Missing report; can be restored if they turn up).
async function markSkidsMissing(sheets, skidIds, operator, opId) {
  return bulkSetStatus(sheets, skidIds, STATUS.MISSING, { 'Missing At': todayYMD(), 'Missing By': operator || '' }, operator, null);
}
// A missing pallet turned up: restore it to Current (raw) or WIP (coated) and clear the Missing stamp.
async function restoreMissing(sheets, skidId, toStatus, operator, opId) {
  const dest = (toStatus === STATUS.WIP) ? STATUS.WIP : STATUS.CURRENT;
  return bulkSetStatus(sheets, [skidId], dest, { 'Missing At': '', 'Missing By': '' }, operator, STATUS.MISSING);
}

// ================= REPORTS =========================================================
// "What was produced" for a day or a date range, per department.
function inRange(v, start, end) {
  const d = toYMD(v);
  return !!d && d >= start && d <= end;
}

// Litho produced = skids whose litho was applied (First Coated At) in the range and that got
// past Pending (WIP / In Production / Used) — i.e. coatings that actually went through.
async function getLithoReport(sheets, start, end) {
  start = start || todayYMD();
  end = end || start;
  const { rows } = await readObjects(sheets, MASTER, true);
  const out = [];
  let totalLitho = 0;
  rows.forEach((o) => {
    const st = o['Status'] || '';
    if (st !== STATUS.WIP && st !== STATUS.IN_PRODUCTION && st !== STATUS.USED) return;
    if (!inRange(o['First Coated At'], start, end)) return;
    const litho = num(o['Litho']);
    totalLitho += litho;
    out.push({ ticket: o['Ticket'], skidId: o['Skid ID'], litho, coatedOn: toYMD(o['First Coated At']), by: o['First Coated By'] || '', status: st });
  });
  out.sort((a, b) => (a.coatedOn < b.coatedOn ? -1 : a.coatedOn > b.coatedOn ? 1 : 0));
  return { start, end, count: out.length, totalLitho: Math.round(totalLitho * 100) / 100, rows: out };
}

// Metals produced = skids marked Used (Finished On) in the range.
async function getMetalsReport(sheets, start, end) {
  start = start || todayYMD();
  end = end || start;
  const { rows } = await readObjects(sheets, MASTER, true);
  const out = [];
  let totalSheets = 0;
  rows.forEach((o) => {
    if ((o['Status'] || '') !== STATUS.USED) return;
    if (!inRange(usedAt(o), start, end)) return;
    const sheetsUsed = num(o['QTY/LOAD']);
    totalSheets += sheetsUsed;
    out.push({ ticket: o['Ticket'], skidId: o['Skid ID'], finishedOn: toYMD(usedAt(o)), by: o['Used By'] || '', sheets: sheetsUsed });
  });
  out.sort((a, b) => (a.finishedOn < b.finishedOn ? -1 : a.finishedOn > b.finishedOn ? 1 : 0));
  return { start, end, count: out.length, totalSheets, rows: out };
}

function classifyMachine(machine) {
  const m = /^\s*(Line|Press)\b/i.exec(String(machine || ''));
  return m ? (m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()) : '';
}

// Completed-work activity by department for a date range. dept: 'all' | 'litho' | 'lines' |
// 'press' | 'slitter' | 'scrolls' | 'count'. Reads the authoritative source tabs so it reflects
// finished output (pallets made, skids coated, runs finished, counts done), not every keystroke.
// Cut pallets carry their parent tickets + mills, so lineage back to the mill shows on each row.
async function getDepartmentReport(sheets, start, end, dept) {
  start = start || todayYMD();
  end = end || start;
  dept = dept || 'all';
  const want = (k) => dept === 'all' || dept === k;
  const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  const sections = [];

  let master = { rows: [] };
  try { master = await readObjects(sheets, MASTER, true); } catch (e) { /* keep empty */ }

  if (want('litho')) {
    const rows = [];
    master.rows.forEach((o) => {
      const st = o['Status'] || '';
      if (st !== STATUS.WIP && st !== STATUS.IN_PRODUCTION && st !== STATUS.USED) return;
      if (!inRange(o['First Coated At'], start, end)) return;
      rows.push({ date: toYMD(o['First Coated At']), ticket: o['Ticket'], skidId: o['Skid ID'], by: o['First Coated By'] || '', litho: num(o['Litho']) });
    });
    rows.sort(byDate);
    sections.push({ key: 'litho', label: 'Litho — skids coated', rows });
  }

  if (want('direct')) {
    const rows = [];
    master.rows.forEach((o) => {
      if ((o['Status'] || '') !== STATUS.USED) return;
      if (String(o['Used Via'] || '') !== 'Direct') return;   // only the quick-mark flow, not runs/slitter
      if (!inRange(usedAt(o), start, end)) return;
      rows.push({ date: toYMD(usedAt(o)), ticket: o['Ticket'], skidId: o['Skid ID'], mill: o['Mill'] || '', litho: num(o['Litho']), cost: num(o['Cost']) });   // date only
    });
    rows.sort(byDate);
    sections.push({ key: 'direct', label: 'Used in Production (direct)', rows });
  }

  if (want('lines') || want('press')) {
    const runMap = {};
    try { (await readObjects(sheets, PRODUCTION, true)).rows.forEach((r) => { if (r['Run ID']) runMap[String(r['Run ID']).trim()] = r['Machine'] || ''; }); } catch (e) { /* no runs */ }
    const lineRows = [], pressRows = [];
    master.rows.forEach((o) => {
      if ((o['Status'] || '') !== STATUS.USED) return;
      if (!inRange(usedAt(o), start, end)) return;
      const runId = String(o['Run ID'] || '').trim();
      if (!runId) return;                                   // no run = not a Line/Press completion
      const machine = runMap[runId] || '';
      const type = classifyMachine(machine);
      const row = { date: usedAt(o), ticket: o['Ticket'], skidId: o['Skid ID'], machine, by: o['Used By'] || '', sheets: num(o['QTY/LOAD']) };   // full date + time
      if (type === 'Line') lineRows.push(row); else if (type === 'Press') pressRows.push(row);
    });
    if (want('lines')) { lineRows.sort(byDate); sections.push({ key: 'lines', label: 'Metal Lines — skids run', rows: lineRows }); }
    if (want('press')) { pressRows.sort(byDate); sections.push({ key: 'press', label: 'Press — skids run', rows: pressRows }); }
  }

  if (want('slitter') || want('scrolls')) {
    const sessMap = {};
    try { (await readObjects(sheets, SLITTER_SESSIONS, true)).rows.forEach((s) => { if (s['Session ID']) sessMap[String(s['Session ID']).trim()] = s; }); } catch (e) { /* none */ }
    let pallets = [];
    try { pallets = (await readObjects(sheets, SLITTER_PALLETS, true)).rows.filter((p) => p['Pallet ID'] && p['Session ID']); } catch (e) { /* none */ }
    const slitRows = [], scrollRows = [];
    pallets.forEach((p) => {
      if (!inRange(p['Created On'], start, end)) return;
      const sess = sessMap[String(p['Session ID']).trim()] || {};
      const kind = sess['Kind'] || 'Slitter';
      const comp = parseComposition(p['Composition']);
      const from = comp.map((c) => (c.ticket || ('Mill ' + c.mill)) + (c.mill ? ' [mill ' + c.mill + ']' : '') + ' (' + (c.strips != null ? c.strips : (c.qty || 0)) + ')').join(' + ');
      const cutRow = master.rows.filter((o) => String(o['Skid ID']).trim() === String(p['Skid ID'] || '').trim())[0] || {};
      const row = { date: toYMD(p['Created On']), loadNo: p['Load #'] || '', machine: sess['Slitter'] || '', by: sess['Operator'] || '', output: num(p['Output Count']), unit: kind === 'Scroll' ? 'Strips' : 'Body Blanks', from, skidId: p['Skid ID'] || '', cost: num(cutRow['Cost']), litho: num(cutRow['Litho']) };
      if (kind === 'Scroll') scrollRows.push(row); else slitRows.push(row);
    });
    if (want('slitter')) { slitRows.sort(byDate); sections.push({ key: 'slitter', label: 'Slitter — pallets made', rows: slitRows }); }
    if (want('scrolls')) { scrollRows.sort(byDate); sections.push({ key: 'scrolls', label: 'Scrolls — pallets made', rows: scrollRows }); }
  }

  if (want('count')) {
    let rows = [];
    try {
      rows = (await readObjects(sheets, COUNTS, true)).rows
        .filter((o) => o['Session ID'] && String(o['Stage']) === 'Done' && inRange(o['Ended At'], start, end))
        .map((o) => ({ date: toYMD(o['Ended At']), sessionId: o['Session ID'], by: o['Ended By'] || '', currentFound: num(o['Current Found']), promoted: num(o['Promoted']), wipFound: num(o['WIP Found']), missing: num(o['Missing Marked']) }));
    } catch (e) { /* none */ }
    rows.sort(byDate);
    sections.push({ key: 'count', label: 'Count — sessions completed', rows });
  }

  return { start, end, dept, sections };
}
