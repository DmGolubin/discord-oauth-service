import express from "express";
import fetch from "node-fetch";

const app = express();

app.get("/auth/discord/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.status(400).send("Missing code");

  try {
    // 1) Обмен кода на токен
    const tokenResp = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: process.env.REDIRECT_URI
      })
    });
    const token = await tokenResp.json();

    if (!token.access_token) {
      console.log(token);
      return res.status(400).send("OAuth token error");
    }

    // 2) Получаем данные пользователя
    const userResp = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${token.access_token}` }
    });
    const user = await userResp.json();

    console.log("Discord user verified:", user.id);

    // 3) Отправляем Discord ID обратно в Telegram
    await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: state,
        text: `Ваш Discord ID подтверждён: ${user.id}`
      })
    });

    res.send("<h2>Discord аккаунт подтверждён. Можете вернуться в Telegram.</h2>");
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

app.listen(3000, () => console.log("OAuth server running on port 3000"));
