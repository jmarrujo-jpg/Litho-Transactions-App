/**
 * Litho backend — Cloudflare edition (Stage 1: reads).
 *
 * Reimplements the read endpoints from Code.gs against the Google Sheets API. Writes are added
 * in Stage 2; until then they return a clear "not migrated yet" message so the Apps Script app
 * stays the one that mutates data.
 */
import { makeSheets, serialToYMD } from './google.js';

const MASTER = 'Steel Tickets';
const TRANSACTIONS = 'Litho Transactions';
const JOBS = 'Litho Jobs';
const RATE = 'Litho Rate Table';
const TZ = 'America/Los_Angeles';

const ADDON_SOURCE_GROUP = 'Specialty / Low Volume / Setup';
const ADDON_ITEM_NAMES = ['SIZE', 'ENAMEL ONE SIDE', 'WHITE BASE COAT',
  'VARNISH WET-STANDARD', 'VARNISH WET-PEBBLE', 'VARNISH DRY-STANDARD', 'VARNISH DRY-PEBBLE', 'WAX ONLY',
  'LITHO PRINT SINGLE COLOR - ONE', 'LITHO PRINT SINGLE COLOR - TWO', 'LITHO PRINT SINGLE COLOR - THREE',
  'LITHO PRINT SINGLE COLOR - FOUR', 'LITHO PRINT SINGLE COLOR - FIVE', 'LITHO PRINT SINGLE COLOR - SIX',
  'LITHO PRINT TWO COLOR - ONE', 'LITHO PRINT TWO COLOR - TWO', 'LITHO PRINT TWO COLOR - THREE',
  'LITHO PRINT TWO COLOR - FOUR', 'LITHO PRINT TWO COLOR - FIVE', 'LITHO PRINT TWO COLOR - SIX'];

function num(v) { return Number(v) || 0; }

/** Reads a whole tab into {headers, rows}, each row an object keyed by header name (+ __row). */
async function readObjects(sheets, tab, unformatted) {
  const values = await sheets.read(tab, unformatted);
  if (!values.length) return { headers: [], rows: [] };
  const headers = values[0].map((h) => String(h));
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

// ---- rate table ----
export async function getRateTree(sheets) {
  const { rows } = await readObjects(sheets, RATE);
  const groups = [];
  const tree = {};
  rows.forEach((r) => {
    const group = r['Group'];
    if (!group) return;
    if (!tree[group]) { tree[group] = { subs: [], items: {} }; groups.push(group); }
    const node = tree[group];
    const subKey = r['Sub-Variant'] || '';
    if (!node.items[subKey]) { node.items[subKey] = []; node.subs.push(r['Sub-Variant'] || ''); }
    node.items[subKey].push({
      item: r['Item'], chemCode: r['Chem Code'],
      appCost: num(r['Application Cost']), lineCost: num(r['Line Cost']), totalCost: num(r['Total Cost']),
    });
  });
  const addons = ((tree[ADDON_SOURCE_GROUP] && tree[ADDON_SOURCE_GROUP].items['']) || [])
    .filter((it) => ADDON_ITEM_NAMES.indexOf(it.item) !== -1);
  return { groups, tree, addonGroup: ADDON_SOURCE_GROUP, addons };
}

async function rateGroups(sheets) {
  const { rows } = await readObjects(sheets, RATE);
  const seen = {};
  const out = [];
  rows.forEach((r) => { if (r['Group'] && !seen[r['Group']]) { seen[r['Group']] = true; out.push(r['Group']); } });
  return out;
}

function guessGroupForEndUse(endUse, groups) {
  if (!endUse) return null;
  const normalized = String(endUse).toUpperCase().replace(/\s+/g, '');
  let best = null;
  groups.forEach((g) => {
    const tokens = String(g).toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
    tokens.forEach((tok) => { if (tok.length >= 3 && normalized.indexOf(tok) !== -1) best = g; });
  });
  return best;
}

// ---- tickets ----
export async function getAllTickets(sheets) {
  const { rows } = await readObjects(sheets, MASTER);
  return rows
    .filter((o) => o['Ticket'] || o['Skid ID'])
    .map((o) => ({
      skidId: o['Skid ID'] || '', ticket: o['Ticket'], supplier: o['Supplier'], endUse: o['End Use'],
      width: o['Width'], length: o['Length'], weight: o['Weight'], qty: o['QTY/LOAD'],
      bw: o['BW'], type: o['TC'], temper: o['TM'], litho: num(o['Litho']),
      status: o['Status'] || 'Current',
    }));
}

export function activeCoatings(history) {
  const voided = {};
  (history || []).forEach((h) => {
    const m = /^VOID#(\d+):/.exec(String(h.notes || ''));
    if (m) voided[m[1]] = true;
  });
  return (history || [])
    .filter((h) => String(h.group || '').trim() !== '' && num(h.passTotal) > 0 && !voided[String(h.passNumber)])
    .map((h) => ({ passNumber: h.passNumber, group: h.group, sub: h.sub, item: h.item, chemCode: h.chemCode, cost: num(h.passTotal) }));
}

export async function getTransactionHistory(sheets, skidId, ticket) {
  const { rows } = await readObjects(sheets, TRANSACTIONS);
  return rows
    .filter((r) => {
      const sid = String(r['Skid ID'] || '').trim();
      if (sid) return skidId && sid === String(skidId).trim();
      return ticket && String(r['Ticket']).trim() === String(ticket).trim();
    })
    .map((r) => ({
      timestamp: r['Timestamp'], ticket: r['Ticket'], passNumber: num(r['Pass Number']), operator: r['Operator'],
      group: r['Group'], sub: r['Sub-Variant'], item: r['Item'], chemCode: r['Chem Code'],
      appCost: r['Application Cost'], lineCost: r['Line Cost'], passTotal: r['Pass Total Cost'],
      runningTotal: r['Running Total After Pass'], notes: r['Notes'], jobName: r['Job Name'], skidId: r['Skid ID'],
    }))
    .sort((a, b) => a.passNumber - b.passNumber);
}

export async function getTicketCard(sheets, skidId) {
  const { rows } = await readObjects(sheets, MASTER);
  const obj = rows.filter((o) => String(o['Skid ID']).trim() === String(skidId).trim())[0];
  if (!obj) throw new Error('Skid not found: ' + skidId);
  const history = await getTransactionHistory(sheets, skidId, obj['Ticket']);
  const active = activeCoatings(history);
  const groups = await rateGroups(sheets);
  return {
    skidId: skidId, ticket: obj['Ticket'], status: obj['Status'] || 'Current', steel: obj,
    litho: num(obj['Litho']), passCount: active.length,
    suggestedGroup: guessGroupForEndUse(obj['End Use'], groups), coatings: active, transactions: history,
  };
}

// ---- jobs ----
export async function getJobsForDate(sheets, dateStr) {
  const { rows } = await readObjects(sheets, JOBS, true); // unformatted so Created At is a serial
  const target = dateStr || todayYMD();
  return rows
    .filter((o) => o['Job ID'])
    .filter((o) => serialToYMD(o['Created At'], TZ) === target)
    .map((o) => ({
      jobId: o['Job ID'], createdBy: o['Created By'], createdAt: serialToYMD(o['Created At'], TZ),
      description: o['Description'], coatings: o['Coatings'], ticketCount: o['Ticket Count'], status: o['Status'],
    }));
}

export async function getJobDetail(sheets, jobId) {
  const jobs = await readObjects(sheets, JOBS, true);
  const job = jobs.rows.filter((o) => String(o['Job ID']).trim() === String(jobId).trim())[0];
  if (!job) throw new Error('Job not found: ' + jobId);
  let recipe = [];
  try { recipe = JSON.parse(job['Coatings JSON'] || '[]') || []; } catch (e) { recipe = []; }
  const master = await readObjects(sheets, MASTER);
  const tickets = master.rows
    .filter((o) => String(o['Job ID']).trim() === String(jobId).trim())
    .map((o) => ({ skidId: o['Skid ID'], ticket: o['Ticket'], status: o['Status'], litho: num(o['Litho']),
      bw: o['BW'], type: o['TC'], temper: o['TM'], endUse: o['End Use'] }));
  return {
    jobId: job['Job ID'], description: job['Description'], createdBy: job['Created By'],
    createdAt: serialToYMD(job['Created At'], TZ), status: job['Status'],
    approvedAt: job['Approved At'] ? serialToYMD(job['Approved At'], TZ) : '', approvedBy: job['Approved By'],
    coatings: recipe, coatingsSummary: job['Coatings'], notes: job['Notes'], tickets: tickets,
  };
}

function todayYMD() {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch (e) { return new Date().toISOString().slice(0, 10); }
}

const WRITE_FNS = ['applyCoating', 'createManualTicket', 'updateWipLithoCost', 'editTicketCoating',
  'removeTicketCoating', 'updateTicketDetails', 'createJob', 'jobAddTicket', 'addCoatingToJob',
  'removeTicketFromJob', 'approveJob'];

export async function handle(fn, args, env) {
  const sheets = await makeSheets(env);
  args = args || [];
  switch (fn) {
    case 'getRateTree': return getRateTree(sheets);
    case 'getAllTickets': return getAllTickets(sheets);
    case 'getOperatorNames': return [];
    case 'getTicketCard': return getTicketCard(sheets, args[0]);
    case 'getJobsForDate': return getJobsForDate(sheets, args[0]);
    case 'getJobDetail': return getJobDetail(sheets, args[0]);
    default:
      if (WRITE_FNS.indexOf(fn) !== -1) {
        throw new Error('"' + fn + '" isn\'t on the new backend yet (Stage 2). Use the Apps Script app to make changes for now.');
      }
      throw new Error('Unknown function: ' + fn);
  }
}
