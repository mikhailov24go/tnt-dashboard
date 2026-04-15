/**
 * fetch-metrics.js  — Truck n Trace Operations Dashboard
 * Структура данных: 3 периода (1d / 7d / 30d)
 * Типы карточек: GPS Lost (P0) / Temp / Other
 * Статус: из названия листа Trello
 */
const fs = require('fs');

const API_KEY    = process.env.TRELLO_API_KEY;
const TOKEN      = process.env.TRELLO_TOKEN;
const BOARD_IDS  = (process.env.TRELLO_BOARD_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

// Регулярки для определения статуса по названию листа
const RE_RESOLVED   = /resolved|done|complete|closed/i;
const RE_ESCALATED  = /escalat/i;
const RE_INPROGRESS = /in.?progress|wip|in.?work/i;

// Определяем тип карточки по названию
function cardType(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('gps') || n.includes('p0')) return 'gps_lost';
  if (n.includes('temp'))                        return 'temp';
  return 'other';
}

async function fetchBoard(boardId) {
  // actions_limit=1000 — получаем все активности за последние 30+ дней
  const url = `https://api.trello.com/1/boards/${boardId}`
    + `?key=${API_KEY}&token=${TOKEN}`
    + `&actions=commentCard,updateCard,createCard`
    + `&actions_limit=1000&cards=open&members=all&lists=all&checklists=all`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Trello API ${res.status}: ${await res.text()}`);
  return res.json();
}

function makeWindowMs(days) { return days * 24 * 60 * 60 * 1000; }

// Создаём пустой аккумулятор для одного периода
function makeAcc(fromDate, toDate) {
  return {
    fromDate, toDate,
    // overview
    cards_total: 0, resolved: 0, escalated: 0, in_progress: 0,
    // card activity
    total_actions: 0, comments: 0, status_changes: 0,
    checklist_done: 0, checklist_total: 0,
    // by card type
    gps:  { total:0, resolved:0, escalated:0 },
    temp: { total:0, resolved:0, escalated:0 },
    other:{ total:0, resolved:0, escalated:0 },
    // per operator: { username: { cards, resolved, escalated, comments, actions, checklist_done, checklist_total, in_progress } }
    ops: {},
  };
}

function opEntry() {
  return { cards:0, resolved:0, escalated:0, in_progress:0,
             comments:0, actions:0, checklist_done:0, checklist_total:0 };
}

function pct(n, d) { return d ? +((n/d)*100).toFixed(1) : 0.0; }

async function main() {
  const now = Date.now();

  // Три окна: 1 день / 7 дней / 30 дней
  const windows = {
    '1d':  { ms: makeWindowMs(1),  acc: makeAcc(new Date(now - makeWindowMs(1)).toISOString().slice(0,10),  new Date(now).toISOString().slice(0,10)) },
    '7d':  { ms: makeWindowMs(7),  acc: makeAcc(new Date(now - makeWindowMs(7)).toISOString().slice(0,10),  new Date(now).toISOString().slice(0,10)) },
    '30d': { ms: makeWindowMs(30), acc: makeAcc(new Date(now - makeWindowMs(30)).toISOString().slice(0,10), new Date(now).toISOString().slice(0,10)) },
  };

  for (const boardId of BOARD_IDS) {
    console.log(`\nProcessing board: ${boardId}`);
    const board = await fetchBoard(boardId);

    // Индексируем: listId → listName, memberId → username
    const listMap   = Object.fromEntries((board.lists   || []).map(l => [l.id, l.name]));
    const memberMap = Object.fromEntries((board.members || []).map(m => [m.id, m.username]));

    // Для каждой карточки собираем: дата создания, кол-во actions, comments, status_changes
    const cardMeta = {}; // cardId → { createdAt, actionCount, commentCount, statusCount }
    for (const a of (board.actions || [])) {
      const cid = a.data?.card?.id; if (!cid) continue;
      if (!cardMeta[cid]) cardMeta[cid] = { createdAt: null, actionCount:0, commentCount:0, statusCount:0 };
      cardMeta[cid].actionCount++;
      if (a.type === 'createCard') cardMeta[cid].createdAt = a.date;
      if (a.type === 'commentCard') cardMeta[cid].commentCount++;
      if (a.type === 'updateCard' && a.data?.listAfter) cardMeta[cid].statusCount++;
    }

    for (const card of (board.cards || [])) {
      const listName  = listMap[card.idList] || '';
      const isResolved   = RE_RESOLVED.test(listName)   || card.dueComplete;
      const isEscalated  = RE_ESCALATED.test(listName);
      const isInProgress = RE_INPROGRESS.test(listName);
      const ctype        = cardType(card.name);
      const meta         = cardMeta[card.id] || {};

      // Дата карточки — сначала из действий, потом из shortLink timestamp
      const createdAt = meta.createdAt
        ? new Date(meta.createdAt).getTime()
        : parseInt(card.id.substring(0,8), 16) * 1000;

      // Checklist данные
      const clDone  = card.badges?.checkItemsChecked ?? 0;
      const clTotal = card.badges?.checkItems ?? 0;

      // Добавляем карточку в каждое временное окно где она попадает
      for (const [periodKey, { ms, acc }] of Object.entries(windows)) {
        if (now - createdAt > ms) continue; // карточка старше окна

        acc.cards_total++;
        if (isResolved)   acc.resolved++;
        if (isEscalated)  acc.escalated++;
        if (isInProgress) acc.in_progress++;
        acc.total_actions  += meta.actionCount  || 0;
        acc.comments       += meta.commentCount || 0;
        acc.status_changes += meta.statusCount  || 0;
        acc.checklist_done  += clDone;
        acc.checklist_total += clTotal;

        // По типу карточки
        acc[ctype].total++;
        if (isResolved)  acc[ctype].resolved++;
        if (isEscalated) acc[ctype].escalated++;

        // По операторам (каждый назначенный участник)
        const memberIds = card.idMembers || [];
        const membersForCard = memberIds.length ? memberIds : ['unassigned'];
        for (const mid of membersForCard) {
          const uname = memberMap[mid] || mid;
          if (!acc.ops[uname]) acc.ops[uname] = opEntry();
          const op = acc.ops[uname];
          op.cards++;
          if (isResolved)   op.resolved++;
          if (isEscalated)  op.escalated++;
          if (isInProgress) op.in_progress++;
          op.comments    += meta.commentCount || 0;
          op.actions     += meta.actionCount  || 0;
          op.checklist_done  += clDone;
          op.checklist_total += clTotal;
        }
      }
    }
  }

  // Формируем итоговый JSON
  const periods = {};
  for (const [key, { acc }] of Object.entries(windows)) {
    const ops_breakdown = Object.entries(acc.ops)
      .map(([name, o]) => ({
        name,
        cards: o.cards,
        resolved: o.resolved,
        escalated: o.escalated,
        resolution_pct: pct(o.resolved, o.cards),
        escalation_pct: pct(o.escalated, o.cards),
        comments: o.comments,
        checklist_pct: pct(o.checklist_done, o.checklist_total),
      }))
      .sort((a,b) => b.cards - a.cards);

    const ops_overview = Object.entries(acc.ops)
      .map(([name, o]) => ({
        name,
        cards_total: o.cards,
        resolved: o.resolved,
        escalated: o.escalated,
        in_progress: o.in_progress,
        resolution_pct: pct(o.resolved, o.cards),
        escalation_pct: pct(o.escalated, o.cards),
        comments_made: o.comments,
        actions_logged: o.actions,
        checklist_avg_pct: pct(o.checklist_done, o.checklist_total),
      }))
      .sort((a,b) => b.cards_total - a.cards_total);

    periods[key] = {
      from: acc.fromDate,
      to:   acc.toDate,
      overview: {
        cards_total:    acc.cards_total,
        resolved:       acc.resolved,
        escalated:      acc.escalated,
        in_progress:    acc.in_progress,
        resolution_pct: pct(acc.resolved,  acc.cards_total),
        escalation_pct: pct(acc.escalated, acc.cards_total),
      },
      card_activity: {
        total_actions:    acc.total_actions,
        comments:         acc.comments,
        status_changes:   acc.status_changes,
        checklist_avg_pct: pct(acc.checklist_done, acc.checklist_total),
        checklist_done:   acc.checklist_done,
        checklist_total:  acc.checklist_total,
      },
      gps_lost: { total: acc.gps.total,  resolved: acc.gps.resolved,  escalated: acc.gps.escalated,  resolution_pct: pct(acc.gps.resolved,   acc.gps.total)  },
      temp:     { total: acc.temp.total, resolved: acc.temp.resolved, escalated: acc.temp.escalated, resolution_pct: pct(acc.temp.resolved,  acc.temp.total) },
      other:    { total: acc.other.total,resolved: acc.other.resolved,escalated: acc.other.escalated,resolution_pct: pct(acc.other.resolved, acc.other.total)},
      operators_breakdown: ops_breakdown,
      operators_overview:  ops_overview,
    };

    console.log(`[${key}] total=${acc.cards_total} GPS=${acc.gps.total} Temp=${acc.temp.total} Other=${acc.other.total}`);
  }

  const output = {
    updated_at: new Date().toISOString(),
    benchmarks: {
      gps_resolution_pct:   75,   // меняй здесь — обновится в следующем деплое
      temp_resolution_pct:  100,
      other_resolution_pct: 75,
      escalation_max_pct:   10,
    },
    periods,
  };

  fs.mkdirSync('public', { recursive: true });
  fs.writeFileSync('public/metrics.json', JSON.stringify(output, null, 2));
  console.log('\n✅ Saved public/metrics.json');
}

main().catch(err => { console.error(err); process.exit(1); });
