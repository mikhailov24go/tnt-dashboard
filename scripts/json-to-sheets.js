/**
 * json-to-sheets.js  v2 — Template-aware Trello → Google Sheets
 *
 * Reads Trello board JSON export, computes all TnT SOP metrics,
 * and writes them into the TnT_Dashboard_Template.
 *
 * Usage:
 *   node scripts/json-to-sheets.js exports/Ten8_2025-04-13.json
 *   node scripts/json-to-sheets.js exports/Ten8_2025-04-06.json --prev
 *   node scripts/json-to-sheets.js exports/Ten8_2025-04-13.json --mode=append
 *
 * Env vars:
 *   GOOGLE_SPREADSHEET_ID        — ID of your Google Sheet
 *   GOOGLE_SERVICE_ACCOUNT_JSON  — full JSON key content
 *
 * Template DATA sheet row map (columns B=current, C=previous, G-J=operators):
 *   10=GPS total  11=resolved  12=resolved%  13=escalated  14=escalated%
 *   15=auto       16=take-time 17=cycle      18=checklist% 19=no-comment
 *   21=temp total 22=resolved  23=resolved%  24=escalated  25=dev%
 *   26=avg-dev    27=photo-t   28=over5      29=mixed
 *   31=inb total  32=p0        33=p1         34=p2         35=p0-time
 *   36=p1p2-time  37=form%     38=no-load    39=incomplete
 *   41=red-tier   42=yellow    43=late-pu    44=fac-closed 45=stopped
 *   46=no-update  47=resolved% 48=interval   49=red-2min%
 *   51=team-total 52=esc-rate  53=avg-cycle  54=checklist% 55=no-comment
 *   56=5+comment  57=2+ops     58=due-remind
 */

const { google } = require('googleapis');
const fs         = require('fs');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const inputFile = args.find(a => !a.startsWith('--'));
const isPrev    = args.includes('--prev');
const mode      = (args.find(a => a.startsWith('--mode=')) || '--mode=template').split('=')[1];

if (!inputFile) {
  console.error('Usage: node scripts/json-to-sheets.js exports/FILE.json [--prev] [--mode=template|append]');
  process.exit(1);
}
if (!fs.existsSync(inputFile)) {
  console.error(`File not found: ${inputFile}`);
  process.exit(1);
}

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
let CREDENTIALS = null;
try {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    CREDENTIALS = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } else {
    CREDENTIALS = JSON.parse(fs.readFileSync('/tmp/gcloud-key.json', 'utf8'));
  }
} catch(e) {
  console.error('Cannot read Google credentials:', e.message);
  process.exit(1);
}
if (!SPREADSHEET_ID || !CREDENTIALS) {
  console.error('Missing env: GOOGLE_SPREADSHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON');
  process.exit(1);
}

// ── Load JSON ─────────────────────────────────────────────────────────────────
console.log(`\n📂 Loading: ${inputFile}`);
const board     = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
const boardName = board.name || 'Unknown';
const listMap   = Object.fromEntries((board.lists   || []).map(l => [l.id, l.name]));
const memberMap = Object.fromEntries((board.members || []).map(m => [m.id, m.username || m.fullName || m.id]));
const allCards   = (board.cards   || []).filter(c => !c.closed);
const allActions = (board.actions || []);

console.log(`📋 Board: ${boardName}`);
console.log(`   Cards: ${allCards.length} | Actions: ${allActions.length} | Members: ${Object.keys(memberMap).length}`);

// ── Operator mapping ───────────────────────────────────────────────────────────
// Columns: G=Dmytro  H=Natalia  I=Khrystyna  J=Others
const OP_MAP = {
  G: ['dmytrosvachii', 'dmytro'],
  H: ['nataliagarcia373', 'natalia'],
  I: ['khrystynapidhoretska', 'khrystyna'],
};

function opCol(memberId) {
  const username = (memberMap[memberId] || '').toLowerCase();
  for (const [col, aliases] of Object.entries(OP_MAP)) {
    if (aliases.some(a => username.includes(a))) return col;
  }
  return 'J'; // Others
}

// ── Card type detection ───────────────────────────────────────────────────────
function cardType(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('gps') && (n.includes('temp') || n.includes('temp check'))) return 'mixed';
  if (n.includes('gps'))           return 'gps';
  if (n.includes('temp check') || n.includes('temp-check')) return 'temp';
  if (n.includes('outbound'))      return 'outbound';
  if (n.includes('facility closed'))return 'inb_fac';
  if (n.includes('late pickup'))    return 'inb_late';
  if (n.includes('os&d') || n.includes('osd')) return 'inb_osd';
  if (n.includes('breakdown'))     return 'inb_brkd';
  if (n.includes('damaged'))       return 'inb_dmg';
  if (n.includes('bol') || n.includes('pod')) return 'inb_bol';
  if (n.includes('layover'))       return 'inb_lay';
  if (n.includes('stopped'))       return 'out_stop';
  if (n.includes('no update'))     return 'out_noupd';
  if (n.includes('pre-pickup') || n.includes('pre pickup')) return 'out_prepu';
  if (n.includes('pre-delivery') || n.includes('pre delivery')) return 'out_predel';
  return 'other';
}

const INBOUND_TYPES  = new Set(['inb_fac','inb_osd','inb_brkd','inb_dmg','inb_bol','inb_lay']);
const P0_INBOUND     = new Set(['inb_fac','inb_osd']);
const P1_INBOUND     = new Set(['inb_brkd','inb_dmg','inb_bol']);
const P2_INBOUND     = new Set(['inb_lay']);
const OUTBOUND_TYPES = new Set(['out_stop','out_noupd','out_prepu','out_predel','outbound','inb_late','inb_fac']);

// ── Parse description for temp data ───────────────────────────────────────────
function parseTempDesc(desc) {
  if (!desc) return null;
  const t = desc.match(/[Tt]arget[:\s]+(-?[\d.]+)/);
  const a = desc.match(/[Aa]ctual[:\s]+(-?[\d.]+)/);
  const d = desc.match(/[Dd]eviation[:\s]+(-?[\d.]+)/);
  if (!t && !a) return null;
  return {
    target:    t ? parseFloat(t[1]) : null,
    actual:    a ? parseFloat(a[1]) : null,
    deviation: d ? Math.abs(parseFloat(d[1])) : (t && a ? Math.abs(parseFloat(a[1]) - parseFloat(t[1])) : null),
  };
}

// ── Build card timeline from actions ──────────────────────────────────────────
const cardTimeline = {};
const cardCreatedAt = {};
const cardTakenAt   = {};

for (const a of [...allActions].reverse()) {
  const cid = a.data?.card?.id;
  if (!cid) continue;
  if (!cardTimeline[cid]) cardTimeline[cid] = [];

  if (a.type === 'createCard') {
    cardCreatedAt[cid] = a.date;
    cardTimeline[cid].push({ list: a.data?.list?.name || '', ts: a.date });
  } else if (a.type === 'updateCard' && a.data?.listAfter) {
    cardTimeline[cid].push({ list: a.data.listAfter.name, ts: a.date });
  } else if (a.type === 'updateCard' && a.data?.old?.idMembers !== undefined) {
    // Member assigned = "taken"
    if (!cardTakenAt[cid]) cardTakenAt[cid] = a.date;
  }
}

const IN_PROGRESS_RE = /progress|work|doing|в работе|in progress/i;
const DONE_RE        = /done|complete|resolved|finished/i;
const ESCALATED_RE   = /escalat/i;

// ── Core computation ──────────────────────────────────────────────────────────
// Per-operator accumulators
const OPS = ['B','G','H','I','J'];

function makeAcc() {
  return {
    gps_total:0, gps_resolved:0, gps_escalated:0, gps_auto:0,
    gps_take_times:[], gps_cycles:[], gps_checklist_done:0, gps_checklist_total:0,
    gps_no_comment:0,
    temp_total:0, temp_resolved:0, temp_escalated:0,
    temp_devs:[], temp_photo_times:[], temp_over5:0, temp_mixed:0,
    inb_total:0, inb_p0:0, inb_p1:0, inb_p2:0,
    inb_p0_times:[], inb_p1p2_times:[], inb_no_load:0, inb_incomplete:0,
    out_red:0, out_yellow:0, out_resolved:0, out_escalated:0,
    out_late:0, out_fac:0, out_stop:0, out_noupd:0,
    all_cycles:[], all_esc:0, all_total:0,
    all_checklist_done:0, all_checklist_total:0,
    all_no_comment:0, all_5plus_comment:0, all_2plus_ops:0, all_due_remind:0,
  };
}

const acc_all  = makeAcc();
const acc_ops  = { G: makeAcc(), H: makeAcc(), I: makeAcc(), J: makeAcc() };

function pick(cardId) {
  // Return operator column for primary member of card
  const card = allCards.find(c => c.id === cardId);
  if (!card || !card.idMembers?.length) return 'J';
  return opCol(card.idMembers[0]);
}

function accumulate(a, card, isEsc, isResolved, cycleMin, takeMin, ctype) {
  a.all_total++;
  if (isEsc) a.all_esc++;
  if (cycleMin !== null) a.all_cycles.push(cycleMin);

  // checklist
  const cl = card.badges?.checkItemsChecked ?? 0;
  const clt = (card.checklists || []).reduce((s, x) => s + (x.checkItems?.length || 0), 0);
  a.all_checklist_done  += cl;
  a.all_checklist_total += clt;

  if ((card.badges?.comments ?? 0) === 0) a.all_no_comment++;
  if ((card.badges?.comments ?? 0) >= 5)  a.all_5plus_comment++;
  if ((card.idMembers?.length ?? 0) >= 2)  a.all_2plus_ops++;
  if (card.dueReminder) a.all_due_remind++;

  const name = card.name || '';

  if (ctype === 'gps' || ctype === 'mixed') {
    a.gps_total++;
    if (isResolved) a.gps_resolved++;
    if (isEsc)      a.gps_escalated++;

    // auto-restored: comments contain "GPS restored automatically"
    const comments = (board.actions || []).filter(ac =>
      ac.type === 'commentCard' && ac.data?.card?.id === card.id &&
      /GPS restored automatically/i.test(ac.data?.text || ''));
    if (comments.length) a.gps_auto++;

    if (takeMin !== null) a.gps_take_times.push(takeMin);
    if (cycleMin !== null) a.gps_cycles.push(cycleMin);
    a.gps_checklist_done  += cl;
    a.gps_checklist_total += clt;
    if ((card.badges?.comments ?? 0) === 0) a.gps_no_comment++;
  }

  if (ctype === 'temp' || ctype === 'mixed') {
    if (ctype === 'mixed') a.temp_mixed++;
    a.temp_total++;
    if (isResolved) a.temp_resolved++;
    if (isEsc)      a.temp_escalated++;

    const td = parseTempDesc(card.desc || '');
    if (td !== null && td?.deviation !== null && td?.deviation !== undefined) {
      a.temp_devs.push(td.deviation);
      if (td.deviation > 5) a.temp_over5++;
    }

    // Photo time: look for "photo received at" in comments
    const photoComments = (board.actions || []).filter(ac =>
      ac.type === 'commentCard' && ac.data?.card?.id === card.id &&
      /photo received at/i.test(ac.data?.text || ''));
    const createdTs = cardCreatedAt[card.id];
    if (photoComments.length && createdTs) {
      const photoTs  = photoComments[0].date;
      const diffMin  = Math.round((new Date(photoTs) - new Date(createdTs)) / 60000);
      if (diffMin > 0 && diffMin < 120) a.temp_photo_times.push(diffMin);
    }
  }

  const isInbound  = INBOUND_TYPES.has(ctype);
  const isOutbound = OUTBOUND_TYPES.has(ctype);

  if (isInbound) {
    a.inb_total++;
    if (P0_INBOUND.has(ctype)) { a.inb_p0++; if (cycleMin !== null) a.inb_p0_times.push(cycleMin); }
    if (P1_INBOUND.has(ctype)) { a.inb_p1++; if (cycleMin !== null) a.inb_p1p2_times.push(cycleMin); }
    if (P2_INBOUND.has(ctype)) { a.inb_p2++; if (cycleMin !== null) a.inb_p1p2_times.push(cycleMin); }
    // missing load id
    if (/load identification needed/i.test(card.desc || '')) a.inb_no_load++;
    if (/information incomplete/i.test(card.desc || ''))     a.inb_incomplete++;
  }

  if (isOutbound || ctype === 'gps') {
    if (ctype === 'inb_late' || ctype === 'inb_fac') {
      a.out_red++;
      if (ctype === 'inb_late') a.out_late++;
      if (ctype === 'inb_fac')  a.out_fac++;
    } else if (OUTBOUND_TYPES.has(ctype) && ctype !== 'gps') {
      a.out_yellow++;
      if (ctype === 'out_stop')  a.out_stop++;
      if (ctype === 'out_noupd') a.out_noupd++;
    }
    if (isResolved) a.out_resolved++;
    if (isEsc)      a.out_escalated++;
  }
}

function avg(arr) {
  if (!arr.length) return 0;
  return Math.round(arr.reduce((s, v) => s + v, 0) / arr.length);
}
function pct(num, den) {
  if (!den) return 0;
  return +(num / den).toFixed(4);
}

// ── Process all cards ─────────────────────────────────────────────────────────
const sla_rows = [];

for (const card of allCards) {
  const ctype    = cardType(card.name);
  const events   = cardTimeline[card.id] || [];
  const created  = cardCreatedAt[card.id];

  // Status from list name
  const listName = listMap[card.idList] || '';
  const isResolved = DONE_RE.test(listName) || card.dueComplete;
  const isEsc      = ESCALATED_RE.test(listName);

  // Cycle time
  const startEvent = events.find(e => IN_PROGRESS_RE.test(e.list));
  const doneEvent  = events.find(e => DONE_RE.test(e.list));
  let cycleMin = null;
  if (startEvent && doneEvent) {
    cycleMin = Math.round((new Date(doneEvent.ts) - new Date(startEvent.ts)) / 60000);
    if (cycleMin < 0 || cycleMin > 10000) cycleMin = null;
  }

  // Take time (created → first member assigned)
  let takeMin = null;
  if (created && cardTakenAt[card.id]) {
    takeMin = Math.round((new Date(cardTakenAt[card.id]) - new Date(created)) / 60000);
    if (takeMin < 0 || takeMin > 1440) takeMin = null;
  }

  // Accumulate global + per-operator
  accumulate(acc_all, card, isEsc, isResolved, cycleMin, takeMin, ctype);
  const opC = pick(card.id);
  accumulate(acc_ops[opC], card, isEsc, isResolved, cycleMin, takeMin, ctype);

  // SLA Tracker row
  const dueDate   = card.due ? new Date(card.due) : null;
  const slaLimit  = (ctype === 'gps') ? 45 : (ctype === 'temp') ? 60 : 30;
  const slaMet    = cycleMin !== null ? (cycleMin <= slaLimit ? 'YES' : 'NO') : '';
  const loadMatch = (card.desc || '').match(/Load\s*ID[:\s]+(\d+)/i);

  sla_rows.push([
    card.id,
    card.name,
    ctype.toUpperCase(),
    (card.idMembers || []).map(id => memberMap[id] || id).join('; '),
    created ? new Date(created).toISOString().replace('T', ' ').slice(0, 16) : '',
    takeMin ?? '',
    doneEvent?.ts ? new Date(doneEvent.ts).toISOString().replace('T', ' ').slice(0, 16) : '',
    cycleMin ?? '',
    slaLimit,
    slaMet,
    card.dueReminder ? 'TRUE' : 'FALSE',
    acc_all.all_checklist_total
      ? pct(acc_all.all_checklist_done, acc_all.all_checklist_total).toFixed(0) + '%'
      : '',
    card.badges?.comments ?? 0,
    loadMatch ? loadMatch[1] : '',
  ]);
}

// ── Build metrics map: row → value (per column) ───────────────────────────────
function buildMetrics(a) {
  return {
    10: a.gps_total,
    11: a.gps_resolved,
    12: pct(a.gps_resolved, a.gps_total),
    13: a.gps_escalated,
    14: pct(a.gps_escalated, a.gps_total),
    15: a.gps_auto,
    16: avg(a.gps_take_times),
    17: avg(a.gps_cycles),
    18: pct(a.gps_checklist_done, a.gps_checklist_total),
    19: a.gps_no_comment,

    21: a.temp_total,
    22: a.temp_resolved,
    23: pct(a.temp_resolved, a.temp_total),
    24: a.temp_escalated,
    25: pct(a.temp_escalated, a.temp_total),
    26: avg(a.temp_devs),
    27: avg(a.temp_photo_times),
    28: a.temp_over5,
    29: a.temp_mixed,

    31: a.inb_total,
    32: a.inb_p0,
    33: a.inb_p1,
    34: a.inb_p2,
    35: avg(a.inb_p0_times),
    36: avg(a.inb_p1p2_times),
    37: pct(a.inb_total - a.inb_no_load - a.inb_incomplete, a.inb_total || 1),
    38: a.inb_no_load,
    39: a.inb_incomplete,

    41: a.out_red,
    42: a.out_yellow,
    43: a.out_late,
    44: a.out_fac,
    45: a.out_stop,
    46: a.out_noupd,
    47: pct(a.out_resolved, (a.out_red + a.out_yellow) || 1),
    48: 5, // monitoring interval — manual
    49: 1.0, // red < 2min % — manual / system

    51: a.all_total,
    52: pct(a.all_esc, a.all_total),
    53: avg(a.all_cycles),
    54: pct(a.all_checklist_done, a.all_checklist_total),
    55: a.all_no_comment,
    56: a.all_5plus_comment,
    57: a.all_2plus_ops,
    58: a.all_due_remind,
  };
}

const metrics_all = buildMetrics(acc_all);
const metrics_ops = {
  G: buildMetrics(acc_ops.G),
  H: buildMetrics(acc_ops.H),
  I: buildMetrics(acc_ops.I),
  J: buildMetrics(acc_ops.J),
};

// ── Google Sheets ─────────────────────────────────────────────────────────────
function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function ensureSheet(sheets, title, headers) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const exists = meta.data.sheets.some(s => s.properties.title === title);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${title}'!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] },
    });
    console.log(`  📄 Created sheet "${title}"`);
  }
}

async function writeTemplateData(sheets) {
  const dataCol  = isPrev ? 'C' : 'B';
  const dateCell = isPrev ? 'D2' : 'B2';
  const label    = isPrev ? 'Previous period' : 'Current period';
  const today    = new Date().toISOString().slice(0, 10);

  console.log(`\n📊 Writing to DATA sheet (column ${dataCol} — ${label})...`);

  // Build batch update data
  const updates = [];

  // Write date label
  updates.push({ range: `DATA!${dateCell}`, values: [[`${label}: ${today}`]] });

  // Write all metric rows
  const pct_rows = new Set([12,14,18,23,25,37,47,49,52,54]);

  for (const [rowStr, val] of Object.entries(metrics_all)) {
    const row = parseInt(rowStr);
    const fmtVal = pct_rows.has(row) ? parseFloat((val * 100).toFixed(2)) / 100 : val;
    updates.push({ range: `DATA!${dataCol}${row}`, values: [[fmtVal]] });
  }

  // Write operator columns
  for (const [opCol, metrics] of Object.entries(metrics_ops)) {
    for (const [rowStr, val] of Object.entries(metrics)) {
      const row = parseInt(rowStr);
      const fmtVal = pct_rows.has(row) ? parseFloat((val * 100).toFixed(2)) / 100 : val;
      updates.push({ range: `DATA!${opCol}${row}`, values: [[fmtVal]] });
    }
  }

  // Batch write
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: updates.map(u => ({ range: u.range, values: u.values })),
    },
  });

  console.log(`  ✅ ${updates.length} cells updated → DATA column ${dataCol}`);
}

async function writeSLATracker(sheets) {
  const SHEET = 'SLA Tracker';
  const headers = ['Card ID','Card Name','Type','Operator','Created','Taken (min)',
                   'Resolved','Cycle (min)','SLA limit (min)','SLA met?',
                   'Due Reminder','Checklist %','Comments','Load ID'];
  await ensureSheet(sheets, SHEET, headers);

  // Clear old data (keep header)
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${SHEET}'!A2:Z`,
  });

  if (sla_rows.length === 0) { console.log('  ⏭  No SLA rows'); return; }

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${SHEET}'!A2`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'OVERWRITE',
    requestBody: { values: sla_rows },
  });

  console.log(`  ✅ ${sla_rows.length} rows → "${SHEET}"`);
}

async function appendMode(sheets) {
  const HEADERS = {
    Actions: ['Date','Board','Action ID','Type','Member','Card ID','Card Name','List Before','List After','Comment','Timestamp'],
    Cards:   ['Date','Board','Card ID','Card Name','Card Type','Member','List','Load ID','Reference','Comments','Checklist Done','Checklist Total','Due Complete'],
  };
  const today = new Date().toISOString().slice(0,10);

  for (const [title, headers] of Object.entries(HEADERS)) {
    await ensureSheet(sheets, title, headers);
  }

  // ── Deduplicate Actions by Action ID ─────────────────────────────────────
  let existingActionIds = new Set();
  try {
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'Actions'!C:C`,
    });
    (existing.data.values || []).slice(1).forEach(row => {
      if (row[0]) existingActionIds.add(row[0]);
    });
  } catch (e) { /* sheet empty or new */ }

  const action_rows = allActions
    .filter(a => !existingActionIds.has(a.id))
    .map(a => [
      a.date?.slice(0,10)||today, boardName, a.id, a.type,
      memberMap[a.idMemberCreator]||'',
      a.data?.card?.id||'', a.data?.card?.name||'',
      a.data?.listBefore?.name||'', a.data?.listAfter?.name||'',
      a.type==='commentCard'?(a.data?.text||''):'', a.date,
    ]);

  if (action_rows.length) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `'Actions'!A1`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: action_rows },
    });
    console.log(`  ✅ ${action_rows.length} new rows → "Actions" (skipped ${allActions.length - action_rows.length} duplicates)`);
  } else {
    console.log(`  ⏭  Actions: no new rows (all ${allActions.length} already exist)`);
  }

  // ── Cards: overwrite by Card ID ────────────────────────────────────────────
  const cards = allCards;
  const card_rows = cards.map(card => {
    const { loadId, reference } = parseDescription(card.desc||'');
    return [
      today, boardName, card.id, card.name,
      getCardType(card.name),
      (card.idMembers||[]).map(id => memberMap[id]||id).join('; '),
      listMap[card.idList]||card.idList,
      loadId, reference,
      card.badges?.comments??0,
      card.badges?.checkItemsChecked??0,
      (card.checklists||[]).reduce((s,cl)=>s+(cl.checkItems?.length||0),0),
      card.dueComplete ? 'TRUE' : 'FALSE',
    ];
  });

  // Clear and rewrite Cards sheet (cards change status over time)
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `'Cards'!A2:Z`,
  });
  if (card_rows.length) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `'Cards'!A2`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'OVERWRITE',
      requestBody: { values: card_rows },
    });
    console.log(`  ✅ ${card_rows.length} rows → "Cards" (refreshed)`);
  }
}

// ── Print summary ─────────────────────────────────────────────────────────────
function printSummary() {
  const m = metrics_all;
  console.log('\n📈 Metrics summary:');
  console.log(`   GPS Lost:   ${m[10]} cards  |  resolved ${(m[12]*100).toFixed(0)}%  |  escalated ${(m[14]*100).toFixed(0)}%  |  cycle avg ${m[17]} min`);
  console.log(`   Temp Check: ${m[21]} cards  |  resolved ${(m[23]*100).toFixed(0)}%  |  avg dev ${m[26]}°F`);
  console.log(`   Inbound:    ${m[31]} total  (P0:${m[32]} P1:${m[33]} P2:${m[34]})`);
  console.log(`   Outbound:   Red ${m[41]}  Yellow ${m[42]}`);
  console.log(`   Team:       ${m[51]} total  |  esc ${(m[52]*100).toFixed(0)}%  |  cycle ${m[53]} min`);
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  const sheets = getSheetsClient();

  if (mode === 'append') {
    console.log('\n🔄 Mode: append (legacy)');
    await appendMode(sheets);
  } else {
    console.log(`\n🔄 Mode: template | Column: ${isPrev ? 'C (previous)' : 'B (current)'}`);
    await writeTemplateData(sheets);
    await writeSLATracker(sheets);
  }

  printSummary();

  console.log('\n🎉 Done!');
  console.log(`   https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}`);
}

main().catch(err => { console.error(err); process.exit(1); });
