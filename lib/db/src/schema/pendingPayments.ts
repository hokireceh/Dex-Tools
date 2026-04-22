import { pgTable, text, integer, timestamp, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const pendingPaymentsTable = pgTable("pending_payments", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  donationId: text("donation_id").notNull().unique(),
  chatId: text("chat_id").notNull(),
  telegramId: text("telegram_id").notNull(),
  telegramUsername: text("telegram_username"),
  telegramName: text("telegram_name").notNull(),
  plan: text("plan").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  qrString: text("qr_string").notNull(),
  waitingMsgId: integer("waiting_msg_id"),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  status: text("status").notNull().default("pending"),
  retryCount: integer("retry_count").notNull().default(0),
  lastCheckedAt: timestamp("last_checked_at"),
  lastSaweriaResponse: text("last_saweria_response"),
});

export const insertPendingPaymentSchema = createInsertSchema(pendingPaymentsTable);
export type InsertPendingPayment = z.infer<typeof insertPendingPaymentSchema>;
export type PendingPayment = typeof pendingPaymentsTable.$inferSelect;
