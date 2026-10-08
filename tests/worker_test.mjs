// Backend tests: real worker.js against the in-memory fake Sheets, with injected failures.
import { makeFake, makeKey } from './fakesheets.mjs';

const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, Math.ceil((ms || 0) / 50), ...a);   // speed up backoff

const W = await import(new URL('../worker.js', import.meta.url).href);
const worker = W.default;
const KEY = makeKey();
const SID = 'sheet1';

const MASTER_H = ['Ticket', 'Skid ID', 'Status', 'QTY/LOAD', 'Weight', 'Litho', 'Job ID', 'Row', 'Litho Notes', 'Spoilage',
  'First Coated At', 'First Coated By', 'Last Updated At', 'Last Updated By', 'Comments', 'System Notes', 'Split Of',
  'End Use', 'BW', 'TC', 'TM', 'Length', 'Width', 'Mill', 'C/S', 'Used At', 'Used Via'];
const TX_H = ['Timestamp', 'Ticket', 'Pass Number', 'Operator', 'Group', 'Sub-Variant', 'Item', 'Chem Code', 'Application Cost',
  'Line Cost', 'Pass Total Cost', 'Running Total After Pass', 'Notes', 'Job Name', 'Skid ID', 'Op ID', 'Job ID'];
const RATE_H = ['Group', 'Sub-Variant', 'BB Per Hour', 'Item', 'Chem Code', 'Application Cost', 'Line Cost', 'Total Cost'];
const JOBS_H = ['Job ID', 'Created At', 'Created By', 'Description', 'Coatings', 'Coatings JSON', 'Ticket Count', 'Status', 'Notes', 'Approved At', 'Approved By', 'Op ID'];

function skid(t, id, status, qty, weight, extra) {
  const o = Object.assign({ 'Ticket': t, 'Skid ID': id, 'Status': status, 'QTY/LOAD': qty, 'Weight': weight, 'Litho': '' }, extra || {});
  return MASTER_H.map((h) => (o[h] == null ? '' : o[h]));
}
function fresh() {
  const fake = makeFake({ [SID]: {
    'Steel Tickets': [MASTER_H,
      skid('100', 'SKD-000001', 'Current', 1000, 5000),
      skid('101', 'SKD-000002', 'Current', 800, 4000),
      skid('102', 'SKD-000003', 'WIP', 500, 2500, { 'Litho': 10 }),
      skid('103', 'SKD-000004', 'Current', 400, 2000),
      skid('104', 'SKD-000005', 'Current', 300, 1500),
      skid('C-1', 'SKD-000006', 'Current', '', 20000, { 'C/S': 'C', 'Mill': 'M77' }),
    ],
    'Transactions': [TX_H],
    'Litho Rate Table': [RATE_H,
      ['603X408', '10-OUT', '', 'SIZE', 'CH1', 1, 1.5, 2.5],
      ['603X408', '10-OUT', '', 'VARNISH', 'CH2', 2, 2, 4],
      ['603X408', '10-OUT', '', 'WHITE', 'CH3', 3, 3, 6],
    ],
    'Litho Jobs': [JOBS_H],
  } });
  globalThis.fetch = fake.fetchImpl;
  return fake;
}
const envBase = { GCP_SA_EMAIL: 'sa@x.iam', GCP_SA_PRIVATE_KEY: KEY, SHEET_ID: SID };
async function call(fn, args, env) {
  const req = new Request('https://w/', { method: 'POST', body: JSON.stringify({ fn, args }) });
  const waits = [];
  const res = await worker.fetch(req, env || envBase, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  return res.json();
}
let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) pass++; else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); } }
const txFor = (fake, id) => fake.rows(SID, 'Transactions').filter((r) => r['Skid ID'] === id);
const skidRow = (fake, id) => fake.rows(SID, 'Steel Tickets').filter((r) => r['Skid ID'] === id)[0];
const isTxAppend = (r) => r.kind === 'append' && r.decoded.includes('/values/Transactions:append');
const isTxAppendWith = (s) => (r) => isTxAppend(r) && r.body.includes(s);
const isMasterStamp = (r) => r.kind === 'write' && r.decoded.includes('/values:batchUpdate') && r.body.includes('Steel Tickets');

// 1. Happy path coating
{ const f = fresh();
  const r = await call('applyCoating', ['SKD-000001', '603X408', '10-OUT', 'SIZE', 'Ann', '', '', false, '', '', 'op-1-a']);
  ok('coating ok', r.ok, r);
  ok('litho = 2.5', Number(skidRow(f, 'SKD-000001')['Litho']) === 2.5, skidRow(f, 'SKD-000001'));
  ok('status WIP', skidRow(f, 'SKD-000001')['Status'] === 'WIP');
  ok('one coating tx', txFor(f, 'SKD-000001').length === 1);
  const again = await call('applyCoating', ['SKD-000001', '603X408', '10-OUT', 'SIZE', 'Ann', '', '', false, '', '', 'op-1-a']);
  ok('same opId again -> duplicate', again.ok && again.result.duplicate, again);
  ok('still litho 2.5 after dup', Number(skidRow(f, 'SKD-000001')['Litho']) === 2.5);
}

// 2. Re-coat dies before its log row -> retry resumes, cost NOT doubled
{ const f = fresh();
  f.faults.push({ match: isTxAppend, mode: 'before', status: 503, times: 50 });
  const r1 = await call('applyCoating', ['SKD-000003', '603X408', '10-OUT', 'VARNISH', 'Ann', '', '', false, '', '', 'op-2-a']);
  ok('re-coat attempt 1 fails', !r1.ok, r1);
  ok('cost applied once (14)', Number(skidRow(f, 'SKD-000003')['Litho']) === 14, skidRow(f, 'SKD-000003')['Litho']);
  f.faults.length = 0;
  const r2 = await call('applyCoating', ['SKD-000003', '603X408', '10-OUT', 'VARNISH', 'Ann', '', '', false, '', '', 'op-2-a']);
  ok('retry ok', r2.ok, r2);
  ok('cost still 14 (not 18)', Number(skidRow(f, 'SKD-000003')['Litho']) === 14, skidRow(f, 'SKD-000003')['Litho']);
  ok('exactly one coating tx', txFor(f, 'SKD-000003').filter((t) => t['Item'] === 'VARNISH').length === 1);
}

// 3. Ambiguous append (Google saved it, then 503) -> no duplicate log row
{ const f = fresh();
  f.faults.push({ match: isTxAppend, mode: 'after', status: 503, times: 1 });
  const r = await call('applyCoating', ['SKD-000002', '603X408', '10-OUT', 'SIZE', 'Ann', '', '', false, '', '', 'op-3-a']);
  ok('ambiguous append -> ok', r.ok, r);
  ok('only one tx row', txFor(f, 'SKD-000002').length === 1, txFor(f, 'SKD-000002').length);
}

// 4. Partial split: dies after making the leftover, before updating the coated skid
{ const f = fresh();
  f.faults.push({ match: isMasterStamp, mode: 'before', status: 503, times: 4 });   // exhausts the 4 tries of one stamp
  const r1 = await call('applyCoating', ['SKD-000002', '603X408', '10-OUT', 'SIZE', 'Ann', '', 300, true, '', '', 'op-4-a', '101-LR1']);
  ok('split attempt 1 fails', !r1.ok, r1);
  const rems1 = f.rows(SID, 'Steel Tickets').filter((o) => o['Split Of'] === 'SKD-000002');
  ok('leftover created once', rems1.length === 1, rems1.length);
  f.faults.length = 0;
  const r2 = await call('applyCoating', ['SKD-000002', '603X408', '10-OUT', 'SIZE', 'Ann', '', 300, true, '', '', 'op-4-a', '101-LR1']);
  ok('split retry ok', r2.ok, r2);
  const rems = f.rows(SID, 'Steel Tickets').filter((o) => o['Split Of'] === 'SKD-000002');
  ok('still ONE leftover', rems.length === 1, rems.length);
  ok('leftover has 500 sheets, ticket 101', rems[0] && Number(rems[0]['QTY/LOAD']) === 500 && rems[0]['Ticket'] === '101', rems[0]);
  const c = skidRow(f, 'SKD-000002');
  ok('coated piece 300 sheets as 101-LR1, WIP', Number(c['QTY/LOAD']) === 300 && c['Ticket'] === '101-LR1' && c['Status'] === 'WIP', c);
  ok('one split log + one coating log', txFor(f, 'SKD-000002').length === 1 && f.rows(SID, 'Transactions').filter((t) => t['Item'] === 'SPLIT REMAINDER CREATED').length === 1);
  ok('result reports remainder', r2.result.remainderTicket === '101' && r2.result.remainderSheets === 500, r2.result);
}

// 4b. Partial split dies after the coated skid was updated (before its log) -> resume logs only
{ const f = fresh();
  f.faults.push({ match: isTxAppendWith('"SIZE"'), mode: 'before', status: 503, times: 50 });
  const r1 = await call('applyCoating', ['SKD-000002', '603X408', '10-OUT', 'SIZE', 'Ann', '', 300, true, '', '', 'op-4b-a', '101-LR1']);
  ok('4b attempt 1 fails', !r1.ok);
  f.faults.length = 0;
  const r2 = await call('applyCoating', ['SKD-000002', '603X408', '10-OUT', 'SIZE', 'Ann', '', 300, true, '', '', 'op-4b-a', '101-LR1']);
  ok('4b retry ok', r2.ok, r2);
  ok('4b one leftover', f.rows(SID, 'Steel Tickets').filter((o) => o['Split Of'] === 'SKD-000002').length === 1);
  ok('4b coated 300, litho 2.5', Number(skidRow(f, 'SKD-000002')['QTY/LOAD']) === 300 && Number(skidRow(f, 'SKD-000002')['Litho']) === 2.5, skidRow(f, 'SKD-000002'));
  ok('4b one coating tx', txFor(f, 'SKD-000002').filter((t) => t['Item'] === 'SIZE').length === 1);
  ok('4b result says partial', r2.result.isPartial && r2.result.remainderTicket === '101', r2.result);
}

// 5. Mark Used dies on skid 3 of 4 -> retry finishes 3-4, no "AGAIN" entries
{ const f = fresh();
  f.faults.push({ match: isTxAppendWith('SKD-000004'), mode: 'before', status: 503, times: 50 });
  const ids = ['SKD-000001', 'SKD-000002', 'SKD-000004', 'SKD-000005'];
  const r1 = await call('markUsedDirect', [ids, '2026-09-29', 'op-5-a']);
  ok('mark used attempt 1 fails', !r1.ok, r1);
  f.faults.length = 0;
  const r2 = await call('markUsedDirect', [ids, '2026-09-29', 'op-5-a']);
  ok('retry ok', r2.ok, r2);
  ok('all 4 Used', ids.every((id) => skidRow(f, id)['Status'] === 'Used'));
  const tx = f.rows(SID, 'Transactions');
  ok('4 log rows, none AGAIN', tx.length === 4 && !tx.some((t) => /AGAIN/.test(t['Item'])), tx.map((t) => t['Item']));
  const r3 = await call('markUsedDirect', [ids, '2026-09-29', 'op-5-a']);
  ok('third call: nothing new', r3.ok && f.rows(SID, 'Transactions').length === 4, f.rows(SID, 'Transactions').length);
}

// 6. Job with 2-coat recipe: second coat's log fails -> retry finishes it, cost = 2.5 + 4
{ const f = fresh();
  const j = await call('createJob', ['J1', 'Ann', [{ group: '603X408', sub: '10-OUT', item: 'SIZE' }, { group: '603X408', sub: '10-OUT', item: 'VARNISH' }], '', 'op-6-j']);
  ok('job created', j.ok && j.result.jobId, j);
  const dup = await call('createJob', ['J1', 'Ann', [{ group: '603X408', sub: '10-OUT', item: 'SIZE' }], '', 'op-6-j']);
  ok('createJob retry returns the jobId', dup.ok && dup.result.jobId === j.result.jobId, dup);
  ok('still one job', f.rows(SID, 'Litho Jobs').length === 1);
  const jid = j.result.jobId;
  f.faults.push({ match: isTxAppendWith('"VARNISH"'), mode: 'before', status: 503, times: 50 });
  const a1 = await call('jobAddTicket', [jid, 'SKD-000001', '', false, '', 'Bob', 'op-6-a', '']);
  ok('add attempt 1 fails', !a1.ok, a1);
  f.faults.length = 0;
  const a2 = await call('jobAddTicket', [jid, 'SKD-000001', '', false, '', 'Bob', 'op-6-a', '']);
  ok('add retry ok (not "already on job")', a2.ok, a2);
  ok('litho = 6.5', Number(skidRow(f, 'SKD-000001')['Litho']) === 6.5, skidRow(f, 'SKD-000001')['Litho']);
  ok('2 coat rows', txFor(f, 'SKD-000001').length === 2, txFor(f, 'SKD-000001').map((t) => t['Item']));
  ok('pending on job', skidRow(f, 'SKD-000001')['Status'] === 'Pending' && skidRow(f, 'SKD-000001')['Job ID'] === jid);
  ok('operator logged is Bob', txFor(f, 'SKD-000001').every((t) => t['Operator'] === 'Bob'));
  const a3 = await call('jobAddTicket', [jid, 'SKD-000001', '', false, '', 'Bob', 'op-6-a', '']);
  ok('3rd call ok with result', a3.ok && a3.result.skidId === 'SKD-000001', a3);
  ok('still 6.5', Number(skidRow(f, 'SKD-000001')['Litho']) === 6.5);

  // 7. Add coating to job: retry doesn't add it to the recipe twice or coat twice
  await call('jobAddTicket', [jid, 'SKD-000002', '', false, '', 'Bob', 'op-6-b', '']);
  f.faults.push({ match: isTxAppendWith('SKD-000002'), mode: 'before', status: 503, times: 50 });
  const c1 = await call('addCoatingToJob', [jid, { group: '603X408', sub: '10-OUT', item: 'WHITE' }, 'Ann', 'op-7-a']);
  ok('add coating attempt 1 fails', !c1.ok, c1);
  f.faults.length = 0;
  const c2 = await call('addCoatingToJob', [jid, { group: '603X408', sub: '10-OUT', item: 'WHITE' }, 'Ann', 'op-7-a']);
  ok('add coating retry ok', c2.ok, c2);
  const recipe = JSON.parse(f.rows(SID, 'Litho Jobs')[0]['Coatings JSON']);
  ok('recipe has 3 coats (not 4)', recipe.length === 3, recipe);
  ok('skid 1 litho 12.5', Number(skidRow(f, 'SKD-000001')['Litho']) === 12.5, skidRow(f, 'SKD-000001')['Litho']);
  ok('skid 2 litho 12.5', Number(skidRow(f, 'SKD-000002')['Litho']) === 12.5, skidRow(f, 'SKD-000002')['Litho']);

  // Pending on another job is refused
  const j2 = await call('createJob', ['J2', 'Ann', [{ group: '603X408', sub: '10-OUT', item: 'SIZE' }], '', 'op-6-j2']);
  const x = await call('jobAddTicket', [j2.result.jobId, 'SKD-000001', '', false, '', 'Bob', 'op-6-x', '']);
  ok('pending-on-other-job refused', !x.ok && /another job/.test(x.error), x);

  // approve: retry-safe and complete
  f.faults.push({ match: isTxAppendWith('JOB APPROVED') , mode: 'before', status: 503, times: 50 });
  const ap1 = await call('approveJob', [jid, 'Ann', 'op-ap-1']);
  ok('approve attempt 1 fails', !ap1.ok);
  f.faults.length = 0;
  const ap2 = await call('approveJob', [jid, 'Ann', 'op-ap-1']);
  ok('approve retry ok', ap2.ok, ap2);
  ok('both WIP', skidRow(f, 'SKD-000001')['Status'] === 'WIP' && skidRow(f, 'SKD-000002')['Status'] === 'WIP');
  ok('2 approval log rows', f.rows(SID, 'Transactions').filter((t) => t['Item'] === 'JOB APPROVED').length === 2);
}

// 8. Coil cut dies after 2 of 3 children -> retry makes only the 3rd
{ const f = fresh();
  let writes = 0;
  f.faults.push({ match: (r) => r.kind === 'write' && /\/values\/'Steel Tickets'!A\d+ /.test(r.decoded) && (++writes === 3), mode: 'before', status: 503, times: 1 });
  f.faults.push({ match: (r) => r.kind === 'write' && /\/values\/'Steel Tickets'!A\d+ /.test(r.decoded) && writes >= 3, mode: 'before', status: 503, times: 3 });
  const kids = [{ weight: 5000, qty: 100 }, { weight: 6000, qty: 110 }, { weight: 7000, qty: 120 }];
  const r1 = await call('cutCoil', ['SKD-000006', '2026-09-29', 1, kids, true, 'op-8-a']);
  ok('cut attempt 1 fails', !r1.ok, r1);
  ok('2 children after failure', f.rows(SID, 'Steel Tickets').filter((o) => o['Split Of'] === 'SKD-000006').length === 2, f.rows(SID, 'Steel Tickets').filter((o) => o['Split Of'] === 'SKD-000006').map((o) => o['Ticket']).concat([writes]));
  f.faults.length = 0;
  const r2 = await call('cutCoil', ['SKD-000006', '2026-09-29', 1, kids, true, 'op-8-a']);
  ok('cut retry ok', r2.ok, r2);
  const ch = f.rows(SID, 'Steel Tickets').filter((o) => o['Split Of'] === 'SKD-000006');
  ok('exactly 3 children', ch.length === 3, ch.map((c) => c['Ticket']));
  ok('tickets 092926-100..102 (the day starts at 00)', ch.map((c) => c['Ticket']).join(',') === '092926-100,092926-101,092926-102', ch.map((c) => c['Ticket']));
  ok('unique skid ids', new Set(ch.map((c) => c['Skid ID'])).size === 3);
  ok('coil Used', skidRow(f, 'SKD-000006')['Status'] === 'Used');
  ok('result lists 3', r2.result.created === 3, r2.result);
  const r3 = await call('cutCoil', ['SKD-000006', '2026-09-29', 1, kids, true, 'op-8-a']);
  ok('dup cut reports 3 made', r3.ok && r3.result.duplicate && r3.result.created === 3, r3);
}

// 9. Edit coating dies before the VOID -> retry: new cost once, old pass voided once
{ const f = fresh();
  await call('applyCoating', ['SKD-000001', '603X408', '10-OUT', 'SIZE', 'Ann', '', '', false, '', '', 'op-9-a']);
  const pass = Number(txFor(f, 'SKD-000001')[0]['Pass Number']);
  f.faults.push({ match: isTxAppendWith('VOID'), mode: 'before', status: 503, times: 50 });
  const e1 = await call('editTicketCoating', ['SKD-000001', pass, '603X408', '10-OUT', 'WHITE', 'Ann', 'op-9-e']);
  ok('edit attempt 1 fails', !e1.ok, e1);
  f.faults.length = 0;
  const e2 = await call('editTicketCoating', ['SKD-000001', pass, '603X408', '10-OUT', 'WHITE', 'Ann', 'op-9-e']);
  ok('edit retry ok', e2.ok, e2);
  ok('litho = 6 (not 9.5)', Number(skidRow(f, 'SKD-000001')['Litho']) === 6, skidRow(f, 'SKD-000001')['Litho']);
  ok('one WHITE row, one VOID row', txFor(f, 'SKD-000001').filter((t) => t['Item'] === 'WHITE').length === 1 && txFor(f, 'SKD-000001').filter((t) => /VOID/.test(t['Item'])).length === 1);
  ok('card shows only WHITE active', e2.result.coatings.length === 1 && e2.result.coatings[0].item === 'WHITE', e2.result.coatings);

  f.faults.push({ match: isTxAppendWith('REMOVED (VOID)'), mode: 'before', status: 503, times: 50 });
  const wp = e2.result.coatings[0].passNumber;
  const d1 = await call('removeTicketCoating', ['SKD-000001', wp, 'Ann', 'op-9-r']);
  ok('remove attempt 1 fails', !d1.ok);
  f.faults.length = 0;
  const d2 = await call('removeTicketCoating', ['SKD-000001', wp, 'Ann', 'op-9-r']);
  ok('remove retry ok', d2.ok, d2);
  ok('litho = 0 (not -6)', Number(skidRow(f, 'SKD-000001')['Litho']) === 0, skidRow(f, 'SKD-000001')['Litho']);
}

// 10. WIP litho cost validation
{ const f = fresh();
  const a = await call('updateWipLithoCost', ['SKD-000003', '', 'Ann', '', 'op-10-a']);
  ok('blank cost rejected', !a.ok && /number/.test(a.error), a);
  ok('cost untouched', Number(skidRow(f, 'SKD-000003')['Litho']) === 10);
  const b = await call('updateWipLithoCost', ['SKD-000003', '1,234.50', 'Ann', '', 'op-10-b']);
  ok('"1,234.50" accepted', b.ok && Number(skidRow(f, 'SKD-000003')['Litho']) === 1234.5, b);
  const c = await call('updateWipLithoCost', ['SKD-000003', 'abc', 'Ann', '', 'op-10-c']);
  ok('junk rejected', !c.ok);
  const d = await call('updateTicketDetails', ['SKD-000003', { 'Weight': '2,600' }, 'Ann', 'op-10-d']);
  ok('weight "2,600" accepted', d.ok && Number(skidRow(f, 'SKD-000003')['Weight']) === 2600, d);
}

// 11. Manual ticket with no number: retry after the log failed doesn't add a second skid
{ const f = fresh();
  f.faults.push({ match: isTxAppendWith('MANUAL TICKET'), mode: 'before', status: 503, times: 50 });
  const m1 = await call('createManualTicket', ['', { 'QTY/LOAD': 50 }, 'Ann', 'op-11-a']);
  ok('manual attempt 1 fails', !m1.ok);
  f.faults.length = 0;
  const m2 = await call('createManualTicket', ['', { 'QTY/LOAD': 50 }, 'Ann', 'op-11-a']);
  ok('manual retry ok', m2.ok, m2);
  ok('still 7 skids', f.rows(SID, 'Steel Tickets').length === 7, f.rows(SID, 'Steel Tickets').length);
}

// 12. Concurrent writes are serialized: 5 blank manual tickets at once get 5 different Skid IDs
async function concurrency(env, label) {
  const f = fresh();
  const rs = await Promise.all([1, 2, 3, 4, 5].map((i) => call('createManualTicket', ['', { 'QTY/LOAD': i }, 'Ann', 'op-12-' + i], env)));
  ok(label + ': all ok', rs.every((r) => r.ok), rs.filter((r) => !r.ok));
  const ids = f.rows(SID, 'Steel Tickets').map((o) => o['Skid ID']);
  ok(label + ': 11 rows, all unique IDs', ids.length === 11 && new Set(ids).size === 11, ids);
}
await concurrency(envBase, 'in-worker lock');
{ // with a Durable Object binding (fake namespace calling the real WriteLock class)
  let inst = null;
  const ns = { idFromName: (n) => n, get: () => ({ fetch: (url, init) => { inst = inst || new W.WriteLock({}, envDO); return inst.fetch(new Request(url, init)); } }) };
  const envDO = Object.assign({}, envBase, { WRITE_LOCK: ns });
  await concurrency(envDO, 'durable object lock');
  const h = await (await worker.fetch(new Request('https://w/', { method: 'GET' }), envDO, {})).json();
  ok('health reports lock', h.writeLock === true && !!h.build, h);
}

// 13. deleteJob: a row that shifted is not deleted by position
{ const f = fresh();
  const j1 = await call('createJob', ['A', 'Ann', [{ group: '603X408', sub: '10-OUT', item: 'SIZE' }], '', 'op-13-1']);
  const j2 = await call('createJob', ['B', 'Ann', [{ group: '603X408', sub: '10-OUT', item: 'SIZE' }], '', 'op-13-2']);
  const del = await call('deleteJob', [j1.result.jobId, 'Ann', 'op-13-d']);
  ok('delete ok', del.ok, del);
  const left = f.rows(SID, 'Litho Jobs').map((r) => r['Job ID']);
  ok('only job B left', left.length === 1 && left[0] === j2.result.jobId, left);
}

// 14. Sheets retry rules
{ const f = fresh();
  f.faults.push({ match: (r) => r.kind === 'read', mode: 'before', status: 503, times: 2 });
  const r = await call('getAllTickets', []);
  ok('reads retry past 503s', r.ok && r.result.length === 6, r);
  f.faults.push({ match: (r) => r.kind === 'read', mode: 'html', times: 1 });
  const r2 = await call('getAllTickets', []);
  ok('HTML 502 page is retried', r2.ok, r2);
  f.faults.push({ match: (r) => r.kind === 'struct' && r.body.includes('deleteDimension'), mode: 'after', status: 503, times: 1 });
  const j = await call('createJob', ['X', 'Ann', [{ group: '603X408', sub: '10-OUT', item: 'SIZE' }], '', 'op-14-j']);
  const n0 = f.log.filter((x) => x.body && x.body.includes('deleteDimension')).length;
  const d = await call('deleteJob', [j.result.jobId, 'Ann', 'op-14-d']);
  const n1 = f.log.filter((x) => x.body && x.body.includes('deleteDimension')).length;
  ok('row delete sent once, never re-sent', n1 - n0 === 1, n1 - n0);
  ok('ambiguous delete reported as error', !d.ok, d);
}

// 15. Snapshot still works (reads through the lock-free path)
{ const f = fresh();
  f.book('snap');
  f.books.snap.tabs = {}; f.books.snap.order = [];
  const env = Object.assign({}, envBase, { SNAPSHOT_SHEET_ID: 'snap' });
  f.faults.push({ match: (r) => r.kind === 'struct' && r.body.includes('addSheet'), mode: 'after', status: 503, times: 1 });
  const s = await call('snapshotCurrentWip', ['op-15'], env);
  ok('snapshot ok despite ambiguous addSheet', s.ok && s.result.total === 6, s);
  ok('one dated tab', f.books.snap.order.length === 1, f.books.snap.order);
}

// 15. Per-request read cache: a job coating stays under the Workers Free 50-calls-per-request cap,
//     and a read after this request's own write sees the new data (not the cached copy).
{ const f = fresh();
  const extra = [];
  for (let i = 7; i <= 12; i++) extra.push(skid(String(200 + i), 'SKD-' + String(i).padStart(6, '0'), 'Current', 100, 500));
  f.book(SID).tabs['Steel Tickets'].rows.push(...extra);
  const j = await call('createJob', ['cache test', 'Ann', [{ group: '603X408', sub: '10-OUT', item: 'SIZE' }], '', 'op-15-a']);
  for (let i = 7; i <= 12; i++) await call('jobAddTicket', [j.result.jobId, 'SKD-' + String(i).padStart(6, '0'), 100, false, '', 'Ann', 'op-15-t' + i, '']);
  const n0 = f.log.length;
  const r = await call('addCoatingToJob', [j.result.jobId, { group: '603X408', sub: '10-OUT', item: 'VARNISH' }, 'Ann', 'op-15-c']);
  const used = f.log.length - n0;
  ok('6-ticket job coating ok', r.ok, r);
  ok('6-ticket job coating under 50 Google calls', used < 50, used);
  const rateReads = f.log.slice(n0).filter((q) => q.kind === 'read' && q.decoded.includes('Litho Rate Table')).length;
  ok('rate table read once per request', rateReads === 1, rateReads);
  ok('each skid got both coats (reads saw own writes)', [7, 8, 9, 10, 11, 12].every((i) => Number(skidRow(f, 'SKD-' + String(i).padStart(6, '0'))['Litho']) === 6.5),
    [7, 12].map((i) => skidRow(f, 'SKD-' + String(i).padStart(6, '0'))['Litho']));
  ok('job detail returned lists 6 tickets', r.result && r.result.tickets && r.result.tickets.length === 6, r.result && r.result.tickets && r.result.tickets.length);
}

// 16. Tested BW: saved on the skid (column added on first use), bad values refused, retry-safe
{ const f = fresh();
  const j = await call('createJob', ['bw test', 'Ann', [{ group: '603X408', sub: '10-OUT', item: 'SIZE' }], '', 'op-16-a']);
  const jid = j.result.jobId;
  const bad = await call('jobAddTicket', [jid, 'SKD-000001', '', false, '', 'Ann', 'op-16-bad', '', 'abc']);
  ok('non-number Tested BW refused', !bad.ok && /Tested BW/.test(bad.error), bad);
  ok('refused add changed nothing', skidRow(f, 'SKD-000001')['Status'] === 'Current' && txFor(f, 'SKD-000001').length === 0);
  const r = await call('jobAddTicket', [jid, 'SKD-000001', '', false, '', 'Ann', 'op-16-b', '', '75.2']);
  ok('add with Tested BW ok', r.ok, r);
  ok('server confirms the saved Tested BW', r.result && r.result.testedBw === 75.2, r.result && r.result.testedBw);
  ok('Tested BW column created and set', String(skidRow(f, 'SKD-000001')['Tested BW']) === '75.2', skidRow(f, 'SKD-000001'));
  ok('nominal BW untouched', String(skidRow(f, 'SKD-000001')['BW']) === '', skidRow(f, 'SKD-000001')['BW']);
  const again = await call('jobAddTicket', [jid, 'SKD-000001', '', false, '', 'Ann', 'op-16-b', '', '75.2']);
  ok('retry of the same add is fine', again.ok && txFor(f, 'SKD-000001').length === 1, [again, txFor(f, 'SKD-000001').length]);
  const blank = await call('jobAddTicket', [jid, 'SKD-000002', '', false, '', 'Ann', 'op-16-c', '', '']);
  ok('blank Tested BW allowed, left empty', blank.ok && String(skidRow(f, 'SKD-000002')['Tested BW'] || '') === '', skidRow(f, 'SKD-000002'));
  const part = await call('jobAddTicket', [jid, 'SKD-000004', 100, true, '', 'Ann', 'op-16-d', '', '74.9']);
  ok('partial add ok', part.ok, part);
  const rem = f.rows(SID, 'Steel Tickets').filter((o) => o['Split Of'] === 'SKD-000004')[0];
  ok('partial: Tested BW on the coated skid in the job', String(skidRow(f, 'SKD-000004')['Tested BW']) === '74.9' && skidRow(f, 'SKD-000004')['Job ID'] === jid);
  ok('partial: remainder left blank', rem && String(rem['Tested BW'] || '') === '', rem);
  const d = await call('getJobDetail', [jid]);
  const t1 = d.result.tickets.filter((t) => t.skidId === 'SKD-000001')[0];
  ok('job detail reports Tested BW', t1 && String(t1.testedBw) === '75.2', t1);
  const all = await call('getAllTickets', []);
  ok('ticket list reports Tested BW', String(all.result.filter((t) => t.skidId === 'SKD-000001')[0].testedBw) === '75.2');
}

// 17. Move To WIP: the foreman's batch — every ticket gets the recipe and goes straight to WIP,
//     in a fixed handful of Google calls, retry-safe, with ineligible tickets skipped.
{ const f = fresh();
  const extra = [];
  for (let i = 7; i <= 46; i++) extra.push(skid(String(300 + i), 'SKD-' + String(i).padStart(6, '0'), 'Current', 100, 500));
  extra.push(skid('USED-1', 'SKD-000047', 'Used', 100, 500));
  f.book(SID).tabs['Steel Tickets'].rows.push(...extra);
  const recipe = [{ group: '603X408', sub: '10-OUT', item: 'SIZE' }, { group: '603X408', sub: '10-OUT', item: 'VARNISH' }];
  const noName = await call('moveToWip', ['', 'Ann', recipe, ['SKD-000001'], 'op-17-x']);
  ok('job/customer name required', !noName.ok && /name/i.test(noName.error), noName);
  const noCoat = await call('moveToWip', ['Acme', 'Ann', [], ['SKD-000001'], 'op-17-y']);
  ok('a coating is required', !noCoat.ok, noCoat);
  const noneOk = await call('moveToWip', ['Acme', 'Ann', recipe, ['SKD-000047', 'SKD-999999'], 'op-17-z']);
  ok('batch with nothing movable refused', !noneOk.ok && /USED-1/.test(noneOk.error), noneOk);
  ok('refused batch made no job', f.rows(SID, 'Litho Jobs').length === 0, f.rows(SID, 'Litho Jobs'));
  // A Pending skid (on another job) is skipped, not taken.
  const j = await call('createJob', ['other job', 'Ann', [recipe[0]], '', 'op-17-j']);
  await call('jobAddTicket', [j.result.jobId, 'SKD-000002', '', false, '', 'Ann', 'op-17-p', '', '']);

  const ids = ['SKD-000001', 'SKD-000002', 'SKD-000003', 'SKD-000047'];
  for (let i = 7; i <= 46; i++) ids.push('SKD-' + String(i).padStart(6, '0'));
  // The log append fails outright the first time: nothing is lost, the retry finishes the job.
  f.faults.push({ match: isTxAppend, mode: 'before', status: 400, times: 1 });
  const first = await call('moveToWip', ['Acme Cans', 'Joel', recipe, ids, 'op-17-m']);
  ok('failed log append reported', !first.ok, first);
  const n0 = f.log.length;
  const r = await call('moveToWip', ['Acme Cans', 'Joel', recipe, ids, 'op-17-m']);
  ok('move ok', r.ok, r);
  const used = f.log.length - n0;
  ok('42-ticket batch well under 50 Google calls', used < 20, used);
  ok('42 moved', r.result.moved.length === 42, r.result.moved.length);
  ok('Pending and Used tickets skipped with reasons', r.result.skipped.length === 2
    && r.result.skipped.some((x) => x.skidId === 'SKD-000002' && /Pending/.test(x.reason))
    && r.result.skipped.some((x) => x.skidId === 'SKD-000047' && x.reason === 'Used'), r.result.skipped);
  const jid = r.result.jobId;
  const s1 = skidRow(f, 'SKD-000001');
  ok('Current ticket -> WIP with the recipe cost', s1['Status'] === 'WIP' && Number(s1['Litho']) === 6.5 && s1['Job ID'] === jid && s1['First Coated By'] === 'Joel', s1);
  const s3 = skidRow(f, 'SKD-000003');
  ok('WIP ticket gets the coats on top', s3['Status'] === 'WIP' && Number(s3['Litho']) === 16.5 && !s3['First Coated By'], s3);
  ok('Pending ticket left on its job', skidRow(f, 'SKD-000002')['Job ID'] === j.result.jobId && skidRow(f, 'SKD-000002')['Status'] === 'Pending');
  ok('sheet count untouched', Number(s1['QTY/LOAD']) === 1000, s1['QTY/LOAD']);
  const tx1 = txFor(f, 'SKD-000001');
  ok('two coating rows, passes 1 and 2, running total', tx1.length === 2 && tx1.map((t) => Number(t['Pass Number'])).join() === '1,2'
    && Number(tx1[1]['Running Total After Pass']) === 6.5 && tx1[0]['Job Name'] === 'Acme Cans' && tx1[0]['Job ID'] === jid, tx1);
  ok('80+2 coating rows written once', f.rows(SID, 'Transactions').filter((t) => t['Job ID'] === jid).length === 84, f.rows(SID, 'Transactions').filter((t) => t['Job ID'] === jid).length);
  const job = f.rows(SID, 'Litho Jobs').filter((x) => x['Job ID'] === jid);
  ok('one Approved job row', job.length === 1 && job[0]['Status'] === 'Approved' && job[0]['Description'] === 'Acme Cans' && job[0]['Approved By'] === 'Joel', job);
  ok('job ticket count', Number(job[0]['Ticket Count']) === 42, job[0] && job[0]['Ticket Count']);
  const again = await call('moveToWip', ['Acme Cans', 'Joel', recipe, ids, 'op-17-m']);
  ok('retry of a finished batch changes nothing', again.ok && Number(skidRow(f, 'SKD-000001')['Litho']) === 6.5 && txFor(f, 'SKD-000001').length === 2
    && f.rows(SID, 'Litho Jobs').filter((x) => x['Description'] === 'Acme Cans').length === 1, [again, skidRow(f, 'SKD-000001')['Litho']]);
  const d = await call('getJobDetail', [jid]);
  ok('job detail lists the moved tickets', d.ok && d.result.tickets.length === 42 && d.result.coatings.length === 2, d.result && d.result.tickets.length);
  const open = await call('getOpenJobs', []);
  ok('moved batch is not an open job', open.ok && !open.result.some((x) => x.jobId === jid));
  // An unclear failure after the log rows landed: the check sees them, nothing is doubled.
  f.faults.push({ match: isTxAppend, mode: 'after', status: 503, times: 1 });
  const r2 = await call('moveToWip', ['Beta', '', [recipe[1]], ['SKD-000004'], 'op-17-n']);
  ok('no name given: recorded as Foreman', r2.ok && skidRow(f, 'SKD-000004')['First Coated By'] === 'Foreman', skidRow(f, 'SKD-000004'));
  ok('ambiguous log append: ok, one row', r2.ok && txFor(f, 'SKD-000004').length === 1 && Number(skidRow(f, 'SKD-000004')['Litho']) === 4, [r2, txFor(f, 'SKD-000004').length]);
}

// 18. Reports carry the product trace: mill, specs, every coating with its chem code, the job /
//     customer, and — for a cut pallet — the same for each source skid it was cut from.
{ const f = fresh();
  const rows = f.book(SID).tabs['Steel Tickets'].rows;
  rows[1][MASTER_H.indexOf('Mill')] = 'M-111'; rows[1][MASTER_H.indexOf('BW')] = '75';
  rows[2][MASTER_H.indexOf('Mill')] = 'M-222';
  const j = await call('createJob', ['Acme Cans', 'Ann', [{ group: '603X408', sub: '10-OUT', item: 'SIZE' }], '', 'op-18-j']);
  await call('jobAddTicket', [j.result.jobId, 'SKD-000001', '', false, '', 'Ann', 'op-18-a', '', '75.2']);
  await call('approveJob', [j.result.jobId, 'Alex', 'op-18-ap']);
  // SKD-000002: on a job, taken off it (coats voided), then moved to WIP with VARNISH only.
  const j2 = await call('createJob', ['Mistake', 'Ann', [{ group: '603X408', sub: '10-OUT', item: 'WHITE' }], '', 'op-18-j2']);
  await call('jobAddTicket', [j2.result.jobId, 'SKD-000002', '', false, '', 'Ann', 'op-18-b', '', '']);
  await call('removeTicketFromJob', [j2.result.jobId, 'SKD-000002', 'Ann', 'op-18-rm']);
  await call('moveToWip', ['Beta Foods', '', [{ group: '603X408', sub: '10-OUT', item: 'VARNISH' }], ['SKD-000002'], 'op-18-mw']);
  const d = new Date(); const ymdNow = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const r = await call('getDepartmentReport', ['2000-01-01', '2099-12-31', 'litho']);
  ok('litho report ok', r.ok, r);
  const lit = r.result.sections[0].rows;
  const a = lit.filter((x) => x.skidId === 'SKD-000001')[0];
  ok('trace: job / customer and job id', a && a.customer === 'Acme Cans' && a.jobId === j.result.jobId, a);
  ok('trace: mill, BW and tested BW', a && a.mill === 'M-111' && String(a.bw) === '75' && String(a.testedBw) === '75.2', a);
  ok('trace: coating with chem code, date and who', a && a.coatings.length === 1 && a.coatings[0].item === 'SIZE' && a.coatings[0].chemCode === 'CH1' && a.coatings[0].by === 'Ann' && /^\d{4}-\d\d-\d\d$/.test(a.coatings[0].date), a && a.coatings);
  ok('trace: sheets and status', a && Number(a.qty) === 1000 && a.status === 'WIP', a);
  const b = lit.filter((x) => x.skidId === 'SKD-000002')[0];
  ok('coats voided by leaving a job are not in the trace', b && b.coatings.map((c) => c.item).join() === 'VARNISH' && b.customer === 'Beta Foods', b && b.coatings);
  const card = await call('getTicketCard', ['SKD-000002']);
  ok('ticket card agrees (only the live coat)', card.ok && card.result.coatings.map((c) => c.item).join() === 'VARNISH', card.result && card.result.coatings);

  // Cut pallet: its sources carry their own trace.
  const sess = await call('createSlitterSession', ['Slitter', 'S1', 'Ann', '', 'op-18-s']);
  const ld = await call('slitterLoadSkid', [sess.result.sessionId, 'SKD-000001', 'Ann', 'op-18-l']);
  const fin = await call('slitterFinishPallet', [sess.result.sessionId, 40, 'lot 7', 'Ann', 'op-18-f']);
  ok('slitter pallet made', sess.ok && ld.ok && fin.ok, [sess, ld, fin]);
  const rs = await call('getDepartmentReport', ['2000-01-01', '2099-12-31', 'slitter']);
  const pal = rs.ok && rs.result.sections[0].rows[0];
  ok('pallet lists its source skid', pal && pal.sources && pal.sources.length === 1 && pal.sources[0].skidId === 'SKD-000001', pal);
  ok('source carries mill, coatings and customer', pal && pal.sources[0].mill === 'M-111' && pal.sources[0].coatings[0].chemCode === 'CH1' && pal.sources[0].customer === 'Acme Cans', pal && pal.sources);
  const all = await call('getDepartmentReport', [ymdNow, ymdNow, 'all']);
  ok('all-departments report still ok', all.ok && all.result.sections.length >= 5, all);
}

// 19. Taking a coat off a WIP ticket (Move To WIP drop-down), then another pass
{ const f = fresh();
  const recipe = [{ group: '603X408', sub: '10-OUT', item: 'SIZE' }, { group: '603X408', sub: '10-OUT', item: 'VARNISH' }];
  await call('moveToWip', ['Acme', '', recipe, ['SKD-000001'], 'op-19-a']);
  const c0 = await call('getTicketCard', ['SKD-000001']);
  const varnish = c0.result.coatings.filter((c) => c.item === 'VARNISH')[0];
  const r = await call('removeTicketCoating', ['SKD-000001', varnish.passNumber, 'Foreman', 'op-19-r']);
  ok('coat removed from a WIP ticket', r.ok && r.result.coatings.map((c) => c.item).join() === 'SIZE' && Number(r.result.litho) === 2.5, r.result);
  ok('ticket stays in WIP', skidRow(f, 'SKD-000001')['Status'] === 'WIP');
  const again = await call('removeTicketCoating', ['SKD-000001', varnish.passNumber, 'Foreman', 'op-19-r']);
  ok('retrying the removal does not subtract twice', again.ok && Number(skidRow(f, 'SKD-000001')['Litho']) === 2.5, skidRow(f, 'SKD-000001')['Litho']);
  const m = await call('moveToWip', ['Acme 2', '', [{ group: '603X408', sub: '10-OUT', item: 'WHITE' }], ['SKD-000001'], 'op-19-b']);
  ok('another pass after the removal', m.ok && Number(skidRow(f, 'SKD-000001')['Litho']) === 8.5, skidRow(f, 'SKD-000001')['Litho']);
  const c1 = await call('getTicketCard', ['SKD-000001']);
  ok('card shows SIZE + WHITE, no VARNISH', c1.result.coatings.map((c) => c.item).join() === 'SIZE,WHITE', c1.result.coatings);
}

// 20. Move To WIP with marked removals: taken off in the same batch as the new coats
{ const f = fresh();
  const R2 = [{ group: '603X408', sub: '10-OUT', item: 'SIZE' }, { group: '603X408', sub: '10-OUT', item: 'VARNISH' }];
  await call('moveToWip', ['First', '', R2, ['SKD-000001', 'SKD-000004'], 'op-20-a']);   // litho 6.5 each
  const c0 = await call('getTicketCard', ['SKD-000001']);
  const vp = c0.result.coatings.filter((c) => c.item === 'VARNISH')[0].passNumber;
  const c4 = await call('getTicketCard', ['SKD-000004']);
  const vp4 = c4.result.coatings.filter((c) => c.item === 'VARNISH')[0].passNumber;
  const n0 = f.log.length;
  f.faults.push({ match: isTxAppend, mode: 'before', status: 400, times: 1 });
  const bad = await call('moveToWip', ['Second', '', [{ group: '603X408', sub: '10-OUT', item: 'WHITE' }], ['SKD-000001'], 'op-20-b', { 'SKD-000001': [vp], 'SKD-000004': [vp4] }]);
  ok('failed log append reported', !bad.ok, bad);
  const n1 = f.log.length;
  const r = await call('moveToWip', ['Second', '', [{ group: '603X408', sub: '10-OUT', item: 'WHITE' }], ['SKD-000001'], 'op-20-b', { 'SKD-000001': [vp], 'SKD-000004': [vp4] }]);
  const used20 = f.log.length - n1;
  ok('move with a removal ok', r.ok && r.result.moved[0].removed.join() === 'VARNISH', r);
  ok('cost: 6.5 - 4 + 6 = 8.5', Number(skidRow(f, 'SKD-000001')['Litho']) === 8.5, skidRow(f, 'SKD-000001')['Litho']);
  const c1 = await call('getTicketCard', ['SKD-000001']);
  ok('card: SIZE + WHITE', c1.result.coatings.map((c) => c.item).join() === 'SIZE,WHITE', c1.result.coatings);
  ok('removal for a ticket not in the batch is ignored', Number(skidRow(f, 'SKD-000004')['Litho']) === 6.5 && c4.result.coatings.length === 2
    && (await call('getTicketCard', ['SKD-000004'])).result.coatings.length === 2);
  const again = await call('moveToWip', ['Second', '', [{ group: '603X408', sub: '10-OUT', item: 'WHITE' }], ['SKD-000001'], 'op-20-b', { 'SKD-000001': [vp], 'SKD-000004': [vp4] }]);
  ok('retry changes nothing', again.ok && Number(skidRow(f, 'SKD-000001')['Litho']) === 8.5
    && txFor(f, 'SKD-000001').filter((t) => t['Item'] === 'COATING REMOVED (VOID)').length === 1, skidRow(f, 'SKD-000001')['Litho']);
  ok('batch with a removal still a few calls', used20 < 20, used20); void n0;
}

// 21. Database Master sheet: move between Current / WIP / Used and take coatings off, saved at once
{ const f = fresh();
  await call('moveToWip', ['Acme', '', [{ group: '603X408', sub: '10-OUT', item: 'SIZE' }, { group: '603X408', sub: '10-OUT', item: 'VARNISH' }], ['SKD-000001'], 'op-21-a']);
  const j = await call('createJob', ['Pend', 'Ann', [{ group: '603X408', sub: '10-OUT', item: 'SIZE' }], '', 'op-21-j']);
  await call('jobAddTicket', [j.result.jobId, 'SKD-000005', '', false, '', 'Ann', 'op-21-p', '', '']);
  await call('markUsedDirect', [['SKD-000004'], '2026-09-01', 'op-21-u']);
  const ms = await call('getMasterSheet', []);
  ok('master sheet loads', ms.ok, ms);
  const m1 = ms.result.rows.filter((x) => x.skidId === 'SKD-000001')[0];
  ok('master sheet row has live coatings with pass numbers', m1 && m1.status === 'WIP' && m1.coatings.map((c) => c.item).join() === 'SIZE,VARNISH' && m1.coatings[1].passNumber > 0, m1);
  ok('master sheet includes Current, Used and Pending', ['SKD-000002', 'SKD-000004', 'SKD-000005'].every((id) => ms.result.rows.some((x) => x.skidId === id)));
  const vp = m1.coatings[1].passNumber;
  const changes = [
    { skidId: 'SKD-000001', removePasses: [vp], status: 'Current', from: 'WIP' },
    { skidId: 'SKD-000002', status: 'Used', from: 'Current' },
    { skidId: 'SKD-000004', status: 'WIP', from: 'Used' },
    { skidId: 'SKD-000005', status: 'Current', from: 'Pending' },
  ];
  f.faults.push({ match: isTxAppend, mode: 'before', status: 400, times: 1 });
  const bad = await call('masterEdit', [changes, '', 'op-21-e']);
  ok('failed log append reported', !bad.ok, bad);
  const r = await call('masterEdit', [changes, '', 'op-21-e']);
  ok('master edit ok', r.ok, r);
  ok('WIP -> Current with VARNISH off', skidRow(f, 'SKD-000001')['Status'] === 'Current' && Number(skidRow(f, 'SKD-000001')['Litho']) === 2.5, skidRow(f, 'SKD-000001'));
  const s1 = skidRow(f, 'SKD-000001');
  ok('back to Current: leaves its job, coated/approved stamps cleared', !s1['Job ID'] && !s1['First Coated At'] && !s1['First Coated By'] && !s1['Approved By'], s1);
  ok('status log names the job it left', txFor(f, 'SKD-000001').some((t) => t['Item'] === 'STATUS CHANGED (DATABASE)' && /left job JOB-/.test(t['Notes'])));
  const s2 = skidRow(f, 'SKD-000002');
  ok('Current -> Used stamps today, via Database', s2['Status'] === 'Used' && /^\d{4}-\d\d-\d\d$/.test(s2['Used At']) && s2['Used Via'] === 'Database', s2);
  const s4 = skidRow(f, 'SKD-000004');
  ok('Used -> WIP clears the used date', s4['Status'] === 'WIP' && !s4['Used At'] && !s4['Used Via'], s4);
  ok('Pending ticket refused with a reason', skidRow(f, 'SKD-000005')['Status'] === 'Pending' && r.result.skipped.some((x) => x.skidId === 'SKD-000005' && /Review Jobs/.test(x.reason)), r.result.skipped);
  const log1 = txFor(f, 'SKD-000001');
  ok('status change and removal logged once each (after the retry)', log1.filter((t) => t['Item'] === 'STATUS CHANGED (DATABASE)').length === 1
    && log1.filter((t) => t['Item'] === 'COATING REMOVED (VOID)').length === 1 && log1.some((t) => /WIP → Current/.test(t['Notes'])), log1.map((t) => [t['Item'], t['Notes']]));
  const again = await call('masterEdit', [changes, '', 'op-21-e']);
  ok('retry of a saved batch changes nothing', again.ok && Number(skidRow(f, 'SKD-000001')['Litho']) === 2.5 && txFor(f, 'SKD-000001').length === log1.length, again);
  const card = await call('getTicketCard', ['SKD-000001']);
  ok('card: only SIZE left', card.result.coatings.map((c) => c.item).join() === 'SIZE');
  const mj = (await call('getJobDetail', [skidRow(f, 'SKD-000004')['Job ID'] || txFor(f, 'SKD-000001').filter((t) => t['Job ID'])[0]['Job ID']])).result;
  ok('the old job no longer lists it', mj && !mj.tickets.some((t) => t.skidId === 'SKD-000001'), mj && mj.tickets);
  const rec = await call('moveToWip', ['Re-run', '', [{ group: '603X408', sub: '10-OUT', item: 'WHITE' }], ['SKD-000001'], 'op-21-rc']);
  const s1b = skidRow(f, 'SKD-000001');
  ok('re-coat fills it all in fresh', rec.ok && s1b['Job ID'] === rec.result.jobId && s1b['First Coated By'] === 'Foreman' && Number(s1b['Litho']) === 8.5, s1b);
  const none = await call('masterEdit', [[{ skidId: 'SKD-000002', status: 'Used', from: 'Used' }], '', 'op-21-n']);
  ok('no real change: refused, nothing written', !none.ok && /nothing to change/.test(none.error), none);
}

// 22. Ticket history: every logged event plus counts, loads cut from it, parent and pieces
{ const f = fresh();
  await call('moveToWip', ['Acme', '', [{ group: '603X408', sub: '10-OUT', item: 'SIZE' }, { group: '603X408', sub: '10-OUT', item: 'VARNISH' }], ['SKD-000001'], 'op-22-a']);
  const ms = await call('getMasterSheet', []);
  const vp = ms.result.rows.filter((x) => x.skidId === 'SKD-000001')[0].coatings[1].passNumber;
  await call('masterEdit', [[{ skidId: 'SKD-000001', removePasses: [vp], from: 'WIP' }], '', 'op-22-e']);
  await call('setSkidsCounted', [['SKD-000001'], true, 'Cora', 'op-22-c']);
  const sess = await call('createSlitterSession', ['Slitter', 'S1', 'Ann', '', 'op-22-s']);
  await call('slitterLoadSkid', [sess.result.sessionId, 'SKD-000001', 'Ann', 'op-22-l']);
  await call('slitterFinishPallet', [sess.result.sessionId, 40, '', 'Ann', 'op-22-f']);
  const j = await call('createJob', ['Part job', 'Ann', [{ group: '603X408', sub: '10-OUT', item: 'SIZE' }], '', 'op-22-j']);
  await call('jobAddTicket', [j.result.jobId, 'SKD-000004', 100, true, '', 'Ann', 'op-22-p', '', '']);
  const h = await call('getSkidHistory', ['SKD-000001']);
  ok('history loads', h.ok, h);
  const ev = h.ok ? h.result.events : [];
  const find = (w) => ev.filter((e) => e.what === w)[0];
  ok('live coat listed with chem code', find('Coated: SIZE') && find('Coated: SIZE').chemCode === 'CH1' && !find('Coated: SIZE').voided, find('Coated: SIZE'));
  ok('removed coat shown as voided, plus the removal', find('Coated: VARNISH') && find('Coated: VARNISH').voided && ev.some((e) => e.what === 'COATING REMOVED (VOID)' && e.kind === 'void'), ev.map((e) => e.what));
  ok('count shown (from the row)', ev.some((e) => e.what === 'COUNTED (steel count)' && e.by === 'Cora'), ev.map((e) => e.what));
  ok('slitter load cut from it', ev.some((e) => /^CUT INTO LOAD/.test(e.what)) && h.result.loads.length === 1 && h.result.loads[0].used === 40, h.result.loads);
  ok('newest first', ev.length > 3 && ev[0].when >= ev[ev.length - 1].when, ev.map((e) => e.when));
  ok('summary carries the trace', h.result.skid.customer === 'Acme' && h.result.skid.ticket === '100' && h.result.skid.coatings.length === 1, h.result.skid);
  const rem = f.rows(SID, 'Steel Tickets').filter((o) => o['Split Of'] === 'SKD-000004')[0];
  const hp = await call('getSkidHistory', ['SKD-000004']);
  ok('partial: pieces made from it listed', hp.ok && hp.result.children.some((c) => c.skidId === rem['Skid ID']), hp.result && hp.result.children);
  const hr = await call('getSkidHistory', [rem['Skid ID']]);
  ok('leftover: knows its parent', hr.ok && hr.result.parent && hr.result.parent.skidId === 'SKD-000004' && hr.result.events.some((e) => e.what === 'SPLIT REMAINDER CREATED'), hr.result && [hr.result.parent, hr.result.events.map((e) => e.what)]);
  const miss = await call('getSkidHistory', ['SKD-999999']);
  ok('unknown skid: clear error', !miss.ok && /not found/.test(miss.error));
}

// 23. Receivers: numbered R-00001.., attached to tickets through the Master sheet save, inherited
//     by pieces cut from a ticket, shown in the trace / history, retry-safe, delete only when empty.
{ const f = fresh();
  const bad = await call('saveReceiver', [{ date: '2026-10-01', supplier: '' }, '', 'op-23-x']);
  ok('supplier required', !bad.ok && /supplier/i.test(bad.error), bad);
  const badLink = await call('saveReceiver', [{ supplier: 'TCC', link: 'drive/abc' }, '', 'op-23-y']);
  ok('link must be a web address', !badLink.ok && /https/.test(badLink.error), badLink);
  const a = await call('saveReceiver', [{ date: '2026-10-01', supplier: ' tcc ', pos: '7974-DC, 7976-DC; 7974-dc', link: 'https://drive.google.com/file/d/abc/view', notes: '3 bills' }, 'Jo', 'op-23-a']);
  ok('first receiver is R-00001', a.ok && a.result.id === 'R-00001', a);
  ok('file name YY-MM-DD--SUPPLIER--R-number', a.ok && a.result.name === '26-10-01--TCC--R-00001', a.result);
  ok('POs tidied (duplicate dropped)', a.ok && a.result.pos === '7974-DC, 7976-DC', a.result);
  const a2 = await call('saveReceiver', [{ date: '2026-10-01', supplier: 'TCC' }, 'Jo', 'op-23-a']);
  ok('retry of the create returns the same receiver', a2.ok && a2.result.id === 'R-00001' && f.rows(SID, 'Receivers').length === 1, a2);
  const b = await call('saveReceiver', [{ supplier: 'Reynolds' }, 'Jo', 'op-23-b']);
  ok('second is R-00002, no date', b.ok && b.result.id === 'R-00002' && b.result.name === 'NO-DATE--REYNOLDS--R-00002', b.result);
  const e = await call('saveReceiver', [{ id: 'R-00002', date: '2026-09-01', supplier: 'REY', pos: '8780-DC' }, 'Jo', 'op-23-e']);
  ok('edit renames it', e.ok && f.rows(SID, 'Receivers').filter((r) => r['Receiver ID'] === 'R-00002')[0]['File Name'] === '26-09-01--REY--R-00002', f.rows(SID, 'Receivers'));
  // Attach (also an Used/WIP ticket) + one unknown receiver; first try loses the ticket write.
  const changes = [{ skidId: 'SKD-000001', receiver: 'R-00001', from: 'Current' }, { skidId: 'SKD-000003', receiver: 'r-00001', from: 'WIP' },
    { skidId: 'SKD-000004', receiver: 'R-00001', from: 'Current' }, { skidId: 'SKD-000005', receiver: 'R-00099', from: 'Current' }];
  f.faults.push({ match: isMasterStamp, mode: 'before', status: 400, times: 1 });
  const fail1 = await call('masterEdit', [changes, '', 'op-23-m']);
  ok('attach: failed write reported', !fail1.ok && !skidRow(f, 'SKD-000001')['Receiver'], fail1);
  const m = await call('masterEdit', [changes, '', 'op-23-m']);
  ok('attach saved', m.ok && skidRow(f, 'SKD-000001')['Receiver'] === 'R-00001' && skidRow(f, 'SKD-000003')['Receiver'] === 'R-00001', m);
  ok('unknown receiver skipped with a reason', m.ok && m.result.skipped.some((x) => x.skidId === 'SKD-000005' && /R-00099/.test(x.reason)) && !skidRow(f, 'SKD-000005')['Receiver'], m.result && m.result.skipped);
  ok('status untouched by a receiver-only change', skidRow(f, 'SKD-000003')['Status'] === 'WIP' && skidRow(f, 'SKD-000001')['Status'] === 'Current');
  ok('receiver changes are not written to Transactions', !f.rows(SID, 'Transactions').some((t) => /^RECEIVER/.test(t['Item'] || '')), f.rows(SID, 'Transactions'));
  const again = await call('masterEdit', [changes, '', 'op-23-m']);
  ok('the same save again (retry after it landed) changes nothing', again.ok && skidRow(f, 'SKD-000001')['Receiver'] === 'R-00001' && f.rows(SID, 'Receivers').filter((r) => r['Receiver ID'] === 'R-00001')[0]['Tickets'].split(', ').length === 3, again);
  const same = await call('masterEdit', [[{ skidId: 'SKD-000001', receiver: 'R-00001' }], '', 'op-23-s']);
  ok('already on it: nothing saved', !same.ok && /already on R-00001/.test(same.error), same);
  // A piece cut from a ticket inherits its receiver.
  const j = await call('createJob', ['Part job', 'Ann', [{ group: '603X408', sub: '10-OUT', item: 'SIZE' }], '', 'op-23-j']);
  await call('jobAddTicket', [j.result.jobId, 'SKD-000004', 100, true, '', 'Ann', 'op-23-p', '', '']);
  const rem = f.rows(SID, 'Steel Tickets').filter((o) => o['Split Of'] === 'SKD-000004')[0];
  const hr = await call('getSkidHistory', [rem['Skid ID']]);
  ok('leftover piece keeps the receiver (copied with the row)', hr.ok && hr.result.skid.receiver === 'R-00001' && rem['Receiver'] === 'R-00001', hr.result && hr.result.skid);
  // A piece with no receiver of its own takes it from the skid it was split from.
  f.books[SID].tabs['Steel Tickets'].rows.push(skid('103-MR1', 'SKD-000050', 'Current', 10, 50, { 'Split Of': rem['Skid ID'] }));
  const hi = await call('getSkidHistory', ['SKD-000050']);
  ok('piece without its own receiver inherits it', hi.ok && hi.result.skid.receiver === 'R-00001' && hi.result.skid.receiverFrom === '103', hi.result && hi.result.skid);
  const h1 = await call('getSkidHistory', ['SKD-000001']);
  ok('history: receiver in the summary', h1.ok && h1.result.skid.receiverName === '26-10-01--TCC--R-00001' && /drive\.google/.test(h1.result.skid.receiverLink), h1.result && h1.result.skid);
  const g = await call('getReceivers', []);
  const r1 = g.ok && g.result.receivers.filter((r) => r.id === 'R-00001')[0];
  ok('list: ticket count and newest first', r1 && r1.ticketCount === 4 && g.result.receivers[0].id === 'R-00002', g.result && g.result.receivers);
  ok('list: tickets carry own / inherited receiver', g.ok && g.result.tickets.some((t) => t.skidId === 'SKD-000050' && !t.receiver && t.via === 'R-00001')
    && g.result.suppliers.indexOf('TCC') !== -1, g.result && g.result.tickets);
  const ms = await call('getMasterSheet', []);
  ok('master sheet lists receivers and each row\'s', ms.ok && ms.result.receivers.length === 2 && ms.result.rows.filter((x) => x.skidId === 'SKD-000001')[0].receiverOwn === 'R-00001', ms.result && ms.result.receivers);
  await call('moveToWip', ['Acme', '', [{ group: '603X408', sub: '10-OUT', item: 'SIZE' }], ['SKD-000001'], 'op-23-w']);
  const rep = await call('getDepartmentReport', ['2000-01-01', '2099-12-31', 'litho']);
  const lrow = rep.ok && rep.result.sections.flatMap((x) => x.rows).filter((x) => x.skidId === 'SKD-000001')[0];
  ok('report trace carries the receiver', lrow && lrow.receiver === 'R-00001', lrow);
  // Delete: refused while tickets are on it; allowed after they come off.
  const d1 = await call('deleteReceiver', ['R-00001', '', 'op-23-d']);
  ok('delete refused while in use', !d1.ok && /4 ticket/.test(d1.error), d1);
  const off = await call('masterEdit', [['SKD-000001', 'SKD-000003', 'SKD-000004', rem['Skid ID']].map((id) => ({ skidId: id, receiver: '' })), '', 'op-23-o']);
  ok('take off: cleared (not logged)', off.ok && !skidRow(f, 'SKD-000001')['Receiver'] && !txFor(f, 'SKD-000001').some((t) => /^RECEIVER/.test(t['Item'] || '')), off);
  const d2 = await call('deleteReceiver', ['R-00001', '', 'op-23-d2']);
  ok('delete when empty', d2.ok && !f.rows(SID, 'Receivers').some((r) => r['Receiver ID'] === 'R-00001') && f.rows(SID, 'Receivers').length === 1, d2);
  const d3 = await call('deleteReceiver', ['R-00001', '', 'op-23-d2']);
  ok('delete again: already gone', d3.ok && d3.result.alreadyGone, d3);
  const c = await call('saveReceiver', [{ supplier: 'CMD' }, '', 'op-23-c']);
  ok('numbers are not reused after a delete', c.ok && c.result.id === 'R-00003', c.result);
}

// 24. Receivers keep their tickets' mill / ticket numbers, so a wipe of Steel Tickets (Fresh Import)
//     puts each ticket back on the right receiver — by mill, then ticket number, never guessing.
{ const f = fresh();
  const tab = (name) => f.books[SID].tabs[name];
  const addTab = (name, rows) => { f.books[SID].tabs[name] = { id: 900 + f.books[SID].order.length, rows, rowCount: 1000, colCount: 40 }; f.books[SID].order.push(name); };
  const setCell = (name, keyCol, key, col, v) => {
    const t = tab(name), h = t.rows[0], ki = h.indexOf(keyCol), ci = h.indexOf(col);
    const row = t.rows.filter((r) => r[ki] === key)[0];
    while (row.length <= ci) row.push('');
    row[ci] = v;
  };
  const rcvRow = (id) => f.rows(SID, 'Receivers').filter((r) => r['Receiver ID'] === id)[0];
  tab('Steel Tickets').rows.push(
    skid('200', 'SKD-000060', 'Current', 10, 50, { 'Mill': 'MA1' }),
    skid('201', 'SKD-000061', 'WIP', 10, 50, { 'Mill': 'ma2 ' }),
    skid('202', 'SKD-000062', 'Current', 10, 50),
    skid('203', 'SKD-000063', 'Current', 10, 50, { 'Mill': 'MB1' }),
    skid('204', 'SKD-000064', 'Current', 10, 50, { 'Mill': 'MZ' }));
  await call('saveReceiver', [{ date: '2026-10-01', supplier: 'TCC' }, '', 'op-24-a']);
  await call('saveReceiver', [{ date: '2026-10-02', supplier: 'CMD' }, '', 'op-24-b']);
  const m = await call('masterEdit', [[['SKD-000060', 'R-00001'], ['SKD-000061', 'R-00001'], ['SKD-000062', 'R-00001'], ['SKD-000063', 'R-00002']]
    .map((x) => ({ skidId: x[0], receiver: x[1] })), '', 'op-24-m']);
  ok('kept: attached', m.ok && m.result.saved.length === 4, m);
  ok('kept: mills and tickets written on the receiver', rcvRow('R-00001')['Mill Numbers'] === 'MA1, MA2' && rcvRow('R-00001')['Tickets'] === '200, 201, 202'
    && rcvRow('R-00002')['Mill Numbers'] === 'MB1' && rcvRow('R-00002')['Tickets'] === '203', f.rows(SID, 'Receivers'));
  const mv = await call('masterEdit', [[{ skidId: 'SKD-000061', receiver: 'R-00002' }], '', 'op-24-mv']);
  ok('kept: moving a ticket moves its numbers', mv.ok && rcvRow('R-00001')['Mill Numbers'] === 'MA1' && rcvRow('R-00001')['Tickets'] === '200, 202'
    && rcvRow('R-00002')['Mill Numbers'] === 'MB1, MA2' && rcvRow('R-00002')['Tickets'] === '203, 201', f.rows(SID, 'Receivers'));
  // A ticket put on a receiver before keeping existed (Receiver typed in the sheet).
  setCell('Steel Tickets', 'Skid ID', 'SKD-000001', 'Receiver', 'R-00002');
  const g1 = await call('getReceivers', []);
  ok('kept: not-yet-saved numbers counted', g1.ok && g1.result.receivers.filter((r) => r.id === 'R-00002')[0].unkept === 1, g1.result && g1.result.receivers);
  const k = await call('keepReceiverNumbers', ['', 'op-24-k']);
  ok('kept: Save them now', k.ok && k.result.changed === 1 && rcvRow('R-00002')['Tickets'] === '203, 201, 100', k);
  const k2 = await call('keepReceiverNumbers', ['', 'op-24-k2']);
  ok('kept: running it again changes nothing', k2.ok && k2.result.changed === 0, k2);
  // MZ kept on both receivers -> never guessed.
  setCell('Receivers', 'Receiver ID', 'R-00001', 'Mill Numbers', 'MA1, MZ');
  setCell('Receivers', 'Receiver ID', 'R-00002', 'Mill Numbers', 'MB1, MA2, MZ');
  const g2 = await call('getReceivers', []);
  const t204 = g2.ok && g2.result.tickets.filter((t) => t.skidId === 'SKD-000064')[0];
  ok('kept: a mill on two receivers is a conflict, not a match', t204 && !t204.match && t204.matchConflict, t204);
  // Wipe & re-import: same tickets come back with new Skid IDs, one with a new ticket number.
  addTab('Current', [['Ticket', 'QTY/LOAD', 'Mill'], ['202', 10, ''], ['999', 5, 'MB1'], ['300', 5, 'MZ'], ['200', 10, 'MA1']]);
  addTab('WIP', [['Ticket', 'QTY/LOAD', 'Mill'], ['201', 10, 'MA2']]);
  const imp = await call('importStaging', ['op-24-i']);
  ok('import ok', imp.ok && imp.result.total === 5, imp);
  const byT = (t) => f.rows(SID, 'Steel Tickets').filter((r) => r['Ticket'] === t)[0];
  ok('import: back on by mill', byT('200')['Receiver'] === 'R-00001' && byT('201')['Receiver'] === 'R-00002' && byT('999')['Receiver'] === 'R-00002',
    f.rows(SID, 'Steel Tickets').map((r) => [r['Ticket'], r['Skid ID'], r['Receiver']]));
  ok('import: no mill -> back on by ticket number', byT('202')['Receiver'] === 'R-00001', byT('202'));
  ok('import: two-receiver mill left blank and reported', !byT('300')['Receiver'] && imp.result.receiverConflicts.indexOf('300') !== -1, imp.result);
  ok('import: count put back', imp.result.receiversRestored === 4, imp.result);
  // 203's mill came back as ticket 999 (same coil, new number) so it counts as back; 100 isn't in the import.
  ok('import: tickets that didn\'t come back are named', imp.result.receiversNotBack.join() === '100 (R-00002)' && imp.result.receiversNotBackCount === 1, imp.result);
  ok('import: receivers and their numbers untouched', f.rows(SID, 'Receivers').length === 2 && /203/.test(rcvRow('R-00002')['Tickets']), f.rows(SID, 'Receivers'));
  // Lost again by hand (Receiver cell cleared): the Receivers screen finds it by mill.
  setCell('Steel Tickets', 'Ticket', '999', 'Receiver', '');
  const g3 = await call('getReceivers', []);
  const t999 = g3.ok && g3.result.tickets.filter((t) => t.ticket === '999')[0];
  ok('found by a kept number', t999 && t999.match === 'R-00002' && t999.matchBy === 'mill', t999);
  // A receiver that still remembers numbers can't be deleted.
  const d = await call('deleteReceiver', ['R-00001', '', 'op-24-d']);
  ok('delete refused while numbers are kept', !d.ok, d);
  const off = await call('masterEdit', [[{ skidId: byT('200')['Skid ID'], receiver: '' }, { skidId: byT('202')['Skid ID'], receiver: '' }], '', 'op-24-o']);
  setCell('Receivers', 'Receiver ID', 'R-00001', 'Mill Numbers', '');
  ok('taking tickets off drops their numbers', off.ok && rcvRow('R-00001')['Tickets'] === '', rcvRow('R-00001'));
  const d2 = await call('deleteReceiver', ['R-00001', '', 'op-24-d2']);
  ok('delete once nothing is kept', d2.ok && !rcvRow('R-00001'), d2);
}

// 25. Fresh Import dies after the wipe, before the rows are written: the retry still puts the
//     receivers back (from the numbers kept on the Receivers tab, saved before the wipe).
{ const f = fresh();
  const tab = (name) => f.books[SID].tabs[name];
  tab('Steel Tickets').rows.push(skid('200', 'SKD-000060', 'Current', 10, 50, { 'Mill': 'MA1' }));
  await call('saveReceiver', [{ date: '2026-10-01', supplier: 'TCC' }, '', 'op-25-a']);
  await call('masterEdit', [[{ skidId: 'SKD-000060', receiver: 'R-00001' }], '', 'op-25-m']);
  for (const [name, rows] of [['Current', [['Ticket', 'Mill'], ['200', 'MA1']]], ['WIP', [['Ticket', 'Mill']]]]) {
    f.books[SID].tabs[name] = { id: 950 + f.books[SID].order.length, rows, rowCount: 1000, colCount: 40 }; f.books[SID].order.push(name);
  }
  f.faults.push({ match: (r) => r.kind === 'write' && r.decoded.includes("Steel Tickets'!A2"), mode: 'before', status: 503, times: 50 });
  const i1 = await call('importStaging', ['op-25-i']);
  ok('import attempt 1 fails after the wipe', !i1.ok && !f.rows(SID, 'Steel Tickets').length, i1);
  f.faults.length = 0;
  const i2 = await call('importStaging', ['op-25-i']);
  const r200 = f.rows(SID, 'Steel Tickets').filter((r) => r['Ticket'] === '200')[0];
  ok('retry puts the receiver back from the kept numbers', i2.ok && r200 && r200['Receiver'] === 'R-00001' && i2.result.receiversRestored === 1, [i2, r200]);
}

// 26. Find in Drive: search unassigned tickets' mill numbers in the shared scans, review by file,
//     approve = new receiver + copy into the receivers folder + attach. Retry-safe; quota fallback.
{ const f = fresh();
  const DEST = '18PRmpTAcNgjmcjQ3_hELRHcsPkYGND98';
  f.books[SID].tabs['Steel Tickets'].rows.push(
    skid('300', 'SKD-000070', 'Current', 10, 50, { 'Mill': '3045220' }),
    skid('301', 'SKD-000071', 'WIP', 10, 50, { 'Mill': '3045214' }),
    skid('302', 'SKD-000072', 'Current', 10, 50, { 'Mill': '9999999' }),
    skid('303', 'SKD-000073', 'Current', 10, 50, { 'Mill': '3044661' }),
    skid('304', 'SKD-000074', 'Current', 10, 50, { 'Mill': 'A / B' }));
  const ARCH = '1wFGdaTg9Rep-ac6DM3rC9x6FA3HLh--_', FOLDER = 'application/vnd.google-apps.folder';
  f.drive.files.push(
    { id: ARCH, name: 'Raw Metal Packing Slip Archive', mimeType: FOLDER, parents: ['root'] },
    { id: DEST, name: 'Raw Metal Packing Slips', mimeType: FOLDER, parents: [ARCH] },
    { id: 'fold-tcc', name: '2026 TCC Steel', mimeType: FOLDER, parents: [ARCH] },
    { id: 'fold-tcc-sep', name: 'September', mimeType: FOLDER, parents: ['fold-tcc'] },
    { id: 'out-1', name: 'Steel report.pdf', mimeType: 'application/pdf', parents: ['mine'], text: '3045220 3044661 9999999' },
    { id: 'fold-rey', name: '2025 Reynolds', mimeType: FOLDER, parents: [ARCH] },
    { id: 'src-1', name: 'Container Supply_20251028_121716.pdf', mimeType: 'application/pdf', parents: ['fold-rey'], createdTime: '2025-10-28T16:58:38Z', text: 'P.O.#: 7730-DC 1 3045220 85 T-5 2 3045214/ 85' },
    { id: 'src-2', name: 'Container Supply_20251014.pdf', mimeType: 'application/pdf', parents: ['fold-rey'], createdTime: '2025-10-14T10:00:00Z', text: '3044661 v' },
    { id: 'dst-1', name: '25-10-14--RN--R-00001.pdf', mimeType: 'application/pdf', parents: [DEST], createdTime: '2026-10-01T10:00:00Z', text: '3044661' },
    { id: 'fold-prod', name: 'Production Slips', mimeType: FOLDER, parents: [ARCH] },
    { id: 'prod-1', name: 'scan_0601.pdf', mimeType: 'application/pdf', parents: ['fold-prod'], text: '3045220 3044661' },
    { id: 'prod-2', name: 'Production Slips 2025-10.pdf', mimeType: 'application/pdf', parents: ['fold-rey'], text: '3045220' },
    { id: 'xls-1', name: '26-09-30 Current.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', parents: ['mine'], text: '3045220 3044661' });
  await call('saveReceiver', [{ date: '2025-10-14', supplier: 'RN' }, '', 'op-26-r1']);
  // A search logged before the archive limit (no Scope) doesn't count.
  f.books[SID].tabs['Drive Search'] = { id: 990, rows: [['Mill', 'File ID', 'File Name', 'File Link', 'Folder ID', 'Folder Name', 'File Date', 'Searched At'],
    ['3045220', 'out-1', 'Steel report.pdf', 'x', 'mine', '', '', '2026-01-01 00:00:00'],
    ['3044661', 'prod-1', 'scan_0601.pdf', 'x', 'fold-prod', 'Production Slips', '', '2026-01-02 00:00:00', ARCH]], rowCount: 1000, colCount: 40 };
  f.books[SID].order.push('Drive Search');
  const s1 = await call('driveSearchMills', [false]);
  ok('drive: searched every unassigned mill once', s1.ok && s1.result.searched === 5 && s1.result.remaining === 0 && s1.result.found === 3, s1);
  const s2 = await call('driveSearchMills', [false]);
  ok('drive: nothing left to search', s2.ok && s2.result.searched === 0, s2);
  const g = await call('getDriveMatches', []);
  const gr = g.ok ? g.result.groups : [];
  const gid = (id) => gr.filter((x) => x.fileId === id)[0];
  ok('drive: the copy in the receivers folder comes first, pointing at its receiver', gr[0] && gr[0].fileId === 'dst-1' && gr[0].receiver === 'R-00001' && gr[0].tickets[0].ticket === '303', gr);
  ok('drive: a scan groups its tickets, with folder and suggested supplier / PO', gid('src-1') && gid('src-1').tickets.length === 2 && gid('src-1').folderName === '2025 Reynolds'
    && gid('src-1').mills.join() === '3045214,3045220', gid('src-1'));
  ok('drive: an original already copied points to the copy', gid('src-2') && gid('src-2').coveredBy.join() === 'R-00001', gid('src-2'));
  ok('drive: spreadsheets are not searched', !gid('xls-1'));
  ok('drive: nothing titled Production Slips (file or folder)', !gid('prod-1') && !gid('prod-2'), gr.map((x) => x.fileId));
  ok('drive: only scans inside the archive folder', !gid('out-1'), gr.map((x) => x.fileId));
  ok('drive: not found and not searchable listed', g.result.misses.map((x) => x.mill).join() === '9999999,M77' && g.result.noMill >= 1 && g.result.unsearched === 0, g.result);
  // Approve the scan: new receiver, copy, attach (first try loses the attach's log append).
  const rec = { fileId: 'src-1', date: '2025-10-28', supplier: 'rn', pos: '7730-DC', notes: '', skidIds: ['SKD-000070', 'SKD-000071'] };
  f.faults.push({ match: isMasterStamp, mode: 'before', status: 400, times: 1 });
  const a1 = await call('approveDriveMatch', [rec, 'Jo', 'op-26-a']);
  ok('drive approve: failed attach reported', !a1.ok, a1);
  const a2 = await call('approveDriveMatch', [rec, 'Jo', 'op-26-a']);
  const copies = f.drive.files.filter((x) => (x.parents || []).includes(DEST) && /R-00002/.test(x.name));
  ok('drive approve: one receiver, one copy named for it', a2.ok && a2.result.receiver === 'R-00002' && f.rows(SID, 'Receivers').length === 2 && copies.length === 1 && copies[0].name === '25-10-28--RN--R-00002.pdf', [a2, copies]);
  const r2 = f.rows(SID, 'Receivers').filter((x) => x['Receiver ID'] === 'R-00002')[0];
  ok('drive approve: linked to the copy, source remembered', r2['Drive Link'] === 'https://drive.google.com/file/d/' + copies[0].id + '/view' && r2['Source File ID'] === 'src-1', r2);
  ok('drive approve: tickets on it, numbers kept', skidRow(f, 'SKD-000070')['Receiver'] === 'R-00002' && skidRow(f, 'SKD-000071')['Receiver'] === 'R-00002' && r2['Mill Numbers'] === '3045214, 3045220', r2);
  const a3 = await call('approveDriveMatch', [rec, 'Jo', 'op-26-a']);
  ok('drive approve: again with the same op changes nothing', a3.ok && f.rows(SID, 'Receivers').length === 2 && f.drive.files.filter((x) => /R-00002/.test(x.name)).length === 1
    && skidRow(f, 'SKD-000070')['Receiver'] === 'R-00002', a3);
  const a4 = await call('approveDriveMatch', [{ receiverId: 'R-00001', skidIds: ['SKD-000073'] }, 'Jo', 'op-26-b']);
  ok('drive: attach to the receiver already in the folder', a4.ok && !a4.result.created && skidRow(f, 'SKD-000073')['Receiver'] === 'R-00001', a4);
  // A My Drive folder: Google refuses the service account's copy -> linked to the original.
  f.books[SID].tabs['Steel Tickets'].rows.push(skid('305', 'SKD-000075', 'Current', 10, 50, { 'Mill': '5550001' }));
  f.drive.files.push({ id: 'src-3', name: 'TCC_0915.pdf', mimeType: 'application/pdf', parents: ['fold-tcc-sep'], createdTime: '2026-09-15T08:00:00Z', text: '5550001' });
  f.drive.quota = true;
  await call('driveSearchMills', [false]);
  const gq = await call('getDriveMatches', []);
  ok('drive: a folder two levels down is searched too', gq.ok && gq.result.groups.some((x) => x.fileId === 'src-3' && x.folderName === 'September'), gq.result && gq.result.groups.map((x) => [x.fileId, x.folderName]));
  const q = await call('approveDriveMatch', [{ fileId: 'src-3', date: '2026-09-15', supplier: 'TCC', skidIds: ['SKD-000075'] }, 'Jo', 'op-26-q']);
  const r3 = f.rows(SID, 'Receivers').filter((x) => x['Receiver ID'] === 'R-00003')[0];
  ok('drive: copy refused -> receiver still made, linked to the original, told why', q.ok && q.result.copy && !q.result.copy.copied && /My Drive/.test(q.result.copy.copyError)
    && q.result.copy.copyName === '26-09-15--TCC--R-00003.pdf' && r3 && r3['Drive Link'] === 'https://drive.google.com/file/d/src-3/view' && skidRow(f, 'SKD-000075')['Receiver'] === 'R-00003', [q, r3]);
  f.drive.quota = false;
  // Search again finds a scan added later for a mill that wasn't found.
  f.drive.files.push({ id: 'src-4', name: 'late.pdf', mimeType: 'application/pdf', parents: ['fold-tcc'], text: '9999999' });
  const ag = await call('driveSearchMills', [true]);
  ok('drive: search again only re-searches the misses', ag.ok && ag.result.searched === 2 && ag.result.found === 1, ag);
  const ag2 = await call('driveSearchMills', [ag.result.cutoff]);
  ok('drive: ...once', ag2.ok && ag2.result.searched === 0, ag2);
  const g2 = await call('getDriveMatches', []);
  ok('drive: approved files drop off the list; the late scan shows', g2.ok && !g2.result.groups.some((x) => x.fileId === 'src-1' || x.fileId === 'dst-1') && g2.result.groups.some((x) => x.fileId === 'src-4')
    && g2.result.misses.map((x) => x.mill).join() === 'M77', g2.result && g2.result.groups);
  const bad = await call('approveDriveMatch', [{ fileId: 'src-4', supplier: 'TCC', skidIds: [] }, 'Jo', 'op-26-x']);
  ok('drive: approve needs a ticket', !bad.ok && /ticket/.test(bad.error), bad);
  f.books[SID].tabs['Steel Tickets'].rows.push(skid('306', 'SKD-000076', 'Current', 10, 50, { 'Mill': '7770001' }));
  const ns = await call('driveSearchMills', [false], Object.assign({}, envBase, { RECEIVER_SOURCE_FOLDER: 'not-shared' }));
  ok('drive: archive folder not shared -> says to share it', !ns.ok && /Share it with the service account/.test(ns.error), ns);
}

// 27. Fresh Import with a "Used In Production" tab (any capitals): each ticket comes in once as Used,
//     dated the last day it was used, the other days in System Notes; a ticket still on Current / WIP
//     stays open with its used days noted; bad / future dates are reported.
{ const f = fresh();
  const addTab = (name, rows) => { f.books[SID].tabs[name] = { id: 960 + f.books[SID].order.length, rows, rowCount: 1000, colCount: 40 }; f.books[SID].order.push(name); };
  addTab('Current', [['Ticket', 'QTY/LOAD', 'Mill'], ['500', 10, 'M5']]);
  addTab('WIP', [['Ticket', 'QTY/LOAD', 'Mill'], ['101425-005', 975, '467268']]);
  const U = ['Date Used', 'Ticket', 'Row', 'Supplier', 'Weight', 'Cost', 'Litho', 'Mill', 'QTY/LOAD', 'PO Number'];
  addTab('Used In Production', [U,
    ['260918-002', '081826-007', 'M-001', 'RN', '4,570.00', '$71.62', '', '3076992', 1568, '8474-DC'],
    ['260916-005', '081826-007', 'M-001', 'RN', '4,570.00', '$71.62', '', '3076992', 1568, '8474-DC'],
    ['260924-004', '081826-007', 'M-001', 'RN', '4,570.00', '$71.62', '', '3076992', 368, '8474-DC'],
    ['260605-001', '031626-100', 'M-001', 'KG', '5,435.00', '$84.63', '19.38', 'DOK0298C01', 1300, '7756-DC'],
    ['290918-001', '091126-012', '', 'RN', '2,565.00', '$72.37', '0', '3082865', 1031, '8780-DC'],
    ['261340-001', '091126-013', '', 'RN', '10', '$1', '', 'X1', 1, ''],
    ['260720-005', '101425-005', 'W-013', 'LS', '3,897.00', '$78.85', '9.69', '467268', 527, '7323-DC'],
    ['', '', '', '', '', '', '', '', '', '']]);
  const imp = await call('importStaging', ['op-27-i']);
  const st = f.rows(SID, 'Steel Tickets');
  const used = st.filter((r) => r['Status'] === 'Used');
  const row = (t) => st.filter((r) => r['Ticket'] === t);
  ok('used import: counts (one Used row per ticket)', imp.ok && imp.result.current === 1 && imp.result.wip === 1 && imp.result.used === 4 && imp.result.usedLines === 7
    && imp.result.total === 6 && imp.result.usedTab === 'Used In Production', imp);
  ok('used import: Used rows after Current / WIP with new Skid IDs', used.length === 4 && used[0]['Skid ID'] === 'SKD-000003', used.map((r) => r['Skid ID']));
  const kg = row('031626-100')[0];
  ok('used import: date used recorded, every column carried', kg['Used At'] === '2026-06-05' && kg['Used Via'] === 'Import' && kg['Date Used'] === '260605-001'
    && kg['Row'] === 'M-001' && kg['Supplier'] === 'KG' && kg['Mill'] === 'DOK0298C01' && kg['PO Number'] === '7756-DC' && !kg['System Notes'], kg);
  const md = row('081826-007');
  ok('used import: used on several days -> one row, the last day, every day noted', md.length === 1 && md[0]['Used At'] === '2026-09-24' && md[0]['QTY/LOAD'] === '368'
    && md[0]['Date Used'] === '260916-005, 260918-002, 260924-004'
    && md[0]['System Notes'] === 'Used in production on 3 days: 2026-09-16 (QTY 1568), 2026-09-18 (QTY 1568), 2026-09-24 (QTY 368)'
    && imp.result.usedMultiDay.join() === '081826-007 (3 days)', [md, imp.result.usedMultiDay]);
  const op = row('101425-005');
  ok('used import: still on WIP -> stays one WIP skid, the used day noted', op.length === 1 && op[0]['Status'] === 'WIP' && !op[0]['Used At']
    && op[0]['System Notes'] === 'Used in production 2026-07-20 (QTY 527) (from Access)' && imp.result.usedAlsoOpen.join() === '101425-005', [op, imp.result.usedAlsoOpen]);
  ok('used import: a bad date is blank and reported', !row('091126-013')[0]['Used At'] && imp.result.usedBadDate.join() === '091126-013 (261340-001)', imp.result);
  ok('used import: a future date is kept but reported', row('091126-012')[0]['Used At'] === '2029-09-18' && imp.result.usedFutureDate.join() === '091126-012 (290918-001)', imp.result);
  ok('used import: logged', /Used 4\)/.test(f.rows(SID, 'Transactions').filter((r) => r['Item'] === 'FRESH IMPORT')[0]['Notes'] || ''), f.rows(SID, 'Transactions'));
  // "$84.63" reads as 84.63 (not 0) in the reports; a multi-day ticket is counted once.
  const rp = await call('getDepartmentReport', ['2026-06-01', '2026-09-30', 'direct']);
  const rows = rp.ok ? (rp.result.sections || []).filter((x) => x.key === 'direct')[0].rows : [];
  ok('used import: in the used report once each, with cost', rows.length === 2 && rows.filter((r) => r.ticket === '031626-100')[0].cost === 84.63
    && rows.filter((r) => r.ticket === '081826-007').length === 1, rows);
  // No Used tab: Current / WIP only, as before.
  delete f.books[SID].tabs['Used In Production']; f.books[SID].order = f.books[SID].order.filter((n) => n !== 'Used In Production');
  const imp2 = await call('importStaging', ['op-27-j']);
  ok('used import: no tab -> skipped', imp2.ok && imp2.result.used === 0 && imp2.result.usedTab === '' && imp2.result.total === 2 && !f.rows(SID, 'Steel Tickets').filter((r) => r['Ticket'] === '101425-005')[0]['System Notes'], imp2);
}

// 28. Begin trace: steel of a size (End Use diameter) used on the production days around a date.
{ const f = fresh();
  const H = ['Ticket', 'Skid ID', 'Status', 'Supplier', 'Mill', 'End Use', 'PO Number', 'QTY/LOAD', 'Used At', 'Used Via', 'Date Used', 'System Notes', 'Receiver'];
  const row = (o) => H.map((h) => (o[h] == null ? '' : o[h]));
  f.books[SID].tabs['Steel Tickets'].rows = [H,
    row({ 'Ticket': '061226-006', 'Skid ID': 'SKD-1', 'Status': 'Used', 'Supplier': 'RN', 'Mill': '3069131', 'End Use': '401 ENDS', 'Used At': '2026-07-24', 'Date Used': '260714-002, 260724-003' }),
    row({ 'Ticket': '061226-007', 'Skid ID': 'SKD-2', 'Status': 'Used', 'Supplier': 'RN', 'Mill': '3069132', 'End Use': '401X400', 'Used At': '2026-07-14 09:30:00', 'Receiver': 'R-00001' }),
    row({ 'Ticket': '040626-013', 'Skid ID': 'SKD-3', 'Status': 'Used', 'Supplier': 'RN', 'Mill': '3059113', 'End Use': '401 ENDS', 'Used At': '2026-07-10' }),
    row({ 'Ticket': '101425-005', 'Skid ID': 'SKD-4', 'Status': 'WIP', 'Supplier': 'LS', 'Mill': '467268', 'End Use': '401X411', 'System Notes': 'Used in production 2026-07-14 (QTY 527) (from Access)' }),
    row({ 'Ticket': '020926-102', 'Skid ID': 'SKD-5', 'Status': 'Used', 'Supplier': 'KG', 'Mill': 'DOK0768C03', 'End Use': '603X700', 'Used At': '2026-07-14' }),
    row({ 'Ticket': '070626-015', 'Skid ID': 'SKD-6', 'Status': 'Used', 'Supplier': 'RN', 'Mill': '1613011041', 'End Use': '401X400', 'Used At': '2026-07-31' }),
    row({ 'Ticket': '100000-001', 'Skid ID': 'SKD-7', 'Status': 'Current', 'Supplier': 'RN', 'Mill': 'X', 'End Use': '401X400' }),
    row({ 'Ticket': '050526-003', 'Skid ID': 'SKD-8', 'Status': 'Used', 'Supplier': 'RN', 'Mill': '3060537', 'End Use': '211 OIL', 'Used At': '2026-07-14' })];
  await call('saveReceiver', [{ date: '2026-06-12', supplier: 'RN' }, '', 'op-28-r']);
  const sz = await call('getUseTrace', ['2026-07-14', '', 1]);
  ok('trace: what was used ON that day, by line — bodies of every height together, ends apart, odd ones alone', sz.ok
    && sz.result.sizes.map((z) => z.key + '=' + z.label + ':' + z.count).join() === '211 OIL=211 OIL:1,401 BODIES=401 Bodies:2,401 ENDS=401 Ends:1,603 BODIES=603 Bodies:1'
    && sz.result.sizes[1].endUses.map((e) => e.endUse).join() === '401X400,401X411' && sz.result.dayCount === 5, sz.result && sz.result.sizes);
  const sz0 = await call('getUseTrace', ['2026-07-12', '', 1]);
  ok('trace: a day with nothing used offers the nearest production days', sz0.ok && !sz0.result.sizes.length && sz0.result.prevDay === '2026-07-10' && sz0.result.nextDay === '2026-07-14', sz0.result);
  const t = await call('getUseTrace', ['2026-07-14', '401', 1]);
  const dl = t.ok ? t.result.dayList : [];
  ok('trace: the calendar day before / of / after', dl.map((x) => x.rel + x.offset + ' ' + x.date + ' ' + x.tickets.length).join() === 'before1 2026-07-13 0,on0 2026-07-14 3,after1 2026-07-15 0', dl.map((x) => [x.rel, x.date, x.tickets.length]));
  const on = dl[1] ? dl[1].tickets : [];
  ok('trace: the day of lists every 401 ticket used that day (multi-day, partial, timestamped)', on.map((x) => x.ticket).join() === '101425-005,061226-006,061226-007', on.map((x) => x.ticket));
  const t7 = on.filter((x) => x.ticket === '061226-007')[0], t6 = on.filter((x) => x.ticket === '061226-006')[0], t4 = on.filter((x) => x.ticket === '101425-005')[0];
  ok('trace: each ticket has supplier, mill and receiver', t7 && t7.supplier === 'RN' && t7.mill === '3069132' && t7.receiver === 'R-00001' && /R-00001/.test(t7.receiverName), t7);
  ok('trace: multi-day and partly used tickets flagged', t6 && t6.daysCount === 2 && t6.usedDays.join() === '2026-07-14,2026-07-24' && t4 && t4.stillOpen && t4.status === 'WIP', [t6, t4]);
  ok('trace: other sizes left out', !on.some((x) => x.ticket === '020926-102'));
  const tb = await call('getUseTrace', ['2026-07-14', '401 BODIES', 1]);
  ok('trace: 401 Bodies = every 401 height (a changeover is covered), no ends', tb.ok && tb.result.label === '401 Bodies' && tb.result.dayList[1].tickets.map((y) => y.ticket).join() === '101425-005,061226-007', tb.result && tb.result.dayList[1].tickets.map((y) => y.ticket));
  const ta = await call('getUseTrace', ['2026-07-14', 'ALL', 1]);
  ok('trace: all steel used that day', ta.ok && ta.result.label === 'All steel' && ta.result.dayList[1].tickets.length === 5, ta.result && ta.result.dayList[1].tickets.map((y) => y.ticket));
  ok('trace: each ticket says who it was for and whether it was coated', tb.ok && 'litho' in tb.result.dayList[1].tickets[0] && 'comments' in tb.result.dayList[1].tickets[0]);
  const te = await call('getUseTrace', ['2026-07-14', '401 ends', 1]);
  ok('trace: by one end use — only its tickets', te.ok && te.result.label === '401 Ends' && te.result.dayList.map((x) => x.date + ':' + x.tickets.map((y) => y.ticket).join('+')).join() === '2026-07-13:,2026-07-14:061226-006,2026-07-15:', te.result && te.result.dayList.map((x) => [x.date, x.tickets.map((y) => y.ticket)]));
  const t2 = await call('getUseTrace', ['2026-07-14', '401', 2]);
  ok('trace: 2 days each side', t2.ok && t2.result.dayList.map((x) => x.rel + x.offset + ' ' + x.date).join() === 'before2 2026-07-12,before1 2026-07-13,on0 2026-07-14,after1 2026-07-15,after2 2026-07-16', t2.result && t2.result.dayList.map((x) => x.date));
  const t5 = await call('getUseTrace', ['2026-07-11', '401', 1]);
  ok('trace: across a month / the steel on the day after', t5.ok && t5.result.dayList.map((x) => x.date + ' ' + x.tickets.length).join() === '2026-07-10 1,2026-07-11 0,2026-07-12 0', t5.result && t5.result.dayList);
  const tm = await call('getUseTrace', ['2026-08-01', '401', 1]);
  ok('trace: month boundary', tm.ok && tm.result.dayList.map((x) => x.date + ' ' + x.tickets.length).join() === '2026-07-31 1,2026-08-01 0,2026-08-02 0', tm.result && tm.result.dayList);
  const t3 = await call('getUseTrace', ['2026-07-12', '401', 1]);
  ok('trace: a day with nothing used still shows, with its neighbours', t3.ok && t3.result.dayList.map((x) => x.rel + ' ' + x.date + ' ' + x.tickets.length).join() === 'before 2026-07-11 0,on 2026-07-12 0,after 2026-07-13 0', t3.result && t3.result.dayList.map((x) => [x.rel, x.date, x.tickets.length]));
  const bad = await call('getUseTrace', ['', '401', 1]);
  ok('trace: needs a date', !bad.ok && /date/.test(bad.error), bad);
}

// 29. A Liner is a press: its runs land in the Press report, not Metal Lines
{ const f = fresh();
  const run = await call('createRun', ['A Liner', 'Ann', '', 'op-29-r']);
  ok('run on A Liner', run.ok && run.result.machine === 'A Liner', run);
  const id = run.result.runId;
  const add = await call('runAddSkid', [id, 'SKD-000001', 'Ann', 'op-29-a']);
  ok('skid loaded', add.ok, add);
  const sub = await call('submitRun', [id, 'Ann', 'op-29-s']);
  ok('submitted', sub.ok, sub);
  const fin = await call('finishRun', [id, { 'SKD-000001': 1000 }, 'Ann', 'op-29-f']);
  ok('finished', fin.ok && skidRow(f, 'SKD-000001')['Status'] === 'Used', fin);
  const d0 = '2000-01-01', d1 = '2100-01-01';
  const rep = await call('getDepartmentReport', [d0, d1, 'all']);
  const sec = (k) => ((rep.result && rep.result.sections) || []).filter((x) => x.key === k)[0] || { rows: [] };
  ok('A Liner run is in the Press report', rep.ok && sec('press').rows.some((r) => r.machine === 'A Liner'), rep.ok ? sec('press') : rep);
  ok('and not in Metal Lines', !sec('lines').rows.some((r) => r.machine === 'A Liner'));
}

// 30. Coil changeover: two coils back to back, the skid across the change carries both mills
{ const fake2 = makeFake({ [SID]: { 'Steel Tickets': [MASTER_H,
    skid('C-1', 'SKD-000006', 'Current', '', 20000, { 'C/S': 'C', 'Mill': 'M77', 'End Use': '603X700' }),
    skid('C-2', 'SKD-000007', 'Current', '', 18000, { 'C/S': 'C', 'Mill': 'M88', 'End Use': '603X700' }),
  ], 'Transactions': [TX_H] } });
  globalThis.fetch = fake2.fetchImpl;
  const skids = [{ weight: 1000, qty: 250, coils: [0] }, { weight: 900, coils: [0, 1], parts: [175, 1125] }, { weight: 1100, qty: 260, coils: [1] }];
  const info = { operator: 'Giovanni', start: '08:00', end: '14:30', spoilage: [15, 10] };
  const r = await call('cutCoil', [['SKD-000006', 'SKD-000007'], '2026-10-07', 1, skids, false, 'op-30-c', info]);
  ok('changeover cut ok', r.ok && r.result.created === 3, r);
  const kids = fake2.rows(SID, 'Steel Tickets').filter((o) => /^100726-1/.test(o['Ticket']));
  ok('3 skids, tickets in order', kids.map((o) => o['Ticket']).join() === '100726-100,100726-101,100726-102', kids.map((o) => o['Ticket']));
  ok('changeover skid = the two coils\' sheets added up', kids[1]['QTY/LOAD'] == 1300 && /175 sheets from C-1 \[mill M77\] and 1125 from C-2 \[mill M88\]/.test(kids[1]['System Notes']), [kids[1]['QTY/LOAD'], kids[1]['System Notes']]);
  ok('operator on the skids', kids.every((o) => o['Last Updated By'] === 'Giovanni'));
  ok('mills: first coil, both, second coil', kids.map((o) => o['Mill']).join('|') === 'M77|M77 / M88|M88', kids.map((o) => o['Mill']));
  ok('changeover skid links both coils', kids[1]['Split Of'] === 'SKD-000006' && kids[1]['Also Cut From'] === 'SKD-000007' && /changeover/i.test(kids[1]['System Notes']), kids[1]);
  ok('skid after the change belongs to the second coil', kids[2]['Split Of'] === 'SKD-000007' && !kids[2]['Also Cut From']);
  const c1 = fake2.rows(SID, 'Steel Tickets').filter((o) => o['Skid ID'] === 'SKD-000006')[0];
  const c2 = fake2.rows(SID, 'Steel Tickets').filter((o) => o['Skid ID'] === 'SKD-000007')[0];
  ok('first coil ran out -> Used; last coil left open', c1['Status'] === 'Used' && c1['Used Via'] === 'Coil' && c2['Status'] === 'Current', [c1['Status'], c2['Status']]);
  const txs = fake2.rows(SID, 'Transactions');
  ok('a history row for each coil, naming the changeover', txs.length === 2 && txs.every((t) => /changeover with/.test(t['Notes'])), txs.map((t) => t['Notes']));
  ok('each coil\'s row says how many sheets of the changeover were its own, who ran it and when', /100726-101 \(175 of 1300, changeover with C-2\)/.test(txs[0]['Notes']) && /100726-101 \(1125 of 1300, changeover with C-1\)/.test(txs[1]['Notes'])
    && /by Giovanni \(08:00–14:30\)/.test(txs[0]['Notes']) && /spoilage 15/.test(txs[0]['Notes']) && txs[0]['Operator'] === 'Giovanni', txs.map((t) => t['Notes']));
  ok('spoilage saved on each coil', c1['Spoilage'] == 15 && c2['Spoilage'] == 10, [c1['Spoilage'], c2['Spoilage']]);
  const again = await call('cutCoil', [['SKD-000006', 'SKD-000007'], '2026-10-07', 1, skids, false, 'op-30-c']);
  ok('retry makes nothing new', again.ok && again.result.duplicate && fake2.rows(SID, 'Steel Tickets').length === 5 && fake2.rows(SID, 'Transactions').length === 2, again);
  const h = await call('getSkidHistory', ['SKD-000007']);
  ok('second coil\'s history lists the changeover skid and its own', h.ok && h.result.children.map((c) => c.ticket).sort().join() === '100726-101,100726-102', h.ok ? h.result.children : h);
  const h2 = await call('getSkidHistory', [kids[1]['Skid ID']]);
  ok('changeover skid shows both coils it came from', h2.ok && h2.result.parent.skidId === 'SKD-000006' && h2.result.alsoParent.skidId === 'SKD-000007', h2.ok ? [h2.result.parent, h2.result.alsoParent] : h2);
  const bad = await call('cutCoil', [['SKD-000006', 'SKD-000007'], '2026-10-07', 1, [{ weight: 1, qty: 1, coils: [0, 2] }], true, 'op-30-x']);
  ok('a changeover must join coils next to each other', !bad.ok && /next to each other/.test(bad.error), bad);
  const more = await call('cutCoil', ['SKD-000007', '2026-10-07', 1, [{ weight: 500, qty: 100 }], false, 'op-30-m']);
  const single = await call('cutCoil', ['SKD-000007', '2026-10-08', 1, [{ weight: 500, qty: 100 }], true, 'op-30-s']);
  ok('more cut the same day continues the numbering', more.ok && more.result.tickets[0].ticket === '100726-103', more.ok ? more.result.tickets : more);
  ok('a single coil still cuts as before', single.ok && single.result.created === 1 && fake2.rows(SID, 'Steel Tickets').filter((o) => o['Skid ID'] === 'SKD-000007')[0]['Status'] === 'Used', single);
}

// 31. An unfinished skid at the end of a run is finished by the next run and takes its first number
{ const fk = makeFake({ [SID]: { 'Steel Tickets': [MASTER_H,
    skid('C-3', 'SKD-000010', 'Current', '', 13000, { 'C/S': 'C', 'Mill': '26HCD20181', 'End Use': '603 ENDS' }),
    skid('C-4', 'SKD-000011', 'Current', '', 13000, { 'C/S': 'C', 'Mill': '26HCD20190', 'End Use': '603 ENDS' }),
    skid('C-5', 'SKD-000012', 'Current', '', 13000, { 'C/S': 'C', 'Mill': '26HCD20200', 'End Use': '603 ENDS' }),
    skid('C-6', 'SKD-000013', 'Current', '', 13000, { 'C/S': 'C', 'Mill': '26HCD20210', 'End Use': '603 ENDS' }),
  ], 'Transactions': [TX_H] } });
  globalThis.fetch = fk.fetchImpl;
  const row = (id) => fk.rows(SID, 'Steel Tickets').filter((o) => o['Skid ID'] === id)[0];
  // Day 1: -200, -201 off coil 3, which runs out with 925 sheets on a skid that isn't full.
  const d1 = await call('cutCoil', [['SKD-000010'], '2026-09-10', 2, [{ qty: 1300, coils: [0] }, { qty: 1300, coils: [0] }], true, 'op-31-a', { operator: 'Giovanni', carryOut: 925 }]);
  ok('day 1: 2 skids, the unfinished one isn\'t made yet', d1.ok && d1.result.tickets.map((t) => t.ticket).join() === '091026-200,091026-201', d1);
  ok('day 1: coil 3 is FIN (Used) and holds the 925 for line 2', row('SKD-000010')['Status'] === 'Used' && row('SKD-000010')['Carry Over'] == 925 && row('SKD-000010')['Carry Over Line'] == 2 && row('SKD-000010')['Carry Over Date'] === '2026-09-10', row('SKD-000010'));
  const all = await call('getAllTickets', []);
  ok('the page sees the carry-over', all.ok && all.result.filter((t) => t.skidId === 'SKD-000010')[0].carryOver === 925);
  // Day 2: a new coil's first 375 finish it as the day's -200, then -201 off the new coil.
  const d2 = await call('cutCoil', [['SKD-000010', 'SKD-000011'], '2026-09-11', 2,
    [{ coils: [0, 1], parts: [925, 375] }, { qty: 1300, coils: [1] }], false, 'op-31-b', { operator: 'Giovanni', carryIn: { skidId: 'SKD-000010' } }]);
  ok('day 2 ok', d2.ok, d2);
  const k2 = fk.rows(SID, 'Steel Tickets').filter((o) => /^091126-2/.test(o['Ticket']));
  ok('day 2: -200 is 925 + 375 with both mills', k2[0] && k2[0]['Ticket'] === '091126-200' && k2[0]['QTY/LOAD'] == 1300 && k2[0]['Mill'] === '26HCD20181 / 26HCD20190'
    && k2[0]['Split Of'] === 'SKD-000010' && k2[0]['Also Cut From'] === 'SKD-000011' && /925 sheets from C-3/.test(k2[0]['System Notes']), k2[0]);
  ok('day 2: -201 off the new coil', k2[1] && k2[1]['Ticket'] === '091126-201' && k2[1]['Mill'] === '26HCD20190');
  ok('yesterday\'s coil keeps its Used date; its carry is cleared', row('SKD-000010')['Used At'] === '2026-09-10' && !row('SKD-000010')['Carry Over'], row('SKD-000010'));
  ok('the new coil stays open', row('SKD-000011')['Status'] === 'Current');
  const tx = fk.rows(SID, 'Transactions').filter((t) => t['Skid ID'] === 'SKD-000010');
  ok('coil 3 history: cut on day 1 (925 left), finished on day 2', tx.length === 2 && /925 sheets on an unfinished skid/.test(tx[0]['Notes']) && tx[1]['Item'] === 'UNFINISHED SKID FINISHED'
    && /091126-200 \(925 of 1300/.test(tx[1]['Notes']) && /left unfinished on 2026-09-10/.test(tx[1]['Notes']), tx.map((t) => t['Item'] + ': ' + t['Notes']));
  const again = await call('cutCoil', [['SKD-000010', 'SKD-000011'], '2026-09-11', 2,
    [{ coils: [0, 1], parts: [925, 375] }, { qty: 1300, coils: [1] }], false, 'op-31-b', { operator: 'Giovanni', carryIn: { skidId: 'SKD-000010' } }]);
  ok('retry makes nothing new', again.ok && again.result.duplicate && fk.rows(SID, 'Steel Tickets').length === 8, again);
  const twice = await call('cutCoil', [['SKD-000010', 'SKD-000012'], '2026-09-12', 2, [{ coils: [0, 1], parts: [925, 375] }], true, 'op-31-c', { carryIn: { skidId: 'SKD-000010' } }]);
  ok('it can\'t be finished twice', !twice.ok && /already finished/.test(twice.error), twice);
  // Same coil both days: left open with 500 on a skid; the next run continues on that coil.
  const d3 = await call('cutCoil', [['SKD-000011'], '2026-09-12', 1, [], false, 'op-31-d', { carryOut: 500 }]);
  ok('a run can end with only the unfinished skid', d3.ok && d3.result.created === 0 && row('SKD-000011')['Carry Over'] == 500 && row('SKD-000011')['Status'] === 'Current', d3);
  const d4 = await call('cutCoil', [['SKD-000011'], '2026-09-13', 1, [{ qty: 1300, coils: [0] }], true, 'op-31-e', { carryIn: { skidId: 'SKD-000011' } }]);
  const d5 = await call('cutCoil', [['SKD-000012'], '2026-09-14', 1, [{ qty: 1000, coils: [0] }], false, 'op-31-f', { carryOut: 300 }]);
  const d6 = await call('cutCoil', [['SKD-000012', 'SKD-000013'], '2026-09-15', 1, [{ coils: [0, 1], parts: [300, 1000] }], false, 'op-31-g', { carryIn: { skidId: 'SKD-000012', only: true } }]);
  ok('an open coil whose skid is finished on another coil stays open', d5.ok && d6.ok && row('SKD-000012')['Status'] === 'Current' && !row('SKD-000012')['Used At'] && !row('SKD-000012')['Carry Over'], [d6, row('SKD-000012')]);
  const d7 = await call('cutCoil', [['SKD-000013'], '2026-09-16', 2, [{ qty: 1300, coils: [0] }], true, 'op-31-h', { carryOut: 725 }]);
  const dd = await call('discardCoilCarry', ['SKD-000013', 'Jonathan', 'op-31-x']);
  ok('discard: the unfinished skid is dropped, the coil stays Used', d7.ok && dd.ok && dd.result.discarded === 725 && !row('SKD-000013')['Carry Over'] && row('SKD-000013')['Status'] === 'Used', [dd, row('SKD-000013')]);
  const dtx = fk.rows(SID, 'Transactions').filter((t) => t['Item'] === 'UNFINISHED SKID DISCARDED');
  ok('discard: history says how many sheets', dtx.length === 1 && /725 sheets on the unfinished skid left on 2026-09-16 \(coil line 2\) were discarded/.test(dtx[0]['Notes']) && dtx[0]['Operator'] === 'Jonathan', dtx.map((t) => t['Notes']));
  const dd2 = await call('discardCoilCarry', ['SKD-000013', 'Jonathan', 'op-31-x']);
  ok('discard: retry is a no-op', dd2.ok && dd2.result.duplicate && fk.rows(SID, 'Transactions').filter((t) => t['Item'] === 'UNFINISHED SKID DISCARDED').length === 1, dd2);
  const dd3 = await call('discardCoilCarry', ['SKD-000013', 'Jonathan', 'op-31-y']);
  ok('discard: nothing left to discard', !dd3.ok && /already finished or discarded/.test(dd3.error), dd3);
  ok('same coil: the next run finishes it as -100, and the coil is FIN', d4.ok && d4.result.tickets[0].ticket === '091326-100' && row('SKD-000011')['Status'] === 'Used' && !row('SKD-000011')['Carry Over'], d4);
}

// 32. A coil-changeover skid shows both coils' receivers
{ const RH = ['Receiver ID', 'File Name', 'Date Received', 'Supplier', 'POs', 'Drive Link', 'Source File ID', 'Notes', 'Mill Numbers', 'Tickets', 'Created At', 'Created By', 'Last Updated At', 'Op ID'];
  const H = MASTER_H.concat(['Receiver']);
  const sk = (t, id, status, extra) => { const o = Object.assign({ 'Ticket': t, 'Skid ID': id, 'Status': status }, extra); return H.map((h) => (o[h] == null ? '' : o[h])); };
  const fk = makeFake({ [SID]: { 'Steel Tickets': [H,
    sk('C-7', 'SKD-000020', 'Current', { 'C/S': 'C', 'Mill': 'MA', 'End Use': '603 ENDS', 'Receiver': 'R-00011', 'Supplier': 'TCC' }),
    sk('C-8', 'SKD-000021', 'Current', { 'C/S': 'C', 'Mill': 'MB', 'End Use': '603 ENDS', 'Receiver': 'R-00118', 'Supplier': 'TCC' }),
    sk('C-9', 'SKD-000022', 'Current', { 'C/S': 'C', 'Mill': 'MC', 'End Use': '603 ENDS', 'Supplier': 'TCC' }),
    sk('C-10', 'SKD-000023', 'Current', { 'C/S': 'C', 'Mill': 'MD', 'End Use': '603 ENDS', 'Receiver': 'R-00200', 'Supplier': 'TCC' }),
  ], 'Transactions': [TX_H], 'Receivers': [RH,
    ['R-00011', '26-01-01--KG--R-00011', '2026-01-01', 'KG', '', 'https://drive/r11', '', '', '', '', '', '', '', ''],
    ['R-00118', '26-06-12--TCC--R-00118', '2026-06-12', 'TCC', '', 'https://drive/r118', '', '', '', '', '', '', '', ''],
    ['R-00200', '26-07-01--TCC--R-00200', '2026-07-01', 'TCC', '', '', '', '', '', '', '', '', '', ''],
  ] } });
  globalThis.fetch = fk.fetchImpl;
  const c1 = await call('cutCoil', [['SKD-000020', 'SKD-000021'], '2026-09-16', 1, [{ qty: 1300, coils: [0] }, { coils: [0, 1], parts: [175, 1125] }, { qty: 1300, coils: [1] }], true, 'op-32-a']);
  const c2 = await call('cutCoil', [['SKD-000022', 'SKD-000023'], '2026-09-17', 1, [{ coils: [0, 1], parts: [500, 800] }], true, 'op-32-b']);
  ok('cuts ok', c1.ok && c2.ok, [c1, c2]);
  const tk = (t) => fk.rows(SID, 'Steel Tickets').filter((o) => o['Ticket'] === t)[0];
  const h = await call('getSkidHistory', [tk('091626-101')['Skid ID']]);
  ok('changeover skid: first coil\'s receiver, then the second\'s', h.ok && h.result.skid.receiver === 'R-00011'
    && h.result.skid.moreReceivers.length === 1 && h.result.skid.moreReceivers[0].receiver === 'R-00118' && h.result.skid.moreReceivers[0].receiverFrom === 'C-8'
    && h.result.skid.moreReceivers[0].receiverLink === 'https://drive/r118', h.ok ? h.result.skid : h);
  const h0 = await call('getSkidHistory', [tk('091626-100')['Skid ID']]);
  ok('a skid off one coil: one receiver', h0.ok && h0.result.skid.receiver === 'R-00011' && h0.result.skid.moreReceivers.length === 0);
  const h2 = await call('getSkidHistory', [tk('091726-100')['Skid ID']]);
  ok('first coil has no receiver: the second coil\'s is shown', h2.ok && h2.result.skid.receiver === 'R-00200' && h2.result.skid.moreReceivers.length === 0, h2.ok ? h2.result.skid : h2);
  const rc = await call('getReceivers', []);
  const t1 = rc.ok && rc.result.tickets.filter((t) => t.ticket === '091626-101')[0];
  ok('Receivers screen: the changeover skid takes both', t1 && (t1.receiver || t1.via) === 'R-00011' && t1.alsoVia.map((a) => a.receiver).join() === 'R-00118', t1);
  const ms = await call('getMasterSheet', []);
  const m1 = ms.ok && ms.result.rows.filter((t) => t.ticket === '091626-101')[0];
  ok('Master sheet: both receivers', m1 && m1.receiver === 'R-00011' && m1.moreReceivers[0].receiver === 'R-00118', m1);
  await call('markUsedDirect', [[tk('091626-101')['Skid ID']], '2026-09-18', 'op-32-u']);
  const tr = await call('getUseTrace', ['2026-09-18', 'ALL', 1]);
  const row = tr.ok && tr.result.dayList[1].tickets.filter((t) => t.ticket === '091626-101')[0];
  ok('Begin trace shows both receivers', row && row.receiver === 'R-00011' && row.moreReceivers.map((r) => r.receiver).join() === 'R-00118', tr.ok ? tr.result.dayList[1] : tr);
}

// 33. Back out of a work session: Delete puts its skids back; a skid marked Used by mistake can be loaded
{ const f = fresh();
  const run = await call('createRun', ['Press 13', 'Ann', '', 'op-33-r']);
  const id = run.result.runId;
  await call('runAddSkid', [id, 'SKD-000001', 'Ann', 'op-33-a']);
  await call('runAddSkid', [id, 'SKD-000003', 'Ann', 'op-33-b']);
  ok('two skids on the run', skidRow(f, 'SKD-000001')['Status'] === 'In Production' && skidRow(f, 'SKD-000003')['Status'] === 'In Production');
  const d = await call('deleteRun', [id, 'Ann', 'op-33-d']);
  ok('deleted: both skids back', d.ok && d.result.returned === 2 && skidRow(f, 'SKD-000001')['Status'] === 'Current' && skidRow(f, 'SKD-000003')['Status'] === 'WIP'
    && !skidRow(f, 'SKD-000001')['Run ID'], d);
  const runRow = f.rows(SID, 'Production Runs').filter((r) => r['Run ID'] === id)[0];
  ok('the run is marked Deleted and leaves the open list', runRow['Status'] === 'Deleted');
  const open = await call('getProductionRuns', ['', 'open']);
  ok('not listed as open', open.ok && !open.result.some((r) => r.runId === id));
  const txs = f.rows(SID, 'Transactions').filter((r) => /deleted/.test(r['Notes'] || ''));
  ok('each skid logs why it came off', txs.length === 2, txs.length);
  const d2 = await call('deleteRun', [id, 'Ann', 'op-33-d']);
  ok('a retry is harmless', d2.ok && f.rows(SID, 'Transactions').filter((r) => /deleted/.test(r['Notes'] || '')).length === 2, d2);

  const run2 = await call('createRun', ['Press 13', 'Ann', '', 'op-33-r2']);
  const id2 = run2.result.runId;
  await call('runAddSkid', [id2, 'SKD-000002', 'Ann', 'op-33-c']);
  await call('submitRun', [id2, 'Ann', 'op-33-s']);
  const d3 = await call('deleteRun', [id2, 'Ann', 'op-33-d3']);
  ok('a submitted run can\'t be deleted', !d3.ok && /submitted/.test(d3.error) && skidRow(f, 'SKD-000002')['Status'] === 'In Production', d3);

  const run3 = await call('createRun', ['Press 14', 'Ann', '', 'op-33-r3']);
  const id3 = run3.result.runId;
  await call('runAddSkid', [id3, 'SKD-000004', 'Ann', 'op-33-e']);
  await call('runSkidPartial', [id3, 'SKD-000004', 100, 'Ann', 'op-33-p']);
  const d4 = await call('deleteRun', [id3, 'Ann', 'op-33-d4']);
  ok('a run with a partial already split off can\'t be deleted', !d4.ok && /partial/.test(d4.error), d4);

  await call('markUsedDirect', [['SKD-000005'], '2026-10-01', 'op-33-u']);
  const run4 = await call('createRun', ['Press 15', 'Ann', '', 'op-33-r4']);
  const id4 = run4.result.runId;
  const n1 = await call('runAddSkid', [id4, 'SKD-000005', 'Ann', 'op-33-f']);
  ok('a Used skid needs the screen to say so', !n1.ok && /already marked Used/.test(n1.error), n1);
  const n2 = await call('runAddSkid', [id4, 'SKD-000005', 'Ann', 'op-33-g', true]);
  const r5 = skidRow(f, 'SKD-000005');
  ok('"Not used — load it": back on the run, the Used mark cleared and noted', n2.ok && r5['Status'] === 'In Production' && r5['Run ID'] === id4 && !r5['Used At'] && !r5['Used Via']
    && /Was marked Used 2026-10-01 but wasn't used/.test(r5['System Notes'] || ''), r5);
  ok('and logged', txFor(f, 'SKD-000005').some((r) => r['Item'] === 'USED UNDONE — ADDED TO PRODUCTION'));
  await call('cutCoil', ['SKD-000006', '2026-10-01', 1, [{ qty: 1300, weight: 5000 }], true, 'op-33-k']);
  const n3 = await call('runAddSkid', [id4, 'SKD-000006', 'Ann', 'op-33-h', true]);
  ok('a cut coil can\'t come back', !n3.ok && /coil line/.test(n3.error), n3);
  const all = await call('getAllTickets', []);
  ok('tickets carry the day they were used', all.ok && all.result.filter((t) => t.skidId === 'SKD-000006')[0].usedOn === '2026-10-01', all.ok && all.result.filter((t) => t.skidId === 'SKD-000006')[0]);
}

// 34. A slitter / scroll LOAD keeps every receiver of the skids it was cut from
{ const RH = ['Receiver ID', 'File Name', 'Date Received', 'Supplier', 'POs', 'Drive Link', 'Source File ID', 'Notes', 'Mill Numbers', 'Tickets', 'Created At', 'Created By', 'Last Updated At', 'Op ID'];
  const H = MASTER_H.concat(['Receiver', 'Also Cut From', 'Split Of']);
  const sk = (t, id, status, extra) => { const o = Object.assign({ 'Ticket': t, 'Skid ID': id, 'Status': status, 'QTY/LOAD': 500 }, extra); return H.map((h) => (o[h] == null ? '' : o[h])); };
  const fk = makeFake({ [SID]: { 'Steel Tickets': [H,
    sk('A-1', 'SKD-000030', 'Current', { 'Mill': 'MA', 'Receiver': 'R-00011' }),
    sk('B-1', 'SKD-000031', 'Current', { 'Mill': 'MB', 'Receiver': 'R-00118' }),
    sk('X-1', 'SKD-000032', 'Current', { 'Mill': 'MX / MY', 'Receiver': 'R-00011', 'Also Cut From': 'SKD-000033' }),   // a coil-changeover skid
    sk('Y-1', 'SKD-000033', 'Used', { 'Mill': 'MY', 'Receiver': 'R-00200' }),
    sk('W-1', 'SKD-000034', 'WIP', { 'Mill': 'MW', 'Litho': 12 }),
    sk('1001', 'SKD-000040', 'Cut', { 'Mill': 'MA / MB', 'Cut Type': 'Slit', 'Load #': 1001 }),   // an older load: sources only in Slitter Pallets
  ], 'Transactions': [TX_H], 'Receivers': [RH,
    ['R-00011', '26-01-01--KG--R-00011', '2026-01-01', 'KG', '', 'https://drive/r11', '', '', '', '', '', '', '', ''],
    ['R-00118', '26-06-12--TCC--R-00118', '2026-06-12', 'TCC', '', 'https://drive/r118', '', '', '', '', '', '', '', ''],
    ['R-00200', '26-07-01--TCC--R-00200', '2026-07-01', 'TCC', '', '', '', '', '', '', '', '', '', ''],
  ], 'Slitter Pallets': [['Pallet ID', 'Session ID', 'Created On', 'Output Count', 'Composition', 'Skid ID', 'Load #', 'Notes', 'Op ID'],
    ['PAL-00001', 'SLT-00001', '2026-10-01', 50, JSON.stringify([{ skidId: 'SKD-000030', ticket: 'A-1', mill: 'MA', strips: 20 }, { skidId: 'SKD-000031', ticket: 'B-1', mill: 'MB', strips: 30 }]), 'SKD-000040', 1001, '', 'op-x'],
  ] } });
  globalThis.fetch = fk.fetchImpl;
  const h = await call('getSkidHistory', ['SKD-000040']);
  ok('older load: both source skids\' receivers', h.ok && h.result.skid.receiver === 'R-00011' && h.result.skid.receiverFrom === 'A-1'
    && h.result.skid.moreReceivers.map((r) => r.receiver + '<' + r.receiverFrom).join() === 'R-00118<B-1', h.ok ? h.result.skid : h);
  // A new load cut from B-1, then (mid-pallet) the changeover skid X-1: three receivers in all.
  const sess = await call('createSlitterSession', ['Scroll', '2 SS', 'Ann', '', 'op-34-s']);
  const sid = sess.result.sessionId;
  await call('slitterLoadSkid', [sid, 'SKD-000031', 'Ann', 'op-34-l']);
  await call('slitterSwitchSkid', [sid, 20, 'SKD-000032', 'Ann', 'op-34-w']);
  const fin = await call('slitterFinishPallet', [sid, 50, '', 'Ann', 'op-34-f']);
  ok('pallet made', fin.ok && fin.result.newLoadNo, fin);
  const load = fk.rows(SID, 'Steel Tickets').filter((o) => o['Cut Type'] && o['Skid ID'] !== 'SKD-000040')[0];
  ok('the new load records what it was cut from', load && load['Cut From'] === 'SKD-000031, SKD-000032', load);
  const h2 = await call('getSkidHistory', [load['Skid ID']]);
  const all = h2.ok ? [h2.result.skid.receiver].concat(h2.result.skid.moreReceivers.map((r) => r.receiver)) : [];
  ok('new load: every receiver, the changeover skid\'s two included', all.join() === 'R-00118,R-00011,R-00200', h2.ok ? h2.result.skid : h2);
  const rc = await call('getReceivers', []);
  const t = rc.ok && rc.result.tickets.filter((x) => x.skidId === load['Skid ID'])[0];
  ok('Receivers screen: the load sits under all three', t && t.via === 'R-00118' && t.alsoVia.map((a) => a.receiver).join() === 'R-00011,R-00200', t);
  ok('a load cut from raw steel is Current', load['Status'] === 'Current', load['Status']);
  await call('slitterSwitchSkid', [sid, 10, 'SKD-000034', 'Ann', 'op-34-w2']);
  await call('slitterFinishPallet', [sid, 40, '', 'Ann', 'op-34-f2']);
  const load2 = fk.rows(SID, 'Steel Tickets').filter((o) => o['Cut Type'] && o['Skid ID'] !== 'SKD-000040' && o['Skid ID'] !== load['Skid ID'])[0];
  ok('a load with coated (WIP) steel in it is WIP', load2 && load2['Status'] === 'WIP' && load2['Cut From'] === 'SKD-000032, SKD-000034', load2);
  const run = await call('createRun', ['Press 2', 'Ann', '', 'op-34-r']);
  await call('runAddSkid', [run.result.runId, load2['Skid ID'], 'Ann', 'op-34-a']);
  await call('deleteRun', [run.result.runId, 'Ann', 'op-34-d']);
  ok('off a run, a load goes back to its own status', fk.rows(SID, 'Steel Tickets').filter((o) => o['Skid ID'] === load2['Skid ID'])[0]['Status'] === 'WIP');
}

console.log((fail ? '✗' : '✓') + ' worker_test: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
