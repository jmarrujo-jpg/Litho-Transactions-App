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
// Litho Department asks for a name first.
async function enterLitho(page, name) {
  if (!(await page.$('#tileLithoLine'))) await page.click('#tileLitho');   // Back from Litho lands on the chooser
  await page.evaluate(() => { document.getElementById('tileLithoLine').disabled = false; });   // greyed out for now (see 17)
  await page.click('#tileLithoLine');
  await page.waitForSelector('#lithoUserSelect');
  await page.selectOption('#lithoUserSelect', { label: name });
  await page.click('#lithoLoginBtn');
  await page.waitForTimeout(250);
}
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
    ok('blank Tested BW sent as blank', ja[0] && ja[0].args[8] === '', ja[0] && ja[0].args);
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

// ---- 8. A scan that finds nothing reloads the list once (ticket added on another iPad)
{ let added = false;
  const { page, calls } = await boot(Object.assign({}, base, {
    getAllTickets: () => R([ticket('SKD-A', 'A1', 'Current')].concat(added ? [ticket('SKD-N', '5550', 'Current')] : [])),
  }));
  const loads = () => calls.filter((c) => c.fn === 'getAllTickets').length;
  await page.click('#tileSearch');
  await page.waitForTimeout(200);
  ok('search box has focus on open', await page.evaluate(() => document.activeElement && document.activeElement.id === 'globalSearch'));
  const before = loads();
  added = true;                                        // another iPad adds ticket 5550 now
  await page.keyboard.type('5550');
  await page.waitForTimeout(150);
  ok('miss says it is checking', (await page.textContent('#searchActiveList')).includes('Checking for newly added'));
  ok('no reload while still typing', loads() === before, [before, loads()]);
  await page.waitForTimeout(1000);
  ok('one reload after the pause', loads() === before + 1, [before, loads()]);
  ok('new ticket found after reload', (await page.textContent('#searchActiveList')).includes('5550'));
  await page.fill('#globalSearch', 'ZZZ');
  await page.waitForTimeout(1000);
  const afterZ = loads();
  await page.evaluate(() => renderSearchActive());     // same miss re-rendered: no second request
  await page.waitForTimeout(1000);
  ok('a real "no match" costs one request, not a loop', loads() === afterZ && afterZ === before + 2, [before, afterZ, loads()]);
  ok('final miss message has no "checking"', !(await page.textContent('#searchActiveList')).includes('Checking'));

  // Used in Production: Enter on an unknown skid reloads right away and adds it if it now exists
  added = false;
  await page.evaluate(() => { setCaches([]); allCache = [ticket0()]; function ticket0() { return { skidId: 'SKD-A', ticket: 'A1', status: 'Current' }; } renderUsedHome(); });
  await page.waitForSelector('#usedAddInput');
  ok('used scan box has focus', await page.evaluate(() => document.activeElement && document.activeElement.id === 'usedAddInput'));
  added = true;
  const b2 = loads();
  await page.fill('#usedAddInput', 'SKD-N');
  await page.press('#usedAddInput', 'Enter');
  await page.waitForTimeout(600);
  ok('Enter on unknown skid reloads once', loads() === b2 + 1, [b2, loads()]);
  ok('reloaded skid is added to the list', (await page.textContent('#usedListBox')).includes('5550'));
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
  await page.close();
}

// ---- 9. iPad basics: numeric keypads, no field under 16px, 44px buttons
{ const { page } = await boot(Object.assign({}, base, {
    getTicketCard: () => R(card({ 'Skid ID': 'SKD-1', 'Ticket': '100', 'Status': 'Current', 'Litho': '' })),
  }));
  await page.setViewportSize({ width: 1024, height: 1366 });   // iPad portrait: the phone CSS does NOT apply
  await page.evaluate(() => openCard('SKD-1'));
  await page.waitForSelector('#edSpoil');
  const info = await page.evaluate(() => ({
    numNoMode: Array.from(document.querySelectorAll('input[type=number]')).filter((i) => !i.getAttribute('inputmode')).map((i) => i.id || i.className),
    small: Array.from(document.querySelectorAll('input:not([type=checkbox]):not([type=radio]), select, textarea')).filter((i) => parseFloat(getComputedStyle(i).fontSize) < 16).map((i) => i.id),
    shortBtns: Array.from(document.querySelectorAll('.btn')).filter((b) => b.offsetParent && b.getBoundingClientRect().height < 44).map((b) => b.id || b.textContent.trim()),
    weightMode: (document.querySelector('#edWeight') || {}).inputMode,
  }));
  ok('every number field sets a keypad', !info.numNoMode.length, info.numNoMode);
  ok('no field text under 16px on iPad', !info.small.length, info.small);
  ok('no visible button under 44px', !info.shortBtns.length, info.shortBtns);
  ok('weight gets the decimal keypad', info.weightMode === 'decimal', info.weightMode);
  await page.close();
}

// ---- 10. Fewer requests: lists are reused for a few minutes; a save forces a reload
{ const { page, calls } = await boot(Object.assign({}, base, {
    getAllTickets: () => R([ticket('SKD-A', 'A1', 'Current')]),
    getTicketCard: () => R(card({ 'Skid ID': 'SKD-A', 'Ticket': 'A1', 'Status': 'Current', 'Litho': '' })),
    updateTicketDetails: () => R({ ok: true }),
  }));
  const n = (fn) => calls.filter((c) => c.fn === fn).length;
  ok('no operator-names request on page load', n('getOperatorNames') === 0);
  await enterLitho(page, 'Alex');
  ok('Litho list loads once', n('getAllTickets') === 1 && n('getOpenJobs') === 1, [n('getAllTickets'), n('getOpenJobs')]);
  await page.click('#backBtn'); await page.waitForTimeout(100);
  await enterLitho(page, 'Alex');
  ok('coming back within minutes reuses the list', n('getAllTickets') === 1 && n('getOpenJobs') === 1, [n('getAllTickets'), n('getOpenJobs')]);
  ok('reused list still shows the tickets', (await page.textContent('#allListContainer')).includes('A1'));
  await page.evaluate(() => new Promise((res) => runMutation('updateTicketDetails', ['SKD-A', {}, 'Ann', '', newOpId()], res, res)));
  await page.click('#backBtn'); await page.waitForTimeout(100);
  await enterLitho(page, 'Alex');
  ok('after a save the list reloads', n('getAllTickets') === 2 && n('getOpenJobs') === 2, [n('getAllTickets'), n('getOpenJobs')]);
  await page.evaluate(() => { ticketsLoadedAt -= 4 * 60 * 1000; openJobsAt -= 4 * 60 * 1000; });   // 4 minutes pass
  await page.click('#backBtn'); await page.waitForTimeout(100);
  await enterLitho(page, 'Alex');
  ok('after 3+ minutes the list reloads', n('getAllTickets') === 3 && n('getOpenJobs') === 3, [n('getAllTickets'), n('getOpenJobs')]);
  await page.close();
}

// ---- 11. Count check-offs are saved in batches, and Finish saves waiting ones first
{ const sess = { sessionId: 'CNT-1', stage: 'Current', startedOn: today, startedBy: 'Ann' };
  const counted = {};
  const skids = ['SKD-A', 'SKD-B', 'SKD-C', 'SKD-D', 'SKD-E', 'SKD-F'];
  const { page, calls } = await boot(Object.assign({}, base, {
    getActiveCount: () => R(sess),
    getAllTickets: () => R(skids.map((id, i) => ticket(id, 'T' + i, 'Current', { countedOn: counted[id] ? today : '' }))),
    setSkidsCounted: (a) => { a[0].forEach((id) => { counted[id] = a[1]; }); return R({ updated: a[0].length }); },
  }));
  await page.evaluate(() => { COUNT_FLUSH_MS = 600; openSteelCount(); });
  await page.waitForSelector('.countChk');
  for (const id of skids.slice(0, 4)) await page.click('.countChk[data-skid="' + id + '"]');
  await page.click('.countChk[data-skid="SKD-D"]');                  // changed their mind on D
  const saves = () => calls.filter((c) => c.fn === 'setSkidsCounted' || c.fn === 'setSkidCounted');
  ok('taps are not sent one by one', saves().length === 0, saves().length);
  await page.waitForTimeout(900);
  ok('one request for the batch', saves().length === 1, saves().map((c) => c.args));
  ok('batch holds A,B,C checked', JSON.stringify(saves()[0] && saves()[0].args[0].slice().sort()) === '["SKD-A","SKD-B","SKD-C"]' && saves()[0].args[1] === true, saves()[0] && saves()[0].args);
  ok('D (tapped twice) not saved as counted', !counted['SKD-D']);
  await page.evaluate(() => { COUNT_FLUSH_MS = 60000; });
  await page.click('.countChk[data-skid="SKD-E"]');
  await page.click('#countFinishBtn');
  await page.waitForTimeout(500);
  ok('Finish saves the waiting tap first', counted['SKD-E'] === true);
  const txt = await page.textContent('#view');
  ok('review does not list E as not found', !txt.includes('T4'), txt.slice(0, 300));
  ok('review lists F as not found', txt.includes('T5'));
  await page.close();
}

// ---- 12. Safety cap: a runaway loop is stopped at 60 requests a minute
{ const { page, calls } = await boot(base);
  const before = calls.length;
  const res = await page.evaluate(() => new Promise((done) => {
    let back = 0, blocked = 0;
    for (let i = 0; i < 70; i++) google.script.run.withSuccessHandler(() => { if (++back === 70) done({ blocked }); })
      .withFailureHandler((e) => { if (e.throttled) blocked++; if (++back === 70) done({ blocked }); }).getOpenJobs();
  }));
  const sent = calls.length - before;
  ok('requests past the cap are not sent', sent <= 60, sent);
  ok('blocked ones fail with a clear message', res.blocked >= 10, res);
  await page.close();
}

// ---- 13. Tested BW on "add ticket to job": shown, checked, sent, displayed
{ const { page, calls } = await boot(Object.assign({}, base, {
    getJobDetail: () => R({ jobId: 'JOB-000009', description: 'Blue', createdBy: 'Ann', coatings: [{ group: '603X408', sub: '10-OUT', item: 'SIZE' }], tickets: [] }),
    getAllTickets: () => R([ticket('SKD-8', '888', 'Current')]),
    jobAddTicket: (args) => R({ skidId: args[1], ticket: '888', litho: 2.5, jobId: args[0], sheetsRun: 100, testedBw: args[8] ? Number(args[8]) : undefined }),
  }));
  await page.evaluate(() => resumeJob('JOB-000009'));
  await page.waitForSelector('#jobTicketOperator');
  await page.fill('#jobTicketOperator', 'Ann');
  await page.fill('#jobTicketSearch', '888');
  await page.waitForTimeout(200);
  await page.click('#jobQueuePicker [data-pick]');
  await page.waitForSelector('#jobTestedBw');
  ok('Tested BW box shows the ticket BW as a hint', (await page.textContent('#jobPickedTicketCard')).includes('ticket says 75'));
  ok('Tested BW box uses the decimal keypad', (await page.$eval('#jobTestedBw', (el) => el.inputMode)) === 'decimal');
  await page.evaluate(() => { const el = document.getElementById('jobTestedBw'); el.type = 'text'; el.value = '7x'; });   // what a paste could leave
  await page.click('#addTicketToJobBtn');
  await page.waitForTimeout(150);
  ok('bad Tested BW blocked before sending', calls.filter((c) => c.fn === 'jobAddTicket').length === 0);
  await page.fill('#jobTestedBw', '75.3');
  await page.click('#addTicketToJobBtn');
  await page.waitForTimeout(300);
  const ja = calls.filter((c) => c.fn === 'jobAddTicket');
  ok('Tested BW sent with the add', ja.length === 1 && ja[0].args[8] === '75.3', ja.map((c) => c.args));
  ok('added list shows the Tested BW', (await page.textContent('#jobAddedList')).includes('75.3'));
  ok('no "not saved" warning when the server confirms it', !(await page.$('.modal-overlay')));
  await page.close();
}
// ---- 14. An older Worker that ignores Tested BW: the operator is told
{ const { page } = await boot(Object.assign({}, base, {
    getJobDetail: () => R({ jobId: 'JOB-000010', description: 'Blue', createdBy: 'Ann', coatings: [{ group: '603X408', sub: '10-OUT', item: 'SIZE' }], tickets: [] }),
    getAllTickets: () => R([ticket('SKD-9', '999', 'Current')]),
    jobAddTicket: (args) => R({ skidId: args[1], ticket: '999', litho: 2.5, jobId: args[0] }),   // no testedBw echo
  }));
  await page.evaluate(() => resumeJob('JOB-000010'));
  await page.waitForSelector('#jobTicketOperator');
  await page.fill('#jobTicketOperator', 'Ann');
  await page.fill('#jobTicketSearch', '999');
  await page.waitForTimeout(200);
  await page.click('#jobQueuePicker [data-pick]');
  await page.waitForSelector('#jobTestedBw');
  await page.fill('#jobTestedBw', '76.1');
  await page.click('#addTicketToJobBtn');
  await page.waitForTimeout(300);
  ok('warns when the Tested BW was not saved', ((await page.textContent('#modalRoot')) || '').includes('Tested BW not saved'));
  await page.close();
}

// ---- 15. Litho sign-in: pick a name; managers and workers get different screens
{ const { page, calls } = await boot(Object.assign({}, base, {
    getAllTickets: () => R([ticket('SKD-A', 'A1', 'Current')]),
    getOpenJobs: () => R([{ jobId: 'JOB-000004', description: 'Blue run', ticketCount: 2, coatings: 'SIZE' }]),
  }));
  await page.click('#tileLitho');
  await page.evaluate(() => { document.getElementById('tileLithoLine').disabled = false; });
  await page.click('#tileLithoLine');
  await page.waitForSelector('#lithoUserSelect');
  const names = await page.$$eval('#lithoUserSelect option', (os) => os.map((o) => o.textContent));
  ok('name list: placeholder + Alex, Joel, Jonathan, Worker', JSON.stringify(names) === JSON.stringify(['Select name…', 'Alex', 'Joel', 'Jonathan', 'Worker']), names);
  await page.click('#lithoLoginBtn'); await page.waitForTimeout(100);
  ok('must pick a name', await page.$('#lithoUserSelect') !== null && !(await page.$('#newJobBtn')));
  ok('no ticket list loaded before signing in', calls.filter((c) => c.fn === 'getAllTickets').length === 0);

  // Manager
  await page.selectOption('#lithoUserSelect', { label: 'Joel' });
  await page.click('#lithoLoginBtn'); await page.waitForTimeout(300);
  let txt = await page.textContent('#view');
  ok('manager: greeted by name', txt.includes('Joel') && txt.includes('Manager'));
  ok('manager: New Job + Review Jobs', !!(await page.$('#newJobBtn')) && !!(await page.$('#reviewJobsBtn')));
  ok('manager: sees the ticket list', (await page.textContent('#allListContainer')).includes('A1'));
  await page.click('#reviewJobsBtn'); await page.waitForTimeout(200);
  ok('manager: Review Jobs opens', await page.evaluate(() => state.view === 'review'));
  await page.click('#backBtn'); await page.waitForTimeout(200);
  ok('Back from Review Jobs returns to the manager home', await page.evaluate(() => state.view === 'all') && !!(await page.$('#reviewJobsBtn')));
  await page.evaluate(() => openCreateJob()); await page.waitForTimeout(150);
  ok('operator name pre-filled with the signed-in name', (await page.$eval('#jobOperator', (el) => el.value)) === 'Joel');

  // Worker
  await page.click('#backBtn'); await page.waitForTimeout(150);
  await page.click('#lithoSwitchBtn'); await page.waitForTimeout(150);
  ok('Change name shows the picker with the current name selected', (await page.$eval('#lithoUserSelect', (el) => el.options[el.selectedIndex].textContent)) === 'Joel');
  const loadsBefore = calls.filter((c) => c.fn === 'getAllTickets').length;
  await page.selectOption('#lithoUserSelect', { label: 'Worker' });
  await page.click('#lithoLoginBtn'); await page.waitForTimeout(300);
  txt = await page.textContent('#view');
  ok('worker: New Job, Open Jobs, Add Ticket', !!(await page.$('#newJobBtn')) && !!(await page.$('#openJobsBtn')) && !!(await page.$('#addTicketBtn')));
  ok('worker: no Review Jobs', !(await page.$('#reviewJobsBtn')));
  ok('worker: no ticket list', !(await page.$('#allListContainer')) && !txt.includes('A1'));
  ok('worker: not labelled manager', !txt.includes('Manager'));
  ok('worker home does not load the ticket list', calls.filter((c) => c.fn === 'getAllTickets').length === loadsBefore);
  await page.evaluate(() => openReview()); await page.waitForTimeout(150);
  ok('worker: Review Jobs blocked even if reached directly', await page.evaluate(() => state.view !== 'review'));
  await page.click('#openJobsBtn'); await page.waitForTimeout(300);
  ok('worker: Open Jobs lists the open job', (await page.textContent('#view')).includes('Blue run'));
  await page.click('#backBtn'); await page.waitForTimeout(150);
  ok('Back from Open Jobs returns to the worker home', !!(await page.$('#openJobsBtn')));
  await page.click('#backBtn'); await page.waitForTimeout(150);
  ok('Back from the Litho home goes to the Litho Department chooser', !!(await page.$('#tileLithoLine')) && !!(await page.$('#tileMoveWip')));
  await page.click('#backBtn'); await page.waitForTimeout(150);
  ok('Back from the chooser goes to the landing screen', !!(await page.$('#tileLitho')));
  await page.reload(); await page.waitForTimeout(300);
  await page.click('#tileLitho'); await page.evaluate(() => { document.getElementById('tileLithoLine').disabled = false; }); await page.click('#tileLithoLine'); await page.waitForTimeout(150);
  ok('after a refresh nobody is pre-selected', (await page.$eval('#lithoUserSelect', (el) => el.value)) === '');
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
  await page.close();
}

// ---- 16. Worker opening a job from Open Jobs: sees its coatings and only adds tickets
{ const job = { jobId: 'JOB-000004', description: 'Blue run', createdBy: 'Alex', tickets: [],
    coatings: [{ group: '603X408', sub: '10-OUT', item: 'SIZE' }, { group: '603X408', sub: '10-OUT', item: 'VARNISH' }] };
  const { page, calls } = await boot(Object.assign({}, base, {
    getOpenJobs: () => R([{ jobId: job.jobId, description: job.description, ticketCount: 0, coatings: 'SIZE, VARNISH' }]),
    getJobDetail: () => R(job),
    getAllTickets: () => R([ticket('SKD-7', '777', 'Current')]),
    jobAddTicket: (a) => R({ skidId: a[1], ticket: '777', litho: 6.5, jobId: a[0], sheetsRun: 100 }),
  }));
  await enterLitho(page, 'Worker');
  await page.click('#openJobsBtn'); await page.waitForTimeout(250);
  await page.click('[data-resume="JOB-000004"]'); await page.waitForTimeout(300);
  const items = await page.$$eval('#jobCoatingsList li', (ls) => ls.map((l) => l.textContent));
  ok('worker: job coatings listed', items.length === 2 && items[0].includes('SIZE') && items[1].includes('VARNISH') && items[0].includes('10-OUT'), items);
  ok('worker: no "Add a coating" section', !(await page.$('#jobAddCoatBtn')) && !(await page.textContent('#view')).includes('Add a coating'));
  ok('worker: can add a ticket', !!(await page.$('#jobTicketSearch')));
  ok('worker: name pre-filled', (await page.$eval('#jobTicketOperator', (el) => el.value)) === 'Worker');
  ok('worker: no mention of Review Jobs', !(await page.textContent('#view')).includes('Review Jobs'));
  ok('worker: no ticket list until they scan/type', !(await page.$('#jobQueuePicker [data-pick]')) && (await page.textContent('#jobQueuePicker')).includes('Scan or type'));
  await page.fill('#jobTicketSearch', '777'); await page.waitForTimeout(200);
  await page.click('#jobQueuePicker [data-pick]');
  await page.waitForSelector('#addTicketToJobBtn');
  await page.click('#addTicketToJobBtn'); await page.waitForTimeout(300);
  const ja = calls.filter((c) => c.fn === 'jobAddTicket');
  ok('worker: ticket added to the job', ja.length === 1 && ja[0].args[0] === 'JOB-000004' && ja[0].args[5] === 'Worker', ja.map((c) => c.args));
  await page.click('#finishJobBtn'); await page.waitForTimeout(200);
  ok('worker: Done returns to the worker home', !!(await page.$('#openJobsBtn')));

  // Manager opening the same job still gets the recipe editor
  await page.click('#lithoSwitchBtn'); await page.waitForTimeout(100);
  await page.selectOption('#lithoUserSelect', { label: 'Alex' });
  await page.click('#lithoLoginBtn'); await page.waitForTimeout(300);
  await page.evaluate(() => resumeJob('JOB-000004')); await page.waitForTimeout(300);
  ok('manager: coatings listed too', (await page.$$('#jobCoatingsList li')).length === 2);
  ok('manager: can still add a coating', !!(await page.$('#jobAddCoatBtn')));
  ok('manager: picker still lists tickets', !!(await page.$('#jobQueuePicker [data-pick]')));
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
  await page.close();
}

// ---- 17. Move To WIP: name the job, pick what was done, scan tickets, move them all at once
{ const tickets = [ticket('SKD-1', '501', 'Current'), ticket('SKD-2', '502', 'Current'), ticket('SKD-3', '503', 'WIP'),
    ticket('SKD-4', '504', 'Pending'), ticket('SKD-5', '505', 'Used')];
  let fails = 1;
  const { page, calls } = await boot(Object.assign({}, base, {
    getAllTickets: () => R(tickets),
    moveToWip: (a) => (fails-- > 0 ? { ok: false, error: 'Sheets API 500' }
      : R({ ok: true, jobId: 'JOB-000009', moved: a[3].map((id) => ({ skidId: id })), skipped: [] })),
  }));
  await page.click('#tileLitho'); await page.waitForTimeout(100);
  ok('Litho Department offers Litho Line and Move To WIP', !!(await page.$('#tileLithoLine')) && !!(await page.$('#tileMoveWip')));
  ok('the chooser loads nothing', calls.filter((c) => c.fn === 'getAllTickets').length === 0);
  ok('Litho Line greyed out and not clickable', await page.$eval('#tileLithoLine', (b) => b.disabled) && (await page.textContent('#view')).includes('coming soon'));
  await page.click('#tileLithoLine', { force: true }); await page.waitForTimeout(100);
  ok('tapping Litho Line does nothing', !(await page.$('#lithoUserSelect')) && !!(await page.$('#tileMoveWip')));
  await page.click('#tileMoveWip'); await page.waitForTimeout(300);
  ok('Move To WIP screen', !!(await page.$('#mwJobName')) && !!(await page.$('#mwAddInput')) && !!(await page.$('#mwGroup')));
  ok('no sheet count or spoilage fields', !(await page.$('#mwListBox input')) && !/spoilage/i.test(await page.$eval('#view', (v) => Array.from(v.querySelectorAll('label')).map((l) => l.textContent).join('|'))));
  ok('cursor starts in the job name', await page.evaluate(() => document.activeElement && document.activeElement.id === 'mwJobName'));
  await page.click('#mwMoveBtn', { force: true }); await page.waitForTimeout(100);
  ok('Move is disabled with nothing on the list', calls.filter((c) => c.fn === 'moveToWip').length === 0);

  await page.fill('#mwJobName', 'Acme Cans');
  ok('no name field', !(await page.$('#mwOperator')));
  await page.selectOption('#mwGroup', '603X408'); await page.waitForTimeout(50);
  await page.selectOption('#mwSub', '10-OUT'); await page.waitForTimeout(50);
  await page.selectOption('#mwItem', 'SIZE');
  await page.click('#mwAddCoatBtn');
  await page.selectOption('#mwItem', 'VARNISH');   // left in the picker: still counts
  ok('coating listed with the per-ticket cost', (await page.textContent('#mwCoatingList')).includes('SIZE') && (await page.textContent('#mwCoatingList')).includes('$2.50'));

  await page.fill('#mwAddInput', '501'); await page.press('#mwAddInput', 'Enter'); await page.waitForTimeout(100);
  await page.fill('#mwAddInput', 'SKD-2'); await page.press('#mwAddInput', 'Enter'); await page.waitForTimeout(100);
  await page.fill('#mwAddInput', '503'); await page.waitForTimeout(100);
  ok('WIP ticket offered as another pass', (await page.textContent('#mwPicker')).includes('another pass'));
  await page.click('#mwPicker [data-mwadd]'); await page.waitForTimeout(100);
  await page.fill('#mwAddInput', '504'); await page.press('#mwAddInput', 'Enter'); await page.waitForTimeout(900);
  await page.fill('#mwAddInput', '505'); await page.press('#mwAddInput', 'Enter'); await page.waitForTimeout(900);
  await page.fill('#mwAddInput', '501'); await page.press('#mwAddInput', 'Enter'); await page.waitForTimeout(100);
  ok('three on the list (Pending/Used refused, no duplicate)', (await page.$$('#mwListBox [data-mwrem]')).length === 3, await page.textContent('#mwListBox'));
  ok('input cleared and focused after a scan', await page.evaluate(() => document.activeElement.id === 'mwAddInput' && document.activeElement.value === '501' || document.activeElement.value === ''));
  ok('button counts the tickets', (await page.textContent('#mwMoveBtn')).includes('Move 3 to WIP'));

  await page.click('#mwMoveBtn'); await page.waitForSelector('#modalOk');
  ok('confirm names the job and the coatings', ((await page.textContent('#modalRoot')) || '').includes('Acme Cans') && (await page.textContent('#modalRoot')).includes('SIZE + VARNISH') && (await page.textContent('#modalRoot')).includes('$6.50'));
  await page.click('#modalOk'); await page.waitForTimeout(400);
  ok('failure explained, list kept', ((await page.textContent('#modalRoot')) || '').includes('Tap Move to WIP again') && (await page.$$('#mwListBox [data-mwrem]')).length === 3);
  await page.click('#modalOk'); await page.waitForTimeout(100);
  await page.click('#mwMoveBtn'); await page.waitForSelector('#modalOk');
  await page.click('#modalOk'); await page.waitForTimeout(400);
  const mv = calls.filter((c) => c.fn === 'moveToWip');
  ok('one request per tap, all tickets in it', mv.length === 2 && JSON.stringify(mv[1].args[3]) === JSON.stringify(['SKD-1', 'SKD-2', 'SKD-3']), mv.map((c) => c.args[3]));
  ok('sends job name and both coatings, no name', mv[1].args[0] === 'Acme Cans' && mv[1].args[1] === '' && mv[1].args[2].map((c) => c.item).join() === 'SIZE,VARNISH', mv[1].args);
  ok('retry after a failure reuses the same opId', mv[0].args[4] === mv[1].args[4], [mv[0].args[4], mv[1].args[4]]);
  ok('success message', ((await page.textContent('#modalRoot')) || '').includes('3 tickets moved to WIP'));
  ok('moved tickets now WIP in the local list', await page.evaluate(() => allCache.filter((t) => ['SKD-1', 'SKD-2'].indexOf(t.skidId) !== -1).every((t) => t.status === 'WIP')));
  await page.click('#modalOk'); await page.waitForTimeout(200);
  ok('list and job cleared for the next batch', (await page.$$('#mwListBox [data-mwrem]')).length === 0 && (await page.$eval('#mwJobName', (el) => el.value)) === '');
  await page.click('#backBtn'); await page.waitForTimeout(100);
  ok('Back returns to the Litho Department chooser', !!(await page.$('#tileMoveWip')));
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
  await page.close();
}

// ---- 18. Reports: rows open to a full product trace; trace box filters; CSV download
{ const coat = (item, chem) => ({ item, chemCode: chem, group: '603X408', sub: '10-OUT', date: '2026-09-29', by: 'Ann' });
  const litho = { skidId: 'SKD-1', ticket: '100231', date: '2026-09-29', by: 'Ann', litho: 6.5, customer: 'Acme Cans', jobId: 'JOB-000009',
    mill: 'M-111', supplier: 'US Steel', endUse: '603X408', bw: '75', testedBw: '75.2', type: 'T', temper: 'T4', width: '32', length: '30', qty: 1000, weight: 5000,
    status: 'WIP', coatings: [coat('SIZE', 'CH1'), coat('VARNISH', 'CH2')], coatedOn: '2026-09-29', coatedBy: 'Ann', usedOn: '', comments: NASTY };
  const other = Object.assign({}, litho, { skidId: 'SKD-2', ticket: '100232', customer: 'Beta Foods', mill: 'M-222', coatings: [coat('WHITE', 'CH9')] });
  const pallet = { date: '2026-09-30', loadNo: '12', machine: 'S1', by: 'Ann', output: 40, unit: 'Body Blanks', from: '100231 [mill M-111] (40)', skidId: 'SKD-9',
    cost: 0, litho: 0, sources: [Object.assign({}, litho, { used: 40 })] };
  const { page, calls } = await boot(Object.assign({}, base, {
    getDepartmentReport: () => R({ start: '2000-01-01', end: '2026-09-30', dept: 'all', sections: [
      { key: 'litho', label: 'Litho — skids coated', rows: [litho, other] },
      { key: 'slitter', label: 'Slitter — pallets made', rows: [pallet] }] }),
  }));
  await page.evaluate(() => openReports()); await page.waitForTimeout(100);
  await page.click('#reportAll');
  ok('All time sets a wide range', (await page.$eval('#reportFrom', (e) => e.value)) === '2000-01-01');
  await page.click('#runReportBtn'); await page.waitForTimeout(300);
  let txt = await page.textContent('#reportSections');
  ok('row shows customer, mill and coatings with chem codes', txt.includes('Acme Cans') && txt.includes('M-111') && txt.includes('SIZE (CH1), VARNISH (CH2)'));
  ok('detail hidden until tapped', !(await page.$('.trace-detail')));
  await page.click('[data-rrow="0-0"]'); await page.waitForTimeout(100);
  const det = await page.textContent('.trace-detail');
  ok('trace detail: supplier, mill, tested BW, each coating, job', det.includes('US Steel') && det.includes('Mill M-111') && det.includes('tested 75.2') && det.includes('chem CH2') && det.includes('JOB-000009'), det);
  ok('sheet data shown as text, not run', await page.evaluate(() => window.__xss === undefined) && det.includes('<img src=x'));
  await page.click('[data-rrow="1-0"]'); await page.waitForTimeout(100);
  ok('cut pallet opens to its source skids with their trace', (await page.$$('.trace-detail')).length === 2 && (await page.textContent('#reportSections')).includes('Cut from 1 source'));
  await page.fill('#reportTrace', 'ch9'); await page.waitForTimeout(100);
  txt = await page.textContent('#reportSections');
  ok('trace box finds a chem code', txt.includes('100232') && !txt.includes('Acme Cans') && (await page.textContent('#reportTraceCount')).includes('1 of 3'), await page.textContent('#reportTraceCount'));
  await page.fill('#reportTrace', 'M-111'); await page.waitForTimeout(100);
  ok('trace box finds a mill, including pallets cut from it', (await page.textContent('#reportTraceCount')).includes('2 of 3'));
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#reportCsvBtn')]);
  const fs = await import('fs');
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  const lines = csv.trim().split(/\r\n/);
  ok('CSV: header + the 2 matching rows', lines.length === 3 && lines[0].startsWith('Section,Date,Ticket') && dl.suggestedFilename().endsWith('.csv'), lines.length);
  ok('CSV: chem codes and customer in the row', lines[1].includes('CH1; CH2') && lines[1].includes('Acme Cans'), lines[1]);
  ok('CSV: pallet row carries its source mill and chem codes', lines[2].includes('M-111') && lines[2].includes('CH1'), lines[2]);
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
  await page.close();
}

// ---- 19. Move To WIP: a WIP ticket opens to its coatings; marked removals go with the move
{ const coats = [{ passNumber: 1, group: '603X408', sub: '10-OUT', item: 'SIZE', chemCode: 'C1', cost: 2.5 },
    { passNumber: 2, group: '603X408', sub: '10-OUT', item: 'VARNISH', chemCode: 'C2', cost: 4 }];
  const { page, calls } = await boot(Object.assign({}, base, {
    getAllTickets: () => R([ticket('SKD-1', '501', 'Current'), ticket('SKD-3', '503', 'WIP')]),
    getTicketCard: (a) => R({ skidId: a[0], ticket: '503', status: 'WIP', litho: 6.5, coatings: coats.slice() }),
    moveToWip: (a) => R({ ok: true, jobId: 'JOB-000010', moved: a[3].map((id) => ({ skidId: id, removed: id === 'SKD-3' ? ['VARNISH'] : [] })), skipped: [] }),
  }));
  await page.click('#tileLitho'); await page.click('#tileMoveWip'); await page.waitForTimeout(300);
  for (const t of ['501', '503']) { await page.fill('#mwAddInput', t); await page.press('#mwAddInput', 'Enter'); await page.waitForTimeout(100); }
  ok('only the WIP ticket gets a coatings drop-down', (await page.$$('[data-mwcoats]')).length === 1);
  ok('coatings not loaded until opened', calls.filter((c) => c.fn === 'getTicketCard').length === 0);
  await page.click('[data-mwcoats="SKD-3"]'); await page.waitForTimeout(200);
  let txt = await page.textContent('#mwListBox');
  ok('drop-down lists what is on the ticket now', txt.includes('SIZE') && txt.includes('VARNISH') && txt.includes('chem C2') && txt.includes('$6.50'), txt);
  await page.click('[data-mwcoats="SKD-3"]'); await page.waitForTimeout(100);
  ok('drop-down closes', !(await page.textContent('#mwListBox')).includes('VARNISH'));
  await page.click('[data-mwcoats="SKD-3"]'); await page.waitForTimeout(100);
  ok('reopening does not reload', calls.filter((c) => c.fn === 'getTicketCard').length === 1);
  await page.click('[data-mwvoid="SKD-3"][data-pass="2"]'); await page.waitForTimeout(100);
  txt = await page.textContent('#mwListBox');
  ok('marking a coating saves nothing yet', calls.filter((c) => c.fn === 'removeTicketCoating' || c.fn === 'moveToWip').length === 0);
  ok('marked coat shows it comes off at Move, with the new cost', txt.includes('comes off at Move') && txt.includes('after removals: $2.50') && txt.includes('1 to remove'), txt);
  await page.click('[data-mwvoid="SKD-3"][data-pass="2"]'); await page.waitForTimeout(100);
  ok('Undo clears the mark', !(await page.textContent('#mwListBox')).includes('comes off at Move'));
  await page.click('[data-mwvoid="SKD-3"][data-pass="1"]'); await page.waitForTimeout(100);
  // Taking the ticket off the list drops its marks; adding it back starts clean.
  await page.click('[data-mwrem="SKD-3"]'); await page.waitForTimeout(100);
  await page.fill('#mwAddInput', '503'); await page.press('#mwAddInput', 'Enter'); await page.waitForTimeout(100);
  await page.click('[data-mwcoats="SKD-3"]'); await page.waitForTimeout(150);
  ok('removing the ticket from the list drops its marks', !(await page.textContent('#mwListBox')).includes('comes off at Move'));
  await page.click('[data-mwvoid="SKD-3"][data-pass="2"]'); await page.waitForTimeout(100);
  await page.fill('#mwJobName', 'Acme');
  await page.selectOption('#mwGroup', '603X408'); await page.waitForTimeout(50);
  await page.selectOption('#mwSub', '10-OUT'); await page.waitForTimeout(50);
  await page.selectOption('#mwItem', 'SIZE');
  await page.click('#mwMoveBtn'); await page.waitForSelector('#modalOk');
  ok('confirm lists the removal', ((await page.textContent('#modalRoot')) || '').includes('Also takes off 1 coating: VARNISH from 503'));
  await page.click('#modalOk'); await page.waitForTimeout(300);
  const mv = calls.filter((c) => c.fn === 'moveToWip');
  ok('removals go with the move, in one request', mv.length === 1 && JSON.stringify(mv[0].args[5]) === JSON.stringify({ 'SKD-3': [2] }), mv.map((c) => c.args[5]));
  ok('no separate removal request', calls.filter((c) => c.fn === 'removeTicketCoating').length === 0);
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
  await page.close();
}

// ---- 20. Database Master sheet: mark status changes and coating removals, save all at once
{ const sheet = [
    { skidId: 'SKD-1', ticket: '501', status: 'WIP', litho: 6.5, mill: 'M-1', customer: 'Acme', jobId: 'JOB-1', coatings: [
      { passNumber: 1, item: 'SIZE', group: '603X408', sub: '10-OUT', chemCode: 'C1', cost: 2.5, date: '2026-09-29' },
      { passNumber: 2, item: 'VARNISH', group: '603X408', sub: '10-OUT', chemCode: 'C2', cost: 4, date: '2026-09-29' }] },
    { skidId: 'SKD-2', ticket: '502', status: 'Current', litho: 0, mill: 'M-2', customer: '', coatings: [] },
    { skidId: 'SKD-3', ticket: '503', status: 'Used', litho: 0, mill: 'M-3', customer: '', usedOn: '2026-09-01', coatings: [] },
    { skidId: 'SKD-4', ticket: '504', status: 'Pending', litho: 2.5, jobId: 'JOB-7', coatings: [] }];
  let saves = 0;
  const { page, calls } = await boot(Object.assign({}, base, {
    getMasterSheet: () => R({ rows: JSON.parse(JSON.stringify(sheet)) }),
    masterEdit: (a) => (saves++ === 0 ? { ok: false, error: 'Sheets API 500' } : R({ ok: true, saved: a[0].map((c) => ({ skidId: c.skidId, status: c.status || c.from })), skipped: [] })),
  }));
  await page.evaluate(() => { dbUnlocked = true; openDatabase(); }); await page.waitForTimeout(300);
  ok('Database opens on the Master sheet', !!(await page.$('#msList')) && calls.filter((c) => c.fn === 'getMasterSheet').length === 1 && calls.filter((c) => c.fn === 'getRawTable').length === 0);
  ok('lists the tickets', (await page.textContent('#msList')).includes('501') && (await page.textContent('#msList')).includes('504'));
  ok('Pending is read-only', !(await page.$('[data-msst="SKD-4"]')) && (await page.textContent('#msList')).includes('Review Jobs'));
  ok('no save bar before changes', await page.$eval('#msBar', (b) => b.style.display === 'none'));
  await page.selectOption('[data-msst="SKD-2"]', 'Used'); await page.waitForTimeout(100);
  await page.selectOption('[data-msst="SKD-3"]', 'WIP'); await page.waitForTimeout(100);
  await page.click('[data-mscoats="SKD-1"]'); await page.waitForTimeout(100);
  await page.click('[data-msvoid="SKD-1"][data-pass="2"]'); await page.waitForTimeout(100);
  ok('nothing saved while marking', calls.filter((c) => c.fn === 'masterEdit').length === 0);
  ok('save bar counts 3 changed tickets', (await page.textContent('#msBarText')).includes('3 tickets changed'));
  ok('marked row shows new cost and change', (await page.textContent('#msList')).includes('$6.50 → $2.50') && (await page.textContent('#msList')).includes('Current → Used'));
  await page.selectOption('[data-msst="SKD-3"]', 'Used'); await page.waitForTimeout(100);
  ok('setting a status back un-marks it', (await page.textContent('#msBarText')).includes('2 tickets changed'));
  await page.fill('#msSearch', 'M-2'); await page.waitForTimeout(100);
  ok('search narrows the list', (await page.textContent('#msList')).includes('502') && !(await page.textContent('#msList')).includes('504'));
  await page.fill('#msSearch', ''); await page.waitForTimeout(100);
  await page.click('#msSaveBtn'); await page.waitForSelector('#modalOk');
  ok('confirm lists every change', ((await page.textContent('#modalRoot')) || '').includes('501: remove VARNISH') && (await page.textContent('#modalRoot')).includes('502: Current → Used'));
  await page.click('#modalOk'); await page.waitForTimeout(300);
  ok('failure keeps the marks', ((await page.textContent('#modalRoot')) || '').includes('Your marks are kept') && (await page.textContent('#msBarText')).includes('2 tickets'));
  await page.click('#modalOk'); await page.waitForTimeout(100);
  await page.click('#msSaveBtn'); await page.waitForSelector('#modalOk'); await page.click('#modalOk'); await page.waitForTimeout(400);
  const me = calls.filter((c) => c.fn === 'masterEdit');
  ok('one request with every change', me.length === 2 && me[1].args[0].length === 2
    && me[1].args[0].some((c) => c.skidId === 'SKD-1' && JSON.stringify(c.removePasses) === '[2]' && !c.status)
    && me[1].args[0].some((c) => c.skidId === 'SKD-2' && c.status === 'Used' && c.from === 'Current'), me.map((c) => c.args[0]));
  ok('retry reuses the opId', me[0].args[2] === me[1].args[2]);
  ok('saved: marks cleared and sheet reloaded', ((await page.textContent('#modalRoot')) || '').includes('2 tickets updated') && calls.filter((c) => c.fn === 'getMasterSheet').length === 2);
  await page.click('#modalOk'); await page.waitForTimeout(100);
  ok('save bar hidden after saving', await page.$eval('#msBar', (b) => b.style.display === 'none'));
  await page.click('[data-dbt="steel"]'); await page.waitForTimeout(200);
  ok('Steel Tickets raw table still there', calls.filter((c) => c.fn === 'getRawTable').length === 1);
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
  await page.close();
}

// ---- 21. Ticket history panel: from Reports and the Database; links between pieces; CSV
{ const hist = (id) => ({
    skid: { skidId: id, ticket: id === 'SKD-1' ? '501' : '501-LR1', status: 'Used', litho: 2.5, row: '', customer: 'Acme', jobId: 'JOB-1', mill: 'M-1',
      supplier: 'US Steel', coatings: [{ item: 'SIZE', chemCode: 'C1', group: '603X408', sub: '10-OUT', date: '2026-09-29', by: 'Foreman' }], usedOn: '2026-09-30', comments: NASTY },
    events: [
      { when: '2026-09-30', date: '2026-09-30', kind: 'event', what: 'USED IN PRODUCTION (DIRECT)', by: '', notes: 'Marked Used', cost: 0 },
      { when: '2026-09-29 10:00:00', kind: 'void', what: 'COATING REMOVED (VOID)', by: 'Foreman', notes: 'VOID#2: removed VARNISH (4.00)', cost: -4, running: 2.5 },
      { when: '2026-09-29 08:00:00', kind: 'coat', what: 'Coated: VARNISH', chemCode: 'C2', cost: 4, running: 6.5, by: 'Foreman', jobName: 'Acme', voided: true },
      { when: '2026-09-29 08:00:00', kind: 'coat', what: 'Coated: SIZE', chemCode: 'C1', cost: 2.5, running: 2.5, by: 'Foreman', jobName: 'Acme', voided: false }],
    parent: null, children: id === 'SKD-1' ? [{ skidId: 'SKD-9', ticket: '501-LR1', status: 'Current', qty: 200 }] : [], loads: [],
    family: { base: '501', members: [] } });
  const litho = { skidId: 'SKD-1', ticket: '501', date: '2026-09-29', by: 'Foreman', litho: 2.5, customer: 'Acme', mill: 'M-1', coatings: [] };
  const { page, calls } = await boot(Object.assign({}, base, {
    getDepartmentReport: () => R({ start: '2026-09-29', end: '2026-09-29', dept: 'litho', sections: [{ key: 'litho', label: 'Litho', rows: [litho] }] }),
    getSkidHistory: (a) => R(hist(a[0])),
    getMasterSheet: () => R({ rows: [{ skidId: 'SKD-1', ticket: '501', status: 'Used', litho: 2.5, coatings: [] }] }),
    getRawTable: () => R({ headers: ['Ticket', 'Skid ID', 'Status'], rows: [{ __row: 2, 'Ticket': '501', 'Skid ID': 'SKD-1', 'Status': 'Used' }] }),
  }));
  await page.evaluate(() => openReports()); await page.waitForTimeout(100);
  await page.click('#runReportBtn'); await page.waitForTimeout(300);
  await page.click('#reportSections a[data-hist="SKD-1"]'); await page.waitForTimeout(300);
  ok('tapping the ticket in a report opens its history', !!(await page.$('#histRoot')) && calls.filter((c) => c.fn === 'getSkidHistory').length === 1);
  ok('...without toggling the row open', !(await page.$('.trace-detail')));
  let txt = await page.textContent('#histRoot');
  ok('history: summary, timeline events, newest first', txt.includes('Ticket 501') && txt.includes('USED IN PRODUCTION') && txt.indexOf('USED IN PRODUCTION') < txt.indexOf('Coated: SIZE'), txt.slice(0, 200));
  ok('removed coat shown struck through', txt.includes('(removed later)') && txt.includes('COATING REMOVED'));
  ok('sheet data shown as text', await page.evaluate(() => window.__xss === undefined) && txt.includes('<img src=x'));
  await page.click('#histRoot [data-hist="SKD-9"]'); await page.waitForTimeout(300);
  ok('opens a piece made from it, with Back', (await page.textContent('#histRoot')).includes('501-LR1') && !!(await page.$('#histBack')));
  await page.click('#histBack'); await page.waitForTimeout(300);
  ok('Back returns to the first ticket', (await page.textContent('#histRoot h3')).includes('Ticket 501 '));
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#histCsv')]);
  const fs = await import('fs');
  const csv = fs.readFileSync(await dl.path(), 'utf8').trim().split(/\r\n/);
  ok('history CSV: header + 4 events', csv.length === 5 && csv[0].startsWith('When,What') && csv.some((l) => l.includes('Coated: VARNISH') && l.endsWith('yes')), csv);
  await page.click('#histClose'); await page.waitForTimeout(100);
  ok('Close returns to the report as it was', !(await page.$('#histRoot')) && !!(await page.$('#reportSections')));
  // Report row trace -> Full history button
  await page.click('[data-rrow="0-0"]'); await page.waitForTimeout(100);
  await page.click('.trace-detail [data-hist="SKD-1"]'); await page.waitForTimeout(300);
  ok('trace detail has a Full history button', !!(await page.$('#histRoot')));
  await page.click('#histClose'); await page.waitForTimeout(100);
  // Database: Master sheet and raw Steel Tickets editor
  await page.evaluate(() => { dbUnlocked = true; openDatabase(); }); await page.waitForTimeout(300);
  await page.click('#msList [data-hist="SKD-1"]'); await page.waitForTimeout(300);
  ok('Master sheet row opens history', !!(await page.$('#histRoot')));
  await page.click('#histClose'); await page.waitForTimeout(100);
  await page.click('[data-dbt="steel"]'); await page.waitForTimeout(300);
  await page.click('#dbTableBox tbody tr'); await page.waitForTimeout(200);
  await page.click('[data-hist="SKD-1"]'); await page.waitForTimeout(300);
  ok('Steel Tickets row editor opens history', !!(await page.$('#histRoot')));
  await page.click('#histClose'); await page.waitForTimeout(100);
  ok('still in the row editor after closing', await page.evaluate(() => state.view === 'databaseEdit'));
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
  await page.close();
}

// ---- 22. Receivers: create one, attach tickets by range / PO, take one off, see it from a ticket
{ const db = { receivers: [], tickets: [
    { skidId: 'SKD-1', ticket: '100126-001', status: 'Current', mill: '26HCE20004', po: '7974-DC', supplier: 'TCC', qty: 900, receiver: '', via: '', viaFrom: '' },
    { skidId: 'SKD-2', ticket: '100126-002', status: 'Used', mill: '26HCE20005', po: '7974-DC', supplier: 'TCC', qty: 900, receiver: '', via: '', viaFrom: '' },
    { skidId: 'SKD-3', ticket: '100126-003', status: 'WIP', mill: '26HCD20179', po: '7973-DC', supplier: 'TCC', qty: 900, receiver: 'R-00007', via: '', viaFrom: '' },
    { skidId: 'SKD-4', ticket: '093026-010', status: 'Current', mill: 'M-9', po: '8780-DC', supplier: 'REY', qty: 500, receiver: '', via: '', viaFrom: '' },
    { skidId: 'SKD-5', ticket: '100126-001-LR1', status: 'Current', mill: '26HCE20004', po: '7974-DC', supplier: 'TCC', qty: 100, receiver: '', via: '', viaFrom: '' }], suppliers: ['TCC', 'REY'] };
  db.receivers.push({ id: 'R-00007', name: '26-09-30--REY--R-00007', date: '2026-09-30', supplier: 'REY', pos: '8780-DC', link: '', notes: '', ticketCount: 1 });
  const out = () => { const c = {}; db.tickets.forEach((t) => { if (t.receiver) c[t.receiver] = (c[t.receiver] || 0) + 1; });
    return JSON.parse(JSON.stringify({ receivers: db.receivers.map((r) => Object.assign({}, r, { ticketCount: c[r.id] || 0 })), suppliers: db.suppliers, tickets: db.tickets })); };
  let saves = 0;
  const { page, calls } = await boot(Object.assign({}, base, {
    getMasterSheet: () => R({ rows: [], receivers: [] }),
    getReceivers: () => R(out()),
    saveReceiver: (a) => {
      const r = a[0];
      if (r.id) { const x = db.receivers.filter((y) => y.id === r.id)[0]; Object.assign(x, r, { name: r.date.slice(2) + '--' + r.supplier.toUpperCase() + '--' + r.id }); return R(x); }
      const id = 'R-0000' + (db.receivers.length + 7);
      const x = { id, name: (r.date ? r.date.slice(2) : 'NO-DATE') + '--' + r.supplier.toUpperCase().trim() + '--' + id, date: r.date, supplier: r.supplier.toUpperCase().trim(), pos: r.pos, link: r.link, notes: r.notes };
      db.receivers.push(x); return R(Object.assign({ created: true }, x));
    },
    masterEdit: (a) => {
      if (saves++ === 0) return { ok: false, error: 'Sheets API 503' };
      a[0].forEach((c) => { db.tickets.filter((t) => t.skidId === c.skidId)[0].receiver = c.receiver; });
      return R({ ok: true, saved: a[0].map((c) => ({ skidId: c.skidId, receiver: c.receiver })), skipped: [] });
    },
    getSkidHistory: (a) => R({ skid: { skidId: a[0], ticket: '100126-001', status: 'Current', litho: 0, po: '7974-DC', receiver: 'R-00008', receiverName: '26-10-01--TCC--R-00008',
      receiverLink: 'https://drive.google.com/file/d/xyz/view', receiverFrom: '', coatings: [] }, events: [{ when: '2026-10-01 09:00:00', kind: 'event', what: 'RECEIVER SET', notes: '26-10-01--TCC--R-00008', cost: 0 }],
      parent: null, children: [], loads: [], family: { base: '100126-001', members: [] } }),
  }));
  await page.evaluate(() => { dbUnlocked = true; openDatabase(); }); await page.waitForTimeout(300);
  await page.click('[data-dbt="receivers"]'); await page.waitForTimeout(300);
  ok('Receivers tab lists receivers', (await page.textContent('#rcvList')).includes('26-09-30--REY--R-00007') && (await page.textContent('#rcvList')).includes('1 ticket'));
  await page.click('#rcvNew'); await page.waitForTimeout(100);
  await page.fill('#rcvDate', '2026-10-01');
  await page.fill('#rcvSupplier', 'tcc');
  ok('file name previews as you type', (await page.textContent('#rcvName')) === '26-10-01--TCC--R-?????', await page.textContent('#rcvName'));
  await page.fill('#rcvPos', '7974-DC, 7976-DC');
  await page.click('#rcvSave'); await page.waitForTimeout(400);
  const sr = calls.filter((c) => c.fn === 'saveReceiver');
  ok('create sends the details', sr.length === 1 && sr[0].args[0].supplier === 'tcc' && sr[0].args[0].date === '2026-10-01' && !sr[0].args[0].id, sr.map((c) => c.args[0]));
  ok('opens the new receiver with its number', (await page.textContent('#rcvBox')).includes('R-00008') && (await page.textContent('#rcvName')) === '26-10-01--TCC--R-00008');
  ok('no tickets yet', (await page.textContent('#rcvTickets')).includes('None yet'));
  ok('asks for a range before listing tickets', (await page.textContent('#rcvCands')).includes('Enter a ticket range'));
  await page.fill('#rcvFrom', '100126-001'); await page.fill('#rcvTo', '100126-003'); await page.waitForTimeout(100);
  let cands = await page.textContent('#rcvCands');
  ok('range finds tickets (and the -LR1 piece), hides ones already on a receiver', cands.includes('100126-001') && cands.includes('100126-002') && cands.includes('100126-001-LR1') && !cands.includes('100126-003') && !cands.includes('093026-010'), cands);
  await page.click('#rcvOnlyNone'); await page.waitForTimeout(100);
  ok('unticking shows tickets on other receivers too', (await page.textContent('#rcvCands')).includes('on R-00007'));
  await page.click('#rcvOnlyNone'); await page.waitForTimeout(100);
  await page.click('#rcvAll'); await page.waitForTimeout(100);
  ok('add all marks them, nothing saved yet', (await page.textContent('#rcvBarText')).includes('3 to add') && !calls.some((c) => c.fn === 'masterEdit'));
  await page.click('#rcvTickets [data-rcvadd="SKD-5"]'); await page.waitForTimeout(100);
  ok('undo one', (await page.textContent('#rcvBarText')).includes('2 to add'));
  await page.fill('#rcvFrom', ''); await page.fill('#rcvTo', ''); await page.fill('#rcvPo', '8780'); await page.waitForTimeout(100);
  ok('PO search', (await page.textContent('#rcvCands')).includes('093026-010') && !(await page.textContent('#rcvCands')).includes('100126-002'));
  await page.click('#rcvSaveTickets'); await page.waitForSelector('#modalOk'); await page.click('#modalOk'); await page.waitForTimeout(300);
  ok('failure keeps the marks', ((await page.textContent('#modalRoot')) || '').includes('Your marks are kept') && (await page.textContent('#rcvBarText')).includes('2 to add'));
  await page.click('#modalOk'); await page.waitForTimeout(100);
  await page.click('#rcvSaveTickets'); await page.waitForSelector('#modalOk'); await page.click('#modalOk'); await page.waitForTimeout(400);
  const me = calls.filter((c) => c.fn === 'masterEdit');
  ok('one request, receiver on each change, retry reuses the opId', me.length === 2 && me[1].args[0].length === 2 && me[1].args[0].every((c) => c.receiver === 'R-00008') && me[0].args[2] === me[1].args[2], me.map((c) => c.args));
  await page.click('#modalOk'); await page.waitForTimeout(100);
  let tk = await page.textContent('#rcvTickets');
  ok('tickets now listed on it', tk.includes('100126-001') && tk.includes('100126-002') && tk.includes('· 2'), tk);
  await page.click('#rcvTickets [data-rcvdrop="SKD-2"]'); await page.waitForTimeout(100);
  await page.click('#rcvSaveTickets'); await page.waitForSelector('#modalOk'); await page.click('#modalOk'); await page.waitForTimeout(400);
  ok('take off sends receiver ""', calls.filter((c) => c.fn === 'masterEdit').slice(-1)[0].args[0][0].receiver === '' && db.tickets[1].receiver === '');
  await page.click('#modalOk'); await page.waitForTimeout(100);
  // From a ticket's history: receiver line, Open file, receiver view with its tickets
  await page.evaluate(() => openSkidHistory('SKD-1')); await page.waitForTimeout(300);
  let h = await page.textContent('#histRoot');
  ok('history shows PO and receiver', h.includes('PO 7974-DC') && h.includes('26-10-01--TCC--R-00008') && h.includes('RECEIVER SET'));
  ok('Open file uses the saved link', await page.$eval('#histRoot a[href*="drive.google.com/file"]', (a) => a.target === '_blank'));
  await page.click('#histRoot a[data-hist="rcv:R-00008"]'); await page.waitForTimeout(300);
  h = await page.textContent('#histRoot');
  ok('tapping the receiver lists its tickets', h.includes('Receiver 26-10-01--TCC--R-00008') && h.includes('100126-001') && h.includes('7974-DC, 7976-DC') && !!(await page.$('#histBack')));
  ok('no link: Drive search for the number', await page.evaluate(() => rcvFileBtn('R-00007', '').includes('drive/search?q=%22R-00007%22')));
  await page.click('#histClose'); await page.waitForTimeout(100);
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
  await page.close();
}

// ---- 23. Master sheet: change one ticket's receiver
{ const { page, calls } = await boot(Object.assign({}, base, {
    getMasterSheet: () => R({ rows: [{ skidId: 'SKD-1', ticket: '501', status: 'Used', litho: 0, po: '7974-DC', receiver: 'R-00001', receiverOwn: 'R-00001', receiverName: '26-10-01--TCC--R-00001', coatings: [] },
      { skidId: 'SKD-2', ticket: '501-LR1', status: 'Current', litho: 0, receiver: 'R-00001', receiverOwn: '', receiverName: '26-10-01--TCC--R-00001', receiverFrom: '501', coatings: [] }],
      receivers: [{ id: 'R-00001', name: '26-10-01--TCC--R-00001' }, { id: 'R-00002', name: '26-10-02--CMD--R-00002' }] }),
    masterEdit: (a) => R({ ok: true, saved: a[0].map((c) => ({ skidId: c.skidId, status: c.from, receiver: c.receiver })), skipped: [] }),
  }));
  await page.evaluate(() => { dbUnlocked = true; openDatabase(); }); await page.waitForTimeout(300);
  let txt = await page.textContent('#msList');
  ok('rows show PO and receiver (and where an inherited one came from)', txt.includes('PO 7974-DC') && txt.includes('26-10-01--TCC--R-00001') && txt.includes('(from 501)'), txt);
  await page.click('[data-msrcvedit="SKD-1"]'); await page.waitForTimeout(100);
  await page.selectOption('[data-msrcv="SKD-1"]', 'R-00002'); await page.waitForTimeout(100);
  ok('marked, not saved', (await page.textContent('#msBarText')).includes('1 ticket changed') && (await page.textContent('#msList')).includes('R-00001 → R-00002'));
  await page.click('#msSaveBtn'); await page.waitForSelector('#modalOk');
  ok('confirm names the new receiver', (await page.textContent('#modalRoot')).includes('501: receiver R-00002'));
  await page.click('#modalOk'); await page.waitForTimeout(300);
  const me = calls.filter((c) => c.fn === 'masterEdit');
  ok('saved with receiver only (no status change)', me.length === 1 && me[0].args[0][0].receiver === 'R-00002' && !me[0].args[0][0].status, me.map((c) => c.args[0]));
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
  await page.close();
}

await browser.close();
console.log((fail ? '✗' : '✓') + ' ui_test: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
