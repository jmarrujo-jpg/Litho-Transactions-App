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
 *   SNAPSHOT_SHEET_ID   (var)     spreadsheet id of the "Steel Snapshot" archive
 *   WRITE_LOCK          (Durable Object binding -> class WriteLock)  recommended: makes every
 *                       write run one at a time across all devices (see "write lock" below).
 *                       Optional — without it the app still works, with a weaker per-server lock.
 */

const DEFAULT_SHEET_ID = '12Irb-isWOO14SrlGglcgnHc8oi0mLwW54LNo7pBHKjg';
const TZ = 'America/Los_Angeles';
const SHEETS_TIMEOUT_MS = 30000;   // one Google call that hangs longer than this counts as failed
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

// Receivers: the paperwork a load of steel arrived on (packing slip / bill of lading), scanned to
// Google Drive. The app numbers them itself (R-00001, never reused) since the paper has no common
// number. Steel Tickets gets a 'Receiver' column holding just that number; this tab holds the rest.
// The file name shown to copy onto the Drive scan is YY-MM-DD--SUPPLIER--R-00001.
// Each receiver also keeps the mill and ticket numbers of the tickets put on it ('Mill Numbers',
// 'Tickets'), so wiping Steel Tickets (Fresh Import) doesn't lose the work — see keepPlan.
const RECEIVERS = 'Receivers';
const RECEIVER_KEEP_COLS = ['Mill Numbers', 'Tickets'];
const RECEIVER_HEADERS = ['Receiver ID', 'File Name', 'Date Received', 'Supplier', 'POs', 'Drive Link', 'Source File ID', 'Notes', 'Mill Numbers', 'Tickets', 'Created At', 'Created By', 'Last Updated At', 'Op ID'];
// Find in Drive: each unassigned ticket's mill number is searched in the receiver scans shared with
// the service account (Drive reads the text of scanned PDFs). Every search is logged on this tab so
// a mill is searched once (until "search again"); the review screen groups the hits by file.
const DRIVE_SEARCH = 'Drive Search';
const DRIVE_SEARCH_HEADERS = ['Mill', 'File ID', 'File Name', 'File Link', 'Folder ID', 'Folder Name', 'File Date', 'Searched At', 'Scope'];
// Only scans inside this folder (and every folder in it, at any depth) are searched — "Raw Metal
// Packing Slip Archive"; env RECEIVER_SOURCE_FOLDER overrides. A search logged under another
// folder (Scope) doesn't count, so changing it means searching again.
const DEFAULT_SOURCE_FOLDER = '1wFGdaTg9Rep-ac6DM3rC9x6FA3HLh--_';
// Files and folders titled "Production Slips" aren't receivers: never searched (a folder by that
// name is skipped with everything in it). Searches from before this rule carry the bare folder id
// as their Scope, so they don't count and get searched again.
const DRIVE_EXCLUDE = /production[\s_-]*slips?/i;
const DRIVE_SCOPE_TAG = ' -production slips';
const DRIVE_FOLDERS_PER_QUERY = 40;   // "in parents" terms per Drive query (keeps the query short)
// Where approved receivers' copies go ("Raw Metal Packing Slips"); env RECEIVER_FOLDER_ID overrides.
const DEFAULT_RECEIVER_FOLDER = '18PRmpTAcNgjmcjQ3_hELRHcsPkYGND98';
const DRIVE_BATCH = 25;   // Drive calls for searching per request (Free plan: 50 calls per request)

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

// ---------------- write lock ----------------
// Every change to the sheet runs one at a time. Most writes are several Sheets calls (read the
// sheet, pick the next Skid ID, write the row, log it); two running at once can hand out the same
// Skid ID, write over each other's rows, or delete the wrong job after rows shift. Reads skip the
// line — they never change anything.
//
// The lock lives in a Durable Object (binding WRITE_LOCK, class WriteLock below): one instance for
// the whole app, so writes from every iPad queue up in one place. If the binding isn't set up yet,
// writes still queue within this Worker instance — which covers the common case (the same device
// double-tapping or retrying) but not two devices landing on different Cloudflare servers.
const READ_ONLY_FNS = new Set(['getRateTree', 'getAllTickets', 'getUsedTickets', 'getOperatorNames', 'getTicketCard',
  'getJobsForDate', 'getOpenJobs', 'getJobDetail', 'getProductionRuns', 'getRunDetail', 'getRawTable', 'getSlitterSessions',
  'getSlitterDetail', 'getMasterSheet', 'getSkidHistory', 'getReceivers', 'getDriveMatches', 'getLithoReport', 'getMetalsReport', 'getDepartmentReport', 'getUseTrace', 'getActiveCount', 'getCountHistory',
  'snapshotCurrentWip']);   // the snapshot only READS the live sheet (it writes to the separate snapshots file)
const LOCK_MAX_HOLD_MS = 120000;   // a write stuck longer than this stops blocking the ones behind it
let lockChain = Promise.resolve();
function serialize(task) {
  const run = lockChain.then(() => task());
  lockChain = Promise.race([run.then(() => {}, () => {}), new Promise((res) => setTimeout(res, LOCK_MAX_HOLD_MS))]);
  return run;
}
async function runLocked(fn, args, env) {
  if (READ_ONLY_FNS.has(fn)) return { ok: true, result: await handle(fn, args, env) };
  if (env.WRITE_LOCK && env.WRITE_LOCK.idFromName) {
    const stub = env.WRITE_LOCK.get(env.WRITE_LOCK.idFromName('litho-sheet'));
    const r = await stub.fetch('https://write-lock/run', { method: 'POST', body: JSON.stringify({ fn, args }) });
    return r.json();
  }
  return { ok: true, result: await serialize(() => handle(fn, args, env)) };
}
export class WriteLock {
  constructor(state, env) { this.env = env; }
  async fetch(request) {
    const { fn, args } = await request.json();
    try {
      const result = await serialize(() => handle(fn, args || [], this.env));
      return new Response(JSON.stringify({ ok: true, result }), { headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) }), { headers: { 'Content-Type': 'application/json' } });
    }
  }
}

export default {
  async fetch(request, env, ctx) {
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
    if (request.method === 'GET') return json({ ok: true, service: 'litho-api', stage: 'full', build: 'trace-69', writeLock: !!env.WRITE_LOCK }, 200);
    if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

    let payload;
    try { payload = JSON.parse((await request.text()) || '{}'); }
    catch (e) { return json({ ok: false, error: 'Bad request body' }, 400); }

    if (env.API_TOKEN && String(payload.secret || '') !== String(env.API_TOKEN)) {
      return json({ ok: false, error: 'Unauthorized' }, 200);
    }
    // waitUntil: if the iPad's connection drops mid-save, keep going until the save finishes
    // (instead of being cut off half-done). The app's retry then finds it done, or waits its turn.
    const work = runLocked(payload.fn, payload.args || [], env);
    if (ctx && ctx.waitUntil) ctx.waitUntil(work.catch(() => {}));
    try {
      return json(await work, 200);
    } catch (e) {
      return json({ ok: false, error: e && e.message ? e.message : String(e) }, 200);
    }
  },
  // Daily snapshot. Configure a Cloudflare Cron Trigger of "0 22,23 * * *" (UTC, EVERY day): that
  // fires at both 22:00 and 23:00 UTC so that, in either half of the year, exactly one firing lands
  // on 3 PM Pacific. We do ALL the gating here in code (not in the cron's day-of-week field, which is
  // evaluated in UTC and easy to get wrong): the local hour must match so daylight-saving shifts
  // don't matter, AND it must be a Pacific weekday (Mon-Fri) so weekends are skipped. skipIfExists
  // guarantees at most one snapshot tab per day even if both firings match.
  async scheduled(event, env, ctx) {
    const targetHour = Number(env.SNAPSHOT_HOUR != null ? env.SNAPSHOT_HOUR : 15); // 3 PM Pacific
    if (!shouldSnapshot(localHour(TZ), localWeekday(TZ), targetHour)) return;
    const today = todayYMD();
    let sheets = null, row;
    try {
      sheets = await makeSheets(env);
      const res = await snapshotCurrentWip(sheets, env, 'cron-' + today, { skipIfExists: true });
      console.log('scheduled snapshot: ' + JSON.stringify(res));
      row = buildSnapshotLog(today, res, null);
    } catch (e) {
      const msg = (e && e.message ? e.message : String(e));
      console.log('scheduled snapshot failed: ' + msg);
      row = buildSnapshotLog(today, null, msg);
    }
    // Record the result in the "Failure Report" tab so a sheet-side Apps Script can email on failure.
    // Never let a logging problem crash the job.
    try {
      if (!sheets) sheets = await makeSheets(env);
      await logSnapshotStatus(sheets, env, today, row);
    } catch (e) { console.log('snapshot log write failed: ' + (e && e.message ? e.message : String(e))); }
  },
};
// Current hour (0-23) in the given IANA timezone, DST-aware.
function localHour(tz) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false }).formatToParts(new Date());
  const h = p.find((x) => x.type === 'hour');
  return h ? (Number(h.value) % 24) : -1;
}
// Current weekday ('Mon'..'Sun') in the given IANA timezone, DST-aware.
function localWeekday(tz) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date());
}
// Should the daily snapshot run right now? Pure predicate (no I/O) so it is easy to test.
// Runs only on the target local hour AND on a weekday (Mon-Fri) — weekends are skipped.
function shouldSnapshot(hour, weekday, targetHour) {
  if (hour !== targetHour) return false;
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  return true;
}
// Compose the "Failure Report" log columns for a run. Pure (no I/O) so it is easy to test.
// Returns { success, failure }: on success, `success` (col B) is filled and `failure` (col C) is
// blank; on failure it is the reverse — so a sheet-side Apps Script can email whenever col C fills.
function buildSnapshotLog(today, res, err) {
  if (err) {
    return { success: '', failure: 'Snapshot did not run: ' + err + ' (live app data is unaffected)' };
  }
  const counts = (res.total || 0) + ' rows (' + (res.current || 0) + ' Current, '
    + (res.wip || 0) + ' WIP, ' + (res.pending || 0) + ' Pending)';
  if (res.skipped) {
    return { success: 'Success — already present, ' + counts, failure: '' };
  }
  return { success: 'Success — saved tab "' + res.tab + '", ' + counts, failure: '' };
}
// Append a row to the "Failure Report" tab of the snapshots spreadsheet: A=date, B=success, C=failure.
// Creates the tab with a header row the first time. No-ops if no snapshots sheet is configured.
const SNAPSHOT_LOG_TAB = 'Failure Report';
async function logSnapshotStatus(sheets, env, today, row) {
  const snapId = (env && env.SNAPSHOT_SHEET_ID) || '';
  if (!snapId) return;
  const header = ['Date', 'Success', 'Failure'];
  const titles = new Set(((await sheets.metaOf(snapId)).sheets || []).map((s) => s.properties.title));
  if (!titles.has(SNAPSHOT_LOG_TAB)) {
    await sheets.addSheetTo(snapId, SNAPSHOT_LOG_TAB, 2000, 3, 0);
    await sheets.writeValues(snapId, "'" + SNAPSHOT_LOG_TAB + "'!A1", [header]);
  } else {
    // Tab already exists — make sure row 1 is the header, even if it was created/emptied by hand,
    // so appended rows start at row 2 and the watcher's "skip row 1" logic stays correct.
    const head = await sheets.readFrom(snapId, "'" + SNAPSHOT_LOG_TAB + "'!A1:C1");
    if (!head.length || !head[0].length) {
      await sheets.writeValues(snapId, "'" + SNAPSHOT_LOG_TAB + "'!A1", [header]);
    }
  }
  await sheets.appendTo(snapId, "'" + SNAPSHOT_LOG_TAB + "'!A1", [today, row.success, row.failure]);
}

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
    case 'snapshotCurrentWip': // (opId) -> writes a dated Current+WIP+Pending tab into the snapshots spreadsheet
      return snapshotCurrentWip(sheets, env, args[0]);
    case 'seedSnapshots': // (count, opId) -> TEST: seed N back-dated day tabs from current data
      return seedSnapshots(sheets, env, args[0], args[1]);
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
    case 'jobAddTicket': // (jobId, skidId, sheetsRun, isPartialSkid, lithoNote, operator, opId, coatedTicket, testedBW)
      return jobAddTicket(sheets, args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7], args[8]);
    case 'getSkidHistory': // (skidId) one ticket's full history: timeline, where it came from, what was made from it
      return getSkidHistory(sheets, args[0]);
    case 'getMasterSheet': // () every Current / WIP / Used / Pending ticket with its live coatings
      return getMasterSheet(sheets);
    case 'masterEdit': // (changes[{skidId, status?, removePasses?[], receiver?}], operator, opId) Database Master sheet: save all at once
      return masterEdit(sheets, args[0], args[1], args[2]);
    case 'getReceivers': // () every receiver, plus a light list of every ticket (to attach them)
      return getReceivers(sheets);
    case 'saveReceiver': // ({id?, date, supplier, pos, link, notes}, operator, opId) create (no id) or edit a receiver
      return saveReceiver(sheets, args[0], args[1], args[2]);
    case 'deleteReceiver': // (receiverId, operator, opId) only while no ticket is on it
      return deleteReceiver(sheets, args[0], args[1], args[2]);
    case 'keepReceiverNumbers': // (operator, opId) write every receiver's kept mill / ticket numbers up to date
      return keepReceiverNumbers(sheets);
    case 'driveSearchMills': // (again) search Drive for the next batch of unassigned tickets' mill numbers
      return driveSearchMills(sheets, env, args[0]);
    case 'getDriveMatches': // () the Drive hits grouped by file, for review
      return getDriveMatches(sheets, env);
    case 'approveDriveMatch': // ({fileId, receiverId?, date, supplier, pos, notes, skidIds[]}, operator, opId) new receiver + copy + attach
      return approveDriveMatch(sheets, env, args[0], args[1], args[2]);
    case 'moveToWip': // (description, operator, coatings[], skidIds[], opId, removals{skidId:[pass]}) foreman batch: coat + straight to WIP
      return moveToWip(sheets, args[0], args[1], args[2], args[3], args[4], args[5]);
    case 'addCoatingToJob': // (jobId, coating, operator, opId)
      return addCoatingToJob(sheets, args[0], args[1], args[2], args[3]);
    case 'removeTicketFromJob': // (jobId, skidId, operator, opId)
      return removeTicketFromJob(sheets, args[0], args[1], args[2], args[3]);
    case 'approveJob': // (jobId, operator, opId)
      return approveJob(sheets, args[0], args[1], args[2]);
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
    case 'getUseTrace': // (dateYMD, diameter, daysEachSide)
      return getUseTrace(sheets, args[0], args[1], args[2]);
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
  // Drive: search the shared receiver scans by mill number and copy them into the receivers folder.
  const claim = { iss: email, scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 };
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
  // Google Sheets intermittently returns transient failures ("Sheets API 503: The service is
  // currently unavailable", also 429/500/502/504). A single blip used to abort a whole multi-call
  // job — that is exactly what lost two daily snapshots in a row — so transient failures are
  // retried with backoff, and real errors (4xx like 403/404) fail fast.
  //
  // BUT a 5xx or a dropped connection does NOT prove Google skipped the request: it may have
  // saved it and then failed to answer. Re-sending a read, or a write that sets exact cells, is
  // harmless. Re-sending an append would add the row twice (a duplicate skid), and re-sending a
  // row delete would delete a different row. So those calls pass unsafe=true: only a 429 (Google
  // refused it outright) is retried here, and any other failure is thrown with err.ambiguous set
  // so the caller can look before retrying (see append / addSheet below).
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  async function call(url, opts, unsafe) {
    const RETRYABLE = [429, 500, 502, 503, 504];
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await sleep(400 * Math.pow(3, attempt - 1)); // 0.4s, 1.2s, 3.6s
      let r, t;
      try {
        const o = Object.assign({}, opts);
        if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) o.signal = AbortSignal.timeout(SHEETS_TIMEOUT_MS);
        r = await fetch(url, o);
        t = await r.text();
      } catch (e) {
        lastErr = new Error('Sheets API request failed: ' + (e && e.message ? e.message : String(e)));
        if (unsafe) { lastErr.ambiguous = true; throw lastErr; }
        continue;
      }
      let j = null;
      try { j = t ? JSON.parse(t) : {}; } catch (e) { j = null; }   // 5xx pages are often HTML, not JSON
      if (r.ok) {
        if (j === null) throw new Error('Sheets API non-JSON: ' + t.slice(0, 200));
        return j;
      }
      const api = url.indexOf('/drive/v3/') !== -1 ? 'Drive API ' : 'Sheets API ';
      const msg = api + r.status + ': ' + (j && j.error && j.error.message ? j.error.message : t.slice(0, 200));
      if (RETRYABLE.indexOf(r.status) === -1) {
        const err = new Error(msg);
        err.status = r.status;
        err.reason = j && j.error && j.error.errors && j.error.errors[0] ? j.error.errors[0].reason : '';
        throw err;
      }
      lastErr = new Error(msg);
      if (unsafe && r.status !== 429) { lastErr.ambiguous = true; throw lastErr; }
    }
    throw lastErr;
  }
  // Retry an unsafe write only after checking it didn't already land. landed() answers "is it
  // there now?"; with no way to check, the error is passed up rather than risk doing it twice.
  async function callChecked(url, opts, landed) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await call(url, opts, true); }
      catch (e) {
        if (!e.ambiguous || !landed) throw e;
        lastErr = e;
        await sleep(600 * (attempt + 1));
        let there;
        try { there = await landed(); } catch (e2) { throw e; }   // can't tell -> don't guess
        if (there) return {};
      }
    }
    throw lastErr;
  }
  const json = (body) => ({ method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  // Per-request read cache. A single save used to read the same tab many times over (adding a
  // coating to a 6-ticket job read the rate table 13 times and Steel Tickets 20 times: 62 Google
  // calls, over the Workers Free plan's 50-per-request cap). Reads are kept for the rest of this
  // request only, and a tab's entries are dropped before AND after any write to it, so a read never
  // returns data older than this request's own last write (and the "did it land?" checks after an
  // unclear failure always read fresh). Writes are serialized by the write lock, so nobody else
  // changes the sheet mid-request. Callers get their own copy, since some edit the rows they read.
  const readCache = new Map();   // tab -> Map(range|mode -> values)
  function tabOfRange(rangeA1) {
    const m = /^'((?:[^']|'')*)'/.exec(rangeA1);
    return m ? m[1].replace(/''/g, "'") : String(rangeA1).split('!')[0];
  }
  const copyRows = (v) => v.map((r) => r.slice());
  function drop(tabs) { if (tabs === null) readCache.clear(); else tabs.forEach((t) => readCache.delete(t)); }
  async function writing(tabs, fn) { drop(tabs); try { return await fn(); } finally { drop(tabs); } }
  const freshCheck = (tabs, landed) => landed && (async () => { drop(tabs); return landed(); });
  async function tabTitles(spreadsheetId) {
    const m = await call('https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId + '?fields=' + encodeURIComponent('sheets.properties(title)'), { headers: auth });
    return new Set((m.sheets || []).map((x) => x.properties.title));
  }
  return {
    id,
    _hdr: {},     // per-request cache of each tab's header row (see tabHeaders)
    _ops: null,   // per-request cache of the Transactions Op IDs (see opIdSet)
    async read(rangeA1, unformatted) {
      const tab = tabOfRange(rangeA1), key = rangeA1 + (unformatted ? '|u' : '|f');
      let byTab = readCache.get(tab);
      if (byTab && byTab.has(key)) return copyRows(byTab.get(key));
      const q = unformatted ? '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER' : '?valueRenderOption=FORMATTED_VALUE';
      const j = await call(base + '/values/' + encodeURIComponent(rangeA1) + q, { headers: auth });
      const values = j.values || [];
      if (!readCache.has(tab)) readCache.set(tab, new Map());
      readCache.get(tab).set(key, values);
      return copyRows(values);
    },
    // landed(): optional "did this row get saved?" check, used to retry safely after an unclear failure.
    async append(rangeA1, row, landed) {
      const tabs = [tabOfRange(rangeA1)];
      return writing(tabs, () => callChecked(base + '/values/' + encodeURIComponent(rangeA1) + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
        json({ values: [row] }), freshCheck(tabs, landed)));
    },
    // Several rows in ONE call (a batch of coating log rows). An append lands all its rows or
    // none, so landed() only needs to check for one of them.
    async appendMany(rangeA1, rows, landed) {
      const tabs = [tabOfRange(rangeA1)];
      return writing(tabs, () => callChecked(base + '/values/' + encodeURIComponent(rangeA1) + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
        json({ values: rows }), freshCheck(tabs, landed)));
    },
    async update(rangeA1, values) {
      return writing([tabOfRange(rangeA1)], () => call(base + '/values/' + encodeURIComponent(rangeA1) + '?valueInputOption=RAW',
        { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ values }) }));
    },
    async batchUpdate(data) {
      return writing(data.map((d) => tabOfRange(d.range)), () => call(base + '/values:batchUpdate', json({ valueInputOption: 'RAW', data })));
    },
    async addSheet(title) {
      return writing(null, () => callChecked(base + ':batchUpdate', json({ requests: [{ addSheet: { properties: { title } } }] }),
        async () => (await tabTitles(id)).has(title)));
    },
    async meta() {
      return call(base + '?fields=' + encodeURIComponent('sheets.properties(sheetId,title,gridProperties)'), { headers: auth });
    },
    // Growing the grid twice just leaves a few extra blank rows/columns, so these can retry freely.
    async appendColumns(sheetId, count) {
      return writing(null, () => call(base + ':batchUpdate', json({ requests: [{ appendDimension: { sheetId, dimension: 'COLUMNS', length: count } }] })));
    },
    async appendRows(sheetId, count) {
      return writing(null, () => call(base + ':batchUpdate', json({ requests: [{ appendDimension: { sheetId, dimension: 'ROWS', length: count } }] })));
    },
    // Never blindly re-sent: a repeated delete would remove whichever row moved up into the gap.
    async deleteRows(sheetId, startIndex, endIndex) {   // 0-based, half-open [startIndex, endIndex)
      return writing(null, () => call(base + ':batchUpdate', json({ requests: [{ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex, endIndex } } }] }), true));
    },
    // ---- cross-spreadsheet helpers (write to a DIFFERENT spreadsheet the SA has been shared on;
    //      used for the snapshots archive). Only the `spreadsheets` scope is needed. ----
    async metaOf(spreadsheetId) {
      return call('https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId + '?fields=' + encodeURIComponent('sheets.properties(title)'), { headers: auth });
    },
    async addSheetTo(spreadsheetId, title, rowCount, columnCount, index) {
      const properties = { title, gridProperties: { rowCount: Math.max(rowCount, 1), columnCount: Math.max(columnCount, 1) } };
      if (typeof index === 'number') properties.index = index; // tab position: 0 = leftmost
      return callChecked('https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId + ':batchUpdate',
        json({ requests: [{ addSheet: { properties } }] }),
        async () => (await tabTitles(spreadsheetId)).has(title));
    },
    async writeValues(spreadsheetId, rangeA1, values) {
      return call('https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId + '/values/' + encodeURIComponent(rangeA1) + '?valueInputOption=RAW',
        { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ values }) });
    },
    // Snapshot "Failure Report" log line: a rare duplicate line is harmless, so this retries freely.
    async appendTo(spreadsheetId, rangeA1, row) {
      return call('https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId + '/values/' + encodeURIComponent(rangeA1) + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
        json({ values: [row] }));
    },
    async readFrom(spreadsheetId, rangeA1) {
      const j = await call('https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId + '/values/' + encodeURIComponent(rangeA1), { headers: auth });
      return j.values || [];
    },
    // ---- Google Drive (v3): the service account sees only files / folders shared with it ----
    async driveList(q, fields, pageSize) {
      const u = 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) + '&fields=' + encodeURIComponent('files(' + fields + ')') +
        '&pageSize=' + (pageSize || 20) + '&corpora=allDrives&includeItemsFromAllDrives=true&supportsAllDrives=true';
      return (await call(u, { headers: auth })).files || [];
    },
    async driveGet(fileId, fields) {
      return call('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '?supportsAllDrives=true&fields=' + encodeURIComponent(fields), { headers: auth });
    },
    // A copy can't be blindly re-sent (it would make two); landed() looks for it first.
    async driveCopy(fileId, name, folderId, landed) {
      return callChecked('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '/copy?supportsAllDrives=true&fields=' + encodeURIComponent('id,name,webViewLink'),
        json({ name, parents: [folderId] }), landed);
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
// Tolerates thousands-separator commas ("4,405" -> 4405) which appear in some weight cells, and a
// dollar sign ("$67.31", as Access pastes Cost); plain Number() would read those as NaN -> 0.
function num(v) { return Number(String(v == null ? '' : v).replace(/[,$\s]/g, '')) || 0; }
// For numbers a person typed: "1,234" and "$12.50" are fine; blank or junk is NaN (never 0).
function typedNum(v) {
  const t = String(v == null ? '' : v).replace(/[,$\s]/g, '');
  return t === '' ? NaN : Number(t);
}
// The skid's "used" date/time lives in 'Used At'. Historically it was 'Finished On' (date only);
// we still read that as a fallback so pre-migration rows keep counting until the old column is gone.
function usedAt(o) { return o['Used At'] || o['Finished On'] || ''; }
async function readObjects(sheets, tab, unformatted) {
  const values = await sheets.read(tab, unformatted);
  if (!values.length) return { headers: [], rows: [] };
  const headers = values[0].map((h) => String(h));
  if (sheets._hdr) sheets._hdr[tab] = headers;
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
    bw: o['BW'], testedBw: o['Tested BW'] != null ? o['Tested BW'] : '', type: o['TC'], temper: o['TM'], litho: num(o['Litho']), status: o['Status'] || 'Current',
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
  let removedAt = 0;   // taking a ticket off a job voids every coat logged before that
  (history || []).forEach((h) => {
    const m = /^VOID#(\d+):/.exec(String(h.notes || '')); if (m) voided[m[1]] = true;
    if (String(h.item || '') === 'REMOVED FROM JOB (VOID)' && num(h.passNumber) > removedAt) removedAt = num(h.passNumber);
  });
  return (history || []).filter((h) => String(h.group || '').trim() !== '' && num(h.passTotal) > 0 && !voided[String(h.passNumber)] && num(h.passNumber) > removedAt)
    .map((h) => ({ passNumber: h.passNumber, group: h.group, sub: h.sub, item: h.item, chemCode: h.chemCode, cost: num(h.passTotal),
      date: toYMD(h.timestamp), by: h.operator || '', jobName: h.jobName || '', jobId: h.jobId || '' }));
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
// Point-in-time snapshot: writes the active rows (Current + WIP + Pending, exactly as they are,
// all columns) into a NEW dated tab in a separate "snapshots" spreadsheet you own and have shared
// with the service account (SNAPSHOT_SHEET_ID). Each tab is right-sized to the data so the archive
// uses the fewest cells possible. Only the spreadsheets scope is required.
// opts.skipIfExists (used by the daily scheduler): if a tab for today already exists, do nothing
// and report skipped instead of writing a second "(2)" tab.
async function snapshotCurrentWip(sheets, env, opId, opts) {
  opts = opts || {};
  const snapId = (env && env.SNAPSHOT_SHEET_ID) || '';
  if (!snapId) {
    throw new Error('No snapshots spreadsheet is set up yet. Create a Google Sheet, share it with the service account as Editor, and set SNAPSHOT_SHEET_ID to its ID.');
  }
  const master = await readObjects(sheets, MASTER);
  const headers = master.headers.slice();
  const rows = master.rows.filter((o) => {
    const s = String(o['Status'] || '').trim();
    return s === STATUS.CURRENT || s === STATUS.WIP || s === STATUS.PENDING;
  });
  const current = rows.filter((o) => String(o['Status']).trim() === STATUS.CURRENT).length;
  const wip = rows.filter((o) => String(o['Status']).trim() === STATUS.WIP).length;
  const pending = rows.filter((o) => String(o['Status']).trim() === STATUS.PENDING).length;
  // Grid = header row + one row per skid, values in header order.
  const grid = [headers];
  rows.forEach((o) => grid.push(headers.map((h) => (o[h] == null ? '' : o[h]))));
  // Tab name = today's date (Pacific).
  let existing = new Set();
  try { existing = new Set(((await sheets.metaOf(snapId)).sheets || []).map((s) => s.properties.title)); }
  catch (e) { throw new Error('Could not open the snapshots spreadsheet (' + snapId + '). Make sure it is shared with the service account as Editor. ' + e.message); }
  const dateName = opts.dateName || todayYMD();
  if (opts.skipIfExists && existing.has(dateName)) {
    return { ok: true, skipped: true, tab: dateName, current, wip, pending, total: rows.length, spreadsheetId: snapId };
  }
  // Manual re-runs the same day get "(2)", "(3)"...
  let title = dateName; let n = 2;
  while (existing.has(title)) { title = dateName + ' (' + n + ')'; n++; }
  // Insert at index 1 so the newest date tab sits just right of "Failure Report" (index 0),
  // pushing older date tabs further right — newest always stays leftmost-but-one.
  await sheets.addSheetTo(snapId, title, grid.length, headers.length, 1);
  await sheets.writeValues(snapId, "'" + title + "'!A1", grid);
  return { ok: true, tab: title, current, wip, pending, total: rows.length, spreadsheetId: snapId };
}
// Date string (YYYY-MM-DD, Pacific) for N days ago.
function ymdDaysAgo(n) {
  const d = new Date(Date.now() - (Number(n) || 0) * 86400000);
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }
  catch (e) { return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }
}
// TEST helper: seed the snapshots spreadsheet with several back-dated day tabs (today, yesterday, ...)
// using the current live data, so you can see what a few days of the daily archive looks like without
// waiting. Idempotent — re-running skips days that already have a tab. Cap 14 days.
async function seedSnapshots(sheets, env, count, opId) {
  const n = Math.max(1, Math.min(Number(count) || 3, 14));
  const days = [];
  for (let i = n - 1; i >= 0; i--) {   // oldest first so tabs land in date order
    const dateName = ymdDaysAgo(i);
    const r = await snapshotCurrentWip(sheets, env, (opId || 'seed') + '-' + i, { dateName, skipIfExists: true });
    days.push({ date: dateName, tab: r.tab, skipped: !!r.skipped, total: r.total, current: r.current, wip: r.wip, pending: r.pending });
  }
  const created = days.filter((d) => !d.skipped).length;
  return { ok: true, requested: n, created, skipped: n - created, days };
}
async function getJobDetail(sheets, jobId) {
  const jobs = await readObjects(sheets, JOBS, true);
  const job = jobs.rows.filter((o) => String(o['Job ID']).trim() === String(jobId).trim())[0];
  if (!job) throw new Error('Job not found: ' + jobId);
  let recipe = []; try { recipe = JSON.parse(job['Coatings JSON'] || '[]') || []; } catch (e) { recipe = []; }
  const master = await readObjects(sheets, MASTER);
  const tickets = master.rows.filter((o) => String(o['Job ID']).trim() === String(jobId).trim()).map((o) => ({
    skidId: o['Skid ID'], ticket: o['Ticket'], status: o['Status'], litho: num(o['Litho']), bw: o['BW'], testedBw: o['Tested BW'] != null ? o['Tested BW'] : '', type: o['TC'], temper: o['TM'], endUse: o['End Use'],
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

// Each tab's unique key column: after an unclear append failure we look this value up to see
// whether the row actually got saved before trying again (so a retry can't add it twice).
const APPEND_KEYS = { [MASTER]: 'Skid ID', [TRANSACTIONS]: 'Op ID', [JOBS]: 'Job ID', [PRODUCTION]: 'Run ID',
  [SLITTER_SESSIONS]: 'Session ID', [SLITTER_PALLETS]: 'Pallet ID', [COUNTS]: 'Session ID', [RECEIVERS]: 'Receiver ID' };

// Is `value` already in column `name` of `tab`? (Reads just that one column.)
async function columnHas(sheets, tab, headers, name, value) {
  const c = mapOf(headers)[name];
  if (!c) return false;
  const L = colLetter(c);
  const vals = await sheets.read("'" + tab + "'!" + L + '2:' + L);
  const want = String(value).trim();
  return vals.some((r) => String((r && r[0]) != null ? r[0] : '').trim() === want);
}

// Appends a row built from an object, in the sheet's header order.
async function appendRowObj(sheets, tab, headers, obj) {
  const row = headers.map((h) => (obj.hasOwnProperty(h) ? obj[h] : ''));
  const key = APPEND_KEYS[tab];
  const keyVal = key && obj[key] != null ? String(obj[key]).trim() : '';
  await sheets.append(tab, row, keyVal ? () => columnHas(sheets, tab, headers, key, keyVal) : null);
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
  if (sheets._hdr) sheets._hdr[tab] = h2;
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

// ---- opId bookkeeping: how a retried action avoids doing its work twice ----
// Every user action carries an opId. The Transactions row that finishes the action is logged
// with that opId, so a retry of an action that already finished is recognized and skipped.
//
// Many actions take several writes (update the skid, then log it; or mark 10 skids Used). If one
// fails halfway, the retry (same opId) must pick up where it stopped — not redo the finished part
// (e.g. add a coating's cost twice) and not skip the unfinished part. Two tools make that work:
//   * subOp(opId, tag): each step's own log row gets "<opId>#<tag>", so a retry can see which
//     steps already happened.
//   * 'Last Op ID' on Steel Tickets: written in the SAME call as a skid's change, so a retry can
//     tell "this skid was already updated by this action" even if the log row never got written.
function subOp(opId, tag) { return opId ? opId + '#' + tag : ''; }
function autoOpId() { return 'auto-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }

// Header row of a tab (cached for the rest of this request).
async function tabHeaders(sheets, tab) {
  if (sheets._hdr && sheets._hdr[tab]) return sheets._hdr[tab];
  const v = await sheets.read("'" + tab + "'!1:1");
  const headers = (v[0] || []).map((h) => String(h));
  if (sheets._hdr) sheets._hdr[tab] = headers;
  return headers;
}
// Every Op ID in Transactions, read once per request (just that column) and kept up to date as
// this request logs more rows.
async function opIdSet(sheets) {
  if (sheets._ops) return sheets._ops;
  const set = new Set();
  const headers = await tabHeaders(sheets, TRANSACTIONS);
  const c = mapOf(headers)['Op ID'];
  if (c) {
    const L = colLetter(c);
    (await sheets.read("'" + TRANSACTIONS + "'!" + L + '2:' + L)).forEach((r) => {
      const v = String((r && r[0]) != null ? r[0] : '').trim(); if (v) set.add(v);
    });
  }
  sheets._ops = set;
  return set;
}
async function opAlreadyDone(sheets, opId) {
  if (!opId) return false;
  return (await opIdSet(sheets)).has(String(opId).trim());
}

async function appendTx(sheets, obj, opId) {
  let headers = await tabHeaders(sheets, TRANSACTIONS);
  if (headers.indexOf('Op ID') === -1) { const e = await ensureColumn(sheets, TRANSACTIONS, headers, 'Op ID'); headers = e.headers; }
  if (headers.indexOf('Job ID') === -1) { const e = await ensureColumn(sheets, TRANSACTIONS, headers, 'Job ID'); headers = e.headers; }
  // Every row gets an Op ID (a generated one for rows that aren't an action's own record), so an
  // unclear append failure can always be checked before retrying.
  obj['Op ID'] = opId || autoOpId();
  await appendRowObj(sheets, TRANSACTIONS, headers, obj);
  if (sheets._ops) sheets._ops.add(obj['Op ID']);
}

// Make sure Steel Tickets has the 'Last Op ID' column; returns the (possibly re-read) master tab.
async function withLastOpCol(sheets, master) {
  if (master.map['Last Op ID']) return master;
  await ensureColumn(sheets, MASTER, master.headers, 'Last Op ID');
  return readTab(sheets, MASTER);
}
function stampedBy(obj, opId) { return !!opId && String((obj && obj['Last Op ID']) || '').trim() === String(opId).trim(); }
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

// ---- applyCoating: the core write (Current -> WIP/Pending, or add a coat to WIP/Pending) ----
// Retry-safe (see "opId bookkeeping"): the skid's change is ONE write that also stamps
// 'Last Op ID', and the coating's Transactions row (carrying the opId) is written last. If the
// action dies in between, the retry sees the stamp, skips the skid change, and just writes the
// missing log row — instead of stacking the cost a second time.
async function applyCoating(sheets, skidId, group, sub, itemName, operatorName, notes, sheetsRun, isPartialSkid, lithoNote, jobName, opId, firstStatus, jobId, coatedTicket) {
  if (await opAlreadyDone(sheets, opId)) return { duplicate: true, skidId };
  if (!group || !itemName) throw new Error('Pick a size/group and coating item.');
  const match = await findRate(sheets, group, sub, itemName);
  if (!match) throw new Error('Could not find rate for item: ' + itemName);
  await normalizeMasterRows(sheets);

  const master = await withLastOpCol(sheets, await readTab(sheets, MASTER));
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
  const mergedNotes = (text) => {   // Litho Notes after appending `text` (written in the same call as the skid change)
    const existing = obj['Litho Notes'] || '';
    return text ? (existing ? existing + ' | ' : '') + text : existing;
  };

  const result = { skidId, ticket, sheetsRun: null, estimatedWeightUsed: null, isPartial: false,
    remainderTicket: null, remainderSheets: 0, remainderWeight: 0, scrapSheets: 0, scrapWeight: 0 };

  // RESUME: an earlier attempt of this same action already updated the skid (and made the split
  // leftover, if any) but didn't get to log it. Finish the logging only.
  if (stampedBy(obj, opId)) {
    const rem = master.rows.filter((o) => o !== obj && stampedBy(o, opId))[0];
    if (rem && !(await opAlreadyDone(sheets, subOp(opId, 'split')))) {
      await eventTx(sheets, { skidId: rem['Skid ID'], ticket: rem['Ticket'], itemText: 'SPLIT REMAINDER CREATED', operator: operatorName,
        note: num(rem['QTY/LOAD']) + ' sheets (~' + num(rem['Weight']) + ' lbs, estimated) of ' + baseTicketOf(ticket) + ' left in Current; coated batch is ' + ticket, runningTotal: 0 }, subOp(opId, 'split'));
    }
    await logCoatingTx(sheets, { skidId, ticket, passNumber: nextPass, operator: operatorName, group, sub, item: itemName, match,
      runningTotal: num(obj['Litho']), notes, jobName, jobId: jobId || obj['Job ID'] || '' }, opId);
    Object.assign(result, { ticket, litho: num(obj['Litho']), sheetsRun: num(obj['QTY/LOAD']), isPartial: !!rem,
      remainderTicket: rem ? rem['Ticket'] : null, remainderSheets: rem ? num(rem['QTY/LOAD']) : 0, remainderWeight: rem ? num(rem['Weight']) : 0 });
    if (rem) result.coatedTicket = ticket;
    result.detail = await getTicketCard(sheets, skidId);
    return result;
  }

  // Another coat on a Pending/WIP skid: stack the cost on top of what it already has. When this
  // happens inside a job (jobId provided) — i.e. an already-coated WIP skid is added to a job for
  // another pass — also ATTACH it: move it into the job as Pending so it rides the normal
  // review/approve flow (approve -> WIP). Ad-hoc re-coats from the card pass no jobId and just add cost.
  if (status === STATUS.WIP || status === STATUS.PENDING) {
    const newTotal = Math.round(((num(obj['Litho'])) + match.totalCost) * 100) / 100;
    const stamp = { 'Litho': newTotal, 'Last Updated At': nowStamp(), 'Last Updated By': operatorName || '', 'Last Op ID': opId || '' };
    if (lithoNoteClean) stamp['Litho Notes'] = mergedNotes(lithoNoteClean);
    if (jobId) { stamp['Status'] = firstStatus || STATUS.PENDING; stamp['Job ID'] = jobId; stamp['Row'] = ''; }   // attached to a job -> leaving its storage row
    await stampCells(sheets, MASTER, row, map, stamp);
    await logCoatingTx(sheets, { skidId, ticket, passNumber: nextPass, operator: operatorName, group, sub, item: itemName, match, runningTotal: newTotal, notes, jobName, jobId: jobId || obj['Job ID'] || '' }, opId);
    result.litho = newTotal;
    result.detail = await getTicketCard(sheets, skidId);
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
  // A leftover already made by an earlier attempt of this action (it died before updating the
  // coated skid): reuse it rather than splitting off a second one.
  const priorRem = isPartialSkid ? master.rows.filter((o) => o !== obj && stampedBy(o, opId))[0] : null;
  if (usedFewer && isPartialSkid) {
    coatedTicketFinal = String(coatedTicket || '').trim() || await findRemainderTicketId(master.rows, ticket, 'LR');
    const pref = base + '-LR';
    const okName = coatedTicketFinal.indexOf(pref) === 0 && /^\d+$/.test(coatedTicketFinal.slice(pref.length));
    if (!okName) throw new Error('New ticket must look like ' + base + '-LR1 (the original number plus -LR and a number).');
    if (master.rows.some((o) => o !== obj && o !== priorRem && String(o['Ticket']).trim() === coatedTicketFinal)) {
      throw new Error('Ticket ' + coatedTicketFinal + ' is already in use — pick a different number.');
    }
    if (priorRem) leftoverTicket = priorRem['Ticket'];
    else {
      // Leftover keeps the bare original ticket, unless some other live row already holds it.
      const baseFree = !master.rows.some((o) => o !== obj && String(o['Ticket']).trim() === base);
      leftoverTicket = baseFree ? base : await findRemainderTicketId(master.rows.concat([{ 'Ticket': coatedTicketFinal }]), ticket, 'LR');
    }
  }

  let scrapNote = '';
  // The split leftover is created BEFORE the coated skid is changed, so a retry still has the
  // original sheet count/weight to work from (the leftover is found again by its Last Op ID).
  if (usedFewer && isPartialSkid) {
    result.remainderTicket = leftoverTicket;   // the ORIGINAL ticket, returned to Current
    result.coatedTicket = coatedTicketFinal;
    result.remainderSheets = originalQty - sheets_;
    result.remainderWeight = Math.round((originalWeight - estimatedWeightUsed) * 100) / 100;
    if (!priorRem) {
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
        'Last Op ID': opId || '',
      });
      await appendRowObj(sheets, MASTER, master.headers, remObj);
      await eventTx(sheets, { skidId: remainderSkid, ticket: leftoverTicket, itemText: 'SPLIT REMAINDER CREATED', operator: operatorName, note: result.remainderSheets + ' sheets (~' + result.remainderWeight + ' lbs, estimated) of ' + base + ' left in Current; coated ' + sheets_ + ' became ' + coatedTicketFinal, runningTotal: 0 }, subOp(opId, 'split'));
    } else if (!(await opAlreadyDone(sheets, subOp(opId, 'split')))) {
      await eventTx(sheets, { skidId: priorRem['Skid ID'], ticket: leftoverTicket, itemText: 'SPLIT REMAINDER CREATED', operator: operatorName, note: result.remainderSheets + ' sheets (~' + result.remainderWeight + ' lbs, estimated) of ' + base + ' left in Current; coated ' + sheets_ + ' became ' + coatedTicketFinal, runningTotal: 0 }, subOp(opId, 'split'));
    }
  } else if (usedFewer) {
    result.scrapSheets = originalQty - sheets_;
    result.scrapWeight = Math.round((originalWeight - estimatedWeightUsed) * 100) / 100;
    scrapNote = 'Scrapped ' + result.scrapSheets + ' sheets (~' + result.scrapWeight + ' lbs, estimated) of ' + originalQty + ' on hand';
  }

  // One write for the whole skid change (status, cost, qty, spoilage, notes, Last Op ID).
  const stamp = { 'Status': firstStatus || STATUS.WIP, 'Job ID': jobId || '', 'Litho': match.totalCost, 'Row': '',   // coated -> moved out of its storage row
    'First Coated At': nowStamp(), 'First Coated By': operatorName || '', 'Last Updated At': nowStamp(), 'Last Updated By': operatorName || '',
    'Last Op ID': opId || '' };
  if (usedFewer) { stamp['QTY/LOAD'] = sheets_; stamp['Weight'] = estimatedWeightUsed; }
  if (usedFewer && isPartialSkid) { stamp['Ticket'] = coatedTicketFinal; } // this record becomes the coated -LR# piece
  if (result.scrapSheets && map['Spoilage']) stamp['Spoilage'] = num(obj['Spoilage']) + result.scrapSheets;
  const noteText = [lithoNoteClean, scrapNote].filter(Boolean).join(' | ');
  if (noteText) stamp['Litho Notes'] = mergedNotes(noteText);
  await stampCells(sheets, MASTER, row, map, stamp);

  await logCoatingTx(sheets, { skidId, ticket: coatedTicketFinal, passNumber: nextPass, operator: operatorName, group, sub, item: itemName, match, runningTotal: match.totalCost, notes: [notes, scrapNote].filter(Boolean).join(' | '), jobName, jobId: jobId || '' }, opId);

  result.ticket = coatedTicketFinal;   // the coated piece now carries the -LR# ticket (obj kept its SKD)
  result.sheetsRun = sheets_;
  result.estimatedWeightUsed = estimatedWeightUsed;
  result.isPartial = isPartialSkid;
  result.litho = match.totalCost;
  result.detail = await getTicketCard(sheets, skidId);
  return result;
}

// ---- createManualTicket: add a Current row with steel specs from the paper ticket ----
// ticket may be blank ("ticket not available" bypass); fields carries the steel specs.
async function createManualTicket(sheets, ticket, fields, operatorName, opId) {
  if (await opAlreadyDone(sheets, opId)) return { duplicate: true, ticket };
  ticket = String(ticket || '').trim();
  fields = fields || {};
  await normalizeMasterRows(sheets);
  let master = await withLastOpCol(sheets, await readTab(sheets, MASTER));
  let headers = master.headers;
  for (const k of TICKET_DETAIL_COLS) { if (headers.indexOf(k) === -1) { const e = await ensureColumn(sheets, MASTER, headers, k); headers = e.headers; } }
  // Retry of an attempt that saved the skid but not its log entry: log it, don't add a 2nd skid.
  const prior = master.rows.filter((o) => stampedBy(o, opId))[0];
  if (prior) {
    await eventTx(sheets, { skidId: prior['Skid ID'], ticket: prior['Ticket'], itemText: 'MANUAL TICKET CREATED', operator: operatorName,
      note: prior['Ticket'] ? 'Ticket manually created in app' : 'Skid created without a ticket number (ticket not available)', runningTotal: 0 }, opId);
    return getTicketCard(sheets, prior['Skid ID']);
  }

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
  const row = { 'Ticket': ticket, 'Skid ID': skidId, 'Status': STATUS.CURRENT, 'Last Updated At': nowStamp(), 'Last Updated By': operatorName || '', 'Last Op ID': opId || '' };
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
  const master = await withLastOpCol(sheets, await readTab(sheets, MASTER));
  if (!master.map['Litho']) throw new Error('Steel Tickets sheet has no Litho column.');
  const obj = master.rows.filter((o) => String(o['Skid ID']).trim() === String(skidId).trim())[0];
  if (!obj) throw new Error('Skid not found: ' + skidId);
  const n = typedNum(newCost);   // a blank box used to become $0.00 here
  if (isNaN(n) || n < 0) throw new Error('Enter the litho cost as a number (0 or more).');
  const resumed = stampedBy(obj, opId);   // earlier attempt already saved the cost; just log it
  const oldCost = resumed ? NaN : num(obj['Litho']);
  if (!resumed) await stampCells(sheets, MASTER, obj.__row, master.map, { 'Litho': n, 'Last Updated At': nowStamp(), 'Last Updated By': operator || '', 'Last Op ID': opId || '' });
  const hist = await getTransactionHistory(sheets, skidId, obj['Ticket']);
  const nextPass = hist.length ? Math.max.apply(null, hist.map((h) => num(h.passNumber))) + 1 : 1;
  await appendTx(sheets, { 'Timestamp': nowStamp(), 'Ticket': obj['Ticket'], 'Pass Number': nextPass, 'Operator': operator || '',
    'Group': '', 'Sub-Variant': '', 'Item': 'MANUAL COST ADJUSTMENT', 'Chem Code': '', 'Application Cost': 0, 'Line Cost': 0,
    'Pass Total Cost': resumed ? 0 : Math.round((n - oldCost) * 100) / 100, 'Running Total After Pass': n,
    'Notes': (resumed ? 'Litho cost set to ' + n.toFixed(2) : 'Litho cost changed from ' + oldCost.toFixed(2) + ' to ' + n.toFixed(2)) + (notes ? ' — ' + notes : ''), 'Job Name': '', 'Skid ID': skidId }, opId);
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
  master = await withLastOpCol(sheets, await readTab(sheets, MASTER));
  const obj = master.rows.filter((o) => String(o['Skid ID']).trim() === String(skidId).trim())[0];
  if (!obj) throw new Error('Skid not found: ' + skidId);
  if (stampedBy(obj, opId)) {   // earlier attempt saved the edits but not the log entry
    const saved = editable.filter((k) => fields.hasOwnProperty(k)).map((k) => (TICKET_COL_LABELS[k] || k) + ' "' + String(obj[k] == null ? '' : obj[k]) + '"');
    await eventTx(sheets, { skidId, ticket: obj['Ticket'], itemText: 'TICKET DETAILS EDITED', operator, note: 'Saved: ' + saved.join('; '), runningTotal: num(obj['Litho']) }, opId);
    return getTicketCard(sheets, skidId);
  }

  const changes = {}, notes = [];
  for (const k of editable) {
    if (!fields.hasOwnProperty(k)) continue;
    const label = TICKET_COL_LABELS[k] || k;
    if (TICKET_NUMERIC_COLS[k]) {
      const raw = fields[k];
      if (raw === '' || raw == null) continue; // leave numeric fields untouched when blank
      const nv = typedNum(raw);   // accepts "1,234"
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
  changes['Last Updated At'] = nowStamp(); changes['Last Updated By'] = operator || ''; changes['Last Op ID'] = opId || '';
  await stampCells(sheets, MASTER, obj.__row, master.map, changes);
  await eventTx(sheets, { skidId, ticket: obj['Ticket'], itemText: 'TICKET DETAILS EDITED', operator, note: notes.join('; '), runningTotal: num(obj['Litho']) }, opId);
  return getTicketCard(sheets, skidId);
}

async function loadCoatingForEdit(sheets, skidId, passNumber) {
  await normalizeMasterRows(sheets);
  const master = await withLastOpCol(sheets, await readTab(sheets, MASTER));
  const obj = master.rows.filter((o) => String(o['Skid ID']).trim() === String(skidId).trim())[0];
  if (!obj) throw new Error('Skid not found: ' + skidId);
  const history = await getTransactionHistory(sheets, skidId, obj['Ticket']);
  const active = activeCoatings(history);
  const target = active.filter((c) => String(c.passNumber) === String(passNumber))[0];
  if (!target) throw new Error('That coating is no longer on the ticket (it may have already been changed).');
  const nextPass = history.length ? Math.max.apply(null, history.map((h) => num(h.passNumber))) + 1 : 1;
  return { map: master.map, row: obj.__row, obj, target, nextPass };
}

// Order matters for retries: (1) the skid's new cost + Last Op ID, (2) the replacement coating's
// log row, (3) the VOID of the old pass, which carries the opId and so marks the action done. Until
// (3) is written the old pass is still "active", so a retry passes the checks and finishes the
// remaining steps without re-applying the cost change.
async function editTicketCoating(sheets, skidId, passNumber, group, sub, item, operator, opId) {
  if (await opAlreadyDone(sheets, opId)) return { duplicate: true, skidId };
  if (!group || !item) throw new Error('Pick a size/group and coating item.');
  const match = await findRate(sheets, group, sub, item);
  if (!match) throw new Error('Could not find rate for item: ' + item);
  const ctx = await loadCoatingForEdit(sheets, skidId, passNumber);
  const oldCost = num(ctx.target.cost), newCost = num(match.totalCost);
  const resumed = stampedBy(ctx.obj, opId);
  const currentLitho = num(ctx.obj['Litho']);
  const afterNew = resumed ? currentLitho : Math.round((currentLitho - oldCost + newCost) * 100) / 100;
  const afterVoid = Math.round((afterNew - newCost) * 100) / 100;
  const ticket = ctx.obj['Ticket'], jobId = ctx.obj['Job ID'] || '';
  if (!resumed) await stampCells(sheets, MASTER, ctx.row, ctx.map, { 'Litho': afterNew, 'Last Updated At': nowStamp(), 'Last Updated By': operator || '', 'Last Op ID': opId || '' });
  if (!(await opAlreadyDone(sheets, subOp(opId, 'new')))) {
    await logCoatingTx(sheets, { skidId, ticket, passNumber: ctx.nextPass + 1, operator, group, sub, item, match, runningTotal: afterNew, notes: 'Correction of pass ' + passNumber, jobName: jobId, jobId }, subOp(opId, 'new'));
  }
  await appendTx(sheets, { 'Timestamp': nowStamp(), 'Ticket': ticket, 'Pass Number': ctx.nextPass, 'Operator': operator || '',
    'Group': '', 'Sub-Variant': '', 'Item': 'COATING CHANGED (VOID)', 'Chem Code': '', 'Application Cost': 0, 'Line Cost': 0,
    'Pass Total Cost': -oldCost, 'Running Total After Pass': afterVoid,
    'Notes': 'VOID#' + passNumber + ': corrected ' + ctx.target.item + ' (' + oldCost.toFixed(2) + ') -> ' + item + ' (' + newCost.toFixed(2) + ')', 'Job Name': jobId, 'Job ID': jobId, 'Skid ID': skidId }, opId);
  return getTicketCard(sheets, skidId);
}

// Same idea: the cost change (with Last Op ID) first, then the VOID row that marks it done.
async function removeTicketCoating(sheets, skidId, passNumber, operator, opId) {
  if (await opAlreadyDone(sheets, opId)) return { duplicate: true, skidId };
  const ctx = await loadCoatingForEdit(sheets, skidId, passNumber);
  const oldCost = num(ctx.target.cost);
  const resumed = stampedBy(ctx.obj, opId);
  const afterVoid = resumed ? num(ctx.obj['Litho']) : Math.round((num(ctx.obj['Litho']) - oldCost) * 100) / 100;
  if (!resumed) await stampCells(sheets, MASTER, ctx.row, ctx.map, { 'Litho': afterVoid, 'Last Updated At': nowStamp(), 'Last Updated By': operator || '', 'Last Op ID': opId || '' });
  await appendTx(sheets, { 'Timestamp': nowStamp(), 'Ticket': ctx.obj['Ticket'], 'Pass Number': ctx.nextPass, 'Operator': operator || '',
    'Group': '', 'Sub-Variant': '', 'Item': 'COATING REMOVED (VOID)', 'Chem Code': '', 'Application Cost': 0, 'Line Cost': 0,
    'Pass Total Cost': -oldCost, 'Running Total After Pass': afterVoid,
    'Notes': 'VOID#' + passNumber + ': removed ' + ctx.target.item + ' (' + oldCost.toFixed(2) + ')', 'Job Name': ctx.obj['Job ID'] || '', 'Job ID': ctx.obj['Job ID'] || '', 'Skid ID': skidId }, opId);
  return getTicketCard(sheets, skidId);
}

// ---- jobs ----
async function createJob(sheets, description, operator, coatings, notes, opId) {
  const jobs0 = await readTab(sheets, JOBS);
  const prior = opId && jobs0.headers.indexOf('Op ID') !== -1 ? jobs0.rows.filter((r) => String(r['Op ID'] || '').trim() === String(opId).trim())[0] : null;
  if (prior) {   // retry of a create that already worked: hand back that job so the app carries on with it
    let recipe = []; try { recipe = JSON.parse(prior['Coatings JSON'] || '[]') || []; } catch (e) { recipe = []; }
    return { duplicate: true, jobId: prior['Job ID'], description: prior['Description'] || '', coatings: recipe, status: prior['Status'] || 'Pending' };
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

// Applies the job's whole recipe to one skid. Each coat is its own retry-safe step (coat 0 uses
// the opId, coat i uses "<opId>#c<i>"), so a retry after a failure part-way through the recipe
// finishes the missing coats instead of stopping at "already recorded".
// testedBW (optional): the basis weight the floor measured on this skid. Saved to the skid's
// 'Tested BW' column (added to Steel Tickets the first time it's used), next to the nominal BW.
// For a partial skid it goes on the coated skid that joins the job. Re-writing it is harmless,
// so a retried add simply sets it again.
async function jobAddTicket(sheets, jobId, skidId, sheetsRun, isPartialSkid, lithoNote, operator, opId, coatedTicket, testedBW) {
  const testedRaw = String(testedBW == null ? '' : testedBW).trim();
  const tested = testedRaw === '' ? null : typedNum(testedRaw);
  if (tested !== null && !(tested > 0)) throw new Error('Tested BW must be a number, e.g. 75.2');
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
  const resuming = !!opId && !!existing && String(existing['Last Op ID'] || '').indexOf(opId) === 0;   // this action already started on it
  if (existing && !resuming) {
    const onJob = String(existing['Job ID'] || '').trim();
    const st = existing['Status'] || STATUS.CURRENT;
    if (onJob === String(jobId).trim() && st !== STATUS.CURRENT) {
      throw new Error('Ticket ' + (existing['Ticket'] || skidId) + ' is already on job ' + jobId + '.');
    }
    if (onJob && onJob !== String(jobId).trim() && st === STATUS.PENDING) {
      throw new Error('Ticket ' + (existing['Ticket'] || skidId) + ' is Pending on another job (' + onJob + '). Remove it from that job first.');
    }
  }
  let result = null;
  for (let i = 0; i < recipe.length; i++) {
    const c = recipe[i];
    const r = await applyCoating(sheets, skidId, c.group, c.sub, c.item, operator, '',
      i === 0 ? sheetsRun : '', i === 0 ? isPartialSkid : false, i === 0 ? lithoNote : '',
      desc, i === 0 ? opId : subOp(opId, 'c' + i), STATUS.PENDING, jobId, i === 0 ? coatedTicket : '');
    if (r && !r.duplicate) {
      if (!result) result = r;
      else if (r.litho !== undefined) { result.litho = r.litho; result.detail = r.detail; }
    }
  }
  let masterNow = await readTab(sheets, MASTER);
  if (tested !== null) {
    if (!masterNow.map['Tested BW']) {
      await ensureColumn(sheets, MASTER, masterNow.headers, 'Tested BW');
      masterNow = await readTab(sheets, MASTER);
    }
    const onJob = masterNow.rows.filter((o) => String(o['Skid ID']).trim() === String(skidId).trim())[0];
    if (onJob) await stampCells(sheets, MASTER, onJob.__row, masterNow.map, { 'Tested BW': tested });
  }
  const count = masterNow.rows.filter((o) => String(o['Job ID']).trim() === String(jobId).trim()).length;
  await stampCells(sheets, JOBS, job.__row, jobs.map, { 'Ticket Count': count });
  if (!result) {   // every coat was already recorded (a retry of an add that had finished)
    const card = await getTicketCard(sheets, skidId);
    result = { skidId, ticket: card.ticket, litho: card.litho, detail: card, isPartial: false, remainderTicket: null, remainderSheets: 0, scrapSheets: 0 };
  }
  result.jobId = jobId;
  if (tested !== null) result.testedBw = tested;   // the page checks this came back (an older Worker ignored the value)
  return result;
}

// The recipe entry remembers the opId that added it, and each Pending skid gets the coat under
// "<opId>#<skidId>" — so a retry neither adds the coating to the recipe twice nor coats a skid twice.
async function addCoatingToJob(sheets, jobId, coating, operator, opId) {
  await validateCoatings(sheets, [coating]);
  const jobs = await readTab(sheets, JOBS);
  const job = jobs.rows.filter((o) => String(o['Job ID']).trim() === String(jobId).trim())[0];
  if (!job) throw new Error('Job not found: ' + jobId);
  if (String(job['Status']) === 'Approved') throw new Error('Job is approved and locked.');
  let recipe = []; try { recipe = JSON.parse(job['Coatings JSON'] || '[]') || []; } catch (e) { recipe = []; }
  if (!(opId && recipe.some((c) => c && c.op === opId))) {
    const entry = { group: coating.group, sub: coating.sub || '', item: coating.item };
    if (opId) entry.op = opId;
    recipe.push(entry);
    await stampCells(sheets, JOBS, job.__row, jobs.map, { 'Coatings JSON': JSON.stringify(recipe), 'Coatings': coatingSummary(recipe) });
  }
  const desc = job['Description'];
  const pend = (await readTab(sheets, MASTER)).rows.filter((o) => String(o['Job ID']).trim() === String(jobId).trim() && (o['Status'] || '') === STATUS.PENDING);
  for (let i = 0; i < pend.length; i++) {
    await applyCoating(sheets, pend[i]['Skid ID'], coating.group, coating.sub, coating.item, operator, '', '', false, '', desc, subOp(opId, pend[i]['Skid ID']), STATUS.PENDING, jobId);
  }
  return getJobDetail(sheets, jobId);
}

// Remainders split off `parentSkid` that are still untouched (Current, no litho). They fold back
// into the parent when its ticket leaves the job.
function splitRemaindersOf(master, parentSkid) {
  if (!master.map['Split Of']) return [];
  return master.rows.filter((o) => String(o['Split Of']).trim() === String(parentSkid).trim()
    && (o['Status'] || STATUS.CURRENT) === STATUS.CURRENT && !(num(o['Litho']) > 0));
}

// Order for retries: the skid's reset — including the sheets/weight folded back from its split
// remainders — is ONE write that stamps Last Op ID; then the remainders are voided (a no-op once
// done); then the Ticket Count; and the log row carrying the opId last.
async function removeTicketFromJob(sheets, jobId, skidId, operator, opId) {
  if (await opAlreadyDone(sheets, opId)) return getJobDetail(sheets, jobId);
  const jobs = await readTab(sheets, JOBS);
  const job = jobs.rows.filter((o) => String(o['Job ID']).trim() === String(jobId).trim())[0];
  if (!job) throw new Error('Job not found: ' + jobId);
  if (String(job['Status']) === 'Approved') throw new Error('Job is approved and locked.');
  const master = await withLastOpCol(sheets, await readTab(sheets, MASTER));
  const obj = master.rows.filter((o) => String(o['Skid ID']).trim() === String(skidId).trim())[0];
  if (!obj) throw new Error('Skid not found: ' + skidId);
  const resumed = stampedBy(obj, opId);
  if (!resumed && String(obj['Job ID']).trim() !== String(jobId).trim()) throw new Error('Skid is not part of this job.');
  const litho = resumed ? 0 : num(obj['Litho']);
  const rems = splitRemaindersOf(master, skidId);
  if (!resumed) {
    const addQty = rems.reduce((n, o) => n + num(o['QTY/LOAD']), 0);
    const addWeight = rems.reduce((n, o) => n + num(o['Weight']), 0);
    const stamp = { 'Status': STATUS.CURRENT, 'Job ID': '', 'Litho': '', 'First Coated At': '', 'First Coated By': '',
      'Last Updated At': nowStamp(), 'Last Updated By': operator || '', 'Last Op ID': opId || '' };
    if (addQty || addWeight) {
      stamp['QTY/LOAD'] = num(obj['QTY/LOAD']) + addQty;
      stamp['Weight'] = Math.round((num(obj['Weight']) + addWeight) * 100) / 100;
    }
    await stampCells(sheets, MASTER, obj.__row, master.map, stamp);
  }
  for (const o of rems) {
    await stampCells(sheets, MASTER, o.__row, master.map, { 'Status': 'Void', 'QTY/LOAD': 0, 'Weight': 0, 'Last Updated At': nowStamp(), 'Last Updated By': operator || '' });
    await eventTx(sheets, { skidId: o['Skid ID'], ticket: o['Ticket'], itemText: 'SPLIT REABSORBED', operator, note: 'Remainder folded back into ' + skidId + ' when its ticket left the job', runningTotal: 0 }, '');
  }
  const count = (await readTab(sheets, MASTER)).rows.filter((o) => String(o['Job ID']).trim() === String(jobId).trim()).length;
  await stampCells(sheets, JOBS, job.__row, jobs.map, { 'Ticket Count': count });
  const hist = await getTransactionHistory(sheets, skidId, obj['Ticket']);
  const nextPass = hist.length ? Math.max.apply(null, hist.map((h) => num(h.passNumber))) + 1 : 1;
  await appendTx(sheets, { 'Timestamp': nowStamp(), 'Ticket': obj['Ticket'], 'Pass Number': nextPass, 'Operator': operator || '',
    'Group': '', 'Sub-Variant': '', 'Item': 'REMOVED FROM JOB (VOID)', 'Chem Code': '', 'Application Cost': 0, 'Line Cost': 0,
    'Pass Total Cost': -litho, 'Running Total After Pass': 0, 'Notes': 'Removed from job ' + jobId + ' before approval; pending coatings voided', 'Job Name': '', 'Skid ID': skidId }, opId);
  return getJobDetail(sheets, jobId);
}

async function approveJob(sheets, jobId, operator, opId) {
  // Approval is naturally repeatable (already-WIP skids are skipped, an Approved job returns
  // early), so a retry after a partial run just finishes the rest. Each skid's move to WIP stamps
  // "<opId>#<skidId>" so a retry also writes any "JOB APPROVED" log entry that got missed.
  const jobs = await readTab(sheets, JOBS);
  const job = jobs.rows.filter((o) => String(o['Job ID']).trim() === String(jobId).trim())[0];
  if (!job) throw new Error('Job not found: ' + jobId);
  if (String(job['Status']) === 'Approved') return getJobDetail(sheets, jobId);
  const master = await withLastOpCol(sheets, await readTab(sheets, MASTER));
  for (const o of master.rows) {
    if (String(o['Job ID']).trim() !== String(jobId).trim()) continue;
    const step = subOp(opId, o['Skid ID']);
    const st = o['Status'] || '';
    const halfDone = st === STATUS.WIP && stampedBy(o, step) && !(await opAlreadyDone(sheets, step));
    if (st !== STATUS.PENDING && !halfDone) continue;
    if (!halfDone) await stampCells(sheets, MASTER, o.__row, master.map, { 'Status': STATUS.WIP, 'Approved At': nowStamp(), 'Approved By': operator || '', 'Last Updated At': nowStamp(), 'Last Updated By': operator || '', 'Last Op ID': step });
    await eventTx(sheets, { skidId: o['Skid ID'], ticket: o['Ticket'], itemText: 'JOB APPROVED', operator, note: 'Approved in job ' + jobId + ' — moved to WIP', jobId: jobId, runningTotal: num(o['Litho']) }, step);
  }
  await stampCells(sheets, JOBS, job.__row, jobs.map, { 'Status': 'Approved', 'Approved At': nowStamp(), 'Approved By': operator || '' });
  return getJobDetail(sheets, jobId);
}

// ---- Batch coating removal (Move To WIP and the Database Master sheet) ----
// A skid's log history from a traceContext (Skid ID rows, plus legacy rows matched by ticket).
function skidHist(ctx, o) {
  const sid = String(o['Skid ID'] || '').trim();
  return (ctx.bySkid[sid] || []).concat(ctx.byTicket[String(o['Ticket'] || '').trim()] || []).sort((a, b) => a.passNumber - b.passNumber);
}
function maxPassOf(hist) { return hist.reduce((n, h) => Math.max(n, num(h.passNumber)), 0); }
// Which of the requested passes are live coatings on this skid, and what taking them off costs.
// Each void row carries "<op>#<skid>#v<pass>"; `logged` marks one an earlier attempt already wrote.
function voidPlan(o, hist, passes, op, ops) {
  const sid = String(o['Skid ID']).trim();
  const want = {};
  (passes || []).forEach((p) => { want[String(p)] = true; });
  const removed = [];
  if (Object.keys(want).length) {
    activeCoatings(hist).forEach((c) => {
      if (!want[String(c.passNumber)]) return;
      const rowOp = subOp(op, sid + '#v' + c.passNumber);
      removed.push({ passNumber: c.passNumber, item: c.item, cost: num(c.cost), rowOp, logged: ops.has(rowOp) });
    });
  }
  return { removed, cost: Math.round(removed.filter((c) => !c.logged).reduce((n, c) => n + c.cost, 0) * 100) / 100 };
}
// Same log row removeTicketCoating writes, so activeCoatings / the card / reports treat it alike.
function voidRowObj(o, c, pass, running, operator, jobId, ts, rowOp) {
  return { 'Timestamp': ts, 'Ticket': o['Ticket'], 'Pass Number': pass, 'Operator': operator || '',
    'Group': '', 'Sub-Variant': '', 'Item': 'COATING REMOVED (VOID)', 'Chem Code': '', 'Application Cost': 0, 'Line Cost': 0,
    'Pass Total Cost': -c.cost, 'Running Total After Pass': running,
    'Notes': 'VOID#' + c.passNumber + ': removed ' + c.item + ' (' + c.cost.toFixed(2) + ')', 'Job Name': jobId || '', 'Job ID': jobId || '',
    'Skid ID': String(o['Skid ID']).trim(), 'Op ID': rowOp };
}
// One append for a batch of Transactions rows (adds Op ID / Job ID columns if missing).
async function appendTxRows(sheets, rows, ops) {
  if (!rows.length) return;
  let headers = await tabHeaders(sheets, TRANSACTIONS);
  for (const col of ['Op ID', 'Job ID']) if (headers.indexOf(col) === -1) headers = (await ensureColumn(sheets, TRANSACTIONS, headers, col)).headers;
  const values = rows.map((r) => headers.map((h) => (r.hasOwnProperty(h) ? r[h] : '')));
  const firstOp = rows[0]['Op ID'];
  await sheets.appendMany(TRANSACTIONS, values, () => columnHas(sheets, TRANSACTIONS, headers, 'Op ID', firstOp));
  rows.forEach((r) => ops.add(r['Op ID']));
}

// ---- One ticket's history (Database + Reports "History" panel) ----
// Every Transactions row for the skid (coatings, removals, jobs, runs, used, splits, edits), plus
// what only lives on other tabs: its count and missing stamps (Steel Tickets), the slitter / scroll
// loads cut from it (Slitter Pallets), the skid it was split / cut from, and the pieces made from
// it. Newest first. Read-only.
async function getSkidHistory(sheets, skidId) {
  skidId = String(skidId || '').trim();
  const master = await readTab(sheets, MASTER);
  const o = master.rows.filter((r) => String(r['Skid ID']).trim() === skidId)[0];
  if (!o) throw new Error('Skid not found: ' + skidId);
  const ctx = await traceContext(sheets, master.rows);
  const hist = skidHist(ctx, o);
  const live = {};
  activeCoatings(hist).forEach((c) => { live[String(c.passNumber)] = true; });
  const events = hist.map((h) => {
    const coat = String(h.group || '').trim() !== '' && num(h.passTotal) > 0;
    const item = String(h.item || '');
    return {
      when: String(h.timestamp || ''), date: toYMD(h.timestamp), kind: coat ? 'coat' : (/VOID/.test(item) ? 'void' : 'event'),
      what: coat ? 'Coated: ' + item : item, item, chemCode: h.chemCode || '', group: h.group || '', sub: h.sub || '',
      cost: coat ? num(h.passTotal) : (num(h.passTotal) || 0), running: h.runningTotal !== undefined ? h.runningTotal : '',
      by: h.operator || '', notes: h.notes || '', jobId: h.jobId || '', jobName: h.jobName || '', pass: h.passNumber,
      voided: coat && !live[String(h.passNumber)],
    };
  });
  const stamp = (col, byCol, what) => {
    if (!o[col]) return;
    events.push({ when: String(o[col]), date: toYMD(o[col]), kind: 'event', what, by: o[byCol] || '', notes: '', cost: 0 });
  };
  stamp('Counted At', 'Counted By', 'COUNTED (steel count)');
  stamp('Missing At', 'Missing By', 'MARKED MISSING (steel count)');
  // Used before the app logged it (imported rows): show the used date from the row itself.
  if (o['Status'] === STATUS.USED && usedAt(o) && !events.some((e) => /^USED IN PRODUCTION|FULLY CUT|COIL CUT/.test(e.what))) {
    events.push({ when: String(usedAt(o)), date: toYMD(usedAt(o)), kind: 'event', what: 'USED', by: o['Used By'] || '', notes: o['Used Via'] ? 'via ' + o['Used Via'] : '', cost: 0 });
  }
  // Slitter / scroll loads cut from this skid.
  const loads = [];
  try {
    const sess = {};
    (await readObjects(sheets, SLITTER_SESSIONS, true)).rows.forEach((x) => { if (x['Session ID']) sess[String(x['Session ID']).trim()] = x; });
    (await readObjects(sheets, SLITTER_PALLETS, true)).rows.forEach((p) => {
      if (!p['Pallet ID']) return;
      const part = parseComposition(p['Composition']).filter((c) => String(c.skidId || '').trim() === skidId)[0];
      if (!part) return;
      const se = sess[String(p['Session ID'] || '').trim()] || {};
      const used = part.strips != null ? part.strips : (part.qty || 0);
      loads.push({ loadNo: p['Load #'] || '', skidId: p['Skid ID'] || '', date: toYMD(p['Created On']), used, output: num(p['Output Count']), machine: se['Slitter'] || '', kind: se['Kind'] || 'Slitter' });
      events.push({ when: String(toYMD(p['Created On'])), date: toYMD(p['Created On']), kind: 'event', what: 'CUT INTO LOAD ' + (p['Load #'] || ''),
        by: se['Operator'] || '', notes: used + ' used on ' + (se['Slitter'] || 'the slitter') + '; pallet ' + (p['Skid ID'] || ''), cost: 0 });
    });
  } catch (e) { /* no slitter tabs */ }
  events.sort((a, b) => (a.when < b.when ? 1 : a.when > b.when ? -1 : (num(b.pass) - num(a.pass))));
  const brief = (r) => ({ skidId: r['Skid ID'] || '', ticket: r['Ticket'] || '', status: r['Status'] || '', qty: r['QTY/LOAD'] != null ? r['QTY/LOAD'] : '', weight: r['Weight'] != null ? r['Weight'] : '' });
  const parentRow = o['Split Of'] ? ctx.skids[String(o['Split Of']).trim()] : null;
  const children = master.rows.filter((r) => String(r['Split Of'] || '').trim() === skidId).map(brief);
  return {
    skid: Object.assign(traceOf(o, ctx), { skidId, ticket: o['Ticket'] || '', litho: num(o['Litho']), row: o['Row'] != null ? o['Row'] : '' }),
    events, parent: parentRow ? brief(parentRow) : (o['Split Of'] ? { skidId: o['Split Of'], ticket: '' } : null), children, loads,
    family: familyOf(master.rows, o['Ticket']),
  };
}

// ---- Database Master sheet ----
// Every ticket that's Current, WIP, Used or Pending, with its live coatings, for the Database
// "Master sheet" screen. One read of Steel Tickets, Transactions and Litho Jobs.
const MASTER_STATUSES = [STATUS.CURRENT, STATUS.WIP, STATUS.USED];
async function getMasterSheet(sheets) {
  const master = await readTab(sheets, MASTER);
  const ctx = await traceContext(sheets, master.rows);
  const out = [];
  master.rows.forEach((o) => {
    const st = o['Status'] || '';
    if (!(o['Ticket'] || o['Skid ID'])) return;
    if (MASTER_STATUSES.indexOf(st) === -1 && st !== STATUS.PENDING) return;
    const t = traceOf(o, ctx);
    out.push({ skidId: o['Skid ID'] || '', ticket: o['Ticket'] || '', status: st, litho: num(o['Litho']), mill: t.mill, customer: t.customer,
      jobId: t.jobId, qty: t.qty, usedOn: t.usedOn, po: t.po, receiver: t.receiver, receiverName: t.receiverName, receiverLink: t.receiverLink, receiverFrom: t.receiverFrom,
      receiverOwn: String(o['Receiver'] || '').trim(),
      coatings: activeCoatings(skidHist(ctx, o)).map((c) => ({ passNumber: c.passNumber, item: c.item, group: c.group || '', sub: c.sub || '', chemCode: c.chemCode || '', cost: c.cost, date: c.date })) });
  });
  return { rows: out, receivers: Object.keys(ctx.receivers).sort().map((id) => ({ id, name: receiverName(ctx.receivers[id]) })) };
}

// Save the Master sheet's marked changes in one go: move tickets between Current / WIP / Used and
// take coatings off. ONE Steel Tickets write and ONE log append for the whole batch. Pending tickets
// (on a job under review) can't be changed here. Leaving Used clears the used date; going to Used
// stamps today. Every change is logged (STATUS CHANGED / COATING REMOVED). Retry-safe: each skid's
// write stamps "<opId>#<skidId>" and each log row carries its own sub-op id.
async function masterEdit(sheets, changes, operator, opId) {
  operator = String(operator || '').trim() || 'Database';
  const list = (changes || []).filter((c) => c && String(c.skidId || '').trim());
  if (!list.length) throw new Error('No changes to save.');
  if (list.length > 300) throw new Error('Save at most 300 tickets at a time.');
  const op = opId || autoOpId();
  let master = await withLastOpCol(sheets, await readTab(sheets, MASTER));
  let hdr = master.headers;
  const cols = ['Used At', 'Used Via'];
  if (list.some((c) => c.receiver !== undefined && c.receiver !== null)) cols.push('Receiver');
  for (const col of cols) hdr = (await ensureColumn(sheets, MASTER, hdr, col)).headers;
  if (hdr !== master.headers) master = await readTab(sheets, MASTER);
  const ops = await opIdSet(sheets);
  const ctx = await traceContext(sheets, master.rows);
  const ts = nowStamp(), today = todayYMD();
  const data = [], rows = [], done = [], skipped = [];
  const rcvOver = {}, rcvIds = {}, rcvDropped = [];   // for the receivers' kept mill / ticket numbers
  const put = (o, fields) => Object.keys(fields).forEach((name) => {
    if (master.map[name]) data.push({ range: "'" + MASTER + "'!" + colLetter(master.map[name]) + o.__row, values: [[fields[name]]] });
  });
  for (const ch of list) {
    const skidId = String(ch.skidId).trim();
    const o = master.rows.filter((r) => String(r['Skid ID']).trim() === skidId)[0];
    if (!o) { skipped.push({ skidId, reason: 'not found' }); continue; }
    const step = subOp(op, skidId);
    const resumed = stampedBy(o, step);
    const cur = o['Status'] || STATUS.CURRENT;
    const to = ch.status ? String(ch.status) : '';
    // A receiver can be set on any ticket (old Used ones too); status and coating changes can't
    // touch Pending / In Production / Missing tickets.
    const wantRcv = ch.receiver !== undefined && ch.receiver !== null;
    const rcv = wantRcv ? String(ch.receiver).trim().toUpperCase() : '';
    const touchesStock = !!to || (ch.removePasses || []).length > 0;
    if (to && MASTER_STATUSES.indexOf(to) === -1) { skipped.push({ skidId, ticket: o['Ticket'], reason: 'can only move to Current, WIP or Used' }); continue; }
    if (!resumed && touchesStock && MASTER_STATUSES.indexOf(cur) === -1) { skipped.push({ skidId, ticket: o['Ticket'], reason: cur === STATUS.PENDING ? 'Pending on job ' + (o['Job ID'] || '') + ' — change it in Review Jobs' : cur }); continue; }
    if (rcv && !ctx.receivers[rcv]) { skipped.push({ skidId, ticket: o['Ticket'], reason: 'no receiver ' + rcv }); continue; }
    const hist = skidHist(ctx, o);
    const v = voidPlan(o, hist, ch.removePasses, op, ops);
    const moving = to && to !== cur && !resumed;
    const from = resumed ? String(ch.from || '') : cur;
    const prevRcv = String(o['Receiver'] || '').trim();
    const rcvChange = wantRcv && !resumed && prevRcv !== rcv;
    if (!resumed && !moving && !v.removed.length && !rcvChange) { skipped.push({ skidId, ticket: o['Ticket'], reason: wantRcv && !touchesStock ? (rcv ? 'already on ' + rcv : 'has no receiver') : 'nothing to change' }); continue; }
    const before = resumed ? Math.round((num(o['Litho']) + v.cost) * 100) / 100 : num(o['Litho']);
    const after = Math.round((before - v.cost) * 100) / 100;
    if (!resumed) {
      const fields = { 'Last Updated At': ts, 'Last Updated By': operator, 'Last Op ID': step };
      if (v.removed.length) fields['Litho'] = after;
      if (rcvChange) fields['Receiver'] = rcv;
      if (moving) {
        fields['Status'] = to;
        if (to === STATUS.USED) { fields['Used At'] = today; fields['Used Via'] = 'Database'; }
        if (cur === STATUS.USED) { fields['Used At'] = ''; fields['Used Via'] = ''; }
        // Back to Current = back to raw stock: it leaves its job and loses the coated / approved
        // stamps, the same as taking a ticket off a job. (Otherwise it still shows on that job's
        // ticket list, reports credit it to that customer, and the job can't be deleted.) The
        // history stays in Transactions, and the status-change log row names the job it left.
        if (to === STATUS.CURRENT) Object.assign(fields, { 'Job ID': '', 'First Coated At': '', 'First Coated By': '', 'Approved At': '', 'Approved By': '' });
      }
      put(o, fields);
    }
    let pass = maxPassOf(hist), running = before;
    v.removed.forEach((c) => {
      if (c.logged) return;
      running = Math.round((running - c.cost) * 100) / 100;
      pass++;
      rows.push(voidRowObj(o, c, pass, running, operator, o['Job ID'] || '', ts, c.rowOp));
    });
    const sOp = subOp(op, skidId + '#s');
    // The job a ticket going back to Current leaves (on a retry the skid's Job ID is already
    // cleared, so fall back to the last job in its log).
    const leftJob = String(o['Job ID'] || '').trim() || ((hist.filter((h) => h.jobId).slice(-1)[0] || {}).jobId || '');
    if (to && (moving || resumed) && !ops.has(sOp) && from !== to) {
      rows.push({ 'Timestamp': ts, 'Ticket': o['Ticket'], 'Pass Number': 0, 'Operator': operator, 'Group': '', 'Sub-Variant': '',
        'Item': 'STATUS CHANGED (DATABASE)', 'Chem Code': '', 'Application Cost': 0, 'Line Cost': 0, 'Pass Total Cost': 0,
        'Running Total After Pass': after, 'Notes': (from || '?') + ' → ' + to + ' (Database master sheet)' + (to === STATUS.CURRENT && leftJob ? '; left job ' + leftJob : ''), 'Job Name': '', 'Job ID': o['Job ID'] || '',
        'Skid ID': skidId, 'Op ID': sOp });
    }
    if (wantRcv && (rcvChange || resumed)) {
      rcvOver[skidId] = rcv;
      if (rcv) rcvIds[rcv] = 1;
      if (rcvChange && prevRcv) {
        rcvIds[keepKey(prevRcv)] = 1;
        rcvDropped.push({ receiver: keepKey(prevRcv), mill: keepKey(o['Mill']), ticket: keepKey(o['Ticket']) });
      }
    }
    // Receiver changes aren't written to Transactions: the ticket's Receiver cell (and the numbers
    // kept on the receiver) is the record. A retry is still safe: the cells are set to the same
    // values again, and Last Op ID marks the ticket as already done.
    done.push({ skidId, ticket: o['Ticket'], from: moving ? cur : (resumed ? from : ''), status: moving ? to : (resumed && to ? to : cur), litho: after,
      removed: v.removed.map((c) => c.item), receiver: wantRcv ? rcv : prevRcv });
  }
  if (!done.length) throw new Error('Nothing saved: ' + skipped.map((x) => (x.ticket || x.skidId) + ' (' + x.reason + ')').join(', '));
  // The receivers' kept numbers go in the SAME write as the tickets, so they can't drift apart.
  if (Object.keys(rcvIds).length) {
    const rt = await receiverTabForKeeping(sheets);
    if (rt) keepPlan(rt, master.rows, { override: rcvOver, dropped: rcvDropped, ids: rcvIds }).data.forEach((d) => data.push(d));
  }
  if (data.length) await sheets.batchUpdate(data);
  await appendTxRows(sheets, rows, ops);
  return { ok: true, saved: done, skipped };
}

// ---- Receivers ----
function receiverName(r) {
  if (!r) return '';
  const d = toYMD(r.date);
  return (/^\d{4}-\d\d-\d\d$/.test(d) ? d.slice(2) : 'NO-DATE') + '--' + (r.supplier || 'UNKNOWN') + '--' + r.id;
}
// Supplier codes go into the file name, so keep them plain: upper case, single spaces, no slashes
// and no "--" (the name's separator).
function cleanSupplier(v) { return String(v || '').toUpperCase().replace(/[\/\\]+/g, ' ').replace(/-{2,}/g, '-').replace(/\s+/g, ' ').trim(); }
function cleanPos(v) {
  const seen = {}, out = [];
  String(v || '').split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean).forEach((x) => { const k = x.toUpperCase(); if (!seen[k]) { seen[k] = 1; out.push(x); } });
  return out.join(', ');
}
function receiverOut(o) {
  return { id: String(o['Receiver ID'] || '').trim().toUpperCase(), date: toYMD(o['Date Received']), supplier: String(o['Supplier'] || '').trim(),
    pos: String(o['POs'] || ''), link: String(o['Drive Link'] || '').trim(), sourceFileId: String(o['Source File ID'] || '').trim(), notes: String(o['Notes'] || ''),
    createdAt: String(o['Created At'] || ''), createdBy: String(o['Created By'] || ''),
    mills: keptList(o['Mill Numbers']), keptTickets: keptList(o['Tickets']), row: o.__row };
}
async function receiverMap(sheets) {
  const map = {};
  try {
    (await readObjects(sheets, RECEIVERS)).rows.forEach((o) => { const r = receiverOut(o); if (r.id) map[r.id] = r; });
  } catch (e) { /* no Receivers tab yet */ }
  return map;
}
// A ticket's receiver: its own, else the skid it was split / cut from (and up the chain), else the
// original ticket of a remainder (042426-207-LR1 -> 042426-207). `receiverFrom` names where it came from.
function receiverTrace(o, ctx) {
  let cur = o, from = '';
  const seen = {};
  for (let i = 0; i < 25 && cur; i++) {
    const id = String(cur['Receiver'] || '').trim().toUpperCase();
    if (id) { from = cur === o ? '' : (cur['Ticket'] || cur['Skid ID'] || ''); return receiverFields(id, from, ctx); }
    const p = String(cur['Split Of'] || '').trim();
    if (!p || seen[p]) break;
    seen[p] = 1; cur = ctx.skids ? ctx.skids[p] : null;
  }
  const t = String(o['Ticket'] || '').trim(), base = baseTicketOf(t);
  const orig = base && base !== t && ctx.tickets ? ctx.tickets[base] : null;
  const id = orig ? String(orig['Receiver'] || '').trim().toUpperCase() : '';
  return id ? receiverFields(id, base, ctx) : { receiver: '', receiverName: '', receiverLink: '', receiverFrom: '' };
}
function receiverFields(id, from, ctx) {
  const r = ctx.receivers ? ctx.receivers[id] : null;
  return { receiver: id, receiverName: r ? receiverName(r) : id + ' (not in Receivers)', receiverLink: r ? r.link : '', receiverFrom: from };
}

// ---- Kept numbers: a receiver remembers which mills / tickets were put on it ----
// Steel Tickets can be wiped and rebuilt (Fresh Import gives every row a new Skid ID), so the
// Receiver column alone would lose the work. Each Receivers row therefore keeps the mill and ticket
// numbers of its tickets ('Mill Numbers', 'Tickets'). A list only grows as tickets go on; a number
// comes off only when its ticket is taken off (and no other ticket still on it shares that number).
// Matching back never uses row order or Skid IDs — only these numbers — and a number found on two
// receivers is never guessed (see receiverLookup).
function keepKey(v) { return String(v == null ? '' : v).trim().toUpperCase().replace(/\s+/g, ' '); }
function keptList(v) {
  const seen = {}, out = [];
  String(v == null ? '' : v).split(/[,\n]+/).map(keepKey).filter(Boolean).forEach((x) => { if (!seen[x]) { seen[x] = 1; out.push(x); } });
  return out;
}
// The Receivers tab with its two keep columns (made if missing), or null when there's no tab yet.
async function receiverTabForKeeping(sheets) {
  let t;
  try { t = await readTab(sheets, RECEIVERS); } catch (e) { return null; }
  if (!t.headers.length || !t.map['Receiver ID']) return null;
  let hdr = t.headers;
  for (const col of RECEIVER_KEEP_COLS) hdr = (await ensureColumn(sheets, RECEIVERS, hdr, col)).headers;
  if (hdr !== t.headers) t = await readTab(sheets, RECEIVERS);
  return t;
}
// Works out each receiver's kept lists from Steel Tickets. opts.override {skidId: receiver|''} is
// what an edit is about to write; opts.dropped [{receiver, mill, ticket}] are tickets coming off;
// opts.ids {R-x:1} limits it to those receivers (default: all). Returns the cells to write.
function keepPlan(rt, masterRows, opts) {
  opts = opts || {};
  const over = opts.override || {}, dropped = opts.dropped || [], only = opts.ids || null;
  const onM = {}, onT = {};
  masterRows.forEach((o) => {
    const sid = String(o['Skid ID'] || '').trim();
    const id = keepKey(Object.prototype.hasOwnProperty.call(over, sid) ? over[sid] : o['Receiver']);
    if (!id) return;
    const m = keepKey(o['Mill']), tk = keepKey(o['Ticket']);
    if (m) (onM[id] = onM[id] || {})[m] = 1;
    if (tk) (onT[id] = onT[id] || {})[tk] = 1;
  });
  const data = [], lists = {};
  let changed = 0;
  rt.rows.forEach((r) => {
    const id = keepKey(r['Receiver ID']);
    if (!id) return;
    let mills = keptList(r['Mill Numbers']), tix = keptList(r['Tickets']);
    if (!only || only[id]) {
      const before = mills.join(', ') + '|' + tix.join(', ');
      dropped.filter((d) => d.receiver === id).forEach((d) => {
        if (d.mill && !(onM[id] || {})[d.mill]) mills = mills.filter((x) => x !== d.mill);
        if (d.ticket && !(onT[id] || {})[d.ticket]) tix = tix.filter((x) => x !== d.ticket);
      });
      Object.keys(onM[id] || {}).forEach((m) => { if (mills.indexOf(m) === -1) mills.push(m); });
      Object.keys(onT[id] || {}).forEach((t) => { if (tix.indexOf(t) === -1) tix.push(t); });
      if (mills.join(', ') + '|' + tix.join(', ') !== before) {
        changed++;
        data.push({ range: "'" + RECEIVERS + "'!" + colLetter(rt.map['Mill Numbers']) + r.__row, values: [[mills.join(', ')]] });
        data.push({ range: "'" + RECEIVERS + "'!" + colLetter(rt.map['Tickets']) + r.__row, values: [[tix.join(', ')]] });
      }
    }
    lists[id] = { mills, tickets: tix };
  });
  return { data, lists, changed };
}
// mill -> receiver and ticket -> receiver from the kept lists. A number on two receivers maps to
// null (ambiguous: never guessed).
function receiverLookup(lists) {
  const byMill = {}, byTicket = {};
  const add = (map, k, id) => { map[k] = (map[k] === undefined || map[k] === id) ? id : null; };
  Object.keys(lists).forEach((id) => {
    lists[id].mills.forEach((m) => add(byMill, m, id));
    lists[id].tickets.forEach((t) => add(byTicket, t, id));
  });
  return { byMill, byTicket };
}
// Which receiver a ticket matches by its kept numbers: mill first, then ticket number.
// {receiver, by: 'mill'|'ticket'} | {conflict: true} | null.
function matchReceiver(look, mill, ticket) {
  const m = keepKey(mill), t = keepKey(ticket);
  let conflict = false;
  if (m && look.byMill[m] !== undefined) { if (look.byMill[m]) return { receiver: look.byMill[m], by: 'mill' }; conflict = true; }
  if (t && look.byTicket[t] !== undefined) { if (look.byTicket[t]) return { receiver: look.byTicket[t], by: 'ticket' }; conflict = true; }
  return conflict ? { conflict: true } : null;
}
// Writes every receiver's kept lists up to date from Steel Tickets (the Receivers screen's
// "Save them now"; the Fresh Import does the same before it wipes). Re-running is harmless.
async function keepReceiverNumbers(sheets) {
  const rt = await receiverTabForKeeping(sheets);
  if (!rt) return { ok: true, changed: 0 };
  const master = await readTab(sheets, MASTER);
  const plan = keepPlan(rt, master.rows);
  if (plan.data.length) await sheets.batchUpdate(plan.data);
  return { ok: true, changed: plan.changed };
}

// Every receiver with its ticket count, the supplier codes in use, and a light list of every ticket
// (to find and attach them by ticket range, PO or mill). One read of each tab.
async function getReceivers(sheets) {
  const master = await readTab(sheets, MASTER);
  const receivers = await receiverMap(sheets);
  const ctx = { skids: {}, tickets: {}, receivers };
  master.rows.forEach((o) => {
    if (o['Skid ID']) ctx.skids[String(o['Skid ID']).trim()] = o;
    const t = String(o['Ticket'] || '').trim(); if (t && !ctx.tickets[t]) ctx.tickets[t] = o;
  });
  const lists = {};
  Object.keys(receivers).forEach((id) => { lists[id] = { mills: receivers[id].mills, tickets: receivers[id].keptTickets }; });
  const look = receiverLookup(lists);
  const count = {}, unkept = {}, tickets = [], sup = {};
  master.rows.forEach((o) => {
    if (!(o['Ticket'] || o['Skid ID'])) return;
    const own = String(o['Receiver'] || '').trim().toUpperCase();
    const tr = receiverTrace(o, ctx);
    if (own) count[own] = (count[own] || 0) + 1;
    const s = cleanSupplier(o['Supplier']); if (s) sup[s] = 1;
    const mk = keepKey(o['Mill']), tk = keepKey(o['Ticket']);
    // On a receiver but its numbers aren't kept there yet (attached before keeping existed).
    if (own && lists[own] && ((mk && lists[own].mills.indexOf(mk) === -1) || (tk && lists[own].tickets.indexOf(tk) === -1))) unkept[own] = (unkept[own] || 0) + 1;
    // Not on any receiver, but a receiver kept its mill / ticket number (e.g. after a wipe).
    const mt = !own && !tr.receiver ? matchReceiver(look, o['Mill'], o['Ticket']) : null;
    tickets.push({ skidId: o['Skid ID'] || '', ticket: String(o['Ticket'] || ''), status: o['Status'] || '', mill: String(o['Mill'] || ''),
      po: o['PO Number'] != null ? String(o['PO Number']) : '', supplier: String(o['Supplier'] || ''), qty: o['QTY/LOAD'] != null ? o['QTY/LOAD'] : '',
      receiver: own, via: own ? '' : tr.receiver, viaFrom: own ? '' : tr.receiverFrom, splitOf: o['Split Of'] || '',
      match: mt && mt.receiver ? mt.receiver : '', matchBy: mt && mt.receiver ? mt.by : '', matchConflict: !!(mt && mt.conflict) });
  });
  const list = Object.keys(receivers).map((id) => Object.assign({}, receivers[id], { name: receiverName(receivers[id]), ticketCount: count[id] || 0, unkept: unkept[id] || 0 }));
  list.sort((a, b) => (b.id < a.id ? -1 : b.id > a.id ? 1 : 0));   // newest number first
  list.forEach((r) => { if (r.supplier) sup[r.supplier] = 1; });
  return { receivers: list, suppliers: Object.keys(sup).sort(), tickets };
}

// ---- Find in Drive ----
function receiverFolderId(env) { return String((env && env.RECEIVER_FOLDER_ID) || DEFAULT_RECEIVER_FOLDER).trim(); }
function sourceFolderId(env) { return String((env && env.RECEIVER_SOURCE_FOLDER) || DEFAULT_SOURCE_FOLDER).trim(); }
function driveScope(env) { return sourceFolderId(env) + DRIVE_SCOPE_TAG; }
// The source folder and every folder under it: {id: name}. One Drive call per level.
async function driveFolderTree(sheets, rootId) {
  const FOLDER = 'application/vnd.google-apps.folder';
  const tree = {};
  try { tree[rootId] = (await sheets.driveGet(rootId, 'id,name')).name || ''; }
  catch (e) {
    e = driveError(e);
    if (e.status === 404) throw new Error('The app can’t see the receivers archive folder (' + rootId + '). Share it with the service account as Viewer.');
    throw e;
  }
  let level = [rootId];
  for (let depth = 0; depth < 8 && level.length; depth++) {
    const next = [];
    for (let i = 0; i < level.length; i += DRIVE_FOLDERS_PER_QUERY) {
      const ins = level.slice(i, i + DRIVE_FOLDERS_PER_QUERY).map((id) => "'" + driveQ(id) + "' in parents").join(' or ');
      const found = await sheets.driveList('(' + ins + ") and mimeType = '" + FOLDER + "' and trashed = false", 'id,name', 1000);
      found.forEach((f) => { if (!tree[f.id] && !DRIVE_EXCLUDE.test(f.name || '')) { tree[f.id] = f.name || ''; next.push(f.id); } });
    }
    level = next;
  }
  return tree;
}
function driveQ(v) { return String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
function driveError(e) {
  const m = e && e.message ? e.message : String(e);
  if (/Drive API has not been used|drive\.googleapis\.com.*(disabled|not been used)|SERVICE_DISABLED/i.test(m)) {
    return new Error('The Google Drive API is turned off for the service account’s Google Cloud project. Turn it on (APIs & Services → Library → Google Drive API), wait a minute, and try again.');
  }
  return e;
}
// Tickets not on any receiver (own, inherited or by a kept number) — what Find in Drive looks for.
// A mill made of several ("A / B", slitter pallets) isn't searched: those come from tickets that
// have receivers of their own.
function driveTickets(masterRows, receivers) {
  const ctx = { skids: {}, tickets: {}, receivers };
  masterRows.forEach((o) => {
    if (o['Skid ID']) ctx.skids[String(o['Skid ID']).trim()] = o;
    const t = String(o['Ticket'] || '').trim(); if (t && !ctx.tickets[t]) ctx.tickets[t] = o;
  });
  const lists = {};
  Object.keys(receivers).forEach((id) => { lists[id] = { mills: receivers[id].mills || [], tickets: receivers[id].keptTickets || [] }; });
  const look = receiverLookup(lists);
  const out = [];
  masterRows.forEach((o) => {
    if (!(o['Ticket'] || o['Skid ID'])) return;
    if (String(o['Receiver'] || '').trim() || receiverTrace(o, ctx).receiver) return;
    const mt = matchReceiver(look, o['Mill'], o['Ticket']);
    if (mt && mt.receiver) return;   // the Receivers screen's "Attach all" puts those back
    const mill = keepKey(o['Mill']);
    out.push({ skidId: String(o['Skid ID'] || ''), ticket: String(o['Ticket'] || ''), status: o['Status'] || '', mill, searchable: !!mill && mill.indexOf('/') === -1,
      po: o['PO Number'] != null ? String(o['PO Number']) : '', supplier: String(o['Supplier'] || ''), qty: o['QTY/LOAD'] != null ? o['QTY/LOAD'] : '' });
  });
  return out;
}
// Each mill's latest search: {mill: {at, hits: {fileId: {...}}}} (a miss has no hits).
async function driveSearchLog(sheets, scope) {
  let t = null;
  try { t = await readTab(sheets, DRIVE_SEARCH); } catch (e) { t = null; }
  const latest = {}, folders = {};
  ((t && t.rows) || []).forEach((r) => {
    const m = keepKey(r['Mill']);
    if (!m || String(r['Scope'] || '').trim() !== scope) return;
    const at = String(r['Searched At'] || '');
    if (!latest[m] || at > latest[m].at) latest[m] = { at, hits: {} };
    const fid = String(r['File ID'] || '').trim();
    if (at === latest[m].at && fid && !DRIVE_EXCLUDE.test(String(r['File Name'] || '') + ' ' + String(r['Folder Name'] || ''))) latest[m].hits[fid] = { fileId: fid, name: String(r['File Name'] || ''), link: String(r['File Link'] || ''),
      folderId: String(r['Folder ID'] || ''), date: toYMD(r['File Date']) };
    if (r['Folder ID'] && r['Folder Name']) folders[String(r['Folder ID'])] = String(r['Folder Name']);
  });
  return { tab: t, latest, folders };
}

// Searches the next DRIVE_BATCH not-yet-searched mills (the app calls it until remaining is 0).
// again: true starts "search again for the ones not found"; the reply's `cutoff` is passed back on
// the following calls so each miss is searched again only once.
async function driveSearchMills(sheets, env, again) {
  const master = await readTab(sheets, MASTER);
  const receivers = await receiverMap(sheets);
  const want = {};
  driveTickets(master.rows, receivers).forEach((t) => { if (t.searchable) want[t.mill] = 1; });
  await ensureTab(sheets, DRIVE_SEARCH, DRIVE_SEARCH_HEADERS);
  let hdr = (await readTab(sheets, DRIVE_SEARCH)).headers;
  for (const col of DRIVE_SEARCH_HEADERS) hdr = (await ensureColumn(sheets, DRIVE_SEARCH, hdr, col)).headers;
  const scope = driveScope(env);
  const log = await driveSearchLog(sheets, scope);
  const ts = nowStamp();
  const cutoff = again ? (again === true ? ts : String(again)) : '';
  // The first "again" call takes every miss up to now; the later ones only those before its cutoff
  // (what that first call and the ones after it searched are stamped at or after it).
  const stale = (at) => (again === true ? at <= cutoff : at < cutoff);
  const todo = Object.keys(want).sort().filter((m) => !log.latest[m] || (cutoff && !Object.keys(log.latest[m].hits).length && stale(log.latest[m].at)));
  if (!todo.length) return { ok: true, searched: 0, found: 0, remaining: 0, cutoff };
  // Only inside the archive folder: each search names its folders ("in parents" isn't recursive).
  let tree;
  try { tree = await driveFolderTree(sheets, sourceFolderId(env)); } catch (e) { throw driveError(e); }
  const ids = Object.keys(tree), chunks = [];
  for (let i = 0; i < ids.length; i += DRIVE_FOLDERS_PER_QUERY) chunks.push(ids.slice(i, i + DRIVE_FOLDERS_PER_QUERY));
  const batch = todo.slice(0, Math.max(1, Math.floor(DRIVE_BATCH / chunks.length)));
  const out = [];
  let found = 0;
  for (const m of batch) {
    const files = [], seen = {};
    for (const ch of chunks) {
      let got;
      try {
        got = await sheets.driveList("fullText contains '\"" + driveQ(m) + "\"' and trashed = false and (mimeType = 'application/pdf' or mimeType contains 'image/') and (" +
          ch.map((id) => "'" + driveQ(id) + "' in parents").join(' or ') + ')', 'id,name,webViewLink,parents,createdTime,mimeType', 20);
      } catch (e) { throw driveError(e); }
      got.forEach((f) => { if (!seen[f.id] && !DRIVE_EXCLUDE.test(f.name || '')) { seen[f.id] = 1; files.push(f); } });
    }
    if (files.length) found++;
    if (!files.length) out.push({ 'Mill': m, 'Searched At': ts, 'Scope': scope });
    files.forEach((f) => {
      const folder = (f.parents || []).filter((p) => tree[p] !== undefined)[0] || (f.parents || [])[0] || '';
      out.push({ 'Mill': m, 'File ID': f.id, 'File Name': f.name || '', 'File Link': f.webViewLink || ('https://drive.google.com/file/d/' + f.id + '/view'),
        'Folder ID': folder, 'Folder Name': tree[folder] || '', 'File Date': String(f.createdTime || '').slice(0, 10), 'Searched At': ts, 'Scope': scope });
    });
  }
  if (out.length) {
    const headers = (await readTab(sheets, DRIVE_SEARCH)).headers;
    await sheets.appendMany(DRIVE_SEARCH, out.map((r) => headers.map((h) => (r[h] != null ? r[h] : ''))),
      () => columnHas(sheets, DRIVE_SEARCH, headers, 'Searched At', ts));
  }
  return { ok: true, searched: batch.length, found, remaining: todo.length - batch.length, cutoff };
}

// The review list: every file that holds the mill number of a ticket not on a receiver yet,
// with those tickets. A file already in the receivers folder named for a receiver says so (attach
// there); an original scan whose mills are all in such a copy points to it instead.
async function getDriveMatches(sheets, env) {
  const master = await readTab(sheets, MASTER);
  const receivers = await receiverMap(sheets);
  const tickets = driveTickets(master.rows, receivers);
  const log = await driveSearchLog(sheets, driveScope(env));
  const dest = receiverFolderId(env);
  const brief = (t) => ({ skidId: t.skidId, ticket: t.ticket, status: t.status, mill: t.mill, po: t.po, supplier: t.supplier, qty: t.qty });
  const byMill = {};
  tickets.forEach((t) => { if (t.searchable) (byMill[t.mill] = byMill[t.mill] || []).push(t); });
  const groups = {}, misses = [];
  let unsearched = 0;
  Object.keys(byMill).sort().forEach((m) => {
    const L = log.latest[m];
    if (!L) { unsearched++; return; }
    const ids = Object.keys(L.hits);
    if (!ids.length) { misses.push({ mill: m, at: L.at, tickets: byMill[m].map(brief) }); return; }
    ids.forEach((fid) => {
      const h = L.hits[fid];
      const g = groups[fid] = groups[fid] || { fileId: fid, name: h.name, link: h.link, folderId: h.folderId, folderName: log.folders[h.folderId] || '', date: h.date, mills: [], tickets: [] };
      g.mills.push(m);
      byMill[m].forEach((t) => g.tickets.push(brief(t)));
    });
  });
  // Supplier code last used for a receiver made from a scan in the same folder (2025 Reynolds -> RN).
  const fileFolder = {};
  Object.keys(log.latest).forEach((m) => Object.keys(log.latest[m].hits).forEach((fid) => { fileFolder[fid] = log.latest[m].hits[fid].folderId; }));
  const folderSupplier = {}, madeFrom = {};
  Object.keys(receivers).sort().forEach((id) => {
    const r = receivers[id];
    if (!r.sourceFileId) return;
    (madeFrom[r.sourceFileId] = madeFrom[r.sourceFileId] || []).push(id);
    if (fileFolder[r.sourceFileId] && r.supplier) folderSupplier[fileFolder[r.sourceFileId]] = r.supplier;
  });
  const list = Object.keys(groups).map((k) => groups[k]);
  list.forEach((g) => {
    const rm = /R-\d{5}/i.exec(g.name);
    g.inFolder = g.folderId === dest;
    g.namedReceiver = g.inFolder && rm ? rm[0].toUpperCase() : '';
    g.receiver = g.namedReceiver && receivers[g.namedReceiver] ? g.namedReceiver : '';
    g.madeFrom = madeFrom[g.fileId] || [];
    const sc = {};
    g.tickets.forEach((t) => { const c = cleanSupplier(t.supplier); if (c) sc[c] = (sc[c] || 0) + 1; });
    g.supplier = folderSupplier[g.folderId] || Object.keys(sc).sort((a, b) => sc[b] - sc[a])[0] || '';
    g.pos = cleanPos(g.tickets.map((t) => t.po).filter(Boolean).join(', '));
  });
  const copies = list.filter((g) => g.inFolder);
  list.forEach((g) => {
    if (g.inFolder) return;
    const cover = copies.filter((c) => g.mills.every((m) => c.mills.indexOf(m) !== -1));
    g.coveredBy = cover.map((c) => c.receiver || c.namedReceiver || c.name);
  });
  list.sort((a, b) => (b.inFolder - a.inFolder) || (a.coveredBy && a.coveredBy.length ? 1 : 0) - (b.coveredBy && b.coveredBy.length ? 1 : 0) ||
    (b.tickets.length - a.tickets.length) || (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const sup = {};
  Object.keys(receivers).forEach((id) => { if (receivers[id].supplier) sup[receivers[id].supplier] = 1; });
  return { groups: list, misses, unsearched, millCount: Object.keys(byMill).length, noMill: tickets.filter((t) => !t.searchable).length,
    unassigned: tickets.map(brief), folderId: dest, sourceFolderId: sourceFolderId(env), saEmail: String(env.GCP_SA_EMAIL || ''), suppliers: Object.keys(sup).sort(),
    receivers: Object.keys(receivers).sort().reverse().map((id) => ({ id, name: receiverName(receivers[id]) })) };
}

// Copies the scan into the receivers folder named for the receiver (25-10-28--RN--R-00003.pdf) and
// saves the link. Retry-safe: a copy already there (found by its R-number) is reused. If Google
// refuses the copy (a service account can't own files in a My Drive folder) the receiver is linked
// to the original scan instead, and copyError says so.
async function copyReceiverFile(sheets, env, id, name, fileId, haveLink) {
  if (haveLink && haveLink.indexOf(fileId) === -1) return { link: haveLink, copied: true, already: true };
  const dest = receiverFolderId(env);
  const find = async () => (await sheets.driveList("'" + driveQ(dest) + "' in parents and name contains '" + driveQ(id) + "' and trashed = false", 'id,name,webViewLink', 5))[0] || null;
  let f, src = null, copyError = '';
  try { f = await find(); } catch (e) { throw driveError(e); }
  if (!f) {
    try { src = await sheets.driveGet(fileId, 'id,name,webViewLink,mimeType'); } catch (e) { throw new Error('Could not open the scan in Drive: ' + driveError(e).message); }
    const ext = (/\.[a-z0-9]{2,5}$/i.exec(src.name || '') || [''])[0] || (src.mimeType === 'application/pdf' ? '.pdf' : '');
    try {
      f = await sheets.driveCopy(fileId, name + ext, dest, async () => !!(await find()));
      if (!f || !f.id) f = await find();
    } catch (e) {
      f = null;
      copyError = (e.reason === 'storageQuotaExceeded' || /storage quota/i.test(e.message || ''))
        ? 'Google won’t let the service account own files in a My Drive folder (it has no storage of its own), so the copy wasn’t made.'
        : 'The copy failed: ' + driveError(e).message;
    }
  }
  const link = f ? (f.webViewLink || 'https://drive.google.com/file/d/' + f.id + '/view') : (src.webViewLink || 'https://drive.google.com/file/d/' + fileId + '/view');
  const t = await readTab(sheets, RECEIVERS);
  const o = t.rows.filter((r) => String(r['Receiver ID'] || '').trim().toUpperCase() === id)[0];
  if (o) await stampCells(sheets, RECEIVERS, o.__row, t.map, { 'Drive Link': link, 'Last Updated At': nowStamp() });
  return { link, copied: !!f, copyName: f ? f.name : name + ((/\.[a-z0-9]{2,5}$/i.exec((src && src.name) || '') || ['.pdf'])[0]), copyError };
}

// Approve one file's match: a new receiver (with its copy) — or an existing one — and the tickets
// put on it, in one go. Retry-safe end to end: the receiver is found again by its Op ID, the copy
// by its R-number, and the attach by its own sub-op.
async function approveDriveMatch(sheets, env, rec, operator, opId) {
  rec = rec || {};
  const skidIds = (rec.skidIds || []).map((x) => String(x || '').trim()).filter(Boolean);
  if (!skidIds.length) throw new Error('Pick at least one ticket.');
  if (skidIds.length > 300) throw new Error('Approve at most 300 tickets at a time.');
  const op = opId || autoOpId();
  let id = String(rec.receiverId || '').trim().toUpperCase(), r = null, copy = null;
  if (!id) {
    const fileId = String(rec.fileId || '').trim();
    if (!fileId) throw new Error('No file picked.');
    r = await saveReceiver(sheets, { date: rec.date, supplier: rec.supplier, pos: rec.pos, notes: rec.notes, sourceFileId: fileId }, operator, op);
    id = r.id;
    copy = await copyReceiverFile(sheets, env, id, r.name, fileId, r.link);
  }
  let res;
  try { res = await masterEdit(sheets, skidIds.map((s) => ({ skidId: s, receiver: id })), operator, subOp(op, 'attach')); }
  catch (e) {
    // Every ticket already on it (attached some other way): nothing left to do.
    const m = /^Nothing saved: (.*)$/.exec(e.message || '');
    if (!m || m[1].replace(/[^,()]+\(already on [^)]+\)/g, '').replace(/[,\s]/g, '') !== '') throw e;
    res = { saved: [], skipped: [] };
  }
  return { ok: true, receiver: id, name: r ? r.name : '', created: !!r, copy, saved: res.saved || [], skipped: res.skipped || [] };
}

// Create (no rec.id) or edit a receiver's details. A new one gets the next R-number. Retry-safe: a
// create is found again by its Op ID; an edit just writes the same cells again.
async function saveReceiver(sheets, rec, operator, opId) {
  rec = rec || {};
  const supplier = cleanSupplier(rec.supplier);
  if (!supplier) throw new Error('Enter the supplier.');
  const date = rec.date ? toYMD(rec.date) : '';
  if (rec.date && !/^\d{4}-\d\d-\d\d$/.test(date)) throw new Error('Date received must be a date.');
  const link = String(rec.link || '').trim();
  if (link && !/^https?:\/\//i.test(link)) throw new Error('The Drive link should start with https://');
  await ensureTab(sheets, RECEIVERS, RECEIVER_HEADERS);
  let t = await readTab(sheets, RECEIVERS);
  let hdr = t.headers;
  for (const col of RECEIVER_HEADERS) hdr = (await ensureColumn(sheets, RECEIVERS, hdr, col)).headers;
  if (hdr !== t.headers) t = await readTab(sheets, RECEIVERS);
  const ts = nowStamp();
  const fields = { 'Date Received': date, 'Supplier': supplier, 'POs': cleanPos(rec.pos), 'Drive Link': link, 'Notes': String(rec.notes || '').trim(), 'Last Updated At': ts };
  if (rec.sourceFileId) fields['Source File ID'] = String(rec.sourceFileId).trim();
  const id = String(rec.id || '').trim().toUpperCase();
  if (id) {
    const o = t.rows.filter((r) => String(r['Receiver ID'] || '').trim().toUpperCase() === id)[0];
    if (!o) throw new Error('Receiver ' + id + ' not found.');
    fields['File Name'] = receiverName({ id, date, supplier });
    await stampCells(sheets, RECEIVERS, o.__row, t.map, fields);
    return Object.assign(receiverOut(Object.assign({}, o, fields)), { name: fields['File Name'] });
  }
  if (opId) {
    const ex = t.rows.filter((r) => String(r['Op ID'] || '').trim() === String(opId).trim())[0];
    if (ex) { const r = receiverOut(ex); return Object.assign(r, { name: receiverName(r), duplicate: true }); }
  }
  const nid = 'R-' + ('00000' + (maxIdNumber(t.rows, 'Receiver ID', 'R-') + 1)).slice(-5);
  const obj = Object.assign({ 'Receiver ID': nid, 'File Name': receiverName({ id: nid, date, supplier }), 'Created At': ts,
    'Created By': String(operator || '').trim() || 'Database', 'Op ID': opId || '' }, fields);
  await appendRowObj(sheets, RECEIVERS, hdr, obj);
  return Object.assign(receiverOut(obj), { name: obj['File Name'], created: true });
}

// Delete a receiver made by mistake — only while no ticket is on it. Its number is not reused.
async function deleteReceiver(sheets, receiverId, operator, opId) {
  const id = String(receiverId || '').trim().toUpperCase();
  let t;
  try { t = await readTab(sheets, RECEIVERS); } catch (e) { return { ok: true, id, alreadyGone: true }; }
  const o = t.rows.filter((r) => String(r['Receiver ID'] || '').trim().toUpperCase() === id)[0];
  if (!o) return { ok: true, id, alreadyGone: true };
  const master = await readTab(sheets, MASTER);
  const on = master.rows.filter((r) => String(r['Receiver'] || '').trim().toUpperCase() === id);
  if (on.length) throw new Error(id + ' still has ' + on.length + ' ticket(s) on it. Take them off first, then delete it.');
  const kept = keptList(o['Mill Numbers']).length + keptList(o['Tickets']).length;
  if (kept) throw new Error(id + ' still remembers ' + kept + ' mill / ticket number(s) — they put its tickets back after a wipe, so it can\'t be deleted.');
  const grid = await sheetGrid(sheets, RECEIVERS);
  if (!grid) throw new Error('Could not locate the Receivers tab.');
  // Re-check the row still holds THIS receiver right before deleting by position.
  const cell = await sheets.read("'" + RECEIVERS + "'!" + colLetter(t.map['Receiver ID']) + o.__row);
  if (String((cell[0] && cell[0][0]) || '').trim().toUpperCase() !== id) throw new Error('The receiver list changed while deleting ' + id + ' — nothing was deleted. Refresh and try again.');
  await sheets.deleteRows(grid.sheetId, o.__row - 1, o.__row);
  return { ok: true, id };
}

// ---- moveToWip: the foreman's batch move (Litho Department -> Move To WIP) ----
// The foreman names the job/customer, picks what was done (one or more coatings) and scans the
// tickets. Every ticket gets the whole recipe at full sheet count (no spoilage, no partials) and
// goes straight to WIP — no Pending/review step. The batch is recorded as a Litho Jobs row that is
// already Approved, so it shows in Review Jobs history with its tickets and cost.
// Built for big batches on the Workers Free plan's 50-Google-calls-per-request cap: the whole
// batch is a fixed handful of calls (one read of each tab, one job row, ONE Steel Tickets write,
// ONE append of all the coating log rows), however many tickets there are.
// Retry-safe: the job row is found again by its Op ID, each skid's change stamps
// "<opId>#<skidId>" in Last Op ID (same write), and each coating row carries
// "<opId>#<skidId>#c<i>" — so a retry skips what landed and writes only what's missing.
// Tickets that can't move (Pending on a job, Used, not found...) are skipped and reported.
const MOVE_WIP_MAX = 150;
async function moveToWip(sheets, description, operator, coatings, skidIds, opId, removals) {
  description = String(description || '').trim();
  operator = String(operator || '').trim() || 'Foreman';   // the screen has no name field (one or two foremen use it)
  if (!description) throw new Error('Enter the job / customer name.');
  const ids = [];
  (skidIds || []).forEach((s) => { const v = String(s || '').trim(); if (v && ids.indexOf(v) === -1) ids.push(v); });
  if (!ids.length) throw new Error('Add at least one ticket.');
  if (ids.length > MOVE_WIP_MAX) throw new Error('Move at most ' + MOVE_WIP_MAX + ' tickets at a time.');
  await validateCoatings(sheets, coatings);
  const recipe = coatings.map((c) => ({ group: c.group, sub: c.sub || '', item: c.item }));
  const matches = [];
  for (const c of recipe) matches.push(await findRate(sheets, c.group, c.sub, c.item));
  const recipeCost = Math.round(matches.reduce((n, m) => n + m.totalCost, 0) * 100) / 100;
  const op = opId || autoOpId();
  await normalizeMasterRows(sheets);

  const master = await withLastOpCol(sheets, await readTab(sheets, MASTER));
  const ops = await opIdSet(sheets);
  const ctx = await traceContext(sheets, master.rows);

  // Work out every ticket first, so nothing is written for a batch where no ticket can move.
  const plan = [], skipped = [];
  ids.forEach((skidId) => {
    const o = master.rows.filter((r) => String(r['Skid ID']).trim() === skidId)[0];
    if (!o) { skipped.push({ skidId, reason: 'not found' }); return; }
    const step = subOp(op, skidId);
    const st = o['Status'] || STATUS.CURRENT;
    if (stampedBy(o, step)) { plan.push({ o, step, resumed: true }); return; }   // an earlier attempt changed it
    if (st === STATUS.PENDING) { skipped.push({ skidId, ticket: o['Ticket'], reason: 'Pending on job ' + (o['Job ID'] || '') }); return; }
    if (st !== STATUS.CURRENT && st !== STATUS.WIP) { skipped.push({ skidId, ticket: o['Ticket'], reason: st }); return; }
    plan.push({ o, step, resumed: false, wasWip: st === STATUS.WIP });
  });
  if (!plan.length) {
    throw new Error('None of these tickets can be moved: ' + skipped.map((x) => (x.ticket || x.skidId) + ' (' + x.reason + ')').join(', '));
  }

  // The job row (Approved from the start). A retry finds it again by its Op ID.
  const jobs = await readTab(sheets, JOBS);
  let job = jobs.headers.indexOf('Op ID') !== -1 ? jobs.rows.filter((r) => String(r['Op ID'] || '').trim() === op)[0] : null;
  let jobId;
  if (job) jobId = job['Job ID'];
  else {
    jobId = fmtId('JOB-', maxIdNumber(jobs.rows, 'Job ID', 'JOB-') + 1);
    let hdr = jobs.headers;
    for (const col of ['Op ID', 'Approved At', 'Approved By']) hdr = (await ensureColumn(sheets, JOBS, hdr, col)).headers;
    const ts = nowStamp();
    await appendRowObj(sheets, JOBS, hdr, {
      'Job ID': jobId, 'Created At': ts, 'Created By': operator, 'Description': description,
      'Coatings': coatingSummary(recipe), 'Coatings JSON': JSON.stringify(recipe), 'Ticket Count': plan.length, 'Status': 'Approved',
      'Notes': 'Moved to WIP (no review step)', 'Approved At': ts, 'Approved By': operator, 'Op ID': op,
    });
  }

  // ONE write for every skid's change (status, cost, job, Last Op ID).
  const ts = nowStamp();
  const data = [], rows = [], moved = [];
  plan.forEach((p) => {
    const o = p.o, skidId = String(o['Skid ID']).trim();
    const hist = skidHist(ctx, o);
    // Coatings the foreman marked to take off this ticket: voided in this same batch, before the
    // new coats. (A retry finds them still active until the one log append lands.)
    const v = voidPlan(o, hist, (removals || {})[skidId], op, ops);
    const before = p.resumed ? Math.round((num(o['Litho']) - recipeCost + v.cost) * 100) / 100 : num(o['Litho']);
    const afterVoid = Math.round((before - v.cost) * 100) / 100;
    const after = p.resumed ? num(o['Litho']) : Math.round((afterVoid + recipeCost) * 100) / 100;
    if (!p.resumed) {
      const fields = { 'Status': STATUS.WIP, 'Job ID': jobId, 'Litho': after, 'Row': '',
        'Approved At': ts, 'Approved By': operator, 'Last Updated At': ts, 'Last Updated By': operator, 'Last Op ID': p.step };
      if (!p.wasWip) { fields['First Coated At'] = ts; fields['First Coated By'] = operator; }
      Object.keys(fields).forEach((name) => {
        if (master.map[name]) data.push({ range: "'" + MASTER + "'!" + colLetter(master.map[name]) + o.__row, values: [[fields[name]]] });
      });
    }
    // Pass numbers: a resumed skid may already have some of this batch's rows logged.
    let pass = maxPassOf(hist), running = before;
    v.removed.forEach((c) => {
      if (c.logged) return;
      running = Math.round((running - c.cost) * 100) / 100;
      pass++;
      rows.push(voidRowObj(o, c, pass, running, operator, jobId, ts, c.rowOp));
    });
    matches.forEach((m, i) => {
      running = Math.round((running + m.totalCost) * 100) / 100;
      const rowOp = subOp(op, skidId + '#c' + i);
      if (ops.has(rowOp)) return;
      pass++;
      rows.push({ 'Timestamp': ts, 'Ticket': o['Ticket'], 'Pass Number': pass, 'Operator': operator,
        'Group': recipe[i].group, 'Sub-Variant': recipe[i].sub, 'Item': recipe[i].item, 'Chem Code': m.chemCode || '',
        'Application Cost': m.appCost, 'Line Cost': m.lineCost, 'Pass Total Cost': m.totalCost, 'Running Total After Pass': running,
        'Notes': 'Moved to WIP', 'Job Name': description, 'Job ID': jobId, 'Skid ID': skidId, 'Op ID': rowOp });
    });
    moved.push({ skidId, ticket: o['Ticket'], litho: after, wasWip: !!p.wasWip, removed: v.removed.map((c) => c.item) });
  });
  if (data.length) await sheets.batchUpdate(data);

  // ONE append for all the log rows (removals and coatings).
  await appendTxRows(sheets, rows, ops);

  if (job) {   // a retry: keep the count right (harmless if unchanged)
    const n = (await readTab(sheets, MASTER)).rows.filter((r) => String(r['Job ID']).trim() === String(jobId).trim()).length;
    await stampCells(sheets, JOBS, job.__row, jobs.map, { 'Ticket Count': n });
  }
  return { ok: true, jobId, description, coatings: recipe, moved, skipped, perTicket: recipeCost };
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
  // Rows shift when anything above is deleted, so re-check that this row still holds THIS job
  // right before deleting it (never delete a different job by position).
  const idCol = colLetter(jobs.map['Job ID']);
  const cell = await sheets.read("'" + JOBS + "'!" + idCol + job.__row);
  if (String((cell[0] && cell[0][0]) || '').trim() !== String(jobId).trim()) {
    throw new Error('The job list changed while deleting ' + jobId + ' — nothing was deleted. Refresh and try again.');
  }
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
// Retry-safe per skid: each skid's change stamps "<opId>#<skidId>" and its log row carries the
// same id, so a retry after a failure at skid 5 of 10 marks skids 5-10 instead of calling the whole
// batch a duplicate — and never re-logs skids 1-4 as a second ("re-used") use.
async function markUsedDirect(sheets, skidIds, usedDate, opId) {
  const ids = (skidIds || []).map((s) => String(s).trim()).filter(Boolean);
  if (!ids.length) throw new Error('No skids to mark.');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(usedDate || '').trim()) ? String(usedDate).trim() : todayYMD();
  let master = await readTab(sheets, MASTER);
  let ens = await ensureColumn(sheets, MASTER, master.headers, 'Used At');
  ens = await ensureColumn(sheets, MASTER, ens.headers, 'Used Via');
  ens = await ensureColumn(sheets, MASTER, ens.headers, 'System Notes');   // re-uses are appended here
  ens = await ensureColumn(sheets, MASTER, ens.headers, 'Last Op ID');
  master = await readTab(sheets, MASTER);
  const results = [];
  for (const skidId of ids) {
    const obj = master.rows.filter((o) => String(o['Skid ID']).trim() === skidId)[0];
    if (!obj) { results.push({ skidId, ok: false, reason: 'not found' }); continue; }
    const step = subOp(opId, skidId);
    if (step && await opAlreadyDone(sheets, step)) {   // this skid was fully done by an earlier attempt
      results.push({ skidId, ticket: obj['Ticket'], ok: true, already: true });
      continue;
    }
    const halfDone = stampedBy(obj, step);   // earlier attempt changed the skid but didn't log it
    if (String(obj['Status']) === STATUS.USED && !halfDone) {
      // Re-use: some skids get used on more than one occasion. Rather than rework the row into a
      // second Used record (the report reads one row per skid), we log the extra use two ways —
      // append "Re-used <date>" to System Notes (NOT Comments, which is the human "who it's for"
      // field), and write a transaction-audit entry — then refresh 'Used At' to this latest date.
      const prior = String(obj['System Notes'] || '').trim();
      const merged = (prior ? prior + '; ' : '') + 'Re-used ' + date;
      await stampCells(sheets, MASTER, obj.__row, master.map, {
        'Used At': date, 'Used Via': 'Direct', 'System Notes': merged, 'Last Updated At': date, 'Last Op ID': step });
      await eventTx(sheets, { skidId, ticket: obj['Ticket'], itemText: 'USED IN PRODUCTION AGAIN (DIRECT)',
        operator: '', note: 'Re-used in Production (direct) for ' + date, timestamp: date, runningTotal: num(obj['Litho']) }, step);
      results.push({ skidId, ticket: obj['Ticket'], ok: true, reused: true });
      continue;
    }
    if (!halfDone) {
      await stampCells(sheets, MASTER, obj.__row, master.map, {
        'Status': STATUS.USED, 'Used At': date, 'Used Via': 'Direct', 'Last Updated At': date, 'Last Op ID': step });
    }
    // A half-done re-use left "Re-used <date>" at the end of System Notes; a first use doesn't touch it.
    const reused = halfDone && String(obj['System Notes'] || '').trim().endsWith('Re-used ' + date);
    await eventTx(sheets, { skidId, ticket: obj['Ticket'], itemText: reused ? 'USED IN PRODUCTION AGAIN (DIRECT)' : 'USED IN PRODUCTION (DIRECT)',
      operator: '', note: (reused ? 'Re-used in Production (direct) for ' : 'Marked Used in Production (direct) for ') + date, timestamp: date, runningTotal: num(obj['Litho']) }, step);
    results.push({ skidId, ticket: obj['Ticket'], ok: true, reused: reused || undefined });
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
  coilSkidId = String(coilSkidId || '').trim();
  if (opId && await opAlreadyDone(sheets, opId)) {   // already finished: report what that cut made
    const made = (await readTab(sheets, MASTER)).rows.filter((o) => stampedBy(o, opId) && String(o['Split Of']).trim() === coilSkidId)
      .map((o) => ({ skidId: o['Skid ID'], ticket: o['Ticket'], weight: num(o['Weight']), qty: num(o['QTY/LOAD']) }));
    return { ok: true, duplicate: true, created: made.length, coilSkidId, finished: finish !== false, tickets: made };
  }
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
  ens = await ensureColumn(sheets, MASTER, ens.headers, 'Last Op ID');
  master = await readTab(sheets, MASTER);
  const coil = master.rows.filter((o) => String(o['Skid ID']).trim() === coilSkidId)[0];
  if (!coil) throw new Error('Coil not found: ' + coilSkidId);
  // Children an earlier attempt of this same cut already wrote (it failed part-way): keep them and
  // only write the rest, so a retry can't create a second set of skids.
  const done = master.rows.filter((o) => stampedBy(o, opId) && String(o['Split Of']).trim() === coilSkidId);
  if (String(coil['Status']) === STATUS.USED && !stampedBy(coil, opId)) throw new Error('That coil is already marked Used.');
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
  const tickets = done.map((o) => ({ skidId: o['Skid ID'], ticket: o['Ticket'], weight: num(o['Weight']), qty: num(o['QTY/LOAD']) }));
  for (const s of list.slice(done.length)) {
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
    row['Last Op ID'] = opId || '';
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
      'Status': STATUS.USED, 'Used At': date, 'Used Via': 'Coil', 'Last Updated At': date, 'Last Op ID': opId || '' });   // 'Coil' distinguishes it from the direct quick-mark
  } else {
    await stampCells(sheets, MASTER, coil.__row, master.map, { 'Last Updated At': date, 'Last Op ID': opId || '' });
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

// ================= FRESH-START IMPORT (convert 'Current' + 'WIP' [+ 'Used in Production'] tabs) ===
// The operator pastes their Access data into two staging tabs — 'Current' and 'WIP' — one per
// state. This wipes Steel Tickets + Transactions and rebuilds Steel Tickets from those tabs:
// every row becomes a CLEAN single-column Steel Tickets row (fresh SKD id, Status taken from which
// tab it came from), mapped BY COLUMN NAME so it tolerates whatever columns each tab actually has.
// Rows are written at exact positions (no append drift), and the header is rebuilt clean — so this
// also permanently escapes the duplicate-column / staircase mess. Repeatable: re-run it whenever the
// Access data is refreshed. Transactions is cleared too, so a reused SKD id can't inherit an
// old skid's history. opId-deduped like the other mutations.
const IMPORT_TABS = [['Current', STATUS.CURRENT], ['WIP', STATUS.WIP]];
// Optional third tab: Access's "Used in Production" list (one line per day a ticket was used).
// Each ticket comes in ONCE as a Used skid, dated the last day it was used; the other days are
// listed in its System Notes. 'Date Used' is YYMMDD-NNN (260601-001 = 2026-06-01; only the date
// counts, the -NNN means nothing). A ticket still on Current / WIP was only partly used: it stays
// that one open skid, with the days it was used in its System Notes (no Used row, so its steel
// isn't counted twice). The first of these tab names that exists is read (any capitals); none = no used skids.
const IMPORT_USED_TABS = ['Used in Production', 'Used'];
const IMPORT_USED_VIA = 'Import';   // 'Used Via' on imported used skids (history shows "via Import")

// 'Date Used' -> yyyy-MM-dd, or '' when it isn't a real date. YYMMDD[-NNN] first; a plain date
// ("2026-06-01", "6/1/2026") or a Sheets date serial also works.
// One row per ticket from the Used in Production lines. open: {ticket: 1} for Current / WIP tickets.
function collapseUsed(lines, open, today) {
  const by = {}, order = [], bad = [], future = [];
  lines.forEach((o, i) => {
    const tk = String(o['Ticket']).trim(), raw = String(o['Date Used'] == null ? '' : o['Date Used']).trim();
    const on = importUsedDate(o['Date Used']);
    if (!on) bad.push(tk + ' (' + (raw || 'blank') + ')');
    else if (on > today) future.push(tk + ' (' + raw + ')');
    if (!by[tk]) { by[tk] = []; order.push(tk); }
    by[tk].push({ o, on, raw, i });
  });
  const rows = [], openNotes = {}, multi = [], alsoOpen = [];
  order.forEach((tk) => {
    const L = by[tk].slice().sort((a, b) => (a.on || '9') < (b.on || '9') ? -1 : (a.on || '9') > (b.on || '9') ? 1 : a.i - b.i);
    const days = L.map((x) => (x.on || x.raw || '?') + (x.o['QTY/LOAD'] != null && String(x.o['QTY/LOAD']).trim() !== '' ? ' (QTY ' + x.o['QTY/LOAD'] + ')' : '')).join(', ');
    if (open[tk]) { alsoOpen.push(tk); openNotes[tk] = 'Used in production ' + days + ' (from Access)'; return; }
    const dated = L.filter((x) => x.on), last = dated.length ? dated[dated.length - 1] : L[L.length - 1];
    const o = Object.assign({}, last.o);
    o['Date Used'] = L.map((x) => x.raw).filter(Boolean).join(', ');
    o.__usedOn = last.on || '';
    if (L.length > 1) { multi.push(tk + ' (' + L.length + ' days)'); o.__note = 'Used in production on ' + L.length + ' days: ' + days; }
    rows.push(o);
  });
  return { rows, openNotes, multi, alsoOpen, bad, future };
}

function importUsedDate(v) {
  if (typeof v === 'number' && v > 20000 && v < 80000) return serialToYMD(v, TZ);
  const t = String(v == null ? '' : v).trim();
  let y, mo, d, m;
  if ((m = /^(\d{2})(\d{2})(\d{2})(?:\s*-\s*\d+)?$/.exec(t))) { y = 2000 + +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(t))) { y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; mo = +m[1]; d = +m[2]; }
  else return '';
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return '';
  return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

// Lifecycle / bookkeeping columns the app writes over a skid's life. They aren't in the source tabs,
// but we pre-create them (blank) so the fresh Steel Tickets header is complete — the app never has to
// widen the sheet later and nothing reads as a "missing header". Names are exact (from the code that
// stamps them), so no phantom duplicates get created.
const IMPORT_LIFECYCLE_COLS = ['System Notes', 'Split Of', 'Cut Type', 'Load #', 'Run ID', 'Job ID', 'Receiver', 'Litho', 'Litho Notes',
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
  const titles = ((await sheets.meta()).sheets || []).map((x) => String((x.properties && x.properties.title) || ''));
  let usedTab = '';
  for (const name of IMPORT_USED_TABS) { usedTab = titles.filter((t) => t.trim().toLowerCase() === name.toLowerCase())[0] || ''; if (usedTab) break; }
  let used = { rows: [], openNotes: {}, multi: [], alsoOpen: [], bad: [], future: [] }, usedLines = 0;
  if (usedTab) {
    const data = await readObjects(sheets, usedTab);
    if (!data.headers.length || data.headers.indexOf('Ticket') === -1) throw new Error('The "' + usedTab + '" tab needs a header row with a "Ticket" column.');
    if (data.headers.indexOf('Date Used') === -1) throw new Error('The "' + usedTab + '" tab needs a "Date Used" column (like 260601-001).');
    const lines = data.rows.filter((o) => String(o['Ticket'] || '').trim() !== '');
    const open = {};
    parts.forEach((p) => p.rows.forEach((o) => { open[String(o['Ticket']).trim()] = 1; }));
    used = collapseUsed(lines, open, todayYMD());
    usedLines = lines.length;
    parts.push({ tabName: 'Used', status: STATUS.USED, headers: data.headers, rows: used.rows });
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

  // 2b) Receivers survive the wipe: first bring every receiver's kept mill / ticket numbers up to
  //     date from the Steel Tickets about to be wiped, then put each imported ticket back on the
  //     receiver that kept its mill (else ticket) number. Never by row order or Skid ID.
  let look = null;
  const expected = [];   // Current / WIP tickets on a receiver now, to report any that don't come back
  const rt = await receiverTabForKeeping(sheets);
  if (rt) {
    const old = await readTab(sheets, MASTER);
    const plan = keepPlan(rt, old.rows);
    if (plan.data.length) await sheets.batchUpdate(plan.data);
    look = receiverLookup(plan.lists);
    old.rows.forEach((o) => {
      const id = keepKey(o['Receiver']), st = o['Status'] || STATUS.CURRENT;
      if (id && (st === STATUS.CURRENT || st === STATUS.WIP)) expected.push({ id, ticket: String(o['Ticket'] || o['Skid ID'] || ''), mill: keepKey(o['Mill']), tk: keepKey(o['Ticket']) });
    });
  }

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
  let n = 0, restored = 0;
  const counts = { Current: 0, WIP: 0, Used: 0 };
  const back = {}, conflicts = [];   // back: "R-x|mill" / "R-x|#ticket" that found its ticket again
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
      const sysNote = p.status === STATUS.USED ? o.__note : used.openNotes[String(o['Ticket']).trim()];
      if (sysNote) rec['System Notes'] = String(rec['System Notes'] || '').trim() ? rec['System Notes'] + ' | ' + sysNote : sysNote;
      if (p.status === STATUS.USED) {
        rec['Used At'] = o.__usedOn;
        rec['Used Via'] = IMPORT_USED_VIA;
      }
      if (look && !String(rec['Receiver'] || '').trim()) {
        const mt = matchReceiver(look, o['Mill'], o['Ticket']);
        if (mt && mt.receiver) { rec['Receiver'] = mt.receiver; restored++; }
        else if (mt && mt.conflict) conflicts.push(String(o['Ticket']));
      }
      const rid = keepKey(rec['Receiver']);
      if (rid) { if (keepKey(o['Mill'])) back[rid + '|' + keepKey(o['Mill'])] = 1; back[rid + '|#' + keepKey(o['Ticket'])] = 1; }
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
    note: 'Imported ' + n + ' skids from staging (Current ' + (counts['Current'] || 0) + ', WIP ' + (counts['WIP'] || 0) +
      (usedTab ? ', Used ' + (counts['Used'] || 0) : '') + ')' +
      (look ? '; receivers put back on ' + restored : ''),
    timestamp: date, runningTotal: 0 }, opId || '');
  const notBack = expected.filter((e) => !(e.mill && back[e.id + '|' + e.mill]) && !(e.tk && back[e.id + '|#' + e.tk]))
    .map((e) => e.ticket + ' (' + e.id + ')');
  return { ok: true, current: counts['Current'] || 0, wip: counts['WIP'] || 0, used: counts['Used'] || 0, usedTab, usedLines, total: n,
    usedBadDate: used.bad.slice(0, 100), usedBadDateCount: used.bad.length, usedFutureDate: used.future.slice(0, 100), usedFutureDateCount: used.future.length,
    usedMultiDay: used.multi.slice(0, 100), usedMultiDayCount: used.multi.length, usedAlsoOpen: used.alsoOpen.slice(0, 100), usedAlsoOpenCount: used.alsoOpen.length,
    receiversRestored: restored, receiversNotBack: notBack.slice(0, 100), receiversNotBackCount: notBack.length, receiverConflicts: conflicts.slice(0, 100),
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

// ---- Product trace detail ----
// Every report row carries where its steel came from (mill, supplier, specs), what was done to it
// (each coating with its chem code, date and who), which job / customer it was for, and where it
// went (used date, run, what it was cut into). Built from one read of Transactions and Jobs.
function txHistoryRow(r) {
  return { timestamp: r['Timestamp'], ticket: r['Ticket'], passNumber: num(r['Pass Number']), operator: r['Operator'],
    group: r['Group'], sub: r['Sub-Variant'], item: r['Item'], chemCode: r['Chem Code'], passTotal: r['Pass Total Cost'],
    notes: r['Notes'], jobName: r['Job Name'], jobId: r['Job ID'] || '', skidId: r['Skid ID'] };
}
async function traceContext(sheets, masterRows) {
  const bySkid = {}, byTicket = {};
  let tx = [];
  try { tx = (await readObjects(sheets, TRANSACTIONS)).rows; } catch (e) { /* no log */ }
  tx.forEach((r) => {
    const sid = String(r['Skid ID'] || '').trim();
    const key = sid || String(r['Ticket'] || '').trim();
    const into = sid ? bySkid : byTicket;
    if (!key) return;
    (into[key] = into[key] || []).push(txHistoryRow(r));
  });
  const jobs = {};
  try { (await readObjects(sheets, JOBS, true)).rows.forEach((j) => { if (j['Job ID']) jobs[String(j['Job ID']).trim()] = j; }); } catch (e) { /* none */ }
  const skids = {}, tickets = {};
  masterRows.forEach((o) => {
    if (o['Skid ID']) skids[String(o['Skid ID']).trim()] = o;
    const t = String(o['Ticket'] || '').trim(); if (t && !tickets[t]) tickets[t] = o;
  });
  const receivers = await receiverMap(sheets);
  return { bySkid, byTicket, jobs, skids, tickets, receivers };
}
function traceOf(o, ctx) {
  const sid = String(o['Skid ID'] || '').trim();
  const hist = (ctx.bySkid[sid] || []).concat(ctx.byTicket[String(o['Ticket'] || '').trim()] || [])
    .sort((a, b) => a.passNumber - b.passNumber);
  const coats = activeCoatings(hist);
  const jobId = String(o['Job ID'] || '').trim() || (coats.length ? coats[coats.length - 1].jobId : '');
  const job = ctx.jobs[jobId] || {};
  const customer = job['Description'] || (coats.length ? coats[coats.length - 1].jobName : '') || '';
  return {
    mill: o['Mill'] || '', supplier: o['Supplier'] || '', endUse: o['End Use'] || '', bw: o['BW'] != null ? o['BW'] : '',
    testedBw: o['Tested BW'] != null ? o['Tested BW'] : '', type: o['TC'] || '', temper: o['TM'] || '',
    width: o['Width'] != null ? o['Width'] : '', length: o['Length'] != null ? o['Length'] : '',
    qty: o['QTY/LOAD'] != null ? o['QTY/LOAD'] : '', weight: o['Weight'] != null ? o['Weight'] : '', cs: String(o['C/S'] || '').trim(),
    status: o['Status'] || '', jobId, customer, coatings: coats.map((c) => ({ item: c.item, chemCode: c.chemCode || '', group: c.group || '', sub: c.sub || '', date: c.date, by: c.by })),
    coatedOn: toYMD(o['First Coated At']), coatedBy: o['First Coated By'] || '', approvedBy: o['Approved By'] || '',
    usedOn: toYMD(usedAt(o)), usedVia: o['Used Via'] || '', runId: o['Run ID'] || '', splitOf: o['Split Of'] || '',
    comments: o['Comments'] || '', lithoNotes: o['Litho Notes'] || '',
    po: o['PO Number'] != null ? String(o['PO Number']) : '', litho: num(o['Litho']), ...receiverTrace(o, ctx),
  };
}

// ---- Begin trace: product made on a day -> the steel of its size used around that day ----
// The size is the can diameter: the first three digits of the ticket's End Use (603X700, 603 ENDS
// -> 603). '' = no size on the ticket.
function endUseDiameter(v) { const m = /^\s*(\d{3})(?!\d)/.exec(String(v || '')); return m ? m[1] : ''; }
// What a trace searches by: the line, not the exact can. Bodies run by diameter on their line, so
// every height is one group (603X700, 603X812 -> '603 BODIES': a changeover from 401X411 to 401X508
// is covered); ends only ever go to ends of their own diameter ('603 ENDS'). Anything else
// (211 OIL, 507 SF …) is its own group by its exact End Use.
function traceGroup(endUse) {
  const eu = String(endUse || '').trim().toUpperCase().replace(/\s+/g, ' '), dia = endUseDiameter(eu);
  if (dia && /\bENDS?\b/.test(eu)) return { key: dia + ' ENDS', label: dia + ' Ends', dia, kind: 2 };
  if (dia && /^\d{3}\s*X\s*\d/.test(eu)) return { key: dia + ' BODIES', label: dia + ' Bodies', dia, kind: 1 };
  return { key: eu, label: eu || 'No end use', dia: dia || '999', kind: 3 };
}
// Every day a ticket was used in production: its Used At (once Used), each day on its Access
// 'Date Used' (260916-005, 260918-002 -> 2026-09-16, 2026-09-18), and the days the import noted in
// System Notes for a ticket used partly and still on Current / WIP.
function usedDays(o) {
  const out = {};
  if (String(o['Status'] || '') === STATUS.USED) { const d = toYMD(usedAt(o)); if (/^\d{4}-\d\d-\d\d$/.test(d)) out[d] = 1; }
  String(o['Date Used'] || '').replace(/\b(\d{6})\s*-\s*\d+/g, (m, code) => { const d = importUsedDate(code); if (d) out[d] = 1; return m; });
  (String(o['System Notes'] || '').match(/Used in production[^|]*/gi) || []).forEach((seg) => (seg.match(/\d{4}-\d\d-\d\d/g) || []).forEach((d) => { out[d] = 1; }));
  return Object.keys(out).sort();
}
// date: the day the product was made. diameter: a trace group ('603 BODIES', '603 ENDS', or an
// exact odd End Use like '211 OIL'), 'ALL' for every ticket used, or a bare diameter ('603');
// '' = just list the groups used that day. days: how many calendar
// days to show on each side (1-5): with 1, the day before, the day itself and the day after —
// a day nothing was used on is still listed (empty), so the trace reads in date order.
async function getUseTrace(sheets, date, diameter, days) {
  date = toYMD(date || '');
  if (!/^\d{4}-\d\d-\d\d$/.test(date)) throw new Error('Pick the date the product was made.');
  diameter = String(diameter || '').trim().toUpperCase().replace(/\s+/g, ' ');
  const all3 = diameter === 'ALL', bareDia = /^\d{3}$/.test(diameter);
  days = Math.min(5, Math.max(1, parseInt(days, 10) || 1));
  const master = await readObjects(sheets, MASTER);
  // The sizes to pick from are the End Uses used ON that day (counts = tickets used that day).
  const sizes = {}, rows = [], anyDay = {};
  let dayCount = 0;
  master.rows.forEach((o) => {
    if (!(o['Ticket'] || o['Skid ID'])) return;
    const ud = usedDays(o);
    if (!ud.length) return;
    ud.forEach((d) => { anyDay[d] = 1; });
    const eu = String(o['End Use'] || '').trim().toUpperCase().replace(/\s+/g, ' '), g = traceGroup(eu);
    if (ud.indexOf(date) !== -1) {
      dayCount++;
      const z = sizes[g.key] = sizes[g.key] || { key: g.key, label: g.label, dia: g.dia, kind: g.kind, count: 0, endUses: {} };
      z.count++; if (eu) z.endUses[eu] = (z.endUses[eu] || 0) + 1;
    }
    if (diameter && (all3 || (bareDia ? g.dia === diameter : g.key === diameter))) rows.push({ o, ud });
  });
  const sizeList = Object.keys(sizes).map((k) => sizes[k]).sort((a, b) => (a.dia < b.dia ? -1 : a.dia > b.dia ? 1 : a.kind - b.kind || (a.key < b.key ? -1 : 1)))
    .map((z) => ({ key: z.key, label: z.label, count: z.count, endUses: Object.keys(z.endUses).sort().map((e) => ({ endUse: e, count: z.endUses[e] })) }));
  // With nothing used that day, the nearest days that used any steel (to jump to).
  const used = Object.keys(anyDay).sort();
  const near = { prevDay: used.filter((d) => d < date).slice(-1)[0] || '', nextDay: used.filter((d) => d > date)[0] || '' };
  const label = all3 ? 'All steel' : bareDia ? 'All ' + diameter : (sizes[diameter] ? sizes[diameter].label : traceGroup(diameter).label);
  if (!diameter) return Object.assign({ date, diameter, days, sizes: sizeList, dayCount, dayList: [] }, near);
  const ctx = await traceContext(sheets, master.rows);
  const byDay = {};
  rows.forEach((r) => r.ud.forEach((d) => { (byDay[d] = byDay[d] || []).push(r); }));
  const all = Object.keys(byDay).sort();
  const shift = (n) => { const p = date.split('-').map(Number), t = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)); return t.toISOString().slice(0, 10); };
  const before = [], after = [];
  for (let n = days; n >= 1; n--) before.push(shift(-n));
  for (let n = 1; n <= days; n++) after.push(shift(n));
  const key = (t) => { const m = /^(\d\d)(\d\d)(\d\d)-(\d+)/.exec(String(t || '')); return m ? m[3] + m[1] + m[2] + ('0000' + m[4]).slice(-4) : String(t || ''); };
  const dayOut = (d, rel, off) => ({ date: d, rel, offset: off, tickets: (byDay[d] || []).map((r) => Object.assign(traceOf(r.o, ctx), {
      ticket: r.o['Ticket'] || '', skidId: r.o['Skid ID'] || '', usedDays: r.ud, stillOpen: String(r.o['Status'] || '') !== STATUS.USED,
      daysCount: r.ud.length })).sort((a, b) => (key(a.ticket) < key(b.ticket) ? -1 : key(a.ticket) > key(b.ticket) ? 1 : 0)) });
  const dayList = before.map((d, i) => dayOut(d, 'before', days - i)).concat([dayOut(date, 'on', 0)], after.map((d, i) => dayOut(d, 'after', i + 1)));
  return Object.assign({ date, diameter, label, days, sizes: sizeList, dayCount, dayList, firstDay: all[0] || '', lastDay: all[all.length - 1] || '' }, near);
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
  const ctx = dept === 'count' ? null : await traceContext(sheets, master.rows);
  const tr = (o) => Object.assign(traceOf(o, ctx), { ticket: o['Ticket'], skidId: o['Skid ID'] });

  if (want('litho')) {
    const rows = [];
    master.rows.forEach((o) => {
      const st = o['Status'] || '';
      if (st !== STATUS.WIP && st !== STATUS.IN_PRODUCTION && st !== STATUS.USED) return;
      if (!inRange(o['First Coated At'], start, end)) return;
      rows.push(Object.assign(tr(o), { date: toYMD(o['First Coated At']), by: o['First Coated By'] || '', litho: num(o['Litho']) }));
    });
    rows.sort(byDate);
    sections.push({ key: 'litho', label: 'Litho — skids coated', rows });
  }

  if (want('direct')) {
    const rows = [];
    master.rows.forEach((o) => {
      if ((o['Status'] || '') !== STATUS.USED) return;
      const via = String(o['Used Via'] || '');
      if (via !== 'Direct' && via !== IMPORT_USED_VIA) return;   // the quick-mark flow (and Access's list, imported), not runs/slitter
      if (!inRange(usedAt(o), start, end)) return;
      rows.push(Object.assign(tr(o), { date: toYMD(usedAt(o)), litho: num(o['Litho']), cost: num(o['Cost']) }));   // date only
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
      const row = Object.assign(tr(o), { date: usedAt(o), machine, by: o['Used By'] || '', sheets: num(o['QTY/LOAD']), litho: num(o['Litho']) });   // full date + time
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
      // Each source skid the pallet was cut from, with its own trace (mill, supplier, coatings, customer).
      const sources = comp.map((c) => {
        const src = ctx.skids[String(c.skidId || '').trim()];
        const t = src ? tr(src) : { ticket: c.ticket || '', skidId: c.skidId || '', mill: c.mill || '', coatings: [] };
        return Object.assign(t, { ticket: t.ticket || c.ticket || '', mill: t.mill || c.mill || '', used: c.strips != null ? c.strips : (c.qty || 0) });
      });
      const row = { date: toYMD(p['Created On']), loadNo: p['Load #'] || '', machine: sess['Slitter'] || '', by: sess['Operator'] || '', output: num(p['Output Count']), unit: kind === 'Scroll' ? 'Strips' : 'Body Blanks', from, skidId: p['Skid ID'] || '', cost: num(cutRow['Cost']), litho: num(cutRow['Litho']),
        sources, status: cutRow['Status'] || '', usedOn: toYMD(usedAt(cutRow)), notes: p['Notes'] || '' };
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
