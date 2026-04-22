import { pgTable, text, integer, boolean, timestamp, jsonb, numeric, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export type GridConfig = {
  amountPerGrid: number;
  upperPrice: number;
  lowerPrice: number;
  gridLevels: number;
  mode?: "neutral" | "long" | "short";
  stopLoss?: number | null;
  takeProfit?: number | null;
  orderType?: "market" | "limit" | "post_only";
  limitPriceOffset?: number;
  executionMode?: "aggressive" | "normal" | "passive" | null;
  maxBudgetUsd?: number | null;
  // F3: Inventory Skew Management
  inventorySkewEnabled?: boolean;
  inventorySkewThreshold?: number;
  inventorySkewMaxMult?: number;
  inventorySkewPauseAt?: number | null;
  // F4: Follow-Market Grid
  followMarket?: boolean;
  followMarketTriggerPct?: number;
  followMarketMinIntervalMin?: number;
};

export type FrArbConfig = {
  positionSize: number;
  entryFrThreshold: number;
  exitFrThreshold: number;
  maxHoldHours: number;
  side: "auto" | "long" | "short";
  orderType: "market" | "limit" | "post_only";
  limitPriceOffset?: number;
  stopLoss?: number | null;
};

export type FrArbState = {
  isInPosition: boolean;
  positionSide: "long" | "short" | null;
  entryPrice: number | null;
  entryFr: number | null;
  entryAt: string | null;
  openOrderId: string | null;
  openQty: string | null;
  closeOrderId: string | null;
  frAccumulated: number | null;
  lastCheckedAt: string | null;
  closeAttemptedAt: string | null;
  // BUG-NADO-013: pending entry — set saat order dikirim, cleared saat WS confirm fill/cancel
  pendingEntryDigest: string | null;
  pendingEntrySide: "buy" | "sell" | null;
  // BUG-NADO-014: pending close — set saat close order dikirim, cleared saat WS confirm fill/cancel
  pendingCloseDigest: string | null;
};

export const strategiesTable = pgTable("strategies", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: integer("user_id"),
  name: text("name").notNull(),
  type: text("type").notNull(),
  marketIndex: integer("market_index").notNull(),
  marketSymbol: text("market_symbol").notNull(),
  isActive: boolean("is_active").default(false).notNull(),
  isRunning: boolean("is_running").default(false).notNull(),
  gridConfig: jsonb("grid_config").$type<GridConfig>(),
  frArbConfig: jsonb("fr_arb_config").$type<FrArbConfig>(),
  frArbState: jsonb("fr_arb_state").$type<FrArbState>(),
  totalOrders: integer("total_orders").default(0).notNull(),
  successfulOrders: integer("successful_orders").default(0).notNull(),
  totalBought: numeric("total_bought", { precision: 20, scale: 8 }).default("0").notNull(),
  totalSold: numeric("total_sold", { precision: 20, scale: 8 }).default("0").notNull(),
  avgBuyPrice: numeric("avg_buy_price", { precision: 20, scale: 8 }).default("0").notNull(),
  avgSellPrice: numeric("avg_sell_price", { precision: 20, scale: 8 }).default("0").notNull(),
  realizedPnl: numeric("realized_pnl", { precision: 20, scale: 8 }).default("0").notNull(),
  exchange: text("exchange").default("lighter").notNull(),
  nextRunAt: timestamp("next_run_at"),
  lastRunAt: timestamp("last_run_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),

  // ── Auto-Rerange state (persisted to DB so restarts don't lose state) ────────
  // lastRerangeAt: kapan terakhir kali rerange sukses di-approve. Untuk cooldown 2 jam.
  lastRerangeAt: timestamp("last_rerange_at"),
  // rerangeCountToday: jumlah rerange yang sudah di-approve hari ini (maks 3).
  rerangeCountToday: integer("rerange_count_today").default(0).notNull(),
  // rerangeCountDate: tanggal hitungan rerangeCountToday (YYYY-MM-DD). Reset jika beda hari.
  rerangeCountDate: text("rerange_count_date"),
  // pendingRerangeAt: timestamp saat pesan konfirmasi dikirim ke user.
  // Jika ada nilainya = bot sedang menunggu konfirmasi user (short-circuit aktif).
  pendingRerangeAt: timestamp("pending_rerange_at"),
  // pendingRerangeParams: parameter grid baru dari AI, disimpan sampai user approve/reject.
  pendingRerangeParams: jsonb("pending_rerange_params"),
  // consecutiveOutOfRange: counter tick berturut-turut harga di luar range.
  // Trigger auto-rerange setelah nilai ini mencapai 5.
  // Di-reset ke 0 saat harga masuk range ATAU bot di-stop/pause.
  consecutiveOutOfRange: integer("consecutive_out_of_range").default(0).notNull(),

  // ── Grid state persistence (BUG-L-005) ───────────────────────────────────────
  // gridLastLevel: level grid terakhir yang diketahui bot.
  // Dipersist ke DB agar saat server restart, bot tidak kehilangan state dan tidak
  // melewatkan satu trade pada tick pertama pasca restart.
  // null = belum pernah diinisialisasi (state awal / baru dibuat).
  gridLastLevel: integer("grid_last_level"),

  // ── F2: Budget Cap ────────────────────────────────────────────────────────────
  // budgetSpentUsd: akumulasi fee yang sudah dikeluarkan bot sejak start (per-strategy).
  // Di-persist ke DB agar server restart tidak mereset counter.
  // Bot berhenti otomatis jika budgetSpentUsd >= gridConfig.maxBudgetUsd.
  budgetSpentUsd: numeric("budget_spent_usd", { precision: 20, scale: 8 }).default("0").notNull(),
}, (table) => ({
  // dipanggil tiap restoreRunningBots saat server restart (1x per engine).
  // WHERE is_running = true AND exchange = 'lighter'/'extended'
  isRunningExchangeIdx: index("strategies_is_running_exchange_idx").on(table.isRunning, table.exchange),
}));

export const insertStrategySchema = createInsertSchema(strategiesTable);
export type InsertStrategy = z.infer<typeof insertStrategySchema>;
export type Strategy = typeof strategiesTable.$inferSelect;
