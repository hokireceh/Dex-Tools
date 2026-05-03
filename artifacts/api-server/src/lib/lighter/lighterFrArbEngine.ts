/**
 * lighterFrArbEngine.ts — Lighter Funding Rate Arbitrage Engine
 *
 * Engine terisolasi untuk FR Arb di Lighter.
 * TIDAK memodifikasi frArbEngine.ts (Extended).
 *
 * FR source: GET /api/v1/funding-rates → exchange="lighter" entry.
 * Rate formula (docs: trading-funding.md): fundingRate = clamp(premium)/8.
 * API mengembalikan rate PER-JAM (server Lighter sudah bagi 8 di sisi mereka).
 * Ref: "BigClamp = 4% per 8h, or 0.5% per hour" — 0.5% adalah nilai max yang dikembalikan.
 * Thresholds dari UI dalam format %/jam (dibagi 100 sebelum disimpan ke DB).
 *
 * Flow per tick (15 menit):
 *   1. Fetch FR terkini dari /api/v1/funding-rates
 *   2. Jika pending entry → poll fill via getTx
 *   3. Jika belum ada posisi → cek entry threshold → buka posisi
 *   4. Jika ada posisi → cek exit conditions → tutup posisi
 *   5. Update state ke DB
 *   6. Kirim notif Telegram
 */

import Decimal from "decimal.js";
import { db } from "@workspace/db";
import { strategiesTable, botLogsTable } from "@workspace/db";
import type { FrArbConfig, FrArbState } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../logger";
import { getBotConfig } from "../../routes/configService";
import { sendMessageToUser } from "../telegramBot";
import {
  getFundingRates,
  getOrderBookDepth,
  sendTx,
  toBaseAmount,
  toPriceInt,
  getTx,
  getBaseUrl,
  type Network,
} from "./lighterApi";
import { getMarkets } from "./marketCache";
import { initSigner, signCreateOrder } from "./lighterSigner";
import { acquireNonce, invalidateNonceCache, shouldInvalidateNonce, nextClientOrderIndex } from "./nonceManager";

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

// ─── Constants ────────────────────────────────────────────────────────────────

const LIGHTER_FR_ARB_INTERVAL_MS = 15 * 60 * 1000; // 15 menit

// ─── Running bots registry ────────────────────────────────────────────────────

const runningLighterFrArbBots = new Map<number, ReturnType<typeof setInterval>>();

// Concurrent tick guard — satu tick per strategyId, tidak overlap.
const tickingLighterFrArbBots = new Set<number>();

// Stop guard — mencegah entry/exit saat user memanggil stop di tengah tick.
const stoppingLighterFrArbBots = new Set<number>();

export function isLighterFrArbBotRunning(strategyId: number): boolean {
  return runningLighterFrArbBots.has(strategyId);
}

export function getAllRunningLighterFrArbBots(): number[] {
  return Array.from(runningLighterFrArbBots.keys());
}

// ─── Logging helpers ──────────────────────────────────────────────────────────

async function frLog(
  userId: number | null,
  strategyId: number | null,
  strategyName: string | null,
  level: "info" | "warn" | "error" | "success",
  message: string,
  details?: string
): Promise<void> {
  try {
    await db.insert(botLogsTable).values({
      userId,
      strategyId,
      strategyName,
      level,
      message,
      details: details ?? null,
      exchange: "lighter",
    });
  } catch (err) {
    logger.error({ err }, "[LighterFrArb] Failed to add bot log");
  }
}

async function frNotify(userId: number | null, message: string): Promise<void> {
  if (userId === null || userId === undefined) return;
  try {
    const botCfg = await getBotConfig(userId);
    if (!botCfg.notifyBotToken || !botCfg.notifyChatId) return;
    await sendMessageToUser(botCfg.notifyChatId, message, botCfg.notifyBotToken);
  } catch (err: any) {
    logger.warn({ err: err?.message }, "[LighterFrArb] frNotify failed");
  }
}

// ─── State management ─────────────────────────────────────────────────────────

async function saveFrState(strategyId: number, patch: Partial<FrArbState>): Promise<void> {
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
    closeAttemptedAt: null,
    pendingEntryDigest: null,
    pendingEntrySide: null,
    pendingCloseDigest: null,
  };

  const merged: FrArbState = { ...existing, ...patch };
  await db.update(strategiesTable)
    .set({ frArbState: merged, updatedAt: new Date() })
    .where(eq(strategiesTable.id, strategyId));
}

function resetFrState(): FrArbState {
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

// ─── FR calculation ───────────────────────────────────────────────────────────

function calcFrAccumulated(entryFr: number | null, entryAt: string | null): number {
  if (entryFr === null || entryAt === null) return 0;
  const elapsedMs = Date.now() - new Date(entryAt).getTime();
  const elapsedHours = elapsedMs / (1000 * 60 * 60);
  return entryFr * elapsedHours;
}

// ─── Telegram notification templates ─────────────────────────────────────────

function buildEntryNotif(
  strategyName: string,
  state: FrArbState,
  config: FrArbConfig,
  currentFr: number
): string {
  const sideEmoji = state.positionSide === "long" ? "🟢" : "🔴";
  const frPct = (currentFr * 100).toFixed(4);
  const entryPriceStr = state.entryPrice != null ? `$${state.entryPrice.toFixed(4)}` : "N/A";
  const slLine = config.stopLoss != null
    ? `\n🛑 Stop Loss: \`$${config.stopLoss.toFixed(4)}\``
    : "";
  return (
    `📥 *FR ARB ENTRY* · ⚡ Lighter\n\n` +
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
  state: FrArbState,
  closePrice: number,
  exitReason: string
): string {
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
    `📤 *FR ARB EXIT* · ⚡ Lighter\n\n` +
    `📌 *${strategyName}*\n` +
    `❓ Reason: \`${exitReason}\`\n\n` +
    `📈 Entry: \`${entryPriceStr}\`\n` +
    `📉 Close: \`${closePriceStr}\`\n` +
    `💹 PnL: \`${pnlStr} USDC\`\n` +
    `💰 FR Collected (est.): \`${frPct}%\``
  );
}

// ─── Lighter: fetch FR ────────────────────────────────────────────────────────
// Endpoint: GET /api/v1/funding-rates (docs: reference/funding-rates.md)
// LIG-FRARB-RATE-001: API sudah mengembalikan rate per-jam.
// Server Lighter hitung: fundingRate = clamp(premium, -BigClamp, +BigClamp) / 8.
// "BigClamp = 4% per 8h, or 0.5% per hour" → 0.5% adalah nilai max yang dikembalikan.
// JANGAN bagi 8 lagi di sini.

async function getLighterFr(marketIndex: number, network: Network): Promise<number | null> {
  try {
    const resp = await getFundingRates(network);
    const entry = (resp.funding_rates ?? []).find(
      (r) => r.exchange === "lighter" && r.market_id === marketIndex
    );
    if (entry == null) return null;
    // Rate sudah per-jam — tidak perlu konversi tambahan
    return entry.rate;
  } catch {
    return null;
  }
}

// ─── Lighter: fetch mid price dari order book ─────────────────────────────────

async function getLighterMidPrice(marketIndex: number, network: Network): Promise<Decimal | null> {
  try {
    const depth = await getOrderBookDepth(marketIndex, network);
    const bestBid = depth.bids[0]?.price;
    const bestAsk = depth.asks[0]?.price;
    if (!bestBid || !bestAsk) return null;
    const bid = new Decimal(bestBid);
    const ask = new Decimal(bestAsk);
    return bid.add(ask).div(2);
  } catch {
    return null;
  }
}

// ─── Lighter: place order ─────────────────────────────────────────────────────

interface LighterFrOrderResult {
  txHash: string;
  estimatedFillPrice: number;
  qty: string;
}

async function placeLighterFrOrder(
  userId: number,
  strategyId: number,
  strategyName: string,
  marketIndex: number,
  side: "long" | "short",
  positionSizeUsdc: number,
  orderType: FrArbConfig["orderType"],
  limitPriceOffset: number | undefined,
  reduceOnly: boolean,
  currentPrice: Decimal,
  network: Network,
  forceQty?: string
): Promise<LighterFrOrderResult | null> {
  const botConfig = await getBotConfig(userId).catch(() => null);
  if (!botConfig?.privateKey || botConfig.accountIndex == null || botConfig.apiKeyIndex == null) {
    await frLog(userId, strategyId, strategyName, "error",
      "[LighterFrArb] Kredensial Lighter tidak lengkap (privateKey/accountIndex/apiKeyIndex)");
    return null;
  }

  const { accountIndex, apiKeyIndex, privateKey } = botConfig;

  // Ambil market info untuk sizeDecimals dan priceDecimals
  const markets = await getMarkets(network).catch(() => null);
  const market = markets?.find((m) => m.index === marketIndex);
  if (!market) {
    await frLog(userId, strategyId, strategyName, "error",
      `[LighterFrArb] Market tidak ditemukan: index ${marketIndex}`);
    return null;
  }

  const { sizeDecimals, priceDecimals } = market;

  // Hitung qty
  const qtyDecimal = forceQty
    ? new Decimal(forceQty)
    : new Decimal(positionSizeUsdc).div(currentPrice)
        .toDecimalPlaces(sizeDecimals, Decimal.ROUND_DOWN);

  if (qtyDecimal.lte(0)) {
    await frLog(userId, strategyId, strategyName, "error",
      "[LighterFrArb] Qty kalkulasi <= 0, order dibatalkan");
    return null;
  }

  const qtyStr = qtyDecimal.toFixed(sizeDecimals);
  const baseAmount = toBaseAmount(qtyDecimal.toNumber(), sizeDecimals);

  const isAsk = side === "short"; // long = buy = bid = isAsk false; short = sell = ask = isAsk true

  // Hitung execution price dan order type fields
  let executionPrice: Decimal;
  let lighterOrderType: number;
  let lighterTimeInForce: number;
  let lighterOrderExpiry: number;

  if (orderType === "market") {
    // Market order: IOC dengan slippage buffer
    const slippageFactor = side === "long" ? 1.005 : 0.995;
    executionPrice = currentPrice.mul(new Decimal(slippageFactor));
    lighterOrderType = 1;  // MarketOrder
    lighterTimeInForce = 0; // ImmediateOrCancel
    lighterOrderExpiry = 0; // NilOrderExpiry — tidak dibutuhkan untuk IOC
  } else {
    // Limit atau post_only
    const offsetPct = limitPriceOffset ?? 0.1;
    const offset = currentPrice.mul(new Decimal(offsetPct)).div(100);
    executionPrice = side === "long"
      ? currentPrice.sub(offset)
      : currentPrice.add(offset);
    lighterOrderType = 0;  // LimitOrder
    lighterTimeInForce = orderType === "post_only" ? 2 : 1; // 2=PostOnly, 1=GoodTillTime
    lighterOrderExpiry = -1; // DEFAULT_28_DAY_ORDER_EXPIRY
  }

  const priceInt = toPriceInt(executionPrice.toNumber(), priceDecimals);
  const url = getBaseUrl(network);

  // AUDIT-NONCE-001: Pakai acquireNonce (chain bersama dengan lighterBotEngine)
  // bukan getNextNonce langsung, agar tidak terjadi nonce collision jika user
  // menjalankan grid bot + FR Arb bot bersamaan pada accountIndex+apiKeyIndex yang sama.
  let nonce: number;
  try {
    nonce = await acquireNonce(accountIndex, apiKeyIndex, network);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await frLog(userId, strategyId, strategyName, "error",
      "[LighterFrArb] Gagal acquire nonce", msg);
    return null;
  }

  // Init signer setelah nonce acquired — atomic di JS event loop
  try {
    initSigner(url, privateKey, apiKeyIndex, accountIndex);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await frLog(userId, strategyId, strategyName, "error",
      "[LighterFrArb] Gagal init signer", msg);
    return null;
  }

  // AUDIT-COI-001: Pakai nextClientOrderIndex() (atomic counter bersama nonceManager)
  // bukan Date.now() % UINT48_MAX agar tidak ada potensi duplikat clientOrderIndex
  // lintas engine jika dua bot aktif bersamaan pada millisecond yang sama.
  const clientOrderIndex = nextClientOrderIndex();
  const signResult = signCreateOrder({
    marketIndex,
    clientOrderIndex,
    baseAmount,
    price: priceInt,
    isAsk,
    orderType: lighterOrderType,
    timeInForce: lighterTimeInForce,
    reduceOnly,
    triggerPrice: 0,
    orderExpiry: lighterOrderExpiry,
    nonce,
    apiKeyIndex,
    accountIndex,
  });

  if (signResult.err) {
    await frLog(userId, strategyId, strategyName, "error",
      `[LighterFrArb] Sign order gagal: ${signResult.err}`);
    return null;
  }

  // Kirim ke exchange
  let sendResult: Awaited<ReturnType<typeof sendTx>>;
  try {
    sendResult = await sendTx(signResult.txType, signResult.txInfo, network, true);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Invalidate nonce cache on sendTx failure agar nonce berikutnya di-fetch ulang dari API.
    // Nonce yang sudah di-acquire tapi gagal terkirim bisa menyebabkan nonce gap jika tidak
    // di-invalidasi — sequencer akan reject order berikutnya karena nonce tidak sequential.
    if (shouldInvalidateNonce(err)) {
      invalidateNonceCache(accountIndex, apiKeyIndex, network);
    }
    await frLog(userId, strategyId, strategyName, "error",
      `[LighterFrArb] sendTx gagal: ${msg}`,
      `side: ${side} | qty: ${qtyStr} | price: ${executionPrice.toFixed(priceDecimals)}`);
    return null;
  }

  // Pakai hash dari Lighter response (lebih akurat dari signer hash)
  const txHash = sendResult.tx_hash ?? signResult.txHash;

  await frLog(userId, strategyId, strategyName, "success",
    `[LighterFrArb] ${side.toUpperCase()} order dikirim`,
    `txHash: ${txHash} | qty: ${qtyStr} | price: ${executionPrice.toFixed(priceDecimals)}`);

  return {
    txHash,
    estimatedFillPrice: executionPrice.toNumber(),
    qty: qtyStr,
  };
}

// ─── Poll pending entry ────────────────────────────────────────────────────────
// Lighter tx status (docs: data-structures-constants-and-errors.md):
//   0 = Failed/Cancelled
//   1 = Queued (pending)
//   2 = Executed (filled)
//   3 = Committed to L2 (treated as filled — L1 proof pending)

interface PendingEntryResult {
  status: "filled" | "pending" | "terminated";
  estimatedFillPrice: number;
}

// AUDIT-FILL-001: Parse fill price dari event_info jika tersedia.
// Lighter API mengembalikan event_info sebagai JSON string (format: CreateOrderExecution)
// yang berisi avgPrice (harga fill aktual). Format referensi dari docs:
// data-structures-constants-and-errors.md → CreateOrderExecution struct.
// Jika event_info tidak bisa di-parse, fallback ke mid-price saat poll (fallbackPrice).
function parseFillPriceFromEventInfo(eventInfo: string | undefined, fallback: number): number {
  if (!eventInfo) return fallback;
  try {
    const parsed = JSON.parse(eventInfo) as Record<string, unknown>;
    // Field bisa berupa "avgPrice", "avg_price", atau "price" tergantung versi API Lighter.
    // Coba semua kemungkinan key secara defensif.
    const raw =
      parsed["avgPrice"] ??
      parsed["avg_price"] ??
      parsed["price"] ??
      parsed["fill_price"];
    if (raw === undefined || raw === null) return fallback;
    const val = Number(raw);
    return isFinite(val) && val > 0 ? val : fallback;
  } catch {
    return fallback;
  }
}

async function pollLighterPendingEntry(
  txHash: string,
  fallbackPrice: number,
  network: Network
): Promise<PendingEntryResult> {
  const txResp = await getTx("hash", txHash, network).catch(() => null);
  if (!txResp) {
    return { status: "pending", estimatedFillPrice: fallbackPrice };
  }

  const txStatus = txResp.status;

  if (txStatus === 2 || txStatus === 3) {
    // Executed atau Committed — fill terkonfirmasi.
    // AUDIT-FILL-001: Ekstrak fill price aktual dari event_info jika ada,
    // bukan selalu pakai mid-price saat poll (fallbackPrice) yang bisa berbeda
    // signifikan dari harga fill sebenarnya untuk order market / large limit order.
    const fillPrice = parseFillPriceFromEventInfo(txResp.event_info, fallbackPrice);
    return { status: "filled", estimatedFillPrice: fillPrice };
  }

  if (txStatus === 0) {
    // Failed/Cancelled
    return { status: "terminated", estimatedFillPrice: fallbackPrice };
  }

  // txStatus === 1 (Queued) atau null → masih pending
  return { status: "pending", estimatedFillPrice: fallbackPrice };
}

// ─── Main tick function ───────────────────────────────────────────────────────

async function tickLighterFrArb(strategyId: number): Promise<void> {
  if (tickingLighterFrArbBots.has(strategyId)) {
    logger.warn({ strategyId }, "[LighterFrArb] Tick masih berjalan, skip (concurrent guard)");
    return;
  }
  tickingLighterFrArbBots.add(strategyId);

  try {
    const strategy = await db.query.strategiesTable.findFirst({
      where: eq(strategiesTable.id, strategyId),
    });

    if (!strategy) {
      logger.warn({ strategyId }, "[LighterFrArb] Strategy tidak ditemukan, skip tick");
      return;
    }

    if (!strategy.isRunning) {
      logger.info({ strategyId }, "[LighterFrArb] Strategy tidak running, skip tick");
      return;
    }

    const config = strategy.frArbConfig as FrArbConfig | null;
    if (!config) {
      logger.warn({ strategyId }, "[LighterFrArb] frArbConfig kosong, skip tick");
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
    const marketIndex = strategy.marketIndex;
    const botConfig = userId != null ? await getBotConfig(userId).catch(() => null) : null;
    const network: Network = (botConfig?.network as Network | null) ?? "mainnet";

    logger.info({ strategyId, marketIndex, isInPosition: state.isInPosition }, "[LighterFrArb] Tick start");

    // ── 1.5: Poll pending entry ─────────────────────────────────────────────

    if (state.pendingEntryDigest && !state.isInPosition) {
      const pendingHash = state.pendingEntryDigest;

      const midPrice = await getLighterMidPrice(marketIndex, network);
      const fallbackPrice = midPrice?.toNumber() ?? state.entryPrice ?? 0;

      const pollResult = await pollLighterPendingEntry(pendingHash, fallbackPrice, network);

      if (pollResult.status === "filled") {
        const positionSide: "long" | "short" =
          state.positionSide ??
          (state.pendingEntrySide === "buy" ? "long" : state.pendingEntrySide === "sell" ? "short" : "long");

        const confirmedState: FrArbState = {
          isInPosition: true,
          positionSide,
          entryPrice: pollResult.estimatedFillPrice,
          entryFr: state.entryFr,
          entryAt: state.entryAt,
          openOrderId: pendingHash,
          openQty: state.openQty,
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

        const entryMsg = buildEntryNotif(strategy.name, confirmedState, config, state.entryFr ?? 0);
        await frNotify(userId ?? null, entryMsg);
        await frLog(userId ?? null, strategyId, strategy.name, "success",
          `[LighterFrArb] Entry TERKONFIRMASI filled — posisi ${positionSide.toUpperCase()} aktif`,
          `txHash: ${pendingHash} | Price: $${pollResult.estimatedFillPrice.toFixed(4)}`);

      } else if (pollResult.status === "terminated") {
        await db.update(strategiesTable)
          .set({ frArbState: resetFrState(), updatedAt: new Date() })
          .where(eq(strategiesTable.id, strategyId));
        await frLog(userId ?? null, strategyId, strategy.name, "warn",
          "[LighterFrArb] Entry order dibatalkan/ditolak exchange — kembali idle",
          `txHash: ${pendingHash}`);
      } else {
        await saveFrState(strategyId, { lastCheckedAt: new Date().toISOString() });
        await frLog(userId ?? null, strategyId, strategy.name, "info",
          "[LighterFrArb] Entry order masih pending, belum terisi — menunggu tick berikutnya",
          `txHash: ${pendingHash}`);
      }

      return; // tick berikutnya handle lanjutan
    }

    // ── 1. Fetch current FR ────────────────────────────────────────────────────

    const currentFr = await getLighterFr(marketIndex, network);

    if (currentFr === null) {
      logger.warn({ strategyId, marketIndex }, "[LighterFrArb] Gagal fetch FR, skip tick");
      await saveFrState(strategyId, { lastCheckedAt: new Date().toISOString() });
      return;
    }

    const absFr = Math.abs(currentFr);
    logger.info({ strategyId, currentFr, absFr, isInPosition: state.isInPosition }, "[LighterFrArb] FR fetched");

    // ── 2. NOT in position — check entry ─────────────────────────────────────

    if (!state.isInPosition) {
      await saveFrState(strategyId, { lastCheckedAt: new Date().toISOString() });

      if (absFr < config.entryFrThreshold) {
        logger.info({ strategyId, absFr, threshold: config.entryFrThreshold }, "[LighterFrArb] FR di bawah threshold, idle");
        return;
      }

      // Tentukan side
      let side: "long" | "short";
      if (config.side === "auto") {
        side = currentFr > 0 ? "short" : "long";
      } else {
        side = config.side;
      }

      logger.info({ strategyId, side, currentFr }, "[LighterFrArb] FR >= threshold — buka posisi");

      if (stoppingLighterFrArbBots.has(strategyId)) {
        logger.info({ strategyId }, "[LighterFrArb] Bot dihentikan saat tick, abort entry");
        return;
      }

      const currentPrice = await getLighterMidPrice(marketIndex, network);
      if (!currentPrice) {
        logger.warn({ strategyId }, "[LighterFrArb] Gagal fetch harga, skip entry");
        return;
      }

      const result = await placeLighterFrOrder(
        userId!, strategyId, strategy.name,
        marketIndex, side,
        config.positionSize, config.orderType, config.limitPriceOffset,
        false, currentPrice, network
      );

      if (result === null) {
        logger.warn({ strategyId }, "[LighterFrArb] Order entry gagal, state tidak diubah");
        return;
      }

      // Simpan sebagai pending — isInPosition diset true setelah fill dikonfirmasi (section 1.5)
      const pendingState: FrArbState = {
        isInPosition: false,
        positionSide: side,
        entryPrice: null,
        entryFr: currentFr,
        entryAt: new Date().toISOString(),
        openOrderId: null,
        openQty: result.qty,
        closeOrderId: null,
        frAccumulated: 0,
        lastCheckedAt: new Date().toISOString(),
        closeAttemptedAt: null,
        pendingEntryDigest: result.txHash,
        pendingEntrySide: side === "long" ? "buy" : "sell",
        pendingCloseDigest: null,
      };

      await db.update(strategiesTable)
        .set({ frArbState: pendingState, updatedAt: new Date() })
        .where(eq(strategiesTable.id, strategyId));

      await frLog(userId ?? null, strategyId, strategy.name, "info",
        `[LighterFrArb] Entry order DIKIRIM — menunggu konfirmasi fill di tick berikutnya`,
        `txHash: ${result.txHash} | side: ${side} | FR: ${(currentFr * 100).toFixed(4)}%/h`);

      return;
    }

    // ── 3. IN position — check exit conditions ────────────────────────────────

    const elapsedMs = state.entryAt ? (Date.now() - new Date(state.entryAt).getTime()) : 0;
    const elapsedHours = elapsedMs / (1000 * 60 * 60);
    const frAccumulated = calcFrAccumulated(state.entryFr, state.entryAt);

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
        const currentPriceForSL = await getLighterMidPrice(marketIndex, network);
        if (currentPriceForSL !== null) {
          const sl = config.stopLoss;
          const cp = currentPriceForSL.toNumber();
          if (state.positionSide === "long" && cp <= sl) {
            exitFlag = true;
            exitReason = `Stop loss hit @ $${cp.toFixed(4)}`;
          } else if (state.positionSide === "short" && cp >= sl) {
            exitFlag = true;
            exitReason = `Stop loss hit @ $${cp.toFixed(4)}`;
          }
        }
      }
    }

    if (!exitFlag) {
      await saveFrState(strategyId, {
        frAccumulated,
        lastCheckedAt: new Date().toISOString(),
      });
      logger.info({ strategyId, frAccumulated, elapsedHours }, "[LighterFrArb] In position, idle tick");
      return;
    }

    // ── 4. EXIT ───────────────────────────────────────────────────────────────

    logger.info({ strategyId, exitReason }, "[LighterFrArb] Exit condition met — tutup posisi");

    if (stoppingLighterFrArbBots.has(strategyId)) {
      logger.info({ strategyId }, "[LighterFrArb] Bot dihentikan saat tick, abort exit — posisi TETAP TERBUKA");
      await frNotify(userId ?? null,
        `⚠️ *FR ARB — EXIT DIBATALKAN*\n📌 *${strategy.name}*\n🛑 Bot dihentikan tepat saat akan close posisi.\nClose posisi manual diperlukan!`);
      return;
    }

    const closeSide: "long" | "short" = state.positionSide === "long" ? "short" : "long";
    const closeForceQty = state.openQty ?? undefined;

    const currentPrice = await getLighterMidPrice(marketIndex, network);
    if (!currentPrice) {
      logger.error({ strategyId }, "[LighterFrArb] Gagal fetch harga untuk close — posisi TETAP TERBUKA");
      await frLog(userId ?? null, strategyId, strategy.name, "error",
        "[LighterFrArb] KRITIS: Gagal fetch harga Lighter untuk close posisi", exitReason);
      await saveFrState(strategyId, { closeAttemptedAt: new Date().toISOString() });
      await frNotify(userId ?? null,
        `🚨 *FR ARB — CLOSE GAGAL*\n📌 *${strategy.name}*\n❌ Gagal fetch harga untuk close posisi.\n🔄 Bot akan retry otomatis di tick berikutnya (±15 menit).`);
      return;
    }

    const closeResult = await placeLighterFrOrder(
      userId!, strategyId, strategy.name,
      marketIndex, closeSide,
      config.positionSize, "market", undefined,
      true, currentPrice, network, closeForceQty
    );

    if (!closeResult) {
      logger.error({ strategyId, exitReason }, "[LighterFrArb] Close order gagal — posisi TETAP TERBUKA");
      await saveFrState(strategyId, { closeAttemptedAt: new Date().toISOString() });
      await frNotify(userId ?? null,
        `🚨 *FR ARB — CLOSE GAGAL*\n📌 *${strategy.name}*\n❌ Close order gagal.\n🔄 Bot akan retry otomatis di tick berikutnya (±15 menit).\nAlasan: ${exitReason}`);
      return;
    }

    // ── 5. Update state → EXIT ────────────────────────────────────────────────

    const finalState = resetFrState();
    finalState.closeOrderId = closeResult.txHash;
    finalState.frAccumulated = frAccumulated;

    await db.update(strategiesTable)
      .set({ frArbState: finalState, updatedAt: new Date() })
      .where(eq(strategiesTable.id, strategyId));

    const exitMsg = buildExitNotif(strategy.name, state, closeResult.estimatedFillPrice, exitReason);
    await frNotify(userId ?? null, exitMsg);
    await frLog(userId ?? null, strategyId, strategy.name, "success",
      `[LighterFrArb] Exit ${closeSide.toUpperCase()} @ $${closeResult.estimatedFillPrice.toFixed(4)}`,
      `Reason: ${exitReason} | FR collected: ${(frAccumulated * 100).toFixed(4)}%`);

    logger.info({ strategyId, exitReason, closePrice: closeResult.estimatedFillPrice }, "[LighterFrArb] Tick selesai — posisi ditutup");

  } finally {
    tickingLighterFrArbBots.delete(strategyId);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function startLighterFrArbBot(strategyId: number): boolean {
  if (runningLighterFrArbBots.has(strategyId)) {
    logger.warn({ strategyId }, "[LighterFrArb] Bot sudah running, skip start");
    return false;
  }

  stoppingLighterFrArbBots.delete(strategyId);
  tickingLighterFrArbBots.delete(strategyId);

  // Tick pertama langsung
  tickLighterFrArb(strategyId).catch((err) => {
    logger.error({ strategyId, err: err?.message }, "[LighterFrArb] Tick pertama error");
  });

  const interval = setInterval(() => {
    tickLighterFrArb(strategyId).catch((err) => {
      logger.error({ strategyId, err: err?.message }, "[LighterFrArb] Tick error");
    });
  }, LIGHTER_FR_ARB_INTERVAL_MS);

  runningLighterFrArbBots.set(strategyId, interval);
  logger.info({ strategyId }, "[LighterFrArb] Bot started — interval 15 menit");
  return true;
}

export function stopLighterFrArbBot(strategyId: number): boolean {
  const interval = runningLighterFrArbBots.get(strategyId);
  if (!interval) return false;

  stoppingLighterFrArbBots.add(strategyId);
  clearInterval(interval);
  runningLighterFrArbBots.delete(strategyId);
  // Bersihkan flag setelah 60 detik — cukup untuk tick yang sedang berjalan selesai
  setTimeout(() => stoppingLighterFrArbBots.delete(strategyId), 60_000);
  logger.info({ strategyId }, "[LighterFrArb] Bot stopped");
  return true;
}

export async function notifyLighterFrArbStopWhileInPosition(
  userId: number,
  strategyName: string,
  state: FrArbState
): Promise<void> {
  const sideLabel = state.positionSide?.toUpperCase() ?? "?";
  const entryPriceStr = state.entryPrice != null ? `$${state.entryPrice.toFixed(4)}` : "N/A";
  const msg =
    `⚠️ *FR ARB BOT DIHENTIKAN — POSISI AKTIF* · ⚡ Lighter\n\n` +
    `📌 *${strategyName}*\n` +
    `🔴 Side: *${sideLabel}*\n` +
    `💰 Entry Price: \`${entryPriceStr}\`\n\n` +
    `🚨 Bot dihentikan saat posisi masih terbuka.\n` +
    `Close posisi manual di exchange diperlukan!`;
  await frNotify(userId, msg);
}

export async function restoreRunningLighterFrArbBots(): Promise<void> {
  try {
    const running = await db.query.strategiesTable.findMany({
      where: eq(strategiesTable.isRunning, true),
    });

    const lighterFrArb = running.filter(
      (s) => s.type === "funding_arb" && s.exchange === "lighter"
    );

    for (const s of lighterFrArb) {
      if (!runningLighterFrArbBots.has(s.id)) {
        logger.info({ strategyId: s.id }, "[LighterFrArb] Restore bot pasca restart");
        startLighterFrArbBot(s.id);
      }
    }
  } catch (err) {
    logger.error({ err }, "[LighterFrArb] restoreRunningLighterFrArbBots error");
  }
}
