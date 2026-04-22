/**
 * frArbEngine.ts — Funding Rate Arbitrage Engine
 *
 * Exchange-agnostic engine untuk strategi FR Arb.
 * Mendukung Extended (Lighter tidak punya FR data — pakai lighterFrArbEngine).
 *
 * Dipanggil setiap 15 menit dari background job di masing-masing route.
 * Pola: sama dengan autoRerange.ts (engine murni, dipanggil dari routes T4).
 *
 * Flow per tick:
 *   1. Fetch FR terkini dari exchange
 *   2. Jika belum ada posisi → cek entry threshold → buka posisi
 *   3. Jika ada posisi → cek exit conditions → tutup posisi
 *   4. Update state ke DB
 *   5. Kirim notif Telegram ENTRY / EXIT
 */

import Decimal from "decimal.js";
import { db } from "@workspace/db";
import { strategiesTable, botLogsTable } from "@workspace/db";
import type { FrArbConfig, FrArbState } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { getBotConfig, getExtendedCredentials } from "../routes/configService";
import { sendMessageToUser } from "./telegramBot";

// ─── Extended imports ─────────────────────────────────────────────────────────
import {
  getMarketStats,
  getOrderBookDepth,
  getMidPrice,
  getAccountDetails,
  placeExtendedOrder,
  calcMarketOrderPrice,
  getOrderHistory,
  getOpenOrders,
  getOrderByExternalId,
} from "./extended/extendedApi";
import type { ExtendedNetwork } from "./extended/extendedApi";

// ─── Pending entry order polling helper ───────────────────────────────────────
// BUG-FRARB-001: poll Extended order status untuk konfirmasi fill sebelum
// transition state ke isInPosition: true.
interface PendingEntryResult {
  status: "filled" | "pending" | "terminated";
  fillPrice: number;
  fillQty: number;
}

async function checkExtendedPendingEntry(
  userId: number,
  externalId: string,
  ticker: string,
  network: ExtendedNetwork
): Promise<PendingEntryResult> {
  const creds = await getExtendedCredentials(userId).catch(() => null);
  if (!creds?.apiKey) {
    return { status: "pending", fillPrice: 0, fillQty: 0 };
  }
  const order = await getOrderByExternalId(creds.apiKey, externalId, network).catch(() => null);
  if (!order) {
    return { status: "pending", fillPrice: 0, fillQty: 0 };
  }
  const status = String(order.status ?? "").toUpperCase();
  const filledQty = parseFloat(order.filledQty ?? "0") || 0;
  const avgPrice = parseFloat(order.averagePrice ?? "0") || parseFloat(order.price ?? "0") || 0;

  if (status === "FILLED" || (filledQty > 0 && (status === "PARTIALLY_FILLED" || status === "CLOSED"))) {
    return { status: "filled", fillPrice: avgPrice, fillQty: filledQty };
  }
  if (status === "CANCELLED" || status === "REJECTED" || status === "EXPIRED") {
    return { status: "terminated", fillPrice: avgPrice, fillQty: filledQty };
  }
  return { status: "pending", fillPrice: avgPrice, fillQty: filledQty };
}
import { getExtendedMarketInfo } from "./extended/extendedMarkets";

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

// ─── Running bots registry ────────────────────────────────────────────────────
// Map<strategyId, intervalId> — menyimpan setInterval handle aktif per strategy.

const runningFrArbBots = new Map<number, ReturnType<typeof setInterval>>();

// Guard: mencegah dua tick berjalan bersamaan untuk strategy yang sama.
// Dalam teori, jika tick memakan waktu >15 menit, interval berikutnya bisa overlap.
const tickingFrArbBots = new Set<number>();

// Guard: mencegah entry/exit setelah user memanggil stop saat tick sedang berjalan.
// stopFrArbBot() menambah strategyId ke sini — tick yang sedang berjalan akan
// melihat flag ini sebelum place order dan membatalkan aksi.
const stoppingFrArbBots = new Set<number>();

export function isFrArbBotRunning(strategyId: number): boolean {
  return runningFrArbBots.has(strategyId);
}

export function getAllRunningFrArbBots(): number[] {
  return Array.from(runningFrArbBots.keys());
}

// ─── Helpers: logging ────────────────────────────────────────────────────────

async function frAddLog(
  userId: number | null,
  strategyId: number | null,
  strategyName: string | null,
  level: "info" | "warn" | "error" | "success",
  message: string,
  details?: string,
  exchange: string = "extended"
): Promise<void> {
  try {
    await db.insert(botLogsTable).values({
      userId,
      strategyId,
      strategyName,
      level,
      message,
      details: details ?? null,
      exchange,
    });
  } catch (err) {
    logger.error({ err }, "[FrArb] Failed to add bot log");
  }
}

async function frNotifyUser(userId: number | null, message: string): Promise<void> {
  if (userId === null || userId === undefined) return;
  try {
    const botCfg = await getBotConfig(userId);
    if (!botCfg.notifyBotToken || !botCfg.notifyChatId) return;
    await sendMessageToUser(botCfg.notifyChatId, message, botCfg.notifyBotToken);
  } catch (err: any) {
    logger.warn({ err: err?.message }, "[FrArb] frNotifyUser failed");
  }
}

// ─── Helpers: state management ────────────────────────────────────────────────

async function saveFrArbState(
  strategyId: number,
  patch: Partial<FrArbState>
): Promise<void> {
  const current = await db.query.strategiesTable.findFirst({
    where: eq(strategiesTable.id, strategyId),
  });
  if (!current) return;

  const existing = (current.frArbState as FrArbState | null) ?? {
    isInPosition: false,
    positionSide: null,
    entryPrice: null,
    entryFr: null,
    entryAt: null,
    openOrderId: null,
    openQty: null,
    closeOrderId: null,
    frAccumulated: null,
    lastCheckedAt: null,
    pendingEntryDigest: null,
    pendingEntrySide: null,
    pendingCloseDigest: null,
  };

  const merged: FrArbState = { closeAttemptedAt: null, ...existing, ...patch };

  await db.update(strategiesTable)
    .set({ frArbState: merged, updatedAt: new Date() })
    .where(eq(strategiesTable.id, strategyId));
}

function resetFrArbState(): FrArbState {
  return {
    isInPosition: false,
    positionSide: null,
    entryPrice: null,
    entryFr: null,
    entryAt: null,
    openOrderId: null,
    openQty: null,
    closeOrderId: null,
    frAccumulated: null,
    lastCheckedAt: new Date().toISOString(),
    closeAttemptedAt: null,
    pendingEntryDigest: null,
    pendingEntrySide: null,
    pendingCloseDigest: null,
  };
}

// ─── Helpers: FR calculation ──────────────────────────────────────────────────

function calcFrAccumulated(entryFr: number | null, entryAt: string | null): number {
  if (entryFr === null || entryAt === null) return 0;
  const elapsedMs = Date.now() - new Date(entryAt).getTime();
  const elapsedHours = elapsedMs / (1000 * 60 * 60);
  return entryFr * elapsedHours;
}

// ─── Telegram notification templates ─────────────────────────────────────────

function buildEntryNotif(
  strategyName: string,
  exchange: string,
  state: FrArbState,
  config: FrArbConfig,
  currentFr: number
): string {
  const dexLabel = "✳️ Extended";
  void exchange;
  const sideEmoji = state.positionSide === "long" ? "🟢" : "🔴";
  const frPct = (currentFr * 100).toFixed(4);
  const entryPriceStr = state.entryPrice != null ? `$${state.entryPrice.toFixed(4)}` : "N/A";
  const slLine = config.stopLoss != null
    ? `\n🛑 Stop Loss: \`$${config.stopLoss.toFixed(4)}\``
    : "";

  return (
    `📥 *FR ARB ENTRY* · ${dexLabel}\n\n` +
    `📌 *${strategyName}*\n` +
    `${sideEmoji} Side: *${(state.positionSide ?? "").toUpperCase()}*\n` +
    `💰 Entry Price: \`${entryPriceStr}\`\n` +
    `📊 FR: \`${frPct}%/h\`\n` +
    `💵 Size: \`${config.positionSize} USDC\`\n` +
    `⏱ Max Hold: \`${config.maxHoldHours}h\`` +
    slLine
  );
}

function buildExitNotif(
  strategyName: string,
  exchange: string,
  state: FrArbState,
  closePrice: number,
  exitReason: string
): string {
  const dexLabel = "✳️ Extended";
  void exchange;
  const frCollected = calcFrAccumulated(state.entryFr, state.entryAt);
  const frPct = (frCollected * 100).toFixed(4);

  const entryPriceStr = state.entryPrice != null ? `$${state.entryPrice.toFixed(4)}` : "N/A";
  const closePriceStr = `$${closePrice.toFixed(4)}`;

  let pnl = 0;
  if (state.entryPrice != null && state.positionSide != null) {
    const diff = closePrice - state.entryPrice;
    pnl = state.positionSide === "long" ? diff : -diff;
  }
  const pnlStr = (pnl >= 0 ? "+" : "") + pnl.toFixed(4);

  return (
    `📤 *FR ARB EXIT* · ${dexLabel}\n\n` +
    `📌 *${strategyName}*\n` +
    `❓ Reason: \`${exitReason}\`\n\n` +
    `📈 Entry: \`${entryPriceStr}\`\n` +
    `📉 Close: \`${closePriceStr}\`\n` +
    `💹 PnL: \`${pnlStr} USDC\`\n` +
    `💰 FR Collected (est.): \`${frPct}%\``
  );
}

// ─── Extended: fetch FR ───────────────────────────────────────────────────────

async function getExtendedFr(market: string, network: ExtendedNetwork): Promise<number | null> {
  const stats = await getMarketStats(market, network).catch(() => null);
  if (stats?.fundingRate == null) return null;
  const fr = parseFloat(stats.fundingRate);
  return isNaN(fr) ? null : fr;
}

// ─── Extended: fetch current market price ────────────────────────────────────

async function getExtendedCurrentPrice(market: string, network: ExtendedNetwork): Promise<Decimal | null> {
  const book = await getOrderBookDepth(market, network).catch(() => null);
  if (!book) return null;
  return getMidPrice(book);
}

// ─── Extended: place order ───────────────────────────────────────────────────

interface ExtOrderResult {
  orderId: string;
  fillPrice: number;
  qty: string;
}

async function placeExtendedFrOrder(
  userId: number,
  strategyId: number,
  strategyName: string,
  market: string,
  side: "long" | "short",
  positionSizUsdc: number,
  orderType: FrArbConfig["orderType"],
  limitPriceOffset: number | undefined,
  reduceOnly: boolean,
  currentPrice: Decimal,
  network: ExtendedNetwork,
  forceQty?: string
): Promise<ExtOrderResult | null> {
  const creds = await getExtendedCredentials(userId).catch(() => null);
  if (!creds?.apiKey || !creds?.privateKey) {
    await frAddLog(userId, strategyId, strategyName, "error", "[FrArb] Extended credentials tidak lengkap");
    return null;
  }

  // Fetch l2Vault fresh (wajib untuk SNIP-12 signing)
  const accountDetails = await getAccountDetails(creds.apiKey, network).catch(() => null);
  const rawVault = accountDetails ? (accountDetails as any).l2Vault ?? null : null;
  if (rawVault == null) {
    await frAddLog(userId, strategyId, strategyName, "error",
      "[FrArb] Gagal fetch l2Vault dari Extended API — tidak bisa sign order");
    return null;
  }
  const collateralPosition = String(rawVault);

  // Market info untuk step/tick size
  const marketInfo = await getExtendedMarketInfo(market, undefined, network).catch(() => null);
  const stepSize = marketInfo?.stepSize ?? "0.0001";
  const tickSize = marketInfo?.tickSize ?? "0.1";
  const stepDecimals = stepSize.includes(".") ? stepSize.split(".")[1].length : 0;
  const tickDecimals = tickSize.includes(".") ? tickSize.split(".")[1].replace(/0+$/, "").length : 0;

  // Hitung qty: positionSize (USDC) / currentPrice, atau gunakan forceQty (untuk close)
  const qtyStr = forceQty
    ? forceQty
    : new Decimal(positionSizUsdc).div(currentPrice)
        .toDecimalPlaces(stepDecimals, Decimal.ROUND_DOWN)
        .toFixed(stepDecimals);

  // Determine execution price
  const extSide = side === "long" ? "BUY" : "SELL";
  let priceStr: string;
  let extOrderType: "LIMIT" | "MARKET";
  let extTimeInForce: "GTT" | "IOC";
  let postOnly: boolean;

  if (orderType === "market") {
    priceStr = calcMarketOrderPrice(currentPrice.toFixed(8), extSide, tickDecimals);
    extOrderType = "MARKET";
    extTimeInForce = "IOC";
    postOnly = false;
  } else {
    const offsetPct = limitPriceOffset ?? 0.1;
    const offset = currentPrice.mul(new Decimal(offsetPct)).div(100);
    const rawPrice = side === "long" ? currentPrice.sub(offset) : currentPrice.add(offset);
    priceStr = rawPrice.toDecimalPlaces(tickDecimals, Decimal.ROUND_HALF_UP).toFixed(tickDecimals);
    extOrderType = "LIMIT";
    extTimeInForce = "GTT";
    postOnly = orderType === "post_only";
  }

  try {
    const result = await placeExtendedOrder({
      apiKey: creds.apiKey,
      privateKey: creds.privateKey,
      collateralPosition,
      market,
      type: extOrderType,
      side: extSide,
      qty: qtyStr,
      price: priceStr,
      timeInForce: extTimeInForce,
      postOnly,
      reduceOnly,
      network,
    });

    await frAddLog(userId, strategyId, strategyName, "success",
      `[FrArb] Extended ${side.toUpperCase()} order dikirim`,
      `orderId: ${result.orderId} | qty: ${qtyStr} | price: $${priceStr}`);

    return { orderId: String(result.orderId), fillPrice: parseFloat(priceStr), qty: qtyStr };
  } catch (err: any) {
    const msg = err instanceof Error ? err.message : String(err);
    await frAddLog(userId, strategyId, strategyName, "error",
      `[FrArb] Extended ${side.toUpperCase()} order gagal`, msg);
    return null;
  }
}

// ─── Main tick function ───────────────────────────────────────────────────────

export async function tickFrArb(strategyId: number): Promise<void> {
  // BUG-FRARB-009: Concurrent tick guard
  if (tickingFrArbBots.has(strategyId)) {
    logger.warn({ strategyId }, "[FrArb] Tick masih berjalan, skip (concurrent guard)");
    return;
  }
  tickingFrArbBots.add(strategyId);
  try {

  const strategy = await db.query.strategiesTable.findFirst({
    where: eq(strategiesTable.id, strategyId),
  });

  if (!strategy) {
    logger.warn({ strategyId }, "[FrArb] Strategy tidak ditemukan, skip tick");
    return;
  }

  if (!strategy.isRunning) {
    logger.info({ strategyId }, "[FrArb] Strategy tidak running, skip tick");
    return;
  }

  const config = strategy.frArbConfig as FrArbConfig | null;
  if (!config) {
    logger.warn({ strategyId }, "[FrArb] frArbConfig kosong, skip tick");
    return;
  }

  const state = (strategy.frArbState as FrArbState | null) ?? {
    isInPosition: false,
    positionSide: null,
    entryPrice: null,
    entryFr: null,
    entryAt: null,
    openOrderId: null,
    openQty: null,
    closeOrderId: null,
    frAccumulated: null,
    lastCheckedAt: null,
    closeAttemptedAt: null,
    pendingEntryDigest: null,
    pendingEntrySide: null,
    pendingCloseDigest: null,
  };

  const userId = strategy.userId;
  const exchange = strategy.exchange;
  const ticker = strategy.marketSymbol;
  const extNetwork: ExtendedNetwork = "mainnet";

  if (exchange !== "extended") {
    logger.warn({ strategyId, exchange }, "[FrArb] Engine ini hanya support Extended; gunakan lighterFrArbEngine untuk Lighter");
    return;
  }

  logger.info({ strategyId, exchange, ticker, isInPosition: state.isInPosition }, "[FrArb] Tick start");

  // ── 1.5: Poll pending entry order (BUG-FRARB-001) ───────────────────────────
  // isInPosition hanya di-set true setelah order fill dikonfirmasi via REST poll.
  // Untuk market/IOC yang reject maupun limit/post_only GTT yang tidak fill,
  // state kembali ke idle — tidak ada false in-position.
  if (state.pendingEntryDigest && !state.isInPosition) {
    const pendingId = state.pendingEntryDigest;

    const pollResult: PendingEntryResult = await checkExtendedPendingEntry(
      userId!,
      pendingId,
      ticker,
      extNetwork,
    );

    if (pollResult.status === "filled") {
      // Konfirmasi fill — set isInPosition: true dengan fill price aktual
      const positionSide: "long" | "short" =
        state.positionSide ??
        (state.pendingEntrySide === "buy" ? "long" : state.pendingEntrySide === "sell" ? "short" : "long");
      const confirmedState: FrArbState = {
        isInPosition: true,
        positionSide,
        entryPrice: pollResult.fillPrice,
        entryFr: state.entryFr,
        entryAt: state.entryAt,
        openOrderId: pendingId,
        openQty: String(pollResult.fillQty),
        closeOrderId: null,
        frAccumulated: 0,
        lastCheckedAt: new Date().toISOString(),
        closeAttemptedAt: null,
        pendingEntryDigest: null,
        pendingEntrySide: null,
        pendingCloseDigest: null,
      };
      await db.update(strategiesTable)
        .set({ frArbState: confirmedState, updatedAt: new Date() })
        .where(eq(strategiesTable.id, strategyId));
      const entryMsg = buildEntryNotif(strategy.name, exchange, confirmedState, config, state.entryFr ?? 0);
      await frNotifyUser(userId, entryMsg);
      await frAddLog(userId, strategyId, strategy.name, "success",
        `[FrArb] Entry TERKONFIRMASI filled — posisi ${positionSide.toUpperCase()} aktif`,
        `orderId: ${pendingId} | Price: $${pollResult.fillPrice.toFixed(4)} | Qty: ${pollResult.fillQty}`,
        exchange);

    } else if (pollResult.status === "terminated") {
      // Order dibatalkan/ditolak exchange — kembali ke idle
      await db.update(strategiesTable)
        .set({ frArbState: resetFrArbState(), updatedAt: new Date() })
        .where(eq(strategiesTable.id, strategyId));
      await frAddLog(userId, strategyId, strategy.name, "warn",
        "[FrArb] Entry order dibatalkan/ditolak exchange — kembali idle",
        `orderId: ${pendingId}`, exchange);

    } else {
      // Masih pending — update lastCheckedAt saja
      await saveFrArbState(strategyId, { lastCheckedAt: new Date().toISOString() });
      await frAddLog(userId, strategyId, strategy.name, "info",
        "[FrArb] Entry order masih pending, belum terisi — menunggu tick berikutnya",
        `orderId: ${pendingId}`, exchange);
    }
    return; // selalu return — tick berikutnya handle sisanya
  }

  // ── 1. Fetch current FR ─────────────────────────────────────────────────────

  const currentFr: number | null = await getExtendedFr(ticker, extNetwork);

  if (currentFr === null) {
    logger.warn({ strategyId, exchange, ticker }, "[FrArb] Gagal fetch FR, skip tick");
    await saveFrArbState(strategyId, { lastCheckedAt: new Date().toISOString() });
    return;
  }

  const absFr = Math.abs(currentFr);
  logger.info({ strategyId, currentFr, absFr, isInPosition: state.isInPosition }, "[FrArb] FR fetched");

  // ── 2. NOT in position — check entry ────────────────────────────────────────

  if (!state.isInPosition) {
    await saveFrArbState(strategyId, { lastCheckedAt: new Date().toISOString() });

    if (absFr < config.entryFrThreshold) {
      logger.info({ strategyId, absFr, threshold: config.entryFrThreshold }, "[FrArb] FR di bawah threshold, idle");
      return;
    }

    // Tentukan side
    let side: "long" | "short";
    if (config.side === "auto") {
      side = currentFr > 0 ? "short" : "long";
    } else {
      side = config.side;
    }

    logger.info({ strategyId, side, currentFr }, "[FrArb] FR >= threshold — buka posisi");

    // BUG-FRARB-008: Cek apakah user sudah stop bot saat tick ini sedang berjalan
    if (stoppingFrArbBots.has(strategyId)) {
      logger.info({ strategyId }, "[FrArb] Bot dihentikan saat tick, abort entry");
      return;
    }

    // Fetch current price
    let orderId: string | null = null;

    const currentPrice = await getExtendedCurrentPrice(ticker, extNetwork);
    if (!currentPrice) {
      logger.warn({ strategyId }, "[FrArb] Gagal fetch harga Extended, skip entry");
      return;
    }

    const result = await placeExtendedFrOrder(
      userId!, strategyId, strategy.name,
      ticker, side,
      config.positionSize, config.orderType, config.limitPriceOffset,
      false, currentPrice, extNetwork,
    );
    if (result) { orderId = result.orderId; }

    // BUG-FRARB-001: orderId (bukan fillPrice) yang menentukan sukses/gagal.
    // fillPrice adalah harga submisi (estimasi) — fill price aktual dikonfirmasi via poll.
    if (orderId === null) {
      logger.warn({ strategyId }, "[FrArb] Order entry gagal, state tidak diubah");
      return;
    }

    // Simpan sebagai pending — JANGAN set isInPosition: true dulu.
    // Tick berikutnya akan poll order status dan konfirmasi fill.
    const pendingState: FrArbState = {
      isInPosition: false,
      positionSide: side,
      entryPrice: null,          // belum dikonfirmasi, diisi saat fill terkonfirmasi
      entryFr: currentFr,
      entryAt: new Date().toISOString(),
      openOrderId: null,         // diisi setelah fill terkonfirmasi
      openQty: null,
      closeOrderId: null,
      frAccumulated: 0,
      lastCheckedAt: new Date().toISOString(),
      closeAttemptedAt: null,
      pendingEntryDigest: orderId,
      pendingEntrySide: side === "long" ? "buy" : "sell",
      pendingCloseDigest: null,
    };

    await db.update(strategiesTable)
      .set({ frArbState: pendingState, updatedAt: new Date() })
      .where(eq(strategiesTable.id, strategyId));

    await frAddLog(userId, strategyId, strategy.name, "info",
      `[FrArb] Entry order DIKIRIM — menunggu konfirmasi fill di tick berikutnya`,
      `orderId: ${orderId} | side: ${side} | FR: ${(currentFr * 100).toFixed(4)}%/h`, exchange);

    return; // notif Telegram dikirim setelah fill dikonfirmasi (section 1.5)
  }

  // ── 3. IN position — check exit conditions ──────────────────────────────────

  const elapsedMs = state.entryAt ? (Date.now() - new Date(state.entryAt).getTime()) : 0;
  const elapsedHours = elapsedMs / (1000 * 60 * 60);
  const frAccumulated = calcFrAccumulated(state.entryFr, state.entryAt);

  // Jika close sebelumnya gagal → paksa retry tanpa cek FR/SL/maxHold
  const forceRetryClose = state.closeAttemptedAt !== null;
  let exitFlag = forceRetryClose;
  let exitReason = forceRetryClose
    ? `Retry close — sebelumnya gagal @ ${state.closeAttemptedAt}`
    : "";

  if (!forceRetryClose) {
    if (absFr <= config.exitFrThreshold) {
      exitFlag = true;
      exitReason = "FR normalized";
    } else if (elapsedHours >= config.maxHoldHours) {
      exitFlag = true;
      exitReason = "Max hold timeout";
    } else if (config.stopLoss != null) {
      // Fetch current price untuk SL check
      const cp = await getExtendedCurrentPrice(ticker, extNetwork);
      const currentPriceForSL: number | null = cp ? cp.toNumber() : null;

      if (currentPriceForSL !== null) {
        const sl = config.stopLoss;
        if (state.positionSide === "long" && currentPriceForSL <= sl) {
          exitFlag = true;
          exitReason = `Stop loss hit @ $${currentPriceForSL.toFixed(4)}`;
        } else if (state.positionSide === "short" && currentPriceForSL >= sl) {
          exitFlag = true;
          exitReason = `Stop loss hit @ $${currentPriceForSL.toFixed(4)}`;
        }
      }
    }
  }

  const closeForceQty = state.openQty ?? undefined;

  if (!exitFlag) {
    // Idle — update frAccumulated dan lastCheckedAt
    await saveFrArbState(strategyId, {
      frAccumulated,
      lastCheckedAt: new Date().toISOString(),
    });
    logger.info({ strategyId, frAccumulated, elapsedHours }, "[FrArb] In position, idle tick");
    return;
  }

  // ── 4. EXIT ──────────────────────────────────────────────────────────────────

  logger.info({ strategyId, exitReason }, "[FrArb] Exit condition met — tutup posisi");

  // BUG-FRARB-008: Cek apakah user sudah stop bot saat tick ini sedang berjalan
  if (stoppingFrArbBots.has(strategyId)) {
    logger.info({ strategyId }, "[FrArb] Bot dihentikan saat tick, abort exit — posisi TETAP TERBUKA, close manual diperlukan");
    await frNotifyUser(userId,
      `⚠️ *FR ARB — EXIT DIBATALKAN*\n📌 *${strategy.name}*\n🛑 Bot dihentikan tepat saat akan close posisi.\nClose posisi manual diperlukan!`);
    return;
  }

  const closeSide: "long" | "short" = state.positionSide === "long" ? "short" : "long";
  let closeResult: { orderId: string; fillPrice: number } | null = null;

  const currentPriceForClose = await getExtendedCurrentPrice(ticker, extNetwork);
  if (!currentPriceForClose) {
    logger.error({ strategyId }, "[FrArb] Gagal fetch harga untuk close Extended — posisi TETAP TERBUKA");
    await frAddLog(userId, strategyId, strategy.name, "error",
      "[FrArb] KRITIS: Gagal fetch harga Extended untuk close posisi", exitReason, "extended");
    await saveFrArbState(strategyId, { closeAttemptedAt: new Date().toISOString() });
    await frNotifyUser(userId,
      `🚨 *FR ARB — CLOSE GAGAL*\n📌 *${strategy.name}*\n❌ Gagal fetch harga untuk close posisi.\n🔄 Bot akan retry otomatis di tick berikutnya (±15 menit).`);
    return;
  }
  closeResult = await placeExtendedFrOrder(
    userId!, strategyId, strategy.name,
    ticker, closeSide,
    config.positionSize, "market", undefined,
    true, currentPriceForClose, extNetwork, closeForceQty,
  );

  if (!closeResult) {
    logger.error({ strategyId, exitReason }, "[FrArb] Close order gagal — posisi TETAP TERBUKA");
    await saveFrArbState(strategyId, { closeAttemptedAt: new Date().toISOString() });
    await frNotifyUser(userId,
      `🚨 *FR ARB — CLOSE GAGAL*\n📌 *${strategy.name}*\n❌ Close order gagal.\n🔄 Bot akan retry otomatis di tick berikutnya (±15 menit).\nAlasan: ${exitReason}`);
    return;
  }

  // ── 5. Update state → EXIT ──────────────────────────────────────────────────

  const finalState = resetFrArbState();
  finalState.closeOrderId = closeResult.orderId;
  finalState.frAccumulated = frAccumulated;

  await db.update(strategiesTable)
    .set({ frArbState: finalState, updatedAt: new Date() })
    .where(eq(strategiesTable.id, strategyId));

  // Telegram EXIT notif
  const exitMsg = buildExitNotif(strategy.name, exchange, state, closeResult.fillPrice, exitReason);
  await frNotifyUser(userId, exitMsg);
  await frAddLog(userId, strategyId, strategy.name, "success",
    `[FrArb] Exit ${closeSide.toUpperCase()} @ $${closeResult.fillPrice.toFixed(4)}`,
    `Reason: ${exitReason} | FR collected: ${(frAccumulated * 100).toFixed(4)}%`, exchange);

  logger.info({ strategyId, exitReason, closePrice: closeResult.fillPrice }, "[FrArb] Tick selesai — posisi ditutup");

  } finally {
    // BUG-FRARB-009: Lepas concurrent guard — allow tick berikutnya
    tickingFrArbBots.delete(strategyId);
  }
}

// ─── Stop warning helper ──────────────────────────────────────────────────────

export async function notifyFrArbStopWhileInPosition(
  userId: number,
  strategyName: string,
  exchange: string,
  state: FrArbState
): Promise<void> {
  const dexLabel = "✳️ Extended";
  void exchange;
  const sideLabel = state.positionSide?.toUpperCase() ?? "?";
  const entryPriceStr = state.entryPrice != null ? `$${state.entryPrice.toFixed(4)}` : "N/A";
  const msg =
    `⚠️ *FR ARB BOT DIHENTIKAN — POSISI AKTIF* · ${dexLabel}\n\n` +
    `📌 *${strategyName}*\n` +
    `🔴 Side: *${sideLabel}*\n` +
    `💰 Entry Price: \`${entryPriceStr}\`\n\n` +
    `🚨 Bot dihentikan saat posisi masih terbuka.\n` +
    `Close posisi manual di exchange diperlukan!`;
  await frNotifyUser(userId, msg);
}

// ─── Background polling ───────────────────────────────────────────────────────

const FR_ARB_INTERVAL_MS = 15 * 60 * 1000; // 15 menit

export function startFrArbBot(strategyId: number): boolean {
  if (runningFrArbBots.has(strategyId)) {
    logger.warn({ strategyId }, "[FrArb] Bot sudah running, skip start");
    return false;
  }

  // Bersihkan flag stop/ticking yang mungkin tertinggal dari sesi sebelumnya
  stoppingFrArbBots.delete(strategyId);
  tickingFrArbBots.delete(strategyId);

  // Tick pertama langsung (tanpa menunggu 15 menit)
  tickFrArb(strategyId).catch((err) => {
    logger.error({ strategyId, err: err?.message }, "[FrArb] Tick pertama error");
  });

  const interval = setInterval(() => {
    tickFrArb(strategyId).catch((err) => {
      logger.error({ strategyId, err: err?.message }, "[FrArb] Tick error");
    });
  }, FR_ARB_INTERVAL_MS);

  runningFrArbBots.set(strategyId, interval);
  logger.info({ strategyId }, "[FrArb] Bot started — interval 15 menit");
  return true;
}

export function stopFrArbBot(strategyId: number): boolean {
  const interval = runningFrArbBots.get(strategyId);
  if (!interval) return false;

  // BUG-FRARB-008: Set flag dulu agar tick yang sedang berjalan bisa abort sebelum place order
  stoppingFrArbBots.add(strategyId);
  clearInterval(interval);
  runningFrArbBots.delete(strategyId);
  // Bersihkan flag setelah 60 detik — cukup untuk tick yang sedang berjalan selesai
  setTimeout(() => stoppingFrArbBots.delete(strategyId), 60_000);
  logger.info({ strategyId }, "[FrArb] Bot stopped");
  return true;
}

export async function restoreRunningFrArbBots(): Promise<void> {
  try {
    const running = await db.query.strategiesTable.findMany({
      where: eq(strategiesTable.isRunning, true),
    });

    const frArbStrategies = running.filter(
      (s) => s.type === "funding_arb" && s.exchange === "extended"
    );

    for (const s of frArbStrategies) {
      if (!runningFrArbBots.has(s.id)) {
        logger.info({ strategyId: s.id, exchange: s.exchange }, "[FrArb] Restore bot pasca restart");
        startFrArbBot(s.id);
      }
    }
  } catch (err) {
    logger.error({ err }, "[FrArb] restoreRunningFrArbBots error");
  }
}
