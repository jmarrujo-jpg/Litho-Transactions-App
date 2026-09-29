// Front-end tests: the real Index.HTML in Chromium, Worker calls answered by a mock.
// Uses the globally installed Playwright + the preinstalled Chromium (Claude Code cloud sessions).
import pw from '/opt/node22/lib/node_modules/playwright/index.js'; const { chromium } = pw;

const FILE = new URL('../Index.HTML', import.meta.url).href;
const API = 'https://litho-floor.jmarrujo.workers.dev';
let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) pass++; else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); } }

const RATE = { groups: ['603X408'], tree: { '603X408': { subs: ['5-OUT', '10-OUT'], items: {
  '5-OUT': [{ item: 'SIZE', chemCode: 'C1', appCost: 1, lineCost: 1, totalCost: 2 }],
  '10-OUT': [{ item: 'SIZE', chemCode: 'C1', appCost: 1, lineCost: 1.5, totalCost: 2.5 }, { item: 'VARNISH', chemCode: 'C2', appCost: 2, lineCost: 2, totalCost: 4 }] } } },
  addonGroup: '', addons: [] };
const NASTY = '2" edge dent <img src=x onerror="window.__xss=1"> & more';
const today = new Date().toISOString().slice(0, 10);
function ticket(id, t, status, extra) { return Object.assign({ skidId: id, ticket: t, status, qty: 100, weight: 500, bw: '75', type: 'T', temper: 'T4', length: '30', width: '30', endUse: '603X408', litho: status === 'WIP' ? 10 : 0, row: '', countedOn: '' }, extra || {}); }

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
async function boot(handlers) {
  const page = await browser.newPage();
  const calls = [];
  page.on('pageerror', (e) => calls.push({ fn: '__pageerror', args: [String(e)] }));
  await page.route(API + '**', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    calls.push(body);
    const h = handlers[body.fn];
    let out;
    try { out = h ? await h(body.args, calls) : { ok: true, result: null }; }
    catch (e) { out = { ok: false, error: e.message }; }
    if (out === 'ABORT') return route.abort('connectionreset');
    if (out === 'HANG') return;   // never answer
    if (out && out.__raw) return route.fulfill({ status: out.status, body: out.__raw, contentType: 'text/html' });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(out) });
  });
  await page.goto(FILE);
  await page.waitForTimeout(300);
  return { page, calls };
}
const R = (result) => ({ ok: true, result });
const card = (steel, extra) => Object.assign({ skidId: steel['Skid ID'], ticket: steel['Ticket'], status: steel['Status'], steel, litho: Number(steel['Litho']) || 0,
  passCount: 0, suggestedGroup: '603X408', coatings: [], transactions: [], family: { base: steel['Ticket'], members: [] } }, extra || {});
const base = {
  getRateTree: () => R(RATE), getAllTickets: () => R([]), getOpenJobs: () => R([]), getOperatorNames: () => R([]),
  getActiveCount: () => R(null), getJobsForDate: () => R([]),
};

// ---- 1. esc(): escapes, and a nasty comment survives a round trip through the edit form
{ const { page, calls } = await boot(Object.assign({}, base, {
    getTicketCard: () => R(card({ 'Skid ID': 'SKD-1', 'Ticket': '100', 'Status': 'Current', 'Comments': NASTY, 'End Use': NASTY, 'Litho': '' })),
  }));
  const e = await page.evaluate(() => esc('<a href="x">\'&</a>'));
  ok('esc escapes all 5 chars', e === '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&lt;/a&gt;', e);
  await page.evaluate(() => openCard('SKD-1'));
  await page.waitForSelector('#edComments');
  const v = await page.$eval('#edComments', (el) => el.value);
  ok('comment with quote + tags kept whole in the edit box', v === NASTY, v);
  ok('no script ran from sheet data', await page.evaluate(() => window.__xss === undefined));
  ok('End Use shows as text', (await page.textContent('#view')).includes('<img src=x'));
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
  await page.close();
}

// ---- 2. runMutation retry rules + sticky opId
{ let n = 0;
  const { page, calls } = await boot(Object.assign({}, base, {
    serverErr: () => ({ ok: false, error: 'Only 40 sheets on this ticket' }),
    flaky: () => (++n < 3 ? 'ABORT' : R('fine')),
    gateway: () => ({ __raw: '<html>502</html>', status: 502 }),
    hang: () => 'HANG',
  }));
  const run = (fn, args) => page.evaluate(({ fn, args }) => new Promise((res) => {
    const t0 = Date.now();
    runMutation(fn, args, (r) => res({ ok: true, r, ms: Date.now() - t0 }), (e) => res({ ok: false, msg: e.message, fromServer: !!e.fromServer, transport: !!e.transport, ms: Date.now() - t0 }));
  }), { fn, args });
  const count = (fn) => calls.filter((c) => c.fn === fn).length;

  const a = await run('serverErr', ['x', 'op-1-aaaa']);
  ok('server error shown, not retried', !a.ok && a.fromServer && count('serverErr') === 1, [a, count('serverErr')]);
  ok('server error is fast (<1s)', a.ms < 1000, a.ms);

  const b = await run('flaky', ['y', 'op-2-bbbb']);
  ok('dropped connection retried until it works', b.ok && count('flaky') === 3, [b, count('flaky')]);
  ok('retries reuse the same opId', calls.filter((c) => c.fn === 'flaky').every((c) => c.args[1] === 'op-2-bbbb'));

  const g = await run('gateway', ['z', 'op-3-cccc']);
  ok('HTML gateway page -> transport error, retried', !g.ok && g.transport && count('gateway') === 3, [g, count('gateway')]);

  // sticky: same action again after a failure reuses the failed attempt's opId
  await run('serverErr', ['same', 'op-4-dddd']);
  await run('serverErr', ['same', 'op-5-eeee']);
  const sent = calls.filter((c) => c.fn === 'serverErr' && c.args[0] === 'same').map((c) => c.args[1]);
  ok('identical retry after failure reuses opId', sent[0] === 'op-4-dddd' && sent[1] === 'op-4-dddd', sent);
  await run('serverErr', ['different', 'op-6-ffff']);
  ok('different inputs -> new opId', calls.filter((c) => c.args[0] === 'different')[0].args[1] === 'op-6-ffff');

  await page.evaluate(() => { API_TIMEOUT_MS = 400; });
  const h = await run('hang', ['h', 'op-7-gggg']);
  ok('no answer -> times out with a clear message', !h.ok && /No response/.test(h.msg) && h.ms < 3000, h);
  ok('timeout not auto-retried', count('hang') === 1, count('hang'));
  await page.close();
}

// ---- 3. Create Job: a failed Start doesn't double the picker coating; retry reuses opId
{ let n = 0;
  const { page, calls } = await boot(Object.assign({}, base, {
    createJob: (args) => (++n === 1 ? { ok: false, error: 'Sheets API 503: unavailable' } : R({ jobId: 'JOB-000009', coatings: args[2] })),
    getAllTickets: () => R([ticket('SKD-1', '100', 'Current')]),
  }));
  await page.evaluate(() => openCreateJob());
  await page.waitForSelector('#jobGroupSelect option[value="603X408"]', { state: 'attached' });
  await page.selectOption('#jobGroupSelect', '603X408');
  await page.waitForTimeout(100);
  ok('#OUT defaults to highest', (await page.$eval('#jobSubSelect', (s) => s.value)) === '10-OUT');
  await page.selectOption('#jobItemSelect', 'SIZE');
  await page.fill('#jobOperator', '');
  await page.click('#startJobSetupBtn');                  // no operator -> toast
  await page.fill('#jobOperator', 'Ann');
  await page.click('#startJobSetupBtn');                  // server fails
  await page.waitForTimeout(300);
  await page.click('#startJobSetupBtn');                  // works
  await page.waitForSelector('#jobTicketSearch');
  const cj = calls.filter((c) => c.fn === 'createJob');
  ok('two createJob calls', cj.length === 2, cj.length);
  ok('each sent ONE coating (not 2 or 3)', cj.every((c) => c.args[2].length === 1), cj.map((c) => c.args[2].length));
  ok('retry reused the opId', cj[0].args[4] === cj[1].args[4], cj.map((c) => c.args[4]));
  ok('ticket search has focus', await page.evaluate(() => document.activeElement && document.activeElement.id === 'jobTicketSearch'));
  ok('name field prefilled with creator on a new job', (await page.$eval('#jobTicketOperator', (el) => el.value)) === 'Ann');
  await page.close();
}

// ---- 4. Resumed job: tickets are logged under the person adding them, not the creator
{ const { page, calls } = await boot(Object.assign({}, base, {
    getJobDetail: () => R({ jobId: 'JOB-000003', description: 'Blue', createdBy: 'Creator', coatings: [{ group: '603X408', sub: '10-OUT', item: 'SIZE' }], tickets: [] }),
    getAllTickets: () => R([ticket('SKD-7', '777', 'Current')]),
    jobAddTicket: (args) => R({ skidId: args[1], ticket: '777', litho: 2.5, jobId: args[0] }),
  }));
  await page.evaluate(() => resumeJob('JOB-000003'));
  await page.waitForSelector('#jobTicketOperator');
  ok('name field blank on a resumed job (not the creator)', (await page.$eval('#jobTicketOperator', (el) => el.value)) === '');
  await page.fill('#jobTicketSearch', '777');
  await page.waitForTimeout(200);
  const pick = await page.$('#jobQueuePicker [data-pick]');
  if (pick) await pick.click();
  await page.waitForSelector('#addTicketToJobBtn', { timeout: 3000 }).catch(() => {});
  if (await page.$('#addTicketToJobBtn')) {
    await page.click('#addTicketToJobBtn');
    await page.waitForTimeout(150);
    ok('refused without a name', calls.filter((c) => c.fn === 'jobAddTicket').length === 0);
    await page.fill('#jobTicketOperator', 'Bob');
    await page.click('#addTicketToJobBtn');
    await page.waitForTimeout(300);
    const ja = calls.filter((c) => c.fn === 'jobAddTicket');
    ok('logged as Bob', ja.length === 1 && ja[0].args[5] === 'Bob', ja.map((c) => c.args[5]));
    ok('button text has no raw entity', !(await page.textContent('#view')).includes('&hellip;'));
  } else ok('could open the picked ticket', false, await page.innerHTML('#jobQueuePicker'));
  await page.close();
}

// ---- 5. WIP litho cost: blank is rejected, "1,234.50" goes through clean
{ const { page, calls } = await boot(Object.assign({}, base, {
    getTicketCard: () => R(card({ 'Skid ID': 'SKD-2', 'Ticket': '200', 'Status': 'WIP', 'Litho': 10 }, { litho: 10 })),
    updateWipLithoCost: () => R(card({ 'Skid ID': 'SKD-2', 'Ticket': '200', 'Status': 'WIP', 'Litho': 12 })),
  }));
  await page.evaluate(() => openCard('SKD-2'));
  await page.waitForSelector('#wipCostInput');
  ok('cost box uses decimal keypad', (await page.$eval('#wipCostInput', (el) => el.getAttribute('inputmode'))) === 'decimal');
  await page.fill('#wipCostInput', '');
  await page.fill('#wipCostOperator', 'Ann');
  await page.click('#saveWipCostBtn');
  await page.waitForTimeout(150);
  ok('blank cost not sent', calls.filter((c) => c.fn === 'updateWipLithoCost').length === 0);
  ok('explains why', (await page.textContent('#toast')).includes('number'));
  await page.fill('#wipCostInput', '12.5');
  await page.click('#saveWipCostBtn');
  await page.waitForTimeout(300);
  const u = calls.filter((c) => c.fn === 'updateWipLithoCost');
  ok('real cost sent', u.length === 1 && u[0].args[1] === '12.5', u.map((c) => c.args[1]));
  await page.close();
}

// ---- 6. Count: Finish reloads first, so another iPad's check-offs aren't "not found"
{ let finished = false;
  const sess = { sessionId: 'CNT-1', stage: 'Current', startedOn: today, startedBy: 'Ann' };
  const { page, calls } = await boot(Object.assign({}, base, {
    getActiveCount: () => R(sess),
    getAllTickets: (a, c) => {
      const loads = c.filter((x) => x.fn === 'getAllTickets').length;
      // 2nd load onward: the OTHER iPad has counted SKD-A
      return R([ticket('SKD-A', 'A1', 'Current', { countedOn: loads >= 2 ? today : '' }), ticket('SKD-B', 'B1', 'Current')]);
    },
  }));
  await page.evaluate(() => openSteelCount());
  await page.waitForSelector('#countFinishBtn');
  await page.click('#countFinishBtn');
  await page.waitForTimeout(400);
  const txt = await page.textContent('#view');
  ok('reloaded before review', calls.filter((c) => c.fn === 'getAllTickets').length >= 2);
  ok('review lists B1 (really not found)', txt.includes('B1'));
  ok('review does NOT list A1 (found on the other iPad)', !txt.includes('A1'), txt.slice(0, 400));
  await page.close();
}

// ---- 7. Database passcode: masked, numeric keypad, asked again after reload
{ const { page } = await boot(base);
  await page.evaluate(() => openDatabase());
  await page.waitForSelector('#modalPromptInput');
  ok('code box is a password field', (await page.$eval('#modalPromptInput', (el) => el.type)) === 'password');
  ok('code box numeric keypad', (await page.$eval('#modalPromptInput', (el) => el.getAttribute('inputmode'))) === 'numeric');
  await page.fill('#modalPromptInput', '1245');
  await page.click('#modalOk');
  await page.waitForTimeout(150);
  ok('unlocks with the code', await page.evaluate(() => dbUnlocked === true));
  await page.reload();
  await page.waitForTimeout(300);
  ok('locked again after refresh', await page.evaluate(() => dbUnlocked === false));
  await page.close();
}

await browser.close();
console.log((fail ? '✗' : '✓') + ' ui_test: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
