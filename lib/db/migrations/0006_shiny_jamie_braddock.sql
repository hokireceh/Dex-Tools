ALTER TABLE "trades" ADD COLUMN "lighter_order_index" bigint;--> statement-breakpoint
CREATE INDEX "trades_exchange_status_idx" ON "trades" USING btree ("exchange","status");--> statement-breakpoint
CREATE INDEX "trades_strategy_id_idx" ON "trades" USING btree ("strategy_id");--> statement-breakpoint
CREATE INDEX "bot_logs_strategy_id_created_at_idx" ON "bot_logs" USING btree ("strategy_id","created_at");