ALTER TABLE "strategies" ADD COLUMN IF NOT EXISTS "budget_spent_usd" numeric(20, 8) DEFAULT '0' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bot_config_user_key_idx" ON "bot_config" USING btree ("user_id","key");
