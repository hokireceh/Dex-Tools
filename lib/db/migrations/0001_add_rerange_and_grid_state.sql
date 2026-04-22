ALTER TABLE "strategies" ADD COLUMN IF NOT EXISTS "last_rerange_at" timestamp;
--> statement-breakpoint
ALTER TABLE "strategies" ADD COLUMN IF NOT EXISTS "rerange_count_today" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "strategies" ADD COLUMN IF NOT EXISTS "rerange_count_date" text;
--> statement-breakpoint
ALTER TABLE "strategies" ADD COLUMN IF NOT EXISTS "pending_rerange_at" timestamp;
--> statement-breakpoint
ALTER TABLE "strategies" ADD COLUMN IF NOT EXISTS "pending_rerange_params" jsonb;
--> statement-breakpoint
ALTER TABLE "strategies" ADD COLUMN IF NOT EXISTS "consecutive_out_of_range" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "strategies" ADD COLUMN IF NOT EXISTS "grid_last_level" integer;
