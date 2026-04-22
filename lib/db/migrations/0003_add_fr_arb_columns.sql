ALTER TABLE "strategies" ADD COLUMN IF NOT EXISTS "fr_arb_config" jsonb;
--> statement-breakpoint
ALTER TABLE "strategies" ADD COLUMN IF NOT EXISTS "fr_arb_state" jsonb;
