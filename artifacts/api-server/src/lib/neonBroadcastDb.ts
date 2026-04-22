import pg from "pg";
import { logger } from "./logger";

const { Pool } = pg;

let neonPool: pg.Pool | null = null;

function getNeonPool(): pg.Pool {
  if (!neonPool) {
    const url = process.env.NEON_DATABASE_URL;
    if (!url) throw new Error("NEON_DATABASE_URL tidak diset");
    neonPool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 5 });
  }
  return neonPool;
}

export async function initNeonBroadcastTable(): Promise<void> {
  const pool = getNeonPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS broadcast_contacts (
      id          SERIAL PRIMARY KEY,
      chat_id     TEXT NOT NULL UNIQUE,
      added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_ok_at  TIMESTAMPTZ,
      is_active   BOOLEAN NOT NULL DEFAULT TRUE
    )
  `);
  logger.info("[NeonBroadcast] Tabel broadcast_contacts siap");
}

export async function upsertBroadcastContact(chatId: string): Promise<void> {
  const pool = getNeonPool();
  await pool.query(
    `INSERT INTO broadcast_contacts (chat_id, last_ok_at, is_active)
     VALUES ($1, NOW(), TRUE)
     ON CONFLICT (chat_id) DO UPDATE
       SET last_ok_at = NOW(), is_active = TRUE`,
    [chatId]
  );
}

export async function getActiveBroadcastContacts(): Promise<string[]> {
  const pool = getNeonPool();
  const res = await pool.query<{ chat_id: string }>(
    `SELECT chat_id FROM broadcast_contacts WHERE is_active = TRUE ORDER BY added_at`
  );
  return res.rows.map(r => r.chat_id);
}

export async function removeBroadcastContact(chatId: string): Promise<void> {
  const pool = getNeonPool();
  await pool.query(
    `DELETE FROM broadcast_contacts WHERE chat_id = $1`,
    [chatId]
  );
  logger.info({ chatId }, "[NeonBroadcast] Contact dihapus (gagal kirim)");
}

export async function getBroadcastContactCount(): Promise<number> {
  const pool = getNeonPool();
  const res = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM broadcast_contacts WHERE is_active = TRUE`
  );
  return parseInt(res.rows[0]?.count ?? "0", 10);
}

export async function closeNeonPool(): Promise<void> {
  if (neonPool) {
    await neonPool.end();
    neonPool = null;
    logger.info("[NeonBroadcast] Pool ditutup");
  }
}
