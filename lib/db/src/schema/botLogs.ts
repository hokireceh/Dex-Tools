import { pgTable, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { strategiesTable } from "./strategies";

export const botLogsTable = pgTable("bot_logs", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: integer("user_id"),
  strategyId: integer("strategy_id").references(() => strategiesTable.id, { onDelete: "cascade" }),
  strategyName: text("strategy_name"),
  level: text("level").notNull().default("info"),
  message: text("message").notNull(),
  details: text("details"),
  exchange: text("exchange").default("lighter"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  // DB-INDEX-BOTLOGS-001: LogDialog query WHERE strategy_id=$1 ORDER BY created_at DESC LIMIT 100
  // dipanggil tiap render frontend. Tanpa index = full scan ratusan ribu baris (30-hari retention).
  index("bot_logs_strategy_id_created_at_idx").on(table.strategyId, table.createdAt),
]);

export const insertBotLogSchema = createInsertSchema(botLogsTable);
export type InsertBotLog = z.infer<typeof insertBotLogSchema>;
export type BotLog = typeof botLogsTable.$inferSelect;
