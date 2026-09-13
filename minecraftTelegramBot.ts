import TelegramBot from "node-telegram-bot-api";
import mineflayer, { type Bot } from "mineflayer";
import minecraftProtocol from "minecraft-protocol";
import { eq, and } from "drizzle-orm";
import { db, minecraftServersTable, type MinecraftServer } from "@workspace/db";
import { logger } from "./logger";

const { ping } = minecraftProtocol;

/* ------------------------------------------------------------------ */
/* Minecraft keep-alive bot manager                                    */
/* ------------------------------------------------------------------ */

interface ActiveBot {
  bot?: Bot;
  manualStop: boolean;
  reconnectTimer?: NodeJS.Timeout;
  failureStreak: number;
}

const activeBots = new Map<number, ActiveBot>();

const BASE_RECONNECT_DELAY_MS = 20_000;
const MAX_RECONNECT_DELAY_MS = 5 * 60_000;

function nextReconnectDelay(failureStreak: number): number {
  const backoff = Math.min(
    BASE_RECONNECT_DELAY_MS * 2 ** Math.max(0, failureStreak - 1),
    MAX_RECONNECT_DELAY_MS,
  );
  const jitter = Math.floor(Math.random() * 3000);
  return backoff + jitter;
}

function isServerActive(serverId: number): boolean {
  return activeBots.has(serverId);
}

function handlePreConnectFailure(serverId: number, failureStreak: number): void {
  const streak = failureStreak + 1;

  void (async () => {
    const [current] = await db
      .select()
      .from(minecraftServersTable)
      .where(eq(minecraftServersTable.id, serverId));

    if (!current || !current.isRunning) return;

    await db
      .update(minecraftServersTable)
      .set({
        connectedSince: null,
        disconnectionCount: (current.disconnectionCount ?? 0) + 1,
        lastError: "server offline (pre-connect ping failed)",
      })
      .where(eq(minecraftServersTable.id, serverId));

    const active = activeBots.get(serverId);
    if (active?.manualStop) return;

    const delay = nextReconnectDelay(streak);
    const timer = setTimeout(() => connect(serverId, streak), delay);
    activeBots.set(serverId, {
      manualStop: false,
      reconnectTimer: timer,
      failureStreak: streak,
    });
  })();
}

async function startMinecraftBot(server: MinecraftServer): Promise<void> {
  const existing = activeBots.get(server.id);
  if (existing) {
    existing.manualStop = true;
    if (existing.reconnectTimer) clearTimeout(existing.reconnectTimer);
    try {
      existing.bot?.quit();
    } catch {
      // ignore
    }
    activeBots.delete(server.id);
  }

  await db
    .update(minecraftServersTable)
    .set({ isRunning: true, lastError: null })
    .where(eq(minecraftServersTable.id, server.id));

  connect(server.id, 0);
}

function connect(serverId: number, failureStreak: number): void {
  void (async () => {
    const [server] = await db
      .select()
      .from(minecraftServersTable)
      .where(eq(minecraftServersTable.id, serverId));

    if (!server || !server.isRunning) return;

    logger.info(
      { serverId, host: server.host, port: server.port, failureStreak },
      "Connecting Minecraft keep-alive bot",
    );

    let detectedVersion: string | undefined;
    try {
      const pingResult = await Promise.race([
        ping({ host: server.host, port: server.port }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("ping timeout")), 8000),
        ),
      ]);
      const versionName =
        typeof pingResult.version === "string"
          ? pingResult.version
          : pingResult.version?.name;
      const candidateVersion = versionName?.split(" ").pop();
      detectedVersion =
        candidateVersion &&
        minecraftProtocol.supportedVersions.includes(candidateVersion)
          ? candidateVersion
          : undefined;
      logger.info(
        { serverId, candidateVersion, detectedVersion },
        "Pre-connect ping succeeded, proceeding like a real client",
      );
    } catch (err) {
      logger.warn(
        { serverId, err: err instanceof Error ? err.message : err },
        "Pre-connect ping failed, server likely offline; will retry",
      );
      handlePreConnectFailure(serverId, failureStreak);
      return;
    }

    await new Promise((resolve) =>
      setTimeout(resolve, 400 + Math.floor(Math.random() * 600)),
    );

    const bot = mineflayer.createBot({
      host: server.host,
      port: server.port,
      username: server.playerName,
      auth: "offline",
      hideErrors: false,
      checkTimeoutInterval: 90_000,
      version: detectedVersion,
    });

    const entry: ActiveBot = { bot, manualStop: false, failureStreak };
    activeBots.set(serverId, entry);

    bot.once("spawn", () => {
      void db
        .update(minecraftServersTable)
        .set({
          connectedSince: new Date(),
          connectionCount: (server.connectionCount ?? 0) + 1,
          lastError: null,
        })
        .where(eq(minecraftServersTable.id, serverId));
      const active = activeBots.get(serverId);
      if (active) active.failureStreak = 0;
      logger.info({ serverId }, "Minecraft bot connected");
    });

    const handleDisconnect = (reason: string, isFailure: boolean) => {
      const active = activeBots.get(serverId);
      activeBots.delete(serverId);
      const streak = isFailure ? (active?.failureStreak ?? 0) + 1 : 0;

      void (async () => {
        const [current] = await db
          .select()
          .from(minecraftServersTable)
          .where(eq(minecraftServersTable.id, serverId));

        if (!current) return;

        await db
          .update(minecraftServersTable)
          .set({
            connectedSince: null,
            disconnectionCount: (current.disconnectionCount ?? 0) + 1,
            lastError: reason,
          })
          .where(eq(minecraftServersTable.id, serverId));

        const shouldReconnect = !active?.manualStop && current.isRunning;
        if (shouldReconnect) {
          const delay = nextReconnectDelay(streak);
          const timer = setTimeout(() => connect(serverId, streak), delay);
          activeBots.set(serverId, {
            bot,
            manualStop: false,
            reconnectTimer: timer,
            failureStreak: streak,
          });
        }
      })();
    };

    bot.on("end", (reason) => {
      logger.warn({ serverId, reason }, "Minecraft bot ended");
      handleDisconnect(String(reason ?? "end"), true);
    });
    bot.on("kicked", (reason) => {
      logger.warn({ serverId, reason }, "Minecraft bot kicked");
      handleDisconnect(String(reason), true);
    });
    bot.on("error", (err) => {
      logger.warn(
        {
          serverId,
          err: err.message,
          stack: err.stack,
          code: (err as NodeJS.ErrnoException).code,
        },
        "Minecraft bot error",
      );
      handleDisconnect(err.message, true);
    });
  })();
}

async function stopMinecraftBot(serverId: number): Promise<void> {
  const active = activeBots.get(serverId);
  if (active) {
    active.manualStop = true;
    if (active.reconnectTimer) clearTimeout(active.reconnectTimer);
    try {
      active.bot?.quit();
    } catch {
      // ignore
    }
    activeBots.delete(serverId);
  }

  await db
    .update(minecraftServersTable)
    .set({ isRunning: false, connectedSince: null })
    .where(eq(minecraftServersTable.id, serverId));
}

interface ServerCheckResult {
  online: boolean;
  playersOnline?: number;
  playersMax?: number;
  motd?: string;
  version?: string;
  error?: string;
}

async function checkMinecraftServer(
  host: string,
  port: number,
): Promise<ServerCheckResult> {
  try {
    const result = await Promise.race([
      ping({ host, port }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 8000),
      ),
    ]);

    if ("players" in result) {
      return {
        online: true,
        playersOnline: result.players.online,
        playersMax: result.players.max,
        motd:
          typeof result.description === "string"
            ? result.description
            : (result.description as { text?: string })?.text,
        version: result.version.name,
      };
    }

    return { online: true };
  } catch (err) {
    return {
      online: false,
      error: err instanceof Error ? err.message : "unknown error",
    };
  }
}

function resumeRunningServersOnBoot(): void {
  void (async () => {
    const servers = await db
      .select()
      .from(minecraftServersTable)
      .where(eq(minecraftServersTable.isRunning, true));

    for (const server of servers) {
      connect(server.id, 0);
    }
  })();
}

/* ------------------------------------------------------------------ */
/* Telegram bot UI                                                     */
/* ------------------------------------------------------------------ */

const COLORS: Record<string, string> = {
  blue: "🔵",
  red: "🔴",
  green: "🟢",
  purple: "🟣",
  yellow: "🟡",
};

type SessionStep =
  | "add_name"
  | "add_host"
  | "add_port"
  | "add_player"
  | "edit_name"
  | "edit_host"
  | "edit_port"
  | "edit_player";

interface Session {
  step: SessionStep;
  serverId?: number;
  data: Partial<{
    name: string;
    host: string;
    port: number;
    playerName: string;
  }>;
}

const sessions = new Map<number, Session>();

function cancelKeyboard() {
  return {
    inline_keyboard: [[{ text: "❌ إلغاء", callback_data: "cancel" }]],
  };
}

function formatDuration(since: Date | null): string {
  if (!since) return "غير متصل";
  const seconds = Math.floor((Date.now() - since.getTime()) / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}س ${m}د ${s}ث`;
}

async function getUserServers(
  telegramUserId: string,
): Promise<MinecraftServer[]> {
  return db
    .select()
    .from(minecraftServersTable)
    .where(eq(minecraftServersTable.telegramUserId, telegramUserId))
    .orderBy(minecraftServersTable.createdAt);
}

async function getServer(
  serverId: number,
  telegramUserId: string,
): Promise<MinecraftServer | undefined> {
  const [server] = await db
    .select()
    .from(minecraftServersTable)
    .where(
      and(
        eq(minecraftServersTable.id, serverId),
        eq(minecraftServersTable.telegramUserId, telegramUserId),
      ),
    );
  return server;
}

export function startTelegramBot(): TelegramBot {
  const token = 8867349694:AAGZMUg4myX4dTy-kgsCFyrASx9MgnSW9dU;
  if (!token) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN environment variable is required but was not provided.",
    );
  }

  const bot = new TelegramBot(token, { polling: true });

  resumeRunningServersOnBoot();

  bot.on("polling_error", (err) => {
    logger.error({ err: err.message }, "Telegram polling error");
  });

  // دالة إرسال شاشة الاشتراك الإجباري بالتنسيق والمظهر المطلوب
  async function sendSubscriptionMenu(chatId: number) {
    const text = `
<b>للمتابعة، يرجى الاشتراك في القنوات التالية:</b>
`.trim();

    const keyboard = {
      inline_keyboard: [
        [{ text: "🪐 𝟗𝐧𝐚𝐭 || بوت 🪐", url: "https://t.me/bot_player_24h" }],
        [{ text: "✅ تحقق من الاشتࢪاڪ", callback_data: "check_subscription" }],
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
        text: `${COLORS[s.botColor] ?? "🔵"} ${s.name} ${s.isRunning ? "✅" : "⏸"}`,
        callback_data: `srv:${s.id}:menu`,
      },
    ]);

    rows.push([{ text: "➕ اضافة سيرفر جديد", callback_data: "add:start" }]);
    rows.push([
      { text: "🛠 حلول مشاكل", callback_data: "help" },
      { text: "📦 اصدارات البوت", callback_data: "about" },
    ]);

    const text =
      servers.length === 0
        ? `<b>🤖 بوت السيرفرات 24/7</b>\n\n<blockquote>ما عندك سيرفرات بعد.\nاضغط على زر اضافة سيرفر جديد للبدء.</blockquote>`
        : `<b>🤖 بوت السيرفرات 24/7</b>\n\n<b>عدد سيرفراتك:</b> <code>${servers.length}</code>`;

    await bot.sendMessage(chatId, text, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: rows },
    });
  }

  async function sendServerMenu(
    chatId: number,
    server: MinecraftServer,
    messageId?: number,
  ) {
    const text = [
      `<b>${COLORS[server.botColor] ?? "🔵"} ${server.name}</b>`,
      `<blockquote>`,
      `📍 <b>العنوان:</b> <code>${server.host}:${server.port}</code>`,
      `👤 <b>اسم اللاعب:</b> <code>${server.playerName}</code>`,
      `⚡ <b>الحالة:</b> ${server.isRunning ? "✅ يعمل" : "⏸ متوقف"}`,
      server.isRunning
        ? `⏱️ <b>مدة الاتصال:</b> ${formatDuration(server.connectedSince)}`
        : "",
      `🔄 <b>عدد الاتصالات:</b> ${server.connectionCount}`,
      `⚠️ <b>عدد الانقطاعات:</b> ${server.disconnectionCount}`,
      `</blockquote>`,
    ]
      .filter(Boolean)
      .join("\n");

    const rows = [
      [
        server.isRunning
          ? { text: "⏹ ايقاف البوت", callback_data: `srv:${server.id}:stop` }
          : {
              text: "▶️ تشغيل البوت",
              callback_data: `srv:${server.id}:start`,
            },
      ],
      [
        { text: "ℹ️ معلومات السيرفر", callback_data: `srv:${server.id}:info` },
        { text: "🔍 فحص السيرفر", callback_data: `srv:${server.id}:check` },
      ],
      [
        { text: "✏️ تعديل البيانات", callback_data: `srv:${server.id}:edit` },
        { text: "🎨 لون البوت", callback_data: `srv:${server.id}:color` },
      ],
      [{ text: "🗑 حذف السيرفر", callback_data: `srv:${server.id}:delete` }],
      [{ text: "◀️ رجوع", callback_data: "back:main" }],
    ];

    if (messageId) {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: rows },
      });
    } else {
      await bot.sendMessage(chatId, text, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: rows },
      });
    }
  }

  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    await sendSubscriptionMenu(chatId);
  });

  bot.on("callback_query", async (query) => {
    const chatId = query.message?.chat.id;
    const messageId = query.message?.message_id;
    const data = query.data;
    if (!chatId || !data) return;

    const telegramUserId = String(chatId);

    try {
      if (data === "check_subscription") {
        await bot.answerCallbackQuery(query.id, { text: "تم التحقق بنجاح!" });
        if (messageId) {
          await bot.deleteMessage(chatId, messageId).catch(() => {});
        }
        await sendMainMenu(chatId, telegramUserId);
        return;
      }

      if (data === "cancel") {
        sessions.delete(chatId);
        await bot.answerCallbackQuery(query.id, { text: "تم الإلغاء" });
        await sendMainMenu(chatId, telegramUserId);
        return;
      }

      if (data === "back:main") {
        await bot.answerCallbackQuery(query.id);
        if (messageId) {
          await bot.deleteMessage(chatId, messageId).catch(() => {});
        }
        await sendMainMenu(chatId, telegramUserId);
        return;
      }

      if (data === "help") {
        await bot.answerCallbackQuery(query.id);
        await bot.sendMessage(
          chatId,
          [
            "<b>🛠 حلول المشاكل الشائعة:</b>",
            "<blockquote>",
            "• تأكد أن عنوان IP والبورت صحيحين.",
            "• السيرفرات المجانية (مثل Aternos) يجب أن تكون قيد التشغيل حتى يدخلها البوت.",
            "• إذا انقطع البوت باستمرار، تأكد أن السيرفر في وضع offline-mode (cracked).",
            "• استخدم زر «فحص السيرفر» للتأكد أن السيرفر متصل بالإنترنت.",
            "• بعض استضافات مثل Aternos تمنع بوتات الـ24/7 القادمة من سيرفرات سحابية، وهذا قيد خارج عن سيطرة البوت.",
            "</blockquote>",
          ].join("\n"),
          { parse_mode: "HTML" }
        );
        return;
      }

      if (data === "about") {
        await bot.answerCallbackQuery(query.id);
        await bot.sendMessage(
          chatId,
          "<b>📦 بوت السيرفرات 24/7</b>\n\n<blockquote><b>الإصدار:</b> 1.0.0\nيبقي سيرفرات ماينكرافت الخاصة بك شغالة عن طريق الدخول كلاعب وهمي.</blockquote>",
          { parse_mode: "HTML" }
        );
        return;
      }

      if (data === "add:start") {
        await bot.answerCallbackQuery(query.id);
        sessions.set(chatId, { step: "add_name", data: {} });
        await bot.sendMessage(
          chatId,
          "<b>أرسل اسم السيرفر (تسمية مميزة له)</b>\n<i>مثال: سيرفري الاول</i>",
          { parse_mode: "HTML", reply_markup: cancelKeyboard() },
        );
        return;
      }

      const srvMatch = data.match(/^srv:(\d+):(\w+)(?::(.+))?$/);
      if (srvMatch) {
        const serverId = Number(srvMatch[1]);
        const action = srvMatch[2];
        const extra = srvMatch[3];

        const server = await getServer(serverId, telegramUserId);
        if (!server) {
          await bot.answerCallbackQuery(query.id, {
            text: "السيرفر غير موجود",
          });
          return;
        }

        if (action === "menu") {
          await bot.answerCallbackQuery(query.id);
          await sendServerMenu(chatId, server, messageId);
          return;
        }

        if (action === "start") {
          await bot.answerCallbackQuery(query.id, {
            text: "جاري تشغيل البوت...",
          });
          await startMinecraftBot(server);
          const updated = await getServer(serverId, telegramUserId);
          if (updated) await sendServerMenu(chatId, updated, messageId);
          return;
        }

        if (action === "stop") {
          await bot.answerCallbackQuery(query.id, {
            text: "جاري ايقاف البوت...",
          });
          await stopMinecraftBot(serverId);
          const updated = await getServer(serverId, telegramUserId);
          if (updated) await sendServerMenu(chatId, updated, messageId);
          return;
        }

        if (action === "info") {
          await bot.answerCallbackQuery(query.id);
          await bot.sendMessage(
            chatId,
            [
              `<b>ℹ️ معلومات السيرفر: ${server.name}</b>`,
              "<blockquote>",
              `<b>العنوان:</b> <code>${server.host}</code>`,
              `<b>البورت:</b> <code>${server.port}</code>`,
              `<b>اسم اللاعب:</b> <code>${server.playerName}</code>`,
              `<b>الحالة:</b> ${server.isRunning ? "يعمل" : "متوقف"}`,
              `<b>متصل فعليًا الآن:</b> ${isServerActive(server.id) ? "نعم" : "لا"}`,
              `<b>عدد الاتصالات:</b> ${server.connectionCount}`,
              `<b>عدد الانقطاعات:</b> ${server.disconnectionCount}`,
              server.lastError ? `<b>آخر خطأ:</b> <code>${server.lastError}</code>` : "",
              "</blockquote>",
            ]
              .filter(Boolean)
              .join("\n"),
            { parse_mode: "HTML" }
          );
          return;
        }

        if (action === "check") {
          await bot.answerCallbackQuery(query.id, {
            text: "جاري فحص السيرفر...",
          });
          const result = await checkMinecraftServer(server.host, server.port);
          const text = result.online
            ? [
                "<b>🔍 نتيجة الفحص: السيرفر متصل ✅</b>",
                "<blockquote>",
                result.version ? `<b>الإصدار:</b> ${result.version}` : "",
                result.playersOnline !== undefined
                  ? `<b>اللاعبون:</b> ${result.playersOnline}/${result.playersMax}`
                  : "",
                result.motd ? `<b>الوصف:</b> ${result.motd}` : "",
                "</blockquote>",
              ]
                .filter(Boolean)
                .join("\n")
            : `<b>🔍 نتيجة الفحص: السيرفر غير متصل ❌</b>\n<code>${result.error ?? ""}</code>`;
          await bot.sendMessage(chatId, text, { parse_mode: "HTML" });
       
