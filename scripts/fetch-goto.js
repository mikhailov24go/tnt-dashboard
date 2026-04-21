/**
 * fetch-goto.js
 * Забирает историю звонков из GoTo Connect API за последние 24 часа
 * и дописывает строки в лист "Calls" Google Sheets.
 *
 * Env vars:
 *   GOTO_CLIENT_ID       — Client ID OAuth приложения
 *   GOTO_CLIENT_SECRET   — Client Secret OAuth приложения
 *   GOTO_PAT             — Personal Access Token
 *   GOTO_ACCOUNT_KEY     — Account Key GoTo аккаунта
 *   GOOGLE_SPREADSHEET_ID — ID Google Таблицы
 */

const { google } = require('googleapis');

const CLIENT_ID      = process.env.GOTO_CLIENT_ID;
const CLIENT_SECRET  = process.env.GOTO_CLIENT_SECRET;
const PAT            = process.env.GOTO_PAT;
const ACCOUNT_KEY    = process.env.GOTO_ACCOUNT_KEY;
const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;

if (!CLIENT_ID || !CLIENT_SECRET || !PAT || !ACCOUNT_KEY || !SPREADSHEET_ID) {
  console.error('Missing required env vars');
  process.exit(1);
}

// ── Получить Access Token через PAT ─────────────────────────────
async function getAccessToken() {
  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://authentication.logmeininc.com/oauth/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: `grant_type=personal_access_token&pat=${encodeURIComponent(PAT)}`,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GoTo auth failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  console.log('  ✅ Access token obtained');
  return data.access_token;
}

// ── Забрать историю звонков за 24 часа ───────────────────────────
async function fetchCalls(token) {
  const now   = new Date();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const startTime = since.toISOString().split('.')[0] + 'Z';
  const endTime   = now.toISOString().split('.')[0] + 'Z';

  console.log(`  Fetching calls: ${startTime} → ${endTime}`);

  const url = `https://api.goto.com/call-events/v1/accounts/${ACCOUNT_KEY}/reports` +
    `?startTime=${encodeURIComponent(startTime)}&endTime=${encodeURIComponent(endTime)}&limit=1000`;

  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GoTo calls API failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  const calls = data.items || data.records || data.calls || data || [];
  console.log(`  Found ${calls.length} calls`);
  return calls;
}

// ── Преобразовать звонок в строку для Sheets ─────────────────────
function callToRow(call) {
  const ts        = call.startTime || call.callCreated || call.startedAt || '';
  const date      = ts ? ts.split('T')[0] : '';
  const time      = ts ? ts.split('T')[1]?.replace('Z', '') : '';
  const direction = (call.direction || call.callDirection || '').toUpperCase();
  const durationSec = call.duration || call.durationSeconds ||
    (call.callEnded && call.callCreated
      ? Math.round((new Date(call.callEnded) - new Date(call.callCreated)) / 1000)
      : 0);

  const participants = call.participants || [];
  const operator = participants
    .filter(p => p.role !== 'caller')
    .map(p => p.name || p.displayName || p.extension || '')
    .filter(Boolean)
    .join(', ') || call.agentName || call.answeredBy || '';

  const callerNumber = call.callerNumber || call.from || call.originatingNumber ||
    participants.find(p => p.role === 'caller')?.number || '';

  const statuses   = call.callStates || [];
  const isAnswered = statuses.some(s => ['answered', 'connected'].includes((s.type || s).toLowerCase()));
  const isMissed   = statuses.some(s => ['missed', 'unanswered', 'abandoned'].includes((s.type || s).toLowerCase()));
  const status     = call.status || (isAnswered ? 'answered' : isMissed ? 'missed' : 'unknown');
  const callId     = call.id || call.callId || call.callSessionId || '';

  return [date, time, direction, durationSec, operator, callerNumber, status, callId, ts];
}

// ── Записать в Google Sheets ─────────────────────────────────────
async function writeToSheets(calls) {
  const credentialsJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
    require('fs').readFileSync('/tmp/gcloud-key.json', 'utf8');

  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(credentialsJson),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const sheets = google.sheets({ version: 'v4', auth });
  const sheetName = 'Calls';
  const HEADER    = ['Date', 'Time', 'Direction', 'Duration (sec)', 'Operator', 'Caller Number', 'Status', 'Call ID', 'Timestamp'];

  // Проверяем/создаём лист
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const existing    = spreadsheet.data.sheets.map(s => s.properties.title);

  if (!existing.includes(sheetName)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [HEADER] },
    });
    console.log(`  📄 Created sheet "${sheetName}"`);
  }

  // Загружаем существующие Call ID для дедупликации
  let existingIds = new Set();
  try {
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!H:H`,
    });
    (existing.data.values || []).flat().forEach(id => existingIds.add(id));
  } catch {}

  const newRows  = calls.map(callToRow).filter(row => row[7] && !existingIds.has(row[7]));
  const skipped  = calls.length - newRows.length;

  if (newRows.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A:I`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: newRows },
    });
  }

  console.log(`  ✅ ${newRows.length} new rows → "${sheetName}" (skipped ${skipped} duplicates)`);
}

// ── Main ────────────────────────────────────────────────────────
(async () => {
  console.log('\n📞 GoTo Connect → Google Sheets');
  console.log('================================');
  try {
    const token = await getAccessToken();
    const calls = await fetchCalls(token);
    await writeToSheets(calls);
    console.log(`\n🎉 Done!\n   Processed ${calls.length} calls`);
  } catch (err) {
    console.error('\n❌ Error:', err.message);
    process.exit(1);
  }
})();
