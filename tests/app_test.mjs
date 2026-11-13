// The ticket printer page (app.py) with a fake printer and fake sheet: ticket format, Copy
// numbering, arrow keys, Print + save / Print only / Save to sheet only, the duplicate check.
// Run: PYTHON=python3 node tests/app_test.mjs   (that python needs flask)
import { spawn } from 'child_process';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = new URL('.', import.meta.url).pathname;
const PORT = 5000 + Math.floor(Math.random() * 900) + 50;
const base = 'http://127.0.0.1:' + PORT;
let pass = 0, fail = 0;
const ok = (name, cond, info) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (info !== undefined ? '  → ' + JSON.stringify(info) : '')); } };

const srv = spawn(process.env.PYTHON || 'python3', [here + 'app_fake_server.py', String(PORT)], { stdio: ['ignore', 'ignore', 'pipe'] });
let errOut = ''; srv.stderr.on('data', (d) => { errOut += d; });
const state = async () => (await fetch(base + '/__state', { method: 'POST' })).json();
const api = async (path, body) => (await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
try {
  for (let i = 0; i < 60; i++) { try { await fetch(base + '/'); break; } catch (e) { await new Promise((r) => setTimeout(r, 250)); } }

  // ---- Server rules
  const row = (t, extra) => Object.assign({ ticket: t, coil_sheet: 'S', qty: '1000', weight: '5000', basis_weight: '75' }, extra || {});
  let r = await api('/print_batch', { tickets: [row('111326-1')] });
  ok('server: a ticket not in MMDDYY-NNN is refused', !r.ok && /isn't in the format MMDDYY-NNN/.test(r.message), r);
  r = await api('/print_batch', { tickets: [row('133026-001')] });
  ok('server: a ticket that isn\'t a real date is refused', !r.ok && /isn't a real date/.test(r.message), r);
  r = await api('/print_batch', { tickets: [row('022926-001')] });
  ok('server: Feb 29 2026 is not a real date', !r.ok && /isn't a real date/.test(r.message), r);
  r = await api('/print_batch', { tickets: [row('111326-002'), row('111326-002')] });
  ok('server: the same number twice in a batch is refused', !r.ok && /in this batch twice/.test(r.message), r);
  r = await api('/print_batch', { tickets: [row('111326-001'), row('111326-005')] });
  let s = await state();
  ok('server: a number already on the sheet stops the batch, nothing printed or saved', !r.ok && r.existing.join() === '111326-001' && s.printed === 0 && s.sheet.length === 1, [r, s]);
  r = await api('/print_batch', { tickets: [row('111326-001')], mode: 'print' });
  s = await state();
  ok('server: Print only reprints it, nothing added (on the 2580 found by name)', r.ok && s.printed === 1 && s.printer === 'Lexmark Forms Printer 2580 (Copy 1)' && s.sheet.length === 1 && /Not saved to the sheet/.test(r.message), [r, s]);
  r = await api('/print_batch', { tickets: [row('111326-002')], mode: 'sheet' });
  s = await state();
  ok('server: Save to sheet only adds it, nothing printed', r.ok && s.printed === 1 && s.sheet.join() === '111326-001,111326-002' && s.skids[1] === 'SKD-000008', [r, s]);
  await api('/__fail', { n: 1 });
  r = await api('/print_batch', { tickets: [row('111326-003')] });
  s = await state();
  ok('server: a failed sheet check stops before printing', !r.ok && /Couldn't reach the sheet/.test(r.message) && s.printed === 1, [r, s]);
  await api('/__fail', { after: 1, n: 2 });
  r = await api('/print_batch', { tickets: [row('111326-003')], mode: 'sheet' });
  s = await state();
  ok('server: a save that fails, then works on a retry, is saved once', r.ok && s.sheet.filter((x) => x === '111326-003').length === 1, [r, s]);
  r = await api('/print_batch', { tickets: [row('111326-004')] });
  await api('/__fail', { n: 0 });
  s = await state();
  ok('server: Print + save does both', r.ok && s.printed === 2 && s.sheet.indexOf('111326-004') !== -1 && /Printed 1 ticket\(s\)\. Saved 1 to the sheet/.test(r.message), [r, s]);
  await api('/__fail', { after: 1, n: 3 });
  r = await api('/print_batch', { tickets: [row('111326-030')] });
  s = await state();
  ok('server: printed but every save failed -> says NOT saved, nothing added', !r.ok && r.sheetFailed && r.printed === 1 && /NOT saved to the sheet/.test(r.message) && s.sheet.indexOf('111326-030') === -1, [r, s]);
  r = await api('/print_batch', { tickets: [row('111326-030')], mode: 'sheet' });
  ok('server: …then Save to sheet only adds it', r.ok && (await state()).sheet.indexOf('111326-030') !== -1, r);
  r = await api('/check_tickets', { tickets: ['111326-004', '111326-009'] });
  ok('server: check_tickets lists the ones already on the sheet', r.ok && r.existing.join() === '111326-004', r);

  // ---- The page
  const b = await chromium.launch(); const page = await b.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(base + '/');
  const T = (i) => page.locator('#tbody tr').nth(i).locator('input[data-key="ticket"]');
  await T(0).click(); await page.keyboard.type('111326005');
  ok('page: typing digits puts the dash in (111326005 -> 111326-005)', (await T(0).inputValue()) === '111326-005', await T(0).inputValue());
  await T(1).click(); await page.keyboard.type('11-13a26');
  ok('page: only digits go in', (await T(1).inputValue()) === '111326', await T(1).inputValue());
  await page.keyboard.press('Tab');
  ok('page: an unfinished number turns red when you leave it', await T(1).evaluate((i) => i.classList.contains('bad')));
  await T(1).fill(''); await T(1).dispatchEvent('input');
  ok('page: a good number is not red', !(await T(0).evaluate((i) => i.classList.contains('bad'))));
  // Copy: the next number
  await page.locator('#tbody tr').nth(0).locator('.cp-btn').click();
  ok('page: Copy gives the next ticket number', (await T(1).inputValue()) === '111326-006', await T(1).inputValue());
  await page.locator('#tbody tr').nth(1).locator('.cp-btn').click();
  ok('page: Copy again -> 007', (await T(2).inputValue()) === '111326-007', await T(2).inputValue());
  await page.locator('#tbody tr').nth(0).locator('.cp-btn').click();
  ok('page: Copy skips numbers already in the table (005 -> 008)', (await T(1).inputValue()) === '111326-008', await T(1).inputValue());
  // Arrow keys
  await T(0).click(); await page.keyboard.press('End'); await page.keyboard.press('ArrowRight');
  let focus = await page.evaluate(() => document.activeElement.dataset.key);
  ok('page: Right at the end of a cell goes to the next cell', focus === 'supplier', focus);
  await page.keyboard.press('ArrowLeft');
  focus = await page.evaluate(() => document.activeElement.dataset.key);
  ok('page: Left from a cell with its text selected goes back', focus === 'ticket', focus);
  await page.keyboard.press('ArrowDown');
  ok('page: Down goes to the same cell in the next row', await page.evaluate(() => document.activeElement === document.querySelectorAll('#tbody input[data-key="ticket"]')[1]));
  await page.keyboard.press('ArrowUp');
  ok('page: Up goes back', await page.evaluate(() => document.activeElement === document.querySelectorAll('#tbody input[data-key="ticket"]')[0]));
  await page.keyboard.press('End'); await page.keyboard.press('ArrowLeft');
  ok('page: Left in the middle of text just moves the caret', await page.evaluate(() => document.activeElement.dataset.key === 'ticket' && document.activeElement.selectionStart === 9));
  // Print + save with a number already on the sheet: the review says so and stays open
  const fillRow = async (i, t) => {
    const tr = page.locator('#tbody tr').nth(i);
    await tr.locator('input[data-key="ticket"]').fill(t); await tr.locator('input[data-key="ticket"]').dispatchEvent('input');
    for (const [k, v] of [['coil_sheet', 'S'], ['qty', '900'], ['weight', '4000'], ['basis_weight', '75']]) await tr.locator('input[data-key="' + k + '"]').fill(v);
  };
  await page.evaluate(() => { document.getElementById('tbody').innerHTML = ''; addRow(); addRow(); });
  await fillRow(0, '111326-004'); await fillRow(1, '111326-010');
  const s0 = await state();
  await page.click('#btnBoth'); await page.waitForSelector('#reviewOverlay.open');
  await page.waitForFunction(() => /Already on the sheet: 111326-004/.test((document.getElementById('reviewErr') || {}).textContent || ''), null, { timeout: 3000 }).catch(() => {});
  ok('page: the review warns about a number already on the sheet', /Already on the sheet: 111326-004/.test(await page.textContent('#reviewModal')));
  await page.click('#reviewGo'); await page.waitForTimeout(300);
  let s1 = await state();
  ok('page: confirming anyway is refused and the window stays open to fix it', await page.$('#reviewOverlay.open') && s1.printed === s0.printed && s1.sheet.length === s0.sheet.length, s1);
  const rv = page.locator('#reviewBody input[data-key="ticket"]').first();
  await rv.fill('111326-011'); await rv.dispatchEvent('input');
  await page.click('#reviewGo'); await page.waitForTimeout(400);
  s1 = await state();
  ok('page: fixed in the review, printed and saved', !(await page.$('#reviewOverlay.open')) && s1.printed === s0.printed + 1 && s1.sheet.indexOf('111326-011') !== -1 && s1.sheet.indexOf('111326-010') !== -1 && /Saved 2 to the sheet/.test(await page.textContent('#status')), [s1, await page.textContent('#status')]);
  // Print only: no check, nothing saved
  await page.click('#btnPrint'); await page.waitForSelector('#reviewOverlay.open');
  ok('page: Print only says so in the review', (await page.textContent('#reviewGo')) === 'Print only' && /nothing added to the sheet/.test(await page.textContent('#reviewTitle')));
  await page.click('#reviewGo'); await page.waitForTimeout(300);
  const s2 = await state();
  ok('page: Print only prints, adds nothing', s2.printed === s1.printed + 1 && s2.sheet.length === s1.sheet.length && /Not saved to the sheet/.test(await page.textContent('#status')));
  // A save that fails every try: printed, and the page says plainly it wasn't saved
  await page.evaluate(() => { document.getElementById('tbody').innerHTML = ''; addRow(); });
  await fillRow(0, '111326-020');
  await page.click('#btnBoth'); await page.waitForSelector('#reviewOverlay.open'); await page.waitForTimeout(300);
  const s3a = await state();
  await api('/__fail', { after: 1, n: 3 });
  await page.click('#reviewGo'); await page.waitForTimeout(500);
  const s3 = await state();
  ok('page: printed, NOT saved -> a red message that says so', s3.printed === s3a.printed + 1 && s3.sheet.indexOf('111326-020') === -1 && /NOT saved to the sheet/.test(await page.textContent('#status')) && (await page.$eval('#status', (e) => e.className)) === 'err');
  await page.click('#btnSheet'); await page.waitForSelector('#reviewOverlay.open'); await page.waitForTimeout(300);
  ok('page: Save to sheet only says so in the review', (await page.textContent('#reviewGo')) === 'Save to sheet only');
  await page.click('#reviewGo'); await page.waitForTimeout(400);
  const s4 = await state();
  ok('page: …and adds it without printing', s4.printed === s3.printed && s4.sheet.indexOf('111326-020') !== -1 && /Saved 1 to the sheet/.test(await page.textContent('#status')));
  // Arrow keys in the review window too
  await page.click('#btnPrint'); await page.waitForSelector('#reviewOverlay.open');
  await page.locator('#reviewBody input').first().click(); await page.keyboard.press('ArrowRight');
  ok('page: arrow keys work in the review window', await page.evaluate(() => document.activeElement.closest('#reviewBody') && document.activeElement.dataset.key === 'ticket'));
  await page.click('#reviewOverlay .ghost');
  // Setup checks: the printer is found by name, a missing printer / key file is shown in red
  await page.goto(base + '/');
  ok('page: a printer with 2580 in its name is found automatically', /Lexmark Forms Printer 2580 \(Copy 1\) \(found automatically\)/.test(await page.textContent('.printer')) && !/Setup problem/.test(await page.textContent('body')));
  await api('/__setup', { printers: ['Microsoft Print to PDF'], key: '/nope/service_account.json' });
  await page.goto(base + '/');
  const body = await page.textContent('body');
  ok('page: no 2580 and no key file -> a red Setup problem box naming both', /Printer: NOT FOUND/.test(body) && /Setup problem/.test(body) && /No Lexmark 2580 printer found/.test(body) && /key file is missing.*\/nope\/service_account\.json/.test(body), body.slice(0, 600));
  r = await api('/print_batch', { tickets: [row('111326-040')], mode: 'print' });
  ok('server: printing with no 2580 says so plainly', !r.ok && /No Lexmark 2580 found/.test(r.message), r);
  await api('/__setup', { printers: ['Lexmark Forms Printer 2580'], key: '' });
  ok('page: no errors', !errs.length, errs);
  await b.close();
} catch (e) { fail++; console.log('  ✗ crashed: ' + (e.stack || e)); }
finally { srv.kill(); }
if (errOut && fail) console.log(errOut.slice(-2000));
console.log((fail ? '✗' : '✓') + ' app_test: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
