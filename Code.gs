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
  MASTER: 'Steel Tickets',
  CURRENT_STEEL: 'Current Steel',
  IN_PROGRESS: 'Litho In Progress',
  TRANSACTIONS: 'Litho Transactions',
  JOBS: 'Litho Jobs',
  WIP: 'WIP',
  RATE_TABLE: 'Litho Rate Table'
};

// Ticket lifecycle. A row is created once in Steel Tickets and never moves or gets deleted —
// only its Status (and the matching timestamp stamps) change. Coatings run during the day put a
// ticket in Pending; a supervisor reviews the day's jobs and approves, which flips them to WIP.
// Full history lives in Litho Transactions, which is what makes the trail SQF-auditable.
var STATUS = { CURRENT: 'Current', PENDING: 'Pending', WIP: 'WIP' };

// Lifecycle columns appended after the steel columns on the Steel Tickets master tab.
var MASTER_EXTRA_COLS = ['Skid ID', 'Status', 'Job ID', 'Split Of', 'First Coated At', 'First Coated By',
  'Approved At', 'Approved By', 'Last Updated At', 'Last Updated By'];

// Columns for the Litho Jobs tab (one row per job; Coatings JSON holds the reusable recipe).
var JOB_COLS = ['Job ID', 'Created At', 'Created By', 'Description', 'Coatings', 'Coatings JSON',
  'Ticket Count', 'Status', 'Approved At', 'Approved By', 'Notes'];

// Extra columns Litho In Progress has on top of the normal steel columns
var PROGRESS_EXTRA_COLS = ['Status', 'Started By', 'Started At', 'Pass Count', 'Running Litho Total'];

var TRANSACTION_COLS = ['Timestamp', 'Ticket', 'Pass Number', 'Operator', 'Group', 'Sub-Variant',
  'Item', 'Chem Code', 'Application Cost', 'Line Cost', 'Pass Total Cost', 'Running Total After Pass', 'Notes', 'Job Name', 'Skid ID'];

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

/** Finds an unused "<ticket>-R", "-R2", "-R3"... number across the whole master table,
 *  so repeated partial splits of the same ticket don't collide. */
function generateRemainderTicketId_(baseTicket) {
  var m = getMasterSheet_();
  for (var i = 1; i <= 20; i++) {
    var candidate = baseTicket + (i === 1 ? '-R' : '-R' + i);
    if (findRowByTicket_(m, candidate) === -1) return candidate;
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

/** Litho Transactions, headers auto-created if missing; older sheets gain the Skid ID column. */
function getTransactionsSheet_() {
  var sh = getSheet_(SHEETS.TRANSACTIONS);
  if (sh.getLastColumn() === 0) {
    sh.getRange(1, 1, 1, TRANSACTION_COLS.length).setValues([TRANSACTION_COLS]);
    sh.setFrozenRows(1);
  } else if (sh.getLastColumn() < TRANSACTION_COLS.length) {
    ensureColumns_(sh, TRANSACTION_COLS);
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

// ---------------- master table (Steel Tickets) ----------------

/** The Steel Tickets master tab: one row per skid, steel columns + lifecycle columns.
 *  Headers are auto-created on first touch (seeded from Current Steel's header row). */
function getMasterSheet_() {
  var sh = getSheet_(SHEETS.MASTER);
  if (sh.getLastColumn() === 0) {
    var cs = getSpreadsheet_().getSheetByName(SHEETS.CURRENT_STEEL);
    var steelHeaders = cs ? getHeaders_(cs) : [];
    if (!steelHeaders.length) {
      steelHeaders = ['Ticket', 'Row', 'Supplier', 'B/C', 'BW', 'TM', 'TC', 'C/S', 'Width',
        'Length', 'Weight', 'Cost', 'Litho', 'Mill', 'End Use', 'Comments', 'QTY/LOAD',
        'PO Number', 'Allocation'];
    }
    if (steelHeaders.indexOf('Litho Notes') === -1) steelHeaders = steelHeaders.concat(['Litho Notes']);
    var headers = steelHeaders.concat(MASTER_EXTRA_COLS);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
  } else {
    // Sheet already exists (possibly created in an earlier version): make sure every lifecycle
    // column is present. Without this, writes to a missing column (e.g. Job ID) are silently
    // dropped by stampRow_, so tickets never link to their job.
    ensureColumns_(sh, MASTER_EXTRA_COLS.concat(['Litho Notes', 'Litho']));
  }
  return sh;
}

/** Next internal skid id (SKD-000001, ...). Counter lives in script properties; only call
 *  under withScriptLock_ so ids are never handed out twice. */
function nextSkidId_() {
  var props = PropertiesService.getScriptProperties();
  var n = Number(props.getProperty('skidCounter') || 0) + 1;
  props.setProperty('skidCounter', String(n));
  return 'SKD-' + ('000000' + n).slice(-6);
}

function findRowBySkidId_(sheet, skidId) {
  var map = headerMap_(sheet);
  var col = map['Skid ID'];
  if (!col) return -1;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  var values = sheet.getRange(2, col, lastRow - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() === String(skidId).trim()) return i + 2;
  }
  return -1;
}

/** Writes a set of named cells on one row (used for Status + timestamp stamps). */
function stampRow_(sheet, row, map, fields) {
  Object.keys(fields).forEach(function (name) {
    if (map[name]) sheet.getRange(row, map[name]).setValue(fields[name]);
  });
}

/** Appends a master row built from an existing row-object plus overrides; returns the row. */
function appendMasterRow_(m, mMap, obj, overrides) {
  var lastCol = m.getLastColumn();
  var rowArr = new Array(lastCol).fill('');
  Object.keys(mMap).forEach(function (col) {
    if (obj && obj.hasOwnProperty(col)) rowArr[mMap[col] - 1] = obj[col];
  });
  Object.keys(overrides || {}).forEach(function (col) {
    if (mMap[col]) rowArr[mMap[col] - 1] = overrides[col];
  });
  var destRow = m.getLastRow() + 1;
  m.getRange(destRow, 1, 1, lastCol).setValues([rowArr]);
  return destRow;
}

/** Adopts rows pasted straight into Steel Tickets (intake): any row with a Ticket but no
 *  Skid ID gets one, and a blank Status becomes Current. Called at the top of every
 *  mutating endpoint (under lock), so paste-intake needs no special process. */
function normalizeMasterRows_() {
  var m = getMasterSheet_();
  var map = headerMap_(m);
  var last = m.getLastRow();
  if (last < 2 || !map['Ticket'] || !map['Skid ID'] || !map['Status']) return;
  var tickets = m.getRange(2, map['Ticket'], last - 1, 1).getValues();
  var skids = m.getRange(2, map['Skid ID'], last - 1, 1).getValues();
  var statuses = m.getRange(2, map['Status'], last - 1, 1).getValues();
  for (var i = 0; i < tickets.length; i++) {
    if (!String(tickets[i][0]).trim()) continue;
    var row = i + 2;
    if (!String(skids[i][0]).trim()) m.getRange(row, map['Skid ID']).setValue(nextSkidId_());
    if (!String(statuses[i][0]).trim()) {
      stampRow_(m, row, map, { 'Status': STATUS.CURRENT, 'Last Updated At': new Date(), 'Last Updated By': 'intake' });
    }
  }
}

/** Cheap check-then-fix used by reads: if any master row has a Ticket but no Skid ID or no
 *  Status (a row just pasted in as intake), assign them now under the lock so the row is
 *  openable immediately. No-op (three column reads, no writes) when everything's already
 *  normalized, so it's safe to call from a frequently-hit read like getAllTickets. */
function normalizeMasterIfNeeded_() {
  var m = getMasterSheet_();
  var map = headerMap_(m);
  var last = m.getLastRow();
  if (last < 2 || !map['Ticket'] || !map['Skid ID'] || !map['Status']) return false;
  var tickets = m.getRange(2, map['Ticket'], last - 1, 1).getValues();
  var skids = m.getRange(2, map['Skid ID'], last - 1, 1).getValues();
  var statuses = m.getRange(2, map['Status'], last - 1, 1).getValues();
  var needs = false;
  for (var i = 0; i < tickets.length; i++) {
    if (!String(tickets[i][0]).trim()) continue;
    if (!String(skids[i][0]).trim() || !String(statuses[i][0]).trim()) { needs = true; break; }
  }
  if (!needs) return false;
  withScriptLock_(function () { normalizeMasterRows_(); });
  return true;
}

/** Retry-safe writes: every mutating call carries a client-generated opId. If we've seen it
 *  (within the cache window), the first call already did the work — report a duplicate so
 *  the client can treat the retry as success. Check/set only under withScriptLock_. */
function guardOp_(opId) {
  if (!opId) return false;
  var cache = CacheService.getScriptCache();
  var key = 'op:' + opId;
  if (cache.get(key)) return true;
  cache.put(key, '1', 21600); // 6h — far beyond any retry window
  return false;
}

function columnLetter_(n) {
  var s = '';
  while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
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

// ---------------- ticket reads (all from the Steel Tickets master) ----------------

/** Every ticket, one master read. Ticket data is never cached — always live. */
function getAllTickets() {
  normalizeMasterIfNeeded_(); // assign Skid IDs to any freshly pasted intake rows before listing
  var m = getMasterSheet_();
  var headers = getHeaders_(m);
  var last = m.getLastRow();
  if (last < 2) return [];
  var values = m.getRange(2, 1, last - 1, headers.length).getValues();
  var out = [];
  values.forEach(function (row) {
    var obj = rowToObject_(headers, row);
    if (!obj['Ticket'] && !obj['Skid ID']) return;
    out.push({
      skidId: obj['Skid ID'] || '',
      ticket: obj['Ticket'], supplier: obj['Supplier'], endUse: obj['End Use'],
      width: obj['Width'], length: obj['Length'], weight: obj['Weight'], qty: obj['QTY/LOAD'],
      bw: obj['BW'], type: obj['TC'], temper: obj['TM'],
      litho: obj['Litho'] || 0,
      status: obj['Status'] || STATUS.CURRENT
    });
  });
  return sanitizeForClient_(out);
}

/** Unified detail for one skid, whatever its status: the row, its lifecycle stamps, and the
 *  full transaction history — the SQF one-screen trace for that skid. */
function getTicketCard(skidId) {
  var m = getMasterSheet_();
  var row = findRowBySkidId_(m, skidId);
  if (row === -1) throw new Error('Skid not found: ' + skidId);
  var headers = getHeaders_(m);
  var obj = rowToObject_(headers, m.getRange(row, 1, 1, headers.length).getValues()[0]);
  var history = getTransactionHistory(skidId, obj['Ticket']);
  var active = activeCoatings_(history);
  return sanitizeForClient_({
    skidId: skidId,
    ticket: obj['Ticket'],
    status: obj['Status'] || STATUS.CURRENT,
    steel: obj,
    litho: obj['Litho'] || 0,
    passCount: active.length,
    suggestedGroup: guessGroupForEndUse_(obj['End Use']),
    coatings: active,
    transactions: history
  });
}

/** The coatings currently in effect on a skid, derived from the log. A real coating pass has
 *  a non-empty Group and a positive Pass Total (events, cost adjustments and voids write an
 *  empty Group). A void row's Notes begin with "VOID#<passNumber>:" and cancel that pass, so
 *  a corrected/removed coating drops out of this list while staying in the audit trail. */
function activeCoatings_(history) {
  var voided = {};
  (history || []).forEach(function (h) {
    var m = /^VOID#(\d+):/.exec(String(h.notes || ''));
    if (m) voided[m[1]] = true;
  });
  return (history || []).filter(function (h) {
    return String(h.group || '').trim() !== '' && Number(h.passTotal) > 0 && !voided[String(h.passNumber)];
  }).map(function (h) {
    return { passNumber: h.passNumber, group: h.group, sub: h.sub, item: h.item,
      chemCode: h.chemCode, cost: Number(h.passTotal) || 0 };
  });
}

/** History for one skid. New rows are matched by Skid ID; rows written before the master-
 *  table migration (no Skid ID) fall back to matching by ticket number. */
function getTransactionHistory(skidId, ticket) {
  var tx = getTransactionsSheet_();
  var last = tx.getLastRow();
  if (last < 2) return [];
  var values = tx.getRange(2, 1, last - 1, TRANSACTION_COLS.length).getValues();
  return sanitizeForClient_(values
    .filter(function (r) {
      var sid = String(r[14] || '').trim();
      if (sid) return skidId && sid === String(skidId).trim();
      return ticket && String(r[1]).trim() === String(ticket).trim();
    })
    .map(function (r) {
      return {
        timestamp: r[0], ticket: r[1], passNumber: r[2], operator: r[3], group: r[4], sub: r[5],
        item: r[6], chemCode: r[7], appCost: r[8], lineCost: r[9], passTotal: r[10],
        runningTotal: r[11], notes: r[12], jobName: r[13], skidId: r[14]
      };
    })
    .sort(function (a, b) { return a.passNumber - b.passNumber; }));
}

// ---------------- event log writers ----------------

/** Writes one coating pass to the Litho Transactions log. */
function logCoatingTx_(skidId, ticket, passNumber, operatorName, group, sub, itemName, match, runningTotal, notes, jobName) {
  var tx = getTransactionsSheet_();
  tx.getRange(tx.getLastRow() + 1, 1, 1, TRANSACTION_COLS.length).setValues([[
    new Date(), ticket, passNumber, operatorName || '', group || '', sub || '', itemName,
    match.chemCode || '', match.appCost, match.lineCost, match.totalCost, runningTotal,
    notes || '', jobName || '', skidId || ''
  ]]);
}

/** Writes a zero-cost lifecycle event (manual creation, moved to production, used, ...). */
function eventTx_(skidId, ticket, itemText, operatorName, note, runningTotal) {
  var tx = getTransactionsSheet_();
  tx.getRange(tx.getLastRow() + 1, 1, 1, TRANSACTION_COLS.length).setValues([[
    new Date(), ticket, 0, operatorName || '', '', '', itemText, '',
    0, 0, 0, runningTotal || 0, note || '', '', skidId || ''
  ]]);
}

// ---------------- ticket mutations (all locked + idempotent) ----------------

/** Creates a Current row for a ticket that isn't in the master — the recovery path when a
 *  skid is on the floor but was never entered (or its row was deleted). Ticket numbers may
 *  legitimately repeat over time; a new row is only refused while another row with the same
 *  number is still active (not Used). */
function createManualTicket(ticket, operatorName, opId) {
  return withScriptLock_(function () { return createManualTicket_(ticket, operatorName, opId); });
}

function createManualTicket_(ticket, operatorName, opId) {
  if (guardOp_(opId)) return sanitizeForClient_({ duplicate: true, ticket: ticket });
  ticket = String(ticket || '').trim();
  if (!ticket) throw new Error('Enter a ticket number.');
  normalizeMasterRows_();

  var m = getMasterSheet_();
  var headers = getHeaders_(m);
  var mMap = headerMap_(m);
  var last = m.getLastRow();
  if (last > 1) {
    var values = m.getRange(2, 1, last - 1, headers.length).getValues();
    for (var i = 0; i < values.length; i++) {
      var obj = rowToObject_(headers, values[i]);
      if (String(obj['Ticket']).trim() !== ticket) continue;
      var st = obj['Status'] || STATUS.CURRENT;
      if (st === STATUS.CURRENT) return getTicketCard(obj['Skid ID']); // already in the queue — open it
      if (st === STATUS.PENDING) {
        throw new Error('Ticket ' + ticket + ' is already active (Pending in a job, skid ' + obj['Skid ID'] + '). Open it from the list.');
      }
      // WIP rows are finished litho — a ticket number may legitimately come around again, so
      // don't block; fall through and create a fresh Current row with its own Skid ID.
    }
  }

  var skidId = nextSkidId_();
  appendMasterRow_(m, mMap, null, {
    'Ticket': ticket, 'Skid ID': skidId, 'Status': STATUS.CURRENT,
    'Last Updated At': new Date(), 'Last Updated By': operatorName || ''
  });
  eventTx_(skidId, ticket, 'MANUAL TICKET CREATED', operatorName,
    'Ticket manually created in app (not found in Steel Tickets)', 0);
  return getTicketCard(skidId);
}

/**
 * Applies one coating pass to a skid — the core mutation:
 *  - Status Current (first coating): Status -> WIP, First Coated stamps, Litho = pass cost.
 *    Partial runs: sheetsRun sets what ran; leftovers return to Current as a NEW row (new
 *    Skid ID, "-R" ticket suffix) only when isPartialSkid, otherwise recorded as scrap.
 *  - Status WIP (another coat): Litho += pass cost.
 * The row itself never moves; every pass lands in Litho Transactions keyed by Skid ID.
 */
function applyCoating(skidId, group, sub, itemName, operatorName, notes, sheetsRun, isPartialSkid, lithoNote, jobName, opId) {
  return withScriptLock_(function () {
    return applyCoating_(skidId, group, sub, itemName, operatorName, notes, sheetsRun, isPartialSkid, lithoNote, jobName, opId);
  });
}

function applyCoating_(skidId, group, sub, itemName, operatorName, notes, sheetsRun, isPartialSkid, lithoNote, jobName, opId, firstStatus, jobId) {
  if (guardOp_(opId)) return sanitizeForClient_({ duplicate: true, skidId: skidId });
  if (!group || !itemName) throw new Error('Pick a size/group and coating item.');
  var match = findRate_(group, sub, itemName);
  if (!match) throw new Error('Could not find rate for item: ' + itemName);
  normalizeMasterRows_();

  var m = getMasterSheet_();
  var mMap = headerMap_(m);
  if (!mMap['Litho']) throw new Error('Steel Tickets sheet has no Litho column.');
  var row = findRowBySkidId_(m, skidId);
  if (row === -1) throw new Error('Skid not found: ' + skidId);
  var headers = getHeaders_(m);
  var obj = rowToObject_(headers, m.getRange(row, 1, 1, headers.length).getValues()[0]);
  var ticket = obj['Ticket'];
  var status = obj['Status'] || STATUS.CURRENT;
  var lithoNoteClean = String(lithoNote || '').trim();

  var history = getTransactionHistory(skidId, ticket);
  var nextPass = history.length
    ? Math.max.apply(null, history.map(function (h) { return Number(h.passNumber) || 0; })) + 1 : 1;

  var result = { skidId: skidId, ticket: ticket, sheetsRun: null, estimatedWeightUsed: null,
    isPartial: false, remainderTicket: null, remainderSheets: 0, remainderWeight: 0,
    scrapSheets: 0, scrapWeight: 0 };

  function appendLithoNote(text) {
    if (!text || !mMap['Litho Notes']) return;
    var cell = m.getRange(row, mMap['Litho Notes']);
    var existing = cell.getValue();
    cell.setValue((existing ? existing + ' | ' : '') + text);
  }

  // ----- Another coat on a Pending or WIP skid: just add cost -----
  if (status === STATUS.WIP || status === STATUS.PENDING) {
    var currentLitho = Number(obj['Litho']) || 0;
    var newTotal = Math.round((currentLitho + match.totalCost) * 100) / 100;
    stampRow_(m, row, mMap, { 'Litho': newTotal, 'Last Updated At': new Date(), 'Last Updated By': operatorName || '' });
    appendLithoNote(lithoNoteClean);
    logCoatingTx_(skidId, ticket, nextPass, operatorName, group, sub, itemName, match, newTotal, notes, jobName);
    result.litho = newTotal;
    result.detail = getTicketCard(skidId);
    return sanitizeForClient_(result);
  }
  if (status !== STATUS.CURRENT) {
    throw new Error('Ticket ' + ticket + ' is "' + status + '" — coatings can only be logged while Current, Pending or WIP.');
  }

  // ----- First coating on a Current skid: flip to firstStatus (WIP for a single coat, or
  //       Pending when run as part of a job that still needs approval) -----
  var originalQty = Number(obj['QTY/LOAD']) || 0;
  var originalWeight = Number(obj['Weight']) || 0;
  var weightPerSheet = originalQty > 0 ? (originalWeight / originalQty) : 0;
  var sheets = (sheetsRun === undefined || sheetsRun === null || sheetsRun === '') ? originalQty : Number(sheetsRun);
  if (originalQty > 0) {
    if (isNaN(sheets) || sheets <= 0) throw new Error('Enter a valid number of sheets run for ' + ticket + '.');
    if (sheets > originalQty) throw new Error('Sheets run (' + sheets + ') exceeds sheets available (' + originalQty + ') for ' + ticket + '.');
  } else {
    sheets = 0; // no sheet count on this ticket — run it whole, no split/scrap math
  }
  var usedFewer = originalQty > 0 && sheets < originalQty;
  isPartialSkid = usedFewer && !!isPartialSkid;
  var estimatedWeightUsed = weightPerSheet > 0 ? Math.round(sheets * weightPerSheet * 100) / 100 : originalWeight;

  var now = new Date();
  stampRow_(m, row, mMap, {
    'Status': firstStatus || STATUS.WIP, 'Job ID': jobId || '', 'Litho': match.totalCost,
    'First Coated At': now, 'First Coated By': operatorName || '',
    'Last Updated At': now, 'Last Updated By': operatorName || ''
  });
  if (usedFewer) {
    stampRow_(m, row, mMap, { 'QTY/LOAD': sheets, 'Weight': estimatedWeightUsed });
  }

  var scrapNote = '';
  if (usedFewer && isPartialSkid) {
    result.remainderTicket = generateRemainderTicketId_(ticket);
    result.remainderSheets = originalQty - sheets;
    result.remainderWeight = Math.round((originalWeight - estimatedWeightUsed) * 100) / 100;
    var remainderSkid = nextSkidId_();
    appendMasterRow_(m, mMap, obj, {
      'Ticket': result.remainderTicket, 'Skid ID': remainderSkid, 'Status': STATUS.CURRENT,
      'Job ID': '', 'Split Of': skidId, // link back to the parent so a job-removal can reabsorb it
      'QTY/LOAD': result.remainderSheets, 'Weight': result.remainderWeight, 'Litho': '',
      'Comments': (obj['Comments'] ? obj['Comments'] + ' | ' : '') + 'Split remainder from ' + ticket +
        ' (partial skid, ' + sheets + ' of ' + originalQty + ' sheets run) on ' +
        Utilities.formatDate(now, Session.getScriptTimeZone() || 'America/Los_Angeles', 'yyyy-MM-dd'),
      'First Coated At': '', 'First Coated By': '', 'Litho Notes': '',
      'Last Updated At': now, 'Last Updated By': operatorName || ''
    });
    eventTx_(remainderSkid, result.remainderTicket, 'SPLIT REMAINDER CREATED', operatorName,
      result.remainderSheets + ' sheets (~' + result.remainderWeight + ' lbs, estimated) returned to Current from ' + ticket, 0);
  } else if (usedFewer) {
    result.scrapSheets = originalQty - sheets;
    result.scrapWeight = Math.round((originalWeight - estimatedWeightUsed) * 100) / 100;
    scrapNote = 'Scrapped ' + result.scrapSheets + ' sheets (~' + result.scrapWeight + ' lbs, estimated) of ' + originalQty + ' on hand';
  }

  appendLithoNote([lithoNoteClean, scrapNote].filter(function (s) { return s; }).join(' | '));

  logCoatingTx_(skidId, ticket, nextPass, operatorName, group, sub, itemName, match, match.totalCost,
    [notes, scrapNote].filter(function (s) { return s; }).join(' | '), jobName);

  result.sheetsRun = sheets;
  result.estimatedWeightUsed = estimatedWeightUsed;
  result.isPartial = isPartialSkid;
  result.litho = match.totalCost;
  result.detail = getTicketCard(skidId);
  return sanitizeForClient_(result);
}

// ---------------- jobs (a day's coating runs, reviewed then approved) ----------------

/** Litho Jobs tab: one row per job, holding the reusable coating recipe (Coatings JSON). */
function getJobsSheet_() {
  var sh = getSheet_(SHEETS.JOBS);
  if (sh.getLastColumn() === 0) {
    sh.getRange(1, 1, 1, JOB_COLS.length).setValues([JOB_COLS]);
    sh.setFrozenRows(1);
  } else if (sh.getLastColumn() < JOB_COLS.length) {
    ensureColumns_(sh, JOB_COLS);
  }
  return sh;
}

function nextJobId_() {
  var props = PropertiesService.getScriptProperties();
  var n = Number(props.getProperty('jobCounter') || 0) + 1;
  props.setProperty('jobCounter', String(n));
  return 'JOB-' + ('000000' + n).slice(-6);
}

function findRowByJobId_(sheet, jobId) {
  var map = headerMap_(sheet);
  var col = map['Job ID'];
  if (!col) return -1;
  var last = sheet.getLastRow();
  if (last < 2) return -1;
  var vals = sheet.getRange(2, col, last - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]).trim() === String(jobId).trim()) return i + 2;
  }
  return -1;
}

function coatingSummary_(coatings) {
  return (coatings || []).map(function (c) {
    return c.item + (c.sub ? ' (' + c.sub + ')' : '');
  }).join(' | ');
}

function getJobRecipe_(jobs, jobRow, jMap) {
  var json = jobs.getRange(jobRow, jMap['Coatings JSON']).getValue();
  try { return JSON.parse(json) || []; } catch (e) { return []; }
}

/** All master rows tagged with this Job ID. */
function jobTickets_(jobId) {
  var m = getMasterSheet_();
  var headers = getHeaders_(m);
  var mMap = headerMap_(m);
  var out = [];
  var last = m.getLastRow();
  if (last < 2 || !mMap['Job ID']) return out;
  m.getRange(2, 1, last - 1, headers.length).getValues().forEach(function (r) {
    var o = rowToObject_(headers, r);
    if (String(o['Job ID']).trim() === String(jobId).trim()) out.push(o);
  });
  return out;
}

/** Validates a coatings recipe (array of {group, sub, item}) against the rate table. */
function validateCoatings_(coatings) {
  if (!coatings || !coatings.length) throw new Error('Add at least one coating to the job.');
  coatings.forEach(function (c) {
    if (!c || !c.group || !c.item) throw new Error('Each coating needs a size/group and a coating item.');
    if (!findRate_(c.group, c.sub, c.item)) throw new Error('No rate found for coating: ' + c.item);
  });
}

/** Creates a Pending job with a coating recipe (one or more coatings). Tickets are added to
 *  it afterward; the whole job is reviewed and approved later, which flips its tickets to WIP. */
function createJob(description, operatorName, coatings, notes, opId) {
  return withScriptLock_(function () {
    if (guardOp_(opId)) return sanitizeForClient_({ duplicate: true });
    validateCoatings_(coatings);
    var jobs = getJobsSheet_();
    var jMap = headerMap_(jobs);
    var jobId = nextJobId_();
    var now = new Date();
    var rowArr = new Array(jobs.getLastColumn()).fill('');
    function put(col, val) { if (jMap[col]) rowArr[jMap[col] - 1] = val; }
    put('Job ID', jobId); put('Created At', now); put('Created By', operatorName || '');
    put('Description', description || ''); put('Coatings', coatingSummary_(coatings));
    put('Coatings JSON', JSON.stringify(coatings)); put('Ticket Count', 0); put('Status', 'Pending');
    put('Notes', notes || '');
    jobs.getRange(jobs.getLastRow() + 1, 1, 1, rowArr.length).setValues([rowArr]);
    return sanitizeForClient_({ jobId: jobId, description: description || '', coatings: coatings, status: 'Pending' });
  });
}

/** Adds one skid to a Pending job: applies every coating in the recipe (first coating flips
 *  Current -> Pending with partial/scrap handling; the rest just add cost). */
function jobAddTicket(jobId, skidId, sheetsRun, isPartialSkid, lithoNote, operatorName, opId) {
  return withScriptLock_(function () {
    if (guardOp_(opId)) return sanitizeForClient_({ duplicate: true, skidId: skidId });
    normalizeMasterRows_();
    var jobs = getJobsSheet_();
    var jMap = headerMap_(jobs);
    var jobRow = findRowByJobId_(jobs, jobId);
    if (jobRow === -1) throw new Error('Job not found: ' + jobId);
    if (String(jobs.getRange(jobRow, jMap['Status']).getValue()) === 'Approved') throw new Error('Job ' + jobId + ' is approved and locked.');
    var recipe = getJobRecipe_(jobs, jobRow, jMap);
    if (!recipe.length) throw new Error('Job ' + jobId + ' has no coatings.');
    var desc = jobs.getRange(jobRow, jMap['Description']).getValue();

    // Don't add the same skid to the same job twice — the recipe would be applied again and
    // double the coating cost. (A retried call is already caught above by guardOp_; this
    // guards a genuinely new double-add from a stale screen.)
    var mCheck = getMasterSheet_();
    var rCheck = findRowBySkidId_(mCheck, skidId);
    if (rCheck !== -1) {
      var oCheck = rowToObject_(getHeaders_(mCheck), mCheck.getRange(rCheck, 1, 1, mCheck.getLastColumn()).getValues()[0]);
      if (String(oCheck['Job ID']).trim() === String(jobId).trim() && (oCheck['Status'] || STATUS.CURRENT) !== STATUS.CURRENT) {
        throw new Error('Ticket ' + (oCheck['Ticket'] || skidId) + ' is already on job ' + jobId + '.');
      }
    }

    var result = null;
    recipe.forEach(function (c, i) {
      var r = applyCoating_(skidId, c.group, c.sub, c.item, operatorName, '',
        i === 0 ? sheetsRun : '', i === 0 ? isPartialSkid : false, i === 0 ? lithoNote : '',
        desc, null, STATUS.PENDING, jobId);
      if (i === 0) result = r; else if (r && r.litho !== undefined) result.litho = r.litho;
    });
    jobs.getRange(jobRow, jMap['Ticket Count']).setValue(jobTickets_(jobId).length);
    result = result || { skidId: skidId };
    result.jobId = jobId;
    return sanitizeForClient_(result);
  });
}

/** Appends a coating to a Pending job's recipe and applies it to every ticket already on it. */
function addCoatingToJob(jobId, coating, operatorName, opId) {
  return withScriptLock_(function () {
    if (guardOp_(opId)) return sanitizeForClient_({ duplicate: true });
    validateCoatings_([coating]);
    var jobs = getJobsSheet_();
    var jMap = headerMap_(jobs);
    var jobRow = findRowByJobId_(jobs, jobId);
    if (jobRow === -1) throw new Error('Job not found: ' + jobId);
    if (String(jobs.getRange(jobRow, jMap['Status']).getValue()) === 'Approved') throw new Error('Job is approved and locked.');
    var recipe = getJobRecipe_(jobs, jobRow, jMap);
    recipe.push({ group: coating.group, sub: coating.sub || '', item: coating.item });
    jobs.getRange(jobRow, jMap['Coatings JSON']).setValue(JSON.stringify(recipe));
    jobs.getRange(jobRow, jMap['Coatings']).setValue(coatingSummary_(recipe));
    var desc = jobs.getRange(jobRow, jMap['Description']).getValue();
    jobTickets_(jobId).forEach(function (o) {
      if ((o['Status'] || '') !== STATUS.PENDING) return;
      applyCoating_(o['Skid ID'], coating.group, coating.sub, coating.item, operatorName, '',
        '', false, '', desc, null, STATUS.PENDING, jobId);
    });
    return getJobDetail(jobId);
  });
}

/** Folds any pristine split-remainder rows (Split Of == parentSkid, still Current with no
 *  litho of their own) back into the parent skid and removes them. Used when a partial-skid
 *  ticket is taken off a job, so the skid isn't left permanently split. Returns sheets folded
 *  back. A remainder that's already been used (not Current, or has litho) is left alone. */
function reabsorbSplitRemainders_(m, mMap, parentRow, parentSkid, operatorName) {
  if (!mMap['Split Of']) return 0;
  var headers = getHeaders_(m);
  var last = m.getLastRow();
  if (last < 2) return 0;
  var vals = m.getRange(2, 1, last - 1, headers.length).getValues();
  var toDelete = [], addQty = 0, addWeight = 0;
  for (var i = 0; i < vals.length; i++) {
    var o = rowToObject_(headers, vals[i]);
    if (String(o['Split Of']).trim() !== String(parentSkid).trim()) continue;
    if ((o['Status'] || STATUS.CURRENT) !== STATUS.CURRENT) continue; // remainder in use — leave it
    if (Number(o['Litho']) > 0) continue;
    addQty += Number(o['QTY/LOAD']) || 0;
    addWeight += Number(o['Weight']) || 0;
    toDelete.push(i + 2);
    eventTx_(o['Skid ID'], o['Ticket'], 'SPLIT REABSORBED', operatorName,
      'Remainder folded back into ' + parentSkid + ' when its ticket left the job', 0);
  }
  if (!toDelete.length) return 0;
  var pObj = rowToObject_(headers, m.getRange(parentRow, 1, 1, headers.length).getValues()[0]);
  stampRow_(m, parentRow, mMap, {
    'QTY/LOAD': (Number(pObj['QTY/LOAD']) || 0) + addQty,
    'Weight': Math.round(((Number(pObj['Weight']) || 0) + addWeight) * 100) / 100
  });
  // Remainder rows are always appended below the parent, so deleting them bottom-up never
  // shifts the parent row we just stamped.
  toDelete.sort(function (a, b) { return b - a; }).forEach(function (r) { m.deleteRow(r); });
  return addQty;
}

/** Removes a still-Pending ticket from a job: reverts it to Current and voids its pending
 *  coatings with a negative delta row (so the log reconciles to zero), and folds any partial-
 *  skid remainder back into it so the skid isn't left split. */
function removeTicketFromJob(jobId, skidId, operatorName, opId) {
  return withScriptLock_(function () {
    if (guardOp_(opId)) return sanitizeForClient_({ duplicate: true });
    var jobs = getJobsSheet_();
    var jMap = headerMap_(jobs);
    var jobRow = findRowByJobId_(jobs, jobId);
    if (jobRow === -1) throw new Error('Job not found: ' + jobId);
    if (String(jobs.getRange(jobRow, jMap['Status']).getValue()) === 'Approved') throw new Error('Job is approved and locked.');
    var m = getMasterSheet_();
    var mMap = headerMap_(m);
    var headers = getHeaders_(m);
    var row = findRowBySkidId_(m, skidId);
    if (row === -1) throw new Error('Skid not found: ' + skidId);
    var obj = rowToObject_(headers, m.getRange(row, 1, 1, headers.length).getValues()[0]);
    if (String(obj['Job ID']).trim() !== String(jobId).trim()) throw new Error('Skid is not part of this job.');
    var litho = Number(obj['Litho']) || 0;
    stampRow_(m, row, mMap, {
      'Status': STATUS.CURRENT, 'Job ID': '', 'Litho': '',
      'First Coated At': '', 'First Coated By': '',
      'Last Updated At': new Date(), 'Last Updated By': operatorName || ''
    });
    var history = getTransactionHistory(skidId, obj['Ticket']);
    var nextPass = history.length ? Math.max.apply(null, history.map(function (h) { return Number(h.passNumber) || 0; })) + 1 : 1;
    var tx = getTransactionsSheet_();
    tx.getRange(tx.getLastRow() + 1, 1, 1, TRANSACTION_COLS.length).setValues([[
      new Date(), obj['Ticket'], nextPass, operatorName || '', '', '', 'REMOVED FROM JOB (VOID)', '',
      0, 0, -litho, 0, 'Removed from job ' + jobId + ' before approval; pending coatings voided', '', skidId
    ]]);
    // If this ticket had been split as a partial skid, fold the pristine remainder back in.
    reabsorbSplitRemainders_(m, mMap, row, skidId, operatorName);
    jobs.getRange(jobRow, jMap['Ticket Count']).setValue(jobTickets_(jobId).length);
    return getJobDetail(jobId);
  });
}

/** Approves a job: every Pending ticket on it flips to WIP (with an approval stamp), and the
 *  job itself is locked. This is the supervisor sign-off gate before steel counts as WIP. */
function approveJob(jobId, operatorName, opId) {
  return withScriptLock_(function () {
    // No guardOp_ here: approval is idempotent by design (already-WIP tickets are skipped,
    // and an already-Approved job returns early). That makes it safe to RESUME — if a first
    // attempt died partway (timeout / transient error) leaving some tickets flipped and some
    // not, the retry simply finishes the rest instead of being masked as a completed duplicate.
    var jobs = getJobsSheet_();
    var jMap = headerMap_(jobs);
    var jobRow = findRowByJobId_(jobs, jobId);
    if (jobRow === -1) throw new Error('Job not found: ' + jobId);
    if (String(jobs.getRange(jobRow, jMap['Status']).getValue()) === 'Approved') return getJobDetail(jobId);
    var m = getMasterSheet_();
    var headers = getHeaders_(m);
    var mMap = headerMap_(m);
    var last = m.getLastRow();
    var now = new Date();
    var flipped = 0;
    if (last > 1) {
      var vals = m.getRange(2, 1, last - 1, headers.length).getValues();
      for (var i = 0; i < vals.length; i++) {
        var obj = rowToObject_(headers, vals[i]);
        if (String(obj['Job ID']).trim() !== String(jobId).trim()) continue;
        if ((obj['Status'] || '') !== STATUS.PENDING) continue;
        stampRow_(m, i + 2, mMap, {
          'Status': STATUS.WIP, 'Approved At': now, 'Approved By': operatorName || '',
          'Last Updated At': now, 'Last Updated By': operatorName || ''
        });
        eventTx_(obj['Skid ID'], obj['Ticket'], 'JOB APPROVED', operatorName, 'Approved in job ' + jobId + ' — moved to WIP', Number(obj['Litho']) || 0);
        flipped++;
      }
    }
    stampRow_(jobs, jobRow, jMap, { 'Status': 'Approved', 'Approved At': now, 'Approved By': operatorName || '' });
    return getJobDetail(jobId);
  });
}

/** Jobs created on a given day (yyyy-MM-dd; blank = today), newest activity first. */
function getJobsForDate(dateStr) {
  var jobs = getJobsSheet_();
  var last = jobs.getLastRow();
  if (last < 2) return [];
  var tz = Session.getScriptTimeZone() || 'America/Los_Angeles';
  var target = dateStr || Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var headers = getHeaders_(jobs);
  var out = [];
  jobs.getRange(2, 1, last - 1, headers.length).getValues().forEach(function (r) {
    var o = rowToObject_(headers, r);
    if (!o['Job ID']) return;
    var created = o['Created At'];
    var d = (created instanceof Date) ? Utilities.formatDate(created, tz, 'yyyy-MM-dd') : String(created).slice(0, 10);
    if (d !== target) return;
    out.push({ jobId: o['Job ID'], createdBy: o['Created By'], createdAt: o['Created At'],
      description: o['Description'], coatings: o['Coatings'], ticketCount: o['Ticket Count'], status: o['Status'] });
  });
  return sanitizeForClient_(out);
}

/** One job plus its coating recipe and the tickets currently on it. */
function getJobDetail(jobId) {
  var jobs = getJobsSheet_();
  var jMap = headerMap_(jobs);
  var jobRow = findRowByJobId_(jobs, jobId);
  if (jobRow === -1) throw new Error('Job not found: ' + jobId);
  var headers = getHeaders_(jobs);
  var jobObj = rowToObject_(headers, jobs.getRange(jobRow, 1, 1, headers.length).getValues()[0]);
  var tickets = jobTickets_(jobId).map(function (o) {
    return { skidId: o['Skid ID'], ticket: o['Ticket'], status: o['Status'], litho: o['Litho'] || 0,
      bw: o['BW'], type: o['TC'], temper: o['TM'], endUse: o['End Use'] };
  });
  return sanitizeForClient_({
    jobId: jobObj['Job ID'], description: jobObj['Description'], createdBy: jobObj['Created By'],
    createdAt: jobObj['Created At'], status: jobObj['Status'], approvedAt: jobObj['Approved At'],
    approvedBy: jobObj['Approved By'], coatings: getJobRecipe_(jobs, jobRow, jMap),
    coatingsSummary: jobObj['Coatings'], notes: jobObj['Notes'], tickets: tickets
  });
}

/** Directly overrides a skid's Litho cost (typo fix / manual adjustment), logged with a
 *  delta row so the transaction log still sums to the cell. */
function updateWipLithoCost(skidId, newCost, operatorName, notes, opId) {
  return withScriptLock_(function () { return updateWipLithoCost_(skidId, newCost, operatorName, notes, opId); });
}

function updateWipLithoCost_(skidId, newCost, operatorName, notes, opId) {
  if (guardOp_(opId)) return sanitizeForClient_({ duplicate: true, skidId: skidId });
  normalizeMasterRows_();
  var m = getMasterSheet_();
  var mMap = headerMap_(m);
  if (!mMap['Litho']) throw new Error('Steel Tickets sheet has no Litho column.');
  var row = findRowBySkidId_(m, skidId);
  if (row === -1) throw new Error('Skid not found: ' + skidId);
  var headers = getHeaders_(m);
  var obj = rowToObject_(headers, m.getRange(row, 1, 1, headers.length).getValues()[0]);

  var oldCost = Number(obj['Litho']) || 0;
  var newCostNum = Number(newCost);
  if (isNaN(newCostNum) || newCostNum < 0) throw new Error('Enter a valid non-negative cost.');

  stampRow_(m, row, mMap, { 'Litho': newCostNum, 'Last Updated At': new Date(), 'Last Updated By': operatorName || '' });

  var history = getTransactionHistory(skidId, obj['Ticket']);
  var nextPassNumber = history.length ? Math.max.apply(null, history.map(function (h) { return Number(h.passNumber) || 0; })) + 1 : 1;
  var tx = getTransactionsSheet_();
  tx.getRange(tx.getLastRow() + 1, 1, 1, TRANSACTION_COLS.length).setValues([[
    new Date(), obj['Ticket'], nextPassNumber, operatorName || '', '', '', 'MANUAL COST ADJUSTMENT', '',
    0, 0, (newCostNum - oldCost), newCostNum,
    'Litho cost changed from ' + oldCost.toFixed(2) + ' to ' + newCostNum.toFixed(2) + (notes ? ' — ' + notes : ''),
    '', skidId
  ]]);

  return getTicketCard(skidId);
}

/** Shared: loads the master row + validates a skid has an editable coating pass, returning the
 *  pieces edit/remove both need. The pass must be a live coating (non-empty Group, positive
 *  cost) that hasn't already been voided. */
function loadCoatingForEdit_(skidId, passNumber) {
  normalizeMasterRows_();
  var m = getMasterSheet_();
  var mMap = headerMap_(m);
  if (!mMap['Litho']) throw new Error('Steel Tickets sheet has no Litho column.');
  var row = findRowBySkidId_(m, skidId);
  if (row === -1) throw new Error('Skid not found: ' + skidId);
  var headers = getHeaders_(m);
  var obj = rowToObject_(headers, m.getRange(row, 1, 1, headers.length).getValues()[0]);
  var history = getTransactionHistory(skidId, obj['Ticket']);
  var active = activeCoatings_(history);
  var target = active.filter(function (c) { return String(c.passNumber) === String(passNumber); })[0];
  if (!target) throw new Error('That coating is no longer on the ticket (it may have already been changed).');
  var nextPass = history.length ? Math.max.apply(null, history.map(function (h) { return Number(h.passNumber) || 0; })) + 1 : 1;
  return { m: m, mMap: mMap, row: row, obj: obj, target: target, nextPass: nextPass };
}

/** Corrects a coating already logged on a ticket: voids the old pass and logs the replacement,
 *  so the Litho cost follows the new rate and the log keeps a full "was X, now Y" trail. The
 *  ticket's Job ID and status are untouched — only this skid's coating changes, not the job's
 *  recipe or its link. */
function editTicketCoating(skidId, passNumber, group, sub, item, operatorName, opId) {
  return withScriptLock_(function () {
    if (guardOp_(opId)) return sanitizeForClient_({ duplicate: true, skidId: skidId });
    if (!group || !item) throw new Error('Pick a size/group and coating item.');
    var match = findRate_(group, sub, item);
    if (!match) throw new Error('Could not find rate for item: ' + item);
    var ctx = loadCoatingForEdit_(skidId, passNumber);
    var oldCost = Number(ctx.target.cost) || 0;
    var newCost = Number(match.totalCost) || 0;
    var currentLitho = Number(ctx.obj['Litho']) || 0;
    var afterVoid = Math.round((currentLitho - oldCost) * 100) / 100;
    var afterNew = Math.round((afterVoid + newCost) * 100) / 100;
    var ticket = ctx.obj['Ticket'];

    // 1) void the old pass  2) log the corrected coating
    var jobId = ctx.obj['Job ID'] || '';
    var tx = getTransactionsSheet_();
    tx.getRange(tx.getLastRow() + 1, 1, 1, TRANSACTION_COLS.length).setValues([[
      new Date(), ticket, ctx.nextPass, operatorName || '', '', '', 'COATING CHANGED (VOID)', '',
      0, 0, -oldCost, afterVoid,
      'VOID#' + passNumber + ': corrected ' + ctx.target.item + ' (' + oldCost.toFixed(2) + ') -> ' + item + ' (' + newCost.toFixed(2) + ')',
      jobId, skidId
    ]]);
    logCoatingTx_(skidId, ticket, ctx.nextPass + 1, operatorName, group, sub, item, match, afterNew,
      'Correction of pass ' + passNumber, ctx.obj['Job ID'] || '');
    stampRow_(ctx.m, ctx.row, ctx.mMap, { 'Litho': afterNew, 'Last Updated At': new Date(), 'Last Updated By': operatorName || '' });
    return getTicketCard(skidId);
  });
}

/** Removes a coating already logged on a ticket: voids the pass and drops its cost from the
 *  Litho total, keeping the void in the audit trail. Job ID and status are untouched. */
function removeTicketCoating(skidId, passNumber, operatorName, opId) {
  return withScriptLock_(function () {
    if (guardOp_(opId)) return sanitizeForClient_({ duplicate: true, skidId: skidId });
    var ctx = loadCoatingForEdit_(skidId, passNumber);
    var oldCost = Number(ctx.target.cost) || 0;
    var currentLitho = Number(ctx.obj['Litho']) || 0;
    var afterVoid = Math.round((currentLitho - oldCost) * 100) / 100;
    var tx = getTransactionsSheet_();
    tx.getRange(tx.getLastRow() + 1, 1, 1, TRANSACTION_COLS.length).setValues([[
      new Date(), ctx.obj['Ticket'], ctx.nextPass, operatorName || '', '', '', 'COATING REMOVED (VOID)', '',
      0, 0, -oldCost, afterVoid,
      'VOID#' + passNumber + ': removed ' + ctx.target.item + ' (' + oldCost.toFixed(2) + ')',
      ctx.obj['Job ID'] || '', skidId
    ]]);
    stampRow_(ctx.m, ctx.row, ctx.mMap, { 'Litho': afterVoid, 'Last Updated At': new Date(), 'Last Updated By': operatorName || '' });
    return getTicketCard(skidId);
  });
}

// ---------------- audits & one-time migration ----------------

/**
 * Audits WIP / Pending skids' Litho cost against the Litho Transactions log (the
 * source of truth: coating costs + adjustment deltas sum to the current cost). Run from the
 * Apps Script editor; pass true to write the recomputed value back where it differs.
 */
function auditWipLithoCosts(applyFixes) {
  return withScriptLock_(function () {
    var m = getMasterSheet_();
    var mMap = headerMap_(m);
    var headers = getHeaders_(m);
    var last = m.getLastRow();
    if (last < 2) return { checked: 0, mismatches: [] };

    var tx = getTransactionsSheet_();
    var txLast = tx.getLastRow();
    var sumBySkid = {}, sumByTicketLegacy = {};
    if (txLast > 1) {
      tx.getRange(2, 1, txLast - 1, TRANSACTION_COLS.length).getValues().forEach(function (r) {
        var amount = Number(r[10]) || 0;
        var sid = String(r[14] || '').trim();
        if (sid) sumBySkid[sid] = Math.round(((sumBySkid[sid] || 0) + amount) * 100) / 100;
        else {
          var t = String(r[1]).trim();
          if (t) sumByTicketLegacy[t] = Math.round(((sumByTicketLegacy[t] || 0) + amount) * 100) / 100;
        }
      });
    }

    var values = m.getRange(2, 1, last - 1, headers.length).getValues();
    var checked = 0, mismatches = [];
    for (var i = 0; i < values.length; i++) {
      var obj = rowToObject_(headers, values[i]);
      var status = obj['Status'] || '';
      if (status !== STATUS.WIP && status !== STATUS.PENDING) continue;
      checked++;
      var sid = String(obj['Skid ID'] || '').trim();
      var computed = Math.round((((sid && sumBySkid[sid]) || 0) + (sumByTicketLegacy[String(obj['Ticket']).trim()] || 0)) * 100) / 100;
      var sheetCost = Math.round((Number(obj['Litho']) || 0) * 100) / 100;
      if (sheetCost !== computed) {
        if (applyFixes) m.getRange(i + 2, mMap['Litho']).setValue(computed);
        mismatches.push({ skidId: sid, ticket: obj['Ticket'], status: status, sheetCost: sheetCost, computedFromLog: computed, fixed: !!applyFixes });
      }
    }
    return { checked: checked, mismatches: mismatches };
  });
}

/**
 * ONE-TIME migration: builds the Steel Tickets master from the old lifecycle tabs
 * (Current Steel -> Current, Litho In Progress + WIP -> WIP), assigning Skid IDs. Old tabs
 * are left untouched as backups. Run from the Apps Script editor. Refuses to run twice.
 */
function migrateToMasterTable() {
  return withScriptLock_(function () {
    var m = getMasterSheet_();
    if (m.getLastRow() > 1) throw new Error('Steel Tickets already has data — migration already ran.');
    var mMap = headerMap_(m);
    var lastCol = m.getLastColumn();
    var sources = [
      { name: SHEETS.CURRENT_STEEL, status: STATUS.CURRENT },
      { name: SHEETS.IN_PROGRESS, status: STATUS.WIP },
      { name: SHEETS.WIP, status: STATUS.WIP }
    ];
    var counts = {};
    var rowsOut = [];
    var now = new Date();
    sources.forEach(function (src) {
      counts[src.name] = 0;
      var sh = getSpreadsheet_().getSheetByName(src.name);
      if (!sh || sh.getLastRow() < 2 || sh.getLastColumn() === 0) return;
      var headers = getHeaders_(sh);
      var values = sh.getRange(2, 1, sh.getLastRow() - 1, headers.length).getValues();
      values.forEach(function (rowVals) {
        var obj = rowToObject_(headers, rowVals);
        if (!obj['Ticket']) return;
        var rowArr = new Array(lastCol).fill('');
        Object.keys(mMap).forEach(function (col) {
          if (obj.hasOwnProperty(col)) rowArr[mMap[col] - 1] = obj[col];
        });
        if (src.name === SHEETS.IN_PROGRESS && mMap['Litho']) {
          rowArr[mMap['Litho'] - 1] = Number(obj['Running Litho Total']) || 0;
        }
        rowArr[mMap['Skid ID'] - 1] = nextSkidId_();
        rowArr[mMap['Status'] - 1] = src.status;
        rowArr[mMap['Last Updated At'] - 1] = now;
        rowArr[mMap['Last Updated By'] - 1] = 'migration';
        rowsOut.push(rowArr);
        counts[src.name]++;
      });
    });
    if (rowsOut.length) m.getRange(2, 1, rowsOut.length, lastCol).setValues(rowsOut);
    counts.total = rowsOut.length;
    return counts;
  });
}

/**
 * CUTOVER step 2 (run after verifying the migrated app): renames the old lifecycle tabs to
 * "<name> (old)" and creates live QUERY view tabs under the ORIGINAL names, filtering the
 * master by status — so anything that reads those tabs keeps working. The views recompute
 * automatically; do not type into them.
 */
function createLegacyViews() {
  var ss = getSpreadsheet_();
  var m = getMasterSheet_();
  var mMap = headerMap_(m);
  var statusLetter = columnLetter_(mMap['Status']);
  var lastLetter = columnLetter_(m.getLastColumn());
  var views = [
    { name: SHEETS.CURRENT_STEEL, status: STATUS.CURRENT },
    { name: SHEETS.WIP, status: STATUS.WIP }
  ];
  views.forEach(function (v) {
    var old = ss.getSheetByName(v.name);
    if (old) {
      if (ss.getSheetByName(v.name + ' (old)')) throw new Error('Backup tab already exists: ' + v.name + ' (old)');
      old.setName(v.name + ' (old)');
    }
    var view = ss.insertSheet(v.name);
    view.getRange(1, 1).setFormula(
      "=QUERY('" + SHEETS.MASTER + "'!A1:" + lastLetter + ", \"select * where " + statusLetter + " = '" + v.status + "'\", 1)");
  });
  var ip = ss.getSheetByName(SHEETS.IN_PROGRESS);
  if (ip) ip.setName(SHEETS.IN_PROGRESS + ' (old)');
  return 'Legacy views created; old tabs renamed to "(old)".';
}
