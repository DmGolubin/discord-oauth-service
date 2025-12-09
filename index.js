// discord-oauth-service/index.js
import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";
import fs from "fs";

const app = express();

const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://auth.majestic-tech.net/auth/discord/callback';
const BOT_TOKEN = process.env.BOT_TOKEN; // Telegram bot token, чтобы отправлять уведомления
const GOOGLE_CREDS_PATH = process.env.GOOGLE_CREDS_PATH || '/etc/secrets/google_creds.json';
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID; // ID таблицы Google Sheets

if (!CLIENT_ID || !CLIENT_SECRET || !BOT_TOKEN) {
  console.warn('Missing DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET / BOT_TOKEN in env');
}

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

function sendTelegram(chatId, text) {
  return fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: String(chatId), text })
  });
}

async function sheetsClient() {
  const raw = fs.readFileSync(GOOGLE_CREDS_PATH, 'utf8');
  const creds = JSON.parse(raw);
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return google.sheets({ version: 'v4', auth });
}

/**
 * Ищет discordId в таблице, и если найден — записывает telegramId в колонку 'telegram' (или создает эту колонку).
 * Ожидает, что заголовок таблицы в первой строке (A1:Z1) содержит колонку с 'discord' (например "Discord ID").
 */
async function updateTelegramIdInSheet(discordId, telegramId) {
  if (!GOOGLE_SHEET_ID) throw new Error('GOOGLE_SHEET_ID not set in env');

  const sheets = await sheetsClient();
  const headerResp = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range: 'A1:Z1' });
  const header = (headerResp.data.values && headerResp.data.values[0]) ? headerResp.data.values[0].map(h => (h||'').toString().trim().toLowerCase()) : [];

  // ищем колонку с discord
  let discordColIndex = header.findIndex(h => h.includes('discord'));
  if (discordColIndex === -1) throw new Error('Discord column not found in sheet header');

  // ищем колонку с telegram (или добавим её)
  let telegramColIndex = header.findIndex(h => h.includes('telegram') || h.includes('tg') || h.includes('telegram id'));
  if (telegramColIndex === -1) {
    telegramColIndex = header.length;
    header.push('telegram');
    // обновить заголовок
    const rangeHeader = `A1:${String.fromCharCode(65 + telegramColIndex)}1`;
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: rangeHeader,
      valueInputOption: 'RAW',
      requestBody: { values: [header] }
    });
  }

  // читаем строки
  const rowsResp = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range: 'A2:Z1000' });
  const rows = rowsResp.data.values || [];

  let foundRow = -1;
  for (let i = 0; i < rows.length; i++) {
    const cell = rows[i][discordColIndex];
    if (cell && String(cell).trim() === String(discordId).trim()) {
      foundRow = i; // 0-based relative to A2
      break;
    }
  }

  if (foundRow === -1) throw new Error('Discord id not found in sheet rows');

  const sheetRowNumber = 2 + foundRow;
  const telegramColLetter = String.fromCharCode(65 + telegramColIndex);
  const writeRange = `${telegramColLetter}${sheetRowNumber}`;

  await sheets.spreadsheets.values.update({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: writeRange,
    valueInputOption: 'RAW',
    requestBody: { values: [[ String(telegramId) ]] }
  });

  return { sheetRowNumber, writeRange };
}

app.get('/auth/discord/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) {
      return res.status(400).send('Missing code or state');
    }

    // state содержит telegram chat id (мы передаем только telegramId)
    const telegramId = String(state);

    // Обмен кода на токен
    const tokenData = await exchangeCodeForToken(code);
    if (!tokenData || !tokenData.access_token) {
      console.error('Token error', tokenData);
      await sendTelegram(telegramId, 'Ошибка: не удалось получить access token от Discord.');
      return res.status(500).send('OAuth token error');
    }

    // Получаем пользователя
    const me = await fetchDiscordMe(tokenData.access_token);
    if (!me || !me.id) {
      await sendTelegram(telegramId, 'Ошибка: не удалось получить данные Discord пользователя.');
      return res.status(500).send('users/me error');
    }

    const discordId = String(me.id);
    console.log('OAuth callback for telegram:', telegramId, 'discordId:', discordId);

    // Попытка обновить Google Sheet: если discordId найден — запишем telegramId
    try {
      await updateTelegramIdInSheet(discordId, telegramId);
      await sendTelegram(telegramId, `✅ Успешно! Ваш Discord ID (${discordId}) найден в базе и привязан к вашему Telegram.`);
      return res.send('<h2>Подтверждение успешно. Можете вернуться в Telegram.</h2>');
    } catch (sheetErr) {
      console.error('sheet update error', sheetErr);
      // Если discordId не найден — уведомим пользователя
      if (String(sheetErr.message).toLowerCase().includes('not found')) {
        await sendTelegram(telegramId, `❌ В базе не найден саппорт с Discord ID ${discordId}. Если вы считаете что это ошибка — свяжитесь с администратором.`);
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
app.listen(PORT, () => console.log('OAuth server running on port', PORT));
