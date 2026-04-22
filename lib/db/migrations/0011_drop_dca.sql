-- 0011_drop_dca.sql
-- DCA dihapus dari semua engine (Lighter/Extended/Ethereal). Nado di-skip (tidak ada DCA di Nado).
-- 1. Hapus semua row strategy bertipe 'dca' (cascade akan ikut hapus trades + bot_logs).
-- 2. Drop kolom dca_config dari tabel strategies.
DELETE FROM "strategies" WHERE "type" = 'dca';--> statement-breakpoint
ALTER TABLE "strategies" DROP COLUMN IF EXISTS "dca_config";
