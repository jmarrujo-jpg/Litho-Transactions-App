/**
 * LITHO FLOOR APP - backend
 * Bind this script to the "Traceability Test" spreadsheet
 * (Extensions > Apps Script from inside the sheet).
 */

var SPREADSHEET_ID = '12Irb-isWOO14SrlGglcgnHc8oi0mLwW54LNo7pBHKjg';

function getSpreadsheet_() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

var SHEETS = {
  CURRENT_STEEL: 'Current Steel',
  IN_PROGRESS: 'Litho In Progress',
  TRANSACTIONS: 'Litho Transactions',
  WIP: 'WIP',
  RATE_TABLE: 'Litho Rate Table'
};

// Extra columns Litho In Progress has on top of the normal steel columns
var PROGRESS_EXTRA_COLS = ['Status', 'Started By', 'Started At', 'Pass Count', 'Running Litho Total'];

var TRANSACTION_COLS = ['Timestamp', 'Ticket', 'Pass Number', 'Operator', 'Group', 'Sub-Variant',
  'Item', 'Chem Code', 'Application Cost', 'Line Cost', 'Pass Total Cost', 'Running Total After Pass', 'Notes', 'Job Name'];

var RATE_TABLE_COLS = ['Group', 'Sub-Variant', 'BB Per Hour', 'Item', 'Chem Code',
  'Application Cost', 'Line Cost', 'Total Cost'];

// ---- Rate data, transcribed from the "Litho Costs" tab (HIGH VOLUME CANS section) ----
var RATE_DATA = (function () {
  var blocks = [
    { group: '603X408,409,410,700,812', sub: '5-OUT', bbph: 65.592, rows: [
      ['FULL ENAMEL BPANI', '31S46AM / 9372535', 11.80, 12.88, 24.68],
      ['INSIDE EPOXY PHENOLIC', '6256069', 7.27, 6.44, 13.71],
      ['INSIDE DBL EPXY PHENOLC', '6256069 / 6256069', 14.54, 12.88, 27.42],
      ['INSIDE C-ENAMEL (ESTIMATED)', '', 9.50, 12.88, 22.38],
      ['INSIDE VALSPAR BPA NON INTENT', '31S46AM', 6.47, 6.44, 12.91],
      ['INSIDE ALUMINUM SLURRY', '', 5.68, 12.88, 18.56],
      ['INSIDE UNIVERSAL WHITE/ SINGLE', '', 5.29, 6.44, 11.73],
      ['INSIDE UNIVERSAL WHITE/ DOUBLE', '', 10.58, 12.88, 23.46],
      ['OUTSIDE WHITE COAT', 'PPG8129050', 5.36, 6.44, 11.80],
      ['OUTSIDE CLEAR BODY VARNISH', '51S01AB', 4.39, 6.44, 10.83],
      ['OUTSIDE GOLD EPOXY', '6356069', 7.27, 6.44, 13.71],
      ['INSIDE OLEO BPA NON INTENT (DO NOT USE)', '', 5.60, 6.44, 12.04],
      ['OUTSIDE VALSPAR GOLD JUANITAS', '9372535', 5.33, 6.44, 11.77],
      ['OUTSIDE SIZE COAT', '51S28AA', 2.49, 6.44, 8.93],
      ['OUTSIDE CLEAR END ENAMEL', '51S01AB', 4.39, 6.44, 10.83]
    ]},
    { group: '603X408,409,410,700,812', sub: '10-OUT', bbph: 131.184, rows: [
      ['FULL ENAMEL BPANI', '31S46AM / 9372535', 11.80, 6.44, 18.24],
      ['INSIDE EPOXY PHENOLIC', '6256069', 7.27, 3.22, 10.49],
      ['INSIDE DBL EPXY PHENOLC', '6256069 / 6256069', 14.54, 6.44, 20.98],
      ['INSIDE C-ENAMEL (ESTIMATED)', '', 9.50, 6.44, 15.94],
      ['INSIDE VALSPAR BPA NON INTENT', '31S46AM', 6.47, 3.22, 9.69],
      ['INSIDE ALUMINUM SLURRY', '', 5.68, 6.44, 12.12],
      ['INSIDE UNIVERSAL WHITE/ SINGLE', '', 5.29, 3.22, 8.51],
      ['INSIDE UNIVERSAL WHITE/ DOUBLE', '', 10.58, 6.44, 17.02],
      ['OUTSIDE WHITE COAT', 'PPG8129050', 5.36, 3.22, 8.58],
      ['OUTSIDE CLEAR BODY VARNISH', '51S01AB', 4.39, 3.22, 7.61],
      ['OUTSIDE GOLD EPOXY', '6356069', 7.27, 3.22, 10.49],
      ['INSIDE OLEO BPA NON INTENT (DO NOT USE)', '', 5.60, 3.22, 8.82],
      ['OUTSIDE VALSPAR GOLD JUANITAS', '9372535', 5.33, 3.22, 8.55],
      ['OUTSIDE SIZE COAT', '51S28AA', 2.49, 3.22, 5.71],
      ['OUTSIDE CLEAR END ENAMEL', '51S01AB', 4.39, 3.22, 7.61]
    ]},
    { group: '401X400,411,508,509', sub: '21-OUT', bbph: 120.674, rows: [
      ['FULL ENAMEL BPANI', '31S46AM / 9372535', 11.80, 7.00, 18.80],
      ['INSIDE EPOXY PHENOLIC', '6256069', 7.27, 3.50, 10.77],
      ['INSIDE DBL EPXY PHENOLC', '6256069 / 6256069', 14.54, 7.00, 21.54],
      ['INSIDE C-ENAMEL (ESTIMATED)', '', 9.50, 7.00, 16.50],
      ['INSIDE VALSPAR BPA NON INTENT', '31S46AM', 6.47, 3.50, 9.97],
      ['INSIDE ALUMINUM SLURRY', '', 5.68, 7.00, 12.68],
      ['INSIDE UNIVERSAL WHITE/ SINGLE', '', 5.29, 3.50, 8.79],
      ['INSIDE UNIVERSAL WHITE/ DOUBLE', '', 10.58, 7.00, 17.58],
      ['OUTSIDE WHITE COAT', 'PPG8129050', 5.36, 3.50, 8.86],
      ['OUTSIDE CLEAR BODY VARNISH', '51S01AB', 4.39, 3.50, 7.89],
      ['OUTSIDE GOLD EPOXY', '6356069', 7.27, 3.50, 10.77],
      ['INSIDE OLEO BPA NON INTENT (DO NOT USE)', '', 5.60, 3.50, 9.10],
      ['OUTSIDE VALSPAR GOLD JUANITAS', '9372535', 5.33, 3.50, 8.83],
      ['OUTSIDE SIZE COAT', '51S28AA', 2.49, 3.50, 5.99],
      ['OUTSIDE CLEAR END ENAMEL', '51S01AB', 4.39, 3.50, 7.89]
    ]},
    { group: '401/404 X 700', sub: '10-OUT', bbph: 90.833, rows: [
      ['FULL ENAMEL BPANI', '31S46AM / 9372535', 11.80, 9.30, 21.10],
      ['INSIDE EPOXY PHENOLIC', '6256069', 7.27, 4.65, 11.92],
      ['INSIDE DBL EPXY PHENOLC', '6256069 / 6256069', 14.54, 9.30, 23.84],
      ['INSIDE C-ENAMEL (ESTIMATED)', '', 9.50, 9.30, 18.80],
      ['INSIDE VALSPAR BPA NON INTENT', '31S46AM', 6.47, 4.65, 11.12],
      ['INSIDE ALUMINUM SLURRY', '', 5.68, 9.30, 14.98],
      ['INSIDE UNIVERSAL WHITE/ SINGLE', '', 5.29, 4.65, 9.94],
      ['INSIDE UNIVERSAL WHITE/ DOUBLE', '', 10.58, 9.30, 19.88],
      ['OUTSIDE WHITE COAT', 'PPG8129050', 5.36, 4.65, 10.01],
      ['OUTSIDE CLEAR BODY VARNISH', '51S01AB', 4.39, 4.65, 9.04],
      ['OUTSIDE GOLD EPOXY', '6356069', 7.27, 4.65, 11.92],
      ['INSIDE OLEO BPA NON INTENT (DO NOT USE)', '', 5.60, 4.65, 10.25],
      ['OUTSIDE VALSPAR GOLD JUANITAS', '9372535', 5.33, 4.65, 9.98],
      ['OUTSIDE SIZE COAT', '51S28AA', 2.49, 4.65, 7.14],
      ['OUTSIDE CLEAR END ENAMEL', '51S01AB', 4.39, 4.65, 9.04]
    ]},
    { group: '401/404 X 700', sub: '15-OUT', bbph: 135.817, rows: [
      ['FULL ENAMEL BPANI', '31S46AM / 9372535', 11.80, 6.22, 18.02],
      ['INSIDE EPOXY PHENOLIC', '6256069', 7.27, 3.11, 10.38],
      ['INSIDE DBL EPXY PHENOLC', '6256069 / 6256069', 14.54, 6.22, 20.76],
      ['INSIDE C-ENAMEL (ESTIMATED)', '', 9.50, 6.22, 15.72],
      ['INSIDE VALSPAR BPA NON INTENT', '31S46AM', 6.47, 3.11, 9.58],
      ['INSIDE ALUMINUM SLURRY', '', 5.68, 6.22, 11.90],
      ['INSIDE UNIVERSAL WHITE/ SINGLE', '', 5.29, 3.11, 8.40],
      ['INSIDE UNIVERSAL WHITE/ DOUBLE', '', 10.58, 6.22, 16.80],
      ['OUTSIDE WHITE COAT', 'PPG8129050', 5.36, 3.11, 8.47],
      ['OUTSIDE CLEAR BODY VARNISH', '51S01AB', 4.39, 3.11, 7.50],
      ['OUTSIDE GOLD EPOXY', '6356069', 7.27, 3.11, 10.38],
      ['INSIDE OLEO BPA NON INTENT (DO NOT USE)', '', 5.60, 3.11, 8.71],
      ['OUTSIDE VALSPAR GOLD JUANITAS', '9372535', 5.33, 3.11, 8.44],
      ['OUTSIDE SIZE COAT', '51S28AA', 2.49, 3.11, 5.60],
      ['OUTSIDE CLEAR END ENAMEL', '51S01AB', 4.39, 3.11, 7.50]
    ]},
    { group: '211 Diameter', sub: '28-OUT', bbph: 110.438, rows: [
      ['FULL ENAMEL BPANI', '31S46AM / 9372535', 11.80, 7.65, 19.45],
      ['INSIDE EPOXY PHENOLIC', '6256069', 7.27, 3.82, 11.09],
      ['INSIDE DBL EPXY PHENOLC', '6256069 / 6256069', 14.54, 7.65, 22.19],
      ['INSIDE C-ENAMEL (ESTIMATED)', '', 9.50, 7.65, 17.15],
      ['INSIDE VALSPAR BPA NON INTENT', '31S46AM', 6.47, 3.82, 10.29],
      ['INSIDE ALUMINUM SLURRY', '', 5.68, 7.65, 13.33],
      ['INSIDE UNIVERSAL WHITE/ SINGLE', '', 5.29, 3.82, 9.11],
      ['INSIDE UNIVERSAL WHITE/ DOUBLE', '', 10.58, 7.65, 18.23],
      ['OUTSIDE WHITE COAT', 'PPG8129050', 5.36, 3.82, 9.18],
      ['OUTSIDE CLEAR BODY VARNISH', '51S01AB', 4.39, 3.82, 8.21],
      ['OUTSIDE GOLD EPOXY', '6356069', 7.27, 3.82, 11.09],
      ['INSIDE OLEO BPA NON INTENT (DO NOT USE)', '', 5.60, 3.82, 9.42],
      ['OUTSIDE VALSPAR GOLD JUANITAS', '9372535', 5.33, 3.82, 9.15],
      ['OUTSIDE SIZE COAT', '51S28AA', 2.49, 3.82, 6.31],
      ['OUTSIDE CLEAR END ENAMEL', '51S01AB', 4.39, 3.82, 8.21]
    ]},
    { group: '603 ENDS', sub: '', bbph: 96.499, rows: [
      ['FULL ENAMEL BPANI', '31S46AM / 9372535', 11.80, 8.75, 20.55],
      ['INSIDE EPOXY PHENOLIC', '6256069', 7.27, 4.38, 11.65],
      ['INSIDE DBL EPXY PHENOLC', '6256069 / 6256069', 14.54, 8.75, 23.29],
      ['INSIDE C-ENAMEL (ESTIMATED)', '', 9.50, 8.75, 18.25],
      ['INSIDE VALSPAR BPA NON INTENT', '31S46AM', 6.47, 4.38, 10.85],
      ['INSIDE ALUMINUM SLURRY', '', 5.68, 8.75, 14.43],
      ['INSIDE UNIVERSAL WHITE/ SINGLE', '', 5.29, 4.38, 9.67],
      ['INSIDE UNIVERSAL WHITE/ DOUBLE', '', 10.58, 8.75, 19.33],
      ['OUTSIDE WHITE COAT', 'PPG8129050', 5.36, 4.38, 9.74],
      ['OUTSIDE CLEAR BODY VARNISH', '51S01AB', 4.39, 4.38, 8.77],
      ['OUTSIDE GOLD EPOXY', '6356069', 7.27, 4.38, 11.65],
      ['INSIDE OLEO BPA NON INTENT (DO NOT USE)', '', 5.60, 4.38, 9.98],
      ['OUTSIDE VALSPAR GOLD JUANITAS', '9372535', 5.33, 4.38, 9.71],
      ['OUTSIDE SIZE COAT', '51S28AA', 2.49, 4.38, 6.87],
      ['OUTSIDE CLEAR END ENAMEL', '51S01AB', 4.39, 4.38, 8.77]
    ]},
    { group: '401 & 404 ENDS', sub: '', bbph: 97.220, rows: [
      ['FULL ENAMEL BPANI', '31S46AM / 9372535', 11.80, 8.69, 20.49],
      ['INSIDE EPOXY PHENOLIC', '6256069', 7.27, 4.34, 11.61],
      ['INSIDE DBL EPXY PHENOLC', '6256069 / 6256069', 14.54, 8.69, 23.23],
      ['INSIDE C-ENAMEL (ESTIMATED)', '', 9.50, 8.69, 18.19],
      ['INSIDE VALSPAR BPA NON INTENT', '31S46AM', 6.47, 4.34, 10.81],
      ['INSIDE ALUMINUM SLURRY', '', 5.68, 8.69, 14.37],
      ['INSIDE UNIVERSAL WHITE/ SINGLE', '', 5.29, 4.34, 9.63],
      ['INSIDE UNIVERSAL WHITE/ DOUBLE', '', 10.58, 8.69, 19.27],
      ['OUTSIDE WHITE COAT', 'PPG8129050', 5.36, 4.34, 9.70],
      ['OUTSIDE CLEAR BODY VARNISH', '51S01AB', 4.39, 4.34, 8.73],
      ['OUTSIDE GOLD EPOXY', '6356069', 7.27, 4.34, 11.61],
      ['INSIDE OLEO BPA NON INTENT (DO NOT USE)', '', 5.60, 4.34, 9.94],
      ['OUTSIDE VALSPAR GOLD JUANITAS', '9372535', 5.33, 4.34, 9.67],
      ['OUTSIDE SIZE COAT', '51S28AA', 2.49, 4.34, 6.83],
      ['OUTSIDE CLEAR END ENAMEL', '51S01AB', 4.39, 4.34, 8.73]
    ]},
    // Specialty / low-volume, and setup charges: flat-rate, not tied to a steel size.
    { group: 'Specialty / Low Volume / Setup', sub: '', bbph: null, rows: [
      ['SIZE', '', 0, 0, 11.21],
      ['ENAMEL ONE SIDE', '', 0, 0, 18.12],
      ['WHITE BASE COAT', '', 0, 0, 26.60],
      ['VARNISH WET-STANDARD', '', 0, 0, 10.85],
      ['VARNISH WET-PEBBLE', '', 0, 0, 16.71],
      ['VARNISH DRY-STANDARD', '', 0, 0, 20.15],
      ['VARNISH DRY-PEBBLE', '', 0, 0, 24.14],
      ['WAX ONLY', '', 0, 0, 7.68],
      ['LITHO PRINT SINGLE COLOR - ONE', '', 0, 0, 12.56],
      ['LITHO PRINT SINGLE COLOR - TWO', '', 0, 0, 28.13],
      ['LITHO PRINT SINGLE COLOR - THREE', '', 0, 0, 42.20],
      ['LITHO PRINT SINGLE COLOR - FOUR', '', 0, 0, 56.27],
      ['LITHO PRINT SINGLE COLOR - FIVE', '', 0, 0, 70.34],
      ['LITHO PRINT SINGLE COLOR - SIX', '', 0, 0, 84.40],
      ['LITHO PRINT TWO COLOR - ONE', '', 0, 0, 20.68],
      ['LITHO PRINT TWO COLOR - TWO', '', 0, 0, 20.68],
      ['LITHO PRINT TWO COLOR - THREE', '', 0, 0, 46.32],
      ['LITHO PRINT TWO COLOR - FOUR', '', 0, 0, 46.32],
      ['LITHO PRINT TWO COLOR - FIVE', '', 0, 0, 69.48],
      ['LITHO PRINT TWO COLOR - SIX', '', 0, 0, 69.48],
      ['SET UP CHARGE FOR COATING (per hour)', '', 0, 0, 422.26],
      ['SET UP SINGLE COLOR PRESS (per print)', '', 0, 0, 720.68],
      ['SET UP TWO COLOR PRESS (per pass)', '', 0, 0, 1152.97],
      ['SMALL QUANTITY PRINT JOB (per pass)', '', 0, 0, 2133.12],
      ['ADDITIONAL CHARGE - SMALL QTY (per print)', '', 0, 0, 355.44]
    ]}
  ];

  var out = [];
  blocks.forEach(function (b) {
    b.rows.forEach(function (r) {
      out.push([b.group, b.sub, b.bbph, r[0], r[1], r[2], r[3], r[4]]);
    });
  });
  return out;
})();

/** Run this once from the Apps Script editor to (re)build the Litho Rate Table tab. */
function seedRateTable() {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName(SHEETS.RATE_TABLE);
  if (!sh) sh = ss.insertSheet(SHEETS.RATE_TABLE);
  sh.clear();
  sh.getRange(1, 1, 1, RATE_TABLE_COLS.length).setValues([RATE_TABLE_COLS]);
  sh.getRange(2, 1, RATE_DATA.length, RATE_TABLE_COLS.length).setValues(RATE_DATA);
  sh.setFrozenRows(1);
  sh.autoResizeColumns(1, RATE_TABLE_COLS.length);
  CacheService.getScriptCache().remove(RATE_CACHE_KEY); // rates changed -> drop stale cache
}

/** Run this once to create the Litho In Progress and Litho Transactions headers. */
function setupTabs() {
  var ss = getSpreadsheet_();

  var csHeaders = getHeaders_(getSheet_(SHEETS.CURRENT_STEEL));

  var progress = getInProgressSheet_();
  if (progress.getLastRow() < 1 || progress.getRange(1, 1).getValue() === '') {
    var progressHeaders = csHeaders.concat(PROGRESS_EXTRA_COLS);
    progress.getRange(1, 1, 1, progressHeaders.length).setValues([progressHeaders]);
    progress.setFrozenRows(1);
  }

  var tx = getTransactionsSheet_();
  if (tx.getLastRow() < 1 || tx.getRange(1, 1).getValue() === '') {
    tx.getRange(1, 1, 1, TRANSACTION_COLS.length).setValues([TRANSACTION_COLS]);
    tx.setFrozenRows(1);
  }

  seedRateTable();
}

function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Litho Floor App')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * Fill this in with your real operator names whenever you're ready — one edit here
 * is all it takes, no changes needed anywhere else. Until then the name field on the
 * app still accepts free typing so nobody's blocked.
 */
var OPERATOR_NAMES = [];

function getOperatorNames() {
  return OPERATOR_NAMES;
}

/** Finds an unused "<ticket>-R", "-R2", "-R3"... id across Current Steel, Litho In
 *  Progress, and WIP, so repeated partial splits of the same ticket don't collide. */
function generateRemainderTicketId_(baseTicket) {
  var cs = getSheet_(SHEETS.CURRENT_STEEL);
  var ip = getInProgressSheet_();
  var wip = getSheet_(SHEETS.WIP);
  for (var i = 1; i <= 20; i++) {
    var candidate = baseTicket + (i === 1 ? '-R' : '-R' + i);
    if (findRowByTicket_(cs, candidate) === -1 &&
        findRowByTicket_(ip, candidate) === -1 &&
        findRowByTicket_(wip, candidate) === -1) {
      return candidate;
    }
  }
  throw new Error('Too many existing splits of ticket ' + baseTicket + '. Rename manually.');
}

// ---------------- helpers ----------------

function getSheet_(name) {
  var sh = getSpreadsheet_().getSheetByName(name);
  if (!sh) sh = getSpreadsheet_().insertSheet(name);
  return sh;
}

/** Litho In Progress, headers auto-created from Current Steel + extra cols if missing. */
function getInProgressSheet_() {
  var sh = getSheet_(SHEETS.IN_PROGRESS);
  if (sh.getLastColumn() === 0) {
    var csHeaders = getHeaders_(getSheet_(SHEETS.CURRENT_STEEL));
    var headers = csHeaders.concat(PROGRESS_EXTRA_COLS);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
  }
  return sh;
}

/** Litho Transactions, headers auto-created if missing. */
function getTransactionsSheet_() {
  var sh = getSheet_(SHEETS.TRANSACTIONS);
  if (sh.getLastColumn() === 0) {
    sh.getRange(1, 1, 1, TRANSACTION_COLS.length).setValues([TRANSACTION_COLS]);
    sh.setFrozenRows(1);
  }
  return sh;
}

/** Litho Rate Table, seeded automatically if missing/empty. */
function getRateTableSheet_() {
  var sh = getSheet_(SHEETS.RATE_TABLE);
  if (sh.getLastColumn() === 0) {
    seedRateTable();
    sh = getSheet_(SHEETS.RATE_TABLE);
  }
  return sh;
}

function getHeaders_(sheet) {
  if (sheet.getLastColumn() === 0) return [];
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
}

function headerMap_(sheet) {
  var headers = getHeaders_(sheet);
  var map = {};
  headers.forEach(function (h, i) { if (h) map[h] = i + 1; });
  return map;
}

function rowToObject_(headers, rowValues) {
  var obj = {};
  headers.forEach(function (h, i) { if (h) obj[h] = rowValues[i]; });
  return obj;
}

/** Dates don't reliably cross the google.script.run bridge and can hang the client
 *  with no success/failure callback firing. Convert them to plain strings before
 *  returning anything from a server function. */
function sanitizeForClient_(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone() || 'America/Los_Angeles', 'yyyy-MM-dd HH:mm:ss');
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeForClient_);
  }
  if (value && typeof value === 'object') {
    var out = {};
    Object.keys(value).forEach(function (k) { out[k] = sanitizeForClient_(value[k]); });
    return out;
  }
  return value;
}

function findRowByTicket_(sheet, ticket) {
  var map = headerMap_(sheet);
  var ticketCol = map['Ticket'];
  if (!ticketCol) return -1;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  var values = sheet.getRange(2, ticketCol, lastRow - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() === String(ticket).trim()) return i + 2;
  }
  return -1;
}

/** Copies a row from one sheet to another by matching header NAMES, not column position. */
function copyRowByHeaderName_(srcSheet, srcRow, destSheet) {
  var srcHeaders = getHeaders_(srcSheet);
  var srcValues = srcSheet.getRange(srcRow, 1, 1, srcHeaders.length).getValues()[0];
  var srcObj = rowToObject_(srcHeaders, srcValues);

  var destMap = headerMap_(destSheet);
  var destLastCol = Math.max(destSheet.getLastColumn(), Object.keys(destMap).length);
  var newRowArr = new Array(destLastCol).fill('');

  Object.keys(destMap).forEach(function (colName) {
    if (srcObj.hasOwnProperty(colName)) {
      newRowArr[destMap[colName] - 1] = srcObj[colName];
    }
  });

  var destRow = destSheet.getLastRow() + 1;
  destSheet.getRange(destRow, 1, 1, newRowArr.length).setValues([newRowArr]);
  return destRow;
}

/** Appends any missing header columns to a sheet (at the end) and returns the refreshed
 *  header->column map. Used to add managed columns like "Litho Notes" to sheets that were
 *  created outside the app, without disturbing existing columns. */
function ensureColumns_(sheet, names) {
  var map = headerMap_(sheet);
  names.forEach(function (n) {
    if (!map[n]) {
      var col = sheet.getLastColumn() + 1;
      sheet.getRange(1, col).setValue(n);
      map[n] = col;
    }
  });
  return map;
}

/** Serializes every mutating operation behind Apps Script's script-wide lock so two operators
 *  acting at the same moment (e.g. both coating the same ticket from different tablets) can't
 *  interleave reads and writes — the second call waits for the first to finish. */
function withScriptLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000); // wait up to 30s for the other operator's write to finish
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ---------------- rate table access ----------------

// Rate/pricing data almost never changes, so it's cached script-wide (shared across all
// operators). Ticket data — queue, in-progress, WIP, history — is deliberately NOT cached
// and is always read live, so operators always see each other's changes immediately.
var RATE_CACHE_KEY = 'rateTableJson';
var RATE_CACHE_TTL_SECONDS = 600; // 10 min safety net for hand-edits; seedRateTable clears it

function getRateTable_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get(RATE_CACHE_KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* fall through and rebuild */ }
  }

  var sh = getRateTableSheet_();
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  var values = sh.getRange(2, 1, lastRow - 1, RATE_TABLE_COLS.length).getValues();
  var rows = values.map(function (r) {
    return {
      group: r[0], sub: r[1], bbph: r[2], item: r[3],
      chemCode: r[4], appCost: r[5], lineCost: r[6], totalCost: r[7]
    };
  }).filter(function (r) { return r.group; });

  try { cache.put(RATE_CACHE_KEY, JSON.stringify(rows), RATE_CACHE_TTL_SECONDS); } catch (e) {}
  return rows;
}

/** Whole rate structure in one payload so the client can drive the Group -> Sub -> Item
 *  dropdowns entirely in-browser, with no per-selection server round trip. */
function getRateTree() {
  var rt = getRateTable_();
  var groups = [];
  var tree = {};
  rt.forEach(function (r) {
    if (!tree[r.group]) {
      tree[r.group] = { subs: [], items: {} };
      groups.push(r.group);
    }
    var node = tree[r.group];
    var subKey = r.sub || '';
    if (!node.items[subKey]) {
      node.items[subKey] = [];
      node.subs.push(r.sub);
    }
    node.items[subKey].push({
      item: r.item, chemCode: r.chemCode, appCost: r.appCost,
      lineCost: r.lineCost, totalCost: r.totalCost
    });
  });
  return sanitizeForClient_({ groups: groups, tree: tree, addonGroup: ADDON_SOURCE_GROUP, addons: getAddonItems_() });
}

function getGroups() {
  var rt = getRateTable_();
  var seen = {};
  var out = [];
  rt.forEach(function (r) { if (!seen[r.group]) { seen[r.group] = true; out.push(r.group); } });
  return out;
}

function getSubVariants(group) {
  var rt = getRateTable_().filter(function (r) { return r.group === group; });
  var seen = {};
  var out = [];
  rt.forEach(function (r) {
    var key = r.sub || '(single)';
    if (!seen[key]) { seen[key] = true; out.push(r.sub); }
  });
  return out;
}

function getItems(group, sub) {
  var rt = getRateTable_().filter(function (r) {
    return r.group === group && (r.sub || '') === (sub || '');
  });
  return rt.map(function (r) {
    return { item: r.item, chemCode: r.chemCode, appCost: r.appCost, lineCost: r.lineCost, totalCost: r.totalCost };
  });
}

// Coatings/prints that can be applied to ANY size (not tied to a can group). They already
// live in the rate table under the group below; these are surfaced as universal add-ons on
// every ticket. Setup / small-quantity charges from that group are intentionally excluded.
var ADDON_SOURCE_GROUP = 'Specialty / Low Volume / Setup';
var ADDON_ITEM_NAMES = ['SIZE', 'ENAMEL ONE SIDE', 'WHITE BASE COAT',
  'VARNISH WET-STANDARD', 'VARNISH WET-PEBBLE', 'VARNISH DRY-STANDARD', 'VARNISH DRY-PEBBLE',
  'WAX ONLY',
  'LITHO PRINT SINGLE COLOR - ONE', 'LITHO PRINT SINGLE COLOR - TWO', 'LITHO PRINT SINGLE COLOR - THREE',
  'LITHO PRINT SINGLE COLOR - FOUR', 'LITHO PRINT SINGLE COLOR - FIVE', 'LITHO PRINT SINGLE COLOR - SIX',
  'LITHO PRINT TWO COLOR - ONE', 'LITHO PRINT TWO COLOR - TWO', 'LITHO PRINT TWO COLOR - THREE',
  'LITHO PRINT TWO COLOR - FOUR', 'LITHO PRINT TWO COLOR - FIVE', 'LITHO PRINT TWO COLOR - SIX'];

/** The universal add-on items, read live from the rate table (so price edits still apply). */
function getAddonItems_() {
  var names = {};
  ADDON_ITEM_NAMES.forEach(function (n) { names[n] = true; });
  return getItems(ADDON_SOURCE_GROUP, '').filter(function (it) { return names[it.item]; });
}

/** Finds an item's rate within its group, falling back to the universal add-ons so an add-on
 *  coating can be logged against a ticket of any size/group. */
function findRate_(group, sub, itemName) {
  var m = getItems(group, sub).filter(function (i) { return i.item === itemName; })[0];
  if (m) return m;
  return getAddonItems_().filter(function (i) { return i.item === itemName; })[0];
}

/** Best-effort guess at which rate-table Group a ticket's "End Use" text belongs to. Operator can override. */
function guessGroupForEndUse_(endUse) {
  if (!endUse) return null;
  var groups = getGroups();
  var normalized = String(endUse).toUpperCase().replace(/\s+/g, '');
  var best = null;
  groups.forEach(function (g) {
    var tokens = g.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
    for (var i = 0; i < tokens.length; i++) {
      if (tokens[i].length >= 3 && normalized.indexOf(tokens[i]) !== -1) { best = g; break; }
    }
  });
  return best;
}

// ---------------- queue / ticket ops ----------------

// Current Steel = raw steel with no litho applied yet. Once the first coating is logged the
// ticket moves straight to WIP (there is no separate "In Progress" stage anymore).
function getQueue() {
  var out = [];
  var cs = getSheet_(SHEETS.CURRENT_STEEL);
  var csHeaders = getHeaders_(cs);
  var csLast = cs.getLastRow();
  if (csLast > 1) {
    var csValues = cs.getRange(2, 1, csLast - 1, csHeaders.length).getValues();
    csValues.forEach(function (row) {
      if (!row[0]) return;
      var obj = rowToObject_(csHeaders, row);
      out.push({
        ticket: obj['Ticket'], supplier: obj['Supplier'], endUse: obj['End Use'],
        width: obj['Width'], length: obj['Length'], weight: obj['Weight'], qty: obj['QTY/LOAD'],
        bw: obj['BW'], type: obj['TC'], temper: obj['TM'],
        location: 'queue', status: 'Not Started', passCount: 0, runningTotal: 0
      });
    });
  }
  return sanitizeForClient_(out);
}

/** Detail for a Current Steel ticket (no litho applied yet). Once a coating is logged the
 *  ticket lives in WIP — use getWipDetail for those. */
function getTicketDetail(ticket) {
  var cs = getSheet_(SHEETS.CURRENT_STEEL);
  var csRow = findRowByTicket_(cs, ticket);
  if (csRow === -1) throw new Error('Ticket not found in Current Steel: ' + ticket);
  var csHeaders = getHeaders_(cs);
  var steel = rowToObject_(csHeaders, cs.getRange(csRow, 1, 1, csHeaders.length).getValues()[0]);

  return sanitizeForClient_({
    steel: steel,
    status: 'Not Started',
    passCount: 0,
    runningTotal: 0,
    suggestedGroup: guessGroupForEndUse_(steel['End Use']),
    transactions: getTransactionHistory(ticket)
  });
}
/** Creates a Current Steel row for a ticket that isn't in any sheet — the recovery path when
 *  a Current Steel row was accidentally deleted (or never entered) but the skid is on the
 *  floor. Only the ticket number is required; steel fields stay blank. The operator then logs
 *  a coating like any other ticket, which moves it to WIP. */
function createManualTicket(ticket, operatorName) {
  return withScriptLock_(function () { return createManualTicket_(ticket, operatorName); });
}

function createManualTicket_(ticket, operatorName) {
  ticket = String(ticket || '').trim();
  if (!ticket) throw new Error('Enter a ticket number.');

  var cs = getSheet_(SHEETS.CURRENT_STEEL);
  if (findRowByTicket_(cs, ticket) > -1) return getTicketDetail(ticket); // already in the queue

  var wip = getSheet_(SHEETS.WIP);
  if (findRowByTicket_(wip, ticket) > -1) {
    throw new Error('Ticket ' + ticket + ' is already in WIP. Open it there to add another coating.');
  }

  var csMap = headerMap_(cs);
  var lastCol = Math.max(cs.getLastColumn(), Object.keys(csMap).length, 1);
  var rowArr = new Array(lastCol).fill('');
  if (csMap['Ticket']) rowArr[csMap['Ticket'] - 1] = ticket;
  else rowArr[0] = ticket;
  var destRow = cs.getLastRow() + 1;
  cs.getRange(destRow, 1, 1, rowArr.length).setValues([rowArr]);

  var tx = getTransactionsSheet_();
  var txRow = tx.getLastRow() + 1;
  tx.getRange(txRow, 1, 1, TRANSACTION_COLS.length).setValues([[
    new Date(), ticket, 0, operatorName || '', '', '', 'MANUAL TICKET CREATED', '',
    0, 0, 0, 0, 'Ticket manually created in app (not found in Current Steel)', ''
  ]]);

  return getTicketDetail(ticket);
}

/** Writes one coating pass to the Litho Transactions log. */
function logCoatingTx_(ticket, passNumber, operatorName, group, sub, itemName, match, runningTotal, notes, jobName) {
  var tx = getTransactionsSheet_();
  var txRow = tx.getLastRow() + 1;
  tx.getRange(txRow, 1, 1, TRANSACTION_COLS.length).setValues([[
    new Date(), ticket, passNumber, operatorName || '', group || '', sub || '', itemName,
    match.chemCode || '', match.appCost, match.lineCost, match.totalCost, runningTotal, notes || '', jobName || ''
  ]]);
}

/**
 * Applies one coating pass to a ticket. This is the single mutation for the new lifecycle:
 *  - Ticket in Current Steel (first coating): it moves to WIP with Litho = this pass's cost.
 *    On a partial run, sheetsRun sets what actually ran; leftovers return to Current Steel
 *    only if isPartialSkid is true, otherwise they're scrapped (and recorded).
 *  - Ticket already in WIP (another coat): its Litho cost is increased by this pass's cost.
 * Every pass is recorded in Litho Transactions, so the full history is always tracked; the
 * only live number kept on the WIP row is the running Litho cost.
 */
function applyCoating(ticket, group, sub, itemName, operatorName, notes, sheetsRun, isPartialSkid, lithoNote, jobName) {
  return withScriptLock_(function () {
    return applyCoating_(ticket, group, sub, itemName, operatorName, notes, sheetsRun, isPartialSkid, lithoNote, jobName);
  });
}

function applyCoating_(ticket, group, sub, itemName, operatorName, notes, sheetsRun, isPartialSkid, lithoNote, jobName) {
  ticket = String(ticket || '').trim();
  if (!ticket) throw new Error('Enter a ticket number.');
  if (!group || !itemName) throw new Error('Pick a size/group and coating item.');
  var match = findRate_(group, sub, itemName);
  if (!match) throw new Error('Could not find rate for item: ' + itemName);

  var wip = getSheet_(SHEETS.WIP);
  var cs = getSheet_(SHEETS.CURRENT_STEEL);
  var lithoNoteClean = String(lithoNote || '').trim();

  var history = getTransactionHistory(ticket);
  var nextPass = history.length
    ? Math.max.apply(null, history.map(function (h) { return Number(h.passNumber) || 0; })) + 1 : 1;

  var result = { ticket: ticket, sheetsRun: null, estimatedWeightUsed: null, isPartial: false,
    remainderTicket: null, remainderSheets: 0, remainderWeight: 0, scrapSheets: 0, scrapWeight: 0 };

  // ----- Additional coating on a ticket already in WIP: just add cost -----
  var wipRow = findRowByTicket_(wip, ticket);
  if (wipRow > -1) {
    var wm = headerMap_(wip);
    if (!wm['Litho']) throw new Error('WIP sheet has no Litho column.');
    var currentLitho = Number(wip.getRange(wipRow, wm['Litho']).getValue()) || 0;
    var newTotal = Math.round((currentLitho + match.totalCost) * 100) / 100;
    wip.getRange(wipRow, wm['Litho']).setValue(newTotal);
    if (lithoNoteClean) {
      var nm = ensureColumns_(wip, ['Litho Notes']);
      var cell = wip.getRange(wipRow, nm['Litho Notes']); var ex = cell.getValue();
      cell.setValue((ex ? ex + ' | ' : '') + lithoNoteClean);
    }
    logCoatingTx_(ticket, nextPass, operatorName, group, sub, itemName, match, newTotal, notes, jobName);
    result.litho = newTotal;
    result.detail = getWipDetail(ticket);
    return sanitizeForClient_(result);
  }

  // ----- First coating: ticket must be in Current Steel; move it to WIP -----
  var csRow = findRowByTicket_(cs, ticket);
  if (csRow === -1) throw new Error('Ticket not found in Current Steel or WIP: ' + ticket);
  var csHeaders = getHeaders_(cs);
  var sourceObj = rowToObject_(csHeaders, cs.getRange(csRow, 1, 1, csHeaders.length).getValues()[0]);

  var originalQty = Number(sourceObj['QTY/LOAD']) || 0;
  var originalWeight = Number(sourceObj['Weight']) || 0;
  var weightPerSheet = originalQty > 0 ? (originalWeight / originalQty) : 0;
  var sheets = (sheetsRun === undefined || sheetsRun === null || sheetsRun === '') ? originalQty : Number(sheetsRun);
  if (originalQty > 0) {
    if (isNaN(sheets) || sheets <= 0) throw new Error('Enter a valid number of sheets run for ' + ticket + '.');
    if (sheets > originalQty) throw new Error('Sheets run (' + sheets + ') exceeds sheets available (' + originalQty + ') for ' + ticket + '.');
  } else {
    sheets = 0; // no sheet count on this ticket (e.g. manually created) — run it whole, no split/scrap math
  }
  var usedFewer = originalQty > 0 && sheets < originalQty;
  isPartialSkid = usedFewer && !!isPartialSkid;
  var estimatedWeightUsed = weightPerSheet > 0 ? Math.round(sheets * weightPerSheet * 100) / 100 : originalWeight;

  ensureColumns_(wip, ['Litho Notes']);
  var destRow = copyRowByHeaderName_(cs, csRow, wip);
  var wipMap = headerMap_(wip);
  if (wipMap['Litho']) wip.getRange(destRow, wipMap['Litho']).setValue(match.totalCost);
  if (usedFewer) {
    if (wipMap['QTY/LOAD']) wip.getRange(destRow, wipMap['QTY/LOAD']).setValue(sheets);
    if (wipMap['Weight']) wip.getRange(destRow, wipMap['Weight']).setValue(estimatedWeightUsed);
  }

  var scrapNote = '';
  if (usedFewer && isPartialSkid) {
    result.remainderTicket = generateRemainderTicketId_(ticket);
    result.remainderSheets = originalQty - sheets;
    result.remainderWeight = Math.round((originalWeight - estimatedWeightUsed) * 100) / 100;
    var csDestRow = copyRowByHeaderName_(cs, csRow, cs);
    var csMap = headerMap_(cs);
    if (csMap['Ticket']) cs.getRange(csDestRow, csMap['Ticket']).setValue(result.remainderTicket);
    if (csMap['QTY/LOAD']) cs.getRange(csDestRow, csMap['QTY/LOAD']).setValue(result.remainderSheets);
    if (csMap['Weight']) cs.getRange(csDestRow, csMap['Weight']).setValue(result.remainderWeight);
    if (csMap['Litho']) cs.getRange(csDestRow, csMap['Litho']).setValue('');
    if (csMap['Comments']) {
      var existingComment = sourceObj['Comments'] || '';
      cs.getRange(csDestRow, csMap['Comments']).setValue(
        (existingComment ? existingComment + ' | ' : '') + 'Split remainder from ' + ticket + ' (partial skid, ' +
        sheets + ' of ' + originalQty + ' sheets run) on ' +
        Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'America/Los_Angeles', 'yyyy-MM-dd'));
    }
  } else if (usedFewer) {
    result.scrapSheets = originalQty - sheets;
    result.scrapWeight = Math.round((originalWeight - estimatedWeightUsed) * 100) / 100;
    scrapNote = 'Scrapped ' + result.scrapSheets + ' sheets (~' + result.scrapWeight + ' lbs, estimated) of ' + originalQty + ' on hand';
  }

  var noteFull = [lithoNoteClean, scrapNote].filter(function (s) { return s; }).join(' | ');
  if (noteFull && wipMap['Litho Notes']) {
    var c2 = wip.getRange(destRow, wipMap['Litho Notes']); var e2 = c2.getValue();
    c2.setValue((e2 ? e2 + ' | ' : '') + noteFull);
  }

  cs.deleteRow(csRow);

  logCoatingTx_(ticket, nextPass, operatorName, group, sub, itemName, match, match.totalCost,
    [notes, scrapNote].filter(function (s) { return s; }).join(' | '), jobName);

  result.sheetsRun = sheets;
  result.estimatedWeightUsed = estimatedWeightUsed;
  result.isPartial = isPartialSkid;
  result.litho = match.totalCost;
  result.detail = getWipDetail(ticket);
  return sanitizeForClient_(result);
}

/** One-time migration: move any tickets still sitting in the old Litho In Progress sheet into
 *  WIP, carrying their running litho cost. Safe to run repeatedly / when empty. */
function migrateInProgressToWip() {
  return withScriptLock_(migrateInProgressToWip_);
}

function migrateInProgressToWip_() {
  var ip = getInProgressSheet_();
  var last = ip.getLastRow();
  if (last < 2) return { moved: 0 };
  var wip = getSheet_(SHEETS.WIP);
  ensureColumns_(wip, ['Litho Notes']);
  var moved = 0;
  // Walk bottom-up so row deletions don't shift the rows we haven't processed yet.
  for (var row = last; row >= 2; row--) {
    var ipHeaders = getHeaders_(ip);
    var obj = rowToObject_(ipHeaders, ip.getRange(row, 1, 1, ipHeaders.length).getValues()[0]);
    if (!obj['Ticket']) continue;
    var destRow = copyRowByHeaderName_(ip, row, wip);
    var wipMap = headerMap_(wip);
    if (wipMap['Litho']) wip.getRange(destRow, wipMap['Litho']).setValue(Number(obj['Running Litho Total']) || 0);
    ip.deleteRow(row);
    moved++;
  }
  return { moved: moved };
}

/**
 * Audits every WIP ticket's Litho cost against the Litho Transactions log. The log is the
 * source of truth: coating costs plus manual-adjustment deltas sum to the current cost, so
 * any drift (hand edits to the sheet, a half-failed run) shows up as a mismatch here.
 * Run from the Apps Script editor: auditWipLithoCosts() to report, auditWipLithoCosts(true)
 * to also write the recomputed value back where it differs.
 */
function auditWipLithoCosts(applyFixes) {
  return withScriptLock_(function () {
    var wip = getSheet_(SHEETS.WIP);
    var wipMap = headerMap_(wip);
    if (!wipMap['Ticket'] || !wipMap['Litho']) throw new Error('WIP sheet needs Ticket and Litho columns.');
    var last = wip.getLastRow();
    if (last < 2) return { checked: 0, mismatches: [] };

    // One read of the whole transaction log; sum Pass Total Cost per ticket.
    var tx = getTransactionsSheet_();
    var txLast = tx.getLastRow();
    var sums = {};
    if (txLast > 1) {
      tx.getRange(2, 1, txLast - 1, TRANSACTION_COLS.length).getValues().forEach(function (r) {
        var t = String(r[1]).trim();
        if (!t) return;
        sums[t] = Math.round(((sums[t] || 0) + (Number(r[10]) || 0)) * 100) / 100;
      });
    }

    var tickets = wip.getRange(2, wipMap['Ticket'], last - 1, 1).getValues();
    var costs = wip.getRange(2, wipMap['Litho'], last - 1, 1).getValues();
    var mismatches = [];
    for (var i = 0; i < tickets.length; i++) {
      var t = String(tickets[i][0]).trim();
      if (!t) continue;
      var sheetCost = Math.round((Number(costs[i][0]) || 0) * 100) / 100;
      var computed = sums[t] || 0;
      if (sheetCost !== computed) {
        if (applyFixes) wip.getRange(i + 2, wipMap['Litho']).setValue(computed);
        mismatches.push({ ticket: t, sheetCost: sheetCost, computedFromLog: computed, fixed: !!applyFixes });
      }
    }
    return { checked: tickets.length, mismatches: mismatches };
  });
}

function getTransactionHistory(ticket) {
  var tx = getTransactionsSheet_();
  var last = tx.getLastRow();
  if (last < 2) return [];
  var values = tx.getRange(2, 1, last - 1, TRANSACTION_COLS.length).getValues();
  return sanitizeForClient_(values
    .filter(function (r) { return String(r[1]).trim() === String(ticket).trim(); })
    .map(function (r) {
      return {
        timestamp: r[0], ticket: r[1], passNumber: r[2], operator: r[3], group: r[4], sub: r[5],
        item: r[6], chemCode: r[7], appCost: r[8], lineCost: r[9], passTotal: r[10],
        runningTotal: r[11], notes: r[12], jobName: r[13]
      };
    })
    .sort(function (a, b) { return a.passNumber - b.passNumber; }));
}

/**
 * Applies one coating pass to a batch of tickets under a shared job name/description.
 * For each ticket: starts the job if it's still sitting in Current Steel, then logs the
 * pass. Every ticket keeps its own full pass history — the Job Name just ties them
 * together so you can see everything that went through together in one run.
 */
/**
 * Adds ONE ticket to a job: applies the job's coating pass to the ticket, which moves it from
 * Current Steel straight to WIP (or adds another coat if it's already in WIP). Partial-skid /
 * scrap handling and per-ticket Litho Notes are all done by applyCoating.
 * Call this once per ticket as tickets are added to the job, one at a time.
 */
function addTicketToJob(jobName, group, sub, itemName, operatorName, notes, ticket, sheetsRun, lithoNote, isPartialSkid) {
  return applyCoating(ticket, group, sub, itemName, operatorName, notes, sheetsRun, isPartialSkid, lithoNote, jobName);
}

// ---------------- WIP browsing / manual cost edit / reopen ----------------

function getWipList() {
  var wip = getSheet_(SHEETS.WIP);
  var headers = getHeaders_(wip);
  var lastRow = wip.getLastRow();
  if (lastRow < 2) return [];
  var values = wip.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var out = values.filter(function (r) { return r[0]; }).map(function (r) {
    var obj = rowToObject_(headers, r);
    return {
      ticket: obj['Ticket'], supplier: obj['Supplier'], endUse: obj['End Use'],
      width: obj['Width'], length: obj['Length'], weight: obj['Weight'],
      qty: obj['QTY/LOAD'], litho: obj['Litho'] || 0,
      bw: obj['BW'], type: obj['TC'], temper: obj['TM'],
      location: 'wip', status: 'WIP'
    };
  });
  return sanitizeForClient_(out);
}

/** Current Steel + WIP merged into one list for the combined search view. Ticket data is read
 *  live (never cached) so every operator sees the same current floor. */
function getAllTickets() {
  return getQueue().concat(getWipList());
}

function getWipDetail(ticket) {
  var wip = getSheet_(SHEETS.WIP);
  var wipRow = findRowByTicket_(wip, ticket);
  if (wipRow === -1) throw new Error('Ticket not found in WIP: ' + ticket);
  var headers = getHeaders_(wip);
  var steel = rowToObject_(headers, wip.getRange(wipRow, 1, 1, headers.length).getValues()[0]);
  var history = getTransactionHistory(ticket);
  return sanitizeForClient_({
    steel: steel,
    litho: steel['Litho'] || 0,
    passCount: history.filter(function (h) {
      return Number(h.passTotal) > 0 && String(h.item).indexOf('MANUAL COST ADJUSTMENT') === -1;
    }).length,
    transactions: history
  });
}

/** Directly overrides the Litho cost on a WIP row (e.g. correcting a typo or manual adjustment)
 *  and logs the change to Litho Transactions so there's a record of who changed it and why. */
function updateWipLithoCost(ticket, newCost, operatorName, notes) {
  return withScriptLock_(function () { return updateWipLithoCost_(ticket, newCost, operatorName, notes); });
}

function updateWipLithoCost_(ticket, newCost, operatorName, notes) {
  var wip = getSheet_(SHEETS.WIP);
  var wipRow = findRowByTicket_(wip, ticket);
  if (wipRow === -1) throw new Error('Ticket not found in WIP: ' + ticket);
  var wipMap = headerMap_(wip);
  if (!wipMap['Litho']) throw new Error('WIP sheet has no Litho column.');

  var oldCost = wip.getRange(wipRow, wipMap['Litho']).getValue() || 0;
  var newCostNum = Number(newCost);
  if (isNaN(newCostNum) || newCostNum < 0) throw new Error('Enter a valid non-negative cost.');

  wip.getRange(wipRow, wipMap['Litho']).setValue(newCostNum);

  var history = getTransactionHistory(ticket);
  var nextPassNumber = history.length ? Math.max.apply(null, history.map(function (h) { return Number(h.passNumber) || 0; })) + 1 : 1;

  var tx = getTransactionsSheet_();
  var txRow = tx.getLastRow() + 1;
  tx.getRange(txRow, 1, 1, TRANSACTION_COLS.length).setValues([[
    new Date(), ticket, nextPassNumber, operatorName || '', '', '', 'MANUAL COST ADJUSTMENT (in WIP)', '',
    0, 0, (newCostNum - oldCost), newCostNum,
    'Litho cost changed from ' + oldCost.toFixed(2) + ' to ' + newCostNum.toFixed(2) + (notes ? ' — ' + notes : ''), ''
  ]]);

  return sanitizeForClient_(getWipDetail(ticket));
}