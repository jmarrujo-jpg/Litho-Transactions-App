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
  ok('tickets 092926-101..103', ch.map((c) => c['Ticket']).join(',') === '092926-101,092926-102,092926-103', ch.map((c) => c['Ticket']));
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

console.log((fail ? '✗' : '✓') + ' worker_test: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
