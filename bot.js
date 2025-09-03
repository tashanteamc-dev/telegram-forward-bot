// bot.js - XFTEAM Telegram Bot Forward Full Version
const { Telegraf, Markup } = require("telegraf");
const { Client } = require("pg");
const express = require("express");

// ---------- Config ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 3000;
const PASSWORD = "xfbest"; // Password access

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
        channel_id TEXT PRIMARY KEY,
        title TEXT,
        username TEXT,
        added_at TIMESTAMPTZ DEFAULT now()
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

const userState = {}; // { userId: { step, content[] } }

// ---------- Helpers ----------
async function upsertChannel(channelId) {
  const chat = await bot.telegram.getChat(channelId);
  const title = chat.title || channelId;
  const username = chat.username ? `@${chat.username}` : null;
  await db.query(
    `INSERT INTO channels (channel_id, title, username)
     VALUES ($1,$2,$3)
     ON CONFLICT (channel_id) DO UPDATE SET title=EXCLUDED.title, username=EXCLUDED.username`,
    [String(channelId), title, username]
  );
  return { channel_id: channelId, title, username };
}

async function listChannels() {
  const res = await db.query(`SELECT channel_id, title, username FROM channels ORDER BY title`);
  return res.rows;
}

async function broadcastForward(messages) {
  const channels = await listChannels();
  if (!channels.length) return;

  for (const ch of channels) {
    for (const msg of messages) {
      try {
        await bot.telegram.forwardMessage(ch.channel_id, msg.chat_id, msg.message_id);
      } catch (e) {
        console.error(`Failed to forward to ${ch.channel_id}:`, e.message || e);
        if (e.message && e.message.toLowerCase().includes("chat not found")) {
          await db.query("DELETE FROM channels WHERE channel_id=$1", [ch.channel_id]);
        }
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
  userState[ctx.from.id] = { step: "awaiting_password", content: [] };
  await ctx.reply(
    "Welcome TashanWIN\nXFTEAM\nhttps://t.me/TASHANWINXFTEAM\n\nPlease enter the password to use this bot:"
  );
});

// ---------- Auto-detect channel ----------
bot.on("my_chat_member", async (ctx) => {
  try {
    const { chat, new_chat_member } = ctx.update.my_chat_member;
    if (chat.type !== "channel") return;

    if (new_chat_member.user.id === BOT_ID && new_chat_member.status === "administrator") {
      await upsertChannel(chat.id);
      console.log(`Bot added as admin to channel: ${chat.title || chat.id}`);
    } else if (new_chat_member.status === "left" || new_chat_member.status === "kicked") {
      await db.query("DELETE FROM channels WHERE channel_id=$1", [chat.id]);
      console.log(`Removed channel ${chat.title || chat.id} from DB`);
    }
  } catch (e) {
    console.error("my_chat_member error:", e.message || e);
  }
});

// ---------- View Channels ----------
bot.hears("📋 View Channels", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  const channels = await listChannels();
  if (!channels.length) return ctx.reply("No channels linked yet.");
  let text = "📌 Channels:\n";
  for (const ch of channels) text += `• ${ch.title} ${ch.username || `(${ch.channel_id})`}\n`;
  return ctx.reply(text);
});

// ---------- Cancel ----------
bot.command("cancel", async (ctx) => {
  userState[ctx.from.id] = { step: "menu", content: [] };
  return ctx.reply("Canceled. Back to menu.", Markup.keyboard([["📋 View Channels"], ["❌ Cancel"]]).resize());
});
bot.hears("❌ Cancel", async (ctx) => {
  userState[ctx.from.id] = { step: "menu", content: [] };
  return ctx.reply("Canceled. Back to menu.", Markup.keyboard([["📋 View Channels"], ["❌ Cancel"]]).resize());
});

// ---------- Collect & Auto Forward ----------
bot.on("message", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  const msg = ctx.message;
  if (!msg || !msg.message_id) return;

  const state = userState[ctx.from.id];
  if (!state) return;

  if (state.step === "awaiting_password") {
    if (msg.text === PASSWORD) {
      state.step = "menu";
      await ctx.reply(
        "✅ Password correct! Bot is ready.",
        Markup.keyboard([["📋 View Channels"], ["❌ Cancel"]]).resize()
      );
    } else {
      await ctx.reply("❌ Wrong password! Contact @kasiatashan");
    }
    return;
  }

  if (state.step === "menu") {
    state.content.push({ chat_id: msg.chat.id, message_id: msg.message_id });
    await ctx.reply("✅ Message received. Forwarding to all channels...");
    await broadcastForward(state.content);
    state.content = [];
    await ctx.reply("✅ Done! Forwarded to all channels.");
  }
});

// ---------- Launch ----------
bot.launch({ polling: true }).then(() => console.log("Bot launched"));
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
