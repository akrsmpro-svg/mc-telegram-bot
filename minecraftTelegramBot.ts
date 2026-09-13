import TelegramBot from "node-telegram-bot-api";
import { db } from "./db"; // Adjust import paths based on your setup
import { minecraftServersTable } from "./db/schema";
import { eq, and } from "drizzle-orm";

// Types & Interfaces
export interface MinecraftServer {
  id: number;
  telegramUserId: string;
  name: string;
  botColor?: string;
  isRunning?: boolean;
}

const COLORS: Record<string, string> = {
  blue: "🔵",
  red: "🔴",
  green: "🟢",
  yellow: "🟡",
};

const logger = {
  error: (data: any, msg: string) => console.error(msg, data),
  info: (msg: string) => console.log(msg),
};

// Database Helpers
async function getUserServers(telegramUserId: string): Promise<MinecraftServer[]> {
  return db
    .select()
    .from(minecraftServersTable)
    .where(eq(minecraftServersTable.telegramUserId, telegramUserId))
    .orderBy(minecraftServersTable.createdAt);
}

async function getServer(
  serverId: number,
  telegramUserId: string
): Promise<MinecraftServer | undefined> {
  const [server] = await db
    .select()
    .from(minecraftServersTable)
    .where(
      and(
        eq(minecraftServersTable.id, serverId),
        eq(minecraftServersTable.telegramUserId, telegramUserId)
      )
    );
  return server;
}

// Bot Initialization
export function startTelegramBot(): TelegramBot {
  const token = "8867349694:AAGZMUg4myX4dTy-kgsCFyrASx9MgnSW9dU";

  if (!token) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN environment variable is required but was not provided."
    );
  }

  const bot = new TelegramBot(token, { polling: true });

  resumeRunningServersOnBoot();

  bot.on("polling_error", (err) => {
    logger.error({ err: err.message }, "Telegram polling error");
  });

  // UI Helpers
  async function sendSubscriptionMenu(chatId: number) {
    const text = `<b>للمتابعة، يرجى الاشتراك في القنوات التالية:</b>`.trim();

    const keyboard = {
      inline_keyboard: [
        [{ text: "🚀 9nat || بوت 🪐", url: "https://t.me/bot_player_24h" }],
        [{ text: "✅ تحقق من الاشتراك", callback_data: "check_subscription" }],
      ],
    };

    await bot.sendMessage(chatId, text, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  }

  async function sendMainMenu(chatId: number, telegramUserId: string) {
    const servers = await getUserServers(telegramUserId);

    const rows = servers.map((s) => [
      {
        text: `${COLORS[s.botColor || "blue"]} ${s.name} ${s.isRunning ? "✅" : "⏸️"}`,
        callback_data: `srv:${s.id}:menu`,
      },
    ]);

    rows.push([{ text: "➕ اضافة سيرفر جديد", callback_data: "add:start" }]);
    rows.push([
      { text: "🛠️ حلول مشاكل", callback_data: "help" },
      { text: "📦 اصدارات البوت", callback_data: "about" },
    ]);

    const text =
      servers.length === 0
        ? `🤖 <b>24/7 بوت السيرفرات</b>\n\n<blockquote>لا يوجد سيرفرات بعد</blockquote>`
        : `🤖 <b>24/7 بوت السيرفرات</b>\n\n<b>عدد سيرفراتك:</b> <code>${servers.length}</code>`;

    await bot.sendMessage(chatId, text, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: rows },
    });
  }

  async function sendServerMenu(
    chatId: number,
    server: MinecraftServer,
    messageId?: number
  ) {
    const text = `⚙️ <b>إدارة السيرفر: ${server.name}</b>\nالحالة: ${server.isRunning ? "شغال 🟢" : "متوقف 🔴"}`;
    const keyboard = {
      inline_keyboard: [
        [
          {
            text: server.isRunning ? "🛑 إيقاف" : "▶️ تشغيل",
            callback_data: `srv:${server.id}:${server.isRunning ? "stop" : "start"}`,
          },
        ],
        [{ text: "🔙 العودة للقائمة", callback_data: "main_menu" }],
      ],
    };

    if (messageId) {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    } else {
      await bot.sendMessage(chatId, text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    }
  }

  function resumeRunningServersOnBoot() {
    logger.info("Resuming active Minecraft sessions...");
  }

  // Handlers
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = String(msg.from?.id);
    await sendMainMenu(chatId, userId);
  });

  bot.on("callback_query", async (query) => {
    const chatId = query.message?.chat.id;
    const messageId = query.message?.message_id;
    const userId = String(query.from.id);
    const data = query.data;

    if (!chatId || !data) return;

    try {
      if (data === "main_menu") {
        await sendMainMenu(chatId, userId);
      } else if (data === "check_subscription") {
        await bot.answerCallbackQuery(query.id, { text: "تم التحقق!" });
        await sendMainMenu(chatId, userId);
      } else if (data.startsWith("srv:")) {
        const parts = data.split(":");
        const serverId = parseInt(parts[1], 10);
        const action = parts[2];

        const server = await getServer(serverId, userId);
        if (!server) {
          await bot.answerCallbackQuery(query.id, { text: "السيرفر غير موجود" });
          return;
        }

        if (action === "menu") {
          await sendServerMenu(chatId, server, messageId);
        } else if (action === "start" || action === "stop") {
          server.isRunning = action === "start";
          await bot.answerCallbackQuery(query.id, {
            text: action === "start" ? "جاري التشغيل..." : "جاري الإيقاف...",
          });
          await sendServerMenu(chatId, server, messageId);
        }
      }
    } catch (err: any) {
      logger.error(err, "Callback query handling error");
    }

    await bot.answerCallbackQuery(query.id);
  });

  return bot;
}
