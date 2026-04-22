import { db } from "@workspace/db";
import { strategiesTable, tradesTable, botLogsTable, GridConfig } from "@workspace/db";
import { getExecModeMultiplier, computeSkewMultipliers, type SkewState, type FollowMarketState } from "../utils";
import { trackBudgetSpend } from "../budgetTracker";
import { eq, sql, and, isNotNull, ne, gte, lte } from "drizzle-orm";
import Decimal from "decimal.js";
import { logger } from "../logger";
import { sendMessageToUser, formatBotStarted, formatBotStopped, formatOrderFilled,
         formatOrderFailed, formatStopLoss, formatTakeProfit,
         formatBotPaused } from "../telegramBot";
import {
  placeExtendedOrder,
  cancelExtendedOrderByExternalId,
  massCancelExtendedOrders,
  calcMarketOrderPrice,
} from "./extendedApi";
import {
  registerExtendedPriceCallback,
  unregisterExtendedPriceCallback,
  getExtendedWsCachedPrice,
  connectExtendedAccountWs,
  disconnectExtendedAccountWs,
} from "./extendedWs";
import type { ExtendedTrade as ExtendedWsTrade } from "./extendedWs";
import { getOrderBookDepth, getMidPrice, getMarketStats, validateExtendedApiKey, getAccountDetails, getOrderByExternalId, getOpenOrders } from "./extendedApi";
import { handleAutoRerange, clearRerangeState, cancelPendingRerangeOnStop, sendMainBotMessageWithButton, PENDING_TIMEOUT_MS } from "../autoRerange";
import type { ExtendedNetwork, ExtendedOrder } from "./extendedApi";
import { getExtendedMarketInfo } from "./extendedMarkets";
import { derivePublicKey } from "./extendedSigner";
import { getBotConfig, getExtendedCredentials as getExtendedCredsFromConfig } from "../../routes/configService";
import { getDuplicateTolerance } from "../shared/tolerance";
import { computeReduceOnly, computeGridSide, isSlTriggered, isTpTriggered } from "../shared/botLogic";

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

// ─── CACHE l2Vault PER USER ───────────────────────────────────────────────────
// l2Vault adalah vault ID yang dibutuhkan untuk SNIP-12 signing.
// Nilainya diambil dari GET /api/v1/user/account (bukan dari input user di Settings).
// Cache per userId, TTL 30 menit — refresh saat bot di-start ulang.

interface L2VaultCacheEntry {
  l2Vault: string;
  fetchedAt: number;
}
const L2VAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 jam — l2Vault tidak pernah berubah
const l2VaultCache = new Map<number, L2VaultCacheEntry>();

// ─── TIPE INTERNAL ────────────────────────────────────────────────────────────

interface ExtendedRunningBot {
  strategyId: number;
  timer: NodeJS.Timeout;
  nextRunAt: Date;
  startedAt: Date;
}

interface ExtendedGridState {
  lastLevel: number;
  initializedAt: Date;
}

// ─── STATE TERISOLASI (tidak berbagi apapun dengan Lighter) ───────────────────

const extendedRunningBots = new Map<number, ExtendedRunningBot>();
const extendedGridStates = new Map<number, ExtendedGridState>();
const extendedSkewStates = new Map<number, SkewState>();
const extendedFollowMarketStates = new Map<number, FollowMarketState>();
// BE-003: Set untuk tracking strategyId yang sedang dalam proses start.
// Mencegah dua request concurrent lolos bersama sebelum extendedRunningBots.set() dipanggil.
const startingExtendedBots = new Set<number>();
// Mirror pattern startingExtendedBots: tracking strategyId yang sedang dalam proses stop.
// Mencegah startExtendedBot menyelesaikan setup jika stopExtendedBot dipanggil saat start in-flight.
const stoppingExtendedBots = new Set<number>();

// EXT-REPLAY-001: Replay queue untuk grid orders yang timeout/cancelled tanpa fill.
// Identik dengan pola LIGHTER-GAP-001 dan ETH-REPLAY-001.
interface ExtendedReplayEntry {
  side: "buy" | "sell";
  originalPrice: Decimal;   // harga grid level asli dari DB trade.price
  cancelledAt: Date;
  tradeId: number;
}
const cancelledExtendedReplays = new Map<number, ExtendedReplayEntry[]>(); // strategyId → entries
const EXT_REPLAY_INTERVAL_MS = 2 * 60 * 1000;  // 2 menit — sama dengan Lighter
const EXT_ORDER_SYNC_INTERVAL_MS = 10 * 60 * 1000; // 10 menit — sync order book state

// Cooldown WS untuk grid — hindari rapid-fire saat tick harga volatil
const EXT_WS_GRID_COOLDOWN_MS = 10_000;
const extendedWsGridLastTriggered = new Map<number, number>();

// ─── ACCOUNT WS PER USER (ref-counted) ───────────────────────────────────────
// Satu koneksi account WS per userId. Ref-count memastikan koneksi tidak
// ditutup selama masih ada bot yang berjalan untuk user tersebut.

const userAccountWsInstanceKey = new Map<number, string>();
const userAccountWsRefCount = new Map<number, number>();

// Interval fallback untuk grid (WS adalah primary; ini sebagai jaring pengaman)
const EXT_GRID_FALLBACK_INTERVAL_MS = 5 * 60 * 1000; // 5 menit

// Maksimum order per "batch" grid (Extended tidak punya batch endpoint — dikirim sequential)
const EXT_MAX_GRID_ORDERS = 5;

// ─── QUERY STATUS BOT ─────────────────────────────────────────────────────────

export function isExtendedBotRunning(strategyId: number): boolean {
  return extendedRunningBots.has(strategyId);
}

export function getExtendedBotNextRunAt(strategyId: number): Date | null {
  return extendedRunningBots.get(strategyId)?.nextRunAt ?? null;
}

export function getAllRunningExtendedBots(): { strategyId: number; nextRunAt: Date }[] {
  return Array.from(extendedRunningBots.entries()).map(([id, bot]) => ({
    strategyId: id,
    nextRunAt: bot.nextRunAt,
  }));
}

// ─── BACA CREDENTIALS EXTENDED DARI DB ───────────────────────────────────────
// Berbeda dari Lighter: credentials Extended disimpan langsung di tabel `users`,
// bukan di tabel key-value `bot_config`.

interface ExtendedCredentials {
  apiKey: string | null;
  privateKey: string | null;
  /** collateralPosition = l2Vault / extendedAccountId */
  collateralPosition: string | null;
  network: ExtendedNetwork;
  hasCredentials: boolean;
}

async function getExtendedConfig(userId: number): Promise<ExtendedCredentials> {
  // Credentials disimpan di bot_config table (mendukung userId=0 / admin)
  const creds = await getExtendedCredsFromConfig(userId).catch(() => null);

  const network: ExtendedNetwork = (creds?.extendedNetwork ?? "mainnet") as ExtendedNetwork;
  const apiKey = creds?.apiKey ?? null;
  const privateKey = creds?.privateKey ?? null;

  // Prioritaskan l2Vault dari cache (diisi saat bot start via API fetch).
  // l2Vault adalah nilai yang benar untuk SNIP-12 signing, bukan accountId.
  // l2Vault TIDAK PERNAH berubah untuk satu akun, jadi nilai stale pun tetap benar.
  // Fallback ke accountId HANYA jika l2Vault belum pernah diambil sama sekali.
  const cachedVault = l2VaultCache.get(userId);
  const collateralPosition = cachedVault?.l2Vault ?? (creds?.accountId ?? null);

  return {
    apiKey,
    privateKey,
    collateralPosition,
    network,
    hasCredentials: !!(apiKey && privateKey && collateralPosition),
  };
}

// ─── LOG DAN NOTIFIKASI ───────────────────────────────────────────────────────

async function extAddLog(
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
      exchange: "extended",
    });
  } catch (err) {
    logger.error({ err }, "[ExtendedBot] Failed to add bot log");
  }
}

async function extNotifyUser(userId: number | null, message: string): Promise<void> {
  if (userId === null || userId === undefined) return;
  try {
    const botCfg = await getBotConfig(userId);
    if (!botCfg.notifyBotToken || !botCfg.notifyChatId) return;
    const result = await sendMessageToUser(botCfg.notifyChatId, message, botCfg.notifyBotToken);
    if (!result.ok) {
      await extAddLog(userId, null, null, "warn",
        `[Notifikasi Telegram gagal] ${result.error ?? "Unknown error"}`,
        `Pastikan: 1) Bot token benar, 2) Sudah kirim /start ke bot notifikasimu, 3) Chat ID benar`
      );
    }
  } catch (err: any) {
    logger.error({ err }, "[ExtendedBot] Unexpected error in extNotifyUser");
  }
}

async function extGetNotificationConfig(userId: number) {
  const botCfg = await getBotConfig(userId).catch(() => null);
  return {
    notifyOnBuy: botCfg?.notifyOnBuy ?? true,
    notifyOnSell: botCfg?.notifyOnSell ?? true,
    notifyOnError: botCfg?.notifyOnError ?? true,
    notifyOnStart: botCfg?.notifyOnStart ?? true,
    notifyOnStop: botCfg?.notifyOnStop ?? false,
  };
}

// ─── CATAT TRADE KE DB ───────────────────────────────────────────────────────

async function extRecordTrade(params: {
  userId: number | null;
  strategyId: number;
  strategyName: string;
  /**
   * E-005: Extended menggunakan `marketSymbol` (string) sebagai identifier market — bukan integer index.
   * Kolom `market_index` di DB adalah NOT NULL (schema-level constraint dari Lighter), sehingga harus diisi.
   * Nilai yang di-pass adalah `strategy.marketIndex` yang tidak bermakna untuk Extended trades.
   * Identifikasi market yang benar untuk Extended selalu melalui `marketSymbol` di bawah.
   */
  marketIndex: number;
  marketSymbol: string;
  side: "buy" | "sell";
  size: Decimal;
  price: Decimal;
  status: "pending" | "filled" | "cancelled" | "failed";
  orderHash?: string;
  errorMessage?: string;
  /** Fee aktual yang dibayar (dalam USDC). Untuk taker fills: size * price * 0.00025. Default "0". */
  fee?: string;
}): Promise<void> {
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
      fee: params.fee ?? "0",
      status: params.status,
      orderHash: params.orderHash ?? null,
      clientOrderIndex: null,
      exchange: "extended",
      errorMessage: params.errorMessage ?? null,
      executedAt: params.status === "filled" ? new Date() : null,
    });
  } catch (err) {
    logger.error({ err, strategyId: params.strategyId }, "[ExtendedBot] Gagal menyimpan trade ke DB — order mungkin sudah terkirim ke exchange");
    throw err;
  }
}

async function extUpdateStrategyStatsAtomic(
  strategyId: number,
  side: "buy" | "sell",
  size: Decimal,
  price: Decimal,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  executor: { execute: (query: any) => Promise<any> } = db,
  mode: string = "neutral"
): Promise<void> {
  if (side === "buy") {
    await executor.execute(sql`
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
    await executor.execute(sql`
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

// ─── ACCOUNT WS EVENT HANDLERS ───────────────────────────────────────────────
// Dipanggil ketika Extended account WS mengirim ORDER atau TRADE event.
// Hanya memproses limit/GTT orders yang ada di DB sebagai "pending".
// Market/IOC orders tidak terdampak — mereka sudah ditandai "filled" saat REST response.

/**
 * Tangani ORDER event dari account WebSocket.
 * Match ke trade di DB via orderHash = "ext_" + order.externalId.
 */
async function handleExtendedOrderEvent(
  userId: number,
  orders: ExtendedOrder[]
): Promise<void> {
  for (const order of orders) {
    if (!order.externalId) continue;

    const orderHash = `ext_${order.externalId}`;
    const status = (order.status ?? "").toUpperCase();

    if (!["FILLED", "PARTIALLY_FILLED", "CANCELLED", "REJECTED", "EXPIRED"].includes(status)) {
      continue;
    }

    let trade: Awaited<ReturnType<typeof db.query.tradesTable.findFirst>>;
    try {
      trade = await db.query.tradesTable.findFirst({
        where: and(
          eq(tradesTable.status, "pending"),
          eq(tradesTable.orderHash, orderHash)
        ),
      });
    } catch (err) {
      logger.error({ err, orderHash }, "[ExtendedBot] WS: DB lookup failed");
      continue;
    }

    if (!trade) continue;

    if (status === "FILLED") {
      const fillPrice = order.averagePrice && parseFloat(order.averagePrice) > 0
        ? new Decimal(order.averagePrice)
        : new Decimal(order.price);
      const fillQty = order.filledQty && parseFloat(order.filledQty) > 0
        ? new Decimal(order.filledQty)
        : new Decimal(order.qty);

      try {
        const stratForMode = trade.strategyId
          ? await db.query.strategiesTable.findFirst({
              where: eq(strategiesTable.id, trade.strategyId),
              columns: { gridConfig: true },
            })
          : null;
        const tradeMode = (stratForMode?.gridConfig as any)?.mode ?? "neutral";
        // EXT-BUDGET-MISSING-001: flag untuk hindari double-count budget jika idempotency guard aktif
        let wsFilledDidUpdate = false;
        await db.transaction(async (tx) => {
          // E-NEW-2: Guard idempotency — jika TRADE event sudah proses lebih dulu, skip stats update.
          const updated = await tx.update(tradesTable)
            .set({ status: "filled", executedAt: new Date() })
            .where(and(eq(tradesTable.id, trade.id), eq(tradesTable.status, "pending")))
            .returning({ id: tradesTable.id });
          if (updated.length === 0) return; // Already processed by concurrent handler

          await extUpdateStrategyStatsAtomic(
            trade.strategyId!,
            trade.side as "buy" | "sell",
            fillQty,
            fillPrice,
            tx,
            tradeMode
          );
          wsFilledDidUpdate = true;
        });

        // EXT-BUDGET-MISSING-001: Budget cap — hanya jika stats benar-benar diupdate (cegah double-count)
        if (wsFilledDidUpdate && trade.strategyId !== null) {
          try {
            const budget = await trackBudgetSpend(trade.strategyId, fillQty, fillPrice, 0);
            if (budget.exceeded) {
              await extAddLog(userId, trade.strategyId, trade.strategyName, "warn",
                "Budget Cap tercapai — bot dihentikan otomatis",
                `Terpakai: $${budget.newSpentUsd.toFixed(2)} dari $${budget.maxBudgetUsd?.toFixed(2)}`
              );
              await extNotifyUser(userId,
                `🛑 Budget Cap tercapai: $${budget.newSpentUsd.toFixed(2)} dari $${budget.maxBudgetUsd?.toFixed(2)} — bot dihentikan otomatis.`
              );
              stopExtendedBot(trade.strategyId).catch((err) =>
                logger.warn({ err, strategyId: trade.strategyId }, "[ExtendedBot] stopExtendedBot setelah budget cap gagal — non-fatal")
              );
            }
          } catch (budgetErr) {
            logger.warn({ tradeId: trade.id }, "[ExtendedBot] Budget tracking failed — non-critical");
          }
        }

        // EXT-SKEW-MISSING-001: F3 Inventory Skew — update cumulative qty.
        // Guard oleh wsFilledDidUpdate (idempotency E-NEW-2): hanya handler yang menang yang update skew,
        // sehingga handleExtendedTradeEvent (jika kalah race) tetap skip via pending-status guard.
        if (wsFilledDidUpdate && trade.strategyId !== null) {
          const skWsFilled = extendedSkewStates.get(trade.strategyId) ?? { cumulativeBuyQty: new Decimal(0), cumulativeSellQty: new Decimal(0) };
          if (trade.side === "buy") skWsFilled.cumulativeBuyQty = skWsFilled.cumulativeBuyQty.add(fillQty);
          else skWsFilled.cumulativeSellQty = skWsFilled.cumulativeSellQty.add(fillQty);
          extendedSkewStates.set(trade.strategyId, skWsFilled);
        }

        await extAddLog(
          userId, trade.strategyId, trade.strategyName, "success",
          `Order Extended terisi penuh (via WS)`,
          `ExternalId: ${order.externalId} | Qty: ${fillQty.toFixed(6)} | Avg: $${fillPrice.toFixed(4)}`
        );

        try {
          const notif = await extGetNotificationConfig(userId);
          const shouldNotify = trade.side === "buy" ? notif.notifyOnBuy : notif.notifyOnSell;
          if (shouldNotify) {
            await extNotifyUser(userId,
              formatOrderFilled("extended", trade.side, fillQty.toFixed(6),
                trade.marketSymbol, fillPrice.toFixed(4), order.payedFee));
          }
        } catch (notifErr) {
          logger.warn({ notifErr, tradeId: trade.id }, "[ExtendedBot] WS: Notifikasi fill gagal dikirim");
        }

        logger.info(
          { tradeId: trade.id, orderHash, fillPrice: fillPrice.toFixed(4), fillQty: fillQty.toFixed(6) },
          "[ExtendedBot] WS: Limit order filled — DB updated"
        );
      } catch (err) {
        logger.error({ err, tradeId: trade.id, orderHash }, "[ExtendedBot] WS: Failed to update filled trade");
      }
    } else if (status === "PARTIALLY_FILLED") {
      // Jangan tandai "filled" terlalu dini — GTT order masih di order book.
      // IOC partial fill akan di-cancel exchange; finalisasi dilakukan saat CANCELLED tiba
      // dengan filledQty > 0 (lihat branch CANCELLED di bawah).
      const partialQty = order.filledQty ?? "0";
      logger.info(
        { tradeId: trade.id, orderHash, filledQty: partialQty, totalQty: order.qty },
        "[ExtendedBot] WS: PARTIALLY_FILLED diterima — menunggu FILLED atau CANCELLED untuk finalisasi"
      );
      await extAddLog(
        userId, trade.strategyId, trade.strategyName, "info",
        `Order Extended terisi sebagian — menunggu finalisasi`,
        `ExternalId: ${order.externalId} | Filled: ${partialQty}/${order.qty}`
      );
    } else {
      // CANCELLED / REJECTED / EXPIRED
      // Jika filledQty > 0: IOC partial fill — tandai "filled" dengan qty yang berhasil terisi
      const partialFillQty = order.filledQty ? parseFloat(order.filledQty) : 0;
      if (partialFillQty > 0) {
        const fillPrice = order.averagePrice && parseFloat(order.averagePrice) > 0
          ? new Decimal(order.averagePrice)
          : new Decimal(order.price);
        const fillQty = new Decimal(order.filledQty!);
        try {
          const stratForModePartial = trade.strategyId
            ? await db.query.strategiesTable.findFirst({
                where: eq(strategiesTable.id, trade.strategyId),
                columns: { gridConfig: true },
              })
            : null;
          const tradeModePartial = (stratForModePartial?.gridConfig as any)?.mode ?? "neutral";
          // EXT-BUDGET-MISSING-001: flag untuk hindari double-count budget jika idempotency guard aktif
          let wsPartialDidUpdate = false;
          await db.transaction(async (tx) => {
            // E-NEW-2: Guard idempotency — IOC partial fill bisa datang via TRADE event lebih dulu.
            const updatedPartial = await tx.update(tradesTable)
              .set({ status: "filled", executedAt: new Date() })
              .where(and(eq(tradesTable.id, trade.id), eq(tradesTable.status, "pending")))
              .returning({ id: tradesTable.id });
            if (updatedPartial.length === 0) return; // Already processed by concurrent handler

            await extUpdateStrategyStatsAtomic(
              trade.strategyId!,
              trade.side as "buy" | "sell",
              fillQty,
              fillPrice,
              tx,
              tradeModePartial
            );
            wsPartialDidUpdate = true;
          });

          // EXT-BUDGET-MISSING-001: Budget cap — hanya jika stats benar-benar diupdate (cegah double-count)
          if (wsPartialDidUpdate && trade.strategyId !== null) {
            try {
              const budget = await trackBudgetSpend(trade.strategyId, fillQty, fillPrice, 0);
              if (budget.exceeded) {
                await extAddLog(userId, trade.strategyId, trade.strategyName, "warn",
                  "Budget Cap tercapai — bot dihentikan otomatis",
                  `Terpakai: $${budget.newSpentUsd.toFixed(2)} dari $${budget.maxBudgetUsd?.toFixed(2)}`
                );
                await extNotifyUser(userId,
                  `🛑 Budget Cap tercapai: $${budget.newSpentUsd.toFixed(2)} dari $${budget.maxBudgetUsd?.toFixed(2)} — bot dihentikan otomatis.`
                );
                stopExtendedBot(trade.strategyId).catch((err) =>
                  logger.warn({ err, strategyId: trade.strategyId }, "[ExtendedBot] stopExtendedBot setelah budget cap gagal — non-fatal")
                );
              }
            } catch (budgetErr) {
              logger.warn({ tradeId: trade.id }, "[ExtendedBot] Budget tracking failed — non-critical");
            }
          }

          // EXT-SKEW-MISSING-001: F3 Inventory Skew — update cumulative qty (IOC partial fill via WS CANCELLED).
          // Guard oleh wsPartialDidUpdate (idempotency E-NEW-2) agar tidak double-count dengan TRADE handler.
          if (wsPartialDidUpdate && trade.strategyId !== null) {
            const skWsPartial = extendedSkewStates.get(trade.strategyId) ?? { cumulativeBuyQty: new Decimal(0), cumulativeSellQty: new Decimal(0) };
            if (trade.side === "buy") skWsPartial.cumulativeBuyQty = skWsPartial.cumulativeBuyQty.add(fillQty);
            else skWsPartial.cumulativeSellQty = skWsPartial.cumulativeSellQty.add(fillQty);
            extendedSkewStates.set(trade.strategyId, skWsPartial);
          }

          await extAddLog(
            userId, trade.strategyId, trade.strategyName, "success",
            `Order Extended terisi sebagian & ${status.toLowerCase()} (via WS)`,
            `ExternalId: ${order.externalId} | Filled: ${fillQty.toFixed(6)} | Avg: $${fillPrice.toFixed(4)}`
          );

          try {
            const notif = await extGetNotificationConfig(userId);
            const shouldNotify = trade.side === "buy" ? notif.notifyOnBuy : notif.notifyOnSell;
            if (shouldNotify) {
              await extNotifyUser(userId,
                formatOrderFilled("extended", trade.side, fillQty.toFixed(6),
                  trade.marketSymbol, fillPrice.toFixed(4), order.payedFee));
            }
          } catch (notifErr) {
            logger.warn({ notifErr, tradeId: trade.id }, "[ExtendedBot] WS: Notifikasi partial fill gagal dikirim");
          }

          logger.info(
            { tradeId: trade.id, orderHash, fillPrice: fillPrice.toFixed(4), fillQty: fillQty.toFixed(6), status },
            "[ExtendedBot] WS: IOC partial fill finalized on CANCELLED — DB updated"
          );
        } catch (err) {
          logger.error({ err, tradeId: trade.id, orderHash }, "[ExtendedBot] WS: Failed to update partial fill trade");
        }
      } else {
        try {
          await db.update(tradesTable)
            .set({
              status: "cancelled",
              errorMessage: `Order ${status.toLowerCase()} oleh exchange (konfirmasi WS)`,
            })
            .where(eq(tradesTable.id, trade.id));

          await extAddLog(
            userId, trade.strategyId, trade.strategyName, "warn",
            `Order Extended ${status.toLowerCase()} (via WS)`,
            `ExternalId: ${order.externalId} | Market: ${order.market} | Side: ${order.side}`
          );

          logger.warn(
            { tradeId: trade.id, orderHash, status },
            "[ExtendedBot] WS: Order cancelled/rejected — DB updated"
          );
        } catch (err) {
          logger.error({ err, tradeId: trade.id, orderHash }, "[ExtendedBot] WS: Failed to update cancelled trade");
        }
      }
    }
  }
}

/**
 * Tangani TRADE event dari account WebSocket.
 * Digunakan sebagai pengaman tambahan: jika ORDER event terlewat tapi TRADE sudah masuk,
 * trade di DB tetap bisa ditandai filled dengan harga eksekusi aktual.
 */
async function handleExtendedTradeEvent(
  userId: number,
  trades: ExtendedWsTrade[]
): Promise<void> {
  for (const wsTrade of trades) {
    if (!wsTrade.externalId) continue;

    const orderHash = `ext_${wsTrade.externalId}`;

    let trade: Awaited<ReturnType<typeof db.query.tradesTable.findFirst>>;
    try {
      trade = await db.query.tradesTable.findFirst({
        where: and(
          eq(tradesTable.status, "pending"),
          eq(tradesTable.orderHash, orderHash)
        ),
      });
    } catch (err) {
      logger.error({ err, orderHash }, "[ExtendedBot] WS TRADE: DB lookup failed");
      continue;
    }

    if (!trade) continue;

    const fillPrice = new Decimal(wsTrade.price);
    const fillQty = new Decimal(wsTrade.qty);

    try {
      const stratForModeWsTrade = trade.strategyId
        ? await db.query.strategiesTable.findFirst({
            where: eq(strategiesTable.id, trade.strategyId),
            columns: { gridConfig: true },
          })
        : null;
      const tradeModeWsTrade = (stratForModeWsTrade?.gridConfig as any)?.mode ?? "neutral";
      // EXT-TRADE-IDEMPOTENCY-001: flag untuk gate budget + skew agar tidak double-count
      // jika ORDER handler sudah menang idempotency guard lebih dulu (race condition).
      let wsTradeDidUpdate = false;
      await db.transaction(async (tx) => {
        // E-NEW-2: Guard idempotency — jika ORDER event sudah proses lebih dulu, skip stats update.
        const updatedWsTrade = await tx.update(tradesTable)
          .set({ status: "filled", executedAt: new Date() })
          .where(and(eq(tradesTable.id, trade.id), eq(tradesTable.status, "pending")))
          .returning({ id: tradesTable.id });
        if (updatedWsTrade.length === 0) return; // Already processed by concurrent handler

        await extUpdateStrategyStatsAtomic(
          trade.strategyId!,
          trade.side as "buy" | "sell",
          fillQty,
          fillPrice,
          tx,
          tradeModeWsTrade
        );
        wsTradeDidUpdate = true;
      });

      // F2: Budget Cap — guard oleh wsTradeDidUpdate agar tidak double-count jika ORDER handler menang
      if (wsTradeDidUpdate && trade.strategyId !== null) {
        try {
          const budget = await trackBudgetSpend(
            trade.strategyId, fillQty, fillPrice, 0
          );
          if (budget.exceeded) {
            await extAddLog(userId, trade.strategyId, trade.strategyName, "warn",
              "Budget Cap tercapai — bot dihentikan otomatis",
              `Terpakai: $${budget.newSpentUsd.toFixed(2)} dari $${budget.maxBudgetUsd?.toFixed(2)}`
            );
            await extNotifyUser(userId,
              `🛑 Budget Cap tercapai: $${budget.newSpentUsd.toFixed(2)} dari $${budget.maxBudgetUsd?.toFixed(2)} — bot dihentikan otomatis.`
            );
            // CROSS-BUDGET-001 FIX: Panggil stopExtendedBot() (bukan db.update saja) agar timer,
            // WS callback, dan in-memory extendedRunningBots benar-benar dibersihkan.
            // db.update saja meninggalkan bot "zombie" — timer masih jalan dan order baru
            // terus dikirim meski budget habis. Identik dengan AUDIT-L-001 di Lighter.
            stopExtendedBot(trade.strategyId).catch((err) =>
              logger.warn({ err, strategyId: trade.strategyId }, "[ExtendedBot] stopExtendedBot setelah budget cap gagal — state mungkin tidak bersih")
            );
          }
        } catch (budgetErr) {
          logger.warn({ tradeId: trade.id }, "[ExtendedBot] Budget tracking failed — non-critical");
        }
      }

      // F3: Inventory Skew — guard oleh wsTradeDidUpdate (EXT-TRADE-IDEMPOTENCY-001):
      // jika ORDER handler menang race dan sudah update skew, TRADE handler skip agar tidak double-count.
      if (wsTradeDidUpdate && trade.strategyId !== null) {
        const sk = extendedSkewStates.get(trade.strategyId) ?? { cumulativeBuyQty: new Decimal(0), cumulativeSellQty: new Decimal(0) };
        if (trade.side === "buy") sk.cumulativeBuyQty = sk.cumulativeBuyQty.add(fillQty);
        else sk.cumulativeSellQty = sk.cumulativeSellQty.add(fillQty);
        extendedSkewStates.set(trade.strategyId, sk);
      }

      await extAddLog(
        userId, trade.strategyId, trade.strategyName, "success",
        `Order Extended terisi (konfirmasi TRADE event WS)`,
        `ExternalId: ${wsTrade.externalId} | Qty: ${fillQty.toFixed(6)} | Price: $${fillPrice.toFixed(4)}`
      );

      try {
        const notif = await extGetNotificationConfig(userId);
        const shouldNotify = trade.side === "buy" ? notif.notifyOnBuy : notif.notifyOnSell;
        if (shouldNotify) {
          await extNotifyUser(userId,
            formatOrderFilled("extended", trade.side, fillQty.toFixed(6),
              trade.marketSymbol, fillPrice.toFixed(4), wsTrade.fee));
        }
      } catch (notifErr) {
        logger.warn({ notifErr, tradeId: trade.id }, "[ExtendedBot] WS TRADE: Notifikasi fill gagal dikirim");
      }

      logger.info(
        { tradeId: trade.id, orderHash, price: fillPrice.toFixed(4), qty: fillQty.toFixed(6) },
        "[ExtendedBot] WS TRADE: Limit order confirmed filled via trade event"
      );
    } catch (err) {
      logger.error({ err, tradeId: trade.id, orderHash }, "[ExtendedBot] WS TRADE: Failed to update trade");
    }
  }
}

/**
 * Hubungkan account WS untuk user jika belum ada.
 * Ref-counted: koneksi dibuat saat bot pertama start, tetap hidup selama ada bot running.
 */
async function ensureExtendedAccountWs(
  userId: number,
  apiKey: string,
  network: ExtendedNetwork
): Promise<void> {
  const prev = userAccountWsRefCount.get(userId) ?? 0;
  userAccountWsRefCount.set(userId, prev + 1);

  if (prev > 0) {
    logger.debug({ userId, refCount: prev + 1 }, "[ExtendedBot] Account WS already connected (ref++)");
    return;
  }

  let instanceKey: string;
  try {
    instanceKey = connectExtendedAccountWs({
      apiKey,
      network,
      callbacks: {
        onOrder: (orders) => {
          handleExtendedOrderEvent(userId, orders).catch((err) =>
            logger.error({ err, userId }, "[ExtendedBot] Error in onOrder handler")
          );
        },
        onTrade: (trades) => {
          handleExtendedTradeEvent(userId, trades).catch((err) =>
            logger.error({ err, userId }, "[ExtendedBot] Error in onTrade handler")
          );
        },
        onConnected: () => {
          logger.info({ userId, network }, "[ExtendedBot] Account WS connected — limit order confirmation active");
        },
        onDisconnected: () => {
          logger.warn({ userId }, "[ExtendedBot] Account WS disconnected — will reconnect automatically");
        },
        onError: (err) => {
          logger.error({ err, userId }, "[ExtendedBot] Account WS error");
        },
      },
    });
  } catch (err) {
    // Rollback ref count — koneksi gagal dibuat, jangan biarkan ref count menggantung.
    // prev selalu 0 di sini (path re-use sudah return lebih awal), jadi rollback = reset ke 0.
    userAccountWsRefCount.set(userId, prev);
    logger.error({ err, userId, network }, "[ExtendedBot] Account WS connect gagal — ref count di-rollback ke prev");
    throw err;
  }

  userAccountWsInstanceKey.set(userId, instanceKey);
  logger.info({ userId, network, instanceKey }, "[ExtendedBot] Account WS connected (new)");
}

/**
 * Lepaskan referensi account WS untuk user.
 * Koneksi diputus hanya jika ref-count mencapai 0 (tidak ada bot running untuk user ini).
 */
function releaseExtendedAccountWs(userId: number): void {
  const current = userAccountWsRefCount.get(userId) ?? 0;
  const next = Math.max(0, current - 1);
  userAccountWsRefCount.set(userId, next);

  if (next > 0) {
    logger.debug({ userId, refCount: next }, "[ExtendedBot] Account WS ref-- (still in use)");
    return;
  }

  const instanceKey = userAccountWsInstanceKey.get(userId);
  if (instanceKey) {
    disconnectExtendedAccountWs(instanceKey);
    userAccountWsInstanceKey.delete(userId);
    logger.info({ userId, instanceKey }, "[ExtendedBot] Account WS disconnected (no bots running)");
  }
  userAccountWsRefCount.delete(userId);
}

// ─── AMBIL HARGA SAAT INI ─────────────────────────────────────────────────────
// Extended menggunakan market string (bukan integer seperti Lighter).
// WS cache menyimpan mid price. Untuk market order, mid price digunakan sebagai
// acuan dan offset 0.75% ditambahkan oleh calcMarketOrderPrice.

async function extGetCurrentPrice(
  market: string,
  network: ExtendedNetwork = "mainnet"
): Promise<Decimal | null> {
  // Preferensi: cache WebSocket (real-time, maksimal 5 detik lalu)
  const cached = getExtendedWsCachedPrice(market, 5_000);
  if (cached) return cached;

  // Fallback 1: REST API orderbook saat WS belum terkoneksi / cache stale
  try {
    const ob = await getOrderBookDepth(market, network);
    if (ob) {
      const mid = getMidPrice(ob);
      if (mid && mid.gt(0)) {
        logger.info({ market, network, price: mid.toFixed(4) }, "[Extended] Harga dari REST orderbook fallback");
        return mid;
      }
    }
  } catch (err) {
    logger.warn({ err, market }, "[Extended] REST orderbook fallback gagal");
  }

  // Fallback 2: markPrice dari market stats (selalu tersedia walau orderbook kosong)
  try {
    const stats = await getMarketStats(market, network);
    if (stats) {
      const markStr = stats.markPrice ?? stats.indexPrice ?? stats.lastPrice;
      if (markStr) {
        const markPrice = new Decimal(markStr);
        if (markPrice.gt(0)) {
          logger.info({ market, network, price: markPrice.toFixed(4) }, "[Extended] Harga dari markPrice fallback");
          return markPrice;
        }
      }
    }
  } catch (err) {
    logger.warn({ err, market }, "[Extended] markPrice fallback gagal");
  }

  return null;
}

// ─── HELPER: ROUND SIZE KE STEP SIZE MARKET ──────────────────────────────────

function roundToStepSize(size: Decimal, stepSize: string): Decimal {
  const step = new Decimal(stepSize);
  if (step.lte(0)) return size;
  return size.div(step).floor().mul(step);
}

// ─── HELPER: ROUND HARGA KE TICK SIZE MARKET ─────────────────────────────────
// BUY limit → floor (jangan overpay)
// SELL limit → ceil (jangan undersell)
// Market/any → round nearest

function roundToTickSize(price: Decimal, tickSize: string, side: "buy" | "sell" | "any" = "any"): Decimal {
  const tick = new Decimal(tickSize);
  if (tick.lte(0)) return price;
  const divided = price.div(tick);
  if (side === "buy") return divided.floor().mul(tick);
  if (side === "sell") return divided.ceil().mul(tick);
  return divided.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).mul(tick);
}

function tickSizeDecimals(tickSize: string): number {
  return tickSize.includes(".") ? tickSize.split(".")[1].replace(/0+$/, "").length : 0;
}

// ─── EKSEKUSI PAPER TRADE ─────────────────────────────────────────────────────

async function extExecutePaperTrade(params: {
  userId: number | null;
  strategy: typeof strategiesTable.$inferSelect;
  side: "buy" | "sell";
  size: Decimal;
  price: Decimal;
  orderCount?: number;
}): Promise<void> {
  const { userId, strategy, side, size, price } = params;
  const count = params.orderCount ?? 1;

  for (let i = 0; i < count; i++) {
    await extRecordTrade({
      userId,
      strategyId: strategy.id,
      strategyName: strategy.name,
      marketIndex: strategy.marketIndex,
      marketSymbol: strategy.marketSymbol,
      side,
      size,
      price,
      status: "filled",
      orderHash: `ext_paper_${Date.now()}_${i}`,
    });
    const paperMode = (strategy.gridConfig as any)?.mode ?? "neutral";
    await extUpdateStrategyStatsAtomic(strategy.id, side, size, price, db, paperMode);

    // EXT-SKEW-PAPER-001: F3 Inventory Skew — update cumulative qty untuk paper trade.
    // Tanpa ini, skewRatio selalu 0 → F3 tidak berfungsi di mode paper trading.
    const skPaper = extendedSkewStates.get(strategy.id) ?? { cumulativeBuyQty: new Decimal(0), cumulativeSellQty: new Decimal(0) };
    if (side === "buy") skPaper.cumulativeBuyQty = skPaper.cumulativeBuyQty.add(size);
    else skPaper.cumulativeSellQty = skPaper.cumulativeSellQty.add(size);
    extendedSkewStates.set(strategy.id, skPaper);
  }

  const label = count > 1 ? `×${count}` : "";
  await extAddLog(
    userId, strategy.id, strategy.name, "warn",
    `Paper trade${label}: ${side.toUpperCase()} ${size.toFixed(6)} @ $${price.toFixed(2)}`,
    "Credentials Extended belum dikonfigurasi — hanya simulasi"
  );

}

// ─── EKSEKUSI LIVE ORDER (single) ─────────────────────────────────────────────
// Berbeda dari Lighter: tidak ada initSigner/getNextNonce — semua ditangani oleh
// placeExtendedOrder() secara internal.

async function extExecuteLiveOrder(params: {
  userId: number | null;
  strategy: typeof strategiesTable.$inferSelect;
  creds: ExtendedCredentials;
  side: "buy" | "sell";
  size: Decimal;
  currentPrice: Decimal;
  orderKind?: "market" | "limit" | "post_only";
  limitPriceOffset?: number;
  stepSize?: string;
  reduceOnly?: boolean;
}): Promise<void> {
  const { userId, strategy, creds, side, size, currentPrice } = params;
  const orderKind = params.orderKind ?? "market";
  const limitPriceOffset = params.limitPriceOffset ?? 0;
  const reduceOnly = params.reduceOnly ?? false;
  const network = creds.network;

  // ── Ambil market info untuk stepSize dan tickSize (cached) ─────────────────
  const priceMarketInfo = await getExtendedMarketInfo(strategy.marketSymbol, undefined, network).catch(() => null);
  const resolvedStepSize = priceMarketInfo?.stepSize ?? params.stepSize ?? "0.0001";
  const resolvedTickSize = priceMarketInfo?.tickSize ?? "0.1";
  const resolvedStepDecimals = resolvedStepSize.includes(".") ? resolvedStepSize.split(".")[1].length : 0;
  const resolvedTickDecimals = tickSizeDecimals(resolvedTickSize);

  // ── Hitung execution price ──────────────────────────────────────────────────
  // Extended market order: gunakan calcMarketOrderPrice (0.75% buffer)
  // Extended limit/post_only: offset dari currentPrice, dibulatkan ke tickSize
  let executionPrice: Decimal;
  let extOrderType: "LIMIT" | "MARKET";
  let extTimeInForce: "GTT" | "IOC";
  let postOnly: boolean;

  if (orderKind === "market") {
    // Market order di Extended = IOC limit dengan worst-case price
    // WS mid price digunakan sebagai referensi best price
    const marketPriceStr = calcMarketOrderPrice(
      currentPrice.toFixed(8),
      side === "buy" ? "BUY" : "SELL",
      resolvedTickDecimals
    );
    executionPrice = roundToTickSize(new Decimal(marketPriceStr), resolvedTickSize, side);
    extOrderType = "MARKET";
    extTimeInForce = "IOC";
    postOnly = false;
  } else {
    const offset = currentPrice.mul(new Decimal(limitPriceOffset)).div(100);
    const rawPrice = side === "buy"
      ? currentPrice.sub(offset)
      : currentPrice.add(offset);
    // Round ke tickSize: BUY floor (jangan overpay), SELL ceil (jangan undersell)
    executionPrice = roundToTickSize(rawPrice, resolvedTickSize, side);
    extOrderType = "LIMIT";
    extTimeInForce = "GTT";
    postOnly = orderKind === "post_only";
  }

  const priceStr = executionPrice.toFixed(resolvedTickDecimals);

  await extAddLog(
    userId, strategy.id, strategy.name, "info",
    `Extended ${side.toUpperCase()} order akan dikirim`,
    `Type: ${extOrderType} | Size: ${size.toFixed(6)} | Price: $${priceStr} | TickSize: ${resolvedTickSize} | Network: ${network}`
  );

  let result: { orderId: number; externalId: string };
  try {
    result = await placeExtendedOrder({
      apiKey: creds.apiKey!,
      privateKey: creds.privateKey!,
      collateralPosition: creds.collateralPosition!,
      market: strategy.marketSymbol,
      type: extOrderType,
      side: side === "buy" ? "BUY" : "SELL",
      qty: size.toFixed(resolvedStepDecimals),
      price: priceStr,
      timeInForce: extTimeInForce,
      postOnly,
      reduceOnly,
      network,
    });
  } catch (err: any) {
    const msg = err instanceof Error ? err.message : String(err);

    // BUG-EXT-REDUCEONLY-NOPOS-001 / BUG-EXT-SAMEPOS-001 / BUG-EXT-LONGSELL-001:
    // API tolak reduce-only order karena (a) belum ada posisi, atau (b) posisi di sisi yang sama.
    // FIX: SKIP order ini — JANGAN retry tanpa reduceOnly.
    // Alasan: di mode Long/Short, retry tanpa reduceOnly bisa membuka posisi berlawanan
    // (contoh: SELL di Long mode tanpa reduceOnly → membuka SHORT, bukan tutup Long).
    // Perilaku ini identik dengan extExecuteMultipleLiveOrders yang sudah benar (skip, tidak retry).
    if (reduceOnly && (
      msg.includes("Position is missing for reduce-only order") ||
      msg.includes("Position is same side as reduce-only order")
    )) {
      logger.warn(
        { strategyId: strategy.id, side, market: strategy.marketSymbol },
        "[ExtendedBot] reduceOnly ditolak — order di-skip (hindari buka posisi berlawanan)"
      );
      await extAddLog(
        userId, strategy.id, strategy.name, "warn",
        "reduceOnly ditolak — order di-skip (mode Long/Short: tidak buka posisi berlawanan)",
        msg
      );
      return;
    }

    logger.error(
      { strategyId: strategy.id, side, market: strategy.marketSymbol, err: msg },
      "[ExtendedBot] Order submission FAILED"
    );
    await extAddLog(userId, strategy.id, strategy.name, "error", "Order submission gagal", msg);
    if (userId !== null) {
      const notif = await extGetNotificationConfig(userId);
      if (notif.notifyOnError) {
        await extNotifyUser(userId, formatOrderFailed("extended", strategy.name, msg));
      }
    }
    await extRecordTrade({
      userId,
      strategyId: strategy.id,
      strategyName: strategy.name,
      marketIndex: strategy.marketIndex,
      marketSymbol: strategy.marketSymbol,
      side,
      size,
      price: currentPrice,
      status: "failed",
      errorMessage: msg,
    });
    return;
  }

  // Extended REST mengkonfirmasi order diterima secara sinkron, BUKAN order terisi.
  // Dokumentasi: "Order placement returns an order ID immediately, before the order is recorded in the book."
  // - Market (IOC): tandai pending juga — Account WS (ORDER/TRADE event) atau polling akan konfirmasi.
  //   IOC yang tidak terpenuhi akan di-cancel exchange; polling akan update status sesuai.
  // - Limit/GTT   : tandai pending — polling akan update status nanti.
  const tradeStatus = "pending"; // selalu pending sampai dikonfirmasi via WS atau polling

  // orderHash = externalId (UUID yang kita generate) dengan prefix "ext_"
  const orderHash = `ext_${result.externalId}`;

  await extRecordTrade({
    userId,
    strategyId: strategy.id,
    strategyName: strategy.name,
    marketIndex: strategy.marketIndex,
    marketSymbol: strategy.marketSymbol,
    side,
    size,
    price: executionPrice,
    status: tradeStatus,
    orderHash,
  });

  // Stats diupdate oleh Account WS atau polling saat trade dikonfirmasi filled/cancelled.

  await extAddLog(
    userId, strategy.id, strategy.name, "success",
    `Live ${side.toUpperCase()} order diterima (${extOrderType})`,
    `ExtOrderId: ${result.orderId} | ExternalId: ${result.externalId} | Price: $${priceStr} | Status: ${tradeStatus}`
  );

}

// ─── EKSEKUSI MULTIPLE LIVE ORDERS (untuk Grid multi-level) ──────────────────
// Berbeda dari Lighter yang pakai sendTxBatch:
// Extended TIDAK punya batch endpoint — order dikirim satu per satu secara sequential.

async function extExecuteMultipleLiveOrders(params: {
  userId: number | null;
  strategy: typeof strategiesTable.$inferSelect;
  creds: ExtendedCredentials;
  side: "buy" | "sell";
  size: Decimal;
  currentPrice: Decimal;
  orderCount: number;
  orderKind?: "market" | "limit" | "post_only";
  limitPriceOffset?: number;
  stepSize?: string;
  reduceOnly?: boolean;
  // E-003 FIX: grid params untuk menghitung harga per level yang dilewati.
  // Setiap order mendapatkan harga level grid-nya sendiri, bukan semua di currentPrice.
  lastLevel: number;
  gridLower: Decimal;
  gridSpacing: Decimal;
  direction: "up" | "down";
}): Promise<void> {
  const { userId, strategy, creds, side, size, currentPrice, orderCount } = params;
  const orderKind = params.orderKind ?? "market";
  const limitPriceOffset = params.limitPriceOffset ?? 0;
  const reduceOnly = params.reduceOnly ?? false;
  const network = creds.network;

  // ── Ambil market info untuk stepSize dan tickSize (cached) ─────────────────
  const multiMarketInfo = await getExtendedMarketInfo(strategy.marketSymbol, undefined, network).catch(() => null);
  const multiStepSize = multiMarketInfo?.stepSize ?? params.stepSize ?? "0.0001";
  const multiTickSize = multiMarketInfo?.tickSize ?? "0.1";
  const multiStepDecimals = multiStepSize.includes(".") ? multiStepSize.split(".")[1].length : 0;
  const multiTickDecimals = tickSizeDecimals(multiTickSize);

  // Order type & TIF dihitung sekali (tidak bergantung pada harga per-level)
  let extOrderType: "LIMIT" | "MARKET";
  let extTimeInForce: "GTT" | "IOC";
  let postOnly: boolean;

  if (orderKind === "market") {
    extOrderType = "MARKET";
    extTimeInForce = "IOC";
    postOnly = false;
  } else {
    extOrderType = "LIMIT";
    extTimeInForce = "GTT";
    postOnly = orderKind === "post_only";
  }

  const isIoc = extTimeInForce === "IOC";
  let successCount = 0;

  for (let i = 0; i < orderCount; i++) {
    // E-003 FIX: hitung level grid yang dilewati pada iterasi ke-i.
    // direction "up" (sell): level naik dari lastLevel → lastLevel+1, +2, ...
    // direction "down" (buy): level turun dari lastLevel → lastLevel-1, -2, ...
    const levelIndex = params.direction === "up"
      ? params.lastLevel + i + 1
      : params.lastLevel - i - 1;
    const levelBasePrice = params.gridLower.add(params.gridSpacing.mul(levelIndex));

    // Hitung executionPrice dari levelBasePrice (bukan currentPrice)
    let iterExecutionPrice: Decimal;
    if (orderKind === "market") {
      const marketPriceStr = calcMarketOrderPrice(
        levelBasePrice.toFixed(8),
        side === "buy" ? "BUY" : "SELL",
        multiTickDecimals
      );
      iterExecutionPrice = roundToTickSize(new Decimal(marketPriceStr), multiTickSize, side);
    } else {
      const offset = levelBasePrice.mul(new Decimal(limitPriceOffset)).div(100);
      const rawPrice = side === "buy" ? levelBasePrice.sub(offset) : levelBasePrice.add(offset);
      iterExecutionPrice = roundToTickSize(rawPrice, multiTickSize, side);
    }
    const iterPriceStr = iterExecutionPrice.toFixed(multiTickDecimals);

    try {
      const result = await placeExtendedOrder({
        apiKey: creds.apiKey!,
        privateKey: creds.privateKey!,
        collateralPosition: creds.collateralPosition!,
        market: strategy.marketSymbol,
        type: extOrderType,
        side: side === "buy" ? "BUY" : "SELL",
        qty: size.toFixed(multiStepDecimals),
        price: iterPriceStr,
        timeInForce: extTimeInForce,
        postOnly,
        reduceOnly,
        network,
      });

      const orderHash = `ext_${result.externalId}`;
      // BUG-GRID-002: Selalu "pending" — konsisten dengan extExecuteLiveOrder (single-order).
      // Market/IOC order di Extended REST hanya berarti order diterima, BUKAN order terisi.
      // Konfirmasi fill ditangani oleh Account WS (handleExtendedOrderEvent/TradeEvent) atau polling.
      const tradeStatus = "pending";

      await extRecordTrade({
        userId,
        strategyId: strategy.id,
        strategyName: strategy.name,
        marketIndex: strategy.marketIndex,
        marketSymbol: strategy.marketSymbol,
        side,
        size,
        price: iterExecutionPrice,
        status: tradeStatus,
        orderHash,
      });

      // Stats diupdate oleh Account WS/polling saat fill dikonfirmasi, bukan di sini.

      successCount++;
      logger.info(
        { orderId: result.orderId, externalId: result.externalId, i, orderCount },
        "[ExtendedBot] Sequential order sent"
      );
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : String(err);

      // BUG-EXT-REDUCEONLY-NOPOS-001 (multi-order): skip order ini saja — tidak retry karena
      // dalam batch multi-order, retry tanpa reduceOnly bisa buka posisi yang tidak diinginkan.
      // BUG-EXT-SAMEPOS-001: tangani "same side" dengan cara yang sama — skip order ini.
      if (reduceOnly && (
        msg.includes("Position is missing for reduce-only order") ||
        msg.includes("Position is same side as reduce-only order")
      )) {
        logger.warn({ i, orderCount, side }, "[ExtendedBot] Sequential: reduceOnly ditolak (no/same-side position), skip order ini");
        await extAddLog(userId, strategy.id, strategy.name, "warn",
          `Order ${i + 1}/${orderCount} di-skip — reduceOnly ditolak (no/same-side position)`, msg);
        continue;
      }

      logger.error({ err, i, orderCount }, "[ExtendedBot] Sequential order failed");
      await extAddLog(userId, strategy.id, strategy.name, "error",
        `Order ${i + 1}/${orderCount} gagal`, msg);

      await extRecordTrade({
        userId,
        strategyId: strategy.id,
        strategyName: strategy.name,
        marketIndex: strategy.marketIndex,
        marketSymbol: strategy.marketSymbol,
        side,
        size,
        price: levelBasePrice,
        status: "failed",
        errorMessage: msg,
      });
    }
  }

  if (successCount > 0) {
    await extAddLog(
      userId, strategy.id, strategy.name, "success",
      `${successCount}/${orderCount} order Extended berhasil dikirim`,
      `Type: ${extOrderType} | Size each: ${size.toFixed(6)} | Prices: per-level (E-003)`
    );

  }
}

// ─── EKSEKUSI GRID CHECK ─────────────────────────────────────────────────────
// Logika identik dengan Lighter (level crossing, SL/TP, mode neutral/long/short),
// namun menggunakan Extended order manager dan WS yang berbeda.

async function extExecuteGridCheck(strategy: typeof strategiesTable.$inferSelect): Promise<void> {
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
  } | null;

  if (!config) return;

  const userId = strategy.userId ?? null;
  const execMultiplier = getExecModeMultiplier(config.executionMode);

  // ── SHORT-CIRCUIT a/b: Cek timeout/pending rerange SEBELUM fetch credentials/harga ──
  // Jika ada pending konfirmasi, bot tidak boleh menjalankan logika grid sama sekali.
  // EXT-CACHE-001: Cache currentPrice dari block (b) agar tidak double-call extGetCurrentPrice
  // saat harga kembali ke range dan kita lanjut ke logika grid normal.
  let _cachedCurrentPrice: Decimal | null = null;

  if (strategy.pendingRerangeAt) {
    const elapsed = Date.now() - new Date(strategy.pendingRerangeAt).getTime();
    if (elapsed > PENDING_TIMEOUT_MS) {
      // (a) Timeout 20 menit: clear state, pause bot, kirim notifikasi
      await clearRerangeState(strategy.id);
      await extAddLog(
        userId, strategy.id, strategy.name, "warn",
        "⏸ Auto-Rerange timeout: tidak ada konfirmasi dalam 20 menit. Bot di-pause.",
        "User tidak merespons konfirmasi rerange. Atur parameter manual dari dashboard."
      );
      const pauseNotifCfg = userId !== null ? await getBotConfig(userId).catch(() => null) : null;
      await sendMainBotMessageWithButton(
        pauseNotifCfg?.notifyChatId,
        formatBotPaused("extended", strategy.name, "Tidak ada konfirmasi rerange dalam 20 menit"),
        { text: "▶️ Start Bot", callback_data: `bot_restart_${strategy.id}` }
      );
      await stopExtendedBot(strategy.id);
      return;
    }
        // (b) Belum timeout — cek apakah harga sudah kembali ke range
        // EXT-01: Gunakan getExtendedConfig (bukan getBotConfig/Lighter) untuk network Extended
        const credsCheck = userId !== null ? await getExtendedConfig(userId) : null;
        const networkCheck = (credsCheck?.network ?? "mainnet") as ExtendedNetwork;
        const priceCheck = await extGetCurrentPrice(strategy.marketSymbol, networkCheck);
        if (priceCheck) {
          const lower = new Decimal(config.lowerPrice);
          const upper = new Decimal(config.upperPrice);
          if (priceCheck.gte(lower) && priceCheck.lte(upper)) {
            // (b-hit) Harga kembali ke range → batalkan pending rerange otomatis
            await clearRerangeState(strategy.id);
            await extAddLog(
              userId, strategy.id, strategy.name, "info",
              `✅ Harga kembali ke range ($${priceCheck.toFixed(4)}). Pending rerange dibatalkan otomatis.`,
              `Range: $${lower.toFixed(4)} - $${upper.toFixed(4)}`
            );
            // Tidak return → lanjutkan ke logika grid normal di bawah
            // Cache hasil fetch agar tidak double-call di block utama (EXT-CACHE-001)
            _cachedCurrentPrice = priceCheck;
          } else {
            // (c) Masih di luar range, belum timeout → tunggu konfirmasi user
            return;
          }
        } else {
          // Tidak bisa fetch harga → skip tick ini
          return;
        }
      }
  // ──────────────────────────────────────────────────────────────────────────────

  const creds = userId !== null ? await getExtendedConfig(userId) : null;
  const hasCredentials = creds?.hasCredentials ?? false;

  // Network HARUS diambil dari credentials user, bukan default "mainnet".
  // Ini menentukan: (1) endpoint REST/WS yang dituju, (2) chainId domain untuk signing.
  const network = (creds?.network ?? "mainnet") as ExtendedNetwork;

  // Gunakan marketSymbol (string) untuk Extended, bukan marketIndex (integer).
  // Gunakan harga yang sudah di-cache dari block pendingRerange jika tersedia (EXT-CACHE-001)
  const currentPrice = _cachedCurrentPrice ?? await extGetCurrentPrice(strategy.marketSymbol, network);
  if (!currentPrice) {
    await extAddLog(userId, strategy.id, strategy.name, "warn",
      "Harga market tidak tersedia untuk grid check Extended",
      `Market: ${strategy.marketSymbol} | Network: ${network}`
    );
    return;
  }

  // ── Stop Loss / Take Profit ─────────────────────────────────────────────────
  const slTriggered = config.stopLoss
    ? isSlTriggered(config.mode ?? "neutral", currentPrice.toNumber(), config.stopLoss)
    : false;
  if (slTriggered) {
    await extAddLog(userId, strategy.id, strategy.name, "warn",
      `Stop Loss dipicu di $${currentPrice.toFixed(2)} (SL: $${config.stopLoss})`,
      "Bot Extended dihentikan otomatis karena stop loss"
    );
    if (userId !== null) {
      const notif = await extGetNotificationConfig(userId);
      if (notif.notifyOnStop) {
        await extNotifyUser(userId, formatStopLoss("extended", strategy.name, strategy.marketSymbol, currentPrice.toFixed(2), config.stopLoss ?? 0));
      }
    }
    await stopExtendedBot(strategy.id);
    return;
  }

  const tpTriggered = config.takeProfit
    ? isTpTriggered(config.mode ?? "neutral", currentPrice.toNumber(), config.takeProfit)
    : false;
  if (tpTriggered) {
    await extAddLog(userId, strategy.id, strategy.name, "success",
      `Take Profit dipicu di $${currentPrice.toFixed(2)} (TP: $${config.takeProfit})`,
      "Bot Extended dihentikan otomatis karena take profit"
    );
    if (userId !== null) {
      const notif = await extGetNotificationConfig(userId);
      if (notif.notifyOnStop) {
        await extNotifyUser(userId, formatTakeProfit("extended", strategy.name, strategy.marketSymbol, currentPrice.toFixed(2), config.takeProfit ?? 0));
      }
    }
    await stopExtendedBot(strategy.id);
    return;
  }

  // ── Kalkulasi level grid ────────────────────────────────────────────────────
  const lower = new Decimal(config.lowerPrice);
  const upper = new Decimal(config.upperPrice);
  const levels = config.gridLevels;
  const amountPerGrid = new Decimal(config.amountPerGrid);
  const mode = config.mode ?? "neutral";
  const gridSpacing = upper.sub(lower).div(levels);

  // ── F4: Follow-Market Grid ────────────────────────────────────────────────
  if (config.followMarket) {
    let fmStateExt = extendedFollowMarketStates.get(strategy.id);
    if (!fmStateExt) {
      fmStateExt = {
        gridCenterPrice: lower.add(upper).div(2),
        lastReanchorAt:  null,
        originalRange:   upper.sub(lower),
      };
      extendedFollowMarketStates.set(strategy.id, fmStateExt);
    }
    const triggerPctExt    = (config.followMarketTriggerPct    ?? 1.0) / 100;
    const minIntervalMsExt = (config.followMarketMinIntervalMin ?? 5)   * 60 * 1000;
    const deviationExt     = currentPrice.sub(fmStateExt.gridCenterPrice).abs().div(fmStateExt.gridCenterPrice).toNumber();
    const intervalOkExt    = fmStateExt.lastReanchorAt === null || (Date.now() - fmStateExt.lastReanchorAt.getTime() > minIntervalMsExt);

    if (deviationExt > triggerPctExt && intervalOkExt) {
      const halfRangeExt = fmStateExt.originalRange.div(2);
      const newLowerExt  = currentPrice.sub(halfRangeExt);
      const newUpperExt  = currentPrice.add(halfRangeExt);
      const oldCenterExt = fmStateExt.gridCenterPrice.toFixed(2);

      const updatedCfgExt: GridConfig = { ...(strategy.gridConfig as GridConfig), lowerPrice: newLowerExt.toNumber(), upperPrice: newUpperExt.toNumber() };
      await db.update(strategiesTable)
        .set({ gridConfig: updatedCfgExt, updatedAt: new Date() })
        .where(eq(strategiesTable.id, strategy.id));

      // Cancel all open orders for THIS strategy only — mirror pattern RERANGE-EXT-CANCEL-001.
      // Bug EXT-F4-CANCEL-001: cancel via markets[] membatalkan SEMUA order user di market tsb,
      // termasuk order dari strategy lain. Fix: cancel via externalOrderIds spesifik strategy ini.
      if (creds?.apiKey) {
        const f4PendingTrades = await db.query.tradesTable.findMany({
          where: and(eq(tradesTable.strategyId, strategy.id), eq(tradesTable.status, "pending"), isNotNull(tradesTable.orderHash)),
        });
        const f4ExternalIds = f4PendingTrades
          .map((t: any) => t.orderHash as string | null)
          .filter((h): h is string => !!h && h.startsWith("ext_") && !h.startsWith("ext_paper_"))
          .map(h => h.slice("ext_".length));
        if (f4ExternalIds.length > 0) {
          await massCancelExtendedOrders({
            apiKey: creds.apiKey,
            externalOrderIds: f4ExternalIds,
            network: creds.network,
          }).catch((err: unknown) => logger.warn({ err, strategyId: strategy.id }, "[ExtendedBot] F4 massCancelExtendedOrders partial failure"));
        }
      }
      await db.update(tradesTable)
        .set({ status: "failed", errorMessage: "F4: grid re-anchored" })
        .where(and(eq(tradesTable.strategyId, strategy.id), eq(tradesTable.status, "pending")));

      extendedGridStates.delete(strategy.id);
      cancelledExtendedReplays.delete(strategy.id);

      fmStateExt.gridCenterPrice = currentPrice;
      fmStateExt.lastReanchorAt  = new Date();
      extendedFollowMarketStates.set(strategy.id, fmStateExt);

      await extAddLog(userId, strategy.id, strategy.name, "info",
        `F4: Grid re-anchored $${oldCenterExt} → $${currentPrice.toFixed(2)}`,
        `New range: $${newLowerExt.toFixed(2)} – $${newUpperExt.toFixed(2)}`
      );
      return;
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  // Out-of-range: delegasikan ke Auto-Rerange engine (shared dengan Lighter).
  // handleAutoRerange mengelola: counter candle (atomic), cooldown 2 jam, daily limit 3x,
  // AI call, simpan pending state ke DB, dan kirim konfirmasi ke Telegram.
  // pendingRerangeAt sudah dicek di short-circuit block di atas, sehingga di sini
  // dijamin pendingRerangeAt IS NULL — handleAutoRerange hanya akan di-hit saat needed.
  if (currentPrice.lt(lower) || currentPrice.gt(upper)) {
    const rerangeResult = await handleAutoRerange(strategy, currentPrice);

    switch (rerangeResult.type) {
      case "triggered":
        // Konfirmasi sudah dikirim ke Telegram. Bot menunggu respons user.
        // Tick berikutnya akan short-circuit via pendingRerangeAt check di atas.
        await extAddLog(
          userId, strategy.id, strategy.name, "warn",
          `🤖 Auto-Rerange triggered: harga $${currentPrice.toFixed(4)} keluar range. Menunggu konfirmasi user.`,
          `Range lama: $${lower.toFixed(4)}-$${upper.toFixed(4)} | Range baru AI: $${rerangeResult.params.newLowerPrice.toFixed(4)}-$${rerangeResult.params.newUpperPrice.toFixed(4)}`
        );
        break;
      case "continue": {
        // Counter belum cukup (< 5 tick), atau cooldown aktif, atau limit harian.
        // Tetap log warning agar user bisa monitor progress di dashboard.
        const displayCount = (strategy.consecutiveOutOfRange ?? 0) + 1;
        const continueMsg = displayCount >= 5
          ? `Harga $${currentPrice.toFixed(4)} di luar range — cooldown/limit harian aktif, trigger ditunda`
          : `Harga $${currentPrice.toFixed(4)} di luar range ($${lower.toFixed(4)} - $${upper.toFixed(4)}) — menunggu (${displayCount}/5 ticks)`;
        await extAddLog(userId, strategy.id, strategy.name, "warn", continueMsg);
        break;
      }
      // "short_circuit" dan "timeout" tidak akan terjadi di sini —
      // sudah ditangani di short-circuit block di atas sebelum price fetch.
    }
    return;
  }

  const currentLevel = Math.min(
    Math.floor(currentPrice.sub(lower).div(gridSpacing).toNumber()),
    levels - 1
  );

  const existingState = extendedGridStates.get(strategy.id);

  // Inisialisasi pertama: simpan state, jangan buat order
  if (!existingState) {
    extendedGridStates.set(strategy.id, { lastLevel: currentLevel, initializedAt: new Date() });
    // EXT-02: Persist gridLastLevel ke DB (fire-and-forget) — mirror Lighter untuk daya tahan restart
    db.update(strategiesTable)
      .set({ gridLastLevel: currentLevel, updatedAt: new Date() })
      .where(eq(strategiesTable.id, strategy.id))
      .catch((e: unknown) => logger.warn({ e, strategyId: strategy.id }, "[extendedBotEngine] Gagal persist gridLastLevel (init)"));
    await extAddLog(
      userId, strategy.id, strategy.name, "info",
      `Grid Extended diinisialisasi di level ${currentLevel}/${levels}`,
      `Harga: $${currentPrice.toFixed(2)} | Range: $${lower.toFixed(2)}-$${upper.toFixed(2)} | Spacing: $${gridSpacing.toFixed(2)}`
    );
    return;
  }

  const lastLevel = existingState.lastLevel;

  if (currentLevel === lastLevel) {
    await extAddLog(
      userId, strategy.id, strategy.name, "info",
      `Grid check Extended: level ${currentLevel}/${levels} | harga $${currentPrice.toFixed(2)} | tidak ada crossing`
    );
    return;
  }

  const levelsMoved = currentLevel - lastLevel;
  const direction = levelsMoved < 0 ? "down" : "up";
  const side = computeGridSide(levelsMoved);
  const reduceOnly = computeReduceOnly(mode, side);

  // Update state segera untuk mencegah re-trigger
  existingState.lastLevel = currentLevel;
  // EXT-02: Persist updated level ke DB (fire-and-forget) — mirror Lighter
  db.update(strategiesTable)
    .set({ gridLastLevel: currentLevel, updatedAt: new Date() })
    .where(eq(strategiesTable.id, strategy.id))
    .catch((e: unknown) => logger.warn({ e, strategyId: strategy.id }, "[extendedBotEngine] Gagal persist gridLastLevel (update)"));

  const orderCount = Math.min(Math.abs(levelsMoved), EXT_MAX_GRID_ORDERS);
  const rawSize = amountPerGrid.div(currentPrice);

  // Round down size ke stepSize market agar tidak ditolak API (Invalid quantity precision)
  const gridMarketInfo = await getExtendedMarketInfo(strategy.marketSymbol, undefined, creds?.network ?? "mainnet").catch(() => null);
  const gridStepSize = gridMarketInfo?.stepSize ?? "0.0001";
  const gridTickSize = gridMarketInfo?.tickSize ?? "0.1";
  const gridTickDecimals = tickSizeDecimals(gridTickSize);
  const size = roundToStepSize(rawSize, gridStepSize);

  if (size.lte(0)) {
    await extAddLog(userId, strategy.id, strategy.name, "warn",
      "Size Grid terlalu kecil setelah pembulatan",
      `Raw: ${rawSize.toFixed(8)} | Step: ${gridStepSize} | Rounded: ${size.toFixed(8)}`
    );
    return;
  }

  await extAddLog(
    userId, strategy.id, strategy.name, "info",
    `Grid Extended: crossing ${Math.abs(levelsMoved)} level ${direction} → ${side.toUpperCase()} ×${orderCount}`,
    `Level: ${lastLevel} → ${currentLevel} | Harga: $${currentPrice.toFixed(2)} | Size each: ${size.toFixed(6)} | Step: ${gridStepSize}`
  );

  // BUG-DUP-001: Gunakan executionPrice sebagai targetPrice — konsisten dengan apa yang disimpan ke DB.
  // Extended limit/post_only menyimpan price = currentPrice ± offset;
  // market menyimpan executionPrice = calcMarketOrderPrice(currentPrice, side) ≈ currentPrice ± 0.75%.
  // DUP-DEFAULT-001: default harus "limit" — konsisten dengan grid execution baris 1373/1382.
  const orderKindForTol = config.orderType ?? "limit";
  const isMarketOrderKind = orderKindForTol === "market";
  const offsetForTol = currentPrice.mul(new Decimal((config.limitPriceOffset ?? 0) * execMultiplier)).div(100);
  // EXT-MKTDUP-001: market order store executionPrice ≈ currentPrice ± 0.75% (calcMarketOrderPrice buffer).
  // Tolerance range (0.1% price / 40% gridSpacing) tidak cukup cover offset 0.75% → dup check bypass.
  // Fix: gunakan price aktual (dengan buffer 0.75%) sebagai targetPrice untuk market orders.
  const targetPrice = isMarketOrderKind
    ? parseFloat(calcMarketOrderPrice(currentPrice.toFixed(8), side === "buy" ? "BUY" : "SELL", gridTickDecimals))
    : (orderKindForTol === "limit" || orderKindForTol === "post_only")
      ? (side === "buy" ? currentPrice.sub(offsetForTol) : currentPrice.add(offsetForTol)).toNumber()
      : currentPrice.toNumber();
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
    logger.info({ strategyId: strategy.id, side, targetPrice }, "Skip: pending order sudah ada di level ini");
    return;
  }

  // F3: Inventory Skew — compute per-side offset multiplier
  const skewStateExt = extendedSkewStates.get(strategy.id) ?? { cumulativeBuyQty: new Decimal(0), cumulativeSellQty: new Decimal(0) };
  const referenceQtyExt = size.mul(config.gridLevels);
  const skewExt = computeSkewMultipliers(skewStateExt, {
    enabled: config.inventorySkewEnabled,
    threshold: config.inventorySkewThreshold,
    maxMult: config.inventorySkewMaxMult,
    pauseAt: config.inventorySkewPauseAt,
  }, referenceQtyExt);
  if ((side === "buy" && skewExt.pauseBuy) || (side === "sell" && skewExt.pauseSell)) {
    await extAddLog(userId, strategy.id, strategy.name, "info",
      `F3: Inventory skew pause — sisi ${side.toUpperCase()} ditangguhkan sementara`,
      `Buy: ${skewStateExt.cumulativeBuyQty.toFixed(6)} | Sell: ${skewStateExt.cumulativeSellQty.toFixed(6)}`
    );
    return;
  }
  const skewMultExt = side === "buy" ? skewExt.buyMult : skewExt.sellMult;
  const effectiveOffsetExt = (config.limitPriceOffset ?? 0) * execMultiplier * skewMultExt;

  if (!hasCredentials) {
    // Paper trading — simulasi satu order per level yang di-cross
    await extExecutePaperTrade({ userId, strategy, side, size, price: currentPrice, orderCount });
  } else if (orderCount === 1) {
    await extExecuteLiveOrder({
      userId, strategy, creds: creds!, side, size, currentPrice,
      orderKind: config.orderType ?? "limit", // GRID-NEW-003: default "limit" (maker fee)
      limitPriceOffset: effectiveOffsetExt,
      stepSize: gridStepSize,
      reduceOnly,
    });
  } else {
    // E-003 FIX: pass grid params langsung ke fungsi — harga per level dihitung di dalam loop.
    // Tidak ada batch di Extended — kirim sequential, masing-masing dengan harga levelnya.
    await extExecuteMultipleLiveOrders({
      userId, strategy, creds: creds!, side, size, currentPrice,
      orderCount,
      orderKind: config.orderType ?? "limit", // GRID-NEW-003: default "limit" (maker fee)
      limitPriceOffset: effectiveOffsetExt,
      stepSize: gridStepSize,
      reduceOnly,
      lastLevel,        // level grid sebelum crossing — sudah ada di scope (line 1474)
      gridLower: lower, // batas bawah range — sudah ada di scope (line 1355)
      gridSpacing,      // jarak antar level — sudah ada di scope (line 1360)
      direction,        // arah crossing — sudah ada di scope (line 1476)
    });
  }
}

// ─── JALANKAN STRATEGY SEKALI ─────────────────────────────────────────────────

async function extRunStrategyOnce(strategyId: number): Promise<void> {
  const strategy = await db.query.strategiesTable.findFirst({
    where: eq(strategiesTable.id, strategyId),
  });

  if (!strategy) {
    logger.warn({ strategyId }, "[ExtendedBot] DB query returned null — skipping tick, bot stays running");
    return;
  }

  if (!strategy.isActive || !strategy.isRunning) {
    await stopExtendedBot(strategyId);
    return;
  }

  // Hanya jalankan strategy Extended
  if (strategy.exchange !== "extended") return;

  try {
    await extExecuteGridCheck(strategy);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await extAddLog(strategy.userId ?? null, strategy.id, strategy.name, "error",
      `Kesalahan eksekusi strategy Extended: ${message}`
    );
    logger.error({ err, strategyId }, "[ExtendedBot] Strategy execution error");
    if (strategy.userId) {
      extGetNotificationConfig(strategy.userId).then(notif => {
        if (notif.notifyOnError) {
          extNotifyUser(strategy.userId, formatOrderFailed("extended", strategy.name, message));
        }
      }).catch(() => {});
    }
  }
}

// ─── START / STOP BOT ─────────────────────────────────────────────────────────

export async function startExtendedBot(strategyId: number, options?: { isRestore?: boolean }): Promise<boolean> {
  if (extendedRunningBots.has(strategyId)) return true;
  // BE-003: Guard atomic — blokir request kedua yang tiba sebelum request pertama selesai
  if (startingExtendedBots.has(strategyId)) return false;
  // EXT-NEW-002 (Opsi B preventif): tolak start jika stopExtendedBot sedang berjalan.
  // Ini menutup race window di mana stop belum selesai saat start dipanggil.
  if (stoppingExtendedBots.has(strategyId)) {
    logger.warn({ strategyId }, "[ExtendedBot] startExtendedBot ditolak — stopExtendedBot sedang berjalan");
    return false;
  }
  startingExtendedBots.add(strategyId);
  try {

  const strategy = await db.query.strategiesTable.findFirst({
    where: eq(strategiesTable.id, strategyId),
  });

  if (!strategy) return false;

  // Pastikan strategy ini memang untuk Extended
  if (strategy.exchange !== "extended") {
    logger.warn({ strategyId, exchange: strategy.exchange }, "[ExtendedBot] startExtendedBot called on non-extended strategy");
    return false;
  }

  const userId = strategy.userId ?? null;

  // ── Pre-flight: validasi credentials ────────────────────────────────────────
  // Extended tidak punya minBaseAmount/minQuoteAmount yang mudah diakses seperti Lighter.
  // Validasi minimal: cek amount > 0.
  {
    let validationError: string | null = null;

    if (strategy.type === "grid") {
      const amount = strategy.gridConfig?.amountPerGrid ?? 0;
      if (amount <= 0) validationError = "amountPerGrid harus lebih dari 0.";
    }

    if (validationError) {
      await extAddLog(userId, strategyId, strategy.name, "error",
        `❌ Bot Extended tidak dapat dimulai: ${validationError}`
      );
      throw new Error(`EXTENDED_BOT_VALIDATION_FAILED: ${validationError}`);
    }
  }

  // ── Credential check — graceful abort jika belum dikonfigurasi ───────────────
  let startCreds: ExtendedCredentials | null = null;
  {
    const creds = userId !== null ? await getExtendedConfig(userId).catch(() => null) : null;
    if (!creds || !creds.hasCredentials) {
      await extAddLog(userId, strategyId, strategy.name, "error",
        `❌ Bot Extended tidak dapat dimulai: kredensial belum dikonfigurasi.`,
        `Isi API Key, Stark Private Key, dan Account ID di halaman Pengaturan > Extended DEX terlebih dahulu.`
      );
      logger.warn({ strategyId, userId }, "[ExtendedBot] Bot aborted — credentials missing. Lighter is unaffected.");
      throw new Error("EXTENDED_BOT_VALIDATION_FAILED: Kredensial Extended belum dikonfigurasi. Buka Pengaturan → Extended DEX dan isi API Key, Stark Private Key, serta Account ID.");
    }
    startCreds = creds;
  }

  // ── Validasi API key ke server Extended (test endpoint read-only) ─────────────
  // Ini mendeteksi API key salah/expired SEBELUM bot mulai trading,
  // sehingga error tidak muncul saat order gagal dengan pesan 401 yang tidak jelas.
  {
    const keyToCheck = startCreds!.apiKey!;
    const netToCheck = startCreds!.network;
    const validation = await validateExtendedApiKey(keyToCheck, netToCheck);
    if (!validation.valid) {
      const reason = validation.reason ?? "API key tidak valid.";
      await extAddLog(userId, strategyId, strategy.name, "error",
        `❌ Bot Extended tidak dapat dimulai: API key ditolak.`,
        reason
      );
      logger.warn({ strategyId, userId, network: netToCheck }, "[ExtendedBot] Bot aborted — API key rejected by Extended server.");
      throw new Error(`EXTENDED_BOT_VALIDATION_FAILED: ${reason}`);
    }
    logger.info({ strategyId, network: netToCheck }, "[ExtendedBot] API key validated OK");
  }

  // ── Validasi minOrderSize dari Extended Exchange ──────────────────────────────
  // Dilakukan SETELAH credentials resolved (network diambil dari startCreds).
  {
    const network = startCreds!.network;
    const marketInfo = await getExtendedMarketInfo(strategy.marketSymbol, undefined, network).catch(() => null);

    if (marketInfo) {
      // M-02: Blokir bot start jika market menggunakan fallback tickSize/stepSize.
      // Nilai fallback "0.01"/"0.001" bisa salah untuk market tertentu — order
      // akan ditolak exchange dengan "Invalid price precision" atau "Invalid quantity precision".
      if (marketInfo.hasFallbackPrecision) {
        const precMsg = `Market ${strategy.marketSymbol} tidak memiliki data presisi (tickSize/stepSize) ` +
          `dari Exchange API. Fallback hardcoded digunakan — order bisa ditolak karena precision salah.`;
        logger.error(
          { strategyId, market: strategy.marketSymbol, network },
          `[ExtendedBot] HARD STOP — fallback tickSize/stepSize detected. ${precMsg}`
        );
        await extAddLog(userId, strategyId, strategy.name, "error",
          `❌ Bot Extended tidak dapat dimulai: presisi market tidak tersedia.`,
          precMsg
        );
        throw new Error(`EXTENDED_BOT_VALIDATION_FAILED: ${precMsg}`);
      }

      const minOrderSize = parseFloat(marketInfo.minOrderSize ?? "0");

      const amount = strategy.gridConfig?.amountPerGrid ?? 0;

      // E-002: minOrderSize adalah qty base asset (e.g. 0.01 ETH, 100 DOGE), bukan USD.
      // amount (amountPerGrid) adalah dalam USD.
      // Konversi: qty = amount / refPrice, lalu bandingkan dengan minOrderSize.
      const refPrice = marketInfo.markPrice > 0 ? marketInfo.markPrice
                     : (marketInfo.lastPrice > 0 ? marketInfo.lastPrice : 0);

      if (minOrderSize > 0 && refPrice > 0) {
        const amountAsQty = amount / refPrice;
        if (amountAsQty < minOrderSize) {
          const amountField = "amountPerGrid";
          const minUsdApprox = (minOrderSize * refPrice).toFixed(2);
          const errMsg =
            `${amountField} ($${amount} USD) menghasilkan qty ≈ ${amountAsQty.toFixed(8)} base asset, ` +
            `di bawah minimum exchange untuk ${strategy.marketSymbol}: ${minOrderSize} base asset ` +
            `(≈ $${minUsdApprox} USD pada harga ~$${refPrice.toFixed(2)}).`;
          await extAddLog(userId, strategyId, strategy.name, "error",
            `❌ Bot Extended tidak dapat dimulai: order size terlalu kecil.`,
            errMsg
          );
          logger.warn(
            { strategyId, userId, amount, minOrderSize, amountAsQty, refPrice, market: strategy.marketSymbol, network },
            "[ExtendedBot] Bot aborted — amount below minOrderSize"
          );
          throw new Error(`EXTENDED_BOT_VALIDATION_FAILED: ${errMsg}`);
        }
      } else if (minOrderSize > 0 && refPrice <= 0) {
        // Harga tidak tersedia dari marketInfo (marketStats kosong) — skip validasi.
        // Exchange akan reject order individual jika qty terlalu kecil.
        logger.warn(
          { strategyId, market: strategy.marketSymbol, minOrderSize },
          "[ExtendedBot] refPrice tidak tersedia dari marketInfo — validasi minOrderSize dilewati"
        );
      }
    } else {
      // Market info gagal di-fetch (network error, market baru, dsb).
      // Log warning tapi jangan block start — bot masih bisa jalan, exchange
      // akan reject order individual jika size benar-benar terlalu kecil.
      logger.warn(
        { strategyId, market: strategy.marketSymbol, network },
        "[ExtendedBot] getExtendedMarketInfo gagal — validasi minOrderSize dilewati"
      );
    }
  }

  // ── Fetch l2Vault + verifikasi starkKey dari Extended API ────────────────────
  // l2Vault berbeda dari accountId yang user masukkan di Settings.
  // Tanpa nilai yang benar, setiap order akan ditolak: "Invalid StarkEx signature".
  //
  // Selain itu, kami verifikasi bahwa starkKey yang di-derive dari private key
  // cocok dengan starkKey yang terdaftar di akun Exchange. Mismatch ini adalah
  // penyebab paling umum "Invalid StarkEx signature" yang tidak bisa di-debug
  // tanpa pengecekan eksplisit.
  if (userId !== null && startCreds) {
    try {
      const accountDetails = await getAccountDetails(startCreds.apiKey!, startCreds.network);

      // ── Verifikasi starkKey mismatch ──────────────────────────────────────────
      // Derive starkKey dari private key yang tersimpan, lalu bandingkan
      // dengan l2Key dari account API (field aktual di Extended Exchange API).
      // NB: API response menggunakan "l2Key" bukan "starkKey".
      const registeredStarkKey: string | null =
        accountDetails ? (accountDetails.l2Key ?? null) : null;

      logger.info(
        {
          strategyId,
          userId,
          l2Key: registeredStarkKey ?? "(tidak tersedia di response)",
          hasPrivateKey: !!startCreds.privateKey,
        },
        "[ExtendedBot] Account details received — memulai starkKey (l2Key) verification"
      );

      if (registeredStarkKey && startCreds.privateKey) {
        let derivedKey: string | null = null;
        try {
          derivedKey = derivePublicKey(startCreds.privateKey);
        } catch (deriveErr) {
          logger.error(
            { err: deriveErr, strategyId, userId },
            "[ExtendedBot] Gagal derive starkKey dari private key — private key mungkin corrupt atau format salah."
          );
        }

        const registeredKeyNorm = registeredStarkKey.toLowerCase().replace(/^0x/, "");
        const derivedKeyNorm = derivedKey ? derivedKey.toLowerCase().replace(/^0x/, "") : null;

        logger.info(
          {
            strategyId,
            userId,
            registeredStarkKey: `0x${registeredKeyNorm}`,
            derivedStarkKey: derivedKey ?? "(gagal derive)",
            match: derivedKeyNorm === registeredKeyNorm,
          },
          "[ExtendedBot] StarkKey comparison — registered vs derived from privateKey"
        );

        if (derivedKeyNorm && derivedKeyNorm !== registeredKeyNorm) {
          const errMsg =
            `StarkKey mismatch! Private key yang tersimpan menghasilkan starkKey ` +
            `0x${derivedKeyNorm}, tetapi akun Exchange menggunakan 0x${registeredKeyNorm}. ` +
            `Pastikan Stark Private Key di Pengaturan Extended DEX sudah benar.`;

          await extAddLog(userId, strategyId, strategy.name, "error",
            `❌ Invalid StarkEx signature: StarkKey mismatch.`,
            errMsg
          );
          logger.error({ strategyId, userId, derivedKey, registeredStarkKey: `0x${registeredKeyNorm}` },
            "[ExtendedBot] Bot aborted — starkKey mismatch antara private key dan akun."
          );
          throw new Error(`EXTENDED_BOT_VALIDATION_FAILED: ${errMsg}`);
        }
      } else if (!registeredStarkKey) {
        logger.warn(
          { strategyId, userId },
          "[ExtendedBot] starkKey tidak tersedia di response account API — skip verifikasi mismatch."
        );
        throw new Error(
          `EXTENDED_BOT_VALIDATION_FAILED: [ExtendedBot] l2Key tidak tersedia dari API — tidak bisa verifikasi starkKey`
        );
      }

      // ── Ambil l2Vault ─────────────────────────────────────────────────────────
      // Handle camelCase (l2Vault) dan snake_case (l2_vault) — Extended Exchange API
      const rawVault = accountDetails ? (accountDetails.l2Vault ?? null) : null;
      if (rawVault != null) {
        const l2VaultStr = String(rawVault);
        l2VaultCache.set(userId, { l2Vault: l2VaultStr, fetchedAt: Date.now() });
        startCreds.collateralPosition = l2VaultStr;
        logger.info(
          { strategyId, userId, l2Vault: l2VaultStr, accountId: accountDetails?.accountId },
          "[ExtendedBot] l2Vault fetched from API — akan dipakai sebagai collateralPosition untuk signing"
        );
      } else {
        logger.warn(
          { strategyId, userId },
          "[ExtendedBot] Gagal fetch l2Vault dari API — fallback ke accountId yang tersimpan. Jika terjadi 'Invalid StarkEx signature', pastikan Account ID di Pengaturan diisi dengan l2Vault (bukan accountId)."
        );
        throw new Error(
          `EXTENDED_BOT_VALIDATION_FAILED: [ExtendedBot] l2Vault tidak tersedia dari API — tidak bisa sign order`
        );
      }
    } catch (err: any) {
      // Re-throw semua error — bot tidak boleh start tanpa l2Vault yang valid.
      // l2VaultCache dibiarkan kosong; bot restart berikutnya akan retry ke API.
      // Jangan telan error ini: fallback ke accountId tersimpan akan menyebabkan
      // semua order gagal "Invalid StarkEx signature" selama cache kosong.
      logger.error(
        { err, strategyId, userId },
        "[ExtendedBot] Gagal fetch account details — bot tidak bisa start tanpa l2Vault yang valid"
      );
      throw err;
    }
  }

  // ── Hubungkan account WS untuk konfirmasi limit/GTT order secara real-time ───
  // Dilakukan setelah credential check berhasil. Ref-counted per user.
  if (userId !== null && startCreds) {
    await ensureExtendedAccountWs(userId, startCreds.apiKey!, startCreds.network);
  }

  const isGrid = strategy.type === "grid";
  const intervalMs = EXT_GRID_FALLBACK_INTERVAL_MS;

  const nextRunAt = new Date(Date.now() + intervalMs);

  await db.update(strategiesTable)
    .set({ isRunning: true, isActive: true, updatedAt: new Date(), nextRunAt })
    .where(eq(strategiesTable.id, strategyId));

  // BUG-GRID-001: Restore grid state dari DB setelah restart (mirror BUG-L-005 Lighter)
  // Jika gridLastLevel tersimpan di DB, pulihkan ke in-memory state agar tick pertama
  // pasca restart tidak selalu "initialize" dan melewatkan satu crossing.
  if (isGrid && strategy.gridLastLevel !== null && strategy.gridLastLevel !== undefined) {
    if (!extendedGridStates.has(strategyId)) {
      extendedGridStates.set(strategyId, { lastLevel: strategy.gridLastLevel, initializedAt: new Date() });
      logger.info(
        { strategyId, gridLastLevel: strategy.gridLastLevel },
        "[ExtendedBot] Grid state restored dari DB setelah restart"
      );
    }
  }

  // Daftarkan WS callback untuk grid bot Extended — callback aktif untuk deteksi crossing level real-time.
  {
    const creds = userId !== null ? await getExtendedConfig(userId).catch(() => null) : null;
    const network = creds?.network ?? "mainnet";

    registerExtendedPriceCallback(
      strategy.marketSymbol,
      strategyId,
      isGrid
        ? (_midPrice: any, _market: any) => {
            const now = Date.now();
            const last = extendedWsGridLastTriggered.get(strategyId) ?? 0;
            if (now - last < EXT_WS_GRID_COOLDOWN_MS) return;
            if (!extendedRunningBots.has(strategyId)) return;
            extendedWsGridLastTriggered.set(strategyId, now);
            extRunStrategyOnce(strategyId).catch((err) => logger.error({ err, strategyId }, "[ExtendedBot] WS price callback error"));
          }
        : () => {},
      network
    );
  }

  const timer = setInterval(async () => {
    const bot = extendedRunningBots.get(strategyId);
    if (bot) {
      bot.nextRunAt = new Date(Date.now() + EXT_GRID_FALLBACK_INTERVAL_MS);
    }
    await extRunStrategyOnce(strategyId);
  }, intervalMs);

  // EXT-NEW-002 (Opsi A cleanup): jika stopExtendedBot selesai saat start masih in-flight,
  // rollback semua state yang sudah disiapkan agar tidak ada orphan callback / DB mismatch.
  if (stoppingExtendedBots.has(strategyId)) {
    clearInterval(timer);
    unregisterExtendedPriceCallback(strategy.marketSymbol, strategyId);
    if (userId !== null) releaseExtendedAccountWs(userId);
    await db.update(strategiesTable)
      .set({ isRunning: false, updatedAt: new Date(), nextRunAt: null })
      .where(eq(strategiesTable.id, strategyId));
    logger.warn({ strategyId }, "[ExtendedBot] startExtendedBot dibatalkan — stop in-flight, state di-rollback");
    return false;
  }

  extendedRunningBots.set(strategyId, { strategyId, timer, nextRunAt, startedAt: new Date() });

  // EXT-SYNC-001: Sinkronisasi order book saat bot start (non-blocking)
  // Extended hanya mendukung mainnet — hardcode untuk menghindari closure variable issue.
  if (isGrid && userId !== null) {
    syncExtendedOrderBookState(userId, strategy, "mainnet").catch((err) =>
      logger.warn({ err, strategyId }, "[ExtendedBot] EXT-SYNC-001: sync on start error — bot tetap berjalan")
    );
  }

  const intervalLabel = `WebSocket realtime + ${EXT_GRID_FALLBACK_INTERVAL_MS / 60000} menit fallback`;

  logger.info({ strategyId, type: strategy.type, exchange: "extended" }, "[ExtendedBot] Bot started");

  if (!options?.isRestore) {
    await extAddLog(strategy.userId ?? null, strategyId, strategy.name, "success",
      `Bot Extended dimulai`, `Mode: ${intervalLabel}`
    );
    if (strategy.userId !== null && strategy.userId !== undefined) {
      const notif = await extGetNotificationConfig(strategy.userId).catch(() => null);
      if (notif?.notifyOnStart) {
        await extNotifyUser(strategy.userId, formatBotStarted("extended", strategy.name, strategy.type, strategy.marketSymbol));
      }
    }
  }

  // Jalankan setelah 8 detik (beri waktu WS connect & terima harga pertama)
  setTimeout(() => extRunStrategyOnce(strategyId), 8000);

  return true;

  } finally {
    startingExtendedBots.delete(strategyId);
  }
}

export async function stopExtendedBot(strategyId: number, skipDbUpdate = false): Promise<boolean> {
  stoppingExtendedBots.add(strategyId);
  // EXTENDED-STOP-001: release lock sesegera mungkin setelah state bersih.
  // extNotifyUser & massCancelExtendedOrders adalah housekeeping — tidak perlu menahan lock.
  let lockReleased = false;
  const releaseLock = () => {
    if (!lockReleased) { lockReleased = true; stoppingExtendedBots.delete(strategyId); }
  };
  try {

  const bot = extendedRunningBots.get(strategyId);
  if (bot) {
    clearInterval(bot.timer);
    extendedRunningBots.delete(strategyId);
  }

  extendedGridStates.delete(strategyId);
  extendedSkewStates.delete(strategyId);
  extendedFollowMarketStates.delete(strategyId);
  extendedWsGridLastTriggered.delete(strategyId);

  const strategy = await db.query.strategiesTable.findFirst({
    where: eq(strategiesTable.id, strategyId),
  });

  // Reset rerange state: consecutive_out_of_range → 0, pending_rerange_at → null.
  // Jika ada pending rerange yang menunggu konfirmasi Telegram, kirim notifikasi
  // bahwa konfirmasi itu sudah tidak berlaku sebelum state di-clear.
  await cancelPendingRerangeOnStop(strategyId, strategy?.userId ?? null, strategy?.name ?? "");

  // Hapus WS callback untuk semua tipe bot Extended (grid DAN dca)
  if (strategy) {
    unregisterExtendedPriceCallback(strategy.marketSymbol, strategyId);
  }

  // Lepaskan referensi account WS — disconnect jika tidak ada bot lain yang berjalan untuk user ini
  const userId = strategy?.userId ?? null;
  if (userId !== null) {
    releaseExtendedAccountWs(userId);
  }

  if (!skipDbUpdate) await db.update(strategiesTable)
    .set({ isRunning: false, updatedAt: new Date(), nextRunAt: null })
    .where(eq(strategiesTable.id, strategyId));

  // State sudah bersih — lepas lock agar startExtendedBot tidak terblok housekeeping.
  releaseLock();

  if (strategy) {
    await extAddLog(strategy.userId ?? null, strategyId, strategy.name, "warn", "Bot Extended dihentikan");
    if (strategy.userId !== null && strategy.userId !== undefined) {
      const notif = await extGetNotificationConfig(strategy.userId).catch(() => null);
      if (notif?.notifyOnStop) {
        await extNotifyUser(strategy.userId, formatBotStopped("extended", strategy.name, strategy.marketSymbol));
      }
    }

    // Cancel HANYA order milik strategy ini — ambil externalId dari DB
    // E-NEW-1: massCancelExtendedOrders({ markets }) membatalkan SEMUA order user di market
    // tersebut, termasuk order dari strategy lain yang masih berjalan. Fix: gunakan
    // externalOrderIds agar hanya order strategy ini yang dibatalkan.
    const stopCreds = strategy.userId !== null
      ? await getExtendedConfig(strategy.userId).catch(() => null)
      : null;
    if (stopCreds?.apiKey) {
      const pendingForStrategy = await db.query.tradesTable.findMany({
        where: and(
          eq(tradesTable.strategyId, strategyId),
          eq(tradesTable.status, "pending"),
          isNotNull(tradesTable.orderHash),
          ne(tradesTable.orderHash, "")
        ),
      });

      const externalIdsToCancel = pendingForStrategy
        .filter((t) => t.orderHash?.startsWith("ext_") && !t.orderHash?.startsWith("ext_paper_"))
        .map((t) => t.orderHash!.slice("ext_".length));

      if (externalIdsToCancel.length > 0) {
        await massCancelExtendedOrders({
          apiKey: stopCreds.apiKey,
          externalOrderIds: externalIdsToCancel,
          network: stopCreds.network,
        }).catch((err: unknown) => {
          logger.warn({ err, strategyId }, "[ExtendedBot] massCancelExtendedOrders gagal saat stop — order mungkin masih open");
        });
      }
    }
  }

  return true;

  } finally {
    releaseLock(); // safety net: jika exception sebelum releaseLock() di atas
  }
}

// ─── RESTORE BOTS YANG SEDANG RUNNING SAAT RESTART SERVER ────────────────────

export async function restoreRunningExtendedBots(): Promise<void> {
  const strategies = await db.query.strategiesTable.findMany({
    where: and(
      eq(strategiesTable.isRunning, true),
      eq(strategiesTable.exchange, "extended")
    ),
  });

  for (const strategy of strategies) {
    logger.info({ strategyId: strategy.id }, "[ExtendedBot] Restoring running extended bot");
    try {
      await startExtendedBot(strategy.id, { isRestore: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isValidationFail = message.startsWith("EXTENDED_BOT_VALIDATION_FAILED:");

      logger.error({ strategyId: strategy.id, err }, "[ExtendedBot] Failed to restore extended bot");

      await db.update(strategiesTable)
        .set({ isRunning: false, updatedAt: new Date(), nextRunAt: null })
        .where(eq(strategiesTable.id, strategy.id));

      if (isValidationFail) {
        logger.warn(
          { strategyId: strategy.id, reason: message },
          "[ExtendedBot] Bot config tidak valid setelah restart — ditandai sebagai stopped. User harus review settings."
        );
      }
    }
  }
}

// ─── MONITORING TRADE PENDING (untuk Limit/GTT orders) ───────────────────────
// Konfirmasi fill/cancel ditangani secara real-time oleh account WebSocket
// (lihat handleExtendedOrderEvent dan handleExtendedTradeEvent di atas).
//
// Fungsi ini adalah fallback REST polling untuk trade yang mungkin terlewat oleh WS
// (misalnya koneksi WS putus sementara). Setelah 10 menit pending:
//   - Cek status via GET /api/v1/user/orders?externalId={id}
//   - FILLED → update DB filled
//   - CANCELLED/REJECTED/EXPIRED → update DB cancelled
//   - Tidak ditemukan setelah 30 menit → mark failed

const EXT_TRADE_POLL_INTERVAL_MS = 1 * 60 * 1000;  // 1 menit (dipercepat untuk mainnet)
const EXT_TRADE_CHECK_AFTER_MS   = 2 * 60 * 1000;  // 2 menit → mulai cek ke API (WS fallback cepat)
const EXT_TRADE_TIMEOUT_MS       = 10 * 60 * 1000; // 10 menit (was 30 — EXT-REPLAY-001)

let isExtPollRunning = false;

export async function pollPendingExtendedTrades(): Promise<void> {
  if (isExtPollRunning) {
    logger.warn("[ExtendedBot] pollPendingExtendedTrades skipped — previous cycle still running");
    return;
  }
  isExtPollRunning = true;
  try {
    const pendingTrades = await db.query.tradesTable.findMany({
      where: and(
        eq(tradesTable.status, "pending"),
        eq(tradesTable.exchange, "extended"),
        isNotNull(tradesTable.orderHash),
        ne(tradesTable.orderHash, "")
      ),
    });

    const extPendingTrades = pendingTrades.filter((t: typeof tradesTable.$inferSelect) =>
      t.orderHash?.startsWith("ext_") && !t.orderHash?.startsWith("ext_paper_")
    );

    if (extPendingTrades.length === 0) return;

    logger.info(
      { count: extPendingTrades.length, hashes: extPendingTrades.map((t: typeof tradesTable.$inferSelect) => t.orderHash) },
      "[ExtendedBot] Poll siklus mulai — memeriksa trades pending"
    );

    // Kumpulkan credentials per userId — satu fetch per user, bukan per trade
    const uniqueUserIds = [...new Set<number>(
      extPendingTrades.map((t: typeof tradesTable.$inferSelect) => t.userId).filter((id: number | null): id is number => id !== null)
    )];

    const credsByUserId = new Map<number, ExtendedCredentials | null>();
    await Promise.all(
      uniqueUserIds.map(async (userId) => {
        try {
          const creds = await getExtendedConfig(userId);
          credsByUserId.set(userId, creds.hasCredentials ? creds : null);
        } catch {
          credsByUserId.set(userId, null);
        }
      })
    );

    for (const trade of extPendingTrades) {
      const orderHash = trade.orderHash!;
      // externalId = bagian setelah "ext_"
      const externalId = orderHash.slice("ext_".length);
      const ageMs = Date.now() - new Date(trade.createdAt).getTime();

      if (ageMs < EXT_TRADE_CHECK_AFTER_MS) continue; // Masih baru, biarkan WS yang tangani

      const ageMinutes = Math.floor(ageMs / 60000);
      const creds = trade.userId !== null ? (credsByUserId.get(trade.userId) ?? null) : null;

      if (!creds || !creds.apiKey) {
        // Tidak ada credentials → tidak bisa cek → hanya log warning
        logger.warn(
          { tradeId: trade.id, orderHash, ageMinutes },
          "[ExtendedBot] Trade pending >10 menit tapi credentials tidak tersedia untuk cek status"
        );
        continue;
      }

      // Cek status order ke Extended API via externalId
      logger.info(
        { tradeId: trade.id, externalId, ageMinutes, endpoint: `/api/v1/user/orders/external/${externalId}` },
        "[ExtendedBot] Poll: mengecek status order ke Extended API"
      );
      let order: Awaited<ReturnType<typeof getOrderByExternalId>> = null;
      try {
        order = await getOrderByExternalId(creds.apiKey, externalId, creds.network);
      } catch (fetchErr) {
        logger.warn({ fetchErr, tradeId: trade.id, externalId }, "[ExtendedBot] Gagal fetch status order dari Extended API");
        continue;
      }

      if (order) {
        logger.info(
          { tradeId: trade.id, externalId, status: order.status, side: order.side, qty: order.qty, price: order.price, filledQty: order.filledQty, averagePrice: order.averagePrice, ageMinutes },
          "[ExtendedBot] Poll: Extended API mengembalikan data order ✓"
        );
      }

      if (!order) {
        // Order tidak ditemukan di Extended API
        if (ageMs > EXT_TRADE_TIMEOUT_MS) {
          // Sudah terlalu lama dan tidak ada data — mark failed
          await db.update(tradesTable)
            .set({
              status: "failed",
              errorMessage: `Order Extended tidak ditemukan di exchange setelah ${Math.floor(EXT_TRADE_TIMEOUT_MS / 60000)} menit — akan di-re-place otomatis`,
            })
            .where(eq(tradesTable.id, trade.id));

          await extAddLog(
            trade.userId ?? null,
            trade.strategyId,
            trade.strategyName,
            "error",
            `${trade.side.toUpperCase()} order Extended timeout — akan di-re-place dalam 2 menit`,
            `ExternalId: ${externalId} | Usia: ${ageMinutes} menit — order tidak terdeteksi di exchange`
          );

          logger.warn(
            { tradeId: trade.id, orderHash, ageMinutes },
            "[ExtendedBot] Trade Extended timeout — tidak ada data dari Extended API, mark failed"
          );

          // EXT-REPLAY-001: Queue untuk re-placement. LIMIT orders (price > 0) saja.
          const origPrice = new Decimal(trade.price ?? "0");
          if (trade.strategyId !== null &&
              extendedRunningBots.has(trade.strategyId) &&
              origPrice.gt(0)) {
            const stratCheck = await db.query.strategiesTable.findFirst({
              where: eq(strategiesTable.id, trade.strategyId),
              columns: { type: true, exchange: true },
            });
            if (stratCheck?.type === "grid" && stratCheck?.exchange === "extended") {
              const q = cancelledExtendedReplays.get(trade.strategyId) ?? [];
              q.push({ side: trade.side as "buy" | "sell", originalPrice: origPrice, cancelledAt: new Date(), tradeId: trade.id });
              cancelledExtendedReplays.set(trade.strategyId, q);
              logger.info({ tradeId: trade.id, orderHash, ageMinutes }, "[ExtendedBot] EXT-REPLAY-001: timeout order queued for re-placement");
            }
          }
        } else {
          // Masih dalam batas wajar — bisa jadi order masih diproses
          logger.info(
            { tradeId: trade.id, orderHash, ageMinutes },
            "[ExtendedBot] Trade Extended pending — Extended API belum mengembalikan data, masih menunggu"
          );
        }
        continue;
      }

      // Order ditemukan — proses berdasarkan status
      const status = (order.status ?? "").toUpperCase();

      if (status === "FILLED") {
        // Order terisi PENUH — update DB
        const fillPrice = order.averagePrice && parseFloat(order.averagePrice) > 0
          ? new Decimal(order.averagePrice)
          : new Decimal(order.price);
        const fillQty = order.filledQty && parseFloat(order.filledQty) > 0
          ? new Decimal(order.filledQty)
          : new Decimal(order.qty);

        const stratForModePoll = trade.strategyId
          ? await db.query.strategiesTable.findFirst({
              where: eq(strategiesTable.id, trade.strategyId),
              columns: { gridConfig: true },
            })
          : null;
        const tradeModePoll = (stratForModePoll?.gridConfig as any)?.mode ?? "neutral";
        // BUG-EXT-POLL-IDEMPOTENCY-001: guard idempotency — WS handler bisa fill trade
        // di antara fetch awal poll dan iterasi ini. Tanpa filter status + returning(),
        // extUpdateStrategyStatsAtomic dipanggil dua kali → double-count stats.
        // Mirror pola E-NEW-2 pada WS handlers.
        let pollFilledDidUpdate = false;
        await db.transaction(async (tx) => {
          const updatedPoll = await tx.update(tradesTable)
            .set({ status: "filled", executedAt: new Date() })
            .where(and(eq(tradesTable.id, trade.id), eq(tradesTable.status, "pending")))
            .returning({ id: tradesTable.id });
          if (updatedPoll.length === 0) return; // Already processed by concurrent WS handler

          if (trade.strategyId !== null) {
            await extUpdateStrategyStatsAtomic(
              trade.strategyId,
              trade.side as "buy" | "sell",
              fillQty,
              fillPrice,
              tx,
              tradeModePoll
            );
          }
          pollFilledDidUpdate = true;
        });

        // BUG-EXT-POLL-IDEMPOTENCY-001: budget + skew hanya jika stats benar-benar diupdate
        // (cegah double-count jika WS handler sudah menang race).
        if (pollFilledDidUpdate && trade.strategyId !== null) {
          try {
            const budget = await trackBudgetSpend(trade.strategyId, fillQty, fillPrice, 0);
            if (budget.exceeded) {
              await extAddLog(trade.userId ?? null, trade.strategyId, trade.strategyName, "warn",
                "Budget Cap tercapai — bot dihentikan otomatis",
                `Terpakai: $${budget.newSpentUsd.toFixed(2)} dari $${budget.maxBudgetUsd?.toFixed(2)}`
              );
              await extNotifyUser(trade.userId,
                `🛑 Budget Cap tercapai: $${budget.newSpentUsd.toFixed(2)} dari $${budget.maxBudgetUsd?.toFixed(2)} — bot dihentikan otomatis.`
              );
              stopExtendedBot(trade.strategyId).catch((err) =>
                logger.warn({ err, strategyId: trade.strategyId }, "[ExtendedBot] stopExtendedBot setelah budget cap gagal — non-fatal")
              );
            }
          } catch (budgetErr) {
            logger.warn({ tradeId: trade.id }, "[ExtendedBot] Budget tracking failed — non-critical");
          }
        }

        // EXT-SKEW-MISSING-001: F3 Inventory Skew — update cumulative qty (REST poll FILLED).
        // BUG-EXT-POLL-IDEMPOTENCY-001: gate oleh pollFilledDidUpdate agar tidak double-count
        // jika WS handler sudah fill trade ini lebih dulu (race condition).
        if (pollFilledDidUpdate && trade.strategyId !== null) {
          const skPollFilled = extendedSkewStates.get(trade.strategyId) ?? { cumulativeBuyQty: new Decimal(0), cumulativeSellQty: new Decimal(0) };
          if (trade.side === "buy") skPollFilled.cumulativeBuyQty = skPollFilled.cumulativeBuyQty.add(fillQty);
          else skPollFilled.cumulativeSellQty = skPollFilled.cumulativeSellQty.add(fillQty);
          extendedSkewStates.set(trade.strategyId, skPollFilled);
        }

        await extAddLog(
          trade.userId ?? null,
          trade.strategyId,
          trade.strategyName,
          "success",
          `Order Extended terisi penuh (konfirmasi REST polling)`,
          `ExternalId: ${externalId} | Qty: ${fillQty.toFixed(6)} | Avg: $${fillPrice.toFixed(4)} | Usia: ${ageMinutes} menit`
        );

        logger.info(
          { tradeId: trade.id, orderHash, fillPrice: fillPrice.toFixed(4), fillQty: fillQty.toFixed(6), ageMinutes },
          "[ExtendedBot] REST poll: Extended order FILLED — DB updated"
        );

      } else if (["CANCELLED", "REJECTED", "EXPIRED"].includes(status)) {
        // Mirror WS handler (handleExtendedOrderEvent L396-476):
        // IOC partial fill — filledQty > 0 saat CANCELLED → tandai "filled" dengan qty yang berhasil terisi
        const partialFillQtyPoll = order.filledQty ? parseFloat(order.filledQty) : 0;
        if (partialFillQtyPoll > 0) {
          const fillPrice = order.averagePrice && parseFloat(order.averagePrice) > 0
            ? new Decimal(order.averagePrice)
            : new Decimal(order.price);
          const fillQty = new Decimal(order.filledQty!);

          const stratForModePartialPoll = trade.strategyId
            ? await db.query.strategiesTable.findFirst({
                where: eq(strategiesTable.id, trade.strategyId),
                columns: { gridConfig: true },
              })
            : null;
          const tradeModePartialPoll = (stratForModePartialPoll?.gridConfig as any)?.mode ?? "neutral";

          // BUG-EXT-POLL-IDEMPOTENCY-001: guard idempotency — mirror pola WS handler (E-NEW-2).
          // WS CANCELLED+partial handler bisa racing dengan poll untuk trade yang sama.
          let pollPartialDidUpdate = false;
          await db.transaction(async (tx) => {
            const updatedPartialPoll = await tx.update(tradesTable)
              .set({ status: "filled", executedAt: new Date() })
              .where(and(eq(tradesTable.id, trade.id), eq(tradesTable.status, "pending")))
              .returning({ id: tradesTable.id });
            if (updatedPartialPoll.length === 0) return; // Already processed by concurrent WS handler

            if (trade.strategyId !== null) {
              await extUpdateStrategyStatsAtomic(
                trade.strategyId,
                trade.side as "buy" | "sell",
                fillQty,
                fillPrice,
                tx,
                tradeModePartialPoll
              );
            }
            pollPartialDidUpdate = true;
          });

          // BUG-EXT-POLL-IDEMPOTENCY-001: budget + skew hanya jika stats benar-benar diupdate.
          if (pollPartialDidUpdate && trade.strategyId !== null) {
            try {
              const budget = await trackBudgetSpend(trade.strategyId, fillQty, fillPrice, 0);
              if (budget.exceeded) {
                await extAddLog(trade.userId ?? null, trade.strategyId, trade.strategyName, "warn",
                  "Budget Cap tercapai — bot dihentikan otomatis",
                  `Terpakai: $${budget.newSpentUsd.toFixed(2)} dari $${budget.maxBudgetUsd?.toFixed(2)}`
                );
                await extNotifyUser(trade.userId,
                  `🛑 Budget Cap tercapai: $${budget.newSpentUsd.toFixed(2)} dari $${budget.maxBudgetUsd?.toFixed(2)} — bot dihentikan otomatis.`
                );
                stopExtendedBot(trade.strategyId).catch((err) =>
                  logger.warn({ err, strategyId: trade.strategyId }, "[ExtendedBot] stopExtendedBot setelah budget cap gagal — non-fatal")
                );
              }
            } catch (budgetErr) {
              logger.warn({ tradeId: trade.id }, "[ExtendedBot] Budget tracking failed — non-critical");
            }
          }

          // EXT-SKEW-MISSING-001: F3 Inventory Skew — update cumulative qty (REST poll IOC partial fill).
          // BUG-EXT-POLL-IDEMPOTENCY-001: gate oleh pollPartialDidUpdate agar tidak double-count.
          if (pollPartialDidUpdate && trade.strategyId !== null) {
            const skPollPartial = extendedSkewStates.get(trade.strategyId) ?? { cumulativeBuyQty: new Decimal(0), cumulativeSellQty: new Decimal(0) };
            if (trade.side === "buy") skPollPartial.cumulativeBuyQty = skPollPartial.cumulativeBuyQty.add(fillQty);
            else skPollPartial.cumulativeSellQty = skPollPartial.cumulativeSellQty.add(fillQty);
            extendedSkewStates.set(trade.strategyId, skPollPartial);
          }

          await extAddLog(
            trade.userId ?? null,
            trade.strategyId,
            trade.strategyName,
            "success",
            `Order Extended terisi sebagian & ${status.toLowerCase()} (konfirmasi REST polling)`,
            `ExternalId: ${externalId} | Filled: ${fillQty.toFixed(6)} | Avg: $${fillPrice.toFixed(4)} | Usia: ${ageMinutes} menit`
          );

          try {
            if (trade.userId !== null) {
              const notif = await extGetNotificationConfig(trade.userId);
              const shouldNotify = trade.side === "buy" ? notif.notifyOnBuy : notif.notifyOnSell;
              if (shouldNotify) {
                await extNotifyUser(trade.userId,
                  formatOrderFilled("extended", trade.side, fillQty.toFixed(6),
                    trade.marketSymbol, fillPrice.toFixed(4), order.payedFee));
              }
            }
          } catch (notifErr) {
            logger.warn({ notifErr, tradeId: trade.id }, "[ExtendedBot] REST poll: Notifikasi partial fill gagal dikirim");
          }

          logger.info(
            { tradeId: trade.id, orderHash, fillPrice: fillPrice.toFixed(4), fillQty: fillQty.toFixed(6), status, ageMinutes },
            "[ExtendedBot] REST poll: IOC partial fill finalized on CANCELLED — DB updated"
          );

        } else {
          await db.update(tradesTable)
            .set({
              status: "cancelled",
              errorMessage: `Order ${status.toLowerCase()} oleh Extended Exchange (konfirmasi REST polling)`,
            })
            .where(eq(tradesTable.id, trade.id));

          await extAddLog(
            trade.userId ?? null,
            trade.strategyId,
            trade.strategyName,
            "warn",
            `Order Extended ${status.toLowerCase()} tanpa fill${status !== "REJECTED" ? " — akan di-re-place dalam 2 menit" : ""}`,
            `ExternalId: ${externalId} | Market: ${order.market} | Side: ${order.side} | Usia: ${ageMinutes} menit`
          );

          logger.warn(
            { tradeId: trade.id, orderHash, status, ageMinutes },
            "[ExtendedBot] REST poll: Extended order cancelled/rejected — DB updated"
          );

          // EXT-REPLAY-001: Queue CANCELLED dan EXPIRED untuk re-placement.
          // REJECTED = exchange menolak karena masalah teknis — jangan re-try.
          const origPriceCancel = new Decimal(trade.price ?? "0");
          if ((status === "CANCELLED" || status === "EXPIRED") &&
              trade.strategyId !== null &&
              extendedRunningBots.has(trade.strategyId) &&
              origPriceCancel.gt(0)) {
            const stratCheck = await db.query.strategiesTable.findFirst({
              where: eq(strategiesTable.id, trade.strategyId),
              columns: { type: true, exchange: true },
            });
            if (stratCheck?.type === "grid" && stratCheck?.exchange === "extended") {
              const q = cancelledExtendedReplays.get(trade.strategyId) ?? [];
              q.push({ side: trade.side as "buy" | "sell", originalPrice: origPriceCancel, cancelledAt: new Date(), tradeId: trade.id });
              cancelledExtendedReplays.set(trade.strategyId, q);
              logger.info({ tradeId: trade.id, orderHash, status }, "[ExtendedBot] EXT-REPLAY-001: queued for re-placement");
            }
          }
        }

      } else {
        // NEW, PARTIALLY_FILLED, TRIGGERED, UNTRIGGERED, dll — order masih aktif di order book
        // TIDAK boleh di-timeout atau di-mark error; biarkan terus dipantau hingga FILLED atau CANCELLED
        const partialInfo = status === "PARTIALLY_FILLED" && order.filledQty
          ? ` | filledQty: ${order.filledQty}/${order.qty}`
          : "";
        logger.info(
          { tradeId: trade.id, orderHash, status, ageMinutes, filledQty: order.filledQty, qty: order.qty },
          `[ExtendedBot] REST poll: order masih aktif di order book (${status})${partialInfo} — tidak ada aksi`
        );
      }
    }
  } catch (err) {
    logger.error({ err }, "[ExtendedBot] Error during pending Extended trade monitoring");
  } finally {
    isExtPollRunning = false;
  }
}

// EXT-SYNC-001: Sinkronisasi order book state Extended dengan DB.
// Memakai GET /api/v1/user/orders/open untuk mendapatkan semua order aktif di exchange.
// Order di DB yang berstatus "pending" tapi tidak ada di exchange (ghost) → mark cancelled + queue replay.
// Berbeda dari Lighter yang pakai clientOrderIndex, Extended memakai externalId sebagai identifier unik.
async function syncExtendedOrderBookState(
  userId: number,
  strategy: typeof strategiesTable.$inferSelect,
  network: ExtendedNetwork
): Promise<void> {
  const creds = await getExtendedConfig(userId).catch(() => null);
  if (!creds?.hasCredentials || !creds.apiKey) {
    logger.warn({ strategyId: strategy.id }, "[ExtendedBot] EXT-SYNC-001: credentials tidak tersedia — sync dilewati");
    return;
  }

  // Ambil semua open orders dari exchange untuk market ini
  let openOrders: Awaited<ReturnType<typeof getOpenOrders>>;
  try {
    openOrders = await getOpenOrders(creds.apiKey, strategy.marketSymbol, network);
  } catch (err) {
    // EXT-SYNC-GHOST-POISON-001: Abort sync jika getOpenOrders gagal.
    // Jangan lanjutkan dengan empty list — ghost detection akan salah anggap
    // semua pending orders hilang → false cancel + duplicate re-placement.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), strategyId: strategy.id },
      "[ExtendedBot] EXT-SYNC-GHOST-POISON-001: getOpenOrders gagal — sync dilewati, ghost/orphan detection diskip untuk keamanan"
    );
    return;
  }

  // Build set externalId yang aktif di exchange
  const activeExternalIds = new Set(openOrders.map((o) => o.externalId));

  // ── EXT-SYNC-002: Orphan detection ──────────────────────────────────────────
  // Orphan = aktif di exchange tapi TIDAK ada di DB (state hilang setelah PM2 restart).
  // Query semua pending extended orders milik user ini (lintas strategy, sama market).
  // Kenapa lintas strategy? getOpenOrders sudah filter by marketSymbol — tapi jika
  // ada 2 strategy trade market yang sama, order strategy lain tidak boleh di-cancel.
  const allUserExtPending = await db.query.tradesTable.findMany({
    where: and(
      eq(tradesTable.userId, userId),
      eq(tradesTable.exchange, "extended"),
      eq(tradesTable.status, "pending"),
      isNotNull(tradesTable.orderHash),
      ne(tradesTable.orderHash, "")
    ),
  });

  const dbExternalIds = new Set(
    allUserExtPending
      .filter((t) => t.orderHash?.startsWith("ext_") && !t.orderHash?.startsWith("ext_paper_"))
      .map((t) => t.orderHash!.slice("ext_".length))
  );

  const orphanExternalIds = openOrders
    .map((o) => o.externalId)
    .filter((eid) => eid && !dbExternalIds.has(eid));

  if (orphanExternalIds.length > 0) {
    try {
      await massCancelExtendedOrders({ apiKey: creds.apiKey, externalOrderIds: orphanExternalIds, network });
      logger.info(
        { strategyId: strategy.id, orphanCount: orphanExternalIds.length },
        "[ExtendedBot] EXT-SYNC-002: orphan orders dikirim mass cancel"
      );
      await extAddLog(
        userId,
        strategy.id,
        strategy.name,
        "warn",
        `Order sync: ${orphanExternalIds.length} orphan order di-cancel`,
        `ExternalIds: ${orphanExternalIds.join(", ")}`
      );
    } catch (orphanErr) {
      logger.warn(
        { err: orphanErr instanceof Error ? orphanErr.message : String(orphanErr), strategyId: strategy.id },
        "[ExtendedBot] EXT-SYNC-002: massCancelExtendedOrders orphan gagal"
      );
    }
  }

  // ── EXT-SYNC-001: Ghost detection ───────────────────────────────────────────
  // Ghost = ada di DB sebagai pending tapi TIDAK ada di exchange (sudah expire/dibatalkan).
  // Cari pending trades di DB untuk strategy ini saja.
  const dbPending = await db.query.tradesTable.findMany({
    where: and(
      eq(tradesTable.strategyId, strategy.id),
      eq(tradesTable.status, "pending"),
      isNotNull(tradesTable.orderHash),
      ne(tradesTable.orderHash, "")
    ),
  });

  const livePending = dbPending.filter(
    (t: typeof tradesTable.$inferSelect) =>
      t.orderHash?.startsWith("ext_") && !t.orderHash?.startsWith("ext_paper_")
  );
  if (livePending.length === 0) return;

  const GRACE_PERIOD_MS = 30_000;
  const now = Date.now();

  const ghosts = livePending.filter((trade: typeof tradesTable.$inferSelect) => {
    const externalId = trade.orderHash!.slice("ext_".length);
    if (activeExternalIds.has(externalId)) return false; // masih aktif di exchange
    const ageMs = now - new Date(trade.createdAt).getTime();
    return ageMs > GRACE_PERIOD_MS; // skip order yang baru dikirim
  });

  if (ghosts.length === 0) return;

  for (const ghost of ghosts) {
    await db.update(tradesTable)
      .set({
        status: "cancelled",
        errorMessage: "EXT-SYNC-001: order tidak ditemukan di exchange active orders — kemungkinan sudah expire atau dibatalkan",
      })
      .where(eq(tradesTable.id, ghost.id));

    await extAddLog(
      userId,
      strategy.id,
      strategy.name,
      "warn",
      `Order sync: ghost order di-clear`,
      `ExternalId: ${ghost.orderHash!.slice("ext_".length)} | Side: ${ghost.side} | Price: ${ghost.price}`
    );

    // EXT-SYNC-001 + EXT-REPLAY-001: Queue ghost orders untuk re-placement.
    // Ghost hilang dari exchange tanpa jalur cancel → tidak pernah masuk replay queue via poller.
    if (strategy.type === "grid" && extendedRunningBots.has(strategy.id)) {
      const origPrice = new Decimal(ghost.price ?? "0");
      if (origPrice.gt(0)) {
        const q = cancelledExtendedReplays.get(strategy.id) ?? [];
        q.push({ side: ghost.side as "buy" | "sell", originalPrice: origPrice, cancelledAt: new Date(), tradeId: ghost.id });
        cancelledExtendedReplays.set(strategy.id, q);
      }
    }
  }

  logger.info(
    { strategyId: strategy.id, ghostCount: ghosts.length },
    "[ExtendedBot] EXT-SYNC-001: ghost pending orders di-clear dari DB"
  );
}

// EXT-REPLAY-001: Re-place cancelled/timed-out grid orders setiap 2 menit.
// Berdasarkan data API: ukuran = amountPerGrid / originalPrice.
// Duplicate check via getDuplicateTolerance sebelum re-place.
async function replayExpiredExtendedGridOrders(): Promise<void> {
  if (cancelledExtendedReplays.size === 0) return;

  const snapshot = new Map(cancelledExtendedReplays);
  cancelledExtendedReplays.clear();

  for (const [strategyId, entries] of snapshot) {
    if (!extendedRunningBots.has(strategyId)) continue;

    const strategy = await db.query.strategiesTable.findFirst({
      where: eq(strategiesTable.id, strategyId),
    });
    if (!strategy || !strategy.isRunning || strategy.type !== "grid" || strategy.exchange !== "extended") continue;
    if (!extendedRunningBots.has(strategyId)) continue;

    const config = strategy.gridConfig as any;
    if (!config?.lowerPrice || !config?.upperPrice || !config?.gridLevels) continue;

    const lower = new Decimal(config.lowerPrice);
    const upper = new Decimal(config.upperPrice);
    const gridSpacing = upper.sub(lower).div(config.gridLevels);
    const execMultiplierReplay = getExecModeMultiplier(config.executionMode);

    const userId = strategy.userId ?? null;
    if (userId === null) continue;

    const creds = await getExtendedConfig(userId).catch(() => null);
    if (!creds?.hasCredentials) continue;

    // Ambil harga pasar terkini dari WS cache menggunakan market symbol
    const wsPrice = getExtendedWsCachedPrice(strategy.marketSymbol);
    const currentPrice = wsPrice
      ? new Decimal(wsPrice)
      : null;

    if (!currentPrice || currentPrice.lte(0)) {
      await extAddLog(userId, strategyId, strategy.name, "warn",
        "replayExpiredExtendedGridOrders: tidak bisa fetch harga — skip siklus ini");
      continue;
    }

    // Skip jika harga di luar range grid — auto-rerange akan handle
    if (currentPrice.lt(lower) || currentPrice.gt(upper)) continue;

    for (const entry of entries) {
      if (!extendedRunningBots.has(strategyId)) break;

      const { side, tradeId } = entry;

      // EXT-REPLAY-OFFSET-001 FIX: entry.originalPrice = DB trade.price = executionPrice WITH offset
      // (Extended menyimpan price = execution price, bukan base price seperti Lighter).
      // Duplicate check harus center di entry.originalPrice — itulah yang tersimpan di DB.
      // Placement: reverse offset → basePriceForReplay → extExecuteLiveOrder apply once
      // → execution price akhir = entry.originalPrice (sama dengan order sebelumnya, tanpa drift).
      const orderKindForReplay = config.orderType ?? "limit";
      const isMarketKindReplay = orderKindForReplay === "market";
      const limitOffsetFrac = (config.limitPriceOffset ?? 0) * execMultiplierReplay / 100;
      // Reverse offset dari entry.originalPrice agar extExecuteLiveOrder bisa apply sekali:
      // buy: executionPrice = base × (1 - frac) → base = executionPrice / (1 - frac)
      // sell: executionPrice = base × (1 + frac) → base = executionPrice / (1 + frac)
      const basePriceForReplay = (!isMarketKindReplay && limitOffsetFrac > 0)
        ? (side === "buy"
            ? entry.originalPrice.div(new Decimal(1).sub(new Decimal(limitOffsetFrac)))
            : entry.originalPrice.div(new Decimal(1).add(new Decimal(limitOffsetFrac))))
        : entry.originalPrice;

      if (!isMarketKindReplay) {
        // Center window di entry.originalPrice — bukan double-offset
        const { lower: tolLower, upper: tolUpper } = getDuplicateTolerance(entry.originalPrice.toNumber(), gridSpacing.toNumber());
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
          logger.info({ strategyId, side, originalPrice: entry.originalPrice.toFixed(4) },
            "[ExtendedBot] EXT-REPLAY-001: skip — pending order sudah ada di grid level ini");
          continue;
        }
      }

      if (entry.originalPrice.lte(0)) continue;

      const rawSize = new Decimal(config.amountPerGrid ?? 0).div(entry.originalPrice);
      if (rawSize.lte(0)) continue;

      // E-NEW-3 FIX: round ke stepSize — konsisten dengan normal grid path (line 1496).
      // Tanpa ini, rawSize bisa punya presisi lebih banyak dari stepSize market →
      // exchange reject dengan "Invalid quantity precision" (api-reference.md line 9992).
      const replayMarketInfo = await getExtendedMarketInfo(
        strategy.marketSymbol, undefined, creds.network ?? "mainnet"
      ).catch(() => null);
      const replayStepSize = replayMarketInfo?.stepSize ?? "0.0001";
      const replaySize = roundToStepSize(rawSize, replayStepSize);
      if (replaySize.lte(0)) {
        logger.warn(
          { strategyId, rawSize: rawSize.toFixed(8), replayStepSize },
          "[ExtendedBot] EXT-REPLAY-001: size terlalu kecil setelah rounding — skip"
        );
        continue;
      }

      const mode = config.mode ?? "neutral";
      const reduceOnly = computeReduceOnly(mode, side);

      await extAddLog(userId, strategyId, strategy.name, "info",
        `Re-placing ${side.toUpperCase()} grid order setelah timeout/cancel`,
        `Harga grid asli: $${entry.originalPrice.toFixed(4)} | Harga pasar: $${currentPrice.toFixed(4)} | Size: ${replaySize.toFixed(8)}`);

      await db.update(tradesTable)
        .set({ errorMessage: "Order expired/timeout — re-placed at original grid level price" })
        .where(eq(tradesTable.id, tradeId));

      if (!extendedRunningBots.has(strategyId)) break;

      await extExecuteLiveOrder({
        userId,
        strategy,
        creds,
        side,
        size: replaySize,
        // EXT-REPLAY-OFFSET-001: pakai basePriceForReplay (reverse offset) agar extExecuteLiveOrder
        // menerapkan offset sekali → execution price = entry.originalPrice (tanpa drift per siklus).
        currentPrice: basePriceForReplay,
        orderKind: orderKindForReplay === "post_only" ? "post_only" : (isMarketKindReplay ? "market" : "limit"),
        limitPriceOffset: (config.limitPriceOffset ?? 0) * execMultiplierReplay,
        reduceOnly,
      });
    }
  }
}

export function startExtendedTradePollSchedule(): void {
  setInterval(pollPendingExtendedTrades, EXT_TRADE_POLL_INTERVAL_MS);
  logger.info(
    {
      intervalMs: EXT_TRADE_POLL_INTERVAL_MS,
      checkAfterMs: EXT_TRADE_CHECK_AFTER_MS,
      timeoutMs: EXT_TRADE_TIMEOUT_MS,
    },
    "[ExtendedBot] Trade status polling started — interval=1min, checkAfter=2min, timeout=10min"
  );

  // EXT-REPLAY-001: Re-place cancelled/expired grid orders setiap 2 menit
  setInterval(() => {
    replayExpiredExtendedGridOrders().catch((err) =>
      logger.warn({ err }, "[ExtendedBot] EXT-REPLAY-001: replayExpiredExtendedGridOrders error")
    );
  }, EXT_REPLAY_INTERVAL_MS);
  logger.info({ intervalMs: EXT_REPLAY_INTERVAL_MS }, "[ExtendedBot] Grid order replay schedule started");

  // EXT-SYNC-001: Periodic order book sync setiap 10 menit untuk semua bot running
  setInterval(() => {
    (async () => {
      const runningStrategies = Array.from(extendedRunningBots.keys());
      if (runningStrategies.length === 0) return;

      for (const strategyId of runningStrategies) {
        const strategy = await db.query.strategiesTable.findFirst({
          where: eq(strategiesTable.id, strategyId),
        });
        if (!strategy || !strategy.userId) continue;
        await syncExtendedOrderBookState(strategy.userId, strategy, "mainnet").catch((err) =>
          logger.warn({ err, strategyId }, "[ExtendedBot] EXT-SYNC-001: syncExtendedOrderBookState error")
        );
      }
    })().catch((err) => logger.warn({ err }, "[ExtendedBot] EXT-SYNC-001: periodic sync gagal"));
  }, EXT_ORDER_SYNC_INTERVAL_MS);
  logger.info({ intervalMs: EXT_ORDER_SYNC_INTERVAL_MS }, "[ExtendedBot] Order book sync polling started");
}
