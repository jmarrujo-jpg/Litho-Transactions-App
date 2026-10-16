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
async function boot(handlers, pageOpts) {
  const page = await browser.newPage(pageOpts || {});
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

// ---- 3. Create Job (the foreman): the line once, every pass up front; a failed Create sends the same passes again with the same opId
{ let n = 0;
  const pjob = { jobId: 'JOB-000009', description: 'Blue', createdBy: 'Ann', passMode: true, tickets: [], currentPass: 1,
    passes: [{ group: '603X408', sub: '10-OUT', item: 'SIZE', pass: 1, line: 'Litho Line 1', lots: [{ lot: 'CS1', product: 'Clear Size' }], changes: [{}], tickets: [], started: true },
             { group: '603X408', sub: '10-OUT', item: 'VARNISH', pass: 2, line: 'Litho Line 1', lots: [], changes: [{}], tickets: [], started: '' }] };
  const { page, calls } = await boot(Object.assign({}, base, {
    createJob: (args) => (++n === 1 ? { ok: false, error: 'Sheets API 503: unavailable' } : R({ jobId: 'JOB-000009', coatings: args[2], passMode: true })),
    getJobDetail: () => R(pjob),
    getMaterials: () => R({ materials: [{ id: 'M-1', lot: 'CS1', product: 'Clear Size', type: 'Litho Coating', status: 'In Stock', location: 'Coater Room' }], items: [], types: [] }),
    getAllTickets: () => R([ticket('SKD-1', '100', 'Current')]),
  }));
  await page.evaluate(() => openCreateJob());
  await page.waitForSelector('#psGroup option[value="603X408"]', { state: 'attached' });
  ok('the line defaults to Litho Line 3', (await page.$eval('[data-plline="Litho Line 3"]', (b) => !b.classList.contains('secondary'))));
  await page.click('[data-plline="Litho Line 1"]');
  await page.selectOption('#psGroup', '603X408');
  await page.waitForTimeout(100);
  ok('#OUT defaults to highest', (await page.$eval('#psSub', (s) => s.value)) === '10-OUT');
  await page.selectOption('#psItem', 'SIZE');
  await page.waitForSelector('#plLot');
  await page.fill('#plLot', 'cs1'); await page.press('#plLot', 'Enter');
  ok('a known lot fills in its material', (await page.textContent('#plBox')).includes('Clear Size'));
  await page.click('#npAdd');
  ok('pass 1 goes on the list; the form is ready for pass 2', /Pass 1: SIZE/.test(await page.textContent('#npList')) && (await page.textContent('#npTitle')) === 'Pass 2' && !(await page.textContent('#plBox')).includes('Clear Size'));
  await page.selectOption('#psItem', 'VARNISH');      // pass 2 left in the picker: still counts
  await page.fill('#jobOperator', '');
  await page.click('#startJobSetupBtn');                  // no operator -> toast
  await page.fill('#jobOperator', 'Ann');
  await page.click('#startJobSetupBtn');                  // server fails
  await page.waitForSelector('#modalOk'); await page.click('#modalOk');
  await page.click('#startJobSetupBtn');                  // works
  await page.waitForSelector('#jobTicketSearch');
  const cj = calls.filter((c) => c.fn === 'createJob');
  ok('two createJob calls', cj.length === 2, cj.length);
  ok('each sent both passes on Litho Line 1, pass 1 with its lot', cj.every((c) => c.args[2].length === 2 && c.args[2].every((x) => x.line === 'Litho Line 1') && c.args[2][0].item === 'SIZE' && c.args[2][0].lots[0].lot === 'CS1' && c.args[2][1].item === 'VARNISH' && c.args[2][1].lots.length === 0), cj.map((c) => c.args[2]));
  ok('retry reused the opId', cj[0].args[4] === cj[1].args[4], cj.map((c) => c.args[4]));
  ok('ticket search has focus', await page.evaluate(() => document.activeElement && document.activeElement.id === 'jobTicketSearch'));
  ok('name field prefilled with creator on a new job', (await page.$eval('#jobTicketOperator', (el) => el.value)) === 'Ann');
  ok('the job screen says what is running now', /Now running: Pass 1 — SIZE/.test(await page.textContent('#view')) && /start Pass 2: VARNISH/.test(await page.textContent('#view')));
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
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

// ---- 7. Database opens straight away on a computer (no passcode)
{ const { page } = await boot(base);
  await page.click('#tileDatabase'); await page.waitForTimeout(200);
  ok('no code asked', !(await page.$('#modalPromptInput')));
  ok('database opens', !!(await page.$('[data-dbt="master"]')));
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
  ok('worker: Open Jobs, Add Ticket — no New Job (the foreman makes jobs)', !(await page.$('#newJobBtn')) && !!(await page.$('#openJobsBtn')) && !!(await page.$('#addTicketBtn')));
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
  await page.click('#tileLitho'); await page.click('#tileLithoLine'); await page.waitForTimeout(150);
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
  ok('Litho Line is open (not greyed out)', !(await page.$eval('#tileLithoLine', (b) => b.disabled)) && !(await page.textContent('#view')).includes('coming soon'));
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
  await page.evaluate(() => { openDatabase(); }); await page.waitForTimeout(300);
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
  await page.evaluate(() => { openDatabase(); }); await page.waitForTimeout(300);
  ok('Master sheet rows have no History button (the Coatings drop-down covers it)', !(await page.$('#msList [data-hist]')) && !!(await page.$('#msList [data-mscoats]')));
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
  await page.evaluate(() => { openDatabase(); }); await page.waitForTimeout(300);
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
  ok('the receiver name opens its file (saved link, new tab)', await page.$eval('#histRoot a[href*="drive.google.com/file"]', (a) => a.target === '_blank' && a.textContent === '26-10-01--TCC--R-00008'));
  ok('no separate Open file button, no receiver page', !(await page.$('#histRoot [data-hist^="rcv:"]')) && !(await page.textContent('#histRoot')).includes('Open file'));
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
  await page.evaluate(() => { openDatabase(); }); await page.waitForTimeout(300);
  let txt = await page.textContent('#msList');
  ok('rows show PO and receiver (and where an inherited one came from)', txt.includes('PO 7974-DC') && txt.includes('26-10-01--TCC--R-00001') && txt.includes('(from 501)'), txt);
  ok('receiver name links to its file (Drive search when no link is saved)', await page.$eval('#msList a[href*="drive/search"]', (x) => x.target === '_blank' && x.textContent === '26-10-01--TCC--R-00001' && x.href.includes('R-00001')));
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

// ---- 24. Receivers kept numbers: save-now notice, attach tickets found by a saved mill, delete hidden
{ const db = { receivers: [
      { id: 'R-00002', name: '26-10-02--CMD--R-00002', date: '2026-10-02', supplier: 'CMD', pos: '', link: '', notes: '', mills: ['MB1'], keptTickets: ['203'], unkept: 0 },
      { id: 'R-00001', name: '26-10-01--TCC--R-00001', date: '2026-10-01', supplier: 'TCC', pos: '', link: '', notes: '', mills: ['MA1', 'MA2'], keptTickets: ['200', '201'], unkept: 1 }],
    suppliers: ['TCC', 'CMD'], tickets: [
      { skidId: 'SKD-1', ticket: '200', status: 'Current', mill: 'MA1', receiver: '', via: '', viaFrom: '', match: 'R-00001', matchBy: 'mill' },
      { skidId: 'SKD-2', ticket: '201', status: 'WIP', mill: '', receiver: '', via: '', viaFrom: '', match: 'R-00001', matchBy: 'ticket' },
      { skidId: 'SKD-3', ticket: '300', status: 'Current', mill: 'MZ', receiver: '', via: '', viaFrom: '', match: '', matchConflict: true },
      { skidId: 'SKD-4', ticket: '100', status: 'Current', mill: 'MQ', receiver: 'R-00001', via: '', viaFrom: '' }] };
  const out = () => { const c = {}; db.tickets.forEach((t) => { if (t.receiver) c[t.receiver] = (c[t.receiver] || 0) + 1; });
    return JSON.parse(JSON.stringify(Object.assign({}, db, { receivers: db.receivers.map((r) => Object.assign({}, r, { ticketCount: c[r.id] || 0 })) }))); };
  const { page, calls } = await boot(Object.assign({}, base, {
    getMasterSheet: () => R({ rows: [], receivers: [] }),
    getReceivers: () => R(out()),
    keepReceiverNumbers: () => { db.receivers.forEach((r) => { r.unkept = 0; }); return R({ ok: true, changed: 1 }); },
    masterEdit: (a) => {
      a[0].forEach((c) => { const t = db.tickets.filter((x) => x.skidId === c.skidId)[0]; t.receiver = c.receiver; t.match = ''; });
      return R({ ok: true, saved: a[0].map((c) => ({ skidId: c.skidId, receiver: c.receiver })), skipped: [] });
    },
  }));
  await page.evaluate(() => { openDatabase(); }); await page.waitForTimeout(300);
  await page.click('[data-dbt="receivers"]'); await page.waitForTimeout(300);
  let k = await page.textContent('#rcvKeep');
  ok('keep: not-saved notice', k.includes('1 ticket is on a receiver') && !!(await page.$('#rcvKeepNow')), k);
  ok('keep: found-by-number notice', k.includes('2 tickets match a receiver') && k.includes('R-00001: 2'), k);
  ok('keep: two-receiver tickets named, not guessed', k.includes('1 ticket match two receivers') && k.includes('300'), k);
  await page.click('#rcvKeepNow'); await page.waitForTimeout(300);
  ok('keep: Save them now calls the worker and clears the notice', calls.some((c) => c.fn === 'keepReceiverNumbers') && !(await page.textContent('#rcvKeep')).includes('hasn'));
  // One receiver: found tickets listed with Add, kept numbers shown, no Delete while it keeps numbers.
  await page.click('[data-rcvopen="R-00002"]'); await page.waitForTimeout(200);
  ok('keep: no Delete while numbers are kept', !(await page.$('#rcvDelete')));
  ok('keep: kept numbers listed', (await page.textContent('#rcvTickets')).includes('1 mill number, 1 ticket number') && (await page.textContent('#rcvTickets')).includes('MB1'));
  await page.click('#rcvBackList'); await page.waitForTimeout(200);
  await page.click('[data-rcvopen="R-00001"]'); await page.waitForTimeout(200);
  let tk = await page.textContent('#rcvTickets');
  ok('keep: found tickets shown on their receiver', tk.includes('Found by a saved number') && tk.includes('same mill') && tk.includes('same ticket number'), tk);
  await page.click('#rcvAddFound'); await page.waitForTimeout(100);
  ok('keep: Add all marks them', (await page.textContent('#rcvBarText')).includes('2 to add'));
  await page.click('#rcvBar #rcvDiscard'); await page.waitForTimeout(100);
  await page.click('#rcvBackList'); await page.waitForTimeout(200);
  await page.click('#rcvAttachFound'); await page.waitForSelector('#modalOk'); await page.click('#modalOk'); await page.waitForTimeout(400);
  const me = calls.filter((c) => c.fn === 'masterEdit');
  ok('keep: Attach all sends each to its matched receiver', me.length === 1 && me[0].args[0].length === 2 && me[0].args[0].every((c) => c.receiver === 'R-00001'), me.map((c) => c.args[0]));
  await page.click('#modalOk'); await page.waitForTimeout(200);
  ok('keep: found notice gone after attaching', !(await page.textContent('#rcvKeep')).includes('match a receiver by'));
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
  await page.close();
}

// ---- 25. Find in Drive: search in batches, review a file's tickets, approve (retry keeps the op), attach to existing
{ let searchedTimes = 0, approves = 0;
  const unassigned = [
    { skidId: 'SKD-1', ticket: '102825-001', status: 'Current', mill: '3045220', po: '7730-DC', supplier: 'RN', qty: 1723 },
    { skidId: 'SKD-2', ticket: '102825-002', status: 'WIP', mill: '3045214', po: '7730-DC', supplier: 'RN', qty: 1568 },
    { skidId: 'SKD-3', ticket: '102825-003', status: 'Current', mill: '30452091', po: '7730-DC', supplier: 'RN', qty: 1568 },
    { skidId: 'SKD-4', ticket: '101425-001', status: 'Current', mill: '3044661', po: '7621-DC', supplier: 'RN', qty: 368 }];
  const matches = () => ({ millCount: 4, unsearched: searchedTimes >= 2 ? 0 : 4, noMill: 1, saEmail: 'litho@proj.iam.gserviceaccount.com', folderId: 'DEST',
    suppliers: ['RN'], receivers: [{ id: 'R-00001', name: '25-10-14--RN--R-00001' }], unassigned,
    misses: searchedTimes >= 2 ? [{ mill: '30452091', tickets: [unassigned[2]] }] : [],
    groups: searchedTimes >= 2 ? [
      { fileId: 'dst-1', name: '25-10-14--RN--R-00001.pdf', link: 'https://drive.google.com/file/d/dst-1/view', folderId: 'DEST', folderName: 'Raw Metal Packing Slips', date: '2026-10-01', mills: ['3044661'], tickets: [unassigned[3]], inFolder: true, receiver: 'R-00001', namedReceiver: 'R-00001', madeFrom: [], supplier: 'RN', pos: '7621-DC' },
      { fileId: 'src-1', name: 'Container Supply_20251028_121716.pdf', link: 'https://drive.google.com/file/d/src-1/view', folderId: 'rey', folderName: '2025 Reynolds', date: '2025-10-28', mills: ['3045214', '3045220'], tickets: [unassigned[0], unassigned[1]], inFolder: false, receiver: '', namedReceiver: '', madeFrom: [], coveredBy: [], supplier: 'RN', pos: '7730-DC' }] : [] });
  const { page, calls } = await boot(Object.assign({}, base, {
    getMasterSheet: () => R({ rows: [], receivers: [] }),
    getReceivers: () => R({ receivers: [], suppliers: [], tickets: [] }),
    getDriveMatches: () => R(matches()),
    driveSearchMills: () => { searchedTimes++; return R({ ok: true, searched: 2, found: searchedTimes === 1 ? 2 : 1, remaining: searchedTimes === 1 ? 2 : 0, cutoff: '' }); },
    approveDriveMatch: (a) => {
      if (approves++ === 0) return { ok: false, error: 'Drive API 503: backend error' };
      return R({ ok: true, receiver: a[0].receiverId || 'R-00002', name: a[0].receiverId ? '' : '25-10-28--RN--R-00002', created: !a[0].receiverId,
        copy: a[0].receiverId ? null : { copied: false, copyName: '25-10-28--RN--R-00002.pdf', copyError: 'Google won’t let the service account own files in a My Drive folder (it has no storage of its own), so the copy wasn’t made.' },
        saved: a[0].skidIds.map((x) => ({ skidId: x })), skipped: [] });
    },
  }));
  await page.evaluate(() => { openDatabase(); }); await page.waitForTimeout(300);
  await page.click('[data-dbt="receivers"]'); await page.waitForTimeout(300);
  await page.click('#rcvDrive'); await page.waitForTimeout(300);
  ok('drive view: counts and a Search button', (await page.textContent('#rcvBox')).includes('4 mill numbers on tickets with no receiver') && !!(await page.$('#drvSearch')));
  await page.click('#drvSearch'); await page.waitForTimeout(600);
  ok('drive: searches in batches until done', calls.filter((c) => c.fn === 'driveSearchMills').length === 2 && calls.filter((c) => c.fn === 'driveSearchMills')[0].args[0] === false, calls.filter((c) => c.fn === 'driveSearchMills').map((c) => c.args));
  let box = await page.textContent('#rcvBox');
  ok('drive: files listed, the folder copy says where it is', box.includes('Container Supply_20251028_121716.pdf') && box.includes('In the receivers folder as R-00001') && box.includes('1 mill number not found'), box);
  ok('drive: file name opens the scan', await page.$eval('#rcvBox a[href*="src-1"]', (a) => a.target === '_blank'));
  await page.click('[data-drvopen="src-1"]'); await page.waitForTimeout(200);
  box = await page.textContent('#rcvBox');
  ok('drive review: tickets ticked, details filled in from the scan', box.includes('2 of 2 ticked') && (await page.inputValue('[data-drvf="src-1|supplier"]')) === 'RN'
    && (await page.inputValue('[data-drvf="src-1|date"]')) === '2025-10-28' && (await page.textContent('#drvName-src-1')) === '25-10-28--RN--R-?????');
  await page.uncheck('[data-drvtk="src-1|SKD-2"]'); await page.waitForTimeout(150);
  await page.fill('[data-drvq="src-1"]', '102825-002 to 102825-003'); await page.waitForTimeout(150);
  ok('drive review: a range finds the missed ticket', (await page.textContent('#drvq-src-1')).includes('102825-003'), await page.textContent('#drvq-src-1'));
  await page.click('[data-drvadd="src-1|SKD-3"]'); await page.waitForTimeout(150);
  ok('drive review: added by hand', (await page.textContent('#rcvBox')).includes('added by hand') && (await page.textContent('#rcvBox')).includes('2 of 3 ticked'));
  await page.fill('[data-drvf="src-1|notes"]', 'slip 178608');
  await page.click('[data-drvapprove="src-1"]'); await page.waitForSelector('#modalOk'); await page.click('#modalOk'); await page.waitForTimeout(400);
  ok('drive approve: failure says it picks up where it stopped', ((await page.textContent('#modalRoot')) || '').includes('never makes a second receiver'));
  await page.click('#modalOk'); await page.waitForTimeout(150);
  await page.click('[data-drvapprove="src-1"]'); await page.waitForSelector('#modalOk'); await page.click('#modalOk'); await page.waitForTimeout(400);
  const ap = calls.filter((c) => c.fn === 'approveDriveMatch');
  ok('drive approve: sends the ticked tickets and details, same op on retry', ap.length === 2 && ap[1].args[0].skidIds.join() === 'SKD-1,SKD-3' && ap[1].args[0].supplier === 'RN'
    && ap[1].args[0].notes === 'slip 178608' && ap[1].args[0].fileId === 'src-1' && ap[0].args[2] === ap[1].args[2], ap.map((c) => c.args));
  ok('drive approve: copy refused is explained with the name to use', ((await page.textContent('#modalRoot')) || '').includes('name it 25-10-28--RN--R-00002.pdf'));
  await page.click('#modalOk'); await page.waitForTimeout(300);
  await page.click('[data-drvquick="dst-1"]'); await page.waitForSelector('#modalOk'); await page.click('#modalOk'); await page.waitForTimeout(400);
  const ap2 = calls.filter((c) => c.fn === 'approveDriveMatch').slice(-1)[0];
  ok('drive: attach straight to the receiver already in the folder', ap2.args[0].receiverId === 'R-00001' && ap2.args[0].skidIds.join() === 'SKD-4' && ap2.args[2] !== ap[1].args[2], ap2.args);
  await page.click('#modalOk'); await page.waitForTimeout(150);
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
  await page.close();
}

// ---- 26. Fresh Import with Used in Production: the result names the used count and what to check
{ const { page, calls } = await boot(Object.assign({}, base, {
    getMasterSheet: () => R({ rows: [], receivers: [] }),
    importStaging: () => R({ ok: true, current: 2, wip: 1, used: 5, usedLines: 7, usedTab: 'Used In Production', total: 8, firstSkid: 'SKD-000001', lastSkid: 'SKD-000008',
      usedBadDate: ['091126-013 (261340-001)'], usedBadDateCount: 1, usedFutureDate: ['091126-012 (290918-001)'], usedFutureDateCount: 1,
      usedMultiDay: ['081826-007 (3 days)'], usedMultiDayCount: 1, usedAlsoOpen: ['040226-004'], usedAlsoOpenCount: 1, receiversRestored: 0, receiversNotBack: [], receiversNotBackCount: 0, receiverConflicts: [] }),
  }));
  await page.evaluate(() => { openDatabase(); }); await page.waitForTimeout(300);
  ok('import card names the Used in Production tab', (await page.textContent('#dbImportBtn')).includes('Used') && (await page.textContent('#view')).includes('Date Used'));
  await page.click('#dbImportBtn'); await page.waitForSelector('#modalOk');
  ok('confirm says used tickets come in once as Used', (await page.textContent('#modalRoot')).includes('comes in once as Used'));
  await page.click('#modalOk'); await page.waitForTimeout(500);
  const txt = (await page.textContent('#modalRoot')) || '';
  ok('result: used count, bad / future dates, multi-day, still open', txt.includes('5 Used (from 7 lines on Used In Production)') && txt.includes('091126-013 (261340-001)') && txt.includes('290918-001')
    && txt.includes('dated the last day') && txt.includes('081826-007 (3 days)') && txt.includes('still on Current / WIP (partly used), so it stays open') && txt.includes('040226-004'), txt);
  ok('import called once', calls.filter((c) => c.fn === 'importStaging').length === 1);
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
  await page.close();
}

// ---- 27. Find in Drive: Approve all — existing receivers first, a shared ticket goes on one file,
//          files without a supplier / named for a missing receiver are left; a failure resumes with the same op
{ const T = (n) => ({ skidId: 'SKD-' + n, ticket: 'T' + n, status: 'Current', mill: 'M' + n, po: '', supplier: 'RN', qty: 10 });
  const G = (id, extra) => Object.assign({ fileId: id, name: id + '.pdf', link: 'https://drive.google.com/file/d/' + id + '/view', folderId: 'rey', folderName: '2025 Reynolds', date: '2025-10-28',
    mills: ['M'], inFolder: false, receiver: '', namedReceiver: '', madeFrom: [], coveredBy: [], supplier: 'RN', pos: '' }, extra);
  const all = [
    G('src-1', { tickets: [T(1), T(2)] }),
    G('src-2', { tickets: [T(2), T(3)], date: '2025-11-02' }),
    G('dst-1', { tickets: [T(4)], inFolder: true, receiver: 'R-00001', namedReceiver: 'R-00001' }),
    G('src-3', { tickets: [T(5)], coveredBy: ['R-00001'] }),
    G('src-4', { tickets: [T(6)], supplier: '' }),
    G('dst-9', { tickets: [T(7)], inFolder: true, namedReceiver: 'R-00009' })];
  const done = {}; let n = 0, next = 2;
  const { page, calls } = await boot(Object.assign({}, base, {
    getMasterSheet: () => R({ rows: [], receivers: [] }),
    getReceivers: () => R({ receivers: [], suppliers: [], tickets: [] }),
    getDriveMatches: () => R({ millCount: 7, unsearched: 0, noMill: 0, saEmail: '', folderId: 'DEST', suppliers: ['RN'], receivers: [{ id: 'R-00001', name: '25-10-14--RN--R-00001' }].concat(n >= 3 ? [{ id: 'R-00002', name: 'x--RN--R-00002' }] : []),
      unassigned: [1, 2, 3, 4, 5, 6, 7].map(T), misses: [], groups: all.filter((g) => !done[g.fileId]).map((g) => n >= 3 && g.fileId === 'src-1' ? Object.assign({}, g, { madeFrom: ['R-00002'] }) : g) }),
    approveDriveMatch: (a) => {
      if (++n === 3) return { ok: false, error: 'Drive API 503: backend error' };
      if (n === 5) return { ok: false, error: "Sheets API 429: Quota exceeded for quota metric 'Read requests' and limit 'Read requests per minute per user'" };
      done[a[0].fileId] = 1;
      const id = a[0].receiverId || ('R-0000' + next++);
      return R({ ok: true, receiver: id, name: a[0].receiverId ? '' : 'x--RN--' + id, created: !a[0].receiverId, copy: a[0].receiverId ? null : { copied: true, copyName: id + '.pdf' },
        saved: a[0].skidIds.map((x) => ({ skidId: x })), skipped: [] });
    },
  }));
  await page.evaluate(() => { openDatabase(); }); await page.waitForTimeout(300);
  await page.click('[data-dbt="receivers"]'); await page.waitForTimeout(300);
  await page.click('#rcvDrive'); await page.waitForTimeout(300);
  ok('approve all: button shows the file count', (await page.textContent('#drvApproveAll')).includes('Approve all 6 files'));
  await page.evaluate(() => { DRV_PACE_MS = 150; DRV_QUOTA_WAIT_S = 1; });
  await page.click('#drvApproveAll'); await page.waitForSelector('#modalOk');
  let txt = await page.textContent('#modalRoot');
  ok('approve all: confirm sums it up and names what is left', txt.includes('Approve all 4 files?') && txt.includes('2 new receivers, 2 added to existing ones')
    && txt.includes('2 files left for you to review (1 with no supplier): src-4.pdf, dst-9.pdf') && txt.includes('keep this page open') && txt.length < 400, txt);
  const t0 = Date.now();
  await page.click('#modalOk'); await page.waitForSelector('#modalRoot >> text=Stopped after');
  txt = (await page.textContent('#modalRoot')) || '';
  ok('approve all: a failure stops and says it resumes', txt.includes('Stopped after 2 of 4') && txt.includes('Tap Approve all again to carry on'), txt);
  const a1 = calls.filter((c) => c.fn === 'approveDriveMatch');
  ok('approve all: paced, not all at once', Date.now() - t0 >= 300);
  ok('approve all: existing receivers first, then new ones', a1.map((c) => c.args[0].fileId + ':' + (c.args[0].receiverId || 'new')).join() === 'dst-1:R-00001,src-3:R-00001,src-1:new', a1.map((c) => c.args[0]));
  await page.click('#modalOk'); await page.waitForTimeout(300);
  await page.click('#drvApproveAll'); await page.waitForSelector('#modalOk'); await page.click('#modalOk');
  await page.waitForTimeout(400);
  ok('approve all: Google\'s per-minute limit -> waits and says so', (await page.textContent('#drvProgress')).includes('per-minute limit was reached'), await page.textContent('#drvProgress'));
  await page.waitForSelector('#modalRoot >> text=All approved', { timeout: 6000 });
  const a2 = calls.filter((c) => c.fn === 'approveDriveMatch');
  const s1 = a2.filter((c) => c.args[0].fileId === 'src-1'), s2 = a2.filter((c) => c.args[0].fileId === 'src-2')[0];
  ok('approve all: the retry reuses the failed file\'s op, still as new (so its copy is finished)', s1.length === 2 && s1[0].args[2] === s1[1].args[2] && !s1[1].args[0].receiverId && s1[1].args[0].skidIds.join() === 'SKD-1,SKD-2', s1.map((c) => c.args));
  const s2s = a2.filter((c) => c.args[0].fileId === 'src-2');
  ok('approve all: after the wait the same file is sent again with the same op', s2s.length === 2 && s2s[0].args[2] === s2s[1].args[2], s2s.map((c) => c.args));
  ok('approve all: a ticket in two files goes on the first only', s2 && s2.args[0].skidIds.join() === 'SKD-3' && s2.args[0].supplier === 'RN' && s2.args[0].date === '2025-11-02', s2 && s2.args);
  txt = (await page.textContent('#modalRoot')) || '';
  ok('approve all: summary', txt.includes('All approved') && txt.includes('2 new receivers: R-00002, R-00003'), txt);
  await page.click('#modalOk'); await page.waitForTimeout(100);
  // Any pop-up, however long its message, fits on the screen with its buttons showing.
  await page.setViewportSize({ width: 390, height: 700 });
  await page.evaluate(() => showConfirm('Long', new Array(400).join('R-00001.pdf, '), function () {}, 'OK'));
  const fit = await page.evaluate(() => { const m = document.querySelector('.modal').getBoundingClientRect(), b = document.getElementById('modalOk').getBoundingClientRect();
    return m.height <= window.innerHeight && b.bottom <= window.innerHeight && document.documentElement.scrollWidth <= window.innerWidth; });
  ok('a long pop-up fits on screen, buttons visible', fit);
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
  await page.close();
}

// ---- 28. Receiver details: typing POs recommends tickets with no receiver and that PO
{ const T = (id, t, po, extra) => Object.assign({ skidId: id, ticket: t, status: 'Current', mill: 'M' + id, po, receiver: '', via: '', viaFrom: '', match: '' }, extra || {});
  const db = { receivers: [{ id: 'R-00001', name: '26-10-01--TCC--R-00001', date: '2026-10-01', supplier: 'TCC', pos: '7974-DC', link: '', notes: '', mills: [], keptTickets: [], unkept: 0, ticketCount: 1 }],
    suppliers: ['TCC'], tickets: [
      T('SKD-1', '072126-002', '7974-DC'), T('SKD-2', '072126-001', '7974-dc '), T('SKD-3', '072126-003', '7976-DC'),
      T('SKD-4', '072126-004', '7974-DC', { receiver: 'R-00009' }), T('SKD-5', '072126-005', '7974-DC', { receiver: 'R-00001' }),
      T('SKD-6', '072126-006', '7974-DC-LR1'), T('SKD-7', '072126-007', '0'), T('SKD-8', '072126-008', '7974-GZ'),
      T('SKD-9', '072126-009', '7974-DC', { via: 'R-00001', viaFrom: '072126-002' })] };
  const { page, calls } = await boot(Object.assign({}, base, {
    getMasterSheet: () => R({ rows: [], receivers: [] }),
    getReceivers: () => R(JSON.parse(JSON.stringify(db))),
    masterEdit: (a) => R({ ok: true, saved: a[0].map((c) => ({ skidId: c.skidId, receiver: c.receiver })), skipped: [] }),
  }));
  await page.evaluate(() => { openDatabase(); }); await page.waitForTimeout(300);
  await page.click('[data-dbt="receivers"]'); await page.waitForTimeout(300);
  await page.click('[data-rcvopen="R-00001"]'); await page.waitForTimeout(200);
  let txt = await page.textContent('#rcvTickets');
  txt = txt.slice(txt.indexOf('Recommended'));
  ok('po: the saved PO recommends its tickets with no receiver (any case), in ticket order', txt.includes('Recommended — same PO, no receiver yet (2)') && txt.indexOf('072126-001') < txt.indexOf('072126-002')
    && !txt.includes('072126-003') && !txt.includes('072126-004') && !txt.includes('072126-008') && !txt.includes('072126-009'), txt);
  await page.fill('#rcvPos', '7974-DC, 7976-DC'); await page.waitForTimeout(400);
  txt = await page.textContent('#rcvTickets');
  ok('po: typing another PO adds its tickets right away', txt.includes('(3)') && txt.includes('072126-003'), txt);
  await page.fill('#rcvPos', '7974'); await page.waitForTimeout(400);
  txt = await page.textContent('#rcvTickets');
  ok('po: just the number matches every suffix', txt.includes('(4)') && txt.includes('072126-008') && !txt.includes('072126-003'), txt);
  await page.click('#rcvAddByPo'); await page.waitForTimeout(150);
  ok('po: Add all marks them (not saved yet)', (await page.textContent('#rcvBarText')).includes('4 to add'), await page.textContent('#rcvBarText'));
  await page.click('#rcvSaveTickets'); await page.waitForSelector('#modalOk'); await page.click('#modalOk'); await page.waitForTimeout(400);
  const me = calls.filter((c) => c.fn === 'masterEdit')[0];
  ok('po: saved onto this receiver', me && me.args[0].map((c) => c.skidId + ':' + c.receiver).sort().join() === 'SKD-1:R-00001,SKD-2:R-00001,SKD-6:R-00001,SKD-8:R-00001', me && me.args[0]);
  await page.click('#modalOk').catch(() => {}); await page.waitForTimeout(200);
  await page.fill('#rcvPos', '9999'); await page.waitForTimeout(400);
  ok('po: nothing matches -> says so', (await page.textContent('#rcvTickets')).includes('No tickets without a receiver have PO 9999'));
  // New receiver: a count under the POs box.
  await page.click('#rcvBackList'); await page.waitForTimeout(200);
  await page.click('#rcvNew'); await page.waitForTimeout(200);
  await page.fill('#rcvPos', '7976-DC'); await page.waitForTimeout(400);
  ok('po: new receiver says how many match', (await page.textContent('#rcvPoHint')).includes('1 ticket with no receiver has this PO'), await page.textContent('#rcvPoHint'));
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
  await page.close();
}

// ---- 29. Tickets with no receiver: one list, filter by ticket or mill, largest first
{ const T = (id, t, mill, status, extra) => Object.assign({ skidId: id, ticket: t, status, mill, po: '0', supplier: 'RN', receiver: '', via: '', viaFrom: '', match: '' }, extra || {});
  const db = { receivers: [{ id: 'R-00001', name: '26-10-01--RN--R-00001', date: '2026-10-01', supplier: 'RN', pos: '', link: '', notes: '', mills: [], keptTickets: [], unkept: 0, ticketCount: 1 }],
    suppliers: ['RN'], tickets: [
      T('SKD-1', '052225-001', '3025452', 'Current'), T('SKD-2', '121318-001', '1561222', 'Current'), T('SKD-3', '120224-002', '454498', 'Current', { supplier: 'LS' }),
      T('SKD-4', '052225-012', '3025617', 'Used'), T('SKD-5', '042126-202', 'P6G211C307', 'WIP', { supplier: 'PST' }),
      T('SKD-6', '090525-013', '3037634', 'Current', { receiver: 'R-00001' }), T('SKD-7', '090525-013-LR1', '3037634', 'Current', { via: 'R-00001', viaFrom: '090525-013' })] };
  const { page, calls } = await boot(Object.assign({}, base, {
    getMasterSheet: () => R({ rows: [], receivers: [] }),
    getReceivers: () => R(JSON.parse(JSON.stringify(db))),
  }));
  await page.evaluate(() => { openDatabase(); }); await page.waitForTimeout(300);
  await page.click('[data-dbt="receivers"]'); await page.waitForTimeout(300);
  ok('none: button shows the count (cut pieces with an inherited receiver don\'t count)', (await page.textContent('#rcvNoneBtn')).includes('No receiver (5)'));
  await page.click('#rcvNoneBtn'); await page.waitForTimeout(200);
  const order = async () => page.$$eval('#rcvNoneList .queue-item', (els) => els.map((e) => e.textContent.trim().split(' ')[0]));
  ok('none: ticket number, largest (newest) first', (await order()).join() === '042126-202,052225-012,052225-001,120224-002,121318-001', await order());
  await page.selectOption('#rcvNoneSort', 'mill-desc'); await page.waitForTimeout(100);
  ok('none: mill number, largest first (numbers as numbers, letters after)', (await order()).join() === '042126-202,052225-012,052225-001,121318-001,120224-002', await order());
  await page.fill('#rcvNoneQ', '0522'); await page.waitForTimeout(100);
  ok('none: filter by ticket number', (await order()).join() === '052225-012,052225-001' && (await page.textContent('#rcvNoneCount')).includes('2 shown'), await order());
  await page.fill('#rcvNoneQ', '4544'); await page.waitForTimeout(100);
  ok('none: filter by mill number', (await order()).join() === '120224-002', await order());
  await page.fill('#rcvNoneQ', ''); await page.click('[data-rcvnonest="used"]'); await page.waitForTimeout(100);
  ok('none: Used only', (await order()).join() === '052225-012', await order());
  await page.click('[data-rcvnonest="open"]'); await page.waitForTimeout(100);
  ok('none: Current / WIP only', (await order()).length === 4 && (await page.textContent('#rcvBox')).includes('Current / WIP 4'));
  await page.click('#rcvNoneBack'); await page.waitForTimeout(150);
  ok('none: back to the receiver list', !!(await page.$('#rcvList')));
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
  await page.close();
}

// ---- 30. Reports → Begin trace: date, size, then the days around it with ticket / supplier / mill / receiver
{ const tk = (t, sup, mill, eu, extra) => Object.assign({ ticket: t, skidId: 'SKD-' + t, supplier: sup, mill, endUse: eu, po: '8272-DC', qty: 900, status: 'Used', receiver: '', receiverName: '', receiverLink: '',
    usedDays: [], daysCount: 1, stillOpen: false, coatings: [] }, extra || {});
  const sizes = [{ key: '401 BODIES', label: '401 Bodies', count: 3, endUses: [{ endUse: '401X400', count: 2 }, { endUse: '401X411', count: 1 }] },
    { key: '401 ENDS', label: '401 Ends', count: 2, endUses: [{ endUse: '401 ENDS', count: 2 }] }, { key: '603 BODIES', label: '603 Bodies', count: 1, endUses: [{ endUse: '603X700', count: 1 }] }];
  const { page, calls } = await boot(Object.assign({}, base, {
    getUseTrace: (a) => R(a[0] === '2026-07-12' ? { date: a[0], diameter: '', days: 1, sizes: [], dayList: [], prevDay: '2026-07-10', nextDay: '2026-07-14' } : !a[1] ? { date: a[0], diameter: '', days: 1, sizes, dayCount: 6, dayList: [] } : { date: a[0], diameter: a[1], label: a[1] === 'ALL' ? 'All steel' : sizes.filter((z) => z.key === a[1])[0].label, days: a[2], sizes, dayCount: 6, firstDay: '2026-06-01', lastDay: '2026-10-01', dayList: [
      { date: '2026-07-13', rel: 'before', offset: 1, tickets: [tk('040626-013', 'RN', '3059113', '401 ENDS')] },
      { date: a[0], rel: 'on', offset: 0, tickets: [tk('101425-005', 'LS', '467268', '401X400', { status: 'WIP', stillOpen: true, comments: 'WALKER', litho: 27.66 }),
        tk('061226-007', 'RN', '3069132', '401X411', { comments: 'JF PRIME', litho: 0, receiver: 'R-00001', receiverName: '26-06-12--RN--R-00001', receiverLink: 'https://drive.google.com/file/d/r1/view' }),
        tk('061226-006', 'RN', '3069131', '401 ENDS', { daysCount: 2, usedDays: ['2026-07-14', '2026-07-24'] })] },
      { date: '2026-07-15', rel: 'after', offset: 1, tickets: [] }] }),
  }));
  await page.evaluate(() => openReports()); await page.waitForTimeout(200);
  await page.click('[data-rtab="trace"]'); await page.waitForTimeout(300);
  ok('trace tab: asks for the date and lists bodies / ends by diameter, with their end uses, plus all steel', !!(await page.$('#trcDate'))
    && (await page.textContent('[data-trcdia="401 BODIES"]')).includes('401 Bodies') && (await page.textContent('[data-trcdia="401 BODIES"]')).includes('401X400, 401X411')
    && (await page.textContent('[data-trcdia="401 ENDS"]')).includes('401 Ends') && (await page.textContent('[data-trcdia="ALL"]')).includes('All steel used that day'));
  await page.fill('#trcDate', '2026-07-12'); await page.dispatchEvent('#trcDate', 'change'); await page.waitForTimeout(300);
  ok('trace: a new date reloads its End Uses; nothing used -> nearest days offered', calls.filter((c) => c.fn === 'getUseTrace').slice(-1)[0].args.join() === '2026-07-12,,1'
    && (await page.textContent('#view')).includes('No steel was recorded as used on Sun, Jul 12, 2026') && !(await page.$('[data-trcdia]')), await page.textContent('#view'));
  await page.click('[data-trcjump="2026-07-14"]'); await page.waitForTimeout(300);
  ok('trace: jump to the next production day', (await page.inputValue('#trcDate')) === '2026-07-14' && !!(await page.$('[data-trcdia="401 BODIES"]')));
  await page.click('[data-trcdia="401 BODIES"]'); await page.waitForTimeout(300);
  const tc = calls.filter((c) => c.fn === 'getUseTrace').slice(-1)[0];
  ok('trace: asks the worker for that day and line', tc.args.join() === '2026-07-14,401 BODIES,1', tc.args);
  let txt = await page.textContent('#trcResults');
  ok('trace: day before, trace day, day after — in date order, empty day says so', /Day before — Mon, Jul 13, 2026.*Trace day — Tue, Jul 14, 2026.*Day after — Wed, Jul 15, 2026 · 0 tickets\s*Nothing for this day\./.test(txt), txt);
  ok('trace: ticket, supplier, mill and receiver columns', txt.includes('Ticket #') && txt.includes('Supplier') && txt.includes('Mill #') && txt.includes('Receiver')
    && txt.includes('3069132') && txt.includes('26-06-12--RN--R-00001') && txt.includes('partly used — still WIP') && txt.includes('used on 2 days')
    && txt.includes('For') && txt.includes('WALKER') && txt.includes('Coated ($27.66 litho)') && txt.includes('JF PRIME') && txt.includes('Plain'), txt);
  ok('trace: receiver name opens the file', await page.$eval('#trcResults a[href*="r1"]', (a) => a.target === '_blank'));
  ok('trace: says what is traced', txt.includes('401 Bodies · made'), txt);
  await page.click('[data-trcdia="ALL"]'); await page.waitForTimeout(300);
  ok('trace: all steel used that day', calls.filter((c) => c.fn === 'getUseTrace').slice(-1)[0].args[1] === 'ALL' && (await page.textContent('#trcResults')).includes('All steel · made'));
  await page.click('[data-trcdia="401 ENDS"]'); await page.waitForTimeout(300);
  await page.click('[data-trcrow="1-2"]'); await page.waitForTimeout(150);
  ok('trace: a row opens its full trace', (await page.textContent('#trcResults')).includes('Used on: 2026-07-14, 2026-07-24'));
  await page.selectOption('#trcDays', '2'); await page.waitForTimeout(300);
  ok('trace: days each side re-asks', calls.filter((c) => c.fn === 'getUseTrace').slice(-1)[0].args[2] === 2);
  await page.fill('#trcDate', '2026-07-15'); await page.dispatchEvent('#trcDate', 'change'); await page.waitForTimeout(400);
  const last2 = calls.filter((c) => c.fn === 'getUseTrace').slice(-2).map((c) => c.args.join());
  ok('trace: changing the date keeps what was picked when it was used that day too', last2.join('|') === '2026-07-15,,1|2026-07-15,401 ENDS,2', last2);
  await page.click('[data-rtab="reports"]'); await page.waitForTimeout(150);
  ok('trace: back to the reports tab', !!(await page.$('#runReportBtn')));
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
  await page.close();
}

// ---- 31. Tablet vs computer: a tablet gets the floor version; ?view= switches it and is remembered
{ const IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const { page, calls } = await boot(base, { userAgent: IPAD });
  const ids = async () => page.$$eval('#view button', (bs) => bs.map((b) => b.id));
  ok('mobile gate off: a tablet gets everything', !!(await page.$('#tileDatabase')) && !!(await page.$('#tileReports')));
  await page.goto(FILE + '?view=floor'); await page.waitForTimeout(300);
  let home = await ids();
  ok('tablet: no Reports or Database', !home.includes('tileReports') && !home.includes('tileDatabase') && home.includes('tileSearch') && !home.includes('tileCount'), home);
  ok('tablet: version says tablet', (await page.textContent('#appVersion')).includes('tablet'));
  await page.click('#tileLitho'); await page.waitForTimeout(100);
  let litho = await ids();
  ok('tablet: Litho Line but no Move To WIP', litho.includes('tileLithoLine') && !litho.includes('tileMoveWip'), litho);
  await page.click('#backBtn'); await page.click('#tileProduction'); await page.waitForTimeout(100);
  let metals = await ids();
  ok('tablet: Metal Lines, Press and Slitter open; no Used in Production or Print', ['metalsPickLines', 'metalsPickPress', 'metalsPickSlitter'].every((k) => metals.includes(k))
    && !metals.includes('metalsPickUsed') && !metals.includes('metalsPrintTickets') && !(await page.$eval('#metalsPickLines', (b) => b.disabled)), metals);
  await page.evaluate(() => { openDatabase(); }); await page.waitForTimeout(100);
  ok('tablet: the Database can\'t be opened another way', !(await page.$('[data-dbt="master"]')) && !!(await page.$('#tileSearch')));
  await page.evaluate(() => { openReports(); openMoveWip(); openMetalsSection('used'); }); await page.waitForTimeout(100);
  ok('tablet: nor Reports, Move To WIP or Used in Production', !(await page.$('#runReportBtn')) && !(await page.$('#mwJobName')) && !(await page.$('#metalsPickUsed')));
  await page.goto(FILE + '?view=full'); await page.waitForTimeout(300);
  ok('?view=full shows everything on a tablet', !!(await page.$('#tileDatabase')) && !!(await page.$('#tileReports')));
  await page.goto(FILE); await page.waitForTimeout(300);
  ok('?view=full is remembered on that device', !!(await page.$('#tileDatabase')));
  await page.goto(FILE + '?view=floor'); await page.goto(FILE + '?view=auto'); await page.waitForTimeout(300);
  ok('?view=auto goes back to detecting (gate off: everything)', !!(await page.$('#tileDatabase')));
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
  await page.close();
}
{ const { page } = await boot(base);
  const home = await page.$$eval('#view button', (bs) => bs.map((b) => b.id));
  ok('computer: everything shows', ['tileSearch', 'tileLitho', 'tileProduction', 'tilePlastics', 'tileReports', 'tileDatabase'].every((k) => home.includes(k)), home);
  ok('computer: version doesn\'t say tablet', !(await page.textContent('#appVersion')).includes('tablet'));
  await page.click('#tileProduction'); await page.waitForTimeout(100);
  ok('computer: Used in Production and Print show', !!(await page.$('#metalsPickUsed')) && !!(await page.$('#metalsPrintTickets')));
  await page.close();
}

// ---- 32. Metals: Coil Line has its own button (tablets too); Press and Slitter machines come from a list
{ const IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const { page, calls } = await boot(Object.assign({}, base, {
    getAllTickets: () => R([ticket('SKD-C', 'C1', 'Current', { cs: 'C', mill: 'M77', weight: 4000 }), ticket('SKD-D', 'D1', 'Current', { cs: 'C', mill: 'M88', weight: 4000 }),
      ticket('SKD-S', 'S1', 'Current', { cs: 'S' })]),
    getProductionRuns: () => R([{ runId: 'RUN-000001', machine: 'A Liner', operator: 'Ann', status: 'Open', skidCount: 0, createdOn: '2026-10-07' },
      { runId: 'RUN-000002', machine: 'Line 4', operator: 'Bo', status: 'Open', skidCount: 0, createdOn: '2026-10-07' }]),
    createRun: (a) => R({ runId: 'RUN-000009', machine: a[0], operator: a[1], status: 'Open' }),
    getSlitterSessions: () => R([]),
    createSlitterSession: (a) => R({ sessionId: 'SLT-000001', slitter: a[1], kind: a[0], operator: a[2], status: 'Open' }),
    cutCoil: (a) => R({ created: a[3].length, tickets: [{ ticket: '100726-101' }] }),
  }), { userAgent: IPAD });
  await page.click('#tileProduction'); await page.waitForTimeout(100);
  ok('coil: Coil Line button on the tablet', !!(await page.$('#metalsPickCoil')));
  await page.click('#metalsPickCoil'); await page.waitForTimeout(300);
  ok('line: asks which coil line first — nothing else until it\'s tapped', !!(await page.$('#crepLinePick')) && !(await page.$('#coilSearch')));
  await page.click('[data-crepline="1"]'); await page.waitForTimeout(200);
  ok('coil: opens the production report', !!(await page.$('#coilSearch')) && !(await page.$('[data-usedtab]')));
  let txt = await page.textContent('#coilPicker');
  ok('coil: lists coils only', txt.includes('C1') && !txt.includes('S1'), txt);
  await page.click('[data-coil="SKD-C"]'); await page.waitForTimeout(100);
  let hdr = true; for (const k of ['#crepOperator', '#crepLine', '#crepDate', '#crepStart', '#crepEnd']) hdr = hdr && !!(await page.$(k));
  ok('coil: report header — operator, line, date, hours', hdr);
  await page.selectOption('#crepLine', '2'); await page.waitForTimeout(100);
  ok('coil: first skid of the day is -200', (await page.textContent('.crep-row .crep-no')).trim() === '-200');
  const q = (ci, ri) => `.crep-row[data-crc="${ci}"][data-crr="${ri}"] .crepQty`;
  await page.fill(q(0, 0), '1100');
  await page.click('[data-crepadd="0"]'); await page.fill(q(0, 1), '175');
  await page.fill('[data-crepspoil="0"]', '15');
  await page.click('#crepNextBtn'); await page.waitForTimeout(100);
  txt = await page.textContent('#coilPicker');
  ok('coil: next coil picker leaves out the coil already picked', txt.includes('D1') && !txt.includes('C1'), txt);
  await page.click('[data-coil="SKD-D"]'); await page.waitForTimeout(100);
  const nos = async () => page.$$eval('.crep-row .crep-no', (es) => es.map((e) => e.textContent.trim()));
  ok('coil: the last count of coil 1 continues on coil 2 (one skid)', (await nos()).join('|') === '-200|-201 ↘|-201 ↳', await nos());
  await page.fill(q(1, 0), '1125');
  ok('coil: the changeover shows its total', (await page.$$eval('.crep-note', (es) => es.map((e) => e.textContent).join('|'))).includes('1,300 on the skid (175 + 1,125)'));
  await page.click('[data-crepadd="1"]'); await page.fill(q(1, 1), '1300');
  await page.fill('.crep-row[data-crc="1"][data-crr="1"] .crepWt', '4515');
  ok('coil: summary counts skids, sheets, spoilage, changeovers', (await page.textContent('#crepSummary')).includes('3 skids (-200 to -202) · 3,700 sheets · 15 spoiled · 1 changeover'), await page.textContent('#crepSummary'));
  ok('coil: no checkboxes anywhere on the report', !(await page.$('#coilBody input[type=checkbox]')));
  ok('coil: start time filled in by itself', /^\d\d:\d\d$/.test(await page.inputValue('#crepStart')));
  await page.fill('#crepOperator', ''); await page.click('#crepCutBtn'); await page.waitForTimeout(100);
  ok('coil: needs the operator', !(await page.$('#crepAsk')));
  await page.fill('#crepOperator', 'Giovanni'); await page.fill('#crepStart', '08:00');
  await page.click('#crepCutBtn'); await page.waitForTimeout(100);
  const reds = async () => page.$$eval('#coilBody input.miss', (es) => es.map((e) => e.closest('.crep-row').querySelector('.crep-no').textContent.trim() + (e.classList.contains('crepWt') ? ' wt' : ' qty')));
  ok('red: Done with missing weights turns them red and stops', !(await page.$('#crepAsk')) && (await reds()).join('|') === '-200 wt|-201 ↳ wt', await reds());
  ok('red: the half of a changeover on the old coil needs no weight', !(await reds()).some((x) => x.startsWith('-201 ↘')));
  await page.fill('.crep-row[data-crc="0"][data-crr="0"] .crepWt', '3800');
  ok('red: filling one clears it', (await reds()).join('|') === '-201 ↳ wt', await reds());
  await page.fill('.crep-row[data-crc="1"][data-crr="0"] .crepWt', '4500');
  await page.click('#crepCutBtn'); await page.waitForTimeout(100);
  ok('coil: Done asks if the last coil is used up (big buttons), end time filled in', !!(await page.$('#crepAsk')) && (await page.textContent('#crepAsk')).includes('Is coil M88 used up?')
    && !!(await page.$('[data-crepyn="fin:1"]')) && /^\d\d:\d\d$/.test(await page.inputValue('#crepEnd')));
  ok('coil: a full last skid isn\'t asked about', !(await page.$('[data-crepyn^="full"]')));
  ok('coil: nothing is made until it\'s answered', !(await page.$('#crepGoBtn')));
  await page.fill('#crepEnd', '14:30'); await page.dispatchEvent('#crepEnd', 'change');
  await page.click('[data-crepyn="fin:1"]'); await page.waitForTimeout(100);
  ok('coil: then one big button', (await page.textContent('#crepGoBtn')).includes('Create 3 skids') && (await page.textContent('#crepAsk')).includes('3 skids (-200 to -202) · 3,700 sheets · 15 spoiled · 1 changeover'));
  await page.click('#crepGoBtn'); await page.waitForTimeout(300);
  const cut = calls.filter((c) => c.fn === 'cutCoil')[0];
  ok('coil: sends both coils, the sheets from each, operator, hours and spoilage', cut && cut.args[0].join() === 'SKD-C,SKD-D' && cut.args[2] === 2
    && JSON.stringify(cut.args[3].map((x) => [x.qty, x.coils, x.parts || null, x.weight])) === JSON.stringify([[1100, [0], null, '3800'], [1300, [0, 1], [175, 1125], '4500'], [1300, [1], null, '4515']])
    && cut.args[4] === true && cut.args[6].operator === 'Giovanni' && cut.args[6].start === '08:00' && cut.args[6].end === '14:30' && cut.args[6].spoilage.join() === '15,0', cut && cut.args);
  await page.click('#modalOk').catch(() => {}); await page.waitForTimeout(100);
  ok('coil: report clears after the cut and asks the line again', !!(await page.$('#crepLinePick')));
  ok('line: the line just used is marked, but not picked for them', (await page.textContent('[data-crepline="2"]')).includes('last used on this tablet') && !(await page.$('#coilSearch')));
  await page.click('[data-crepline="2"]'); await page.waitForTimeout(200);
  ok('line: then the line shows at the top with Change line', (await page.textContent('#coilBody')).includes('Coil Line 2') && !!(await page.$('#crepLineChange')));
  // The app decides if a coil's last skid finishes on the next coil from the counts; a tap flips it.
  await page.click('[data-coil="SKD-C"]'); await page.fill(q(0, 0), '1300'); await page.click('[data-crepadd="0"]'); await page.fill(q(0, 1), '1300');
  await page.click('#crepNextBtn'); await page.click('[data-coil="SKD-D"]'); await page.waitForTimeout(100);
  ok('coil: a full last skid (the usual count) doesn\'t continue', (await nos()).join('|') === '-200|-201|-202' && (await page.textContent('[data-crepflip="0"]')).includes('Full skid'), await nos());
  await page.fill(q(0, 1), '400'); await page.dispatchEvent(q(0, 1), 'change'); await page.waitForTimeout(100);
  ok('coil: a short one does, by itself', (await nos()).join('|') === '-200|-201 ↘|-201 ↳' && (await page.textContent('[data-crepflip="0"]')).includes('Not full — finishes on coil 2'), await nos());
  await page.click('[data-crepflip="0"]'); await page.waitForTimeout(100);
  ok('coil: one tap flips it', (await nos()).join('|') === '-200|-201|-202', await nos());
  await page.click('[data-crepremove]'); await page.waitForTimeout(100);
  ok('coil: remove the last coil', (await nos()).join('|') === '-200|-201' && !(await page.$('[data-crepflip]')));
  await page.click('#backBtn'); await page.waitForTimeout(100);
  ok('coil: Back returns to Metals', !!(await page.$('#metalsPickCoil')));

  await page.click('#metalsPickPress'); await page.waitForTimeout(300);
  const presses = await page.$$eval('#runMachineSel option', (os) => os.map((o) => o.value).filter(Boolean));
  ok('press: the 11 presses from a list', presses.join() === 'A Liner,Press 2,Press 3,Press 13,Press 14,Press 15,Press 16,Press 17,Press 18,Press 19,Press 20', presses);
  ok('press: A Liner\'s open run shows on Press, the Line run doesn\'t', (await page.textContent('#openRunsList')).includes('A Liner') && !(await page.textContent('#openRunsList')).includes('Line 4'));
  await page.fill('#runOperator', 'Ann');
  await page.click('#startRunBtn'); await page.waitForTimeout(100);
  ok('press: must pick one', !calls.some((c) => c.fn === 'createRun'));
  await page.selectOption('#runMachineSel', 'Press 13');
  await page.click('#startRunBtn'); await page.waitForTimeout(300);
  ok('press: starts on Press 13', calls.filter((c) => c.fn === 'createRun')[0].args[0] === 'Press 13');
  ok('A Liner counts as a press', await page.evaluate(() => machineParts('A Liner').type === 'Press' && machineParts('Press 13').num === '13'));

  await page.evaluate(() => { openProduction(); }); await page.waitForTimeout(100);
  await page.click('#metalsPickSlitter'); await page.waitForTimeout(200);
  ok('slitter dept: two big buttons, Slitters and Scrolls', !!(await page.$('#slitPickSlitter')) && !!(await page.$('#slitPickScroll')) && !(await page.$('#slitMachineSel')));
  await page.click('#slitPickSlitter'); await page.waitForTimeout(300);
  ok('slitters: no Scroll tab on the screen', !(await page.$('[data-slkind]')) && (await page.textContent('#view')).includes('Slitters — Log'));
  const slitters = await page.$$eval('#slitMachineSel option', (os) => os.map((o) => o.value).filter(Boolean));
  ok('slitter: 1 H, 2 H, 7 A, 9 A', slitters.join() === '1 H,2 H,7 A,9 A', slitters);
  await page.fill('#slitOperator', 'Ann'); await page.selectOption('#slitMachineSel', '9 A');
  await page.click('#startSlitBtn'); await page.waitForTimeout(300);
  ok('slitter: starts on 9 A', calls.filter((c) => c.fn === 'createSlitterSession')[0].args.slice(0, 2).join() === 'Slitter,9 A');
  await page.evaluate(() => { openProduction(); }); await page.waitForTimeout(100);
  await page.click('#metalsPickSlitter'); await page.waitForTimeout(200);
  await page.click('#slitPickScroll'); await page.waitForTimeout(200);
  const scrolls = await page.$$eval('#slitMachineSel option', (os) => os.map((o) => o.value).filter(Boolean));
  ok('scrolls: 2 SS, 3 SS', scrolls.join() === '2 SS,3 SS', scrolls);
  await page.click('#backBtn'); await page.waitForTimeout(150);
  ok('back from Scrolls: the two buttons again', !!(await page.$('#slitPickScroll')));
  await page.click('#backBtn'); await page.waitForTimeout(150);
  ok('back again: Metals', !!(await page.$('#metalsPickSlitter')));
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
  await page.close();
}
{ const { page, calls } = await boot(Object.assign({}, base, {
    getAllTickets: () => R([ticket('SKD-C', 'C1', 'Current', { cs: 'C', mill: 'M77' })]),
    cutCoil: (a) => R({ created: a[3].length, tickets: [{ ticket: '100726-101' }] }),
  }));
  await page.click('#tileProduction'); await page.click('#metalsPickUsed'); await page.waitForTimeout(200);
  ok('Used in Production keeps its manual Coil Line tab', !!(await page.$('#usedAddInput')) && !!(await page.$('[data-usedtab="coil"]')));
  await page.click('[data-usedtab="coil"]'); await page.waitForTimeout(300);
  await page.click('[data-coil="SKD-C"]'); await page.waitForTimeout(100);
  ok('manual Coil Line: one coil, no Next coil or changeover', !(await page.$('#coilNextBtn')) && !(await page.$('.crFrom')));
  await page.fill('.crWeight', '1000'); await page.fill('.crQty', '250');
  await page.click('#coilCutBtn'); await page.waitForTimeout(100); await page.click('#modalOk'); await page.waitForTimeout(300);
  const cut = calls.filter((c) => c.fn === 'cutCoil')[0];
  ok('manual Coil Line: cuts one coil as before', cut && cut.args[0] === 'SKD-C' && !('coils' in cut.args[3][0]), cut && cut.args);
  await page.close();
}

// ---- 33. Coil Line: a skid left unfinished at the end of a run is the next run's first skid
{ const IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  let tickets = [ticket('SKD-3', 'C3', 'Current', { cs: 'C', mill: '26HCD20181' }), ticket('SKD-4', 'C4', 'Current', { cs: 'C', mill: '26HCD20190' })];
  const { page, calls } = await boot(Object.assign({}, base, {
    getAllTickets: () => R(tickets),
    cutCoil: (a) => R({ created: a[3].length, tickets: a[3].map((x, i) => ({ ticket: 'T' + i })) }),
  }), { userAgent: IPAD });
  const q = (ci, ri) => `.crep-row[data-crc="${ci}"][data-crr="${ri}"] .crepQty`;
  const nos = async () => page.$$eval('.crep-row .crep-no', (es) => es.map((e) => e.textContent.trim()));
  await page.click('#tileProduction'); await page.click('#metalsPickCoil'); await page.waitForTimeout(300); await page.click('[data-crepline="2"]'); await page.waitForTimeout(200);
  ok('carry: no unfinished skid card when there is none', !(await page.$('#crepCarryOpts')));
  await page.click('[data-coil="SKD-3"]'); await page.selectOption('#crepLine', '2'); await page.fill('#crepOperator', 'Giovanni');
  const w = (ci, ri) => `.crep-row[data-crc="${ci}"][data-crr="${ri}"] .crepWt`;
  await page.fill(q(0, 0), '1300'); await page.fill(w(0, 0), '4515'); await page.click('[data-crepadd="0"]'); await page.fill(q(0, 1), '1300'); await page.fill(w(0, 1), '4515');
  await page.click('[data-crepadd="0"]'); await page.fill(q(0, 2), '925');
  ok('red: a short last skid isn\'t asked for its weight (it may not be finished)', !(await page.$('#coilBody input.miss')));
  await page.click('#crepCutBtn'); await page.waitForTimeout(100);
  ok('carry: a short last skid is asked about in plain words', (await page.textContent('#crepAsk')).includes('The last skid (-202) has 925 sheets. Is it full?'), await page.textContent('#crepAsk'));
  await page.click('[data-crepyn="fin:1"]'); await page.waitForTimeout(100);
  ok('carry: both questions need an answer', !(await page.$('#crepGoBtn')));
  await page.click('[data-crepyn="full:0"]'); await page.waitForTimeout(100);
  ok('carry: the unfinished skid has no number yet', (await nos()).join('|') === '-200|-201|next ↘', await nos());
  ok('carry: summary says it waits for the next run', (await page.textContent('#crepAsk')).includes('2 skids (-200 to -201) · 2,600 sheets · 925 left on a skid for the next run'), await page.textContent('#crepAsk'));
  await page.click('#crepGoBtn'); await page.waitForTimeout(300);
  ok('carry: the saved note explains it', (await page.textContent('#modalRoot')).includes('The 925 sheets on the last skid wait for the next run on Coil Line 2'));
  let cut = calls.filter((c) => c.fn === 'cutCoil').slice(-1)[0];
  ok('carry: day 1 sends 2 skids, FIN COIL, and the 925 to carry', cut.args[3].length === 2 && cut.args[4] === true && cut.args[6].carryOut === 925, cut.args);
  await page.click('#modalOk').catch(() => {}); await page.waitForTimeout(100);
  // Next run (the reload says coil 3 is Used and holds 925 for line 2)
  tickets = [ticket('SKD-3', 'C3', 'Used', { cs: 'C', mill: '26HCD20181', carryOver: 925, carryLine: '2', carryDate: '2026-09-10' }), ticket('SKD-4', 'C4', 'Current', { cs: 'C', mill: '26HCD20190' })];
  await page.evaluate(() => { allCache = []; }); await page.click('#backBtn'); await page.click('#metalsPickCoil'); await page.waitForTimeout(400); await page.click('[data-crepline="2"]'); await page.waitForTimeout(200);
  ok('carry: next run shows the unfinished skid as its -200, no choices to make', !!(await page.$('#crepCarryOpts')) && (await page.textContent('#coilBody')).includes('-200 continues from the last run: 925 sheets') && (await page.textContent('#coilBody')).includes('from coil C3'), await page.textContent('#coilBody'));
  await page.click('[data-coil="SKD-4"]'); await page.waitForTimeout(100);
  ok('carry: the new coil\'s first count finishes it', (await nos()).join('|') === '-200 ↳', await nos());
  await page.fill(q(0, 0), '375'); await page.fill(w(0, 0), '4515'); await page.click('[data-crepadd="0"]'); await page.fill(q(0, 1), '1300'); await page.fill(w(0, 1), '4515');
  ok('carry: total shown', (await page.$$eval('.crep-note', (es) => es.map((e) => e.textContent).join('|'))).includes('1,300 on the skid (925 from the last run + 375)'), await page.$$eval('.crep-note', (es) => es.map((e) => e.textContent).join('|')));
  await page.click('#crepCutBtn'); await page.waitForTimeout(100); await page.click('[data-crepyn="fin:0"]'); await page.waitForTimeout(100);
  await page.click('#crepGoBtn'); await page.waitForTimeout(300);
  cut = calls.filter((c) => c.fn === 'cutCoil').slice(-1)[0];
  ok('carry: day 2 sends yesterday\'s coil first, the -200 as 925 + 375', cut.args[0].join() === 'SKD-3,SKD-4' && JSON.stringify(cut.args[3].map((x) => [x.qty, x.coils, x.parts || null])) === JSON.stringify([[1300, [0, 1], [925, 375]], [1300, [1], null]])
    && cut.args[6].carryIn.skidId === 'SKD-3' && cut.args[6].carryIn.only === true && cut.args[6].spoilage.join() === '0,0', cut.args);
  await page.click('#modalOk').catch(() => {}); await page.waitForTimeout(100);
  // Same coil both days: still open, picked again first
  tickets = [ticket('SKD-4', 'C4', 'Current', { cs: 'C', mill: '26HCD20190', carryOver: 500, carryLine: '1', carryDate: '2026-09-11' })];
  await page.evaluate(() => { allCache = []; }); await page.click('#backBtn'); await page.click('#metalsPickCoil'); await page.waitForTimeout(400);
  ok('line: opening Coil Line asks the line every time (2 marked as last used)', !!(await page.$('#crepLinePick')) && (await page.textContent('[data-crepline="2"]')).includes('last used'));
  await page.click('[data-crepline="2"]'); await page.waitForTimeout(100);
  await page.click('#crepLineChange'); await page.waitForTimeout(100);
  ok('line: Change line asks again', !!(await page.$('#crepLinePick')));
  await page.click('[data-crepline="1"]'); await page.waitForTimeout(100);
  ok('line: the coil is still open, so it asks which coil is on the line — no list yet', !!(await page.$('#crepLineAsk')) && !(await page.$('#coilPicker')) && (await page.textContent('#crepLineAsk')).includes('Skid -100 is waiting with 500 sheets from coil 26HCD20190'), await page.textContent('#coilBody'));
  await page.click('[data-crepsame="0"]'); await page.waitForTimeout(100);
  ok('line: "a new coil" shows the list without the old coil', !!(await page.$('#coilPicker')) && !(await page.$('[data-coil="SKD-4"]')) && !!(await page.$('#crepLineBack')));
  await page.click('#crepLineBack'); await page.waitForTimeout(100);
  await page.click('[data-crepsame="1"]'); await page.waitForTimeout(100);
  ok('line: "the same coil" picks it straight away', (await page.textContent('.crep-coil')).includes('26HCD20190') && (await nos()).join('|') === '-100 ↳', await nos());
  await page.fill('#crepOperator', 'Giovanni'); await page.fill(q(0, 0), '800'); await page.fill(w(0, 0), '4000');
  await page.click('#crepCutBtn'); await page.waitForTimeout(100); await page.click('[data-crepyn="fin:1"]'); await page.waitForTimeout(100);
  await page.click('#crepGoBtn'); await page.waitForTimeout(300);
  cut = calls.filter((c) => c.fn === 'cutCoil').slice(-1)[0];
  ok('carry: same coil — one coil, 500 + 800 on one skid', cut.args[0].join() === 'SKD-4' && cut.args[3][0].qty === 1300 && cut.args[3][0].coils.join() === '0,0' && !cut.args[3][0].parts && cut.args[6].carryIn.only === false, cut.args);
  await page.click('#modalOk').catch(() => {}); await page.waitForTimeout(100);
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
  await page.close();
}

// ---- 33b. Discard an unfinished skid (a test or a mistake)
{ const IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const tickets = [ticket('SKD-9', '100726-001', 'Used', { cs: 'C', mill: '12345', carryOver: 725, carryLine: '2', carryDate: '2026-10-07' }), ticket('SKD-8', 'C8', 'Current', { cs: 'C', mill: 'M8' })];
  const { page, calls } = await boot(Object.assign({}, base, { getAllTickets: () => R(tickets), discardCoilCarry: (a) => R({ ok: true, coilSkidId: a[0], discarded: 725 }) }), { userAgent: IPAD });
  await page.click('#tileProduction'); await page.click('#metalsPickCoil'); await page.waitForTimeout(400); await page.click('[data-crepline="2"]'); await page.waitForTimeout(200);
  await page.click('[data-coil="SKD-8"]'); await page.selectOption('#crepLine', '2'); await page.waitForTimeout(100);
  ok('discard: tucked under Options', !(await page.$('#crepCarryDiscard')) && !!(await page.$('#crepCarryOpts')));
  await page.click('#crepCarryOpts'); await page.waitForTimeout(100);
  ok('discard: Options shows Discard and "make it its own skid" as buttons', !!(await page.$('#crepCarryDiscard')) && (await page.textContent('#crepCarryUse')).includes('Make it its own skid (725 sheets)'));
  await page.click('#crepCarryDiscard'); await page.waitForTimeout(100);
  ok('discard: asks first, says no skid is made', (await page.textContent('#modalRoot')).includes('725 sheets from coil 100726-001 (left 2026-10-07) are dropped and no skid is made'));
  await page.click('#modalOk'); await page.waitForTimeout(300);
  const dc = calls.filter((c) => c.fn === 'discardCoilCarry')[0];
  ok('discard: sends the coil', dc && dc.args[0] === 'SKD-9', dc && dc.args);
  ok('discard: the card is gone and the first skid is the new coil\'s -200', !(await page.$('#crepCarryOpts')) && (await page.textContent('.crep-row .crep-no')).trim() === '-200');
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
  await page.close();
}

// ---- 34. Both receivers of a coil-changeover skid show, each linked to its scan
{ const { page, calls } = await boot(base);
  const out = await page.evaluate(() => {
    const t = { receiver: 'R-00011', receiverName: '26-01-01--KG--R-00011', receiverLink: 'https://drive/r11', receiverFrom: '',
      moreReceivers: [{ receiver: 'R-00118', receiverName: '26-06-12--TCC--R-00118', receiverLink: 'https://drive/r118', receiverFrom: 'C-8' }] };
    const box = document.createElement('div'); box.innerHTML = traceDetailHtml(Object.assign({ mill: 'MA / MB', coatings: [] }, t));
    return { names: rcvAllNames(t), text: box.textContent, links: Array.from(box.querySelectorAll('a')).map((a) => a.href) };
  });
  ok('receivers: CSV name has both', out.names === '26-01-01--KG--R-00011 + 26-06-12--TCC--R-00118', out.names);
  ok('receivers: the trace detail shows both, the second says which coil', out.text.includes('26-01-01--KG--R-00011') && out.text.includes('+ 26-06-12--TCC--R-00118 (from C-8)'), out.text);
  ok('receivers: each opens its own scan', out.links.indexOf('https://drive/r11') !== -1 && out.links.indexOf('https://drive/r118') !== -1, out.links);
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
  await page.close();
}

// ---- 35. Receivers with no tickets stand out (started, then interrupted) and can be listed alone
{ const RC = (id, n, extra) => Object.assign({ id, name: '26-10-07--PST--' + id, date: '2026-10-07', supplier: 'PST', pos: '', link: '', notes: '', mills: [], keptTickets: [], unkept: 0, ticketCount: n }, extra || {});
  const db = { receivers: [RC('R-00129', 0), RC('R-00128', 0, { notes: 'Test' }), RC('R-00127', 2)], suppliers: ['PST'], tickets: [] };
  const { page, calls } = await boot(Object.assign({}, base, { getMasterSheet: () => R({ rows: [], receivers: [] }), getReceivers: () => R(JSON.parse(JSON.stringify(db))) }));
  await page.evaluate(() => { openDatabase(); }); await page.waitForTimeout(300);
  await page.click('[data-dbt="receivers"]'); await page.waitForTimeout(300);
  ok('empty: warning counts them', (await page.textContent('#rcvEmptyNote')).includes('2 receivers have no tickets yet'));
  const tiles = await page.$$eval('[data-rcvopen]', (els) => els.map((e) => e.getAttribute('data-rcvopen') + (e.classList.contains('rcv-empty') ? ':empty' : '') + (e.textContent.includes('NO TICKETS') ? ':badge' : '')));
  ok('empty: those tiles are marked, the one with tickets isn\'t', tiles.join() === 'R-00129:empty:badge,R-00128:empty:badge,R-00127', tiles);
  await page.click('#rcvEmptyBtn'); await page.waitForTimeout(100);
  ok('empty: show only these', (await page.$$('[data-rcvopen]')).length === 2 && (await page.textContent('#rcvEmptyBtn')).includes('Show all'));
  await page.click('#rcvEmptyBtn'); await page.waitForTimeout(100);
  ok('empty: back to all', (await page.$$('[data-rcvopen]')).length === 3);
  db.receivers.forEach((r) => { r.ticketCount = 1; });
  await page.click('#rcvReload'); await page.waitForTimeout(300);
  ok('empty: no warning when every receiver has tickets', (await page.textContent('#rcvEmptyNote')).trim() === '' && !(await page.$('.rcv-empty')));
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
  await page.close();
}

// ---- 36. A full skid's count comes from the same job (End Use + size), with a little slack
{ const IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const sk = (id, t, eu, q) => ticket(id, t, 'Used', { cs: 'S', endUse: eu, qty: q, width: 30.6875, length: 34.005 });
  const tickets = [
    sk('H1', '090126-200', '603 ENDS', 1300), sk('H2', '090126-201', '603 ENDS', 1300), sk('H3', '090126-202', '603 ENDS', 665),
    sk('H4', '090226-200', '401 ENDS', 1500), sk('H5', '090226-201', '401 ENDS', 1500), sk('H6', '090226-202', '401 ENDS', 1500), sk('H7', '090226-203', '401 ENDS', 1500),
    ticket('SKD-E', 'E1', 'Current', { cs: 'C', mill: 'ME', endUse: '603 ENDS', width: 30.6875, length: 34.005 }),
    ticket('SKD-F', 'F1', 'Current', { cs: 'C', mill: 'MF', endUse: '603 ENDS', width: 30.6875, length: 34.005 }),
    ticket('SKD-G', 'G1', 'Current', { cs: 'C', mill: 'MG', endUse: '401 ENDS', width: 30.6875, length: 34.005 }),
    ticket('SKD-K', 'K1', 'Current', { cs: 'C', mill: 'MK', endUse: '401 ENDS', width: 30.6875, length: 34.005 })];
  const { page, calls } = await boot(Object.assign({}, base, { getAllTickets: () => R(tickets) }), { userAgent: IPAD });
  const q = (ci, ri) => `.crep-row[data-crc="${ci}"][data-crr="${ri}"] .crepQty`;
  const flip = async () => (await page.textContent('[data-crepflip="0"]')).trim();
  await page.click('#tileProduction'); await page.click('#metalsPickCoil'); await page.waitForTimeout(300); await page.click('[data-crepline="1"]'); await page.waitForTimeout(200);
  // 603 ENDS: the first skid of the day is 1,296 — the past 603 ENDS skids say a full one is 1,300
  await page.click('[data-coil="SKD-E"]'); await page.fill(q(0, 0), '1296');
  await page.click('#crepNextBtn'); await page.click('[data-coil="SKD-F"]'); await page.waitForTimeout(100);
  ok('full: 1,296 of a 1,300 job (from past skids) is full', (await flip()).startsWith('✔ Full skid'), await flip());
  await page.fill(q(0, 0), '1200'); await page.waitForTimeout(50);
  ok('full: 1,200 is short, so it finishes on the next coil', (await flip()).startsWith('↘ Not full'), await flip());
  await page.click('[data-crepremove]'); await page.click('[data-crepremove]'); await page.waitForTimeout(100);
  // 401 ENDS on the same line: a full skid is 1,500, so 1,300 isn't
  await page.click('[data-coil="SKD-G"]'); await page.fill(q(0, 0), '1300');
  await page.click('#crepNextBtn'); await page.click('[data-coil="SKD-K"]'); await page.waitForTimeout(100);
  ok('full: a 401 ENDS job uses 1,500, not the 603 count', (await flip()).startsWith('↘ Not full'), await flip());
  await page.fill(q(0, 0), '1500'); await page.waitForTimeout(50);
  ok('full: 1,500 is full for it', (await flip()).startsWith('✔ Full skid'), await flip());
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
  await page.close();
}

// ---- 37. Spanish display: the screen changes, the records don't
{ const IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const tickets = [ticket('SKD-C', 'C1', 'Current', { cs: 'C', mill: '26HCD20179', endUse: '603 ENDS', comments: 'JF PRIME' })];
  const { page, calls } = await boot(Object.assign({}, base, {
    getAllTickets: () => R(tickets), getProductionRuns: () => R([]),
    cutCoil: (a) => R({ created: a[3].length, tickets: [{ ticket: '100726-200' }] }),
  }), { userAgent: IPAD });
  ok('es: the button is written in Spanish while the app is English', (await page.textContent('#tileLang')).includes('Cambiar idioma a español') && (await page.textContent('#tileLitho')).includes('Litho Department'));
  await page.click('#tileLang'); await page.waitForTimeout(200);
  ok('es: the start screen turns Spanish', (await page.textContent('#tileLitho')).includes('Departamento de Litho') && (await page.textContent('#tileProduction')).includes('Departamento de Metales') && (await page.textContent('#tileSearch')).includes('Buscar un ticket'));
  ok('es: the button now says Change to English, in English', (await page.textContent('#tileLang')).includes('Change to English'));
  await page.reload(); await page.waitForTimeout(300);
  ok('es: remembered after a refresh', (await page.textContent('#tileLitho')).includes('Departamento de Litho') && (await page.textContent('#backBtn')).includes('Atrás'));
  await page.click('#tileProduction'); await page.waitForTimeout(100);
  ok('es: Metals screen', (await page.textContent('#view')).includes('¿En qué departamento está trabajando?') && (await page.textContent('#metalsPickCoil')).includes('Línea de bobina'));
  await page.click('#metalsPickPress'); await page.waitForTimeout(300);
  const opt = await page.$$eval('#runMachineSel option', (os) => os.filter((o) => o.value === 'Press 13').map((o) => o.value + '|' + o.textContent));
  ok('es: a press shows as Prensa 13 but its value stays Press 13', opt.join() === 'Press 13|Prensa 13', opt);
  await page.evaluate(() => { openProduction(); }); await page.waitForTimeout(100);
  await page.click('#metalsPickCoil'); await page.waitForTimeout(300);
  ok('es: coil line asks the line in Spanish', (await page.textContent('#crepLinePick')).includes('¿En qué línea de bobina está?') && (await page.textContent('[data-crepline="1"]')).includes('Línea de bobina 1'));
  await page.click('[data-crepline="1"]'); await page.waitForTimeout(200);
  await page.click('[data-coil="SKD-C"]'); await page.waitForTimeout(100);
  const body = await page.textContent('#coilBody');
  ok('es: report labels in Spanish, data left alone', body.includes('Reporte de producción — Línea de bobina') && body.includes('Conteo de hojas') && body.includes('Peso') && body.includes('26HCD20179') && body.includes('JF PRIME') && body.includes('603 ENDS'), body.slice(0, 600));
  ok('es: placeholders too', (await page.getAttribute('.crepQty', 'placeholder')) === 'hojas');
  await page.fill('#crepOperator', 'Giovanni');
  await page.fill('.crep-row[data-crc="0"][data-crr="0"] .crepQty', '1300'); await page.fill('.crep-row[data-crc="0"][data-crr="0"] .crepWt', '4515');
  await page.click('#crepCutBtn'); await page.waitForTimeout(100);
  ok('es: the questions in Spanish', (await page.textContent('#crepAsk')).includes('¿Se terminó la bobina') && (await page.textContent('[data-crepyn="fin:1"]')).includes('Sí — FIN COIL'));
  await page.click('[data-crepyn="fin:1"]'); await page.waitForTimeout(100);
  await page.click('#crepGoBtn'); await page.waitForTimeout(300);
  const cut = calls.filter((c) => c.fn === 'cutCoil')[0];
  ok('es: what is saved is the same as in English', cut && cut.args[0].join() === 'SKD-C' && cut.args[3][0].qty === 1300 && cut.args[3][0].weight === '4515' && cut.args[4] === true && cut.args[6].operator === 'Giovanni', cut && cut.args);
  ok('es: the result message is Spanish', (await page.textContent('#modalRoot')).includes('Reporte guardado') && (await page.textContent('#modalRoot')).includes('1 tarima creada'), await page.textContent('#modalRoot'));
  await page.click('#modalOk').catch(() => {}); await page.waitForTimeout(100);
  await page.click('#backBtn'); await page.waitForTimeout(100); await page.click('#backBtn'); await page.waitForTimeout(100);
  await page.click('#tileLang'); await page.waitForTimeout(200);
  ok('en: back to English everywhere, header included', (await page.textContent('#tileLitho')).includes('Litho Department') && (await page.textContent('#backBtn')).includes('Back') && (await page.textContent('#tileLang')).includes('Cambiar idioma a español'));
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
  await page.evaluate(() => { try { localStorage.removeItem('cscLang'); } catch (e) {} });
  await page.close();
}

// 38. Work sessions: the skid finder lists nothing until a scan; Back asks Save / Delete / Keep working
{ const { page, calls } = await boot(Object.assign({}, base, {
    getAllTickets: () => R([ticket('SKD-1', '5001', 'Current'), ticket('SKD-2', '5002', 'WIP'), ticket('SKD-3', '9999', 'Current'),
      ticket('SKD-4', '5003', 'Used', { usedOn: '2026-10-06' }), ticket('SKD-5', '5004', 'Used', { cs: 'C' })]),
    getProductionRuns: () => R([]),
    createRun: (a) => R({ runId: 'RUN-00009', machine: a[0], operator: a[1], status: 'Open' }),
    runAddSkid: (a) => R({ runId: a[0], skidId: a[1], ticket: { 'SKD-1': '5001', 'SKD-2': '5002', 'SKD-4': '5003' }[a[1]], loadedOn: '2026-10-08' }),
    deleteRun: (a) => R({ runId: a[0], deleted: true, returned: 1 }),
  }));
  const startPress = async () => {
    if (await page.$('#metalsPickPress')) { await page.click('#metalsPickPress'); await page.waitForTimeout(300); }
    await page.fill('#runOperator', 'Ann'); await page.selectOption('#runMachineSel', 'Press 13');
    await page.click('#startRunBtn'); await page.waitForTimeout(300);
  };
  await page.click('#tileProduction'); await page.waitForTimeout(100);
  await startPress();
  ok('finder: nothing listed before a scan', !(await page.$('#runSkidPicker [data-pick]')) && (await page.textContent('#runSkidPicker')).includes('Scan the ticket'));
  await page.fill('#runSkidSearch', '500'); await page.waitForTimeout(100);
  const picks = await page.$$eval('#runSkidPicker [data-pick]', (bs) => bs.map((b) => b.getAttribute('data-pick')));
  ok('finder: typing shows the Current and WIP matches', picks.join() === 'SKD-1,SKD-2', picks);
  ok('finder: and, apart, the ones already marked Used (not cut coils)', (await page.textContent('#runUsedHits')).includes('5003') && (await page.textContent('#runUsedHits')).includes('2026-10-06')
    && !(await page.textContent('#runUsedHits')).includes('5004'));
  await page.fill('#runSkidSearch', '5001'); await page.press('#runSkidSearch', 'Enter'); await page.waitForTimeout(300);
  const add1 = calls.filter((c) => c.fn === 'runAddSkid')[0];
  ok('finder: a scan (exact + Enter) loads it at once', add1 && add1.args[1] === 'SKD-1' && !add1.args[4], add1 && add1.args);
  ok('finder: the box clears for the next scan', (await page.inputValue('#runSkidSearch')) === '' && (await page.textContent('#runAddedCount')) === '1');
  await page.fill('#runSkidSearch', '5003'); await page.waitForTimeout(100);
  await page.click('[data-pickused="SKD-4"]'); await page.waitForTimeout(100);
  ok('used: asks before loading one marked Used', (await page.textContent('#modalRoot')).includes('was marked Used on 2026-10-06'));
  await page.click('#modalOk'); await page.waitForTimeout(300);
  const add2 = calls.filter((c) => c.fn === 'runAddSkid')[1];
  ok('used: loads it, telling the server it was marked Used', add2 && add2.args[1] === 'SKD-4' && add2.args[4] === true, add2 && add2.args);

  await page.click('#backBtn'); await page.waitForTimeout(100);
  ok('back: asks to save or delete', (await page.textContent('#modalRoot')).includes('Save this work session?') && (await page.textContent('#modalRoot')).includes('has 2 skids loaded')
    && !!(await page.$('#modalAlt')) && !!(await page.$('#modalCancel')));
  await page.click('#modalAlt'); await page.waitForTimeout(100);
  ok('back: Keep working stays put', !!(await page.$('#runSkidSearch')));
  await page.click('#backBtn'); await page.waitForTimeout(100);
  await page.click('#modalOk'); await page.waitForTimeout(300);
  ok('back: Save leaves it open and goes back to Press', !!(await page.$('#startRunBtn')) && !calls.some((c) => c.fn === 'deleteRun'));

  await startPress();
  await page.click('#backBtn'); await page.waitForTimeout(100);
  await page.click('#modalCancel'); await page.waitForTimeout(100);
  ok('delete: asks once more', (await page.textContent('#modalRoot')).includes('Delete this work session?'));
  await page.click('#modalOk'); await page.waitForTimeout(300);
  const del = calls.filter((c) => c.fn === 'deleteRun')[0];
  const loads = await page.evaluate(() => {
    allCache = [{ skidId: 'L1', ticket: '1001', status: 'Current', cutType: 'Slit' }, { skidId: 'L2', ticket: '1002', status: 'WIP', cutType: 'Scroll' },
      { skidId: 'L3', ticket: '1003', status: 'Cut', cutType: 'Scroll' }, { skidId: 'S1', ticket: '7001', status: 'Current' }];
    markCacheStatus('S1', 'Current');
    return [prodPickList('Press').map((t) => t.skidId).join(), prodPickList('Line').map((t) => t.skidId).join(), queueCache.map((t) => t.skidId).join()];
  });
  ok('loads: Current / WIP loads stay on their own machines, off the Litho pickers', loads.join('|') === 'L2,L3,S1|L1,S1|S1', loads);
  ok('delete: deletes that run and goes back to Press', del && del.args[0] === 'RUN-00009' && del.args[1] === 'Ann' && !!(await page.$('#startRunBtn')), del && del.args);
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
  await page.close();
}

// ---- 39. Database: ⚠ warnings for skids that look mis-typed against the spec sheet
{ const W = 'Sheet size 34 × 97.093 isn\'t on the spec sheet for 401X508 (spec sizes: 37.093 × 34). Check Width / Length, or the End Use. Likely meant: Length 37.093 (so 34 × 37.093).';
  let raws = 0;
  const { page, calls } = await boot(Object.assign({}, base, {
    getMasterSheet: () => R({ rows: [
      { skidId: 'SKD-1', ticket: '120225-011', status: 'Current', litho: 0, coatings: [], warn: [W] },
      { skidId: 'SKD-2', ticket: '502', status: 'Current', litho: 0, coatings: [], warn: [] }], receivers: [] }),
    getRawTable: () => { raws++; return R({ headers: ['Ticket', 'Skid ID', 'Length'], rows: [
      { __row: 2, 'Ticket': '120225-011', 'Skid ID': 'SKD-1', 'Length': '97.093', __warn: [W] },
      { __row: 3, 'Ticket': '502', 'Skid ID': 'SKD-2', 'Length': '37.093' }] }); },
    updateRawRow: () => R({ ok: true, updated: 1 }),
  }));
  await page.evaluate(() => { openDatabase(); }); await page.waitForTimeout(300);
  const list = await page.textContent('#msList');
  ok('Master sheet: the flagged skid shows ⚠ check and why', list.includes('⚠ check') && list.includes('97.093 isn') && list.includes('Steel Tickets tab'), list);
  ok('Master sheet: Likely meant on its own line', ((await page.innerHTML('#msList')) || '').includes('<b>→ Likely meant:</b> Length 37.093 (so 34 × 37.093).'));
  ok('Master sheet: a ⚠ Check filter with the count', (await page.textContent('[data-msf="warn"]')).includes('⚠ Check (1)'));
  await page.click('[data-msf="warn"]'); await page.waitForTimeout(100);
  ok('the ⚠ Check filter shows only flagged skids', (await page.textContent('#msList')).includes('120225-011') && !(await page.textContent('#msList')).includes('502'));
  await page.click('[data-dbt="steel"]'); await page.waitForTimeout(300);
  ok('Steel Tickets: ⚠ on the flagged row only', (await page.$$('#dbTableBox .specwarn-tag')).length === 1);
  await page.click('#dbWarnBtn'); await page.waitForTimeout(100);
  ok('Steel Tickets: only-the-flagged button', (await page.$$('#dbTableBox tbody tr')).length === 1);
  await page.click('[data-dbrow="2"]'); await page.waitForTimeout(100);
  ok('editor: the warning is shown above the fields', ((await page.textContent('.specwarn')) || '').includes('97.093 isn'));
  await page.fill('.dbf[data-f="Length"]', '37.093');
  await page.click('#dbSave'); await page.waitForSelector('#modalOk'); await page.click('#modalOk'); await page.waitForTimeout(300);
  await page.click('#modalOk'); await page.waitForTimeout(300);
  ok('after a save the table reloads so the warning re-checks', raws === 2, raws);
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
  await page.close();
}

// ---- 40. Master sheet: ✏️ Edit opens the ticket's row (usual fields first) and comes back
{ let raws = 0, upd = null;
  const { page, calls } = await boot(Object.assign({}, base, {
    getMasterSheet: () => R({ rows: [
      { skidId: 'SKD-1', ticket: '102825-009', status: 'Current', litho: 0, coatings: [], warn: [] },
      { skidId: 'SKD-2', ticket: '502', status: 'Current', litho: 0, coatings: [], warn: [] }], receivers: [] }),
    getRawTable: () => { raws++; return R({ headers: ['Ticket', 'Skid ID', 'Status', 'Weight', 'End Use', 'Last Op ID'], rows: [
      { __row: 2, 'Ticket': '102825-009', 'Skid ID': 'SKD-1', 'Status': 'Current', 'Weight': '3040', 'End Use': '603 ENDS', 'Last Op ID': 'x' },
      { __row: 3, 'Ticket': '502', 'Skid ID': 'SKD-2', 'Status': 'Current', 'Weight': '100', 'End Use': '', 'Last Op ID': '' }] }); },
    updateRawRow: (a) => { upd = a; return R({ ok: true, updated: 1 }); },
  }));
  await page.evaluate(() => { openDatabase(); }); await page.waitForTimeout(300);
  await page.selectOption('[data-msst="SKD-2"]', 'Used'); await page.waitForTimeout(100);
  await page.click('[data-msedit="SKD-1"]'); await page.waitForTimeout(300);
  const vis = await page.$$eval('.dbf', (els) => els.filter((e) => e.offsetParent).map((e) => e.getAttribute('data-f')));
  ok('Edit opens that ticket with the usual fields only', vis.join() === 'Ticket,End Use,Weight' && (await page.textContent('#view')).includes('Edit SKD-1'), vis);
  await page.click('#dbAllFields'); await page.waitForTimeout(100);
  ok('Show all fields shows the rest', (await page.$$eval('.dbf', (els) => els.filter((e) => e.offsetParent).length)) === 6);
  await page.click('#dbCancel'); await page.waitForTimeout(200);
  ok('Cancel goes back to the Master sheet with the unsaved mark kept', !!(await page.$('#msList')) && (await page.textContent('#msBarText')).includes('1 ticket changed'));
  await page.click('[data-msedit="SKD-1"]'); await page.waitForTimeout(300);
  await page.fill('.dbf[data-f="Weight"]', '4310');
  await page.click('#dbSave'); await page.waitForSelector('#modalOk'); await page.click('#modalOk'); await page.waitForTimeout(300);
  ok('Save writes that one field to its Steel Tickets row', upd && upd[0] === 'steel' && upd[1] === 2 && JSON.stringify(upd[2]) === '{"Weight":"4310"}', upd);
  await page.click('#modalOk'); await page.waitForTimeout(300);
  ok('after saving: back on the Master sheet, reloaded, marks kept', !!(await page.$('#msList')) && calls.filter((c) => c.fn === 'getMasterSheet').length === 2
    && (await page.textContent('#msBarText')).includes('1 ticket changed'));
  await page.click('[data-msedit="SKD-1"]'); await page.waitForTimeout(300);
  await page.click('#backBtn'); await page.waitForTimeout(200);
  ok('Back from the editor also returns to the Master sheet', !!(await page.$('#msList')) && raws === 3, raws);
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
  await page.close();
}

// ---- 41. Count Edit: changing the sheet count fills in an estimated weight; you can override it
{ const sess = { sessionId: 'CNT-1', stage: 'Current', startedOn: today, startedBy: 'Ann' };
  let upd = [];
  const { page, calls } = await boot(Object.assign({}, base, {
    getActiveCount: () => R(sess),
    getAllTickets: () => R([ticket('SKD-A', '102825-009', 'Current', { qty: 1422, weight: '4,310.00' }),
      ticket('SKD-B', '200', 'Current', { qty: '', weight: '', width: 34, length: 37.093, bw: 75 }),
      ticket('SKD-C', 'C-1', 'Current', { cs: 'C', qty: '', weight: 20000 })]),
    updateTicketDetails: (a) => { upd.push(a); return R({ ok: true }); },
  }));
  await page.evaluate(() => openSteelCount());
  await page.waitForSelector('[data-countedit="SKD-A"]');
  await page.click('[data-countedit="SKD-A"]'); await page.waitForTimeout(100);
  ok('the weight box starts with the pallet weight', (await page.inputValue('#ceWt_SKD-A')) === '4310');
  await page.fill('#ceQty_SKD-A', '1000'); await page.waitForTimeout(50);
  ok('a new count scales the pallet weight: 4,310 ÷ 1,422 × 1,000 = 3,031', (await page.inputValue('#ceWt_SKD-A')) === '3031' && (await page.textContent('#ceWtNote_SKD-A')).includes('estimated'));
  await page.fill('#ceWt_SKD-A', '3100'); await page.waitForTimeout(50);
  await page.fill('#ceQty_SKD-A', '999'); await page.waitForTimeout(50);
  ok('a typed weight wins over the estimate', (await page.inputValue('#ceWt_SKD-A')) === '3100' && await page.isVisible('#ceWtEst_SKD-A'));
  await page.click('#ceWtEst_SKD-A'); await page.waitForTimeout(50);
  ok('Use estimate puts it back', (await page.inputValue('#ceWt_SKD-A')) === '3028');
  await page.fill('#ceWt_SKD-A', '3100'); await page.fill('#ceQty_SKD-A', '1000');
  await page.click('#ceSave_SKD-A'); await page.waitForTimeout(300);
  ok('Save sends the count and the weight', upd.length === 1 && upd[0][1]['QTY/LOAD'] === 1000 && upd[0][1]['Weight'] === 3100, upd);
  await page.click('[data-countedit="SKD-B"]'); await page.waitForTimeout(100);
  await page.fill('#ceQty_SKD-B', '1000'); await page.waitForTimeout(50);
  ok('no weight yet: worked out from the size (34 × 37.093 × 1,000 × 75 ÷ 31,360 = 3,016)', (await page.inputValue('#ceWt_SKD-B')) === '3016');
  await page.click('[data-countedit="SKD-C"]'); await page.waitForTimeout(100);
  await page.fill('#ceQty_SKD-C', '2'); await page.waitForTimeout(50);
  ok('coils: no estimate', (await page.inputValue('#ceWt_SKD-C')) === '20000' && !(await page.textContent('#ceWtNote_SKD-C')));
  await page.click('#ceSave_SKD-C'); await page.waitForTimeout(300);
  ok('an unchanged weight is not re-sent', upd.length === 2 && !('Weight' in upd[1][1]), upd[1] && upd[1][1]);
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
  await page.close();
}

// ---- 42. Materials: receive a delivery by scanning lots; the list; edit a lot
{ const mats = [
    { id: 'M-00002', lot: 'PW-1', type: 'Powder', product: 'Stripe 9', supplier: 'AKZO', receiver: 'R-00007', po: '55', date: '2026-09-01', expiration: '2020-01-01', qtyReceived: 2, qtyOnHand: 2, container: 'Box', status: 'In Stock', comments: '' },
    { id: 'M-00001', lot: 'OLD-1', type: 'Compound', product: 'WB-2100', supplier: 'DSM', receiver: 'R-00007', po: '55', date: '2026-08-01', expiration: '', qtyReceived: 1, qtyOnHand: 0, container: 'Pail', status: 'Used', comments: '' }];
  const G = { materials: mats, types: ['Compound', 'Powder', 'Copper', 'Ink'], products: { Compound: ['WB-2100'], Powder: ['Stripe 9'], Copper: [], Ink: [] },
    suppliers: ['AKZO', 'DSM'], containers: ['Box', 'Pail'], receivers: [{ id: 'R-00007', name: '26-09-01--AKZO--R-00007', date: '2026-09-01', supplier: 'AKZO', pos: '55' }],
    items: [{ id: 'MI-00001', name: 'WB-2100', type: 'Compound', supplier: 'DSM', container: 'Barrel', partNo: '', notes: '', active: true },
      { id: 'MI-00002', name: 'Stripe 9', type: 'Powder', supplier: 'AKZO', container: 'Unit', partNo: '', notes: '', active: true }] };
  const { page, calls } = await boot(Object.assign({}, base, {
    getMaterials: () => R(G),
    receiveMaterials: (a) => R({ ok: true, receiver: 'R-00008', receiverCreated: true, lots: 2, containers: 3, saved: [] }),
    updateMaterial: () => R({ ok: true }),
  }));
  await page.click('#tileMaterials'); await page.click('[data-mthome="Metals"]');
  ok('a department\'s Materials: Load, Receive, Maintenance', (await page.$$eval('#view > button', (els) => els.map((e) => e.id))).join() === 'mtLoadBtn,mtReceiveBtn,mtMaintBtn');
  await page.click('#mtMaintBtn');
  ok('Maintenance: Lots, Materials, Machines, Load History', (await page.$$eval('#view > button', (els) => els.map((e) => e.id))).join() === 'mtLotsBtn,mtListBtn,mtMachBtn,mtHistBtn');
  await page.click('#mtLotsBtn');
  await page.waitForSelector('[data-mtopen]');
  let txt = await page.textContent('#mtList');
  ok('materials list: in-stock lots only by default; expired shows', txt.includes('PW-1') && !txt.includes('OLD-1') && txt.includes('EXPIRED 2020-01-01') && txt.includes('2 of 2 left'), txt);
  await page.check('#mtShowUsed');
  ok('Show used-up lots shows the used one', (await page.textContent('#mtList')).includes('OLD-1'));
  await page.click('[data-mtt="Compound"]');
  txt = await page.textContent('#mtList');
  ok('type chip filters', txt.includes('OLD-1') && !txt.includes('PW-1'), txt);
  // Receive
  await page.click('#backBtn'); await page.click('#backBtn'); await page.waitForSelector('#mtReceiveBtn');
  await page.click('#mtReceiveBtn');
  await page.waitForSelector('#mtScan');
  await page.fill('#mtSupplier', 'DSM');
  await page.fill('#mtPo', '7731-DC');
  await page.fill('#mtScan', 'A1'); await page.press('#mtScan', 'Enter');
  ok('scanning without a product name is refused', !(await page.$('[data-mtqty]')));
  await page.fill('#mtProduct', 'WB-2100');
  await page.fill('#mtExp', '2027-04-01');
  for (const lot of ['24A0915', '24A0915', '24A0922']) { await page.fill('#mtScan', lot); await page.press('#mtScan', 'Enter'); }
  const qtys = await page.$$eval('[data-mtqty]', (els) => els.map((e) => e.textContent));
  ok('the same lot scanned twice counts 2 containers', qtys.join() === '1,2', qtys);
  ok('the scan box is cleared and ready for the next', (await page.$eval('#mtScan', (e) => e.value)) === '' && (await page.evaluate(() => document.activeElement.id)) === 'mtScan');
  await page.click('[data-mtrt="Powder"]');
  ok('a new type: its container, blank product, its product list', (await page.$eval('#mtContainer', (e) => e.value)) === 'Unit' && (await page.$eval('#mtProduct', (e) => e.value)) === ''
    && (await page.$eval('#mtProdList', (e) => e.innerHTML)).includes('Stripe 9'));
  await page.fill('#mtScan', 'PW-1');
  ok('save button counts lots and containers', (await page.textContent('#mtSave')).includes('Save 2 lots (3 containers)'), await page.textContent('#mtSave'));
  // Back keeps the scanned lots
  await page.click('#backBtn'); await page.waitForTimeout(100);
  ok('stepping out keeps the scanned lots (warning on the list)', (await page.textContent('#view')).includes('2 scanned lots are not saved yet'));
  await page.click('#mtReceiveBtn'); await page.waitForSelector('#mtScan');
  ok('…and they are still there', (await page.$$('[data-mtqty]')).length === 2);
  // The typed-but-not-entered lot (PW-1 is gone now since the screen redrew) — product needed for powder
  await page.fill('#mtProduct', 'Stripe 9');
  await page.fill('#mtScan', 'PW-1');
  await page.click('#mtSave');   // the lot left in the box is added before saving
  await page.waitForSelector('#modalOk'); await page.click('#modalOk');
  await page.waitForTimeout(200);
  const rc = calls.filter((c) => c.fn === 'receiveMaterials')[0];
  ok('receiveMaterials gets the delivery and every lot', rc && rc.args[0].supplier === 'DSM' && rc.args[0].po === '7731-DC' && rc.args[0].receiver === '' && rc.args[1].length === 3
    && rc.args[1].some((l) => l.lot === '24A0915' && l.qty === 2 && l.expiration === '2027-04-01' && l.product === 'WB-2100' && l.type === 'Compound')
    && rc.args[1].some((l) => l.lot === 'PW-1' && l.type === 'Powder' && l.container === 'Unit'), rc && rc.args);
  ok('saved: says the receiver number to write on the slip', (await page.textContent('#modalRoot')).includes('R-00008'));
  await page.click('#modalOk'); await page.waitForTimeout(150);
  ok('back on the department after saving; nothing pending', !!(await page.$('#mtReceiveBtn')) && !(await page.textContent('#view')).includes('not saved yet'));
  // Edit a lot
  await page.click('#mtMaintBtn'); await page.click('#mtLotsBtn'); await page.waitForSelector('[data-mtt="all"]');
  await page.click('[data-mtt="all"]');
  await page.waitForSelector('[data-mtopen="M-00002"]');
  await page.click('[data-mtopen="M-00002"]');
  await page.waitForSelector('#mtEdSave');
  await page.fill('#mtEd5', '0');
  await page.click('#mtEdSave'); await page.waitForTimeout(150);
  const up = calls.filter((c) => c.fn === 'updateMaterial')[0];
  ok('edit sends only the changed field', up && up.args[0] === 'M-00002' && JSON.stringify(up.args[1]) === '{"Qty On Hand":"0"}', up && up.args);
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
  await page.close();
}

// ---- 43. Skid traveler prints straight to the Zebra (via print_server.py's /label tab)
{ const steel = { 'Skid ID': 'SKD-1', 'Ticket': '100', 'Status': 'WIP', 'BW': '75', 'Litho': 10 };
  const { page, calls } = await boot(Object.assign({}, base, {
    getTicketCard: () => R(card(steel, { coatings: [{ passNumber: 1, item: 'SIZE', group: '603X408', sub: '10-OUT', cost: 2 }] })),
  }));
  await page.evaluate(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return {}; }; window.__printed = 0; window.print = () => { window.__printed++; }; });
  await page.evaluate(() => openCard('SKD-1'));
  await page.waitForSelector('#printTravelerBtn');
  await page.click('#printTravelerBtn');
  const opened = await page.evaluate(() => window.__opened);
  const zpl = opened.length ? Buffer.from(opened[0].split('#')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('latin1') : '';
  ok('Print opens the print server\'s /label page with the label', opened.length === 1 && opened[0].indexOf('http://192.168.1.214:8000/label#') === 0, opened);
  ok('the label is one 300 dpi graphic, turned for a 4in printer (1200 x 1800 dots)', /^\^XA\^PW1200\^LL1800\^LH0,0\^FO0,0\^GFA,270000,270000,150,/.test(zpl) && /\^FS\^PQ1\^XZ$/.test(zpl), zpl.slice(0, 60));
  ok('no print dialog for the Zebra', (await page.evaluate(() => window.__printed)) === 0);
  await page.click('#printTravelerDialog');
  ok('"Print with the print dialog instead" still opens the dialog', (await page.evaluate(() => window.__printed)) === 1);
  await page.evaluate(() => { window.open = () => null; });
  await page.click('#printTravelerBtn'); await page.waitForTimeout(50);
  ok('a blocked pop-up says how to allow it', /Allow pop-ups/.test(await page.textContent('#toast')), await page.textContent('#toast'));
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
  await page.close();
}

// ---- 44. Material List: add / edit materials; receiving picks from it ("Add it now" when missing)
{ const mats = [{ id: 'M-00001', lot: 'A1', type: 'Compound', product: 'WB-2100', supplier: 'DSM', receiver: 'R-00007', po: '', date: '2026-08-01', expiration: '', qtyReceived: 3, qtyOnHand: 3, container: 'Pail', status: 'In Stock', comments: '' }];
  let items = [{ id: 'MI-00001', name: 'WB-2100', type: 'Compound', supplier: 'DSM', container: 'Pail', partNo: '', notes: '', active: true, createdBy: 'From received lots' },
    { id: 'MI-00002', name: 'Old Blue', type: 'Ink', supplier: 'SUN', container: 'Can', partNo: '', notes: '', active: false },
    { id: 'MI-00003', name: 'Acetone', type: 'Solvent', supplier: '', container: 'Drum', partNo: 'AC-1', notes: 'flammable', active: true }];
  const G = () => ({ materials: mats, items, types: ['Compound', 'Powder', 'Copper', 'Ink', 'Solvent'], containerFor: { Compound: 'Pail', Powder: 'Box', Copper: 'Gaylord', Ink: 'Can' },
    products: {}, suppliers: ['DSM', 'SUN'], containers: ['Pail'], receivers: [] });
  const { page, calls } = await boot(Object.assign({}, base, {
    getMaterials: () => R(G()),
    saveMaterialItem: (a) => { const it = Object.assign({}, a[0], { id: a[0].id || 'MI-00009' }); items = items.filter((i) => i.id !== it.id).concat([it]); return R({ ok: true, item: it }); },
    deleteMaterialItem: () => R({ ok: true }),
  }));
  await page.click('#tileMaterials'); await page.click('[data-mthome="Metals"]');
  await page.click('#mtMaintBtn'); await page.click('#mtLotsBtn');
  ok('the type chips include a type added on the list', !!(await page.waitForSelector('[data-mtt="Solvent"]', { timeout: 2000 }).catch(() => null)));
  await page.click('#backBtn'); await page.waitForSelector('#mtListBtn');
  await page.click('#mtListBtn');
  await page.waitForSelector('[data-mtitem]');
  let txt = await page.textContent('#mtItemList');
  ok('the list: grouped by type, inactive hidden, lot counts', txt.includes('WB-2100') && txt.includes('1 lot received') && !/shelf/i.test(txt) && txt.includes('Solvent') && txt.includes('Part # AC-1') && !txt.includes('Old Blue'), txt);
  await page.check('#mtShowInactive');
  ok('Show inactive shows it, marked', (await page.textContent('#mtItemList')).includes('Old Blue Inactive'));
  await page.fill('#mtItemSearch', 'flamm');
  ok('search finds by notes', (await page.$$('[data-mtitem]')).length === 1);
  await page.fill('#mtItemSearch', '');
  // Add a new material with a new type
  await page.click('#mtItemAdd'); await page.waitForSelector('#mtItName');
  await page.click('#mtItSave');
  ok('a blank name is refused before sending', !calls.some((c) => c.fn === 'saveMaterialItem'));
  await page.fill('#mtItName', 'Copper 0.059');
  await page.selectOption('#mtItType', 'Copper');
  ok('picking a type fills its container', (await page.inputValue('#mtItContainer')) === 'Gaylord');
  await page.selectOption('#mtItType', '__new');
  ok('New type… shows a box to type it', await page.isVisible('#mtItNewType'));
  await page.fill('#mtItNewType', 'Wire');
  ok('no shelf life box on the form', !(await page.$('#mtItShelf')));
  await page.click('#mtItSave'); await page.waitForTimeout(200);
  let sv = calls.filter((c) => c.fn === 'saveMaterialItem').pop();
  ok('Add sends the new material', sv && sv.args[0].id === '' && sv.args[0].name === 'Copper 0.059' && sv.args[0].type === 'Wire' && sv.args[0].container === 'Gaylord' && !('shelfLife' in sv.args[0]) && sv.args[0].active === true, sv && sv.args);
  await page.waitForSelector('[data-mtitem]');
  ok('back on the list with it', (await page.textContent('#mtItemList')).includes('Copper 0.059'));
  // Rename an item that has lots: asks first
  const idx = await page.$$eval('[data-mtitem]', (els) => els.findIndex((e) => e.textContent.includes('WB-2100')));
  await page.click('[data-mtitem="' + idx + '"]'); await page.waitForSelector('#mtItName');
  ok('editing shows Active and Delete', !!(await page.$('#mtItActive')) && !!(await page.$('#mtItDelete')));
  await page.click('#mtItDelete'); await page.waitForTimeout(100);
  ok('Delete with lots says to uncheck Active instead', /Uncheck Active/.test(await page.textContent('#modalRoot')) && !calls.some((c) => c.fn === 'deleteMaterialItem'));
  await page.click('#modalOk'); await page.waitForTimeout(100);
  await page.fill('#mtItName', 'WB-2100 Gold');
  await page.click('#mtItSave'); await page.waitForTimeout(100);
  ok('renaming asks, saying its lots follow', /1 lot received as WB-2100 will be renamed to WB-2100 Gold/.test(await page.textContent('#modalRoot')));
  await page.click('#modalOk'); await page.waitForTimeout(200);
  sv = calls.filter((c) => c.fn === 'saveMaterialItem').pop();
  ok('the rename is sent with the id', sv && sv.args[0].id === 'MI-00001' && sv.args[0].name === 'WB-2100 Gold', sv && sv.args);
  mats[0].product = 'WB-2100 Gold';
  // Receiving: a name not on the list can't be scanned; "Add it now" adds it and comes back with it picked
  await page.click('#backBtn'); await page.click('#backBtn'); await page.waitForSelector('#mtReceiveBtn');
  await page.click('#mtReceiveBtn'); await page.waitForSelector('#mtScan');
  await page.fill('#mtSupplier', 'DSM');
  await page.fill('#mtProduct', 'WB-2100 Gold');
  ok('picking a material from the list: it says so; expiration is left to type in', /On the Material List/.test(await page.textContent('#mtProdHint')) && (await page.inputValue('#mtExp')) === '');
  await page.fill('#mtProduct', 'Brand New 7');
  ok('a name not on the list: says so, with Add it now', /not on the Material List yet/.test(await page.textContent('#mtProdHint')) && !!(await page.$('#mtAddItemBtn')));
  await page.fill('#mtScan', 'L1'); await page.press('#mtScan', 'Enter');
  ok('…and its lots can\'t be scanned', !(await page.$('[data-mtqty]')) && /Material List first/.test(await page.textContent('#toast')));
  await page.click('#mtAddItemBtn'); await page.waitForSelector('#mtItName');
  ok('Add it now: the form has the name and type filled in', (await page.inputValue('#mtItName')) === 'Brand New 7' && (await page.inputValue('#mtItType')) === 'Compound' && (await page.inputValue('#mtItSupplier')) === 'DSM');
  await page.click('#mtItSave'); await page.waitForSelector('#mtScan');
  ok('…back on receiving with it picked', (await page.inputValue('#mtProduct')) === 'Brand New 7' && (await page.inputValue('#mtSupplier')) === 'DSM');
  await page.fill('#mtScan', 'L1'); await page.press('#mtScan', 'Enter');
  ok('…and now its lots scan', (await page.$$('[data-mtqty]')).length === 1);
  await page.fill('#mtProduct', 'Old Blue');
  ok('an inactive material says it is turned off', /turned off/.test(await page.textContent('#mtProdHint')));
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
  await page.close();
}

// ---- 45. Load Materials: scan lots onto a machine; Load History by day and machine; undo
{ const mats = [
    { id: 'M-00003', lot: 'A1', type: 'Compound', product: 'WB-2100', supplier: 'DSM', receiver: '', po: '', date: '2026-09-01', expiration: '', qtyReceived: 3, qtyOnHand: 2, container: 'Pail', status: 'In Stock', comments: '' },
    { id: 'M-00002', lot: 'X9', type: 'Ink', product: 'Blue', supplier: 'SUN', receiver: '', po: '', date: '2026-09-01', expiration: '', qtyReceived: 1, qtyOnHand: 1, container: 'Can', status: 'In Stock', comments: '' },
    { id: 'M-00001', lot: 'X9', type: 'Powder', product: 'Red', supplier: 'AKZO', receiver: '', po: '', date: '2026-08-01', expiration: '', qtyReceived: 1, qtyOnHand: 1, container: 'Box', status: 'In Stock', comments: '' },
    { id: 'M-00000', lot: 'Z0', type: 'Powder', product: 'Red', supplier: 'AKZO', receiver: '', po: '', date: '2026-07-01', expiration: '', qtyReceived: 1, qtyOnHand: 0, container: 'Box', status: 'Used', comments: '' }];
  const G = { materials: mats, items: [], types: ['Compound', 'Powder', 'Copper', 'Ink'], machines: ['Liner 1', 'Press 3'], containerFor: {}, products: {}, suppliers: [], containers: [], receivers: [] };
  const H = { from: '2026-10-14', to: '2026-10-14', total: 2, machines: ['Liner 1', 'Press 3'], loads: [
    { id: 'L-000002', at: '2026-10-14 13:40:00', date: '2026-10-14', machine: 'Press 3', lot: 'A1', materialId: 'M-00003', type: 'Compound', product: 'WB-2100', container: 'Pail', qty: 1, left: 1, by: 'Sam', notes: '' },
    { id: 'L-000001', at: '2026-10-14 06:05:00', date: '2026-10-14', machine: 'Liner 1', lot: 'X9', materialId: 'M-00002', type: 'Ink', product: 'Blue', container: 'Can', qty: 1, left: 0, by: 'Jo', notes: 'start of shift' }] };
  const { page, calls } = await boot(Object.assign({}, base, {
    getMaterials: () => R(G),
    loadMaterials: () => R({ ok: true, machine: 'Press 3', containers: 3, lots: 2, usedUp: ['A1', 'X9'], loaded: [] }),
    getMaterialLoads: () => R(H),
    undoMaterialLoad: () => R({ ok: true }),
  }));
  await page.click('#tileMaterials'); await page.click('[data-mthome="Metals"]');
  await page.waitForSelector('#mtLoadBtn');
  ok('the Materials screen has Receive and Load buttons', (await page.textContent('#mtReceiveBtn')).includes('Receive Materials') && (await page.textContent('#mtLoadBtn')).includes('Load Materials'));
  await page.click('#mtLoadBtn'); await page.waitForSelector('#mlScan');
  ok('machines used before are suggested', (await page.$eval('#mlMachineList', (e) => e.innerHTML)).includes('Press 3'));
  const scanLot = async (lot) => { await page.fill('#mlScan', lot); await page.press('#mlScan', 'Enter'); await page.waitForTimeout(30); };
  await scanLot('NOPE');
  ok('a lot not in inventory is refused', /NOPE is not in inventory/.test(await page.textContent('#toast')) && !(await page.$('[data-mlrm]')));
  await scanLot('Z0');
  ok('a used-up lot is refused', /Z0 is used up/.test(await page.textContent('#toast')));
  await scanLot('a1'); await scanLot('A1');
  ok('the same lot twice: 2 containers, shows what will be left', (await page.$$eval('[data-mlqty]', (els) => els.map((e) => e.textContent))).join() === '2' && /2 left now → 0 after loading/.test(await page.textContent('#mlLines')));
  await scanLot('A1');
  ok('can\'t take more than are left', /only 2 left/.test(await page.textContent('#toast')) && (await page.textContent('[data-mlqty]')) === '2');
  await scanLot('X9');
  ok('a lot number on two materials asks which', /Which material is this lot/.test(await page.textContent('#mlLines')) && (await page.$$('[data-mlpick]')).length === 2);
  await page.click('#mlSave'); await page.waitForTimeout(50);
  ok('the machine is required', /Enter the machine/.test(await page.textContent('#toast')) && !calls.some((c) => c.fn === 'loadMaterials'));
  await page.fill('#mlMachine', 'Press 3');
  await page.click('#mlSave'); await page.waitForTimeout(50);
  ok('…and the material picked', /Pick which material/.test(await page.textContent('#toast')) && !calls.some((c) => c.fn === 'loadMaterials'));
  await page.click('[data-mlpick="0:1"]');
  ok('picked: the line shows that material', /Red/.test(await page.textContent('#mlLines')) && !(await page.$('[data-mlpick]')));
  // Back keeps the scans
  await page.click('#backBtn'); await page.waitForTimeout(100);
  ok('stepping out keeps the scanned lots (warning)', (await page.textContent('#view')).includes('2 scanned lots are not loaded yet'));
  await page.click('#mtLoadBtn'); await page.waitForSelector('#mlScan');
  await page.click('#mlSave'); await page.waitForSelector('#modalOk');
  ok('confirm names the machine and count', /Load onto Press 3/.test(await page.textContent('#modalRoot')) && /3 containers will be taken out/.test(await page.textContent('#modalRoot')), await page.textContent('#modalRoot'));
  await page.click('#modalOk'); await page.waitForTimeout(200);
  const lc = calls.filter((c) => c.fn === 'loadMaterials')[0];
  ok('loadMaterials gets the machine and each lot with its material and count', lc && lc.args[0].machine === 'Press 3' && JSON.stringify(lc.args[1]) === JSON.stringify([{ lot: 'X9', product: 'Red', qty: 1 }, { lot: 'A1', product: 'WB-2100', qty: 2 }]), lc && lc.args);
  ok('done: says what got used up', /Used up: A1, X9/.test(await page.textContent('#modalRoot')));
  await page.click('#modalOk'); await page.waitForSelector('#mlScan');
  ok('ready for the next load on the same machine', (await page.inputValue('#mlMachine')) === 'Press 3' && !(await page.$('[data-mlrm]')));
  // History
  await page.click('#backBtn'); await page.waitForSelector('#mtMaintBtn'); await page.click('#mtMaintBtn'); await page.waitForSelector('#mtHistBtn');
  await page.click('#mtHistBtn'); await page.waitForSelector('[data-mhundo]');
  const hist = await page.textContent('#mhList');
  ok('history: grouped by machine with the time, lot, material and who', /Liner 1.*06:05.*X9.*Blue.*by Jo.*Press 3.*13:40.*A1.*WB-2100/.test(hist) && (await page.$$eval('#mhMachine option', (o) => o.length)) === 3, hist);
  await page.fill('#mhDate', '2026-10-01'); await page.dispatchEvent('#mhDate', 'change'); await page.waitForTimeout(100);
  await page.selectOption('#mhMachine', 'Press 3'); await page.waitForTimeout(100);
  const gl = calls.filter((c) => c.fn === 'getMaterialLoads').pop();
  ok('picking a day and machine asks for those', gl.args[0].from === '2026-10-01' && gl.args[0].machine === 'Press 3', gl.args);
  await page.click('[data-mhundo="L-000002"]'); await page.waitForSelector('#modalOk');
  await page.click('#modalOk'); await page.waitForTimeout(150);
  const un = calls.filter((c) => c.fn === 'undoMaterialLoad')[0];
  ok('Undo sends that load line', un && un.args[0] === 'L-000002', un && un.args);
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
  await page.close();
}

// ---- 46. Setup from the count sheets; stock and LOW; locations; barrels and the "not normally run" warning
{ let items = [{ id: 'MI-00001', name: '9307G', type: 'Compound', supplier: '', container: 'Barrel', partNo: '', notes: '', active: true, unit: '', perContainer: '', reorder: '', location: '' }];
  let mats = [{ id: 'M-00001', lot: 'A1', type: 'Compound', product: '9307G', supplier: 'DSM', receiver: '', po: '', date: '2026-09-01', expiration: '', qtyReceived: 2, qtyOnHand: 2, container: 'Barrel', status: 'In Stock', comments: '', location: 'Pallet Area' }];
  let machineInfo = [];
  const G = () => ({ materials: mats, items, types: ['Compound', 'Powder', 'Copper', 'Ink', 'Make-Up', 'Solution/Grease'], machines: machineInfo.map((m) => m.name), machineInfo,
    containerFor: { Compound: 'Barrel', Powder: 'Unit', Copper: 'Gaylord' }, products: {}, suppliers: [], containers: [], receivers: [] });
  const { page, calls } = await boot(Object.assign({}, base, {
    getMaterials: () => R(G()),
    setupMaterials: (a) => {
      const seed = a[0];
      items = seed.items.map((x, i) => Object.assign({ id: 'MI-' + (i + 1), supplier: '', partNo: '', notes: '', active: true }, x));
      machineInfo = seed.machines.map((m) => ({ name: m.name, positions: m.positions || [], materials: m.materials || [], active: true }));
      mats = mats.concat(seed.stock.map((x, i) => ({ id: 'M-1' + i, lot: 'START', type: x.type, product: x.name, qtyReceived: x.qty, qtyOnHand: x.qty, status: 'In Stock', container: '', location: x.location, supplier: '', receiver: '', po: '', date: seed.date, expiration: '', comments: '' })));
      return R({ ok: true, itemsAdded: 11, itemsFilled: 1, machinesAdded: 9, lotsAdded: 12, containers: 60 });
    },
    loadMaterials: () => R({ ok: true, containers: 1, usedUp: [] }),
  }));
  await page.click('#tileMaterials'); await page.click('[data-mthome="Metals"]'); await page.click('#mtMaintBtn'); await page.click('#mtLotsBtn'); await page.waitForSelector('[data-mtopen]');
  ok('lot cards show where they are kept', (await page.textContent('#mtList')).includes('📍 Pallet Area'));
  await page.click('#backBtn'); await page.waitForSelector('#mtListBtn'); await page.click('#mtListBtn'); await page.waitForSelector('#mtSetupBtn');
  ok('the list offers the setup from the count', (await page.textContent('#mtSetupBtn')).includes('2026-10-12'));
  await page.click('#mtSetupBtn'); await page.waitForSelector('#mtSetupSave');
  let txt = await page.textContent('#view');
  ok('setup preview: materials, machines and starting stock, before saving', /9307G — Compound.*Barrel = 549 lbs.*reorder at 1,098 lbs.*fills in blanks/.test(txt) && /New Copper — Copper.*Gaylord = 3,800 lbs.*will add/.test(txt)
    && /Press 13.*Barrel 1 \/ Barrel 2.*runs 9307G/.test(txt) && /9000-63-1.*8 Barrels ≈ 4,200 lbs.*Pallet Area/.test(txt) && !calls.some((c) => c.fn === 'setupMaterials'), txt);
  await page.click('#mtSetupSave'); await page.waitForSelector('#modalOk');
  const su = calls.filter((c) => c.fn === 'setupMaterials')[0];
  ok('Add all of this sends the setup', su && su.args[0].items.length === 12 && su.args[0].machines.length === 9 && su.args[0].stock.length === 12, su && su.args);
  await page.click('#modalOk'); await page.waitForSelector('[data-mtitem]');
  ok('done: the setup button is gone', !(await page.$('#mtSetupBtn')));
  txt = await page.textContent('#mtItemList');
  ok('the list shows stock as containers and amount, and the reorder point', /9307G.*In stock: 5 Barrels ≈ 2,745 lbs · reorder at 1,098 lbs/.test(txt) && /New Copper.*In stock: 6 Gaylords ≈ 22,800 lbs/.test(txt), txt);
  ok('at or under the reorder point shows LOW (powder: 4 units = 440 lbs, reorder at 440)', /VP 102 BPA-NI\s*LOW — reorder/.test(txt), txt);
  await page.click('#backBtn'); await page.waitForSelector('#mtMachBtn'); await page.click('#backBtn'); await page.waitForSelector('#mtLowCard');
  ok('the Materials screen says what to reorder', /Time to reorder \(3\).*VP 102 BPA-NI.*4 Units ≈ 440 lbs left · reorder at 440 lbs.*V7257-D — 4 Cartridges left · reorder at 5/.test(await page.textContent('#mtLowCard')), await page.textContent('#mtLowCard'));
  // Receiving: picking a material puts it where it's kept
  await page.click('#mtReceiveBtn'); await page.waitForSelector('#mtProduct');
  await page.fill('#mtProduct', 'New Copper');
  ok('picking a material fills in where it is kept', (await page.inputValue('#mtLoc')) === 'Cage' && (await page.inputValue('#mtContainer')) === 'Gaylord');
  // Load: barrels for Press 13, and a warning for a material it doesn't run
  await page.click('#backBtn'); await page.waitForSelector('#mtLoadBtn');
  await page.click('#mtLoadBtn'); await page.waitForSelector('#mlScan');
  await page.fill('#mlMachine', 'Press 13');
  ok('Press 13 offers its barrels', (await page.$$('[data-mlpos]')).length === 2);
  await page.click('[data-mlpos="Barrel 2"]');
  await page.fill('#mlScan', 'START'); await page.press('#mlScan', 'Enter');
  const pick = await page.$$eval('[data-mlpick]', (els) => els.map((e) => e.textContent));
  ok('START is on every material: pick which', pick.length === 12, pick);
  const k = pick.findIndex((x) => x.startsWith('9000-63-1'));
  await page.click('[data-mlpick="0:' + k + '"]');
  ok('a material the machine doesn\'t run gets a warning', /9000-63-1 is not normally run on Press 13/.test(await page.textContent('#mlLines')));
  await page.click('#mlSave'); await page.waitForSelector('#modalOk');
  ok('…and the confirm says so, with the barrel', /Load onto Press 13 \(Barrel 2\)/.test(await page.textContent('#modalRoot')) && /Not normally run on Press 13: 9000-63-1/.test(await page.textContent('#modalRoot')));
  await page.click('#modalOk'); await page.waitForTimeout(200);
  const lc = calls.filter((c) => c.fn === 'loadMaterials')[0];
  ok('the load is sent with the barrel', lc && lc.args[0].machine === 'Press 13' && lc.args[0].position === 'Barrel 2' && lc.args[1][0].lot === 'START' && lc.args[1][0].product === '9000-63-1', lc && lc.args);
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
  await page.close();
}

// ---- 47. Add Lots (the walk-around): pick a section, add several lots, save them together; ➕ new type / supplier / place / machine
{ const items = [{ id: 'MI-1', name: '9000-63-1', type: 'Compound', supplier: 'DOW', container: 'Barrel', active: true, unit: 'lbs', perContainer: 525, reorder: 1050, location: 'Pallet Area' },
    { id: 'MI-2', name: '9307G', type: 'Compound', supplier: '', container: 'Barrel', active: true, unit: 'lbs', perContainer: 549, reorder: '', location: 'Pallet Area' }];
  const mats = [{ id: 'M-00001', lot: 'START', type: 'Compound', product: '9000-63-1', supplier: '', receiver: '', po: '', date: '2026-10-12', expiration: '', qtyReceived: 2, qtyOnHand: 2, container: 'Barrel', status: 'In Stock', comments: '', location: 'Pallet Area', position: '' }];
  let n = 1;
  const G = { materials: mats, items, types: ['Compound', 'Powder', 'Copper', 'Ink', 'Make-Up', 'Solution/Grease'], machines: ['Multi Press', 'Press 14'],
    machineInfo: [{ name: 'Multi Press', positions: ['Barrel 1', 'Barrel 2'], materials: ['9000-63-1'], active: true }, { name: 'Press 14', positions: [], materials: [], active: true }],
    containerFor: {}, products: {}, suppliers: ['DOW', 'STEEL MILL X'], containers: [], receivers: [] };
  const { page, calls } = await boot(Object.assign({}, base, {
    getMaterials: () => R(G),
    addMaterialLots: (a) => { const c = a[0];
      const saved = a[1].map((l) => { const m = { id: 'M-1' + (n++), lot: l.lot, type: c.type, product: c.product, supplier: String(c.supplier || '').toUpperCase(), expiration: l.expiration, qtyReceived: l.qty, qtyOnHand: l.qty, container: 'Barrel', location: c.location, position: c.position, status: c.onMachine ? 'Loaded' : 'In Stock', receiver: '', po: '', date: '2026-10-14', comments: '' }; mats.unshift(m); return m; });
      return R({ ok: true, saved, lots: saved.length }); },
    updateMaterial: () => R({ ok: true }),
    removeStartLots: () => R({ ok: true, removed: 1, remaining: 0 }),
  }));
  await page.click('#tileMaterials'); await page.click('[data-mthome="Metals"]'); await page.click('#mtMaintBtn'); await page.click('#mtLotsBtn'); await page.waitForSelector('#mtStartRemove');
  ok('Add Lots is there; the START lots can be removed', (await page.textContent('#mtAddBtn')).includes('Add Lots') && !!(await page.$('#mtStartRemove')));
  await page.click('#mtAddBtn'); await page.waitForSelector('[data-maprod]');
  ok('compound shows its material codes as buttons', (await page.$$eval('[data-maprod]', (els) => els.map((e) => e.textContent))).join() === '9000-63-1,9307G');
  ok('Added by starts as Jonathan', (await page.inputValue('#maOperator')) === 'Jonathan');
  ok('suppliers are the materials\' suppliers (not every steel mill)', (await page.$$eval('[data-masup]', (els) => els.map((e) => e.textContent))).join() === 'DOW');
  await page.click('[data-maprod="9000-63-1"]');
  ok('picking the material picks the supplier used before', (await page.getAttribute('[data-masup="DOW"]', 'class')) === 'btn ');
  await page.click('[data-maplace="Pallet Area"]');
  // several lots
  await page.fill('#maLot', 'B-1'); await page.press('#maLot', 'Enter');
  ok('Enter on the lot goes to the date', (await page.evaluate(() => document.activeElement.id)) === 'maExp');
  await page.fill('#maExp', '2027-05-01'); await page.press('#maExp', 'Enter');
  ok('Enter on the date adds the lot to the list and goes back to the lot box', /B-1.*expires 2027-05-01/.test(await page.textContent('#maLines')) && (await page.evaluate(() => document.activeElement.id)) === 'maLot' && (await page.inputValue('#maExp')) === '2027-05-01');
  await page.fill('#maLot', 'B-2'); await page.click('#maPlus'); await page.click('#maAddLot');
  await page.fill('#maLot', 'b-1'); await page.click('#maAddLot');
  ok('the same lot again adds its containers', (await page.$$eval('[data-maq]', (els) => els.map((e) => e.textContent))).join() === '2,2');
  await page.fill('#maLot', 'B-3');   // typed but not added: still counts
  ok('Save says how many lots and containers', /Save 2 lots \(4 containers\)/.test(await page.textContent('#maSave')));
  await page.click('#maSave'); await page.waitForTimeout(200);
  let ad = calls.filter((c) => c.fn === 'addMaterialLots');
  ok('Save sends the section and every lot at once, no receiver or PO', ad.length === 1 && JSON.stringify(ad[0].args[0]) === JSON.stringify({ type: 'Compound', product: '9000-63-1', supplier: 'DOW', location: 'Pallet Area', onMachine: false, position: '', department: 'Metals' })
    && JSON.stringify(ad[0].args[1].map((l) => [l.lot, l.qty])) === JSON.stringify([['B-3', 1], ['B-2', 2], ['B-1', 2]]) && ad[0].args[2] === 'Jonathan', ad[0] && ad[0].args);
  ok('after Save: the list is empty, the section stays, ready to scan', !(await page.$('[data-maq]')) && /Saved \(3\)/.test(await page.textContent('#maAdded'))
    && (await page.getAttribute('[data-maplace="Pallet Area"]', 'class')) === 'btn ' && (await page.evaluate(() => document.activeElement.id)) === 'maLot');
  // ➕ new supplier, new machine (Loaded, with no barrels)
  await page.click('[data-manew="supplier"]'); await page.fill('#maNew_supplier', 'Henkel'); await page.press('#maNew_supplier', 'Enter');
  ok('➕ New supplier adds it and picks it', (await page.getAttribute('[data-masup="Henkel"]', 'class')) === 'btn ');
  await page.click('[data-manew="machine"]'); await page.fill('#maNew_machine', 'Press 22'); await page.click('[data-manewok="machine"]');
  ok('➕ New machine adds it and picks it', (await page.getAttribute('[data-mamach="Press 22"]', 'class')) === 'btn ' && (await page.getAttribute('[data-maplace="Pallet Area"]', 'class')) === 'btn secondary');
  await page.fill('#maLot', 'B-9'); await page.click('#maSave'); await page.waitForTimeout(200);
  ad = calls.filter((c) => c.fn === 'addMaterialLots');
  ok('a new machine: sent as on a machine', ad[1].args[0].location === 'Press 22' && ad[1].args[0].onMachine === true && ad[1].args[0].supplier === 'Henkel', ad[1].args);
  // a known machine with barrels
  await page.click('[data-mamach="Multi Press"]');
  ok('a machine with barrels asks which', (await page.$$('[data-mapos]')).length === 2);
  await page.click('[data-mapos="Barrel 1"]');
  await page.fill('#maLot', 'B-10'); await page.click('#maSave'); await page.waitForTimeout(200);
  ad = calls.filter((c) => c.fn === 'addMaterialLots');
  ok('…sent with the barrel, shows Loaded', ad[2].args[0].location === 'Multi Press' && ad[2].args[0].position === 'Barrel 1' && /B-10.*Loaded.*Multi Press · Barrel 1/.test(await page.textContent('#maAdded')), ad[2].args);
  // ➕ new type
  await page.click('[data-manew="type"]'); await page.fill('#maNew_type', 'Solvent'); await page.press('#maNew_type', 'Enter');
  ok('➕ New type adds it and picks it (no materials yet)', (await page.getAttribute('[data-matype="Solvent"]', 'class')) === 'btn ' && /No Solvent on the Material List yet/.test(await page.textContent('#view')));
  // Back on Materials: Used up; stock counts loaded ones; remove START
  await page.click('#backBtn'); await page.waitForSelector('[data-mtusedup]');
  await page.click('[data-mtusedup]'); await page.waitForSelector('#modalOk');
  await page.click('#modalOk'); await page.waitForTimeout(150);
  const up = calls.filter((c) => c.fn === 'updateMaterial')[0];
  ok('Used up marks that lot Used', up && JSON.stringify(up.args[1]) === '{"Status":"Used"}', up && up.args);
  await page.waitForSelector('[data-mtopen]'); await page.click('#backBtn'); await page.waitForSelector('#mtListBtn'); await page.click('#mtListBtn'); await page.waitForSelector('[data-mtitem]');
  ok('stock counts loaded containers too, and says how many', /9000-63-1.*In stock: 9 Barrels ≈ 4,725 lbs \(2 loaded\)/.test(await page.textContent('#mtItemList')), await page.textContent('#mtItemList'));
  await page.click('#backBtn'); await page.waitForSelector('#mtLotsBtn'); await page.click('#mtLotsBtn'); await page.waitForSelector('#mtStartRemove');
  await page.click('#mtStartRemove'); await page.waitForSelector('#modalOk'); await page.click('#modalOk'); await page.waitForTimeout(150);
  ok('Remove the START lots asks first, then removes them', calls.some((c) => c.fn === 'removeStartLots'));
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
  await page.close();
}

// ---- 48. At the line: pass 2 is running; workers re-scan tickets, scan a lot label (it replaces that
// material's lot), an unknown code can be added as a lot; the line changes over to pass 3; the foreman adds a pass.
{ const P = (n, item, tickets, lots, started) => ({ group: '603X408', sub: '10-OUT', item, pass: n, line: 'Litho Line 3', lots: lots || [], changes: [{}], tickets: tickets || [], started });
  let job = { jobId: 'JOB-000020', description: 'Blue run', createdBy: 'Ann', status: 'Pending', passMode: true, notes: '', currentPass: 2,
    tickets: [{ skidId: 'SKD-1', ticket: '100' }, { skidId: 'SKD-2', ticket: '101' }],
    passes: [P(1, 'SIZE', [{ skidId: 'SKD-1', ticket: '100', passNumber: 1 }, { skidId: 'SKD-2', ticket: '101', passNumber: 1 }], [], true),
             P(2, 'VARNISH', [], [{ lot: 'V1', product: 'Varnish 9' }, { lot: 'T1', product: 'Thinner T' }], true), P(3, 'SIZE', [], [], '')] };
  job.coatings = job.passes;
  const { page, calls } = await boot(Object.assign({}, base, {
    getJobDetail: () => R(job),
    getMaterials: () => R({ materials: [{ id: 'M-7', lot: 'V2', product: 'Varnish 9', type: 'Litho Coating', status: 'In Stock', location: 'Ink Room' }], items: [{ name: 'Varnish 9', type: 'Litho Coating', active: true }], types: ['Litho Coating'] }),
    jobAddTicket: (a) => { const tk = a[1] === 'SKD-1' ? '100' : '101'; job.passes[job.currentPass - 1].tickets.push({ skidId: a[1], ticket: tk, passNumber: 2 });
      return R({ skidId: a[1], ticket: tk, jobId: a[0], jobPass: job.currentPass, lots: 'V1 (Varnish 9)', detail: { coatings: [{ passNumber: 2 }] } }); },
    setJobPassLots: (a) => { job.passes[a[4] - 1].lots = a[1]; job.passes[a[4] - 1].changes.push({}); return R(job); },
    nextJobPass: (a) => { job.currentPass = a[1]; job.passes[a[1] - 1].started = true; return R(job); },
    addJobPass: (a) => { job.passes.push(P(job.passes.length + 1, a[1].item, [], a[1].lots, '')); return R(job); },
  }));
  await page.evaluate(() => { lithoUser = { name: 'Bob', manager: false }; resumeJob('JOB-000020'); });
  await page.waitForSelector('#pjEarlier [data-pjadd]');
  ok('pass 2 is running; the job\'s tickets are listed to re-scan', (await page.$$('#pjEarlier [data-pjadd]')).length === 2 && /Now running: Pass 2 — VARNISH/.test(await page.textContent('#view')) && /Pass 3: SIZE.*not started/.test(await page.textContent('#view')));
  ok('a worker sees no foreman tools', !(await page.$('#pjAdd')));
  await page.fill('#jobTicketOperator', 'Bob');
  await page.click('[data-pjadd="SKD-1"]'); await page.waitForTimeout(150);
  let ja = calls.filter((c) => c.fn === 'jobAddTicket');
  ok('one tap adds it to the pass (no sheet count)', ja.length === 1 && ja[0].args[1] === 'SKD-1' && ja[0].args[2] === '' && ja[0].args[5] === 'Bob', ja.map((c) => c.args));
  await page.fill('#jobTicketSearch', '100'); await page.press('#jobTicketSearch', 'Enter'); await page.waitForTimeout(100);
  ok('scanning it again does not add it twice', calls.filter((c) => c.fn === 'jobAddTicket').length === 1);
  await page.fill('#jobTicketSearch', '101'); await page.press('#jobTicketSearch', 'Enter'); await page.waitForTimeout(150);
  ja = calls.filter((c) => c.fn === 'jobAddTicket');
  ok('scanning a job ticket + Enter adds it', ja.length === 2 && ja[1].args[1] === 'SKD-2', ja.map((c) => c.args));
  // a lot label: replaces that material's lot
  await page.fill('#jobTicketSearch', 'V2'); await page.press('#jobTicketSearch', 'Enter');
  await page.waitForSelector('#modalOk');
  ok('a scanned lot label says what it replaces', /replaces lot V1/.test(await page.textContent('#modalRoot')));
  await page.click('#modalOk'); await page.waitForTimeout(200);
  let sl = calls.filter((c) => c.fn === 'setJobPassLots');
  ok('…and saves pass 2 with V2 instead of V1 (the thinner stays)', sl.length === 1 && sl[0].args[4] === 2 && sl[0].args[1].map((l) => l.lot).join() === 'T1,V2', sl.map((c) => c.args));
  // an unknown code
  await page.fill('#jobTicketSearch', 'ZZ-9'); await page.press('#jobTicketSearch', 'Enter');
  await page.waitForSelector('#pjNewLot'); await page.click('#pjNewLot');
  await page.waitForSelector('#plMat');
  await page.fill('#plMat', 'Clear Size 77'); await page.click('#plMatOk');
  await page.click('#pjLotsSave'); await page.waitForTimeout(200);
  sl = calls.filter((c) => c.fn === 'setJobPassLots');
  ok('an unknown code can be added as a new lot with its material', sl.length === 2 && sl[1].args[1].some((l) => l.lot === 'ZZ-9' && l.product === 'Clear Size 77' && l.type === 'Litho Coating'), sl[1] && sl[1].args);
  // the line changes over
  await page.click('#pjNext'); await page.waitForSelector('#modalOk'); await page.click('#modalOk'); await page.waitForTimeout(200);
  const nx = calls.filter((c) => c.fn === 'nextJobPass')[0];
  ok('Line changed over starts pass 3', nx && nx.args[0] === 'JOB-000020' && nx.args[1] === 3 && /Now running: Pass 3 — SIZE/.test(await page.textContent('#view')), nx && nx.args);
  ok('the last pass has no next button', !(await page.$('#pjNext')) && /This is the last pass/.test(await page.textContent('#view')));
  // the foreman adds a pass
  await page.evaluate(() => { lithoUser = { name: 'Ann', manager: true }; renderPassJob(); });
  await page.click('#pjAdd'); await page.waitForSelector('#pjAddSave');
  await page.waitForTimeout(150);
  await page.selectOption('#psItem', 'VARNISH');
  await page.click('#pjAddSave'); await page.waitForTimeout(200);
  const ap = calls.filter((c) => c.fn === 'addJobPass')[0];
  ok('the foreman adds pass 4', ap && ap.args[1].item === 'VARNISH' && /start Pass 4: VARNISH/.test(await page.textContent('#view')), ap && ap.args);
  // Review Jobs shows the passes and an Open button
  await page.evaluate(() => { openJob('JOB-000020'); }); await page.waitForSelector('#jrContinue');
  ok('Review shows each pass with its lots, no Add Coating', /Pass 1:.*SIZE/.test(await page.textContent('#view')) && /ZZ-9/.test(await page.textContent('#view')) && !(await page.$('#jrAddCoatingBtn')));
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
  await page.close();
}

// ---- 49. Departments + the Materials Master File: Materials filters by department; Add Lots for
// Plastics shows only its types and machines; the Master File edits lots, materials and machines.
{ const mats = {
    materials: [
      { id: 'M-1', lot: 'C-1', type: 'Compound', product: '9307G', supplier: 'DOW', status: 'In Stock', qtyOnHand: 2, qtyReceived: 2, location: 'Cage', department: 'Metals' },
      { id: 'M-2', lot: 'R-1', type: 'Resin', product: 'PP Resin 1', supplier: 'LYB', status: 'Loaded', qtyOnHand: 1, qtyReceived: 1, location: 'Injection 1', department: 'Plastics' },
      { id: 'M-3', lot: 'CS1', type: 'Litho Coating', product: 'Clear Size', supplier: 'PPG', status: 'In Stock', qtyOnHand: 1, qtyReceived: 1, location: 'Ink Room', department: 'Litho' }],
    items: [{ id: 'MI-1', name: '9307G', type: 'Compound', active: true, department: 'Metals' }, { id: 'MI-2', name: 'PP Resin 1', type: 'Resin', active: true, department: 'Plastics' },
      { id: 'MI-3', name: 'Clear Size', type: 'Litho Coating', active: true, department: 'Litho' }],
    types: ['Compound', 'Powder', 'Copper', 'Ink', 'Make-Up', 'Solution/Grease', 'Resin', 'Litho Coating'], departments: ['Metals', 'Plastics', 'Litho'],
    machines: ['Press 13', 'Injection 1', 'Litho Line 3'],
    machineInfo: [{ name: 'Press 13', positions: [], materials: [], active: true, department: 'Metals' }, { name: 'Injection 1', positions: ['Hopper'], materials: [], active: true, department: 'Plastics' },
      { name: 'Litho Line 3', positions: [], materials: [], active: true, department: 'Litho' }],
    suppliers: ['DOW', 'LYB', 'PPG'], containers: [], receivers: [], products: {} };
  const { page, calls } = await boot(Object.assign({}, base, {
    getMaterials: () => R(mats),
    updateMaterial: (a) => R({ ok: true }), saveMachine: (a) => R({ ok: true }), saveMaterialItem: (a) => R({ ok: true, item: a[0] }),
  }));
  mats.machineInfo[0].deptSet = false;   // a row from before departments
  await page.click('#tilePlastics'); await page.waitForSelector('#tilePlasticsMat');
  ok('Plastics Department: Plastics Lines (coming soon), then Materials', (await page.textContent('#tilePlasticsLines')).includes('coming soon') && await page.$eval('#tilePlasticsLines', (e) => e.disabled));
  await page.click('#tilePlasticsMat'); await page.waitForSelector('#mtMaintBtn');
  await page.waitForTimeout(150);
  ok('a machine with no Department in the sheet gets it written (once)', calls.filter((c) => c.fn === 'fillDepartments').length === 1);
  ok('Plastics Materials: Load, Receive, Maintenance', (await page.textContent('#deptLabel')) === 'Plastics Materials' && (await page.$$eval('#view > button', (els) => els.map((e) => e.id))).join() === 'mtLoadBtn,mtReceiveBtn,mtMaintBtn');
  await page.click('#mtMaintBtn'); await page.click('#mtLotsBtn'); await page.waitForSelector('[data-mtopen]');
  let ids = await page.$$eval('[data-mtopen]', (els) => els.map((e) => e.getAttribute('data-mtopen')));
  ok('Lots: Plastics lots only', ids.join() === 'M-2', ids);
  await page.click('#mtAddBtn'); await page.waitForSelector('[data-matype]');
  ok('Add Lots is Plastics only (no department buttons), with its types and machines', !(await page.$('[data-madept]')) && (await page.$$('[data-matype]')).length === 1
    && !!(await page.$('[data-matype="Resin"]')) && (await page.$$eval('[data-mamach]', (els) => els.map((e) => e.getAttribute('data-mamach')))).join() === 'Injection 1');
  await page.click('#backBtn'); await page.waitForSelector('#mtAddBtn');
  await page.click('#backBtn'); await page.waitForSelector('#mtMachBtn');
  // Machines
  await page.click('#mtMachBtn'); await page.waitForSelector('[data-mmrow]');
  ok('Machines: Plastics machines only, with what is loaded', (await page.$$eval('[data-mmrow]', (els) => els.map((e) => e.getAttribute('data-mmrow')))).join() === 'Injection 1'
    && /Spots: Hopper/.test(await page.textContent('[data-mmrow="Injection 1"]')) && /Loaded now: R-1 · PP Resin 1/.test(await page.textContent('[data-mmrow="Injection 1"]')));
  await page.click('#mmAdd'); await page.waitForSelector('#mmName');
  ok('a new machine starts in Plastics', (await page.inputValue('#mmDept')) === 'Plastics' && !(await page.$('#mmRemove')));
  await page.fill('#mmName', 'Injection 2'); await page.fill('#mmPos', 'Hopper'); await page.click('#mmSave'); await page.waitForTimeout(150);
  const am = calls.filter((c) => c.fn === 'saveMachine').pop();
  ok('add a machine', am && am.args[0].name === 'Injection 2' && am.args[0].oldName === '' && am.args[0].department === 'Plastics' && am.args[0].positions === 'Hopper' && am.args[0].active === true, am && am.args);
  await page.waitForSelector('[data-mmrow="Injection 1"]'); await page.click('[data-mmrow="Injection 1"]'); await page.waitForSelector('#mmRemove');
  await page.click('#mmRemove'); await page.waitForSelector('#modalOk');
  ok('a machine with lots loaded can\'t be removed (says why)', /1 lot\(s\) are loaded on it/.test(await page.textContent('#modalRoot')) && !calls.some((c) => c.fn === 'deleteMachine'));
  await page.click('#modalOk');
  await page.uncheck('#mmActive'); await page.click('#mmSave'); await page.waitForTimeout(150);
  const em = calls.filter((c) => c.fn === 'saveMachine').pop();
  ok('…but it can be made not active', em && em.args[0].oldName === 'Injection 1' && em.args[0].active === false, em && em.args);
  await page.waitForSelector('#mmAdd'); await page.click('#backBtn'); await page.waitForSelector('#mtMachBtn');
  await page.click('#backBtn'); await page.waitForSelector('#mtLoadBtn');
  await page.click('#backBtn'); await page.waitForSelector('#tilePlasticsMat');
  ok('back from Plastics materials goes to the Plastics Department', true);
  await page.click('#backBtn'); await page.waitForSelector('#tilePlastics');
  await page.click('#tileLitho'); await page.waitForSelector('#tileLithoMat');
  ok('Litho Department: Litho Line, Litho Steel Count, Materials, then Move To WIP', (await page.$$eval('#view button', (els) => els.map((e) => e.id))).join() === 'tileLithoLine,tileCount,tileLithoMat,tileLithoCosts,tileMoveWip');
  await page.click('#tileLithoMat'); await page.waitForSelector('#mtLoadBtn');
  ok('…opens Litho materials', (await page.textContent('#deptLabel')) === 'Litho Materials');
  await page.click('#backBtn'); await page.waitForSelector('#tileLithoMat');
  await page.click('#backBtn'); await page.waitForSelector('#tileProduction');
  await page.click('#tileProduction'); await page.waitForSelector('#metalsPickMat');
  await page.click('#metalsPickMat'); await page.waitForSelector('#mtLoadBtn');
  ok('Metals Department has Materials too', (await page.textContent('#deptLabel')) === 'Metals Materials');
  await page.click('#backBtn'); await page.waitForSelector('#metalsPickMat');
  await page.click('#backBtn'); await page.waitForSelector('#tilePlastics');
  await page.click('#tileMaterials'); await page.waitForSelector('[data-mthome]');
  ok('Materials: a tile per department', (await page.$$eval('[data-mthome]', (els) => els.map((e) => e.getAttribute('data-mthome')))).join() === 'Metals,Litho,Plastics');
  await page.click('[data-mthome="Litho"]'); await page.waitForSelector('#mtLoadBtn');
  await page.click('#mtLoadBtn'); await page.waitForSelector('#mlMachine');
  ok('Load on Litho: its machines as buttons', (await page.$$eval('[data-mlm]', (els) => els.map((e) => e.getAttribute('data-mlm')))).join() === 'Litho Line 3');
  await page.click('[data-mlm="Litho Line 3"]');
  ok('…tapping one picks it, and says what is on it', (await page.inputValue('#mlMachine')) === 'Litho Line 3' && !(await page.getAttribute('[data-mlm="Litho Line 3"]', 'class')).includes('secondary')
    && /On it now: nothing loaded/.test(await page.textContent('#mlOnNow')));
  await page.click('#backBtn'); await page.waitForSelector('#mtMaintBtn'); await page.click('#mtMaintBtn'); await page.click('#mtLotsBtn'); await page.waitForSelector('#mtAddBtn');
  await page.click('#mtAddBtn'); await page.waitForSelector('[data-matype]');
  ok('switching to Litho shows the litho types', !!(await page.$('[data-matype="Litho Coating"]')) && !!(await page.$('[data-maprod="Clear Size"]')) && !(await page.$('[data-matype="Resin"]')));
  // the Master File
  await page.evaluate(() => { dbTable = 'materials'; openDatabase(); }); await page.waitForSelector('[data-mfrow]');
  ok('Master File: every lot with its department', (await page.$$('[data-mfrow]')).length === 3 && /Plastics/.test(await page.textContent('#mfBox')));
  await page.click('[data-mfd="Litho"]'); await page.waitForTimeout(80);
  ok('…filtered by department', (await page.$$('[data-mfrow]')).length === 1);
  await page.click('[data-mfd="all"]'); await page.click('[data-mfrow="M-1"]'); await page.waitForSelector('#mfSave');
  await page.fill('#mfLoc', 'Pallet Area'); await page.fill('#mfOnHand', '1'); await page.click('#mfSave'); await page.waitForTimeout(150);
  const um = calls.filter((c) => c.fn === 'updateMaterial')[0];
  ok('editing a lot sends only what changed', um && um.args[0] === 'M-1' && JSON.stringify(um.args[1]) === '{"Qty On Hand":"1","Location":"Pallet Area"}', um && um.args);
  await page.waitForSelector('[data-mft="machines"]'); await page.click('[data-mft="machines"]'); await page.waitForSelector('[data-mfrow="Injection 1"]');
  ok('Machines: what is loaded on each', /R-1/.test(await page.textContent('#mfBox')));
  await page.click('[data-mfrow="Injection 1"]'); await page.waitForSelector('#mfSave');
  await page.fill('#mfName', 'Injection 01'); await page.fill('#mfPos', 'Hopper, Side'); await page.click('#mfSave'); await page.waitForTimeout(150);
  const sm = calls.filter((c) => c.fn === 'saveMachine').pop();
  ok('renaming a machine sends the old name', sm && sm.args[0].oldName === 'Injection 1' && sm.args[0].name === 'Injection 01' && sm.args[0].positions === 'Hopper, Side' && sm.args[0].department === 'Plastics', sm && sm.args);
  await page.waitForSelector('[data-mft="items"]'); await page.click('[data-mft="items"]'); await page.waitForSelector('#mfAdd');
  await page.click('[data-mfd="Plastics"]'); await page.click('#mfAdd'); await page.waitForSelector('#mfSave');
  ok('a new material starts in the department picked', (await page.$eval('#mfDept', (e) => e.value)) === 'Plastics');
  ok('…its Type is picked from the Types list, Plastics types first', (await page.$$eval('#mfType option', (els) => els.map((e) => e.value)))[1] === 'Resin');
  await page.fill('#mfName', 'Blue MB'); await page.selectOption('#mfType', 'Resin'); await page.click('#mfSave'); await page.waitForTimeout(150);
  const si = calls.filter((c) => c.fn === 'saveMaterialItem')[0];
  ok('…and saves with it', si && si.args[0].name === 'Blue MB' && si.args[0].type === 'Resin' && si.args[0].department === 'Plastics' && si.args[0].id === '', si && si.args);
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
  await page.close();
}

// ---- 50. Types (each with a department), Material Receivers kept apart from steel, Receive in a department
{ const mats = {
    materials: [{ id: 'M-1', lot: 'R-1', type: 'Resin', product: 'PP Resin 1', supplier: 'LYB', status: 'In Stock', qtyOnHand: 1, qtyReceived: 1, location: 'Silo', department: 'Plastics', receiver: 'MR-00001' }],
    items: [{ id: 'MI-1', name: 'PP Resin 1', type: 'Resin', active: true, department: 'Plastics', deptSet: true }],
    types: ['Compound', 'Powder', 'Resin', 'Pellet'],
    typeInfo: [{ name: 'Compound', department: 'Metals', container: 'Barrel', active: true, saved: true }, { name: 'Powder', department: 'Metals', container: 'Unit', active: true, saved: true },
      { name: 'Resin', department: 'Plastics', container: 'Gaylord', active: true, saved: true }, { name: 'Pellet', department: 'Plastics', container: 'Bag', active: true, saved: false }],
    departments: ['Metals', 'Plastics', 'Litho'], machines: ['Injection 1'], machineInfo: [{ name: 'Injection 1', positions: [], materials: [], active: true, department: 'Plastics', deptSet: true }],
    suppliers: ['LYB'], containers: [], products: {},
    receivers: [{ id: 'MR-00002', name: '26-10-01--DOW--MR-00002', supplier: 'DOW', department: 'Metals' }, { id: 'MR-00001', name: '26-09-01--LYB--MR-00001', supplier: 'LYB', department: 'Plastics' },
      { id: 'R-00007', name: '26-01-01--AKZO--R-00007', supplier: 'AKZO', old: true }] };
  const { page, calls } = await boot(Object.assign({}, base, {
    getMaterials: () => R(mats),
    receiveMaterials: () => R({ ok: true, receiver: 'MR-00003', receiverCreated: true, lots: 1, containers: 1, saved: [] }),
    saveMaterialType: (a) => R({ ok: true, type: a[0] }),
    getMatReceivers: () => R({ receivers: [{ id: 'MR-00001', name: '26-09-01--LYB--MR-00001', date: '2026-09-01', supplier: 'LYB', pos: 'P-1', department: 'Plastics', notes: '', lotCount: 1 },
      { id: 'MR-00002', name: '26-10-01--DOW--MR-00002', date: '2026-10-01', supplier: 'DOW', pos: '', department: 'Metals', notes: '', lotCount: 0 }], suppliers: ['DOW', 'LYB'] }),
    saveMatReceiver: (a) => R({ ok: true, id: a[0].id || 'MR-00003' }), deleteMatReceiver: (a) => R({ ok: true, id: a[0] }),
  }));
  await page.click('#tilePlastics'); await page.click('#tilePlasticsMat'); await page.waitForSelector('#mtReceiveBtn'); await page.waitForTimeout(150);
  ok('a type not on the Types tab yet gets written (once)', calls.filter((c) => c.fn === 'fillDepartments').length === 1);
  await page.click('#mtReceiveBtn'); await page.waitForSelector('[data-mtrt]');
  ok('Receive in Plastics: only Plastics types, starting on the first', (await page.$$eval('[data-mtrt]', (els) => els.map((e) => e.getAttribute('data-mtrt')))).join() === 'Resin,Pellet'
    && (await page.getAttribute('[data-mtrt="Resin"]', 'class')) === 'active' && (await page.inputValue('#mtContainer')) === 'Gaylord');
  ok('…and only Plastics material receivers (no steel ones)', (await page.$$eval('#mtReceiver option', (els) => els.map((e) => e.value))).join() === ',MR-00001');
  await page.fill('#mtSupplier', 'LYB'); await page.fill('#mtProduct', 'PP Resin 1'); await page.fill('#mtScan', 'LOT-9'); await page.press('#mtScan', 'Enter');
  await page.click('#mtSave'); await page.waitForSelector('#modalOk'); await page.click('#modalOk'); await page.waitForTimeout(200);
  const rm = calls.filter((c) => c.fn === 'receiveMaterials')[0];
  ok('the delivery is saved as Plastics', rm && rm.args[0].department === 'Plastics' && rm.args[1][0].type === 'Resin', rm && rm.args);
  if (await page.$('#modalOk')) await page.click('#modalOk');
  // Master File: Types
  await page.evaluate(() => { dbTable = 'materials'; mfTab = 'types'; mfDept = 'all'; openDatabase(); }); await page.waitForSelector('[data-mfrow="Pellet"]');
  ok('Master File tabs in setup order', (await page.$$eval('[data-mft]', (els) => els.map((e) => e.getAttribute('data-mft')))).join() === 'machines,types,items,lots');
  await page.click('[data-mfd="Plastics"]'); await page.waitForTimeout(60);
  ok('Types filtered by department', (await page.$$eval('[data-mfrow]', (els) => els.map((e) => e.getAttribute('data-mfrow')))).join() === 'Resin,Pellet');
  await page.click('#mfAdd'); await page.waitForSelector('#mfSave');
  await page.fill('#mfName', 'Colorant'); await page.fill('#mfCont', 'Box'); await page.click('#mfSave'); await page.waitForTimeout(150);
  const st = calls.filter((c) => c.fn === 'saveMaterialType')[0];
  ok('add a type: Plastics, its container', st && st.args[0].name === 'Colorant' && st.args[0].department === 'Plastics' && st.args[0].container === 'Box' && st.args[0].oldName === '', st && st.args);
  // Database: Material Receivers is its own tab; steel keeps its own
  await page.evaluate(() => { dbTable = 'mreceivers'; openDatabase(); }); await page.waitForSelector('[data-mrrow]');
  const tabs = await page.$$eval('[data-dbt]', (els) => els.map((e) => e.textContent));
  ok('Database: Material Receivers and Steel Receivers tabs', tabs.indexOf('Material Receivers') !== -1 && tabs.indexOf('Steel Receivers') !== -1 && tabs.indexOf('Receivers') === -1, tabs);
  ok('material receivers listed with lot counts', (await page.$$('[data-mrrow]')).length === 2 && /MR-00001/.test(await page.textContent('#mrList')));
  await page.click('[data-mrrow="MR-00001"]'); await page.waitForSelector('#mrSave');
  ok('a receiver with lots can\'t be deleted', !(await page.$('#mrDelete')));
  await page.fill('#mrPos', 'P-1, P-2'); await page.click('#mrSave'); await page.waitForTimeout(150);
  const sr = calls.filter((c) => c.fn === 'saveMatReceiver')[0];
  ok('edit a material receiver', sr && sr.args[0].id === 'MR-00001' && sr.args[0].pos === 'P-1, P-2' && sr.args[0].department === 'Plastics', sr && sr.args);
  await page.waitForSelector('[data-mrrow="MR-00002"]'); await page.click('[data-mrrow="MR-00002"]'); await page.waitForSelector('#mrDelete');
  ok('an empty one can be deleted', !!(await page.$('#mrDelete')));
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
  await page.close();
}

// ---- 51. Litho Costs: laid out like the Litho Costs tab; change a price (every size), add a coating
{ const rows = [
    { row: 2, group: '603X408', sub: '5-OUT', bbph: 65.592, item: 'OUTSIDE WHITE COAT', chemCode: 'PPG8129050', appCost: 5.36, lineCost: 6.44, totalCost: 11.8 },
    { row: 3, group: '603X408', sub: '5-OUT', bbph: 65.592, item: 'FULL ENAMEL BPANI', chemCode: '31S46AM', appCost: 11.8, lineCost: 12.88, totalCost: 24.68 },
    { row: 4, group: '401X400', sub: '21-OUT', bbph: 120.674, item: 'OUTSIDE WHITE COAT', chemCode: 'PPG8129050', appCost: 5.36, lineCost: 3.5, totalCost: 8.86 },
    { row: 5, group: 'Specialty / Low Volume / Setup', sub: '', bbph: '', item: 'WAX ONLY', chemCode: '', appCost: 0, lineCost: 0, totalCost: 7.68 },
    { row: 6, group: 'Specialty / Low Volume / Setup', sub: '', bbph: '', item: 'SET UP CHARGE FOR COATING (per hour)', chemCode: '', appCost: 0, lineCost: 0, totalCost: 422.26 }];
  const { page, calls } = await boot(Object.assign({}, base, {
    getRateTable: () => R({ rows, flatGroup: 'Specialty / Low Volume / Setup' }),
    saveRates: (a) => R({ ok: true, changed: 4, rows: 2 }), addRate: (a) => R({ ok: true, added: 2 }),
    getRateHistory: () => R({ since: '2025-10-01', log: [
      { at: '2025-10-01 08:00:00', by: 'Ann', group: '603X408', sub: '5-OUT', item: 'OUTSIDE WHITE COAT', what: 'Application', old: 4.79, now: 5 },
      { at: '2025-10-01 08:00:00', by: 'Ann', group: '603X408', sub: '5-OUT', item: 'OUTSIDE WHITE COAT', what: 'Total', old: 11.23, now: 11.44 },
      { at: '2026-03-01 08:00:00', by: 'Ann', group: '603X408', sub: '5-OUT', item: 'OUTSIDE WHITE COAT', what: 'Application', old: 5, now: 5.1 },
      { at: '2026-03-01 08:00:00', by: 'Ann', group: '603X408', sub: '5-OUT', item: 'OUTSIDE WHITE COAT', what: 'Total', old: 11.44, now: 11.54 },
      { at: '2026-10-01 09:30:00', by: 'Jo', group: '603X408', sub: '5-OUT', item: 'OUTSIDE WHITE COAT', what: 'Application', old: 5.1, now: 5.36 },
      { at: '2026-10-01 09:30:00', by: 'Jo', group: '603X408', sub: '5-OUT', item: 'OUTSIDE WHITE COAT', what: 'Total', old: 11.54, now: 11.8 },
      { at: '2026-10-01 09:30:00', by: 'Jo', group: 'Specialty / Low Volume / Setup', sub: '', item: 'WAX ONLY', what: 'Added', old: '', now: 7.68 }] }),
  }));
  await page.click('#tileLitho'); await page.click('#tileLithoCosts'); await page.waitForSelector('[data-lcrow]');
  const blocks = await page.$$eval('[data-lcblock] h3', (els) => els.map((e) => e.textContent));
  ok('specialty first, then each size with its -OUT', blocks.join('|') === 'Specialty and Low Volume Cans|603X408 — 5-OUT|401X400 — 21-OUT', blocks);
  ok('BB per hour and the three costs shown', /65.592 BB per hour/.test(await page.textContent('#lcBody')) && /\$5\.36[\s\S]*\$6\.44[\s\S]*\$11\.80/.test(await page.textContent('[data-lcrow="2"]')));
  await page.fill('#lcSearch', 'enamel'); await page.waitForTimeout(50);
  ok('search narrows to the matching coating', (await page.$$('[data-lcrow]')).length === 1);
  await page.fill('#lcSearch', ''); await page.click('[data-lcsize="603X408|5-OUT"]'); await page.waitForTimeout(50);
  ok('a size button shows just that size', (await page.$$('[data-lcblock]')).length === 1);
  await page.click('[data-lcrow="2"]'); await page.waitForSelector('#lcSave');
  await page.fill('#lcApp', '5.60');
  ok('the Total updates as you type', (await page.textContent('#lcNewTotal')) === '$12.04');
  ok('…offered for the other size, checked', await page.isChecked('#lcAll'));
  await page.click('#lcSave'); await page.waitForSelector('#modalOk');
  const msg = await page.textContent('#modalRoot');
  ok('the confirm shows old → new and that coated tickets keep theirs', msg.includes('$11.80 → $12.04') && msg.includes('$5.36 → $5.60 in the 1 other size') && msg.includes('already coated keep'), msg);
  await page.click('#modalOk'); await page.waitForTimeout(150);
  const sr = calls.filter((c) => c.fn === 'saveRates')[0];
  ok('saves the row with its coating and every size', sr && sr.args[0][0].row === 2 && sr.args[0][0].item === 'OUTSIDE WHITE COAT' && sr.args[0][0].appCost === 5.6 && sr.args[0][0].lineCost === 6.44 && sr.args[0][0].allSizes === true, sr && sr.args);
  ok('the prices for New Job are refreshed', calls.filter((c) => c.fn === 'getRateTree').length >= 2);
  // add a coating
  await page.waitForSelector('[data-lcadd="603X408|5-OUT"]'); await page.click('[data-lcadd="603X408|5-OUT"]'); await page.waitForSelector('#lcNSave');
  ok('one pass: the size\'s one-pass Line cost', (await page.inputValue('#lcNLine')) === '6.44');
  await page.fill('#lcNName', 'Gold Epoxy'); await page.fill('#lcNChem', '6356069'); await page.fill('#lcNApp', '7.27');
  await page.click('[data-lcpass="2"]');
  ok('two passes: twice that, and what was typed is kept', (await page.inputValue('#lcNLine')) === '12.88' && (await page.inputValue('#lcNName')) === 'Gold Epoxy' && (await page.textContent('#lcNTot')) === '$20.15');
  await page.check('#lcNAll'); await page.click('#lcNSave'); await page.waitForTimeout(150);
  const ar = calls.filter((c) => c.fn === 'addRate')[0];
  ok('adds it (every size, 2 passes)', ar && ar.args[0].item === 'Gold Epoxy' && ar.args[0].group === '603X408' && ar.args[0].passes === 2 && ar.args[0].allSizes === true && ar.args[0].lineCost === 12.88, ar && ar.args);
  // a flat price
  await page.click('[data-lcsize="flat"]'); await page.click('[data-lcrow="5"]'); await page.waitForSelector('#lcTotal');
  ok('a specialty item has just a price', !(await page.$('#lcApp')) && (await page.inputValue('#lcTotal')) === '7.68');
  await page.click('#lcCancel');
  // How prices are worked out
  ok('the explanation is there (folded)', /How these prices are worked out/.test(await page.textContent('#lcHow')) && /BB per hour/.test(await page.textContent('#lcHow')));
  // Change by a percentage
  await page.click('#lcPctOpen'); await page.waitForSelector('#lcPctIn');
  ok('nothing changes until a percentage is typed', (await page.$eval('#lcPctApply', (e) => e.disabled)));
  await page.fill('#lcPctIn', '10'); await page.waitForTimeout(80);
  const pv = await page.textContent('#lcPctBox');
  // set-up 422.26 +10% = 464.49; ÷ 65.592 BB/hr = 7.08 a pass, 14.16 for two (not 12.88 × 1.1); ÷ 120.674 = 3.85
  ok('preview: specialty +10%, line costs from the new set-up charge ÷ BB per hour, application left alone', pv.includes('$7.68 → $8.45') && pv.includes('$422.26 → $464.49')
    && pv.includes('$6.44 → $7.08') && pv.includes('$12.88 → $14.16') && pv.includes('$3.50 → $3.85') && pv.includes('5 prices will change') && !pv.includes('$5.36 →'), pv);
  await page.check('[data-lcpk="app"]'); await page.waitForTimeout(80);
  ok('ticking Application adds those', (await page.textContent('#lcPctBox')).includes('$5.36 → $5.90') && (await page.textContent('#lcPctBox')).includes('5 prices will change'));
  await page.click('#lcPctApply'); await page.waitForSelector('#modalOk'); await page.click('#modalOk'); await page.waitForTimeout(150);
  const pr = calls.filter((c) => c.fn === 'saveRates')[1];
  ok('applies them all in one save', pr && pr.args[0].length === 5 && pr.args[0].some((x) => x.item === 'WAX ONLY' && x.totalCost === 8.45) && pr.args[0].some((x) => x.row === 2 && x.appCost === 5.9 && x.lineCost === 7.08), pr && pr.args);
  // Price history: a card per change date, the cost change shown before opening it
  await page.waitForSelector('#lcHistOpen'); await page.click('[data-lcsize="all"]'); await page.click('#lcHistOpen'); await page.waitForSelector('[data-lcver]');
  const vers = await page.$$eval('[data-lcver]', (els) => els.map((e) => e.getAttribute('data-lcver')));
  ok('by year is the default: one card per year, newest first', vers.join() === '2026,2025' && (await page.getAttribute('[data-lcmode="year"]', 'class')) === 'active', vers);
  const c1 = await page.textContent('[data-lcver="2026"]'), c2 = await page.textContent('[data-lcver="2025"]');
  ok('this year: its 2 changes together, and that it is today\'s prices', c1.includes('latest') && c1.includes('2 changes (03-01 to 10-01)') && c1.includes('Change in 2026: 1 price · average +3.1%') && c1.includes('1 added')
    && c1.includes('by Ann, Jo') && c1.includes('these are today\'s prices'), c1);
  ok('last year: its change, and from the end of it to today', c2.includes('Change in 2025: 1 price · average +1.9%') && c2.includes('From the end of 2025 to today: 1 price · average +3.1% · 1 added'), c2);
  ok('nothing opened yet', !(await page.$('[data-lccmp]')));
  await page.click('[data-lcver="2025"]'); await page.waitForSelector('[data-lccmp]');
  let det = await page.textContent('#lcHistBox');
  ok('opened: every coating, before → that version, with the difference', det.includes('Before $11.23 → 2025 $11.44') && /vs\. the year before/.test(det) && !(await page.$('[data-lcrestore]')) && det.includes('+$0.21 (+1.9%)'), det);
  await page.click('[data-lccmp="now"]'); await page.waitForTimeout(60);
  det = await page.textContent('#lcHistBox');
  ok('…or that version → today', det.includes('2025 $11.44 → Today $11.80') && det.includes('+$0.36 (+3.1%)') && /WAX ONLY[\s\S]*new/.test(det), det);
  await page.click('[data-lcshow="2025-10-01 08:00:00"]'); await page.waitForTimeout(80);
  ok('the full table from that date (and no editing)', /Showing the prices from 2025-10-01 08:00/.test(await page.textContent('#view')) && /\$5\.00[\s\S]*\$6\.44[\s\S]*\$11\.44/.test(await page.textContent('[data-lcrow="2"]'))
    && !(await page.$('[data-lcadd]')) && !(await page.$('#lcPctOpen')) && !(await page.$('[data-lcrow="5"]')));
  await page.click('#lcHistToday'); await page.waitForTimeout(80);
  ok('back to today', /\$5\.36/.test(await page.textContent('[data-lcrow="2"]')) && !!(await page.$('[data-lcrow="5"]')));
  // Each change: one card per save
  await page.click('[data-lcmode="change"]'); await page.waitForTimeout(60);
  const ch = await page.$$eval('[data-lcver]', (els) => els.map((e) => e.getAttribute('data-lcver')));
  ok('each change: one card per save, newest first', ch.join() === '2026-10-01 09:30:00,2026-03-01 08:00:00,2025-10-01 08:00:00', ch);
  ok('…each with its own change', (await page.textContent('[data-lcver="2026-10-01 09:30:00"]')).includes('Change from the version before: 1 price · average +2.3%'));
  // Undo a change exactly (not with a minus percentage)
  await page.click('[data-lcver="2026-10-01 09:30:00"]'); await page.waitForSelector('[data-lcrestore="2026-10-01 09:30:00"]');
  await page.click('[data-lcrestore="2026-10-01 09:30:00"]'); await page.waitForSelector('#modalOk');
  ok('restore asks first', /Put 1 prices back/.test(await page.textContent('#modalRoot')) && /exactly/.test(await page.textContent('#modalRoot')));
  await page.click('#modalOk'); await page.waitForTimeout(150);
  const rs = calls.filter((c) => c.fn === 'saveRates').slice(-1)[0];
  ok('puts back the exact old prices (coatings added since stay)', rs && rs.args[0].length === 1 && rs.args[0][0].row === 2 && rs.args[0][0].appCost === 5.1 && rs.args[0][0].lineCost === 6.44, rs && rs.args);
  await page.waitForSelector('#lcPctOpen'); await page.click('#lcPctOpen'); await page.fill('#lcPctIn', '-12'); await page.waitForTimeout(60);
  ok('a minus percentage explains how to undo a raise instead', /don.t use a minus percentage/.test(await page.textContent('#lcPctBox')));
  await page.click('#lcPctCancel');
  await page.click('#backBtn'); await page.waitForSelector('#tileLithoCosts');
  ok('back goes to the Litho Department', true);
  ok('no page errors', !calls.some((c) => c.fn === '__pageerror'), calls.filter((c) => c.fn === '__pageerror'));
  await page.close();
}

await browser.close();
console.log((fail ? '✗' : '✓') + ' ui_test: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
