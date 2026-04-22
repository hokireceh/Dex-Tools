import { pgTable, text, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const botConfigTable = pgTable("bot_config", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: integer("user_id"),
  key: text("key").notNull(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("bot_config_user_key_idx").on(table.userId, table.key),
]);

export const insertBotConfigSchema = createInsertSchema(botConfigTable);
export type InsertBotConfig = z.infer<typeof insertBotConfigSchema>;
export type BotConfigRow = typeof botConfigTable.$inferSelect;
