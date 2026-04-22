import { setGlobalDispatcher, ProxyAgent } from "undici";
import app from "./app";
import { logger } from "./lib/logger";
import { getAllRunningExtendedBots, stopExtendedBot } from "./lib/extended/extendedBotEngine";
import { getAllRunningBots, stopBot } from "./lib/lighter/lighterBotEngine";
import { getAllRunningFrArbBots, stopFrArbBot } from "./lib/frArbEngine";
import { destroyExtendedWs } from "./lib/extended/extendedWs";
import { db, runMigrations, strategiesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

const proxyUrl = process.env["HTTPS_PROXY"] || process.env["HTTP_PROXY"] || process.env["https_proxy"] || process.env["http_proxy"];
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
  logger.info({ proxy: proxyUrl.replace(/:[^:@/]*@/, ":***@") }, "HTTP proxy configured for outbound requests");
}

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// ── Auto Migration ─────────────────────────────────────────────────────────────
// Jalankan migrations sebelum server start agar schema DB selalu up-to-date
// secara otomatis setiap kali server di-restart/deploy. Aman dijalankan berulang
// (idempotent) — hanya apply migration yang belum pernah dijalankan.
// CRITICAL: jika migration gagal, server HARUS exit — jangan pernah jalankan
// server dengan schema DB yang tidak sesuai karena query akan error dan bot crash.
// NOTE: pastikan user DB punya privilege CREATE SCHEMA (jalankan setup-drizzle-schema.sql
// sebagai postgres superuser sekali saja sebelum deploy pertama).
logger.info("[Startup] Menjalankan database migrations...");
try {
  await runMigrations();
  logger.info("[Startup] Migrations selesai ✓");
} catch (migErr: any) {
  logger.error({ err: migErr?.message }, "[Startup] FATAL: Migration gagal — server tidak bisa jalan dengan schema DB yang rusak. Periksa koneksi DB dan migration files, lalu restart ulang.");
  // Beri waktu logger flush sebelum exit
  await new Promise(r => setTimeout(r, 500));
  process.exit(1);
}

// ── NeonDB Broadcast Table Init ───────────────────────────────────────────────
// Inisialisasi tabel broadcast_contacts di NeonDB (terpisah dari DB utama).
// Jika NEON_DATABASE_URL tidak diset, lewati tanpa crash.
try {
  const { initNeonBroadcastTable } = await import("./lib/neonBroadcastDb");
  await initNeonBroadcastTable();
} catch (neonErr: any) {
  logger.warn({ err: neonErr?.message }, "[Startup] NeonDB broadcast table init gagal — fitur broadcast NeonDB tidak aktif");
}

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // ── Startup Recovery ──────────────────────────────────────────────────────
  // Recovery dipusatkan di app.ts (setTimeout 3 detik) via restoreRunningBots /
  // restoreRunningExtendedBots / restoreRunningEtherealBots.
  // Loop recovery kedua di sini (delay 5 detik) dihapus untuk menghindari
  // double recovery: kedua path memanggil startBot bersamaan dalam window 2 detik
  // → potensi race condition pada in-memory guard runningBots.has() sebelum set.
  // startBot memang idempotent (line 1002), tapi race window tetap ada saat
  // banyak bot restore bersamaan dan startBot belum selesai set runningBots.
  // ─────────────────────────────────────────────────────────────────────────
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({ signal }, "[Shutdown] Signal received, shutting down gracefully...");

  // 1. Stop accepting new HTTP connections
  server.close((err) => {
    if (err) logger.warn({ err }, "[Shutdown] HTTP server close error");
  });

  try {
    // 2. Stop all Lighter bots
    const lighterBots = getAllRunningBots();
    if (lighterBots.length > 0) {
      logger.info({ count: lighterBots.length }, "[Shutdown] Stopping Lighter bots");
      await Promise.allSettled(lighterBots.map((b) => stopBot(b.strategyId, true)));
    }

    // 3. Stop all Extended bots
    const extendedBots = getAllRunningExtendedBots();
    if (extendedBots.length > 0) {
      logger.info({ count: extendedBots.length }, "[Shutdown] Stopping Extended bots");
      await Promise.allSettled(extendedBots.map((b) => stopExtendedBot(b.strategyId, true)));
    }

    // 4. Stop all FrArb bots (sync — clear interval + set stoppingFrArbBots flag)
    const frArbIds = getAllRunningFrArbBots();
    if (frArbIds.length > 0) {
      logger.info({ count: frArbIds.length }, "[Shutdown] Stopping FrArb bots");
      for (const id of frArbIds) stopFrArbBot(id);
    }

    // 5. Close Extended WebSocket connections
    destroyExtendedWs();
    logger.info("[Shutdown] Extended WS connections closed");

    // 8. Close NeonDB broadcast pool
    try {
      const { closeNeonPool } = await import("./lib/neonBroadcastDb");
      await closeNeonPool();
    } catch (_) {}

    // 8. Close main DB connection
    if (typeof (db as any).$client?.end === "function") {
      await (db as any).$client.end();
      logger.info("[Shutdown] DB connection closed");
    }
  } catch (err) {
    logger.error({ err }, "[Shutdown] Error during graceful shutdown");
  }

  logger.info("[Shutdown] Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));

process.on("uncaughtException", (err) => {
  logger.error({ err }, "[Process] uncaughtException — process akan exit");
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "[Process] unhandledRejection — process akan exit");
  process.exit(1);
});
