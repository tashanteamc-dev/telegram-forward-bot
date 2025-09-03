// bot.js - XFTEAM Telegram Bot CopyMessage Version
const { Telegraf, Markup } = require("telegraf");
const { Client } = require("pg");
const express = require("express");

// ---------- Config ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 3000;
const PASSWORD = "xfbest"; // Password for bot access

if (!BOT_TOKEN || !DATABASE_URL) {
  console.error("BOT_TOKEN and DATABASE_URL are required!");
  process.exit(1);
}

// ---------- DB ----------
const db = new Client({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

db.connect()
  .then(async () => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS channels (
        user_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        title TEXT,
        username TEXT,
        added_at TIMESTAMPTZ DEFAULT now(),
        PRIMARY KEY (user_id, channel_id)
      );
    `);
    console.log("Database ready");
  })
  .catch((err) => {
    console.error("DB connection error:", err);
    process.exit(1);
  });

// ---------- Bot ----------
const bot = new Telegraf(BOT_TOKEN);

let BOT_ID = null;
bot.telegram.getMe().then((me) => (BOT_ID = me.id));

// ---------- Helpers ----------
async function upsertChannel(userId, channelId) {
  const chat = await bot.telegram.getChat(channelId);
  const title = chat.title || channelId;
  const username = chat.username ? `@${chat.username}` : null;
  await db.query(
    `INSERT INTO channels (user_id, channel_id, title, username)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, channel_id)
     DO UPDATE SET title=EXCLUDED.title, username=EXCLUDED.username`,
    [String(userId), String(channelId), title, username]
  );
  return { channel_id: channelId, title, username };
}

async function listUserChannels(userId) {
  const res = await db.query(
    `SELECT channel_id, title, username FROM channels WHERE user_id=$1 ORDER BY title`,
    [String(userId)]
  );
  return res.rows;
}

async function broadcastCopy(userId, msg) {
  const channels = await listUserChannels(userId);
  if (!channels.length) return;

  for (const ch of channels) {
    try {
      await bot.telegram.copyMessage(ch.channel_id, msg.chat.id, msg.message_id, {
        caption: msg.caption || undefined,
        parse_mode: msg.text ? "HTML" : undefined
      });
    } catch (e) {
      console.error(`Failed to copy to ${ch.channel_id}:`, e.message || e);
      if (e.message && e.message.toLowerCase().includes("chat not found")) {
        await db.query("DELETE FROM channels WHERE user_id=$1 AND channel_id=$2", [userId, ch.channel_id]);
      }
    }
  }
}

// ---------- Express keep-alive ----------
const app = express();
app.get("/", (_, res) => res.send("Bot is running"));
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

// ---------- Start ----------
bot.start(async (ctx) => {
  if (ctx.chat.type !== "private") return;
  await ctx.reply(
    "Welcome TashanWIN\nXFTEAM\nhttps://t.me/TASHANWINXFTEAM\n\nPlease enter the password to use this bot:"
  );
});

// ---------- Auto-detect channel ----------
bot.on("my_chat_member", async (ctx) => {
  try {
    const { chat, new_chat_member } = ctx.update.my_chat_member;
    if (chat.type !== "channel") return;

    // Bot jadi admin
    if (new_chat_member.user.id === BOT_ID && new_chat_member.status === "administrator") {
      const admins = await bot.telegram.getChatAdministrators(chat.id);
      for (const admin of admins) {
        if (!admin.user.is_bot) {
          const saved = await upsertChannel(admin.user.id, chat.id);
          console.log(`Channel registered: ${saved.title} for user ${admin.user.id}`);
          try {
            await bot.telegram.sendMessage(
              admin.user.id,
              `✅ Channel linked: ${saved.title} ${saved.username || `(${saved.channel_id})`}`
            );
          } catch {}
        }
      }
    } else if (new_chat_member.status === "left" || new_chat_member.status === "kicked") {
      await db.query("DELETE FROM channels WHERE channel_id=$1", [chat.id]);
      console.log(`Channel removed from DB: ${chat.title}`);
    }
  } catch (e) {
    console.error("my_chat_member error:", e.message || e);
  }
});

// ---------- View Channels ----------
bot.hears("📋 View My Channels", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  const channels = await listUserChannels(ctx.from.id);
  if (!channels.length) return ctx.reply("You have not linked any channels yet.");
  let text = "📌 Your Channels:\n";
  for (const ch of channels) text += `• ${ch.title} ${ch.username || `(${ch.channel_id})`}\n`;
  return ctx.reply(text);
});

// ---------- Cancel ----------
bot.command("cancel", async (ctx) => {
  return ctx.reply("Canceled. Back to menu.", Markup.keyboard([["📋 View My Channels"], ["❌ Cancel"]]).resize());
});
bot.hears("❌ Cancel", async (ctx) => {
  return ctx.reply("Canceled. Back to menu.", Markup.keyboard([["📋 View My Channels"], ["❌ Cancel"]]).resize());
});

// ---------- Collect & Auto Copy ----------
bot.on("message", async (ctx) => {
  if (ctx.chat.type !== "private") return;

  const msg = ctx.message;
  if (!msg || !msg.message_id) return;

  if (msg.text === PASSWORD) {
    await ctx.reply(
      "✅ Password correct! You can now use the bot.",
      Markup.keyboard([["📋 View My Channels"], ["❌ Cancel"]]).resize()
    );
    return;
  }

  await ctx.reply("✅ Message received. Copying to all your channels...");
  await broadcastCopy(ctx.from.id, msg);
  await ctx.reply("✅ Done! Message copied to all channels.");
});

// ---------- Launch ----------
bot.launch({ polling: true }).then(() => console.log("Bot launched with polling"));
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
