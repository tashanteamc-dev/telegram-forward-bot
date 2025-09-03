// bot.js - XFTEAM Telegram Bot Forward Final Version
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
const userState = {}; // { userId: { step, messages[] } }

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

async function broadcastForward(userId, messages) {
  const channels = await listUserChannels(userId);
  if (!channels.length) return;

  for (const ch of channels) {
    try {
      for (const msg of messages) {
        if (msg.message_id) {
          // Forward message as BOT
          await bot.telegram.forwardMessage(ch.channel_id, BOT_ID, msg.message_id);
        }
      }
    } catch (e) {
      console.error(`Failed to forward to ${ch.channel_id}:`, e.message || e);
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
  userState[ctx.from.id] = { step: "awaiting_password", messages: [] };
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
      const admins = await bot.telegram.getChatAdministrators(chat.id);
      for (const admin of admins) {
        if (!admin.user.is_bot) {
          const saved = await upsertChannel(admin.user.id, chat.id);
          console.log(`Auto-registered channel ${saved.title} for user ${admin.user.id}`);
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
      console.log(`Removed channel ${chat.title} from DB`);
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
  userState[ctx.from.id] = { step: "menu", messages: [] };
  return ctx.reply("Canceled. Back to menu.", Markup.keyboard([["📋 View My Channels"], ["❌ Cancel"]]).resize());
});
bot.hears("❌ Cancel", async (ctx) => {
  userState[ctx.from.id] = { step: "menu", messages: [] };
  return ctx.reply("Canceled. Back to menu.", Markup.keyboard([["📋 View My Channels"], ["❌ Cancel"]]).resize());
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
        "✅ Password correct! You can now use the bot.",
        Markup.keyboard([["📋 View My Channels"], ["❌ Cancel"]]).resize()
      );
    } else {
      await ctx.reply("❌ Wrong password! Please contact @kasiatashan");
    }
    return;
  }

  if (state.step === "menu") {
    state.messages.push({ chat_id: msg.chat.id, message_id: msg.message_id });
    await ctx.reply("✅ Message received. Forwarding to all your channels...");
    await broadcastForward(ctx.from.id, state.messages);
    state.messages = [];
    await ctx.reply("✅ Done! Forwarded to all your channels.");
  }
});

// ---------- Launch ----------
bot.launch({ polling: true }).then(() => console.log("Bot launched with polling"));
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
