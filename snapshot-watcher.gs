/**
 * Litho Snapshot Watcher — Google Apps Script (bound to the "Steel Snapshot" spreadsheet)
 * ---------------------------------------------------------------------------------------
 * Emails you each weekday whether the daily Steel snapshot worked, by reading the
 * "Failure Report" tab that the Cloudflare worker writes after its 3 PM run:
 *     Column A = Date (YYYY-MM-DD)   Column B = Success text   Column C = Failure text
 *
 * SETUP (all in the browser, ~5 min, no API keys):
 *   1. Open the "Steel Snapshot" spreadsheet -> Extensions -> Apps Script.
 *   2. Delete the sample code, paste this whole file, and Save.
 *   3. Project Settings (gear) -> set Time zone to America/Los_Angeles.
 *   4. Triggers (clock icon) -> Add Trigger:
 *        Function: checkSnapshot | Event source: Time-driven | Type: Day timer
 *        Time of day: 4pm-5pm  (runs AFTER the 3 PM snapshot)
 *   5. Save; authorize sending email from your account when prompted (one time).
 *
 * Every weekday ~4 PM Pacific you'll get one email: OK with counts, or a failure/no-record
 * alert. Weekends are silent. Set EMAIL_ON_SUCCESS to false to only email on failures.
 */

var RECIPIENT        = 'jmarrujo@cscmfg.com';
var LOG_TAB          = 'Failure Report';
var EMAIL_ON_SUCCESS = true;   // false = only email when a snapshot fails / is missing

function checkSnapshot() {
  var TZ = 'America/Los_Angeles';
  var dow = Utilities.formatDate(new Date(), TZ, 'u'); // 1=Mon … 7=Sun
  if (dow === '6' || dow === '7') return;              // skip weekends
  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');

  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_TAB);
  var todaysRow = null;
  if (sh) {
    var v = sh.getDataRange().getValues();
    for (var i = v.length - 1; i >= 1; i--) {          // newest first, skip header row
      if (String(v[i][0]) === today) { todaysRow = v[i]; break; }
    }
  }

  if (!todaysRow) {
    MailApp.sendEmail(RECIPIENT, 'Steel Snapshot ⚠️ NO RECORD ' + today,
      'No snapshot result was logged for ' + today + '. The job likely did not run at all ' +
      '(worker or schedule issue). Check the app.');
    return;
  }

  var success = String(todaysRow[1] || ''), failure = String(todaysRow[2] || '');
  if (failure) {
    MailApp.sendEmail(RECIPIENT, 'Steel Snapshot ⚠️ FAILED ' + today,
      'The daily Steel snapshot reported a failure:\n\n' + failure);
  } else if (EMAIL_ON_SUCCESS) {
    MailApp.sendEmail(RECIPIENT, 'Steel Snapshot ✅ ' + today,
      'The daily Steel snapshot worked:\n\n' + success);
  }
}
