-- L-005 FIX: Tambah kolom lighter_order_index untuk menyimpan exchange-assigned order_index.
-- Digunakan oleh signCancelOrder (Go FFI) sebagai cOrderIndex — lebih akurat dari client_order_index.
-- Column nullable: data lama tidak punya nilai ini, fallback ke clientOrderIndex tetap berlaku.
ALTER TABLE "trades" ADD COLUMN IF NOT EXISTS "lighter_order_index" bigint;
