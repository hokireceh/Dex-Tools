import { execFile } from "child_process";
import https from "https";
import dns from "dns";
import { Telegraf, Markup, session } from "telegraf";
import type { Context } from "telegraf";
import QRCode from "qrcode";
import { db } from "@workspace/db";
import { usersTable, pendingPaymentsTable } from "@workspace/db";
import { eq, sql, and, gt } from "drizzle-orm";
import path from "path";
import fs from "fs";
import { logger } from "./logger";
import { generatePassword, addDays } from "./utils";
import { setGlobalBotTelegramForRerange, registerRerangeHandlers } from "./autoRerange";
import { broadcaster } from "./smartBroadcaster";

dns.setDefaultResultOrder("ipv4first");

// CS_PERSONA — identitas karakter untuk AI Chat (future use)
export const CS_PERSONA = `Kamu adalah asisten AI dari Sepi Bukan Sapi.
Karaktermu: hangat, playful, casual, selalu panggil user dengan "sayang".
Tone seperti kakak/tante yang akrab dan perhatian.
Bahasa Indonesia santai, tidak formal, tidak kaku.
Tetap informatif dan helpful meski dengan gaya yang fun.`;

const PLANS = {
  "30d": { label: "30 Hari", price: 50000, days: 30, formatted: "Rp 50.000" },
  "60d": { label: "60 Hari", price: 100000, days: 60, formatted: "Rp 100.000" },
  "90d": { label: "90 Hari", price: 150000, days: 90, formatted: "Rp 150.000" },
} as const;

type PlanKey = keyof typeof PLANS;

let activePromo: { discountPercent: number; label: string } | null = null;

function getEffectivePrice(basePrice: number): number {
  if (!activePromo) return basePrice;
  return Math.round(basePrice * (1 - activePromo.discountPercent / 100));
}

function getEffectiveFormatted(basePrice: number): string {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", minimumFractionDigits: 0 }).format(getEffectivePrice(basePrice));
}

interface SessionData {
  step?: string;
  pendingTelegramId?: string;
  pendingPlan?: PlanKey;
  pendingPromoPercent?: number;
}

type BotContext = Context & { session: SessionData };

const SAWERIA_API = "https://backend.saweria.co";
const CHECK_INTERVAL_MS = 7000;
const MAX_WAIT_MINUTES = 15;

const CURL_HEADERS = [
  "-H", "Accept: */*",
  "-H", "Accept-Encoding: gzip, deflate, br, zstd",
  "-H", "Accept-Language: id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
  "-H", "DNT: 1",
  "-H", "Origin: https://saweria.co",
  "-H", "Priority: u=1, i",
  "-H", "Referer: https://saweria.co/",
  "-H", "Sec-Fetch-Dest: empty",
  "-H", "Sec-Fetch-Mode: cors",
  "-H", "Sec-Fetch-Site: same-site",
  "-H", 'sec-ch-ua: "Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
  "-H", "sec-ch-ua-mobile: ?0",
  "-H", 'sec-ch-ua-platform: "Windows"',
  "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
];

const MD = (text: string) => ({ parse_mode: "Markdown" as const, ...(text ? {} : {}) });

function curlPost(url: string, body: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const args = ["-s", "--compressed", "-m", "30", "-X", "POST", url,
      "-H", "Content-Type: application/json", ...CURL_HEADERS, "-d", JSON.stringify(body)];
    execFile("curl", args, { maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`curl error: ${err.message}`));
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error(`Non-JSON dari Saweria: ${stdout.slice(0, 200)}`)); }
    });
  });
}

function curlGet(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const args = ["-s", "--compressed", "-m", "30", url, ...CURL_HEADERS];
    execFile("curl", args, { maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`curl error: ${err.message}`));
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error(`Non-JSON: ${stdout.slice(0, 200)}`)); }
    });
  });
}

async function withRetry<T>(fn: () => Promise<T>, retries = 3, delayMs = 2000): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (err: any) {
      if (i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, delayMs * Math.pow(2, i)));
    }
  }
  throw new Error("Max retries reached");
}


async function createDonation(saweriaId: string, amount: number, name: string) {
  return withRetry(async () => {
    const payload = {
      agree: true, notUnderage: true, message: "Sepi Bukan Sapi Subscription",
      amount, payment_type: "qris", vote: "", currency: "IDR",
      customer_info: { first_name: name, email: "bot@hokireceh.online", phone: "" },
    };
    const res = await curlPost(`${SAWERIA_API}/donations/snap/${saweriaId}`, payload);
    if (!res?.data?.qr_string) throw new Error(res?.message || "Respons tidak valid dari Saweria");
    return res.data as { id: string; qr_string: string; amount_raw: number };
  });
}

const SAWERIA_MAX_RETRIES = 3;

function isTransientSaweriaError(e: Error): boolean {
  const msg = e.message.toLowerCase();
  return msg.startsWith("curl error") || msg.startsWith("non-json");
}

async function checkPaymentStatus(donationId: string) {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < SAWERIA_MAX_RETRIES; attempt++) {
    try {
      const res = await curlGet(`${SAWERIA_API}/donations/qris/snap/${donationId}`);
      const d = res?.data;
      if (d) return { id: d.id, status: d.transaction_status as string, amount: d.amount_raw as number };
      // Response JSON valid tapi tidak ada data → donationId tidak valid/tidak ditemukan (permanent)
      logger.warn(`checkPaymentStatus: no data for donationId ${donationId}, response: ${JSON.stringify(res)?.slice(0, 200)}`);
      return null;
    } catch (e: any) {
      if (!isTransientSaweriaError(e)) {
        // Error permanen (4xx atau tidak terduga) → jangan retry
        logger.warn(`checkPaymentStatus permanent error for donationId ${donationId}: ${e.message}`);
        return null;
      }
      lastError = e;
      if (attempt < SAWERIA_MAX_RETRIES - 1) {
        const delayMs = 1000 * Math.pow(2, attempt); // 1s → 2s → 4s
        logger.warn(`Saweria retry ke-${attempt + 1} untuk donationId ${donationId}, error: ${e.message}`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  logger.error(`Saweria gagal setelah ${SAWERIA_MAX_RETRIES} retry untuk donationId ${donationId}: ${lastError?.message}`);
  return null;
}

async function generateQRImage(qrString: string): Promise<Buffer> {
  return await QRCode.toBuffer(qrString, { width: 500, margin: 2, type: "png" });
}

function formatRupiah(amount: number): string {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", minimumFractionDigits: 0 }).format(amount);
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Jakarta" });
}

function buildWaitingText(donationId: string, secsLeft: number): string {
  const m = Math.floor(secsLeft / 60);
  const s = secsLeft % 60;
  const countdown = `${m}:${String(s).padStart(2, "0")}`;
  return (
    `⏳ *Aku lagi nungguin pembayaran kamu sayang~* 🙏\n\n` +
    `🆔 ID: \`${donationId}\`\n` +
    `⏱ Sisa waktu: *${countdown}*\n\n` +
    `_Otomatis aktif begitu pembayaran berhasil ya!_`
  );
}

async function upsertUser(
  telegramId: string, telegramUsername: string | undefined,
  telegramName: string, plan: PlanKey, password: string
) {
  const planInfo = PLANS[plan];
  const bcrypt = await import("bcryptjs");
  const passwordHash = await bcrypt.hash(password, 12);
  const existing = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, telegramId) });

  if (existing) {
    const base = existing.expiresAt > new Date() ? existing.expiresAt : new Date();
    const newExpiry = addDays(base, planInfo.days);
    await db.update(usersTable)
      .set({ password, passwordHash, plan, expiresAt: newExpiry, isActive: true, updatedAt: new Date() })
      .where(eq(usersTable.telegramId, telegramId));
    return { password, expiresAt: newExpiry, isNew: false };
  } else {
    const expiresAt = addDays(new Date(), planInfo.days);
    await db.insert(usersTable).values({
      telegramId, telegramUsername: telegramUsername ?? null,
      telegramName, password, passwordHash, plan, expiresAt, isActive: true,
    });
    return { password, expiresAt, isNew: true };
  }
}

const activeIntervals: Record<string, ReturnType<typeof setInterval>> = {};

// Live chat: map topic_message_id → user telegram_id
// Agar saat admin reply di topic, bot tahu harus forward balik ke user mana.
const liveChatMap = new Map<number, string>();
const LIVE_CHAT_MAP_MAX = 500;

async function startPaymentPolling(
  bot: Telegraf<BotContext>,
  donationId: string,
  chatId: string,
  telegramId: string,
  telegramUsername: string | undefined,
  telegramName: string,
  plan: PlanKey,
  planInfo: typeof PLANS[PlanKey],
  amount: number,
  expiresAt: Date,
  adminChatId: string | undefined,
  notifyAdmin: (text: string, threadId?: number) => Promise<void>,
  topicPaymentId?: number,
  waitingMsgId?: number
) {
  if (activeIntervals[donationId]) return;

  try {
    await db.update(pendingPaymentsTable)
      .set({ status: "polling" })
      .where(eq(pendingPaymentsTable.donationId, donationId));
  } catch (_) { }

  let lastCountdownUpdate = 0;

  const editWaiting = async (text: string, keyboard?: ReturnType<typeof Markup.inlineKeyboard>) => {
    if (!waitingMsgId) return;
    try {
      await bot.telegram.editMessageText(
        chatId, waitingMsgId, undefined, text,
        { ...MD(""), ...(keyboard ? keyboard : {}) }
      );
    } catch (_) { }
  };

  const interval = setInterval(async () => {
    try {
      const now = Date.now();

      if (waitingMsgId && now - lastCountdownUpdate > 55_000) {
        lastCountdownUpdate = now;
        const secsLeft = Math.max(0, Math.floor((expiresAt.getTime() - now) / 1000));
        await editWaiting(
          buildWaitingText(donationId, secsLeft),
          Markup.inlineKeyboard([[Markup.button.callback("❌ Batalkan", `cancel_${donationId}`)]])
        );
      }

      if (new Date() >= expiresAt) {
        clearInterval(interval);
        delete activeIntervals[donationId];
        try {
          await db.update(pendingPaymentsTable)
            .set({ status: "expired" })
            .where(eq(pendingPaymentsTable.donationId, donationId));
        } catch (_) { }
        await db.delete(pendingPaymentsTable).where(eq(pendingPaymentsTable.donationId, donationId));
        const expiredText =
          `⏰ *Waduh, waktu habis nih sayang* 🥺\n\n` +
          `_QR-nya udah expired. Tapi tenang, tekan tombol di bawah buat mulai lagi~_`;
        const retryBtn = Markup.inlineKeyboard([[Markup.button.callback("🔄 Mulai Ulang", "back_main")]]);
        if (waitingMsgId) {
          await editWaiting(expiredText, retryBtn);
        } else {
          try { await bot.telegram.sendMessage(chatId, expiredText, { ...MD(""), ...retryBtn }); } catch (_) { }
        }
        return;
      }

      const data = await checkPaymentStatus(donationId);
      const status = (data?.status || "").toUpperCase();

      try {
        await db.update(pendingPaymentsTable)
          .set({
            retryCount: sql`${pendingPaymentsTable.retryCount} + 1`,
            lastCheckedAt: new Date(),
            lastSaweriaResponse: data ? JSON.stringify(data).slice(0, 500) : null,
          })
          .where(eq(pendingPaymentsTable.donationId, donationId));
      } catch (_) { }

      if (["SUCCESS", "SETTLEMENT", "PAID", "CAPTURE"].includes(status)) {
        clearInterval(interval);
        delete activeIntervals[donationId];
        try {
          await db.update(pendingPaymentsTable)
            .set({ status: "success" })
            .where(eq(pendingPaymentsTable.donationId, donationId));
        } catch (_) { }
        await db.delete(pendingPaymentsTable).where(eq(pendingPaymentsTable.donationId, donationId));

        const password = generatePassword();
        const { expiresAt: subscriptionExpiry, isNew } = await upsertUser(
          telegramId, telegramUsername, telegramName, plan, password
        );

        await editWaiting(`✅ *Yeay, pembayaran diterima!* 🎉`);

        await bot.telegram.sendMessage(chatId,
          `🎉 *Yeay sayang berhasil!* 🥳\n\n` +
          `📦 Paket: *${planInfo.label}*\n` +
          `📅 Aktif sampai: *${formatDate(subscriptionExpiry)}*\n\n` +
          `Sekarang login ke dashboard pakai password kamu ya sayang~ 😘\n` +
          `Lupa password? Ketuk tombol *🔑 Password Saya* di menu utama.` +
          (isNew ? "" : `\n\n_Password lama udah gak berlaku ya sayang._`),
          { ...MD(""), ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Menu Utama", "back_main")]]) }
        );

        await notifyAdmin(
          `💳 *PEMBAYARAN MASUK*\n\n` +
          `👤 ${telegramName} (@${telegramUsername || telegramId})\n` +
          `🆔 Telegram ID: \`${telegramId}\`\n` +
          `📦 ${planInfo.label} | 💰 ${formatRupiah(amount)}`
        , topicPaymentId);
      } else if (["FAILED", "EXPIRED", "CANCEL", "FAILURE", "DENY"].includes(status)) {
        clearInterval(interval);
        delete activeIntervals[donationId];
        try {
          await db.update(pendingPaymentsTable)
            .set({ status: "failed" })
            .where(eq(pendingPaymentsTable.donationId, donationId));
        } catch (_) { }
        await db.delete(pendingPaymentsTable).where(eq(pendingPaymentsTable.donationId, donationId));
        const failText = `❌ *Aduh, pembayaran gagal nih sayang* 😢\n\n_Jangan nyerah ya, coba lagi yuk~_`;
        const retryBtn = Markup.inlineKeyboard([[Markup.button.callback("🔄 Coba Lagi", "back_main")]]);
        if (waitingMsgId) {
          await editWaiting(failText, retryBtn);
        } else {
          await bot.telegram.sendMessage(chatId, failText, { ...MD(""), ...retryBtn });
        }
      }
    } catch (e: any) {
      logger.error(`Poll error: ${e.message}`);
    }
  }, CHECK_INTERVAL_MS);

  activeIntervals[donationId] = interval;
}

let globalBotTelegram: Telegraf<BotContext>["telegram"] | null = null;

// ─── Pause Message Store ──────────────────────────────────────────────────────
// Exchange-agnostic: kunci = strategyId, value = { chatId, messageId }
// Diisi saat pesan pause dikirim (via proxy), dibersihkan saat bot resume.
const pauseMessageStore = new Map<number, { chatId: string; messageId: number }>();

export async function clearPauseNotification(strategyId: number): Promise<void> {
  const info = pauseMessageStore.get(strategyId);
  if (!info || !globalBotTelegram) return;
  const { chatId, messageId } = info;
  pauseMessageStore.delete(strategyId);
  // IMPROVE-001: Edit → konfirmasi aktif, fallback delete jika gagal
  try {
    await globalBotTelegram.editMessageText(chatId, messageId, undefined,
      "▶️ *Bot sudah aktif kembali*", { parse_mode: "Markdown" });
  } catch (_) {
    try { await (globalBotTelegram as any).deleteMessage(chatId, messageId); } catch (_) {}
  }
  // IMPROVE-002: Unpin — silent jika gagal
  try { await (globalBotTelegram as any).unpinChatMessage(chatId, messageId); } catch (_) {}
}

// ─── Notification Template Helpers ───────────────────────────────────────────
// Exchange-agnostic formatters — dipanggil dari semua bot engines.
// Perubahan format cukup di sini tanpa menyentuh engine files lagi.

export type DexName = "lighter" | "extended";

function dexLabel(dex: DexName): string {
  if (dex === "extended") return "✳️ Extended";
  return "⚡ Lighter";
}

function sideEmoji(side: string): string {
  const s = side.toLowerCase();
  return s === "buy" || s === "long" ? "🟢" : "🔴";
}

function truncate(msg: string, max = 100): string {
  return msg.length > max ? msg.slice(0, max - 3) + "..." : msg;
}

function nowWIB(): string {
  return new Date().toLocaleTimeString("id-ID", {
    hour: "2-digit", minute: "2-digit",
    timeZone: "Asia/Jakarta",
  }) + " WIB";
}

export function formatBotStarted(dex: DexName, name: string, type: string, market: string): string {
  return (
    `▶️ *BOT STARTED* · ${dexLabel(dex)}\n` +
    `📌 *${name}*\n` +
    `🔄 ${type.toUpperCase()} · 📍 ${market}`
  );
}

export function formatBotStopped(dex: DexName, name: string, market: string): string {
  return (
    `⛔ *BOT STOPPED* · ${dexLabel(dex)}\n` +
    `📌 *${name}* · 📍 ${market}`
  );
}

export function formatBotPaused(dex: DexName, name: string, reason: string): string {
  return (
    `⚠️ *BOT PAUSED* · ${dexLabel(dex)}\n` +
    `📌 *${name}*\n` +
    `❓ ${reason}`
  );
}

export function formatOrderFilled(
  dex: DexName,
  side: string,
  qty: string | number,
  market: string,
  avgPrice: string | number,
  fee?: string | number | null
): string {
  const feeNum = fee != null ? Number(fee) : 0;
  const feeLine = feeNum > 0 ? `\n💸 Fee: \`$${feeNum.toFixed(4)}\`` : "";
  const priceStr = parseFloat(String(avgPrice)).toFixed(4);
  return (
    `✅ *ORDER FILLED* · ${dexLabel(dex)}\n\n` +
    `${sideEmoji(side)} *${side.toUpperCase()}* · ${market}\n` +
    `📊 Qty: \`${qty}\`\n` +
    `💰 Avg: \`$${priceStr}\`` +
    feeLine + `\n\n` +
    `🕐 ${nowWIB()}`
  );
}

export function formatOrderFailed(dex: DexName, name: string, msg: string): string {
  return (
    `🚨 *ERROR* · ${dexLabel(dex)}\n` +
    `📌 *${name}*\n` +
    `❌ ${truncate(msg)}`
  );
}

export function formatStopLoss(
  dex: DexName,
  name: string,
  market: string,
  price: string | number,
  slPrice: string | number
): string {
  return (
    `🛑 *STOP LOSS* · ${dexLabel(dex)}\n` +
    `📌 *${name}* · 📍 ${market}\n` +
    `💰 Price: \`$${price}\` · SL: \`$${slPrice}\``
  );
}

export function formatTakeProfit(
  dex: DexName,
  name: string,
  market: string,
  price: string | number,
  tpPrice: string | number
): string {
  return (
    `🎯 *TAKE PROFIT* · ${dexLabel(dex)}\n` +
    `📌 *${name}* · 📍 ${market}\n` +
    `💰 Price: \`$${price}\` · TP: \`$${tpPrice}\``
  );
}

export async function sendMessageToUser(
  chatId: string,
  text: string,
  notifyBotToken?: string | null
): Promise<{ ok: boolean; error?: string }> {
  if (!notifyBotToken) return { ok: false, error: "Bot token not configured" };
  if (!chatId) return { ok: false, error: "Chat ID not configured" };
  // Force IPv4 — same as the main bot. VPS servers sometimes have broken IPv6
  // connectivity to Telegram's API which causes silent send failures.
  const ipv4Agent = new https.Agent({ family: 4, keepAlive: true, timeout: 30000 });
  const telegram = new Telegraf(notifyBotToken, { telegram: { agent: ipv4Agent } }).telegram;
  try {
    await telegram.sendMessage(chatId, text, { parse_mode: "Markdown" });
    return { ok: true };
  } catch (err: any) {
    const msg = err?.response?.description ?? err?.message ?? String(err);
    logger.warn({ chatId, err: msg }, "[Notify] Failed to send Telegram notification");
    return { ok: false, error: msg };
  }
}

export function startTelegramBot() {
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const SAWERIA_USER_ID = process.env.SAWERIA_USER_ID;
  const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;  // ID personal admin (untuk isAdmin + DM)
  const GRUP_CHAT_ID = process.env.GRUP_CHAT_ID;    // ID supergroup (untuk topic payment/livechat)
  const TOPIC_PAYMENT_ID = process.env.TOPIC_PAYMENT_ID ? Number(process.env.TOPIC_PAYMENT_ID) : undefined;
  const TOPIC_LIVECHAT_ID = process.env.TOPIC_LIVECHAT_ID ? Number(process.env.TOPIC_LIVECHAT_ID) : undefined;

  if (!BOT_TOKEN) { logger.warn("BOT_TOKEN tidak diset, Telegram bot tidak aktif"); return; }

  const subscriptionEnabled = !!SAWERIA_USER_ID;
  if (!subscriptionEnabled) {
    logger.warn("SAWERIA_USER_ID tidak diset, fitur subscription/pembayaran dinonaktifkan (bot notifikasi tetap jalan jika diperlukan)");
  }

  const ipv4Agent = new https.Agent({ family: 4, keepAlive: true, timeout: 30000 });
  const bot = new Telegraf<BotContext>(BOT_TOKEN, { telegram: { agent: ipv4Agent } });
  globalBotTelegram = bot.telegram;

  // Daftarkan referensi telegram ke autoRerange module agar bisa kirim
  // pesan konfirmasi inline-keyboard via main bot (bukan notify bot per-user).
  // Proxy mengintersep sendMessage → tangkap messageId pesan pause + auto-pin.
  const pauseProxy = {
    sendMessage: async (chatId: string, text: string, extra?: any): Promise<any> => {
      const result = await bot.telegram.sendMessage(chatId as any, text, extra);
      if (result?.message_id) {
        const rows: any[][] = extra?.reply_markup?.inline_keyboard ?? [];
        outer: for (const row of rows) {
          for (const btn of row) {
            const m = String(btn?.callback_data ?? "").match(/^bot_restart_(\d+)$/);
            if (m) {
              const sid = Number(m[1]);
              pauseMessageStore.set(sid, { chatId: String(chatId), messageId: result.message_id });
              // IMPROVE-002: Auto-pin — silent jika bot tidak punya izin pin
              bot.telegram.pinChatMessage(chatId as any, result.message_id).catch(() => {});
              break outer;
            }
          }
        }
      }
      return result;
    },
  };
  setGlobalBotTelegramForRerange(pauseProxy);

  // Daftarkan ke SmartBroadcaster agar broadcast bisa menggunakan token yang sama
  broadcaster.setTelegram(bot.telegram);

  bot.use(session({ defaultSession: () => ({}) }));

  const isAdmin = (ctx: BotContext) =>
    ADMIN_CHAT_ID && String(ctx.from?.id) === String(ADMIN_CHAT_ID);

  async function notifyAdmin(text: string, threadId?: number) {
    // Dengan threadId → kirim ke GRUP (supergroup dengan topics)
    // Tanpa threadId → kirim DM ke admin pribadi
    const target = threadId ? GRUP_CHAT_ID : ADMIN_CHAT_ID;
    if (!target) return;
    try { await bot.telegram.sendMessage(target, text, { ...MD(text), ...(threadId ? { message_thread_id: threadId } : {}) }); }
    catch (e: any) { logger.warn(`Gagal notif admin: ${e.message}`); }
  }

  // ─── MENU UTAMA USER ──────────────────────────────────────────────────────
  async function showMainMenu(ctx: BotContext, edit = false) {
    const name = ctx.from?.first_name || "Trader";
    const promoLine = activePromo && subscriptionEnabled
      ? `\n🔥 *PROMO ${activePromo.label}* — Diskon *${activePromo.discountPercent}%*!`
      : "";
    const text =
      `🤖 *Sepi Bukan Sapi — Akses Eksklusif*\n\n` +
      `Haii sayang *${name}*! 👋✨\n\n` +
      `Mau join VIP? Langsung chat aku ya~\n` +
      `Cek testi & postingan aku dulu di profil dong${promoLine}\n\n` +
      (subscriptionEnabled
        ? `Yuk pilih paket atau cek status akses kamu:`
        : `Cek status akses kamu di bawah ya sayang~`);

    const statusRow = [
      Markup.button.callback("📊 Cek status aku dong~", "menu_status"),
      Markup.button.callback("🔑 Psst, liat password aku", "menu_mypassword"),
    ];

    const liveChatRow = (TOPIC_LIVECHAT_ID && GRUP_CHAT_ID)
      ? [[Markup.button.callback("💬 Hubungi CS", "menu_livechat")]]
      : [];

    const rows = subscriptionEnabled ? [
      [Markup.button.callback(
        activePromo ? `⚡ 30 Hari · Rp 50.000 → ${getEffectiveFormatted(PLANS["30d"].price)} 🔥` : `⚡ 30 Hari · Rp 50.000`,
        "plan_30d"
      )],
      [Markup.button.callback(
        activePromo ? `🔥 60 Hari · Rp 100.000 → ${getEffectiveFormatted(PLANS["60d"].price)} 🔥` : `🔥 60 Hari · Rp 100.000`,
        "plan_60d"
      )],
      [Markup.button.callback(
        activePromo ? `💎 90 Hari · Rp 150.000 → ${getEffectiveFormatted(PLANS["90d"].price)} 🔥` : `💎 90 Hari · Rp 150.000`,
        "plan_90d"
      )],
      statusRow,
      ...liveChatRow,
    ] : [statusRow, ...liveChatRow];

    const keyboard = Markup.inlineKeyboard(rows);
    if (edit) return ctx.editMessageText(text, { ...MD(text), ...keyboard });
    return ctx.reply(text, { ...MD(text), ...keyboard });
  }

  // ─── MENU ADMIN ───────────────────────────────────────────────────────────
  async function showAdminMenu(ctx: BotContext, edit = false) {
    const promoStatus = activePromo
      ? `🔥 Promo aktif: *${activePromo.label}* (-${activePromo.discountPercent}%)`
      : `🎁 Tidak ada promo aktif`;
    const text =
      `👑 *Admin Panel — Sepi Bukan Sapi*\n\n` +
      `${promoStatus}\n\n` +
      `Selamat datang, Admin! Pilih aksi:`;
    const promoBtn = activePromo
      ? Markup.button.callback("🔥 Kelola Promo (Aktif)", "admin_promo")
      : Markup.button.callback("🎁 Kelola Promo", "admin_promo");
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback("👥 Daftar User", "admin_listusers")],
      [
        Markup.button.callback("➕ Tambah User", "admin_adduser"),
        Markup.button.callback("❌ Hapus User", "admin_deleteuser"),
      ],
      [Markup.button.callback("⏰ Perpanjang User", "admin_extenduser")],
      [promoBtn, Markup.button.callback("📊 Statistik", "admin_stats")],
      [Markup.button.callback("📢 Broadcast Pesan", "admin_broadcast")],
    ]);
    if (edit) return ctx.editMessageText(text, { ...MD(text), ...keyboard });
    return ctx.reply(text, { ...MD(text), ...keyboard });
  }

  // ─── /start ───────────────────────────────────────────────────────────────
  bot.start(async (ctx) => {
    ctx.session = {};
    // Daftarkan chatId ke NeonDB broadcast list (untuk promosi/broadcast ke semua yang pernah /start)
    const startChatId = String(ctx.from?.id ?? "");
    if (startChatId && !isAdmin(ctx)) {
      import("./neonBroadcastDb").then(({ upsertBroadcastContact }) => {
        upsertBroadcastContact(startChatId).catch(() => {});
      }).catch(() => {});
    }
    if (isAdmin(ctx)) {
      await showAdminMenu(ctx);
    } else {
      await showMainMenu(ctx);
      // Reply keyboard shortcut — one-time, hilang otomatis setelah diketuk
      const shortcutRows: string[][] = [["📊 Cek Status", "🔑 Password Saya"]];
      if (TOPIC_LIVECHAT_ID && GRUP_CHAT_ID) shortcutRows.push(["💬 Hubungi CS"]);
      await ctx.reply("_Shortcut tersedia di bawah~_", {
        parse_mode: "Markdown",
        ...Markup.keyboard(shortcutRows).resize().oneTime(),
      });
    }
  });

  // ─── /help ────────────────────────────────────────────────────────────────
  bot.help(async (ctx) => {
    if (isAdmin(ctx)) {
      await showAdminMenu(ctx);
    } else {
      await showMainMenu(ctx);
    }
  });

  // ─── AUTO-RERANGE: Daftarkan action handler approve/reject ───────────────
  // Dipasang di sini (setelah session middleware) agar session tersedia jika dibutuhkan.
  // startBot/stopBot di-import secara lazy untuk menghindari circular dependency.
  // Callbacks dispatch berdasarkan strategy.exchange — mendukung Lighter dan Extended.
  registerRerangeHandlers(
    bot,
    async (strategyId) => {
      const { db: botDb } = await import("@workspace/db");
      const { strategiesTable: st } = await import("@workspace/db");
      const { eq: eqFn } = await import("drizzle-orm");
      const strat = await botDb.query.strategiesTable.findFirst({ where: eqFn(st.id, strategyId) });
      if (strat?.exchange === "extended") {
        const { startExtendedBot } = await import("./extended/extendedBotEngine");
        return startExtendedBot(strategyId);
      }
      const { startBot } = await import("./lighter/lighterBotEngine");
      return (await startBot(strategyId)) !== false;
    },
    async (strategyId) => {
      const { db: botDb } = await import("@workspace/db");
      const { strategiesTable: st } = await import("@workspace/db");
      const { eq: eqFn } = await import("drizzle-orm");
      const strat = await botDb.query.strategiesTable.findFirst({ where: eqFn(st.id, strategyId) });
      if (strat?.exchange === "extended") {
        const { stopExtendedBot } = await import("./extended/extendedBotEngine");
        return stopExtendedBot(strategyId);
      }
      const { stopBot } = await import("./lighter/lighterBotEngine");
      return stopBot(strategyId);
    }
  );

  // ─── BOT RESTART (dari notif pause) ──────────────────────────────────────
  // Dipasang setelah session middleware agar handler berjalan dalam konteks bot.
  // Callback data: bot_restart_<strategyId> — dikirim oleh pause notification di *BotEngine.ts
  bot.action(/^bot_restart_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery("⏳ Memulai ulang bot...");
    const strategyId = Number(ctx.match![1]);
    try {
      const { db: botDb } = await import("@workspace/db");
      const { strategiesTable: st } = await import("@workspace/db");
      const { eq: eqFn } = await import("drizzle-orm");
      const strat = await botDb.query.strategiesTable.findFirst({ where: eqFn(st.id, strategyId) });
      if (!strat) {
        await ctx.reply(`❌ Strategy ID ${strategyId} tidak ditemukan.`);
        return;
      }
      if (strat.exchange === "extended") {
        const { startExtendedBot } = await import("./extended/extendedBotEngine");
        await startExtendedBot(strategyId);
      } else {
        const { startBot } = await import("./lighter/lighterBotEngine");
        await startBot(strategyId);
      }
      // IMPROVE-001 + IMPROVE-002: Edit/hapus pesan pause & unpin — silent jika gagal
      await clearPauseNotification(strategyId);
      await ctx.reply(`▶️ *Bot Dimulai Kembali*\nStrategy: *${strat.name}*`, { parse_mode: "Markdown" });
    } catch (err: any) {
      logger.error({ err, strategyId }, "[TelegramBot] Gagal restart bot dari tombol pause");
      await ctx.reply(`❌ Gagal memulai bot: ${err?.message ?? "Unknown error"}`);
    }
  });

  // ─── TOMBOL KEMBALI ───────────────────────────────────────────────────────
  bot.action("back_main", async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session = {};
    if (isAdmin(ctx)) {
      await showAdminMenu(ctx, true).catch(() => showAdminMenu(ctx));
    } else {
      await showMainMenu(ctx, true).catch(() => showMainMenu(ctx));
    }
  });

  bot.action("back_admin", async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session = {};
    await showAdminMenu(ctx, true).catch(() => showAdminMenu(ctx));
  });

  // ─── STATUS LANGGANAN (USER) ──────────────────────────────────────────────
  bot.action("menu_status", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = String(ctx.from!.id);
    const user = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, telegramId) });
    const keyboard = Markup.inlineKeyboard([[Markup.button.callback("🏠 Menu Utama", "back_main")]]);
    if (!user) {
      return ctx.reply("Eh sayang, kamu belum berlangganan nih 🥺\nYuk daftar dulu~", { ...keyboard });
    }
    const isExpired = user.expiresAt < new Date();
    await ctx.reply(
      `📊 *Status Akses Kamu*\n\n` +
      `${isExpired ? "❌ Expired nih sayang 🥺" : "✅ Masih aktif & aman~"}\n` +
      `📦 ${PLANS[user.plan as PlanKey]?.label || user.plan}\n` +
      `📅 Sampai *${formatDate(user.expiresAt)}*\n` +
      (isExpired ? "\nSayang jangan pergi dulu dong~ Perpanjang yuk:" : `🔑 Password: \`${user.password}\``),
      { ...MD(""), ...keyboard }
    );
  });

  // ─── PASSWORD SAYA (USER) ─────────────────────────────────────────────────
  bot.action("menu_mypassword", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = String(ctx.from!.id);
    const user = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, telegramId) });
    const keyboard = Markup.inlineKeyboard([[Markup.button.callback("🏠 Menu Utama", "back_main")]]);
    if (!user || !user.isActive) {
      return ctx.reply("Eh sayang, kamu belum berlangganan nih 🥺\nYuk daftar dulu~", { ...keyboard });
    }
    if (user.expiresAt < new Date()) {
      return ctx.reply(
        `Eh sayang, akses kamu udah habis nih 🥺\n_(habis sejak ${formatDate(user.expiresAt)})_\nJangan pergi dulu dong, perpanjang yuk~`,
        { ...MD(""), ...keyboard }
      );
    }
    await ctx.reply(
      `🔑 *Ini password kamu ya sayang, jangan keselip!*\n\n\`${user.password}\`\n\n` +
      `📅 Aktif sampai: *${formatDate(user.expiresAt)}*\n` +
      `📦 Paket: *${PLANS[user.plan as PlanKey]?.label || user.plan}*`,
      { ...MD(""), ...keyboard }
    );
  });

  // ─── PILIH PAKET (USER) ───────────────────────────────────────────────────
  for (const [planKey, planInfo] of Object.entries(PLANS)) {
    bot.action(`plan_${planKey}`, async (ctx) => {
      await ctx.answerCbQuery();

      if (!subscriptionEnabled) {
        return ctx.reply(
          `⚠️ Eh sayang, fitur pembelian lagi off dulu nih.\nHubungi admin untuk berlangganan ya~`,
          Markup.inlineKeyboard([[Markup.button.callback("🏠 Menu Utama", "back_main")]])
        );
      }

      // Guard: satu pending payment aktif per user — cegah spam klik plan
      const existingPending = await db.query.pendingPaymentsTable.findFirst({
        where: and(
          eq(pendingPaymentsTable.telegramId, String(ctx.from!.id)),
          gt(pendingPaymentsTable.expiresAt, new Date())
        ),
      });
      if (existingPending) {
        return ctx.reply(
          `⏳ *Kamu masih punya QR yang aktif sayang~* 🙏\n\n_Selesaikan dulu pembayaran sebelumnya, atau batalkan dari pesan sebelumnya._`,
          { ...MD(""), ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Menu Utama", "back_main")]]) }
        );
      }

      const userName = ctx.from?.first_name || "Trader";
      const saweriaId = SAWERIA_USER_ID!;

      const effectivePrice = getEffectivePrice(planInfo.price);
      const effectiveFormatted = getEffectiveFormatted(planInfo.price);
      const promoNote = activePromo
        ? `\n🔥 Promo *${activePromo.label}* — hemat *${activePromo.discountPercent}%*`
        : "";

      const loadingMsg = await ctx.reply(
        `⏳ *Sabar ya sayang, lagi bikin QR-nya...* 🙏\n\n📦 Paket: *${planInfo.label}*\n💰 Harga: *${effectiveFormatted}*${promoNote}`,
        MD("")
      );

      try {
        const donation = await createDonation(saweriaId, effectivePrice, userName);
        const qrBuffer = await generateQRImage(donation.qr_string);
        const expiresAt = new Date(Date.now() + MAX_WAIT_MINUTES * 60 * 1000);

        const pgFee = donation.amount_raw - effectivePrice;
        const captionLines = [
          `📋 *Detail Pembayaran — ${planInfo.label}* 💸`,
          ``,
          `👤 User: \`${ctx.from!.id}\``,
          `📦 Paket: *${planInfo.label}*`,
          `💰 Nominal: *${formatRupiah(effectivePrice)}*`,
          pgFee > 0 ? `🏦 Biaya PG: *${formatRupiah(pgFee)}*` : null,
          pgFee > 0 ? `💳 Total Bayar: *${formatRupiah(donation.amount_raw)}*` : null,
          ``,
          `📲 Scan QR di atas pakai e-wallet / m-banking`,
          `⏰ Berlaku: *${MAX_WAIT_MINUTES} menit*`,
        ].filter(l => l !== null).join("\n");

        await withRetry(
          () => ctx.replyWithPhoto(
            { source: qrBuffer, filename: "qr.png" },
            { caption: captionLines, parse_mode: "Markdown" }
          ),
          3, 1500
        );

        try { await ctx.telegram.deleteMessage(ctx.chat!.id, loadingMsg.message_id); } catch (_) { }

        const chatId = String(ctx.chat!.id);
        const telegramId = String(ctx.from!.id);
        const telegramName = ctx.from?.first_name || "Trader";
        const telegramUsername = ctx.from?.username;

        const waitingMsg = await ctx.reply(
          buildWaitingText(donation.id, MAX_WAIT_MINUTES * 60),
          { ...MD(""), ...Markup.inlineKeyboard([[Markup.button.callback("❌ Batalkan", `cancel_${donation.id}`)]]) }
        );
        const waitingMsgId = waitingMsg.message_id;

        await db.insert(pendingPaymentsTable).values({
          donationId: donation.id,
          chatId, telegramId,
          telegramUsername: telegramUsername ?? null,
          telegramName,
          plan: planKey,
          amount: String(donation.amount_raw),
          qrString: donation.qr_string,
          waitingMsgId,
          expiresAt,
        }).onConflictDoNothing();

        startPaymentPolling(
          bot, donation.id, chatId, telegramId, telegramUsername,
          telegramName, planKey as PlanKey, planInfo, donation.amount_raw,
          expiresAt, ADMIN_CHAT_ID, notifyAdmin, TOPIC_PAYMENT_ID, waitingMsgId
        );

      } catch (err: any) {
        logger.error(`Gagal buat donasi: ${err.message}`);
        try { await ctx.telegram.deleteMessage(ctx.chat!.id, loadingMsg.message_id); } catch (_) { }
        const isNetworkError = /socket hang up|ECONNRESET|ETIMEDOUT|ENOTFOUND|network/i.test(err.message ?? "");
        const userMsg = isNetworkError
          ? `❌ Aduh sayang, koneksi ke server sempat putus nih 😣\n\nUdah dicoba ulang beberapa kali tapi masih gagal. Coba lagi ya~`
          : `❌ Aduh sayang, gagal bikin QR nih 😣\n\nCoba lagi ya atau hubungi admin~`;
        await ctx.reply(
          userMsg,
          Markup.inlineKeyboard([[Markup.button.callback("🔄 Coba Lagi", `plan_${planKey}`), Markup.button.callback("🏠 Menu", "back_main")]])
        );
      }
    });
  }

  // ─── BATALKAN PEMBAYARAN ──────────────────────────────────────────────────
  bot.action(/^cancel_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const donationId = ctx.match[1];
    const chatId = String(ctx.chat!.id);

    const pending = await db.query.pendingPaymentsTable.findFirst({
      where: eq(pendingPaymentsTable.donationId, donationId),
    });

    if (!pending || pending.chatId !== chatId) return;

    if (activeIntervals[donationId]) {
      clearInterval(activeIntervals[donationId]);
      delete activeIntervals[donationId];
    }

    await db.delete(pendingPaymentsTable).where(eq(pendingPaymentsTable.donationId, donationId));

    try {
      await ctx.editMessageText(
        `❌ *Pembayaran dibatalkan ya sayang*\n\n_QR-nya udah gak aktif. Kalau mau lagi, tekan mulai ulang~_`,
        { ...MD(""), ...Markup.inlineKeyboard([[Markup.button.callback("🔄 Mulai Ulang", "back_main")]]) }
      );
    } catch (_) { }
  });

  // ─── ADMIN: DAFTAR USER ───────────────────────────────────────────────────
  bot.action("admin_listusers", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("⛔ Bukan admin");
    await ctx.answerCbQuery();
    const users = await db.query.usersTable.findMany({ orderBy: (u, { desc }) => [desc(u.createdAt)] });
    const backBtn = Markup.inlineKeyboard([[Markup.button.callback("◀️ Kembali", "back_admin")]]);
    if (!users.length) return ctx.reply("Belum ada user.", backBtn);

    const lines = users.map((u, i) => {
      const expired = u.expiresAt < new Date();
      return `${i + 1}. *${u.telegramName || u.telegramId}* (@${u.telegramUsername || "-"})\n` +
        `   🆔 \`${u.telegramId}\` | 📦 ${PLANS[u.plan as PlanKey]?.label || u.plan}\n` +
        `   ${expired ? "❌ Expired" : "✅ Aktif"} s/d ${formatDate(u.expiresAt)}\n` +
        `   🔑 \`${u.password}\``;
    });

    const chunks: string[] = [];
    let chunk = `👥 *Daftar User (${users.length})*\n\n`;
    for (const line of lines) {
      if (chunk.length + line.length > 3500) { chunks.push(chunk); chunk = ""; }
      chunk += line + "\n\n";
    }
    if (chunk) chunks.push(chunk);

    for (let i = 0; i < chunks.length; i++) {
      if (i === chunks.length - 1) {
        await ctx.reply(chunks[i], { ...MD(""), ...backBtn });
      } else {
        await ctx.reply(chunks[i], MD(""));
      }
    }
  });

  // ─── ADMIN: TAMBAH USER (flow) ────────────────────────────────────────────
  bot.action("admin_adduser", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("⛔ Bukan admin");
    await ctx.answerCbQuery();
    ctx.session = { step: "admin_adduser_id" };
    await ctx.reply(
      `➕ *Tambah User*\n\nKirim *Telegram ID* user yang ingin ditambahkan:\n_Contoh: 123456789_`,
      { ...MD(""), ...Markup.inlineKeyboard([[Markup.button.callback("❌ Batal", "back_admin")]]) }
    );
  });

  // ─── ADMIN: HAPUS USER (flow) ─────────────────────────────────────────────
  bot.action("admin_deleteuser", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("⛔ Bukan admin");
    await ctx.answerCbQuery();
    ctx.session = { step: "admin_deleteuser_id" };
    await ctx.reply(
      `❌ *Hapus User*\n\nKirim *Telegram ID* user yang ingin dinonaktifkan:`,
      { ...MD(""), ...Markup.inlineKeyboard([[Markup.button.callback("❌ Batal", "back_admin")]]) }
    );
  });

  // ─── ADMIN: PERPANJANG USER (flow) ────────────────────────────────────────
  bot.action("admin_extenduser", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("⛔ Bukan admin");
    await ctx.answerCbQuery();
    ctx.session = { step: "admin_extenduser_id" };
    await ctx.reply(
      `⏰ *Perpanjang User*\n\nKirim *Telegram ID* user yang ingin diperpanjang:`,
      { ...MD(""), ...Markup.inlineKeyboard([[Markup.button.callback("❌ Batal", "back_admin")]]) }
    );
  });

  // ─── ADMIN: PILIH PLAN UNTUK ADDUSER ─────────────────────────────────────
  for (const [planKey, planInfo] of Object.entries(PLANS)) {
    bot.action(`admin_setplan_${planKey}`, async (ctx) => {
      if (!isAdmin(ctx)) return ctx.answerCbQuery("⛔ Bukan admin");
      await ctx.answerCbQuery();
      const telegramId = ctx.session.pendingTelegramId;
      if (!telegramId) return ctx.reply("Sesi habis. Mulai lagi dari menu admin.");

      const password = generatePassword();
      const { expiresAt } = await upsertUser(telegramId, undefined, `User-${telegramId}`, planKey as PlanKey, password);
      ctx.session = {};

      await ctx.reply(
        `✅ *User Ditambahkan*\n\n` +
        `🆔 Telegram ID: \`${telegramId}\`\n` +
        `📦 Plan: *${planInfo.label}*\n` +
        `🔑 Password: \`${password}\`\n` +
        `📅 Expires: *${formatDate(expiresAt)}*`,
        { ...MD(""), ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Kembali", "back_admin")]]) }
      );

      try {
        await bot.telegram.sendMessage(telegramId,
          `🎉 *Haii sayang, akses kamu udah aktif nih!* ✨\n\n📦 Paket: *${planInfo.label}*\n\nLogin ke dashboard sekarang ya sayang~ 😘\nLupa password? Ketuk tombol *🔑 Password Saya* di menu utama.`,
          MD("")
        );
      } catch (_) { }
    });
  }

  // ─── ADMIN: STATISTIK ─────────────────────────────────────────────────────
  bot.action("admin_stats", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("⛔ Bukan admin");
    await ctx.answerCbQuery();
    const users = await db.query.usersTable.findMany();
    const now = new Date();
    const total = users.length;
    const aktif = users.filter(u => u.isActive && u.expiresAt > now).length;
    const expired = users.filter(u => u.expiresAt <= now).length;
    const plan30 = users.filter(u => u.plan === "30d" && u.isActive && u.expiresAt > now).length;
    const plan60 = users.filter(u => u.plan === "60d" && u.isActive && u.expiresAt > now).length;
    const plan90 = users.filter(u => u.plan === "90d" && u.isActive && u.expiresAt > now).length;

    await ctx.reply(
      `📊 *Statistik Sepi Bukan Sapi*\n\n` +
      `👥 Total User: *${total}*\n` +
      `✅ Aktif: *${aktif}*\n` +
      `❌ Expired: *${expired}*\n\n` +
      `📦 Rincian Aktif:\n` +
      `   • 30 Hari: *${plan30}* user\n` +
      `   • 60 Hari: *${plan60}* user\n` +
      `   • 90 Hari: *${plan90}* user`,
      { ...MD(""), ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Kembali", "back_admin")]]) }
    );
  });

  // ─── ADMIN: BROADCAST ─────────────────────────────────────────────────────
  bot.action("admin_broadcast", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("⛔ Bukan admin");
    await ctx.answerCbQuery();
    await ctx.reply(
      "📢 *Broadcast Pesan*\n\n" +
      "Untuk broadcast pesan ke semua user,\n" +
      "gunakan dashboard admin:\n\n" +
      "🌐 https://hokireceh.online/admin\n\n" +
      "Scroll ke bagian Broadcast di halaman Admin.",
      { parse_mode: "Markdown" }
    );
  });

  // ─── ADMIN: KELOLA PROMO ──────────────────────────────────────────────────
  async function showPromoMenu(ctx: BotContext, edit = false) {
    const promoStatus = activePromo
      ? `🔥 *Promo Aktif:* ${activePromo.label} — Diskon *${activePromo.discountPercent}%*\n\n` +
        `Harga saat ini:\n` +
        `   • 30 Hari: Rp 50.000 → *${getEffectiveFormatted(PLANS["30d"].price)}*\n` +
        `   • 60 Hari: Rp 100.000 → *${getEffectiveFormatted(PLANS["60d"].price)}*\n` +
        `   • 90 Hari: Rp 150.000 → *${getEffectiveFormatted(PLANS["90d"].price)}*`
      : `🎁 Tidak ada promo aktif saat ini.\n\n` +
        `Harga normal:\n` +
        `   • 30 Hari: *Rp 50.000*\n` +
        `   • 60 Hari: *Rp 100.000*\n` +
        `   • 90 Hari: *Rp 150.000*`;
    const text = `🎁 *Kelola Promo*\n\n${promoStatus}`;
    const keyboard = activePromo
      ? Markup.inlineKeyboard([
          [Markup.button.callback("✏️ Ubah Promo", "admin_promo_set")],
          [Markup.button.callback("❌ Nonaktifkan Promo", "admin_promo_off")],
          [Markup.button.callback("◀️ Kembali", "back_admin")],
        ])
      : Markup.inlineKeyboard([
          [Markup.button.callback("✅ Aktifkan Promo Baru", "admin_promo_set")],
          [Markup.button.callback("◀️ Kembali", "back_admin")],
        ]);
    if (edit) return ctx.editMessageText(text, { ...MD(text), ...keyboard });
    return ctx.reply(text, { ...MD(text), ...keyboard });
  }

  bot.action("admin_promo", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("⛔ Bukan admin");
    await ctx.answerCbQuery();
    await showPromoMenu(ctx, true).catch(() => showPromoMenu(ctx));
  });

  bot.action("admin_promo_set", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("⛔ Bukan admin");
    await ctx.answerCbQuery();
    ctx.session = { step: "admin_promo_percent" };
    await ctx.reply(
      `✏️ *Set Promo Diskon*\n\nKirim persentase diskon (1–99):\n_Contoh: 20 (untuk diskon 20%)_`,
      { ...MD(""), ...Markup.inlineKeyboard([[Markup.button.callback("❌ Batal", "admin_promo")]]) }
    );
  });

  bot.action("admin_promo_off", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("⛔ Bukan admin");
    await ctx.answerCbQuery();
    activePromo = null;
    await ctx.reply(
      `✅ *Promo dinonaktifkan.*\n\nHarga kembali ke normal.`,
      { ...MD(""), ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Kembali", "back_admin")]]) }
    );
  });

  // ─── LIVE CHAT: Tombol "Hubungi CS" ──────────────────────────────────────
  bot.action("menu_livechat", async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (_) {}
    const text = TOPIC_LIVECHAT_ID && GRUP_CHAT_ID
      ? `💬 *Hubungi Customer Service*\n\nLangsung ketik pesanmu di sini sayang~\nCS kami akan segera membalas! 🙏\n\n_Jam layanan: 08.00 – 22.00 WIB_`
      : `💬 *Hubungi Admin*\n\nFitur live chat belum aktif.\nHubungi admin langsung ya~`;
    return ctx.editMessageText(text, {
      ...MD(text),
      ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Kembali", "menu_back")]]),
    });
  });

  bot.action("menu_back", async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (_) {}
    return showMainMenu(ctx, true);
  });

  // ─── REPLY KEYBOARD SHORTCUT HANDLERS ────────────────────────────────────
  // Menangkap teks dari Reply Keyboard one-time yang dikirim saat /start.
  // Ditempatkan sebelum bot.on("text") agar diproses lebih dulu.

  bot.hears("📊 Cek Status", async (ctx) => {
    if (isAdmin(ctx) || ctx.chat?.type !== "private") return;
    const telegramId = String(ctx.from!.id);
    const user = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, telegramId) });
    const keyboard = Markup.inlineKeyboard([[Markup.button.callback("🏠 Menu Utama", "back_main")]]);
    if (!user) {
      return ctx.reply("Eh sayang, kamu belum berlangganan nih 🥺\nYuk daftar dulu~", { ...keyboard });
    }
    const isExpired = user.expiresAt < new Date();
    await ctx.reply(
      `📊 *Status Akses Kamu*\n\n` +
      `${isExpired ? "❌ Expired nih sayang 🥺" : "✅ Masih aktif & aman~"}\n` +
      `📦 ${PLANS[user.plan as PlanKey]?.label || user.plan}\n` +
      `📅 Sampai *${formatDate(user.expiresAt)}*\n` +
      (isExpired ? "\nSayang jangan pergi dulu dong~ Perpanjang yuk:" : `🔑 Password: \`${user.password}\``),
      { ...MD(""), ...keyboard }
    );
  });

  bot.hears("🔑 Password Saya", async (ctx) => {
    if (isAdmin(ctx) || ctx.chat?.type !== "private") return;
    const telegramId = String(ctx.from!.id);
    const user = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, telegramId) });
    const keyboard = Markup.inlineKeyboard([[Markup.button.callback("🏠 Menu Utama", "back_main")]]);
    if (!user || !user.isActive) {
      return ctx.reply("Eh sayang, kamu belum berlangganan nih 🥺\nYuk daftar dulu~", { ...keyboard });
    }
    if (user.expiresAt < new Date()) {
      return ctx.reply(
        `Eh sayang, akses kamu udah habis nih 🥺\n_(habis sejak ${formatDate(user.expiresAt)})_\nJangan pergi dulu dong, perpanjang yuk~`,
        { ...MD(""), ...keyboard }
      );
    }
    await ctx.reply(
      `🔑 *Ini password kamu ya sayang, jangan keselip!*\n\n\`${user.password}\`\n\n` +
      `📅 Aktif sampai: *${formatDate(user.expiresAt)}*\n` +
      `📦 Paket: *${PLANS[user.plan as PlanKey]?.label || user.plan}*`,
      { ...MD(""), ...keyboard }
    );
  });

  bot.hears("💬 Hubungi CS", async (ctx) => {
    if (isAdmin(ctx) || ctx.chat?.type !== "private") return;
    const text = TOPIC_LIVECHAT_ID && GRUP_CHAT_ID
      ? `💬 *Hubungi Customer Service*\n\nLangsung ketik pesanmu di sini sayang~\nCS kami akan segera membalas! 🙏\n\n_Jam layanan: 08.00 – 22.00 WIB_`
      : `💬 *Hubungi Admin*\n\nFitur live chat belum aktif.\nHubungi admin langsung ya~`;
    await ctx.reply(text, {
      ...MD(text),
      ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Kembali", "back_main")]]),
    });
  });

  // ─── HANDLER TEKS ─────────────────────────────────────────────────────────
  // Menangani 3 skenario:
  // 1. Admin di DM → flow multi-step (tambah user, promo, dll)
  // 2. Admin reply di topic live chat grup → forward balik ke user
  // 3. User di DM (non-admin, tidak dalam session step) → forward ke topic live chat
  bot.on("text", async (ctx) => {
    const chatType = ctx.chat.type;
    const senderId = String(ctx.from?.id ?? "");

    // ── Skenario 2: Admin reply dari topic live chat → forward ke user ─────
    if (
      TOPIC_LIVECHAT_ID &&
      GRUP_CHAT_ID &&
      chatType !== "private" &&
      String(ctx.chat.id) === String(GRUP_CHAT_ID) &&
      (ctx.message as any).message_thread_id === TOPIC_LIVECHAT_ID
    ) {
      const replyToMsgId = ctx.message.reply_to_message?.message_id;
      if (replyToMsgId && liveChatMap.has(replyToMsgId)) {
        const userTelegramId = liveChatMap.get(replyToMsgId)!;
        try {
          await bot.telegram.sendMessage(
            userTelegramId,
            `💬 *CS:* ${ctx.message.text}`,
            MD("")
          );
        } catch (e: any) {
          logger.warn({ err: e?.message, userTelegramId }, "[LiveChat] Gagal forward reply CS ke user");
        }
      }
      return;
    }

    // ── Skenario 1 & 3: Pesan dari DM ─────────────────────────────────────
    if (chatType !== "private") return;

    const step = ctx.session?.step;
    const text = ctx.message.text.trim();

    // ── Skenario 3: User (non-admin, tidak dalam session step) → forward ke topic
    if (!isAdmin(ctx) && !step && TOPIC_LIVECHAT_ID && GRUP_CHAT_ID) {
      const userName = ctx.from?.first_name ?? "User";
      try {
        const sentMsg = await bot.telegram.sendMessage(
          GRUP_CHAT_ID,
          `💬 *Pesan dari ${userName}* (ID: \`${senderId}\`)\n\n${text}`,
          { ...MD(""), message_thread_id: TOPIC_LIVECHAT_ID } as any
        );
        // Simpan mapping: topic_msg_id → user telegram_id
        liveChatMap.set(sentMsg.message_id, senderId);
        if (liveChatMap.size > LIVE_CHAT_MAP_MAX) {
          const oldest = liveChatMap.keys().next().value;
          if (oldest !== undefined) liveChatMap.delete(oldest);
        }
        await ctx.reply(`✅ Pesanmu sudah diterima CS! Tunggu balasan ya sayang~ 🙏`, MD(""));
      } catch (e: any) {
        logger.warn({ err: e?.message }, "[LiveChat] Gagal forward pesan user ke topic");
        await ctx.reply(`❌ Maaf, pesan gagal terkirim. Coba lagi ya~`);
      }
      return;
    }

    // ── Skenario 1: Admin di DM → flow multi-step ─────────────────────────
    if (!isAdmin(ctx)) return;

    // Step: tunggu persentase diskon promo
    if (step === "admin_promo_percent") {
      const percent = parseInt(text);
      if (isNaN(percent) || percent < 1 || percent > 99) {
        return ctx.reply("❌ Persentase harus antara 1–99. Coba lagi:");
      }
      ctx.session = { step: "admin_promo_label", pendingPromoPercent: percent };
      return ctx.reply(
        `✅ Diskon *${percent}%* dipilih.\n\nSekarang kirim nama/label promo:\n_Contoh: Lebaran, Flash Sale, dll._`,
        { ...MD(""), ...Markup.inlineKeyboard([[Markup.button.callback("❌ Batal", "admin_promo")]]) }
      );
    }

    // Step: tunggu label promo
    if (step === "admin_promo_label") {
      const percent = ctx.session.pendingPromoPercent;
      if (!percent) return ctx.reply("Sesi habis. Coba lagi dari menu promo.");
      activePromo = { discountPercent: percent, label: text };
      ctx.session = {};
      await ctx.reply(
        `🎉 *Promo Aktif!*\n\n` +
        `🏷️ Label: *${text}*\n` +
        `💸 Diskon: *${percent}%*\n\n` +
        `Harga promo sekarang:\n` +
        `   • 30 Hari: *${getEffectiveFormatted(PLANS["30d"].price)}*\n` +
        `   • 60 Hari: *${getEffectiveFormatted(PLANS["60d"].price)}*\n` +
        `   • 90 Hari: *${getEffectiveFormatted(PLANS["90d"].price)}*`,
        { ...MD(""), ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Kembali ke Admin", "back_admin")]]) }
      );
      return;
    }

    // Step: tunggu Telegram ID untuk adduser
    if (step === "admin_adduser_id") {
      if (!/^\d+$/.test(text)) {
        return ctx.reply("❌ Telegram ID harus berupa angka. Coba lagi:");
      }
      ctx.session = { step: "admin_adduser_plan", pendingTelegramId: text };
      return ctx.reply(
        `🆔 ID: \`${text}\`\n\nPilih paket untuk user ini:`,
        {
          ...MD(""),
          ...Markup.inlineKeyboard([
            [Markup.button.callback("📦 30 Hari", "admin_setplan_30d")],
            [Markup.button.callback("📦 60 Hari", "admin_setplan_60d")],
            [Markup.button.callback("📦 90 Hari", "admin_setplan_90d")],
            [Markup.button.callback("❌ Batal", "back_admin")],
          ])
        }
      );
    }

    // Step: tunggu Telegram ID untuk deleteuser
    if (step === "admin_deleteuser_id") {
      if (!/^\d+$/.test(text)) {
        return ctx.reply("❌ Telegram ID harus berupa angka. Coba lagi:");
      }
      await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.telegramId, text));
      ctx.session = {};
      return ctx.reply(
        `✅ User \`${text}\` dinonaktifkan.`,
        { ...MD(""), ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Kembali", "back_admin")]]) }
      );
    }

    // Step: tunggu Telegram ID untuk extenduser
    if (step === "admin_extenduser_id") {
      if (!/^\d+$/.test(text)) {
        return ctx.reply("❌ Telegram ID harus berupa angka. Coba lagi:");
      }
      const user = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, text) });
      if (!user) {
        return ctx.reply(
          `❌ User \`${text}\` tidak ditemukan.`,
          { ...MD(""), ...Markup.inlineKeyboard([[Markup.button.callback("❌ Batal", "back_admin")]]) }
        );
      }
      ctx.session = { step: "admin_extenduser_days", pendingTelegramId: text };
      return ctx.reply(
        `🆔 User: *${user.telegramName || text}*\nExpires: *${formatDate(user.expiresAt)}*\n\nBerapa hari ingin diperpanjang? (contoh: 30)`,
        { ...MD(""), ...Markup.inlineKeyboard([[Markup.button.callback("❌ Batal", "back_admin")]]) }
      );
    }

    // Step: tunggu jumlah hari untuk extenduser
    if (step === "admin_extenduser_days") {
      const days = parseInt(text);
      if (isNaN(days) || days <= 0) {
        return ctx.reply("❌ Jumlah hari tidak valid. Coba lagi:");
      }
      const telegramId = ctx.session.pendingTelegramId!;
      const user = await db.query.usersTable.findFirst({ where: eq(usersTable.telegramId, telegramId) });
      if (!user) return ctx.reply("❌ User tidak ditemukan.");

      const base = user.expiresAt > new Date() ? user.expiresAt : new Date();
      const newExpiry = addDays(base, days);
      await db.update(usersTable)
        .set({ expiresAt: newExpiry, isActive: true })
        .where(eq(usersTable.telegramId, telegramId));
      ctx.session = {};

      await ctx.reply(
        `✅ *Diperpanjang ${days} hari*\n\n🆔 \`${telegramId}\`\n📅 Expires baru: *${formatDate(newExpiry)}*`,
        { ...MD(""), ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Kembali", "back_admin")]]) }
      );
      try {
        await bot.telegram.sendMessage(telegramId,
          `🎉 *Yeay, langganan kamu diperpanjang sayang!* 🥳\nDitambahin *${days} hari* lagi buat kamu~\n📅 Aktif sampai: *${formatDate(newExpiry)}*`, MD("")
        );
      } catch (_) { }
    }
  });

  async function launchWithRetry(retries = 5, delayMs = 5000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        // ── Fix 409: force-terminate any existing long-poll session ──────────
        // Calling deleteWebhook (even in polling mode) also terminates any
        // active getUpdates long-poll on Telegram's side, resolving 409 immediately
        // without having to wait 50-65s for the old poll to expire naturally.
        try {
          await bot.telegram.deleteWebhook({ drop_pending_updates: false });
          logger.info("[TelegramBot] deleteWebhook OK — old polling session cleared");
        } catch (hookErr: any) {
          logger.warn({ err: hookErr?.message }, "[TelegramBot] deleteWebhook failed (non-fatal, continuing)");
        }

        // Short settle window so Telegram registers the deleteWebhook before we poll
        await new Promise((r) => setTimeout(r, 1500));

        // drop_pending_updates: true on restart avoids processing a storm of
        // stale updates that accumulated while the server was down.
        await bot.launch({ dropPendingUpdates: true });
        logger.info("Telegram bot started successfully");
        await restorePendingPayments(bot, ADMIN_CHAT_ID, notifyAdmin, TOPIC_PAYMENT_ID);
        return;
      } catch (err: any) {
        const is409 = err?.response?.error_code === 409 || String(err?.message).includes("409");
        if (attempt < retries) {
          const wait = is409 ? 10_000 : delayMs;
          logger.warn({ attempt, retries, is409 }, `Telegram bot failed to start — retrying in ${wait / 1000}s...`);
          await new Promise((r) => setTimeout(r, wait));
        } else {
          logger.error({ err }, "Failed to start Telegram bot after all retries");
        }
      }
    }
  }

  launchWithRetry();

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));

  return bot;
}

async function restorePendingPayments(
  bot: Telegraf<BotContext>,
  adminChatId: string | undefined,
  notifyAdmin: (text: string, threadId?: number) => Promise<void>,
  topicPaymentId?: number
) {
  try {
    const pending = await db.query.pendingPaymentsTable.findMany();
    const now = new Date();

    for (const payment of pending) {
      if (payment.expiresAt <= now) {
        await db.delete(pendingPaymentsTable).where(eq(pendingPaymentsTable.donationId, payment.donationId));
        logger.info({ donationId: payment.donationId }, "Removed expired pending payment on restore");
        continue;
      }

      const plan = payment.plan as PlanKey;
      const planInfo = PLANS[plan];
      if (!planInfo) continue;

      logger.info({ donationId: payment.donationId }, "Restoring payment polling");

      startPaymentPolling(
        bot,
        payment.donationId,
        payment.chatId,
        payment.telegramId,
        payment.telegramUsername ?? undefined,
        payment.telegramName,
        plan,
        planInfo,
        parseFloat(String(payment.amount)),
        payment.expiresAt,
        adminChatId,
        notifyAdmin,
        topicPaymentId,
        payment.waitingMsgId ?? undefined
      );
    }

    if (pending.length > 0) {
      logger.info({ count: pending.length }, "Restored pending payment polling");
    }
  } catch (err) {
    logger.error({ err }, "Failed to restore pending payments");
  }
}
