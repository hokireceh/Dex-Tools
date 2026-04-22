import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import path from "path";
import fs from "fs";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

/**
 * Jalankan semua migration SQL secara idempotent.
 *
 * Semua file migration menggunakan IF NOT EXISTS / ADD COLUMN IF NOT EXISTS,
 * sehingga aman dijalankan berulang kali.
 *
 * Error handling per-statement (Postgres error codes — lihat
 * https://www.postgresql.org/docs/current/errcodes-appendix.html):
 *
 * Benign (allowlist — re-run idempotent, di-skip silent):
 * - 42701 duplicate_column        → kolom sudah ada
 * - 42P07 duplicate_table         → tabel sudah ada
 * - 42710 duplicate_object        → index/constraint sudah ada
 * - 23505 unique_violation        → row sudah ada
 * - 42501 insufficient_privilege  → CREATE IF NOT EXISTS no-op untuk non-owner
 *
 * Fatal (denylist — data-integrity violation, throw → caller exit):
 * - 23503 foreign_key_violation   → FK validate gagal (orphan rows)
 * - 23514 check_violation         → CHECK constraint gagal validate data existing
 * - 23P01 exclusion_violation     → EXCLUDE constraint gagal validate data existing
 *   Class 23 lainnya (kecuali 23505 yang benign) di-treat sama: schema
 *   half-applied = bot crash di runtime + data drift. Throw supaya caller di
 *   `artifacts/api-server/src/index.ts` (try/catch + process.exit(1)) eksekusi.
 *   Lihat DB-NEW-003.
 *
 * Error lain (warning):
 * - Selain dua kategori di atas → log warning, tetap lanjut. Conservative
 *   behavior untuk error tak dikenal supaya server tetap startup; kalau
 *   benar-benar fatal akan ketahuan di runtime saat query gagal.
 *
 * Kenapa tidak pakai drizzle migrate():
 * drizzle migrate() menjalankan CREATE SCHEMA IF NOT EXISTS "public" yang
 * gagal di PostgreSQL 15+ jika user bukan owner schema public.
 */
export async function runMigrations(): Promise<void> {
  const migrationsFolder = path.join(__dirname, "./migrations");

  if (!fs.existsSync(migrationsFolder)) {
    return;
  }

  const migrationFiles = fs
    .readdirSync(migrationsFolder)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (migrationFiles.length === 0) {
    return;
  }

  const client = await pool.connect();
  try {
    for (const filename of migrationFiles) {
      const filePath = path.join(migrationsFolder, filename);
      const sql = fs.readFileSync(filePath, "utf-8");

      const statements = sql
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      for (const statement of statements) {
        try {
          await client.query(statement);
        } catch (err: any) {
          const code: string = err?.code ?? "";

          // Benign re-run errors — schema sudah idempotent, aman lewat.
          const isExpected =
            code === "42701" || // duplicate_column
            code === "42P07" || // duplicate_table
            code === "42710" || // duplicate_object (constraint/index)
            code === "23505" || // unique_violation
            code === "42501";   // insufficient_privilege

          // Data-integrity violations (Postgres Class 23 kecuali 23505) —
          // TIDAK BOLEH silent. Schema half-applied = bot crash di runtime +
          // orphan akumulasi tanpa ketahuan. Throw → caller exit (DB-NEW-003).
          const isFatal =
            code === "23503" || // foreign_key_violation
            code === "23514" || // check_violation
            code === "23P01";   // exclusion_violation

          if (isFatal) {
            throw new Error(
              `[Migration] FATAL data-integrity error di ${filename} (${code}): ${err?.message?.split("\n")[0]}. ` +
                `Migration tidak boleh apply silent — periksa data orphan / constraint conflict, cleanup, lalu retry deploy.`,
            );
          }

          if (!isExpected) {
            console.warn(
              `[Migration] Warning: statement in ${filename} gagal (${code}): ${err?.message?.split("\n")[0]}`,
            );
          }
        }
      }
    }
  } finally {
    client.release();
  }
}

export * from "./schema";
export type { GridConfig, FrArbConfig, FrArbState } from "./schema/strategies";
