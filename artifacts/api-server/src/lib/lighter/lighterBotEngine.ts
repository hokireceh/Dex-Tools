import { db } from "@workspace/db";
import { strategiesTable, tradesTable, botLogsTable, usersTable, GridConfig } from "@workspace/db";
import { eq, desc, lt, sql, and, isNotNull, ne, gte, lte, inArray } from "drizzle-orm";
import Decimal from "decimal.js";
import { logger } from "../logger";
import { getBotConfig, getNotificationConfig } from "../../routes/configService";
import { getNextNonce, sendTx, sendTxBatch, toBaseAmount, toPriceInt, getTx, getBaseUrl, fetchAccountActiveOrders, getAccountByIndex, type Network } from "./lighterApi";
import { getMarketInfo, fetchLiveMarketInfo } from "./marketCache";
import { initSigner, signCreateOrder, signCancelOrder } from "./lighterSigner";
import { sendMessageToUser, formatBotStarted, formatBotStopped, formatOrderFilled,
         formatOrderFailed, formatStopLoss, formatTakeProfit,
         formatBotPaused } from "../telegramBot";
import { registerPriceCallback, unregisterPriceCallback, getWsCachedPrice } from "./lighterWs";
import { handleAutoRerange, clearRerangeState, cancelPendingRerangeOnStop, sendMainBotMessageWithButton, PENDING_TIMEOUT_MS } from "../autoRerange";
import { getDuplicateTolerance } from "../shared/tolerance";
import { getExecModeMultiplier, computeSkewMultipliers, type SkewState, type FollowMarketState } from "../utils";
import { trackBudgetSpend } from "../budgetTracker";
import { computeReduceOnly, computeGridSide, isSlTriggered, isTpTriggered } from "../shared/botLogic";

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

// ─── LIGHTER FEE RATES ───────────────────────────────────────────────────────
// LIG-TAKER-FEE-001 FIX: Fee rates dari docs resmi (trading-fees.md, https://docs.lighter.xyz/trading/trading-fees)
// Standard Account = 0 maker / 0 taker. Premium Account (base, 0 LIT staked) = 0.004% maker / 0.028% taker.
// Gunakan Premium base rate sebagai worst-case conservative estimate untuk budget tracking.
// `order_kind` disimpan di DB → pollPendingTrades apply rate yang tepat per trade.
const LIGHTER_MAKER_FEE_RATE = 0.00004; // 0.004% — limit / post-only (Premium base)
const LIGHTER_TAKER_FEE_RATE = 0.00028; // 0.028% — market / IOC (Premium base)

// INFO-FEE-001 FIX: Cache account_type per accountIndex untuk menghindari extra API call setiap poll.
// TTL 10 menit — cukup untuk detect tier changes tanpa spam API.
// account_type: 0 = Standard (fee 0%), 1+ = Premium (fee berlaku).
// Sumber: LighterAccountEntry.account_type dari /api/v1/account endpoint.
const ACCOUNT_TYPE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 menit
const _accountTypeCache = new Map<number, { type: number; fetchedAt: number }>();

async function getCachedAccountType(accountIndex: number, network: Network): Promise<number> {
  const cached = _accountTypeCache.get(accountIndex);
  if (cached && Date.now() - cached.fetchedAt < ACCOUNT_TYPE_CACHE_TTL_MS) {
    return cached.type;
  }
  try {
    const resp = await getAccountByIndex(accountIndex, network);
    const entry = resp?.accounts?.[0];
    const type = entry?.account_type ?? 1; // default ke Premium (conservative) jika tidak diketahui
    _accountTypeCache.set(accountIndex, { type, fetchedAt: Date.now() });
    return type;
  } catch {
    // Gagal fetch → default ke Premium (conservative — tidak salah undercharge)
    return 1;
  }
}

// ─── ATOMIC CLIENT ORDER INDEX COUNTER ──────────────────────────────────────
// uint48 max = 2^48 - 1 = 281,474,976,710,655
// Seed from current time so it survives restarts without collision,
// then increment atomically — never use Date.now() directly to avoid
// same-millisecond duplicates when multiple bots run concurrently.
const UINT48_MAX = BigInt(281_474_976_710_655);
let _clientOrderCounter = BigInt(Date.now() % Number(UINT48_MAX));

function nextClientOrderIndex(): number {
  _clientOrderCounter = (_clientOrderCounter + 1n) % (UINT48_MAX + 1n);
  return Number(_clientOrderCounter);
}

// ─── PER-KEY NONCE MANAGER (BUG-L-003) ──────────────────────────────────────
// Prevents nonce race conditions when concurrent bots share the same API key.
// Guarantees serial nonce acquisition per (network:accountIndex:apiKeyIndex) key.
// Concurrent calls chain onto each other — only one fetches from API at a time.
const _nonceChain = new Map<string, Promise<number>>();
const _nonceValue = new Map<string, number>();
const _nonceVersion = new Map<string, number>();

// ORPHAN-CANCEL-SEQ-001: Global serial chain untuk orphan cancel per account+apikey.
// Lighter exchange mewajibkan new_nonce = old_nonce + 1 (docs: signing-transactions.md).
// Karena strategy yang berbeda bisa share apiKeyIndex yang sama, nonce allocation yang
// sudah serial via acquireNonce belum cukup — sendTx dari dua strategy bisa tetap
// interleave dan tiba out-of-order di sequencer.
// Chain ini memastikan acquire+send tiap orphan cancel adalah atomic: strategy berikutnya
// baru bisa mulai setelah strategy sebelumnya selesai kirim ke exchange.
const _orphanCancelChain = new Map<string, Promise<void>>();

function enqueueOrphanCancel(
  accountIndex: number,
  apiKeyIndex: number,
  network: Network,
  task: () => Promise<void>
): Promise<void> {
  const key = `${network}:${accountIndex}:${apiKeyIndex}`;
  const prev = _orphanCancelChain.get(key) ?? Promise.resolve();
  const next = prev.then(task, task); // lanjut meski prev gagal, tiap task punya error handler sendiri
  _orphanCancelChain.set(key, next);
  return next;
}

async function acquireNonce(
  accountIndex: number,
  apiKeyIndex: number,
  network: Network,
  count: number = 1
): Promise<number> {
  const key = `${network}:${accountIndex}:${apiKeyIndex}`;
  const myVersion = _nonceVersion.get(key) ?? 0;
  const prevChain = _nonceChain.get(key) ?? Promise.resolve(0);

  const nextChain: Promise<number> = prevChain.then(
    async () => {
      const cached = _nonceValue.get(key);
      if (cached !== undefined) {
        _nonceValue.set(key, cached + count);
        return cached;
      }
      const nonce = await getNextNonce(accountIndex, apiKeyIndex, network);
      // Only write to cache if not invalidated while this fetch was in-flight
      if ((_nonceVersion.get(key) ?? 0) === myVersion) {
        _nonceValue.set(key, nonce + count);
      }
      return nonce;
    },
    async () => {
      // Previous acquisition failed — re-fetch fresh nonce from API
      const nonce = await getNextNonce(accountIndex, apiKeyIndex, network);
      if ((_nonceVersion.get(key) ?? 0) === myVersion) {
        _nonceValue.set(key, nonce + count);
      }
      return nonce;
    }
  );

  _nonceChain.set(key, nextChain);
  return nextChain;
}

function invalidateNonceCache(accountIndex: number, apiKeyIndex: number, network: Network): void {
  const key = `${network}:${accountIndex}:${apiKeyIndex}`;
  // NONCE-RACE-001 FIX: Jangan hapus _nonceChain saat invalidasi.
  // Sebelumnya: _nonceChain.delete(key) → caller baru mulai dari Promise.resolve(0), TIDAK menunggu
  // in-flight promise yang sedang memanggil getNextNonce. Kedua caller (in-flight lama + baru) bisa
  // memanggil getNextNonce secara concurrent dan mendapat nonce yang sama → collision di sequencer.
  //
  // Fix: hapus hanya cached VALUE (_nonceValue), biarkan chain tetap ada.
  // Caller baru akan chain setelah in-flight promise selesai (bukan dari Promise.resolve(0)).
  // Setelah in-flight selesai: cache sudah didelete dan version-nya berbeda → caller baru
  // masuk ke success/error handler dan memanggil getNextNonce dengan benar setelah in-flight selesai.
  // Version bump tetap diperlukan untuk mencegah in-flight lama menulis nonce stale ke cache.
  _nonceValue.delete(key);
  _nonceVersion.set(key, (_nonceVersion.get(key) ?? 0) + 1);
}

function shouldInvalidateNonce(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    (err instanceof Error && err.name === "AbortError") ||
    msg.includes("timeout") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("ENOTFOUND") ||
    msg.toLowerCase().includes("nonce") ||
    msg.includes("HTTP 400")
  );
}

// MARGIN-LOOP-001 FIX: Deteksi apakah order dibatalkan sequencer karena alasan margin.
// Sumber: docs data-structures-constants-and-errors.md — Order Status constants & OrderExecution struct.
//
// Order Status codes yang relevan (dari constants.go di lighter-go SDK):
//   CanceledOrder_MarginNotAllowed   = 8
//   CanceledOrder_InvalidBalance     = 16
//
// Lighter mengisi `event_info` (JSON string) di tx response dengan OrderExecution struct:
//   { m: marketId, mo: Order (maker), to: Order (taker), ae: AppError, t: Trade }
// Field `st` pada Order (mo/to) = Order Status code.
// Field `ae` pada OrderExecution atau CancelOrder = AppError string (error text dari sequencer).
//
// Jika margin-related: skip replay queue — re-placing order yang sama akan ditolak lagi
// (infinite loop yang menguras rate limit: 4000 req/menit untuk Premium account per docs rate-limits.md).
function isMarginRelatedCancel(eventInfo: string | undefined): boolean {
  if (!eventInfo) return false;
  try {
    const parsed = JSON.parse(eventInfo) as Record<string, unknown>;
    // AppError field di top level (OrderExecution.ae atau CancelOrder.ae)
    const ae = typeof parsed.ae === "string" ? parsed.ae.toLowerCase() : "";
    if (ae.includes("margin") || ae.includes("balance") || ae.includes("collateral") || ae.includes("liquidat")) {
      return true;
    }
    // Order Status dari maker order (mo) atau taker order (to)
    // st=8 = CanceledOrder_MarginNotAllowed, st=16 = CanceledOrder_InvalidBalance
    const makerSt = (parsed.mo as Record<string, unknown> | undefined)?.st;
    const takerSt = (parsed.to as Record<string, unknown> | undefined)?.st;
    if (makerSt === 8 || makerSt === 16 || takerSt === 8 || takerSt === 16) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

interface RunningBot {
  strategyId: number;
  timer: NodeJS.Timeout;
  nextRunAt: Date;
  // startedAt direkam saat bot pertama kali distart — dipakai getSessionStartedAt (routes/config.ts).
  startedAt: Date;
}

interface GridState {
  lastLevel: number;
  initializedAt: Date;
}

const runningBots = new Map<number, RunningBot>();
const gridStates = new Map<number, GridState>();
const lighterSkewStates = new Map<number, SkewState>();
const lighterFollowMarketStates = new Map<number, FollowMarketState>();
const startingBots = new Set<number>();
const stoppingBots = new Set<number>();
const stopVersions = new Map<number, number>();

// Minimum ms between WS-triggered grid checks per strategy (avoids rapid-fire on volatile ticks)
const WS_GRID_COOLDOWN_MS = 10_000;
// strategyId → timestamp of last WS-triggered run
const wsGridLastTriggered = new Map<number, number>();

// Fallback interval for grid bots (WS is primary; this catches any WS gaps)
const GRID_FALLBACK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// LIGHTER-GAP-002: Interval sinkronisasi order book DB vs exchange
const ORDER_SYNC_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

// LIGHTER-GAP-001: Queue cancelled/timed-out grid orders for re-placement
interface ReplayEntry {
  side: "buy" | "sell";
  originalPrice: Decimal;
  cancelledAt: Date;
  tradeId: number;
}
const cancelledOrderReplays = new Map<number, ReplayEntry[]>();
const REPLAY_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
// AUDIT-L-007: Delay antar order di replay burst untuk menghindari 429 rate limit.
// Lighter menolak lebih dari ~5-10 tx/detik dari satu account.
// 300ms = ~3 order/detik → aman untuk semua kondisi (termasuk restart dengan 15+ replay entries).
const REPLAY_ORDER_DELAY_MS = 300;

export function isRunning(strategyId: number): boolean {
  return runningBots.has(strategyId);
}

export function getNextRunAt(strategyId: number): Date | null {
  return runningBots.get(strategyId)?.nextRunAt ?? null;
}

export function getAllRunningBots(): { strategyId: number; nextRunAt: Date }[] {
  return Array.from(runningBots.entries()).map(([id, bot]) => ({
    strategyId: id,
    nextRunAt: bot.nextRunAt,
  }));
}

// STRAT-SESSION-ORDERS-SERIALIZER-001: expose session startedAt agar routes/config.ts bisa serialisasi.
export function getSessionStartedAt(strategyId: number): Date | null {
  return runningBots.get(strategyId)?.startedAt ?? null;
}

async function notifyUser(userId: number | null, message: string): Promise<void> {
  if (userId === null || userId === undefined) return;
  try {
    const config = await getBotConfig(userId);
    if (!config.notifyBotToken || !config.notifyChatId) return;
    const result = await sendMessageToUser(config.notifyChatId, message, config.notifyBotToken);
    if (!result.ok) {
      // Log failure to DB so user can see it in the Logs tab
      await addLog(userId, null, null, "warn",
        `[Notifikasi Telegram gagal] ${result.error ?? "Unknown error"}`,
        `Pastikan: 1) Bot token benar, 2) Sudah kirim /start ke bot notifikasimu, 3) Chat ID benar`
      );
    }
  } catch (err: any) {
    logger.error({ err }, "[Notify] Unexpected error in notifyUser");
  }
}

async function addLog(
  userId: number | null,
  strategyId: number | null,
  strategyName: string | null,
  level: "info" | "warn" | "error" | "success",
  message: string,
  details?: string
) {
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
    logger.error({ err }, "Failed to add bot log");
  }
}

async function recordTrade(params: {
  userId: number | null;
  strategyId: number;
  strategyName: string;
  marketIndex: number;
  marketSymbol: string;
  side: "buy" | "sell";
  size: Decimal;
  price: Decimal;
  status: "pending" | "filled" | "cancelled" | "failed";
  orderHash?: string;
  clientOrderIndex?: number;
  orderKind?: "market" | "limit" | "post_only";
  errorMessage?: string;
}) {
  try {
    await db.insert(tradesTable).values({
      userId: params.userId,
      strategyId: params.strategyId,
      strategyName: params.strategyName,
      marketIndex: params.marketIndex,
      marketSymbol: params.marketSymbol,
      side: params.side,
      size: params.size.toFixed(8),
      price: params.price.toFixed(8),
      fee: "0",
      status: params.status,
      orderHash: params.orderHash ?? null,
      clientOrderIndex: params.clientOrderIndex ?? null,
      orderKind: params.orderKind ?? null,
      errorMessage: params.errorMessage ?? null,
      executedAt: params.status === "filled" ? new Date() : null,
    });
  } catch (err) {
    logger.error({ err, strategyId: params.strategyId }, "[LighterBot] Gagal menyimpan trade ke DB — order mungkin sudah terkirim ke exchange");
    throw err;
  }
}

// ORPHAN-PREVENT-001: Pre-save pending trade to DB BEFORE sending to exchange.
// Returns the inserted trade ID so the caller can update it after exchange responds.
// If this insert fails, the caller must NOT send the order (throw propagates up).
async function preSavePendingTrade(params: {
  userId: number | null;
  strategyId: number;
  strategyName: string;
  marketIndex: number;
  marketSymbol: string;
  side: "buy" | "sell";
  size: Decimal;
  price: Decimal;
  clientOrderIndex: number;
  orderKind?: "market" | "limit" | "post_only";
}): Promise<number> {
  const [row] = await db.insert(tradesTable).values({
    userId: params.userId,
    strategyId: params.strategyId,
    strategyName: params.strategyName,
    marketIndex: params.marketIndex,
    marketSymbol: params.marketSymbol,
    side: params.side,
    size: params.size.toFixed(8),
    price: params.price.toFixed(8),
    fee: "0",
    status: "pending",
    orderHash: null,
    clientOrderIndex: params.clientOrderIndex,
    orderKind: params.orderKind ?? null,
    errorMessage: null,
    executedAt: null,
  }).returning({ id: tradesTable.id });
  return row.id;
}

async function updateStrategyStatsAtomic(
  strategyId: number,
  side: "buy" | "sell",
  size: Decimal,
  price: Decimal,
  mode: string = "neutral"
) {
  if (side === "buy") {
    await db.execute(sql`
      UPDATE strategies
      SET
        total_orders      = total_orders + 1,
        successful_orders = successful_orders + 1,
        last_run_at       = NOW(),
        updated_at        = NOW(),
        total_bought      = total_bought + ${size.toFixed(8)}::numeric,
        avg_buy_price     = CASE
          WHEN total_bought + ${size.toFixed(8)}::numeric = 0 THEN 0
          ELSE (avg_buy_price * total_bought + ${price.toFixed(8)}::numeric * ${size.toFixed(8)}::numeric)
               / (total_bought + ${size.toFixed(8)}::numeric)
        END,
        realized_pnl      = realized_pnl + CASE
          WHEN ${mode} = 'short' AND avg_sell_price > 0
          THEN (${size.toFixed(8)}::numeric * (avg_sell_price - ${price.toFixed(8)}::numeric))
          ELSE 0
        END
      WHERE id = ${strategyId}
    `);
  } else {
    await db.execute(sql`
      UPDATE strategies
      SET
        total_orders      = total_orders + 1,
        successful_orders = successful_orders + 1,
        last_run_at       = NOW(),
        updated_at        = NOW(),
        total_sold        = total_sold + ${size.toFixed(8)}::numeric,
        avg_sell_price    = CASE
          WHEN total_sold + ${size.toFixed(8)}::numeric = 0 THEN 0
          ELSE (avg_sell_price * total_sold + ${price.toFixed(8)}::numeric * ${size.toFixed(8)}::numeric)
               / (total_sold + ${size.toFixed(8)}::numeric)
        END,
        realized_pnl      = realized_pnl + CASE
          WHEN avg_buy_price > 0
          THEN (${size.toFixed(8)}::numeric * (${price.toFixed(8)}::numeric - avg_buy_price))
          ELSE 0
        END
      WHERE id = ${strategyId}
    `);
  }
}

async function getCurrentPrice(marketIndex: number, network: "mainnet" = "mainnet"): Promise<Decimal | null> {
  // Prefer WebSocket cache (real-time, < 5 s old)
  const cached = getWsCachedPrice(marketIndex, 5_000);
  if (cached) return cached;

  // Fallback to REST
  try {
    const marketInfo = await getMarketInfo(marketIndex, network);
    if (marketInfo && marketInfo.lastTradePrice > 0) {
      return new Decimal(marketInfo.lastTradePrice);
    }
    return null;
  } catch {
    return null;
  }
}

async function executeLiveOrder(params: {
  userId: number | null;
  strategy: typeof strategiesTable.$inferSelect;
  botConfig: Awaited<ReturnType<typeof getBotConfig>>;
  side: "buy" | "sell";
  size: Decimal;
  currentPrice: Decimal;
  network: "mainnet";
  orderKind?: "market" | "limit" | "post_only";
  limitPriceOffset?: number;
  _postOnlyRetryCount?: number;
}) {
  const { userId, strategy, botConfig, side, size, currentPrice, network } = params;
  const orderKind = params.orderKind ?? "market";
  const limitPriceOffset = params.limitPriceOffset ?? 0;
  const _postOnlyRetryCount = params._postOnlyRetryCount ?? 0;

  // L-003 FIX: Jika cache miss (termasuk saat fallback tidak cover market ini),
  // fetch langsung dari API live. Jika masih null → abort dengan error jelas,
  // bukan skip validasi minimum diam-diam.
  let marketInfo = await getMarketInfo(strategy.marketIndex, network);
  if (!marketInfo) {
    logger.warn(
      { strategyId: strategy.id, marketIndex: strategy.marketIndex },
      "[lighterBotEngine] getMarketInfo null — mencoba fetchLiveMarketInfo langsung dari API"
    );
    try {
      marketInfo = await fetchLiveMarketInfo(strategy.marketIndex, network);
    } catch (liveErr) {
      logger.error({ liveErr, strategyId: strategy.id }, "[lighterBotEngine] fetchLiveMarketInfo gagal");
    }
  }
  if (!marketInfo) {
    const msg = `Market index ${strategy.marketIndex} tidak ditemukan di Lighter — cek konfigurasi strategi`;
    await addLog(userId, strategy.id, strategy.name, "error", "Order dibatalkan: market info tidak tersedia", msg);
    return;
  }
  const sizeDecimals = marketInfo.sizeDecimals;
  const priceDecimals = marketInfo.priceDecimals;

  const baseAmount = toBaseAmount(size.toNumber(), sizeDecimals);

  // ── Validate against exchange minimums before signing ─────────────────────
  // Lighter docs: "Note that those minimums only apply to maker orders."
  // min_base_amount and min_quote_amount ONLY apply to limit/post_only (maker).
  // Market orders (IOC/taker) are NOT subject to these minimums.
  const minBase = marketInfo.minBaseAmount;
  const minQuote = marketInfo.minQuoteAmount;
  const isMakerOrder = orderKind === "limit" || orderKind === "post_only";

  if (isMakerOrder) {
    if (minBase > 0 && size.lt(minBase)) {
      const msg = `Order size ${size.toFixed(6)} ${strategy.marketSymbol} is below exchange minimum of ${minBase} (min_base_amount). Increase amountPerOrder.`;
      await addLog(userId, strategy.id, strategy.name, "warn", "Order skipped: size below exchange minimum", msg);
      logger.warn({ size: size.toNumber(), minBase, market: strategy.marketSymbol }, "Order below min_base_amount, skipped");
      return;
    }

    const orderValueUsdc = size.mul(currentPrice);
    if (minQuote > 0 && orderValueUsdc.lt(minQuote)) {
      const msg = `Order value $${orderValueUsdc.toFixed(2)} USDC is below exchange minimum of $${minQuote} (min_quote_amount). Increase amountPerOrder.`;
      await addLog(userId, strategy.id, strategy.name, "warn", "Order skipped: value below exchange minimum", msg);
      logger.warn({ valueUsdc: orderValueUsdc.toNumber(), minQuote, market: strategy.marketSymbol }, "Order below min_quote_amount, skipped");
      return;
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  // Market order: add 0.5% slippage buffer (worst-case fill price)
  // Limit/PostOnly order: offset from current price (buy below, sell above)
  let executionPrice: Decimal;
  let lighterOrderType: number;
  let lighterTimeInForce: number;
  let lighterOrderExpiry: number;

  if (orderKind === "limit" || orderKind === "post_only") {
    const offset = currentPrice.mul(new Decimal(limitPriceOffset)).div(100);
    executionPrice = side === "buy"
      ? currentPrice.sub(offset)
      : currentPrice.add(offset);
    lighterOrderType = 0;   // LimitOrder
    // PostOnly (2): maker-only, rejected immediately if it would cross — no expiry needed
    // GoodTillTime (1): standard limit, stays in book until expiry
    lighterTimeInForce = orderKind === "post_only" ? 2 : 1;
    // All limit orders (GTT and PostOnly) use -1 = DEFAULT_28_DAY_ORDER_EXPIRY
    // The Go signer computes the actual expiry internally.
    // PostOnly orders that don't cross sit in the book and also need a valid expiry.
    // 0 (NilOrderExpiry) is only correct for IOC/Market orders.
    lighterOrderExpiry = -1;
  } else {
    const slippageFactor = side === "buy" ? 1.005 : 0.995;
    executionPrice = currentPrice.mul(slippageFactor);
    lighterOrderType = 1;   // MarketOrder
    lighterTimeInForce = 0; // ImmediateOrCancel
    lighterOrderExpiry = 0; // NilOrderExpiry — not needed for IOC
  }

  const priceInt = toPriceInt(executionPrice.toNumber(), priceDecimals);
  const isAsk = side === "sell";

  const accountIndex = botConfig.accountIndex!;
  const apiKeyIndex = botConfig.apiKeyIndex;
  const privateKey = botConfig.privateKey!;

  if (apiKeyIndex === null) {
    const msg = "API key index not configured — go to Settings and enter your API Key Index";
    await addLog(userId, strategy.id, strategy.name, "error", "Order aborted: missing API key index", msg);
    return;
  }

  const gridMode = (strategy.gridConfig as any)?.mode ?? "neutral";

  const reduceOnly = computeReduceOnly(gridMode, side);

  const url = getBaseUrl(network);

  const clientOrderIndex = nextClientOrderIndex();

  let nonce: number;
  try {
    nonce = await acquireNonce(accountIndex, apiKeyIndex, network);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    invalidateNonceCache(accountIndex, apiKeyIndex, network);
    await addLog(userId, strategy.id, strategy.name, "error", "Failed to get nonce", msg);
    await recordTrade({
      userId,
      strategyId: strategy.id,
      strategyName: strategy.name,
      marketIndex: strategy.marketIndex,
      marketSymbol: strategy.marketSymbol,
      side,
      size,
      price: currentPrice,
      status: "failed",
      orderKind,
      errorMessage: msg,
    });
    return;
  }

  // initSigner called AFTER acquireNonce to prevent race condition:
  // no await between initSigner and signCreateOrder → atomic in JS event loop (LIGHTER-SIGNER-RACE-001)
  try {
    initSigner(url, privateKey, apiKeyIndex, accountIndex);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Nonce already acquired above — invalidate so next attempt fetches fresh nonce
    invalidateNonceCache(accountIndex, apiKeyIndex, network);
    await addLog(userId, strategy.id, strategy.name, "error", "Failed to initialize signer", msg);
    await recordTrade({
      userId,
      strategyId: strategy.id,
      strategyName: strategy.name,
      marketIndex: strategy.marketIndex,
      marketSymbol: strategy.marketSymbol,
      side,
      size,
      price: currentPrice,
      status: "failed",
      orderKind,
      errorMessage: msg,
    });
    return;
  }

  const signResult = signCreateOrder({
    marketIndex: strategy.marketIndex,
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
    const msg = `Sign failed: ${signResult.err}`;
    await addLog(userId, strategy.id, strategy.name, "error", "Order signing failed", msg);
    if (userId !== null) {
      getNotificationConfig(userId).then(notif => {
        if (notif.notifyOnError) notifyUser(userId, formatOrderFailed("lighter", strategy.name, msg));
      }).catch(() => {});
    }
    await recordTrade({
      userId,
      strategyId: strategy.id,
      strategyName: strategy.name,
      marketIndex: strategy.marketIndex,
      marketSymbol: strategy.marketSymbol,
      side,
      size,
      price: currentPrice,
      status: "failed",
      orderKind,
      errorMessage: msg,
    });
    return;
  }

  // ORPHAN-PREVENT-001: Pre-save pending trade to DB BEFORE sending to exchange.
  // Jika process crash setelah sendTx tapi sebelum recordTrade, order akan ada di
  // exchange tapi tidak di DB → orphan. Dengan pre-save, clientOrderIndex sudah ada
  // di DB sebagai "pending", sehingga orphan detection tidak akan cancel order ini.
  // Jika pre-save gagal (DB error), order TIDAK dikirim ke exchange.
  let preSavedTradeId: number;
  try {
    preSavedTradeId = await preSavePendingTrade({
      userId,
      strategyId: strategy.id,
      strategyName: strategy.name,
      marketIndex: strategy.marketIndex,
      marketSymbol: strategy.marketSymbol,
      side,
      size,
      price: currentPrice,
      clientOrderIndex,
      orderKind,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, strategyId: strategy.id, clientOrderIndex }, "[executeLiveOrder] DB pre-save gagal — order TIDAK dikirim ke exchange");
    await addLog(userId, strategy.id, strategy.name, "error", "Order aborted: DB pre-save gagal", msg);
    return;
  }

  // For market orders (IOC), disable price_protection because we already
  // apply a 0.5% slippage buffer in executionPrice. Keeping price_protection=true
  // on top of slippage causes sequencer to reject orders on volatile markets.
  // For limit orders keep price_protection=true as a safety net.
  const priceProtection = orderKind !== "market";

  // Wait for pending orphan cancels on the same account+apikey to complete their sends
  // before submitting this order — prevents nonce out-of-order delivery at startup.
  const _orphanKey = `${network}:${accountIndex}:${apiKeyIndex}`;
  await (_orphanCancelChain.get(_orphanKey) ?? Promise.resolve()).catch(() => {});

  let sendTxResult: Awaited<ReturnType<typeof sendTx>>;
  try {
    sendTxResult = await sendTx(signResult.txType, signResult.txInfo, network, priceProtection);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // FIX-LIGHTER-POSTONLY: Post-Only rejection retry (max 3x, +0.1% offset per attempt).
    // Sequencer menolak Post-Only order jika ia akan langsung match (ImmediateMatchPostOnly).
    // Retry dengan price offset lebih jauh dari mid-price agar order masuk sebagai maker.
    // Nonce di-invalidate karena sequencer memproses (dan menolak) tx — nonce ter-increment.
    const isPostOnlyRejection =
      orderKind === "post_only" &&
      (msg.includes("PostOnly") || msg.includes("ImmediateMatchPostOnly") || msg.includes("would take"));

    if (isPostOnlyRejection && _postOnlyRetryCount < 3) {
      const nextAttempt = _postOnlyRetryCount + 1;
      const nextOffset = limitPriceOffset + 0.1;
      // Update pre-saved record ke "failed" — attempt ini ditolak exchange.
      // Retry akan buat pre-save baru dengan clientOrderIndex baru.
      await db.update(tradesTable)
        .set({ status: "failed", errorMessage: `Post-Only rejected (attempt ${_postOnlyRetryCount + 1}/3): ${msg}` })
        .where(eq(tradesTable.id, preSavedTradeId));
      await addLog(
        userId, strategy.id, strategy.name, "warn",
        `Post-Only rejected (attempt ${nextAttempt}/3) — retry dengan offset +0.1%`,
        `Error: ${msg} | Offset baru: ${nextOffset.toFixed(3)}`
      );
      invalidateNonceCache(accountIndex, apiKeyIndex, network);
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      return executeLiveOrder({ ...params, limitPriceOffset: nextOffset, _postOnlyRetryCount: nextAttempt });
    }

    if (shouldInvalidateNonce(err)) {
      invalidateNonceCache(accountIndex, apiKeyIndex, network);
    }
    await addLog(userId, strategy.id, strategy.name, "error", "Order submission failed", msg);
    if (userId !== null) {
      getNotificationConfig(userId).then(notif => {
        if (notif.notifyOnError) notifyUser(userId, formatOrderFailed("lighter", strategy.name, msg));
      }).catch(() => {});
    }
    // Update pre-saved record ke "failed" — tidak buat record baru.
    await db.update(tradesTable)
      .set({ status: "failed", orderHash: signResult.txHash || null, errorMessage: msg })
      .where(eq(tradesTable.id, preSavedTradeId));
    return;
  }

  // Lighter mengembalikan hash yang BENAR di sendTx response (field: tx_hash).
  // Hash dari signer (signResult.txHash) = signing hash (berbeda dari Lighter-indexed hash).
  // Selalu pakai hash dari Lighter response — fallback ke signer hash hanya jika API tidak return.
  const confirmedHash = sendTxResult.tx_hash ?? signResult.txHash;

  if (sendTxResult.tx_hash) {
    logger.info({ lighterHash: sendTxResult.tx_hash, signerHash: signResult.txHash }, "Using Lighter-assigned hash for polling");
  } else {
    logger.warn({ signerHash: signResult.txHash }, "sendTx did not return tx_hash — using signer hash (may cause poll failures)");
  }

  await addLog(
    userId,
    strategy.id,
    strategy.name,
    "success",
    `Live ${side.toUpperCase()} order submitted`,
    `Size: ${size.toFixed(6)} | Price: $${currentPrice.toFixed(2)} | TxHash: ${confirmedHash}`
  );

  // Update pre-saved record dengan orderHash — status tetap "pending" (sudah di-set saat pre-save).
  await db.update(tradesTable)
    .set({ orderHash: confirmedHash })
    .where(eq(tradesTable.id, preSavedTradeId));

  // NOTE: updateStrategyStatsAtomic is called in pollPendingTrades when the
  // order is confirmed as filled (txStatus=2), not here. This avoids counting
  // orders that are submitted but later cancelled/rejected by the sequencer.

}

// Max orders per batch — prevents flooding the sequencer on huge price swings
const MAX_BATCH_ORDERS = 5;

async function executeBatchLiveOrders(params: {
  userId: number | null;
  strategy: typeof strategiesTable.$inferSelect;
  botConfig: Awaited<ReturnType<typeof getBotConfig>>;
  side: "buy" | "sell";
  size: Decimal;         // size per order
  currentPrice: Decimal;
  network: "mainnet";
  orderCount: number;
  orderKind?: "market" | "limit" | "post_only";
  limitPriceOffset?: number;
  // L-004 FIX: per-level prices untuk batch grid orders. Jika diberikan, tiap order
  // ke-i di-sign dengan harga dari levelPrices[i] (± limitPriceOffset), bukan currentPrice.
  levelPrices?: Decimal[];
}): Promise<void> {
  const { userId, strategy, botConfig, side, size, currentPrice, network, orderCount } = params;
  const orderKind = params.orderKind ?? "market";
  const limitPriceOffset = params.limitPriceOffset ?? 0;

  // L-003 FIX: Sama seperti executeLiveOrder — fallback fetch langsung dari API
  // jika cache miss, abort jelas jika masih null.
  let marketInfo = await getMarketInfo(strategy.marketIndex, network);
  if (!marketInfo) {
    logger.warn(
      { strategyId: strategy.id, marketIndex: strategy.marketIndex },
      "[lighterBotEngine] getMarketInfo null di executeBatchOrders — mencoba fetchLiveMarketInfo"
    );
    try {
      marketInfo = await fetchLiveMarketInfo(strategy.marketIndex, network);
    } catch (liveErr) {
      logger.error({ liveErr, strategyId: strategy.id }, "[lighterBotEngine] fetchLiveMarketInfo gagal di batch");
    }
  }
  if (!marketInfo) {
    const msg = `Market index ${strategy.marketIndex} tidak ditemukan di Lighter — cek konfigurasi strategi`;
    await addLog(userId, strategy.id, strategy.name, "error", "Batch dibatalkan: market info tidak tersedia", msg);
    return;
  }
  const sizeDecimals = marketInfo.sizeDecimals;
  const priceDecimals = marketInfo.priceDecimals;
  const minBase = marketInfo.minBaseAmount;
  const minQuote = marketInfo.minQuoteAmount;

  const baseAmount = toBaseAmount(size.toNumber(), sizeDecimals);

  // Lighter docs: minimums only apply to maker orders (limit/post_only), not market (taker) orders.
  const isMakerOrder = orderKind === "limit" || orderKind === "post_only";
  if (isMakerOrder) {
    if (minBase > 0 && size.lt(minBase)) {
      await addLog(userId, strategy.id, strategy.name, "warn", "Batch order skipped: size below min_base_amount");
      return;
    }
    if (minQuote > 0 && size.mul(currentPrice).lt(minQuote)) {
      await addLog(userId, strategy.id, strategy.name, "warn", "Batch order skipped: value below min_quote_amount");
      return;
    }
  }

  const accountIndex = botConfig.accountIndex!;
  const apiKeyIndex = botConfig.apiKeyIndex;
  const privateKey = botConfig.privateKey!;

  if (apiKeyIndex === null) {
    await addLog(userId, strategy.id, strategy.name, "error", "Batch order aborted: missing API key index");
    return;
  }

  const url = getBaseUrl(network);

  // Get base nonce once — atomically reserves `orderCount` nonces to prevent
  // race conditions with other concurrent bots sharing the same API key (BUG-L-003).
  let baseNonce: number;
  try {
    baseNonce = await acquireNonce(accountIndex, apiKeyIndex, network, orderCount);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    invalidateNonceCache(accountIndex, apiKeyIndex, network);
    await addLog(userId, strategy.id, strategy.name, "error", "Batch: failed to get nonce", msg);
    return;
  }

  // initSigner called AFTER acquireNonce to prevent race condition:
  // no await between initSigner and signCreateOrder → atomic in JS event loop (LIGHTER-SIGNER-RACE-001)
  try {
    initSigner(url, privateKey, apiKeyIndex, accountIndex);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Nonce already acquired above — invalidate so next attempt fetches fresh nonce
    invalidateNonceCache(accountIndex, apiKeyIndex, network);
    await addLog(userId, strategy.id, strategy.name, "error", "Batch: failed to initialize signer", msg);
    return;
  }

  // Order type params — sama untuk semua order dalam batch
  let lighterOrderType: number;
  let lighterTimeInForce: number;
  let lighterOrderExpiry: number;

  if (orderKind === "limit" || orderKind === "post_only") {
    lighterOrderType = 0;
    lighterTimeInForce = orderKind === "post_only" ? 2 : 1; // PostOnly=2, GoodTillTime=1
    lighterOrderExpiry = -1;
  } else {
    lighterOrderType = 1;
    lighterTimeInForce = 0;
    lighterOrderExpiry = 0;
  }

  const isAsk = side === "sell";
  const gridMode = (strategy.gridConfig as any)?.mode ?? "neutral";
  const levelPrices = params.levelPrices;

  // Sign all orders sequentially, each with an incremented nonce
  const signedTxs: Array<{ txType: number; txInfo: string }> = [];
  const clientOrderIndexes: number[] = [];
  // BATCH-PRESAVE-PRICE FIX: Rekam basePrice tiap order agar pre-save DB
  // menyimpan harga grid level asli (bukan currentPrice/market price untuk semua order).
  // Tanpa ini, semua N batch orders disimpan di DB dengan price=currentPrice yang identik
  // → replay system tidak bisa membedakan level → N-1 entries di-drop sebagai duplikat.
  const orderBasePrices: Decimal[] = [];

  for (let i = 0; i < orderCount; i++) {
    const clientOrderIndex = nextClientOrderIndex();
    const nonce = baseNonce + i;
    const reduceOnly = computeReduceOnly(gridMode, side);

    // L-004 FIX: Tiap order pakai harga level grid-nya sendiri.
    // Jika levelPrices diberikan, basePrice = harga level ke-i.
    // Jika tidak (DCA/non-grid batch), gunakan currentPrice seperti sebelumnya.
    const basePrice = levelPrices?.[i] ?? currentPrice;
    orderBasePrices.push(basePrice);
    let executionPrice: Decimal;
    if (orderKind === "limit" || orderKind === "post_only") {
      const offset = basePrice.mul(new Decimal(limitPriceOffset)).div(100);
      executionPrice = side === "buy" ? basePrice.sub(offset) : basePrice.add(offset);
    } else {
      const slippageFactor = side === "buy" ? 1.005 : 0.995;
      executionPrice = basePrice.mul(slippageFactor);
    }
    const priceInt = toPriceInt(executionPrice.toNumber(), priceDecimals);

    const signResult = signCreateOrder({
      marketIndex: strategy.marketIndex,
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
      await addLog(userId, strategy.id, strategy.name, "error",
        `Batch: sign failed for order ${i + 1}/${orderCount}`, signResult.err);
      break;
    }

    signedTxs.push({ txType: signResult.txType, txInfo: signResult.txInfo });
    clientOrderIndexes.push(clientOrderIndex);
  }

  if (signedTxs.length === 0) {
    await addLog(userId, strategy.id, strategy.name, "warn", "Batch: no orders could be signed");
    return;
  }

  // ORPHAN-PREVENT-001 (batch): Pre-save semua order ke DB SEBELUM sendTxBatch.
  // Jika process crash setelah batch diterima exchange tapi sebelum recordTrade,
  // semua order sudah ada di DB sebagai "pending" dengan clientOrderIndex-nya masing-masing.
  // Jika pre-save gagal, batch TIDAK dikirim ke exchange.
  const preSavedTradeIds: number[] = [];
  try {
    for (let i = 0; i < signedTxs.length; i++) {
      const tid = await preSavePendingTrade({
        userId,
        strategyId: strategy.id,
        strategyName: strategy.name,
        marketIndex: strategy.marketIndex,
        marketSymbol: strategy.marketSymbol,
        side,
        size,
        // BATCH-PRESAVE-PRICE FIX: gunakan harga grid level asli per order (bukan currentPrice).
        // DB menyimpan "reference price" tanpa offset — konsisten dengan executeLiveOrder
        // yang menyimpan currentPrice (= grid level price saat single order, tanpa offset).
        // orderBasePrices[i] = levelPrices[i] ?? currentPrice, diisi saat signing loop.
        price: orderBasePrices[i] ?? currentPrice,
        clientOrderIndex: clientOrderIndexes[i],
        orderKind,
      });
      preSavedTradeIds.push(tid);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, strategyId: strategy.id }, "[executeBatchLiveOrders] DB pre-save gagal — batch TIDAK dikirim ke exchange");
    await addLog(userId, strategy.id, strategy.name, "error", "Batch aborted: DB pre-save gagal", msg);
    // Update records yang sudah ter-insert ke "failed"
    for (const tid of preSavedTradeIds) {
      await db.update(tradesTable).set({ status: "failed", errorMessage: msg }).where(eq(tradesTable.id, tid));
    }
    return;
  }

  await addLog(
    userId, strategy.id, strategy.name, "info",
    `Batch: submitting ${signedTxs.length}× ${side.toUpperCase()} orders via sendTxBatch`,
    `Size each: ${size.toFixed(6)} | Price: $${currentPrice.toFixed(2)} | Total: $${size.mul(currentPrice).mul(signedTxs.length).toFixed(2)}`
  );

  let batchResult: Awaited<ReturnType<typeof sendTxBatch>>;
  try {
    // price_protection is not supported by sendTxBatch API (only by single sendTx).
    // Market orders in grid batch are handled by the 0.5% slippage buffer in executionPrice.
    batchResult = await sendTxBatch(signedTxs, network);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Invalidate nonce cache on sequencer rejection — nonce may have advanced
    invalidateNonceCache(accountIndex, apiKeyIndex, network);
    await addLog(userId, strategy.id, strategy.name, "error", "Batch order submission failed", msg);
    // Update pre-saved records ke "failed" — tidak buat record baru.
    for (const tid of preSavedTradeIds) {
      await db.update(tradesTable).set({ status: "failed", errorMessage: msg }).where(eq(tradesTable.id, tid));
    }
    return;
  }

  const txHashes = batchResult.tx_hash ?? [];

  // Detect partial success (BUG-L-006) — sequencer may accept fewer txs than submitted
  // (e.g. margin limit reached mid-batch, or sequencer capacity constraint).
  if (txHashes.length < signedTxs.length) {
    const rejected = signedTxs.length - txHashes.length;
    logger.warn(
      { strategyId: strategy.id, submitted: signedTxs.length, accepted: txHashes.length },
      "[LighterBatch] Partial success — some orders rejected by sequencer"
    );
    await addLog(
      userId, strategy.id, strategy.name, "warn",
      `Batch partial: ${txHashes.length}/${signedTxs.length} order diterima sequencer`,
      `${rejected} order ditolak (margin tidak cukup atau limit sequencer). Nonce di-reset.`
    );
    // Invalidate cached nonce so next call re-fetches the actual next nonce from API
    invalidateNonceCache(accountIndex, apiKeyIndex, network);
  }

  // Update pre-saved records — accepted: tambah orderHash, rejected: ubah ke "failed"
  for (let i = 0; i < preSavedTradeIds.length; i++) {
    const accepted = i < txHashes.length;
    await db.update(tradesTable)
      .set(accepted
        ? { orderHash: txHashes[i] ?? null }
        : { status: "failed", errorMessage: "Ditolak sequencer (partial batch failure — margin atau limit)" }
      )
      .where(eq(tradesTable.id, preSavedTradeIds[i]));
  }

  await addLog(
    userId, strategy.id, strategy.name, "success",
    `Batch: ${txHashes.length}/${signedTxs.length} ${side.toUpperCase()} order diterima sequencer`,
    txHashes.length > 0 ? `TxHashes: ${txHashes.join(", ")}` : "No tx_hash returned from sequencer"
  );

}

async function executeGridCheck(strategy: typeof strategiesTable.$inferSelect) {
  const config = strategy.gridConfig as {
    lowerPrice: number;
    upperPrice: number;
    gridLevels: number;
    amountPerGrid: number;
    mode: "neutral" | "long" | "short";
    stopLoss?: number | null;
    takeProfit?: number | null;
    orderType?: "market" | "limit" | "post_only";
    limitPriceOffset?: number;
    executionMode?: "aggressive" | "normal" | "passive" | null;
    // F3: Inventory Skew
    inventorySkewEnabled?: boolean;
    inventorySkewThreshold?: number;
    inventorySkewMaxMult?: number;
    inventorySkewPauseAt?: number | null;
    // F4: Follow-Market Grid
    followMarket?: boolean;
    followMarketTriggerPct?: number;
    followMarketMinIntervalMin?: number;
  };

  if (!config) return;

  const userId = strategy.userId ?? null;
  const execMultiplier = getExecModeMultiplier(config.executionMode);

  // ── SHORT-CIRCUIT a/b/c: Cek timeout/pending rerange SEBELUM logika grid ──
  // Jika ada pending konfirmasi rerange, cek tiga kondisi berurutan:
  // (a) Timeout 20 menit → pause bot
  // (b) Harga sudah kembali ke range → batalkan pending, lanjutkan grid
  // (c) Masih di luar range, belum timeout → tunggu konfirmasi user
  //
  // LIGHTER-CACHE-001: Cache botConfig & currentPrice dari block (b) agar
  // tidak double-call getBotConfig + getCurrentPrice saat harga kembali ke range
  // dan fungsi lanjut ke logika grid normal. Mirror Extended (EXT-CACHE-001)
  // dan Extended yang sudah implement pola ini terlebih dahulu.
  let _cachedBotConfig: Awaited<ReturnType<typeof getBotConfig>> | null = null;
  let _cachedCurrentPrice: Decimal | null = null;

  if (strategy.pendingRerangeAt) {
    const elapsed = Date.now() - new Date(strategy.pendingRerangeAt).getTime();
    if (elapsed > PENDING_TIMEOUT_MS) {
      // (a) Timeout 20 menit: clear state, pause bot, kirim notifikasi
      await clearRerangeState(strategy.id);
      await addLog(
        userId, strategy.id, strategy.name, "warn",
        "⏸ Auto-Rerange timeout: tidak ada konfirmasi dalam 20 menit. Bot di-pause.",
        "User tidak merespons konfirmasi rerange. Atur parameter manual dari dashboard."
      );
      const pauseNotifCfg = userId !== null ? await getBotConfig(userId).catch(() => null) : null;
      await sendMainBotMessageWithButton(
        pauseNotifCfg?.notifyChatId,
        formatBotPaused("lighter", strategy.name, "Tidak ada konfirmasi rerange dalam 20 menit"),
        { text: "▶️ Start Bot", callback_data: `bot_restart_${strategy.id}` }
      );
      await stopBot(strategy.id);
      return;
    }

    // (b) Belum timeout — cek apakah harga sudah kembali ke range
    const botCfgCheck = userId !== null ? await getBotConfig(userId) : null;
    const networkCheck = botCfgCheck?.network ?? "mainnet";
    const priceCheck = await getCurrentPrice(strategy.marketIndex, networkCheck);

    if (priceCheck) {
      const lower = new Decimal(config.lowerPrice);
      const upper = new Decimal(config.upperPrice);
      if (priceCheck.gte(lower) && priceCheck.lte(upper)) {
        // (b-hit) Harga kembali ke range → batalkan pending rerange otomatis
        await clearRerangeState(strategy.id);
        await addLog(
          userId, strategy.id, strategy.name, "info",
          `✅ Harga kembali ke range ($${priceCheck.toFixed(4)}). Pending rerange dibatalkan otomatis.`,
          `Range: $${lower.toFixed(4)} - $${upper.toFixed(4)}`
        );
        // Cache hasil fetch agar tidak double-call di block utama (LIGHTER-CACHE-001)
        _cachedBotConfig = botCfgCheck;
        _cachedCurrentPrice = priceCheck;
        // Tidak return → lanjutkan ke logika grid normal di bawah
      } else {
        // (c) Masih di luar range, belum timeout → tunggu konfirmasi user
        return;
      }
    } else {
      // Tidak bisa fetch harga → skip tick ini, coba lagi nanti
      return;
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  // Gunakan hasil cache dari block pendingRerange (b) jika tersedia (LIGHTER-CACHE-001)
  const botConfig = _cachedBotConfig ?? (userId !== null ? await getBotConfig(userId) : null);
  const hasCredentials = !!(botConfig?.privateKey && botConfig?.accountIndex != null);
  const network = botConfig?.network ?? "mainnet";

  const currentPrice = _cachedCurrentPrice ?? await getCurrentPrice(strategy.marketIndex, network);
  if (!currentPrice) {
    await addLog(userId, strategy.id, strategy.name, "warn", "Could not fetch market price for grid check");
    return;
  }

  if (config.stopLoss) {
    const slTriggered = isSlTriggered(config.mode ?? "neutral", currentPrice.toNumber(), config.stopLoss);
    if (slTriggered) {
      await addLog(userId, strategy.id, strategy.name, "warn",
        `Stop Loss triggered at $${currentPrice.toFixed(2)} (SL: $${config.stopLoss})`,
        "Bot stopped automatically due to stop loss"
      );
      if (userId !== null) {
        const notif = await getNotificationConfig(userId);
        if (notif.notifyOnStop) {
          await notifyUser(userId, formatStopLoss("lighter", strategy.name, strategy.marketSymbol, currentPrice.toFixed(2), config.stopLoss));
        }
      }
      await stopBot(strategy.id);
      return;
    }
  }

  if (config.takeProfit) {
    const tpTriggered = isTpTriggered(config.mode ?? "neutral", currentPrice.toNumber(), config.takeProfit);
    if (tpTriggered) {
      await addLog(userId, strategy.id, strategy.name, "success",
        `Take Profit triggered at $${currentPrice.toFixed(2)} (TP: $${config.takeProfit})`,
        "Bot stopped automatically due to take profit"
      );
      if (userId !== null) {
        const notif = await getNotificationConfig(userId);
        if (notif.notifyOnStop) {
          await notifyUser(userId, formatTakeProfit("lighter", strategy.name, strategy.marketSymbol, currentPrice.toFixed(2), config.takeProfit));
        }
      }
      await stopBot(strategy.id);
      return;
    }
  }

  const lower = new Decimal(config.lowerPrice);
  const upper = new Decimal(config.upperPrice);
  const levels = config.gridLevels;
  const amountPerGrid = new Decimal(config.amountPerGrid);
  const mode = config.mode ?? "neutral";

  if (!levels || levels === 0 || lower.gte(upper)) {
    await addLog(
      userId, strategy.id, strategy.name,
      "error", "Grid config invalid",
      `levels=${levels}, lower=${lower.toFixed(4)}, upper=${upper.toFixed(4)} — bot dihentikan.`
    );
    return;
  }

  const gridSpacing = upper.sub(lower).div(levels);

  // ── F4: Follow-Market Grid ────────────────────────────────────────────────
  if (config.followMarket) {
    let fmState = lighterFollowMarketStates.get(strategy.id);
    if (!fmState) {
      fmState = {
        gridCenterPrice: lower.add(upper).div(2),
        lastReanchorAt:  null,
        originalRange:   upper.sub(lower),
      };
      lighterFollowMarketStates.set(strategy.id, fmState);
    }
    const triggerPct    = (config.followMarketTriggerPct    ?? 1.0) / 100;
    const minIntervalMs = (config.followMarketMinIntervalMin ?? 5)   * 60 * 1000;
    const deviation     = currentPrice.sub(fmState.gridCenterPrice).abs().div(fmState.gridCenterPrice).toNumber();
    const intervalOk    = fmState.lastReanchorAt === null || (Date.now() - fmState.lastReanchorAt.getTime() > minIntervalMs);

    if (deviation > triggerPct && intervalOk) {
      const halfRange = fmState.originalRange.div(2);
      const newLower  = currentPrice.sub(halfRange);
      const newUpper  = currentPrice.add(halfRange);
      const oldCenter = fmState.gridCenterPrice.toFixed(2);

      // Update gridConfig in DB with new bounds
      const updatedCfg: GridConfig = { ...(strategy.gridConfig as GridConfig), lowerPrice: newLower.toNumber(), upperPrice: newUpper.toNumber() };
      await db.update(strategiesTable)
        .set({ gridConfig: updatedCfg, updatedAt: new Date() })
        .where(eq(strategiesTable.id, strategy.id));

      // Cancel all pending orders on exchange + mark as failed so placement loop re-places
      try {
        const fmCancelCfg = userId !== null ? await getBotConfig(userId).catch(() => null) : null;
        if (fmCancelCfg?.privateKey && fmCancelCfg.accountIndex != null && fmCancelCfg.apiKeyIndex != null) {
          const network: Network = "mainnet";
          initSigner(getBaseUrl(network), fmCancelCfg.privateKey, fmCancelCfg.apiKeyIndex, fmCancelCfg.accountIndex);
          const pendingForCancel = await db.query.tradesTable.findMany({
            where: and(eq(tradesTable.strategyId, strategy.id), eq(tradesTable.status, "pending"), isNotNull(tradesTable.clientOrderIndex)),
          });
          // NONCE-OOO-002 FIX: Lighter mensyaratkan new_nonce = old_nonce + 1 (docs: signing-transactions.md).
          // Sebelumnya Promise.allSettled (parallel sendTx) → nonce N+1 bisa tiba sebelum N → sequencer reject.
          // Fix: gunakan enqueueOrphanCancel (atomic acquire+send per entry, serial per account+apikey).
          const fmCancelPromises = pendingForCancel.map((trade: any) =>
            enqueueOrphanCancel(fmCancelCfg.accountIndex!, fmCancelCfg.apiKeyIndex!, network, async () => {
              try {
                const cancelNonce = await acquireNonce(fmCancelCfg.accountIndex!, fmCancelCfg.apiKeyIndex!, network);
                // L-005 FIX: Prioritaskan lighterOrderIndex (exchange-assigned, dari syncOrderBookState).
                // Fallback ke clientOrderIndex untuk order lama yang belum sempat di-populate.
                const cancelOrderIndex = trade.lighterOrderIndex ?? trade.clientOrderIndex!;
                const cancelSign = signCancelOrder({ marketIndex: trade.marketIndex, orderIndex: cancelOrderIndex, nonce: cancelNonce, apiKeyIndex: fmCancelCfg.apiKeyIndex!, accountIndex: fmCancelCfg.accountIndex! });
                if (!cancelSign.err) await sendTx(cancelSign.txType, cancelSign.txInfo, network, false);
              } catch (fmCancelErr) {
                if (shouldInvalidateNonce(fmCancelErr)) {
                  invalidateNonceCache(fmCancelCfg.accountIndex!, fmCancelCfg.apiKeyIndex!, network);
                }
                /* best-effort — DB update below runs regardless */
              }
              await db.update(tradesTable).set({ status: "failed", errorMessage: "F4: grid re-anchored" }).where(eq(tradesTable.id, trade.id));
            })
          );
          await Promise.all(fmCancelPromises);
        }
      } catch (fmErr) {
        logger.warn({ fmErr, strategyId: strategy.id }, "[LighterBot] F4 cancel-on-reanchor partial failure");
      }

      // Clear in-memory grid state so next tick re-initializes
      gridStates.delete(strategy.id);
      cancelledOrderReplays.delete(strategy.id);

      fmState.gridCenterPrice = currentPrice;
      fmState.lastReanchorAt  = new Date();
      lighterFollowMarketStates.set(strategy.id, fmState);

      await addLog(userId, strategy.id, strategy.name, "info",
        `F4: Grid re-anchored $${oldCenter} → $${currentPrice.toFixed(2)}`,
        `New range: $${newLower.toFixed(2)} – $${newUpper.toFixed(2)}`
      );
      return; // next poll cycle picks up new config from DB
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  // Out-of-range: delegasikan ke Auto-Rerange engine
  // handleAutoRerange mengelola: counter candle, cooldown, daily limit, AI call,
  // simpan pending state ke DB, dan kirim konfirmasi ke Telegram.
  if (currentPrice.lt(lower) || currentPrice.gt(upper)) {
    const rerangeResult = await handleAutoRerange(strategy, currentPrice);

    switch (rerangeResult.type) {
      case "triggered":
        // Konfirmasi sudah dikirim ke Telegram. Bot menunggu respons user.
        // Tick berikutnya akan short-circuit via pendingRerangeAt check di atas.
        await addLog(
          userId, strategy.id, strategy.name, "warn",
          `🤖 Auto-Rerange triggered: harga $${currentPrice.toFixed(4)} keluar range. Menunggu konfirmasi user.`,
          `Range lama: $${lower.toFixed(4)}-$${upper.toFixed(4)} | Range baru AI: $${rerangeResult.params.newLowerPrice.toFixed(4)}-$${rerangeResult.params.newUpperPrice.toFixed(4)}`
        );
        break;
      case "continue":
        // Counter belum cukup (< 5 tick), atau cooldown aktif, atau limit harian.
        // Tetap log warning seperti sebelumnya agar user bisa monitor.
        await addLog(
          userId, strategy.id, strategy.name, "warn",
          `Price $${currentPrice.toFixed(4)} outside range ($${lower.toFixed(4)} - $${upper.toFixed(4)}) — waiting (${(strategy.consecutiveOutOfRange ?? 0) + 1}/5 ticks)`
        );
        break;
      // "short_circuit" dan "timeout" tidak akan terjadi di sini
      // karena sudah ditangani di short-circuit block di atas (pendingRerangeAt check).
    }
    return;
  }

  // Current level: 0 = at lower, levels-1 = near upper
  const currentLevel = Math.min(
    Math.floor(currentPrice.sub(lower).div(gridSpacing).toNumber()),
    levels - 1
  );

  const existingState = gridStates.get(strategy.id);

  // First run: initialize state only, no order
  if (!existingState) {
    gridStates.set(strategy.id, { lastLevel: currentLevel, initializedAt: new Date() });
    // BUG-L-005: Persist initial level to DB
    db.update(strategiesTable)
      .set({ gridLastLevel: currentLevel, updatedAt: new Date() })
      .where(eq(strategiesTable.id, strategy.id))
      .catch((e: unknown) => logger.warn({ e, strategyId: strategy.id }, "[lighterBotEngine] Gagal persist gridLastLevel (init)"));
    await addLog(
      userId,
      strategy.id,
      strategy.name,
      "info",
      `Grid initialized at level ${currentLevel}/${levels}`,
      `Price: $${currentPrice.toFixed(2)} | Range: $${lower.toFixed(2)}-$${upper.toFixed(2)} | Spacing: $${gridSpacing.toFixed(2)}`
    );
    return;
  }

  const lastLevel = existingState.lastLevel;

  // No crossing: just log
  if (currentLevel === lastLevel) {
    await addLog(
      userId,
      strategy.id,
      strategy.name,
      "info",
      `Grid check: level ${currentLevel}/${levels} | price $${currentPrice.toFixed(2)} | no crossing`
    );
    return;
  }

  const levelsMoved = currentLevel - lastLevel;
  const direction = levelsMoved < 0 ? "down" : "up";
  const side = computeGridSide(levelsMoved);

  // Update state immediately to prevent re-triggering
  existingState.lastLevel = currentLevel;
  // BUG-L-005: Persist updated level to DB (fire-and-forget, no await to keep hot path fast)
  db.update(strategiesTable)
    .set({ gridLastLevel: currentLevel, updatedAt: new Date() })
    .where(eq(strategiesTable.id, strategy.id))
    .catch((e: unknown) => logger.warn({ e, strategyId: strategy.id }, "[lighterBotEngine] Gagal persist gridLastLevel (update)"));

  // Place one order per level crossed, capped at MAX_BATCH_ORDERS
  const orderCount = Math.min(Math.abs(levelsMoved), MAX_BATCH_ORDERS);
  const size = amountPerGrid.div(currentPrice);

  // LIGHTER-SIZE-001: Zero-guard — mirror Extended.
  // Terjadi jika amountPerGrid sangat kecil atau currentPrice sangat besar.
  // Tanpa guard ini, order dengan size=0 dikirim ke exchange dan ditolak di sisi Lighter.
  if (size.lte(0)) {
    await addLog(
      userId, strategy.id, strategy.name, "warn",
      "Size Grid terlalu kecil — order dilewati",
      `Amount per grid: $${amountPerGrid.toFixed(2)} | Price: $${currentPrice.toFixed(2)} | Size: ${size.toFixed(8)}`
    );
    return;
  }

  await addLog(
    userId,
    strategy.id,
    strategy.name,
    "info",
    `Grid crossed ${Math.abs(levelsMoved)} level(s) ${direction} → ${side.toUpperCase()} ×${orderCount}`,
    `Level: ${lastLevel} → ${currentLevel} | Price: $${currentPrice.toFixed(2)} | Size each: ${size.toFixed(6)} | Amount each: $${amountPerGrid.toFixed(2)}`
  );

  const limitPriceOffset = config.limitPriceOffset ?? 0;
  const offsetDecimal = currentPrice.mul(new Decimal(limitPriceOffset)).div(100);
  const isMarketOrderKind = (config.orderType ?? "limit") === "market";
  const executionPriceForTol = isMarketOrderKind
    ? currentPrice
    : (side === "buy" ? currentPrice.sub(offsetDecimal) : currentPrice.add(offsetDecimal));

  // AUDIT-L-006: preSavePendingTrade menyimpan `price: currentPrice` (= grid level price, tanpa offset).
  // Tolerance window harus berpusat di currentPrice — bukan executionPriceForTol (yang sudah di-offset).
  // Sebelumnya window berpusat di executionPriceForTol, meleset sejauh offset × price dari record DB,
  // sehingga duplicate check selalu MISS ketika limitPriceOffset > 0.
  const targetPrice = currentPrice.toNumber();
  const { lower: tolLower, upper: tolUpper } = getDuplicateTolerance(targetPrice, gridSpacing.toNumber());
  const existingPending = await db.query.tradesTable.findFirst({
    where: and(
      eq(tradesTable.strategyId, strategy.id),
      eq(tradesTable.status, "pending"),
      eq(tradesTable.side, side),
      gte(tradesTable.price, String(tolLower)),
      lte(tradesTable.price, String(tolUpper)),
    ),
  });
  if (existingPending) {
    logger.info({ strategyId: strategy.id, side, targetPrice }, "Skip: pending order sudah ada di level ini (AUDIT-L-006)");
    return;
  }

  // F3: Inventory Skew — compute per-side offset multiplier
  const skewState = lighterSkewStates.get(strategy.id) ?? { cumulativeBuyQty: new Decimal(0), cumulativeSellQty: new Decimal(0) };
  const referenceQty = amountPerGrid.mul(config.gridLevels).div(currentPrice);
  const skew = computeSkewMultipliers(skewState, {
    enabled: config.inventorySkewEnabled,
    threshold: config.inventorySkewThreshold,
    maxMult: config.inventorySkewMaxMult,
    pauseAt: config.inventorySkewPauseAt,
  }, referenceQty);
  if ((side === "buy" && skew.pauseBuy) || (side === "sell" && skew.pauseSell)) {
    await addLog(userId, strategy.id, strategy.name, "info",
      `F3: Inventory skew pause — sisi ${side.toUpperCase()} ditangguhkan sementara`,
      `Buy: ${skewState.cumulativeBuyQty.toFixed(6)} | Sell: ${skewState.cumulativeSellQty.toFixed(6)}`
    );
    return;
  }
  const skewMult = side === "buy" ? skew.buyMult : skew.sellMult;
  const effectiveOffset = (config.limitPriceOffset ?? 0) * execMultiplier * skewMult;

  if (!hasCredentials) {
    // Paper trading — simulate one order per level crossed
    for (let i = 0; i < orderCount; i++) {
      await recordTrade({
        userId,
        strategyId: strategy.id,
        strategyName: strategy.name,
        marketIndex: strategy.marketIndex,
        marketSymbol: strategy.marketSymbol,
        side,
        size,
        price: currentPrice,
        status: "filled",
        orderHash: `paper_${Date.now()}_${i}`,
        orderKind: (config.orderType ?? "limit") as "market" | "limit" | "post_only",
      });
      await updateStrategyStatsAtomic(strategy.id, side, size, currentPrice, mode);

      // LIG-SKEW-PAPER-001: F3 Inventory Skew — update cumulative qty untuk paper trade.
      // Tanpa ini, skewRatio selalu 0 → F3 tidak berfungsi di mode paper trading.
      const skLigPaper = lighterSkewStates.get(strategy.id) ?? { cumulativeBuyQty: new Decimal(0), cumulativeSellQty: new Decimal(0) };
      if (side === "buy") skLigPaper.cumulativeBuyQty = skLigPaper.cumulativeBuyQty.add(size);
      else skLigPaper.cumulativeSellQty = skLigPaper.cumulativeSellQty.add(size);
      lighterSkewStates.set(strategy.id, skLigPaper);
    }
    await addLog(
      userId, strategy.id, strategy.name, "warn",
      `Paper trade: ${orderCount}× ${side.toUpperCase()} ${size.toFixed(6)} @ $${currentPrice.toFixed(2)}`,
      "No API credentials configured — simulated orders only"
    );
  } else if (orderCount === 1) {
    // Single level crossed — use the original single-order path
    await executeLiveOrder({
      userId,
      strategy,
      botConfig: botConfig!,
      side,
      size,
      currentPrice,
      network,
      orderKind: config.orderType ?? "limit", // GRID-NEW-003: default "limit" (maker fee)
      limitPriceOffset: effectiveOffset,
    });
  } else {
    // Multiple levels crossed — send all orders in a single sendTxBatch call.
    // L-004 FIX: Hitung harga per level grid yang dilewati, bukan satu harga untuk semua.
    // Jika price turun (buy): level lastLevel-1, lastLevel-2, ...
    // Jika price naik (sell): level lastLevel+1, lastLevel+2, ...
    const levelPrices: Decimal[] = [];
    for (let i = 0; i < orderCount; i++) {
      const levelIndex = side === "buy"
        ? lastLevel - 1 - i
        : lastLevel + 1 + i;
      const clampedIndex = Math.max(0, levelIndex);
      levelPrices.push(lower.add(gridSpacing.mul(clampedIndex)));
    }

    await executeBatchLiveOrders({
      userId,
      strategy,
      botConfig: botConfig!,
      side,
      size,
      currentPrice,
      network,
      orderCount,
      orderKind: config.orderType ?? "limit", // GRID-NEW-003: default "limit" (maker fee)
      limitPriceOffset: effectiveOffset,
      levelPrices,
    });
  }
}

async function runStrategyOnce(strategyId: number) {
  const strategy = await db.query.strategiesTable.findFirst({
    where: eq(strategiesTable.id, strategyId),
  });

  if (!strategy) {
    logger.warn({ strategyId }, "[LighterBot] DB query returned null — skipping tick, bot stays running");
    return;
  }

  if (!strategy.isActive || !strategy.isRunning) {
    await stopBot(strategyId);
    return;
  }

  try {
    await executeGridCheck(strategy);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await addLog(strategy.userId ?? null, strategy.id, strategy.name, "error", `Strategy execution error: ${message}`);
    logger.error({ err, strategyId }, "Strategy execution error");
    if (strategy.userId) {
      getNotificationConfig(strategy.userId).then(notif => {
        if (notif.notifyOnError) notifyUser(strategy.userId, formatOrderFailed("lighter", strategy.name, message));
      }).catch(() => {});
    }
  }
}

// LIGHTER-GAP-002: Reconcile DB pending orders vs exchange active orders.
// Ghost pending = ada di DB tapi tidak ada di exchange, usia > 30 detik, dan
// clientOrderIndex IS NOT NULL. Ghost orders di-mark "cancelled" di DB.
async function syncOrderBookState(
  userId: number,
  strategy: typeof strategiesTable.$inferSelect,
  network: Network
): Promise<void> {
  let botConfig: Awaited<ReturnType<typeof getBotConfig>>;
  try {
    botConfig = await getBotConfig(userId);
  } catch (err) {
    logger.warn({ err, strategyId: strategy.id }, "[syncOrderBookState] getBotConfig gagal — sync dilewati");
    return;
  }

  const readonlyToken = botConfig.lighterReadonlyToken;
  if (!readonlyToken) {
    logger.warn({ strategyId: strategy.id }, "[syncOrderBookState] lighter_readonly_token belum dikonfigurasi — sync dilewati");
    return;
  }

  const accountIndex = botConfig.accountIndex;
  if (accountIndex === null) {
    logger.warn({ strategyId: strategy.id }, "[syncOrderBookState] accountIndex belum dikonfigurasi — sync dilewati");
    return;
  }

  let activeOrders: Awaited<ReturnType<typeof fetchAccountActiveOrders>>;
  try {
    activeOrders = await fetchAccountActiveOrders(accountIndex, readonlyToken, strategy.marketIndex ?? undefined, network);
  } catch (err) {
    logger.warn({ err, strategyId: strategy.id }, "[syncOrderBookState] fetchAccountActiveOrders gagal — sync cycle ini dilewati");
    return;
  }

  const activeClientIds = new Set(activeOrders.map((o) => o.client_order_index));

  // L-005 FIX: Buat map clientOrderIndex → order_index dari exchange-side active orders.
  // Digunakan untuk populate lighter_order_index di DB — sehingga cancel Go FFI pakai nilai yang benar.
  const activeClientToOrderIndex = new Map<number, number>(
    activeOrders.map((o) => [o.client_order_index, o.order_index])
  );

  const dbPending = await db.query.tradesTable.findMany({
    where: and(
      eq(tradesTable.strategyId, strategy.id),
      eq(tradesTable.status, "pending"),
      isNotNull(tradesTable.clientOrderIndex)
    ),
  });

  // L-005: Update lighter_order_index untuk trades yang belum punya nilainya.
  // Hanya update jika: (a) trade ada di exchange activeOrders (masih hidup) DAN (b) kolom belum diisi.
  const updateOrderIndexPromises = dbPending
    .filter((t) => t.lighterOrderIndex == null && t.clientOrderIndex != null && activeClientToOrderIndex.has(t.clientOrderIndex))
    .map((t) => {
      const exOrderIndex = activeClientToOrderIndex.get(t.clientOrderIndex!)!;
      return db.update(tradesTable)
        .set({ lighterOrderIndex: exOrderIndex })
        .where(eq(tradesTable.id, t.id));
    });
  if (updateOrderIndexPromises.length > 0) {
    await Promise.allSettled(updateOrderIndexPromises);
    logger.info(
      { strategyId: strategy.id, updated: updateOrderIndexPromises.length },
      "[syncOrderBookState] lighter_order_index dipopulasi dari exchange active orders (L-005)"
    );
  }

  // ── ORPHAN DETECTION: order aktif di exchange tapi tidak ada di DB sebagai pending ──
  // Terjadi saat restart — order dari sesi sebelumnya masih hidup di exchange tapi
  // bot tidak mengenalinya. Dibersihkan dengan cancel agar tidak ada order liar.
  //
  // BUG-FRESH-001: fetchAccountActiveOrders mengembalikan SEMUA order untuk account+market
  // (Lighter API tidak menyediakan filter per-strategy). Jika dua strategy berbeda trade
  // market yang sama pada account yang sama, syncOrderBookState dari strategy A akan
  // melihat order strategy B sebagai "orphan" (tidak ada di dbPending strategy A) dan
  // meng-cancelnya — lalu re-queue ke cancelledOrderReplays → infinite cancel loop (~280ms).
  //
  // Fix: bangun dbPendingClientIds dari SEMUA pending trades untuk userId+marketIndex ini,
  // bukan hanya strategyId saat ini. Order milik strategy lain tidak akan dianggap orphan.
  const allPendingForMarket = await db.query.tradesTable.findMany({
    where: and(
      eq(tradesTable.userId, userId),
      eq(tradesTable.marketIndex, strategy.marketIndex),
      eq(tradesTable.status, "pending"),
      isNotNull(tradesTable.clientOrderIndex)
    ),
  });
  const dbPendingClientIds = new Set(allPendingForMarket.map((t) => t.clientOrderIndex!));
  const orphans = activeOrders.filter(
    (o) => o.client_order_index && !dbPendingClientIds.has(o.client_order_index)
  );

  if (orphans.length > 0) {
    logger.info(
      { strategyId: strategy.id, orphanCount: orphans.length },
      "[syncOrderBookState] Orphaned exchange orders ditemukan — akan di-cancel"
    );
    await addLog(userId, strategy.id, strategy.name, "warn",
      `Orphaned orders ditemukan (${orphans.length}) — sedang di-cancel`,
      `Exchange memiliki ${orphans.length} order aktif yang tidak ditemukan di database bot (kemungkinan sisa sesi sebelumnya)`
    );

    if (botConfig.privateKey && botConfig.apiKeyIndex !== null && botConfig.accountIndex !== null) {
      // initSigner harus dipanggil sekali sebelum loop — identik dengan pola di stopBot & placeOrder.
      // Tanpa ini signCancelOrder akan error "client is not created for apiKeyIndex: X accountIndex: Y".
      initSigner(getBaseUrl(network), botConfig.privateKey, botConfig.apiKeyIndex, botConfig.accountIndex);
      // ORPHAN-CANCEL-SEQ-001: setiap cancel di-enqueue ke global chain per account+apikey.
      // Ini menjamin acquire+send tiap transaksi atomic antar strategy yang share apiKeyIndex sama.
      // Lighter docs (signing-transactions.md): "we require new_nonce = old_nonce + 1".
      // Sequential loop saja tidak cukup jika dua strategy jalan bersamaan — sendTx bisa interleave.
      const cancelPromises = orphans.map((orphan) => {
        // LIG-007 FIX: Gunakan client_order_index (bukan order_index) untuk cancel.
        // Lighter docs (signing-transactions.md line 35): "in cancels, you may see order_index
        // instead as an argument — this is fine and you can use the same value [client_order_index] here."
        // order_index dari accountActiveOrders API tidak di-return secara reliable (undefined di runtime)
        // → cancel dengan order_index menghasilkan cOrderIndex=0 → ditolak exchange secara silent.
        // client_order_index selalu tersedia (dijamin truthy oleh filter orphan di atas).
        const orderIndex = orphan.client_order_index;
        return enqueueOrphanCancel(botConfig.accountIndex!, botConfig.apiKeyIndex!, network, async () => {
          try {
            const cancelNonce = await acquireNonce(botConfig.accountIndex!, botConfig.apiKeyIndex!, network);
            const cancelSign = signCancelOrder({
              marketIndex: strategy.marketIndex!,
              orderIndex,
              nonce: cancelNonce,
              apiKeyIndex: botConfig.apiKeyIndex!,
              accountIndex: botConfig.accountIndex!,
            });
            if (!cancelSign.err) {
              await sendTx(cancelSign.txType, cancelSign.txInfo, network, false);
              logger.info(
                { strategyId: strategy.id, orderIndex, clientOrderIndex: orphan.client_order_index },
                "[syncOrderBookState] Orphaned exchange order di-cancel"
              );
              await addLog(userId, strategy.id, strategy.name, "info",
                "Orphaned order berhasil di-cancel",
                `clientOrderIndex: ${orphan.client_order_index}, price: ${orphan.price}, side: ${orphan.is_ask ? "sell" : "buy"}`
              );
              // LIG-ORPHAN-RATE-LIMIT-001: Jeda 500ms setelah tiap cancel sukses agar burst
              // orphan cancel tidak melebihi rate limit exchange (~2 tx/s per account).
              // Delay hanya aktif saat ada orphan (startup) — tidak mempengaruhi normal operation.
              await new Promise((r) => setTimeout(r, 500));
              // BUG-ORPHAN-REPLACE-001: Re-queue orphan ke cancelledOrderReplays agar
              // replayExpiredGridOrders bisa re-place grid level yang hilang.
              // BUG-ORPHAN-SIDE-ROOT-001: Lighter API sudah tidak mengisi field `side`
              // (deprecated, docs: "TODO: remove this") — selalu "". Pakai `is_ask: boolean`
              // (field canonical) untuk menentukan arah: is_ask=true → sell, is_ask=false → buy.
              // tradeId=-1 = sentinel: tidak ada DB record untuk orphan murni (pre-save bypass).
              if (strategy.type === "grid") {
                const orphanPrice = new Decimal(orphan.price);
                // LIG-ORPHAN-RANGE-001: Hanya re-queue orphan jika harganya berada dalam
                // grid range [lowerPrice, upperPrice] saat ini. Orphan dari sesi lama dengan
                // harga di luar range (misal BTC $61K atau $98K saat grid $71K-$78K) tidak
                // perlu di-place ulang — cancel sudah cukup, grid tick akan place order baru
                // di harga yang benar saat price crossing terjadi.
                const gridCfg = strategy.gridConfig as { lowerPrice?: number; upperPrice?: number } | null;
                const gridLower = gridCfg?.lowerPrice != null ? new Decimal(gridCfg.lowerPrice) : null;
                const gridUpper = gridCfg?.upperPrice != null ? new Decimal(gridCfg.upperPrice) : null;
                const inRange = gridLower && gridUpper
                  ? orphanPrice.gte(gridLower) && orphanPrice.lte(gridUpper)
                  : true; // fail-open: jika config tidak tersedia, queue tetap agar tidak ada regresi
                if (orphanPrice.gt(0) && inRange) {
                  const orphanSide: "buy" | "sell" = orphan.is_ask ? "sell" : "buy";
                  const q = cancelledOrderReplays.get(strategy.id) ?? [];
                  q.push({
                    side: orphanSide,
                    originalPrice: orphanPrice,
                    cancelledAt: new Date(),
                    tradeId: -1,
                  });
                  cancelledOrderReplays.set(strategy.id, q);
                  logger.info(
                    { strategyId: strategy.id, is_ask: orphan.is_ask, side: orphanSide, price: orphan.price },
                    "[syncOrderBookState] Orphan grid level di-queue untuk re-placement"
                  );
                } else if (orphanPrice.gt(0)) {
                  logger.info(
                    { strategyId: strategy.id, price: orphan.price, lower: gridLower?.toFixed(4), upper: gridUpper?.toFixed(4) },
                    "[syncOrderBookState] LIG-ORPHAN-RANGE-001: Orphan di luar grid range — cancel-only, tidak di-queue"
                  );
                }
              }
            } else {
              logger.warn(
                { strategyId: strategy.id, orderIndex, clientOrderIndex: orphan.client_order_index, signErr: cancelSign.err },
                "[syncOrderBookState] Gagal sign cancel orphaned exchange order — lanjut"
              );
              await addLog(userId, strategy.id, strategy.name, "error",
                "Gagal sign cancel orphaned order",
                `clientOrderIndex: ${orphan.client_order_index}, signErr: ${cancelSign.err}`
              );
            }
          } catch (cancelErr) {
            const errMsg = cancelErr instanceof Error ? cancelErr.message : String(cancelErr);
            if (shouldInvalidateNonce(cancelErr)) {
              invalidateNonceCache(botConfig.accountIndex!, botConfig.apiKeyIndex!, network);
            }
            logger.warn(
              { cancelErr: errMsg, strategyId: strategy.id, orderIndex, clientOrderIndex: orphan.client_order_index },
              "[syncOrderBookState] Gagal cancel orphaned exchange order — lanjut"
            );
            await addLog(userId, strategy.id, strategy.name, "error",
              "Error saat cancel orphaned order",
              `clientOrderIndex: ${orphan.client_order_index}: ${errMsg}`
            );
          }
        });
      });
      await Promise.all(cancelPromises);
    } else {
      logger.warn(
        { strategyId: strategy.id },
        "[syncOrderBookState] Orphaned orders ditemukan tapi credentials tidak lengkap — cancel dilewati"
      );
      await addLog(userId, strategy.id, strategy.name, "warn",
        `Orphaned orders ditemukan (${orphans.length}) tapi credentials tidak lengkap — cancel dilewati`,
        "Pastikan privateKey, apiKeyIndex, dan accountIndex sudah tersimpan di bot config"
      );
    }
  }

  // ── GHOST DETECTION: order di DB sebagai pending tapi tidak ada di exchange ──
  if (dbPending.length === 0) return;

  // BUG-FRESH-006: 30s grace period terlalu singkat saat sequencer lambat
  // (observed latency >30s selama network congestion). Dinaikkan ke 90s agar
  // order in-flight tidak salah dikategorikan ghost dan di-cancel prematur.
  const GRACE_PERIOD_MS = 90_000;
  const now = Date.now();
  const ghosts = dbPending.filter((trade: (typeof dbPending)[number]) => {
    if (activeClientIds.has(trade.clientOrderIndex!)) return false;
    const ageMs = now - new Date(trade.createdAt).getTime();
    return ageMs > GRACE_PERIOD_MS;
  });

  if (ghosts.length === 0) return;

  for (const ghost of ghosts) {
    await db.update(tradesTable)
      .set({
        status: "cancelled",
        errorMessage: "Order sync: tidak ditemukan di exchange active orders — kemungkinan sudah expire atau dibatalkan",
      })
      .where(eq(tradesTable.id, ghost.id));

    await addLog(
      userId,
      strategy.id,
      strategy.name,
      "warn",
      `Order sync: ghost pending di-clear`,
      `TradeId: ${ghost.id} | ClientOrderIndex: ${ghost.clientOrderIndex} | Side: ${ghost.side} | Price: ${ghost.price}`
    );

    // BUG-SYNC-001: Queue ghost orders untuk re-placement — identik dengan perlakuan di pollPendingTrades.
    // Ghost orders hilang dari exchange tanpa jalur sequencer-cancel, sehingga tidak pernah masuk
    // cancelledOrderReplays via pollPendingTrades. Tanpa ini, grid level bolong permanen.
    if (strategy.type === "grid" && runningBots.has(strategy.id)) {
      const q = cancelledOrderReplays.get(strategy.id) ?? [];
      q.push({
        side: ghost.side as "buy" | "sell",
        originalPrice: new Decimal(ghost.price),
        cancelledAt: new Date(),
        tradeId: ghost.id,
      });
      cancelledOrderReplays.set(strategy.id, q);
    }
  }

  logger.info(
    { strategyId: strategy.id, ghostCount: ghosts.length },
    "[syncOrderBookState] Ghost pending orders di-clear dari DB"
  );
}

export async function startBot(strategyId: number, options?: { isRestore?: boolean }): Promise<boolean | "starting"> {
  if (runningBots.has(strategyId)) return true;
  if (startingBots.has(strategyId)) return "starting";
  if (stoppingBots.has(strategyId)) return "starting";
  const stopVersionAtStart = stopVersions.get(strategyId) ?? 0;
  startingBots.add(strategyId);
  try {

  const strategy = await db.query.strategiesTable.findFirst({
    where: eq(strategiesTable.id, strategyId),
  });

  if (!strategy) return false;

  // ── Exchange guard: tolak strategy bukan milik Lighter ───────────────────────
  if (strategy.exchange !== "lighter") {
    logger.warn({ strategyId, exchange: strategy.exchange }, "[HokirecehProjects] startBot dipanggil untuk non-lighter strategy — diabaikan");
    return false;
  }

  // ── Pre-flight: validate amount against exchange minimums — HARD STOP ────────
  // If the configured amount is below the exchange minimum, the bot will never
  // place any orders. We refuse to start rather than let it run silently idle.
  {
    const userId = strategy.userId ?? null;
    let validationError: string | null = null;

    try {
      const botCfg = userId !== null ? await getBotConfig(userId).catch(() => null) : null;
      const network = botCfg?.network ?? "mainnet";
      const marketInfo = await getMarketInfo(strategy.marketIndex, network);
      // Fix #3: Log warning jika marketInfo null — terjadi saat market tidak ada
      // di fallback (non-BTC/ETH/SOL) dan market cache gagal fetch dari API.
      // Bot tetap bisa start tapi pre-flight validation amount dilewati.
      if (!marketInfo) {
        logger.warn(
          { strategyId, marketIndex: strategy.marketIndex },
          "[lighterBotEngine] getMarketInfo null di startBot — pre-flight validation dilewati, bot start tanpa cek minimum"
        );
      }

      if (marketInfo) {
        const lastPrice = marketInfo.lastTradePrice > 0 ? marketInfo.lastTradePrice : null;

        let amount = 0;
        let amountLabel = "";

        if (strategy.type === "grid") {
          amount = (strategy.gridConfig as any)?.amountPerGrid ?? 0;
          amountLabel = "amountPerGrid";
        }

        if (amount > 0) {
          // Check minQuoteAmount (amount is already in USDC)
          if (marketInfo.minQuoteAmount > 0 && amount < marketInfo.minQuoteAmount) {
            const recommended = Math.ceil(marketInfo.minQuoteAmount * 1.2);
            validationError = `${amountLabel} ($${amount}) di bawah minimum exchange ($${marketInfo.minQuoteAmount} USDC). Naikkan ke minimal $${recommended}.`;
          }

          // Check minBaseAmount using last known price
          if (!validationError && lastPrice && marketInfo.minBaseAmount > 0) {
            const estimatedSize = amount / lastPrice;
            if (estimatedSize < marketInfo.minBaseAmount) {
              const minNeeded = Math.ceil(marketInfo.minBaseAmount * lastPrice * 1.2 * 100) / 100;
              validationError = `${amountLabel} ($${amount}) terlalu kecil — estimasi ${estimatedSize.toFixed(6)} ${marketInfo.baseAsset} < minimum ${marketInfo.minBaseAmount} ${marketInfo.baseAsset}. Naikkan ke minimal $${minNeeded}.`;
            }
          }
        }
      }
    } catch (_err) {
      // Market info fetch failed — best-effort, don't block start
    }

    if (validationError) {
      await addLog(userId, strategyId, strategy.name, "error",
        `❌ Bot tidak dapat dimulai: ${validationError}`
      );
      throw new Error(`BOT_VALIDATION_FAILED: ${validationError}`);
    }
  }
  // ─────────────────────────────────────────────────────────────────────────────

  const isGrid = strategy.type === "grid";
  const intervalMs = GRID_FALLBACK_INTERVAL_MS;

  const nextRunAt = new Date(Date.now() + intervalMs);

  await db.update(strategiesTable)
    .set({ isRunning: true, isActive: true, updatedAt: new Date(), nextRunAt })
    .where(eq(strategiesTable.id, strategyId));

  // ── BUG-L-005: Restore grid state dari DB setelah restart ─────────────────
  // Jika gridLastLevel tersimpan di DB, pulihkan ke in-memory gridStates agar
  // tick pertama pasca restart tidak selalu "initialize" dan melewatkan satu trade.
  if (isGrid && strategy.gridLastLevel !== null && strategy.gridLastLevel !== undefined) {
    if (!gridStates.has(strategyId)) {
      gridStates.set(strategyId, { lastLevel: strategy.gridLastLevel, initializedAt: new Date() });
      logger.info(
        { strategyId, gridLastLevel: strategy.gridLastLevel },
        "[lighterBotEngine] Grid state restored dari DB setelah restart"
      );
    }
  }

  // LIGHTER-GAP-002: Sync order book state saat bot start (fire-and-forget)
  if (strategy.userId !== null && strategy.userId !== undefined) {
    syncOrderBookState(strategy.userId, strategy, "mainnet").catch((err) =>
      logger.warn({ err, strategyId }, "[startBot] syncOrderBookState error — bot tetap start")
    );
  }

  // Grid bots: register a WebSocket price callback for real-time level detection
  if (isGrid) {
    registerPriceCallback(
      strategy.marketIndex,
      strategyId,
      (_midPrice, _mktIdx) => {
        const now = Date.now();
        const last = wsGridLastTriggered.get(strategyId) ?? 0;
        if (now - last < WS_GRID_COOLDOWN_MS) return;
        if (!runningBots.has(strategyId)) return;
        wsGridLastTriggered.set(strategyId, now);
        runStrategyOnce(strategyId).catch((err) => logger.error({ err, strategyId }, "[LighterBot] WS price callback error"));
      },
    );
  }

  const timer = setInterval(async () => {
    const bot = runningBots.get(strategyId);
    if (!bot) return;
    await runStrategyOnce(strategyId);
    bot.nextRunAt = new Date(Date.now() + GRID_FALLBACK_INTERVAL_MS);
  }, intervalMs);

  const stopVersionNow = stopVersions.get(strategyId) ?? 0;
  if (stoppingBots.has(strategyId) || stopVersionNow !== stopVersionAtStart) {
    clearInterval(timer);
    if (isGrid) unregisterPriceCallback(strategy.marketIndex, strategyId);
    await db.update(strategiesTable)
      .set({ isRunning: false, updatedAt: new Date(), nextRunAt: null })
      .where(eq(strategiesTable.id, strategyId));
    logger.warn({ strategyId }, "[LighterBot] startBot dibatalkan — stop terjadi saat start, state di-rollback");
    return false;
  }

  runningBots.set(strategyId, { strategyId, timer, nextRunAt, startedAt: new Date() });

  const intervalLabel = `WebSocket realtime + ${GRID_FALLBACK_INTERVAL_MS / 60000} min fallback`;
  logger.info({ strategyId, type: strategy.type }, "Bot started");

  if (!options?.isRestore) {
    await addLog(strategy.userId ?? null, strategyId, strategy.name, "success", `Bot started`, `Mode: ${intervalLabel}`);
    if (strategy.userId !== null && strategy.userId !== undefined) {
      const notif = await getNotificationConfig(strategy.userId).catch(() => null);
      if (notif?.notifyOnStart) {
        await notifyUser(strategy.userId, formatBotStarted("lighter", strategy.name, strategy.type, strategy.marketSymbol));
      }
    }
  }

  setTimeout(() => {
    if (!runningBots.has(strategyId)) return;
    runStrategyOnce(strategyId).catch((err) => logger.error({ err, strategyId }, "[LighterBot] delayed initial run failed"));
  }, 2000);

  return true;

  } finally {
    startingBots.delete(strategyId);
  }
}

export async function stopBot(strategyId: number, skipDbUpdate = false): Promise<boolean> {
  stopVersions.set(strategyId, (stopVersions.get(strategyId) ?? 0) + 1);
  stoppingBots.add(strategyId);
  // LIGHTER-STOP-002: release lock sesegera mungkin setelah state bersih.
  // Cancel orders (paralel) & Telegram notify adalah housekeeping — tidak perlu menahan lock.
  let lockReleased = false;
  const releaseLock = () => {
    if (!lockReleased) { lockReleased = true; stoppingBots.delete(strategyId); }
  };
  try {
  const bot = runningBots.get(strategyId);
  if (bot) {
    clearInterval(bot.timer);
    runningBots.delete(strategyId);
  }
  gridStates.delete(strategyId);
  lighterSkewStates.delete(strategyId);
  lighterFollowMarketStates.delete(strategyId);
  wsGridLastTriggered.delete(strategyId);
  // BUG-FRESH-002: Clear replay queue on stop agar entries dari range lama tidak
  // di-re-place setelah bot restart dengan config range baru (post-rerange).
  cancelledOrderReplays.delete(strategyId);

  const strategy = await db.query.strategiesTable.findFirst({
    where: eq(strategiesTable.id, strategyId),
  });

  // Reset auto-rerange state saat bot di-stop/pause karena alasan apapun.
  // Jika ada pending rerange yang menunggu konfirmasi Telegram, kirim notifikasi
  // bahwa konfirmasi itu sudah tidak berlaku sebelum state di-clear.
  await cancelPendingRerangeOnStop(strategyId, strategy?.userId ?? null, strategy?.name ?? "");

  // Unregister WebSocket callback for grid bots
  if (strategy?.type === "grid") {
    unregisterPriceCallback(strategy.marketIndex, strategyId);
  }

  if (!skipDbUpdate) {
    await db.update(strategiesTable)
      .set({ isRunning: false, updatedAt: new Date(), nextRunAt: null })
      .where(eq(strategiesTable.id, strategyId));
  }

  // State sudah bersih — lepas lock agar startBot tidak terblok housekeeping.
  releaseLock();

  // Cancel semua pending orders di exchange saat bot dihentikan
  if (strategy?.userId !== null && strategy?.userId !== undefined) {
    try {
      const cancelConfig = await getBotConfig(strategy.userId!);
      if (cancelConfig?.privateKey && cancelConfig?.accountIndex != null && cancelConfig?.apiKeyIndex != null) {
        const pendingTrades = await db.query.tradesTable.findMany({
          where: and(
            eq(tradesTable.strategyId, strategyId),
            eq(tradesTable.status, "pending"),
            isNotNull(tradesTable.clientOrderIndex),
          ),
        });
        if (pendingTrades.length > 0) {
          const network: Network = "mainnet";
          initSigner(getBaseUrl(network), cancelConfig.privateKey, cancelConfig.apiKeyIndex, cancelConfig.accountIndex);
          // NONCE-OOO-001 FIX: Lighter mensyaratkan new_nonce = old_nonce + 1 (docs: signing-transactions.md).
          // Sebelumnya: Promise.allSettled (parallel sendTx) → nonce N+1 bisa tiba sebelum N → sequencer reject.
          // Fix: gunakan enqueueOrphanCancel (atomic acquire+send per entry, serial per account+apikey).
          // enqueueOrphanCancel chains setiap cancel ke global serial chain → setiap acquire+send atomic.
          // Promise.all dari hasil enqueue hanya menunggu selesai; eksekusi aktual tetap serial.
          const cancelPromises = pendingTrades
            .filter((t: any) => t.clientOrderIndex !== null && t.clientOrderIndex !== undefined)
            .map((trade: any) =>
              enqueueOrphanCancel(cancelConfig.accountIndex!, cancelConfig.apiKeyIndex!, network, async () => {
                try {
                  const cancelNonce = await acquireNonce(cancelConfig.accountIndex!, cancelConfig.apiKeyIndex!, network);
                  // L-005 FIX: Prioritaskan lighterOrderIndex (exchange-assigned, dari syncOrderBookState).
                  // Fallback ke clientOrderIndex untuk order lama yang belum sempat di-populate.
                  const cancelOrderIdx = trade.lighterOrderIndex ?? trade.clientOrderIndex!;
                  const cancelSign = signCancelOrder({
                    marketIndex: trade.marketIndex,
                    orderIndex: cancelOrderIdx,
                    nonce: cancelNonce,
                    apiKeyIndex: cancelConfig.apiKeyIndex!,
                    accountIndex: cancelConfig.accountIndex!,
                  });
                  if (!cancelSign.err) {
                    await sendTx(cancelSign.txType, cancelSign.txInfo, network, false);
                    // AUDIT-L-002: Set status="cancelled" (bukan hanya errorMessage) agar
                    // pollPendingTrades tidak memproses ulang trade ini setelah bot stop+restart.
                    // Tanpa ini, setelah sequencer konfirmasi cancel (txStatus=0), trade masuk
                    // cancelledOrderReplays dan bisa di-replay di grid range lama pasca rerange.
                    await db.update(tradesTable)
                      .set({ status: "cancelled", errorMessage: "Bot dihentikan — cancel order dikirim ke exchange" })
                      .where(eq(tradesTable.id, trade.id));
                    logger.info({ strategyId, tradeId: trade.id }, "[LighterBot] Cancel order dikirim saat stopBot");
                  }
                } catch (cancelErr) {
                  if (shouldInvalidateNonce(cancelErr)) {
                    invalidateNonceCache(cancelConfig.accountIndex!, cancelConfig.apiKeyIndex!, network);
                  }
                  logger.warn(
                    {
                      cancelErr: cancelErr instanceof Error ? cancelErr.message : String(cancelErr),
                      strategyId,
                      tradeId: trade.id,
                    },
                    "[LighterBot] Gagal cancel 1 order saat stopBot — lanjut"
                  );
                }
              })
            );
          await Promise.all(cancelPromises);
          await addLog(strategy.userId!, strategyId, strategy.name, "info",
            `${pendingTrades.length} open order dikirim cancel saat bot dihentikan`, "");
        }
      }
    } catch (err) {
      logger.warn({ err, strategyId }, "[LighterBot] Mass cancel on stop gagal — open orders mungkin masih aktif di exchange");
    }
  }

  if (strategy) {
    await addLog(strategy.userId ?? null, strategyId, strategy.name, "warn", "Bot stopped");
    if (strategy.userId !== null && strategy.userId !== undefined) {
      const notif = await getNotificationConfig(strategy.userId).catch(() => null);
      if (notif?.notifyOnStop) {
        await notifyUser(strategy.userId, formatBotStopped("lighter", strategy.name, strategy.marketSymbol));
      }
    }
  }

  return true;
  } finally {
    releaseLock(); // safety net: jika exception sebelum releaseLock() di atas
  }
}

export async function restoreRunningBots() {
  const strategies = await db.query.strategiesTable.findMany({
    where: and(
      eq(strategiesTable.isRunning, true),
      eq(strategiesTable.exchange, "lighter")
    ),
  });

  for (const strategy of strategies) {
    logger.info({ strategyId: strategy.id }, "Restoring running bot");
    try {
      await startBot(strategy.id, { isRestore: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isValidationFail = message.startsWith("BOT_VALIDATION_FAILED:");

      logger.error({ strategyId: strategy.id, err }, "Failed to restore bot");

      // Mark as stopped in DB so it won't be retried on next restart
      await db
        .update(strategiesTable)
        .set({ isRunning: false, updatedAt: new Date(), nextRunAt: null })
        .where(eq(strategiesTable.id, strategy.id));

      if (isValidationFail) {
        // Log already written by startBot — no duplicate needed
        logger.warn(
          { strategyId: strategy.id, reason: message },
          "Bot config outdated after restart — marked as stopped. User must review settings."
        );
      }
    }
  }

  // LIGHTER-GAP-001: Pre-populate cancelledOrderReplays from recent cancelled/failed
  // lighter grid trades — handles orders that were cancelled while server was down.
  try {
    const runningGridIds = new Set<number>();
    for (const s of strategies) {
      if (s.type === "grid") runningGridIds.add(s.id);
    }
    if (runningGridIds.size > 0) {
      const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
      const recentCancelled = await db.query.tradesTable.findMany({
        where: and(
          eq(tradesTable.exchange, "lighter"),
          gte(tradesTable.createdAt, cutoff),
          inArray(tradesTable.status, ["failed", "cancelled"])
        ),
      });
      // LIG-RESTORE-RANGE-001: Buat Map strategyId → grid range untuk range check O(1) per trade.
      // Trades dari sesi lama dengan harga di luar range grid saat ini tidak perlu di-place ulang.
      const strategyGridConfig = new Map<number, { lower: Decimal; upper: Decimal } | null>();
      for (const s of strategies) {
        if (s.type !== "grid") continue;
        const cfg = s.gridConfig as { lowerPrice?: number; upperPrice?: number } | null;
        strategyGridConfig.set(
          s.id,
          cfg?.lowerPrice != null && cfg?.upperPrice != null
            ? { lower: new Decimal(cfg.lowerPrice), upper: new Decimal(cfg.upperPrice) }
            : null
        );
      }
      for (const trade of recentCancelled) {
        if (trade.strategyId === null) continue;
        if (!runningGridIds.has(trade.strategyId)) continue;
        const errMsgLower = (trade.errorMessage ?? "").toLowerCase();
        if (errMsgLower.includes("margin") || errMsgLower.includes("insufficient")) continue;
        // LIG-RESTORE-RANGE-001: Skip trade yang harganya di luar range grid saat ini.
        // Contoh: BTC trade dari sesi lama di $98K saat grid sekarang $71K-$78K → skip.
        const tradePrice = new Decimal(trade.price);
        const rangeCfg = strategyGridConfig.get(trade.strategyId);
        if (rangeCfg && (tradePrice.lt(rangeCfg.lower) || tradePrice.gt(rangeCfg.upper))) {
          logger.info(
            { strategyId: trade.strategyId, price: trade.price, lower: rangeCfg.lower.toFixed(4), upper: rangeCfg.upper.toFixed(4) },
            "[restoreRunningBots] LIG-RESTORE-RANGE-001: Skip trade di luar grid range"
          );
          continue;
        }
        const q = cancelledOrderReplays.get(trade.strategyId) ?? [];
        q.push({
          side: trade.side as "buy" | "sell",
          originalPrice: tradePrice,
          cancelledAt: new Date(trade.createdAt),
          tradeId: trade.id,
        });
        cancelledOrderReplays.set(trade.strategyId, q);
      }
      const totalQueued = [...cancelledOrderReplays.values()].reduce((s, a) => s + a.length, 0);
      if (totalQueued > 0) {
        logger.info({ totalQueued }, "[restoreRunningBots] Pre-populated cancelledOrderReplays from recent cancelled trades");
      }
    }
  } catch (err) {
    logger.warn({ err }, "[restoreRunningBots] Gagal pre-populate cancelledOrderReplays — lanjut tanpa replay queue");
  }
}

const LOG_RETENTION_DAYS = 30;
const TRADE_RETENTION_DAYS = 90;

export async function cleanupOldLogs() {
  try {
    const cutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    await db.delete(botLogsTable).where(lt(botLogsTable.createdAt, cutoff));
    logger.info({ cutoff }, "Old bot logs cleaned up");

    const tradeCutoff = new Date(Date.now() - TRADE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    await db.delete(tradesTable).where(
      and(
        lt(tradesTable.createdAt, tradeCutoff),
        ne(tradesTable.status, "pending")
      )
    );
    logger.info({ tradeCutoff }, "Old trade records cleaned up");
  } catch (err) {
    logger.error({ err }, "Failed to cleanup old logs");
  }
}

export function startLogCleanupSchedule() {
  cleanupOldLogs();
  setInterval(cleanupOldLogs, 24 * 60 * 60 * 1000);
}

// ─── TRADE STATUS POLLING ───────────────────────────────────────────────────
// Lighter transaction status codes (from official docs):
//   0 = Failed / Cancelled by sequencer
//   1 = Pending
//   2 = Executed (filled)
//   3 = Pending - Final State
//
// BUG FIX: timeout check MUST come AFTER getTx, not before.
// Previously the timeout fired before calling getTx, meaning a filled order
// that had a slow indexer would be marked "failed" without ever being re-checked.
// Correct order: (1) call getTx, (2) act on status, (3) only if getTx returns
// null AND age > timeout, THEN mark as timed-out.

const TRADE_POLL_INTERVAL_MS = 5_000;   // 5 s — fast enough for IOC market orders
const TRADE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes — trade polling timeout

let isPollRunning = false;

export async function pollPendingTrades() {
  if (isPollRunning) {
    logger.warn("pollPendingTrades skipped — previous cycle still running");
    return;
  }
  isPollRunning = true;
  try {
    const pendingTrades = await db.query.tradesTable.findMany({
      where: and(
        eq(tradesTable.status, "pending"),
        eq(tradesTable.exchange, "lighter"),
        isNotNull(tradesTable.orderHash),
        ne(tradesTable.orderHash, "")
      ),
    });

    if (pendingTrades.length === 0) return;

    // Group unique userIds to look up network config per user
    const uniqueUserIds = [...new Set<number>(
      pendingTrades
        .map((t: typeof tradesTable.$inferSelect) => t.userId)
        .filter((id: number | null): id is number => id !== null)
    )];

    // INFO-FEE-001 FIX: Simpan juga accountIndex agar bisa lookup account_type di fee calculation.
    const networkByUserId = new Map<number, "mainnet">();
    const accountIndexByUserId = new Map<number, number | null>();
    await Promise.all(
      uniqueUserIds.map(async (userId) => {
        try {
          const config = await getBotConfig(userId);
          networkByUserId.set(userId, config.network);
          accountIndexByUserId.set(userId, config.accountIndex ?? null);
        } catch {
          networkByUserId.set(userId, "mainnet");
          accountIndexByUserId.set(userId, null);
        }
      })
    );

    for (const trade of pendingTrades) {
      const orderHash = trade.orderHash!;

      // Skip paper trades
      if (orderHash.startsWith("paper_")) continue;

      // Skip Extended DEX trades — dikelola oleh pollPendingExtendedTrades() di extendedBotEngine.ts
      if (orderHash.startsWith("ext_")) continue;
      if (orderHash.startsWith("eth_")) continue;

      const network = trade.userId !== null
        ? (networkByUserId.get(trade.userId) ?? "mainnet")
        : "mainnet";

      const ageMs = Date.now() - new Date(trade.createdAt).getTime();

      // STEP 1: Always call getTx first — never skip it for timeouts
      // Wrap per-trade so a 429 on one trade doesn't abort the entire poll cycle
      let txResponse;
      try {
        txResponse = await getTx("hash", orderHash, network);
      } catch (fetchErr) {
        if (ageMs > TRADE_TIMEOUT_MS) {
          await db.update(tradesTable)
            .set({ status: "failed", errorMessage: "Order timed out — Lighter API tidak dapat dikonfirmasi setelah 30 menit" })
            .where(eq(tradesTable.id, trade.id));

          await addLog(
            trade.userId ?? null,
            trade.strategyId,
            trade.strategyName,
            "error",
            `${trade.side.toUpperCase()} order timed out`,
            `TxHash: ${orderHash} | Lighter API error setelah 30 menit — cek exchange langsung`
          );

          logger.warn({ tradeId: trade.id, orderHash }, "Trade timed out — Lighter API error after 30 min");
        } else {
          logger.warn({ fetchErr, tradeId: trade.id, orderHash }, "getTx failed — skip trade this cycle, retry next");
        }
        continue;
      }

      // EnrichedTx response is flat — check txResponse.hash (required field) to confirm Lighter indexed it
      if (!txResponse || !txResponse.hash) {
        // Lighter hasn't indexed this tx yet (or network error)
        // ONLY mark as timed-out if we've been waiting too long with no response
        if (ageMs > TRADE_TIMEOUT_MS) {
          await db.update(tradesTable)
            .set({ status: "failed", errorMessage: "Order timed out — Lighter did not index this tx after 30 minutes" })
            .where(eq(tradesTable.id, trade.id));

          await addLog(
            trade.userId ?? null,
            trade.strategyId,
            trade.strategyName,
            "error",
            `${trade.side.toUpperCase()} order timed out`,
            `TxHash: ${orderHash} | Lighter returned no data after 30 minutes — check exchange directly`
          );

          logger.warn({ tradeId: trade.id, orderHash }, "Trade timed out — no Lighter indexer data after 30 min");
        }
        // else: still within timeout window, keep polling next cycle
        continue;
      }

      // STEP 2: We have a definitive response from Lighter — act on it (fields are flat at root)
      const txStatus = txResponse.status;
      const executedAt = txResponse.executed_at;

      // Lighter tx status:
      //   0 = Failed/Cancelled
      //   1 = Queued/Pending
      //   2 = Committed & L1-verified (full finality)
      //   3 = Committed to L2 (trade has happened, awaiting L1 batch proof)
      //
      // Status 3 with executed_at set = order has been processed on L2.
      // From a trading perspective this IS "filled" — L1 proof is a formality.
      const isFilled = txStatus === 2 || (txStatus === 3 && !!executedAt);

      if (isFilled) {
        // BUG-POLL-003: executedAt is optional in LighterTxResponse — txStatus=2 can arrive without it.
        // Fallback to poll time (new Date()) is the best available approximation, but logged as warning
        // so the gap is observable if Lighter indexer ever omits executed_at on a confirmed fill.
        if (!executedAt) {
          logger.warn(
            { tradeId: trade.id, orderHash, txStatus },
            "executedAt missing for filled order — storing poll time as fallback (BUG-POLL-003)"
          );
        }
        const execTime = executedAt ? new Date(executedAt) : new Date();
        await db.update(tradesTable)
          .set({ status: "filled", executedAt: execTime })
          .where(eq(tradesTable.id, trade.id));

        await addLog(
          trade.userId ?? null,
          trade.strategyId,
          trade.strategyName,
          "success",
          `${trade.side.toUpperCase()} order confirmed (filled)`,
          `TxHash: ${orderHash} | Size: ${trade.size} | Price: ${trade.price} | L2 status: ${txStatus}`
        );

        // Update strategy stats now that the order is confirmed filled
        try {
          const stratForMode = trade.strategyId
            ? await db.query.strategiesTable.findFirst({
                where: eq(strategiesTable.id, trade.strategyId),
                columns: { gridConfig: true },
              })
            : null;
          const tradeMode = (stratForMode?.gridConfig as any)?.mode ?? "neutral";
          await updateStrategyStatsAtomic(
            trade.strategyId,
            trade.side as "buy" | "sell",
            new Decimal(trade.size),
            new Decimal(trade.price),
            tradeMode
          );
        } catch (e) {
          logger.warn({ tradeId: trade.id }, "Failed to update strategy stats after fill");
        }

        // F2: Budget Cap — track fee, stop bot if limit reached
        // LIG-TAKER-FEE-001 FIX: apply taker rate for market orders, maker rate for limit/post_only
        // INFO-FEE-001 FIX: Standard Account (account_type=0) = fee 0%; skip fee deduction dari budget.
        if (trade.strategyId !== null) {
          try {
            const acctIdx = trade.userId !== null ? (accountIndexByUserId.get(trade.userId) ?? null) : null;
            const acctType = acctIdx !== null
              ? await getCachedAccountType(acctIdx, network)
              : 1; // unknown → assume Premium (conservative)
            const isStandardAccount = acctType === 0;
            const baseFeeRate = trade.orderKind === "market" ? LIGHTER_TAKER_FEE_RATE : LIGHTER_MAKER_FEE_RATE;
            const feeRate = isStandardAccount ? 0 : baseFeeRate; // Standard: 0% fee per docs trading-fees.md
            const budget = await trackBudgetSpend(
              trade.strategyId, new Decimal(trade.size), new Decimal(trade.price), feeRate
            );
            if (budget.exceeded) {
              // AUDIT-L-001: Panggil stopBot() (bukan hanya db.update) agar timer, WS callback,
              // dan in-memory runningBots benar-benar dibersihkan. DB-only update meninggalkan
              // bot "zombie" — timer masih jalan dan order baru terus dikirim meski budget habis.
              await addLog(trade.userId ?? null, trade.strategyId, trade.strategyName, "warn",
                "Budget Cap tercapai — bot dihentikan otomatis",
                `Terpakai: $${budget.newSpentUsd.toFixed(2)} dari $${budget.maxBudgetUsd?.toFixed(2)}`
              );
              await notifyUser(trade.userId,
                `🛑 Budget Cap tercapai: $${budget.newSpentUsd.toFixed(2)} dari $${budget.maxBudgetUsd?.toFixed(2)} — bot dihentikan otomatis.`
              );
              stopBot(trade.strategyId).catch((err) =>
                logger.warn({ err, strategyId: trade.strategyId }, "[LighterBot] stopBot setelah budget cap gagal — state mungkin tidak bersih")
              );
            }
          } catch (budgetErr) {
            logger.warn({ tradeId: trade.id }, "Budget tracking failed — non-critical");
          }
        }

        // F3: Inventory Skew — update cumulative qty on fill
        if (trade.strategyId !== null) {
          const sk = lighterSkewStates.get(trade.strategyId) ?? { cumulativeBuyQty: new Decimal(0), cumulativeSellQty: new Decimal(0) };
          if (trade.side === "buy") sk.cumulativeBuyQty = sk.cumulativeBuyQty.add(new Decimal(trade.size));
          else sk.cumulativeSellQty = sk.cumulativeSellQty.add(new Decimal(trade.size));
          lighterSkewStates.set(trade.strategyId, sk);
        }

        // Notify user via Telegram (respect notifyOnBuy / notifyOnSell settings)
        if (trade.userId !== null) {
          const notif = await getNotificationConfig(trade.userId).catch(() => null);
          const shouldNotify = trade.side === "buy"
            ? (notif?.notifyOnBuy ?? true)
            : (notif?.notifyOnSell ?? true);
          if (shouldNotify) {
            await notifyUser(
              trade.userId,
              formatOrderFilled("lighter", trade.side, trade.size, trade.marketSymbol, trade.price)
            );
          }
        }

        logger.info({ tradeId: trade.id, orderHash, txStatus }, "Trade confirmed as filled");

      } else if (txStatus === 0) {
        // Failed / cancelled by sequencer (includes IOC not filled, margin rejected, etc.)
        // MARGIN-LOOP-001 FIX: Cek event_info untuk deteksi margin-related cancel.
        // Docs (data-structures-constants-and-errors.md): OrderExecution.ae (AppError string)
        // dan Order.st (status code: 8=MarginNotAllowed, 16=InvalidBalance).
        const isMarginCancel = isMarginRelatedCancel(txResponse.event_info);
        const cancelReason = isMarginCancel
          ? "Order cancelled by sequencer — margin/balance insufficient (tidak di-replay untuk menghindari infinite retry)"
          : "Order cancelled/failed by Lighter sequencer (status=0)";

        await db.update(tradesTable)
          .set({ status: "cancelled", errorMessage: cancelReason })
          .where(eq(tradesTable.id, trade.id));

        await addLog(
          trade.userId ?? null,
          trade.strategyId,
          trade.strategyName,
          "warn",
          `${trade.side.toUpperCase()} order cancelled by sequencer${isMarginCancel ? " (margin/balance)" : ""}`,
          `TxHash: ${orderHash} | ${isMarginCancel ? "Margin/balance tidak cukup — order TIDAK di-queue untuk replay" : "IOC order may have found no liquidity"}`
        );

        logger.warn({ tradeId: trade.id, orderHash, txStatus, isMarginCancel }, "Trade cancelled by Lighter sequencer");

        // LIGHTER-GAP-001: Queue for grid order re-placement.
        // MARGIN-LOOP-001 FIX: Skip queue jika margin-related cancel — re-placing order
        // yang sama akan ditolak lagi oleh sequencer → infinite retry loop yang menguras
        // rate limit (4000 req/menit Premium per docs rate-limits.md: sendTx weight=6,
        // default tx limit = 40 req/menit → ~6 retry cycles sebelum 429).
        if (!isMarginCancel && trade.strategyId !== null && runningBots.has(trade.strategyId)) {
          const st = await db.query.strategiesTable.findFirst({
            where: eq(strategiesTable.id, trade.strategyId),
            columns: { type: true, exchange: true },
          });
          if (st?.type === "grid" && st?.exchange === "lighter") {
            const q = cancelledOrderReplays.get(trade.strategyId) ?? [];
            q.push({ side: trade.side as "buy" | "sell", originalPrice: new Decimal(trade.price), cancelledAt: new Date(), tradeId: trade.id });
            cancelledOrderReplays.set(trade.strategyId, q);
          }
        }

      } else if (txStatus === 3 && ageMs > TRADE_TIMEOUT_MS) {
        // BUG-POLL-001: txStatus=3 means the order is committed to L2 — execution has happened,
        // L1 batch proof is just pending. executedAt never arrived from Lighter indexer after 30 min.
        // Treat as filled (not failed) — marking failed + replaying would cause double-placement.
        // executedAt is estimated (poll time), not the actual fill time — logged as warning.
        const execTime = new Date();
        await db.update(tradesTable)
          .set({ status: "filled", executedAt: execTime })
          .where(eq(tradesTable.id, trade.id));

        await addLog(
          trade.userId ?? null,
          trade.strategyId,
          trade.strategyName,
          "warn",
          `${trade.side.toUpperCase()} order assumed filled (txStatus=3, executedAt missing after 30min — L2 committed, L1 proof pending)`,
          `TxHash: ${orderHash} | Size: ${trade.size} | Price: ${trade.price} | executedAt estimated — Lighter indexer may have a delay`
        );

        try {
          const stratForMode = trade.strategyId
            ? await db.query.strategiesTable.findFirst({
                where: eq(strategiesTable.id, trade.strategyId),
                columns: { gridConfig: true },
              })
            : null;
          const tradeMode = (stratForMode?.gridConfig as any)?.mode ?? "neutral";
          await updateStrategyStatsAtomic(
            trade.strategyId,
            trade.side as "buy" | "sell",
            new Decimal(trade.size),
            new Decimal(trade.price),
            tradeMode
          );
        } catch (e) {
          logger.warn({ tradeId: trade.id }, "Failed to update strategy stats after assumed fill (BUG-POLL-001)");
        }

        // F2: Budget Cap — track fee for BUG-POLL-001 assumed fill path (AUDIT-L-001)
        // LIG-TAKER-FEE-001 FIX: apply taker rate for market orders, maker rate for limit/post_only
        // INFO-FEE-001 FIX: Standard Account (account_type=0) = fee 0%.
        if (trade.strategyId !== null) {
          try {
            const acctIdx2 = trade.userId !== null ? (accountIndexByUserId.get(trade.userId) ?? null) : null;
            const acctType2 = acctIdx2 !== null
              ? await getCachedAccountType(acctIdx2, network)
              : 1; // unknown → assume Premium (conservative)
            const isStandardAccount2 = acctType2 === 0;
            const baseFeeRate2 = trade.orderKind === "market" ? LIGHTER_TAKER_FEE_RATE : LIGHTER_MAKER_FEE_RATE;
            const feeRate = isStandardAccount2 ? 0 : baseFeeRate2;
            const budget = await trackBudgetSpend(
              trade.strategyId, new Decimal(trade.size), new Decimal(trade.price), feeRate
            );
            if (budget.exceeded) {
              await addLog(trade.userId ?? null, trade.strategyId, trade.strategyName, "warn",
                "Budget Cap tercapai — bot dihentikan otomatis",
                `Terpakai: $${budget.newSpentUsd.toFixed(2)} dari $${budget.maxBudgetUsd?.toFixed(2)}`
              );
              await notifyUser(trade.userId,
                `🛑 Budget Cap tercapai: $${budget.newSpentUsd.toFixed(2)} dari $${budget.maxBudgetUsd?.toFixed(2)} — bot dihentikan otomatis.`
              );
              stopBot(trade.strategyId).catch((err) =>
                logger.warn({ err, strategyId: trade.strategyId }, "[LighterBot] stopBot setelah budget cap (POLL-001 path) gagal")
              );
            }
          } catch (budgetErr) {
            logger.warn({ tradeId: trade.id }, "Budget tracking failed (BUG-POLL-001 path) — non-critical");
          }
        }

        // F3: Inventory Skew — update cumulative qty on fill (BUG-POLL-001 path)
        if (trade.strategyId !== null) {
          const sk = lighterSkewStates.get(trade.strategyId) ?? { cumulativeBuyQty: new Decimal(0), cumulativeSellQty: new Decimal(0) };
          if (trade.side === "buy") sk.cumulativeBuyQty = sk.cumulativeBuyQty.add(new Decimal(trade.size));
          else sk.cumulativeSellQty = sk.cumulativeSellQty.add(new Decimal(trade.size));
          lighterSkewStates.set(trade.strategyId, sk);
        }

        if (trade.userId !== null) {
          const notif = await getNotificationConfig(trade.userId).catch(() => null);
          const shouldNotify = trade.side === "buy"
            ? (notif?.notifyOnBuy ?? true)
            : (notif?.notifyOnSell ?? true);
          if (shouldNotify) {
            await notifyUser(
              trade.userId,
              formatOrderFilled("lighter", trade.side, trade.size, trade.marketSymbol, trade.price)
            );
          }
        }

        logger.warn({ tradeId: trade.id, orderHash, ageMs }, "Trade assumed filled — txStatus=3 committed to L2, executedAt missing after 30min (BUG-POLL-001)");

      } else if (ageMs > TRADE_TIMEOUT_MS) {
        // LIGHTER-POLL-001: Fallback timeout — Lighter returned a valid tx response but
        // the order never resolved after 30 minutes. Covers:
        //   - txStatus === 1 (Queued/stuck): order accepted but never executed
        //   - txStatus === undefined: API anomaly, field is optional in LighterTxResponse
        // Without this guard these orders stay "pending" forever — no cleanup path existed.
        // Note: txStatus === 3 without executed_at is handled by the branch above (BUG-POLL-001).

        // Best-effort cancel on Lighter exchange before marking failed in our DB.
        // This closes the order on the exchange side, not just in our records.
        // Requires clientOrderIndex (stored at order creation) and user credentials.
        // Failure to cancel does NOT block DB cleanup — we mark failed regardless.
        if ((trade.lighterOrderIndex !== null || trade.clientOrderIndex !== null) && trade.userId !== null) {
          try {
            const cancelConfig = await getBotConfig(trade.userId);
            if (cancelConfig?.privateKey && cancelConfig?.accountIndex != null && cancelConfig?.apiKeyIndex != null) {
              initSigner(getBaseUrl(network), cancelConfig.privateKey, cancelConfig.apiKeyIndex, cancelConfig.accountIndex);
              const cancelNonce = await acquireNonce(cancelConfig.accountIndex, cancelConfig.apiKeyIndex, network);
              // LIG-006 FIX: Prioritaskan lighterOrderIndex (exchange-assigned, dari syncOrderBookState).
              // Fallback ke clientOrderIndex untuk order lama yang belum sempat di-populate.
              // Konsisten dengan stopBot (line 2036) dan F4 re-anchor (line 1240).
              const cancelOrderIdx = trade.lighterOrderIndex ?? trade.clientOrderIndex!;
              const cancelSign = signCancelOrder({
                marketIndex: trade.marketIndex,
                orderIndex: cancelOrderIdx,
                nonce: cancelNonce,
                apiKeyIndex: cancelConfig.apiKeyIndex,
                accountIndex: cancelConfig.accountIndex,
              });
              if (!cancelSign.err) {
                await sendTx(cancelSign.txType, cancelSign.txInfo, network, false);
                logger.info(
                  { tradeId: trade.id, orderHash, cancelOrderIdx, clientOrderIndex: trade.clientOrderIndex },
                  "Cancel submitted to Lighter for timed-out order"
                );
              } else {
                logger.warn(
                  { tradeId: trade.id, clientOrderIndex: trade.clientOrderIndex, signErr: cancelSign.err },
                  "Failed to sign cancel for timed-out order — marking failed anyway"
                );
              }
            }
          } catch (cancelErr) {
            logger.warn(
              {
                tradeId: trade.id,
                orderHash,
                cancelErr: cancelErr instanceof Error ? cancelErr.message : String(cancelErr),
              },
              "Best-effort Lighter cancel threw — marking failed anyway"
            );
          }
        }

        await db.update(tradesTable)
          .set({
            status: "failed",
            errorMessage: `Order timeout setelah 30 menit — Lighter status: ${txStatus ?? "unknown"}`
          })
          .where(eq(tradesTable.id, trade.id));

        await addLog(
          trade.userId ?? null,
          trade.strategyId,
          trade.strategyName,
          "error",
          `${trade.side.toUpperCase()} order stuck/timeout`,
          `TxHash: ${orderHash} | L2 status: ${txStatus ?? "unknown"} | Usia: ${Math.round(ageMs / 60000)} menit — tidak ada konfirmasi fill`
        );

        logger.warn({ tradeId: trade.id, orderHash, txStatus, ageMs }, "Trade timed out — stuck in unresolved L2 state after 30 min");

        // LIGHTER-GAP-001: Queue for grid order re-placement after timeout.
        // MARGIN-LOOP-001 FIX: Skip queue jika event_info menunjukkan margin-related issue —
        // order stuck karena margin lebih baik tidak di-replay (akan ditolak lagi).
        const isTimeoutMarginCancel = isMarginRelatedCancel(txResponse.event_info);
        if (!isTimeoutMarginCancel && trade.strategyId !== null && runningBots.has(trade.strategyId)) {
          const st = await db.query.strategiesTable.findFirst({
            where: eq(strategiesTable.id, trade.strategyId),
            columns: { type: true, exchange: true },
          });
          if (st?.type === "grid" && st?.exchange === "lighter") {
            const q = cancelledOrderReplays.get(trade.strategyId) ?? [];
            q.push({ side: trade.side as "buy" | "sell", originalPrice: new Decimal(trade.price), cancelledAt: new Date(), tradeId: trade.id });
            cancelledOrderReplays.set(trade.strategyId, q);
          }
        }

      }
      // txStatus === 1 (Queued) atau txStatus === 3 tanpa executed_at — masih dalam window 30 menit → keep polling
    }
  } catch (err) {
    logger.error({ err }, "Error during pending trade poll");
  } finally {
    isPollRunning = false;
  }
}

// LIGHTER-GAP-001: Re-place cancelled/timed-out grid orders.
// Drains cancelledOrderReplays, re-fetches fresh price, checks duplicates,
// then calls executeLiveOrder per entry. Runs every REPLAY_INTERVAL_MS.
async function replayExpiredGridOrders(): Promise<void> {
  if (cancelledOrderReplays.size === 0) return;

  // Drain atomically — new entries queued while we process go to next cycle
  const snapshot = new Map(cancelledOrderReplays);
  cancelledOrderReplays.clear();

  for (const [strategyId, entries] of snapshot) {
    if (!runningBots.has(strategyId)) continue;

    // Re-fetch strategy from DB — definitive check
    const strategy = await db.query.strategiesTable.findFirst({
      where: eq(strategiesTable.id, strategyId),
    });
    if (!strategy || !strategy.isRunning || strategy.type !== "grid" || strategy.exchange !== "lighter") continue;
    if (!runningBots.has(strategyId)) continue; // re-check after await

    const config = strategy.gridConfig as any;
    if (!config?.lowerPrice || !config?.upperPrice || !config?.gridLevels) continue;

    const lower = new Decimal(config.lowerPrice);
    const upper = new Decimal(config.upperPrice);
    const gridSpacing = upper.sub(lower).div(config.gridLevels);
    const amountPerGrid = new Decimal(config.amountPerGrid ?? 0);

    const userId = strategy.userId ?? null;
    const botConfig = userId !== null ? await getBotConfig(userId).catch(() => null) : null;
    if (!botConfig?.privateKey || botConfig.accountIndex === null) {
      // BUG-REPLAY-002: credentials sementara tidak tersedia (transient) — re-queue entries
      // agar cycle berikutnya mencoba lagi. Jangan drop permanen.
      logger.warn({ strategyId }, "[replayExpiredGridOrders] credentials tidak tersedia — entries di-re-queue");
      const existing = cancelledOrderReplays.get(strategyId) ?? [];
      cancelledOrderReplays.set(strategyId, [...existing, ...entries]);
      continue;
    }

    const network: Network = botConfig.network ?? "mainnet";

    const currentPrice = await getCurrentPrice(strategy.marketIndex, network);
    if (!currentPrice || currentPrice.lte(0)) {
      // BUG-REPLAY-002: price fetch gagal (transient) — re-queue entries, jangan drop.
      await addLog(userId, strategyId, strategy.name, "warn",
        "replayExpiredGridOrders: tidak bisa fetch harga — entries di-re-queue untuk cycle berikutnya");
      const existing = cancelledOrderReplays.get(strategyId) ?? [];
      cancelledOrderReplays.set(strategyId, [...existing, ...entries]);
      continue;
    }

    // BUG-REPLAY-002: Saat harga keluar range, re-queue entries (jangan drop permanen).
    // Jika harga sementara keluar range lalu kembali tanpa rerange, grid level yang
    // cancelled harus tetap ada untuk di-re-place. Jika rerange dikonfirmasi user →
    // stopBot dipanggil → runningBots.delete() → cycle berikutnya entries di-drop
    // karena !runningBots.has(strategyId) — perilaku bersih, tidak ada stale entries.
    if (currentPrice.lt(lower) || currentPrice.gt(upper)) {
      const existing = cancelledOrderReplays.get(strategyId) ?? [];
      cancelledOrderReplays.set(strategyId, [...existing, ...entries]);
      continue;
    }

    // LIG-REPLAY-DEDUP-001: Dedup entries per grid level index dalam satu cycle.
    // Root cause: AUDIT-L-006 tolerance window (<0.1% price) terlalu sempit untuk menangkap
    // dua entry di level yang sama dari sesi berbeda (misal $45.07 & $45.02, selisih 0.056
    // > radius 0.045 → keduanya lolos → double order per level).
    // Math.round((price - lower) / gridSpacing) memetakan ke integer level index → exact dedup,
    // tidak terpengaruh variasi harga kecil antar sesi.
    const processedLevelIndices = new Set<number>();
    for (const entry of entries) {
      if (!runningBots.has(strategyId)) break; // bot stopped mid-loop

      const levelIdx = Math.round(entry.originalPrice.sub(lower).div(gridSpacing).toNumber());
      if (processedLevelIndices.has(levelIdx)) {
        logger.info(
          { strategyId, levelIdx, price: entry.originalPrice.toFixed(4) },
          "[replayExpiredGridOrders] LIG-REPLAY-DEDUP-001: Skip entry — level index sudah di-process dalam cycle ini"
        );
        continue;
      }
      processedLevelIndices.add(levelIdx);

      const { tradeId } = entry;

      // BUG-ORPHAN-SIDE-002: Lighter API kadang mengembalikan side="" untuk orphan orders
      // (terjadi saat restart — exchange mengembalikan order tanpa field side terisi).
      // Infer side dari posisi price relatif ke currentPrice:
      //   originalPrice < currentPrice → buy (order beli di bawah harga pasar)
      //   originalPrice >= currentPrice → sell (order jual di atas harga pasar)
      // Ini sesuai konvensi grid standar: buy wall di bawah, sell wall di atas.
      let side: "buy" | "sell" = entry.side as "buy" | "sell";
      if (!side) {
        side = entry.originalPrice.lt(currentPrice) ? "buy" : "sell";
        logger.warn(
          { strategyId, originalPrice: entry.originalPrice.toFixed(4), currentPrice: currentPrice.toFixed(4), inferredSide: side },
          "[replayExpiredGridOrders] BUG-ORPHAN-SIDE-002: side kosong — inferred dari originalPrice vs currentPrice"
        );
      }

      // Semua mode re-place order yang cancelled — simetris dengan direction logic.
      // LONG: sell = close long (reduceOnly) → re-place agar bisa exit saat harga naik.
      // SHORT: buy = close short (reduceOnly) → re-place agar bisa exit saat harga turun.
      const execModeMultiplier = getExecModeMultiplier((config as any).executionMode);
      const limitPriceOffset = (config.limitPriceOffset ?? 0) * execModeMultiplier;

      // AUDIT-L-006: Duplicate check pakai entry.originalPrice sebagai CENTER tolerance window.
      // DB menyimpan `price: currentPrice` (= originalPrice, tanpa offset) via preSavePendingTrade.
      // Sebelumnya window berpusat di executionPriceForTol (originalPrice ± offset) → meleset
      // sejauh nilai offset dari record DB → check selalu MISS → 4 order duplikat per level.
      // Fix: window berpusat di entry.originalPrice agar cocok dengan apa yang tersimpan di DB.
      const targetPrice = entry.originalPrice.toNumber();
      const { lower: tolLower, upper: tolUpper } = getDuplicateTolerance(targetPrice, gridSpacing.toNumber());
      const existingPending = await db.query.tradesTable.findFirst({
        where: and(
          eq(tradesTable.strategyId, strategyId),
          eq(tradesTable.status, "pending"),
          eq(tradesTable.side, side),
          gte(tradesTable.price, String(tolLower)),
          lte(tradesTable.price, String(tolUpper)),
        ),
      });
      if (existingPending) {
        logger.info({ strategyId, side, targetPrice }, "[replayExpiredGridOrders] Skip: pending order sudah ada di tolerance radius (AUDIT-L-006)");
        continue;
      }

      // BUG-REPLAY-001: Guard originalPrice — jika zero/invalid (DB default),
      // skip dan log agar bisa di-trace di production jika pernah terjadi.
      if (entry.originalPrice.lte(0)) {
        logger.warn(
          { strategyId, tradeId, originalPrice: entry.originalPrice.toFixed(8) },
          "[replayExpiredGridOrders] skipped — originalPrice zero/invalid"
        );
        continue;
      }

      // BUG-REPLAY-001: Size dari originalPrice (grid level asli), bukan currentPrice.
      // Notional: (amountPerGrid / originalPrice) × originalPrice = amountPerGrid exact.
      const size = amountPerGrid.div(entry.originalPrice);
      if (size.lte(0)) continue;

      await addLog(userId, strategyId, strategy.name, "info",
        `Re-placing ${side.toUpperCase()} grid order after cancel`,
        `Original price: ${entry.originalPrice.toFixed(4)} | Market price: ${currentPrice.toFixed(4)}`);

      // Update old trade errorMessage to reflect re-placement.
      // tradeId=-1 = sentinel (orphan tanpa DB record) — skip update.
      if (tradeId !== -1) {
        await db.update(tradesTable)
          .set({ errorMessage: "Order expired — re-placed at original grid level price" })
          .where(eq(tradesTable.id, tradeId));
      }

      if (!runningBots.has(strategyId)) break; // re-check before sending order

      // BUG-REPLAY-001: Pakai entry.originalPrice sebagai price reference,
      // bukan currentPrice — agar order di-place di grid level yang benar.
      await executeLiveOrder({
        userId,
        strategy,
        botConfig: botConfig!,
        side,
        size,
        currentPrice: entry.originalPrice,
        network,
        orderKind: config.orderType ?? "limit",
        limitPriceOffset: limitPriceOffset,
      });

      // AUDIT-L-007: Throttle antar order untuk menghindari 429 rate limit dari Lighter.
      // Tanpa delay ini, restart dengan 15+ grid entries dikirim dalam burst <1 detik
      // → Lighter menolak dengan 429 → grid levels bolong permanen sampai crossing berikutnya.
      await new Promise<void>(resolve => setTimeout(resolve, REPLAY_ORDER_DELAY_MS));
    }
  }
}

export function startTradePollSchedule() {
  setInterval(pollPendingTrades, TRADE_POLL_INTERVAL_MS);
  logger.info({ intervalMs: TRADE_POLL_INTERVAL_MS }, "Trade status polling started");

  // LIGHTER-GAP-002: Periodic order book sync setiap 10 menit untuk semua bot yang running
  setInterval(() => {
    (async () => {
      const runningStrategies = await db.query.strategiesTable.findMany({
        where: and(
          eq(strategiesTable.isRunning, true),
          eq(strategiesTable.exchange, "lighter")
        ),
      });
      for (const strategy of runningStrategies) {
        if (strategy.userId === null || strategy.userId === undefined) continue;
        await syncOrderBookState(strategy.userId, strategy, "mainnet").catch((err) =>
          logger.warn({ err, strategyId: strategy.id }, "[orderSync] syncOrderBookState error")
        );
      }
    })().catch((err) => logger.warn({ err }, "[orderSync] Periodic order book sync gagal"));
  }, ORDER_SYNC_INTERVAL_MS);
  logger.info({ intervalMs: ORDER_SYNC_INTERVAL_MS }, "Order book sync polling started");

  // LIGHTER-GAP-001: Re-place cancelled/expired grid orders every 2 minutes
  setInterval(() => {
    replayExpiredGridOrders().catch((err) =>
      logger.warn({ err }, "[replayExpiredGridOrders] Uncaught error")
    );
  }, REPLAY_INTERVAL_MS);
  logger.info({ intervalMs: REPLAY_INTERVAL_MS }, "Grid order replay schedule started");
}