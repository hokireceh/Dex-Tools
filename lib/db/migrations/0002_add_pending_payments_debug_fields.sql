ALTER TABLE "pending_payments" ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'pending';
ALTER TABLE "pending_payments" ADD COLUMN IF NOT EXISTS "retry_count" integer NOT NULL DEFAULT 0;
ALTER TABLE "pending_payments" ADD COLUMN IF NOT EXISTS "last_checked_at" timestamp;
ALTER TABLE "pending_payments" ADD COLUMN IF NOT EXISTS "last_saweria_response" text;
