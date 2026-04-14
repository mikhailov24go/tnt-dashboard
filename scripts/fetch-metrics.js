/**
 * fetch-metrics.js
 * Забирает данные из Trello API, считает метрики и сохраняет в public/metrics.json
 * Запускается GitHub Actions каждый день в 06:00 UTC
 */
const fs = require('fs');

const API_KEY   = process.env.TRELLO_API_KEY;
const TOKEN     = process.env.TRELLO_TOKEN;
const BOARD_IDS = (process.env.TRELLO_BOARD_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

async function fetchBoard(boardId) {
  const url = `https://api.trello.com/1/boards/${boardId}?key=${API_KEY}&token=${TOKEN}&actions=all&actions_limit=1000&cards=all&members=all&lists=all`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Trello API error: ${res.status}`);
  return res.json();
}

function cardType(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('gps') && n.includes('temp')) return 'mixed';
  if (n.includes('gps'))        return 'gps';
  if (n.includes('temp check')) return 'temp';
  return 'other';
}

function parseDeviation(desc) {
  const m = (desc || '').match(/[Dd]eviation[:\s]+(-?[\d.]+)/);
  return m ? Math.abs(parseFloat(m[1])) : null;
}

async function main() {
  const RESOLVED_RE  = /resolved|done|complete/i;
  const ESCALATED_RE = /escalat/i;
  const IN_PROG_RE   = /in progress|in_progress|progress/i;

  // Accumulators for current period (last 7 days) and previous (7–14 days ago)
  const now    = Date.now();
  const D7     = 7  * 864e5;
  const D14    = 14 * 864e5;

  let acc = { curr: makeAcc(), prev: makeAcc() };

  function makeAcc() {
    return {
      gps_total:0, gps_resolved:0, gps_escalated:0,
      gps_cycles:[], gps_take_times:[],
      gps_checklist_done:0, gps_checklist_total:0, gps_no_comment:0,
      temp_total:0, temp_resolved:0, temp_escalated:0,
      temp_devs:[], temp_over5:0,
      all_total:0, all_esc:0, all_cycles:[], all_no_comment:0,
    };
  }

  const cardTimeline = {}, cardCreated = {}, cardTaken = {};

  for (const boardId of BOARD_IDS) {
    console.log(`Processing board: ${boardId}`);
    const board   = await fetchBoard(boardId);
    const listMap = Object.fromEntries((board.lists || []).map(l => [l.id, l.name]));

    for (const a of [...(board.actions || [])].reverse()) {
      const cid = a.data?.card?.id; if (!cid) continue;
      if (!cardTimeline[cid]) cardTimeline[cid] = [];
      if (a.type === 'createCard') { cardCreated[cid] = a.date; cardTimeline[cid].push({ list: a.data?.list?.name||'', ts: a.date }); }
      else if (a.type === 'updateCard' && a.data?.listAfter) cardTimeline[cid].push({ list: a.data.listAfter.name, ts: a.date });
      else if (a.type === 'updateCard' && a.data?.old?.idMembers !== undefined && !cardTaken[cid]) cardTaken[cid] = a.date;
    }

    for (const card of (board.cards || []).filter(c => !c.closed)) {
      const listName = listMap[card.idList] || '';
      const isResolved = RESOLVED_RE.test(listName) || card.dueComplete;
      const isEsc      = ESCALATED_RE.test(listName);
      const ctype      = cardType(card.name);
      const created    = cardCreated[card.id] ? new Date(cardCreated[card.id]).getTime() : null;
      const age        = created ? (now - created) : null;

      // Determine period bucket
      let bucket = null;
      if (age !== null && age <= D7)           bucket = 'curr';
      else if (age !== null && age <= D14)      bucket = 'prev';
      if (!bucket) continue;

      const a = acc[bucket];
      const events    = cardTimeline[card.id] || [];
      const doneEvent = events.find(e => RESOLVED_RE.test(e.list));
      const startEv   = events.find(e => IN_PROG_RE.test(e.list));
      const cycleMin  = (startEv && doneEvent) ? Math.round((new Date(doneEvent.ts) - new Date(startEv.ts)) / 60000) : null;
      const takeMin   = (created && cardTaken[card.id]) ? Math.round((new Date(cardTaken[card.id]) - created) / 60000) : null;

      a.all_total++; if (isEsc) a.all_esc++;
      if (cycleMin > 0 && cycleMin < 500) a.all_cycles.push(cycleMin);
      if (!(card.badges?.comments)) a.all_no_comment++;

      if (ctype === 'gps' || ctype === 'mixed') {
        a.gps_total++; if (isResolved) a.gps_resolved++; if (isEsc) a.gps_escalated++;
        if (cycleMin > 0 && cycleMin < 500) a.gps_cycles.push(cycleMin);
        if (takeMin > 0 && takeMin < 120) a.gps_take_times.push(takeMin);
        a.gps_checklist_done  += card.badges?.checkItemsChecked ?? 0;
        a.gps_checklist_total += (card.checklists || []).reduce((s,cl) => s + (cl.checkItems?.length||0), 0);
        if (!(card.badges?.comments)) a.gps_no_comment++;
      }
      if (ctype === 'temp' || ctype === 'mixed') {
        a.temp_total++; if (isResolved) a.temp_resolved++; if (isEsc) a.temp_escalated++;
        const dev = parseDeviation(card.desc);
        if (dev !== null) { a.temp_devs.push(dev); if (dev > 5) a.temp_over5++; }
      }
    }
  }

  function pct(n, d) { return d ? +((n/d)*100).toFixed(1) : 0; }
  function avg(arr) { return arr.length ? Math.round(arr.reduce((s,v) => s+v,0)/arr.length) : 0; }

  function summarize(a) {
    return {
      gps_total:      a.gps_total,
      gps_resolved_pct: pct(a.gps_resolved, a.gps_total),
      gps_escalated_pct: pct(a.gps_escalated, a.gps_total),
      gps_cycle_avg:  avg(a.gps_cycles),
      gps_take_avg:   avg(a.gps_take_times),
      gps_checklist_pct: pct(a.gps_checklist_done, a.gps_checklist_total),
      gps_no_comment: a.gps_no_comment,
      temp_total:       a.temp_total,
      temp_resolved_pct: pct(a.temp_resolved, a.temp_total),
      temp_escalated_pct: pct(a.temp_escalated, a.temp_total),
      temp_avg_dev:     avg(a.temp_devs),
      temp_over5:       a.temp_over5,
      team_total:       a.all_total,
      team_esc_pct:     pct(a.all_esc, a.all_total),
      team_cycle_avg:   avg(a.all_cycles),
      team_no_comment:  a.all_no_comment,
    };
  }

  const output = {
    updated_at: new Date().toISOString(),
    period_label: 'Last 7 days',
    curr: summarize(acc.curr),
    prev: summarize(acc.prev),
    benchmarks: {
      gps_resolved_pct: 85,
      gps_cycle_avg: 45,
      gps_checklist_pct: 100,
      temp_resolved_pct: 90,
      temp_avg_dev: 5,
      team_esc_pct: 20,
      team_cycle_avg: 45,
    },
  };

  fs.mkdirSync('public', { recursive: true });
  fs.writeFileSync('public/metrics.json', JSON.stringify(output, null, 2));
  console.log('✅ Saved public/metrics.json');
  console.log(`   GPS: ${output.curr.gps_total} cards, ${output.curr.gps_resolved_pct}% resolved`);
  console.log(`   Temp: ${output.curr.temp_total} cards, avg dev ${output.curr.temp_avg_dev}°F`);
  console.log(`   Team: ${output.curr.team_total} total, ${output.curr.team_esc_pct}% escalated`);
}

main().catch(err => { console.error(err); process.exit(1); });
