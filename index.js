// discord-oauth-service/index.js
import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";
import fs from "fs";

const app = express();

const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://auth.majestic-tech.net/auth/discord/callback';
const BOT_TOKEN = process.env.BOT_TOKEN;
const GOOGLE_CREDS_PATH = process.env.GOOGLE_CREDS_PATH || '/etc/secrets/google_creds.json';
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME; // <-- обязательно укажи в Environment точное имя листа, например "Stats (RU)"

if (!CLIENT_ID || !CLIENT_SECRET || !BOT_TOKEN) {
  console.warn('Missing DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET / BOT_TOKEN in env');
}
if (!GOOGLE_SHEET_ID) {
  console.warn('Missing GOOGLE_SHEET_ID in env');
}
if (!SHEET_NAME) {
  console.warn('Missing SHEET_NAME in env (set exact sheet/tab name, e.g. "Stats (RU)")');
}

// --- Helpers ---
async function exchangeCodeForToken(code) {
  const resp = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI
    })
  });
  return await resp.json();
}

async function fetchDiscordMe(access_token) {
  const resp = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${access_token}` }
  });
  return await resp.json();
}

async function sendTelegram(chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: String(chatId), text, parse_mode: "HTML" })
    });
  } catch (e) {
    console.error('sendTelegram error', e);
  }
}

// column index (0-based) -> A1 column letters (A, B, ... Z, AA, AB, ...)
function colIndexToLetter(index) {
  let s = "";
  let i = index + 1;
  while (i > 0) {
    const rem = (i - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

// --- Google Sheets client ---
function getSheetsClient() {
  if (!fs.existsSync(GOOGLE_CREDS_PATH)) {
    throw new Error(`Google creds file not found at ${GOOGLE_CREDS_PATH}`);
  }
  const raw = fs.readFileSync(GOOGLE_CREDS_PATH, "utf8");
  const creds = JSON.parse(raw);

  // Используем JWT напрямую
  const jwtClient = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  return google.sheets({ version: "v4", auth: jwtClient });
}

/**
 * Ищет discordId в таблице, и если найден — записывает telegramId в колонку 'telegram' (если нет — добавляет колонку).
 * Требования:
 *  - SHEET_NAME указан в env
 *  - В первой строке листа (row 1) есть заголовки (например "Nickname", "Discord ID", ...)
 */
async function updateTelegramIdInSheet(discordId, telegramId) {
  if (!GOOGLE_SHEET_ID) throw new Error('GOOGLE_SHEET_ID not set in env');
  if (!SHEET_NAME) throw new Error('SHEET_NAME not set in env');

  const sheets = getSheetsClient();

  // читаем заголовок первой строки (A1:Z1)
  const headerRange = `${SHEET_NAME}!A1:Z1`;
  const headerResp = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range: headerRange });
  const header = (headerResp.data.values && headerResp.data.values[0]) ? headerResp.data.values[0].map(h => (h||'').toString().trim().toLowerCase()) : [];

  // ищем колонку с discord (в заголовке)
  let discordColIndex = header.findIndex(h => h.includes('discord'));
  if (discordColIndex === -1) {
    throw new Error('Discord column not found in sheet header (searching for header containing "discord")');
  }

  // ищем колонку для telegram
  let telegramColIndex = header.findIndex(h => h.includes('telegram') || h.includes('tg') || h.includes('telegram id'));
  if (telegramColIndex === -1) {
    // добавляем колонку в конец заголовка
    telegramColIndex = header.length;
    header.push('telegram');
    const lastColLetter = colIndexToLetter(telegramColIndex);
    const writeHeaderRange = `${SHEET_NAME}!A1:${lastColLetter}1`;
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: writeHeaderRange,
      valueInputOption: 'RAW',
      requestBody: { values: [header] }
    });
  }

  // читаем все строки, начиная со второй
  const rowsRange = `${SHEET_NAME}!A2:Z1000`;
  const rowsResp = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range: rowsRange });
  const rows = rowsResp.data.values || [];

  // находим строку с нужным discordId
  let foundIndex = -1; // 0-based relative to A2
  for (let i = 0; i < rows.length; i++) {
    const val = rows[i][discordColIndex];
    if (val && String(val).trim() === String(discordId).trim()) {
      foundIndex = i;
      break;
    }
  }

  if (foundIndex === -1) {
    throw new Error('Discord id not found in sheet rows');
  }

  const sheetRowNumber = 2 + foundIndex; // фактический номер строки в таблице
  const telegramColLetter = colIndexToLetter(telegramColIndex);
  const writeRange = `${SHEET_NAME}!${telegramColLetter}${sheetRowNumber}`;

  await sheets.spreadsheets.values.update({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: writeRange,
    valueInputOption: 'RAW',
    requestBody: { values: [[ String(telegramId) ]] }
  });

  return { sheetRowNumber, writeRange };
}

// --- OAuth callback ---
app.get('/auth/discord/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) {
      return res.status(400).send('Missing code or state');
    }

    const telegramId = String(state);

    const tokenData = await exchangeCodeForToken(code);
    if (!tokenData || !tokenData.access_token) {
      console.error('Token error', tokenData);
      await sendTelegram(telegramId, 'Ошибка: не удалось получить access token от Discord.');
      return res.status(500).send('OAuth token error');
    }

    const me = await fetchDiscordMe(tokenData.access_token);
    if (!me || !me.id) {
      await sendTelegram(telegramId, 'Ошибка: не удалось получить данные Discord пользователя.');
      return res.status(500).send('users/me error');
    }

    const discordId = String(me.id);
    console.log('OAuth callback:', { telegramId, discordId });

    try {
      await updateTelegramIdInSheet(discordId, telegramId);
      await sendTelegram(telegramId, `✅ Успешно! Ваш Discord ID <code>${discordId}</code> привязан к Telegram.`);
      return res.send('<h2>Авторизация успешна. Можно вернуться в Telegram.</h2>');
    } catch (sheetErr) {
      console.error('sheet update error', sheetErr);
      if (String(sheetErr.message).toLowerCase().includes('not found')) {
        await sendTelegram(telegramId, `❌ В базе не найден саппорт с Discord ID ${discordId}. Свяжитесь с администратором.`);
        return res.status(404).send('discord id not found');
      }
      await sendTelegram(telegramId, `Ошибка при обновлении таблицы: ${sheetErr.message || sheetErr}`);
      return res.status(500).send('sheet update error');
    }

  } catch (err) {
    console.error('callback general error', err);
    return res.status(500).send('server error');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`OAuth server running on port ${PORT}`));
