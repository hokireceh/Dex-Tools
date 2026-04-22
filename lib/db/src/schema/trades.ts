import { pgTable, text, integer, bigint, timestamp, numeric, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { strategiesTable } from "./strategies";

export const tradesTable = pgTable("trades", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: integer("user_id"),
  strategyId: integer("strategy_id")
    .notNull()
    .references(() => strategiesTable.id, { onDelete: "cascade" }),
  strategyName: text("strategy_name").notNull(),
  marketIndex: integer("market_index").notNull(),
  marketSymbol: text("market_symbol").notNull(),
  side: text("side").notNull(),
  size: numeric("size", { precision: 20, scale: 8 }).default("0").notNull(),
  price: numeric("price", { precision: 20, scale: 8 }).default("0").notNull(),
  fee: numeric("fee", { precision: 20, scale: 8 }).default("0").notNull(),
  status: text("status").notNull().default("pending"),
  orderHash: text("order_hash"),
  clientOrderIndex: bigint("client_order_index", { mode: "number" }),
  lighterOrderIndex: bigint("lighter_order_index", { mode: "number" }), // L-005: exchange-assigned order_index untuk cancel Go FFI
  orderKind: text("order_kind"), // "market" | "limit" | "post_only" — untuk fee rate tracking (LIG-TAKER-FEE-001)
  exchange: text("exchange").default("lighter").notNull(),
  errorMessage: text("error_message"),
  executedAt: timestamp("executed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  // DB-INDEX-TRADES-001: Poll scheduler query WHERE exchange='...' AND status='pending'
  // dipanggil 45x/menit (3 engine × tiap 15 detik). Tanpa index = full table scan.
  index("trades_exchange_status_idx").on(table.exchange, table.status),
  // Log dialog dan stats query WHERE strategy_id = $1
  index("trades_strategy_id_idx").on(table.strategyId),
]);

export const insertTradeSchema = createInsertSchema(tradesTable);
export type InsertTrade = z.infer<typeof insertTradeSchema>;
export type Trade = typeof tradesTable.$inferSelect;
