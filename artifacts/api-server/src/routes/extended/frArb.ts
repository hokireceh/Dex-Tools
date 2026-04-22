import { Router } from "express";
import { db } from "@workspace/db";
import { strategiesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { authMiddleware, type AuthRequest } from "../../middlewares/auth";
import {
  startFrArbBot,
  stopFrArbBot,
  isFrArbBotRunning,
  notifyFrArbStopWhileInPosition,
} from "../../lib/frArbEngine";
import type { FrArbState } from "@workspace/db";
import { getMarketStats } from "../../lib/extended/extendedApi";
import type { ExtendedNetwork } from "../../lib/extended/extendedApi";
import { getExtendedCredentials } from "../configService";

const router = Router();
router.use(authMiddleware);

// ─── START FR ARB BOT ─────────────────────────────────────────────────────────

router.post("/:strategyId/start", async (req: AuthRequest, res) => {
  const strategyId = parseInt(String(req.params.strategyId));
  if (isNaN(strategyId)) return res.status(400).json({ error: "strategyId tidak valid" });

  try {
    const strategy = await db.query.strategiesTable.findFirst({
      where: and(
        eq(strategiesTable.id, strategyId),
        eq(strategiesTable.userId, req.userId!),
        eq(strategiesTable.exchange, "extended")
      ),
    });
    if (!strategy) return res.status(404).json({ error: "Strategy Extended tidak ditemukan" });

    if (strategy.type !== "funding_arb") {
      return res.status(400).json({ error: "Strategy ini bukan tipe funding_arb" });
    }

    if (!strategy.frArbConfig) {
      return res.status(400).json({ error: "frArbConfig belum dikonfigurasi" });
    }

    if (isFrArbBotRunning(strategyId)) {
      return res.status(409).json({ error: "Bot FR Arb sudah running", strategyId, isRunning: true });
    }

    // Start engine dulu — jika gagal (throw sync), DB tidak di-set isRunning=true
    startFrArbBot(strategyId);

    // Update isRunning di DB setelah engine berhasil dimulai
    await db.update(strategiesTable)
      .set({ isRunning: true, updatedAt: new Date() })
      .where(eq(strategiesTable.id, strategyId));

    res.json({
      strategyId,
      isRunning: true,
      message: "FR Arb bot Extended berhasil dimulai",
      frArbState: strategy.frArbState ?? null,
      currentFr: null,
    });
  } catch (err) {
    req.log.error({ err, strategyId }, "[FrArb Extended] Failed to start bot");
    res.status(500).json({ error: "Gagal memulai FR Arb bot Extended" });
  }
});

// ─── STOP FR ARB BOT ──────────────────────────────────────────────────────────

router.delete("/:strategyId/stop", async (req: AuthRequest, res) => {
  const strategyId = parseInt(String(req.params.strategyId));
  if (isNaN(strategyId)) return res.status(400).json({ error: "strategyId tidak valid" });

  try {
    const strategy = await db.query.strategiesTable.findFirst({
      where: and(
        eq(strategiesTable.id, strategyId),
        eq(strategiesTable.userId, req.userId!),
        eq(strategiesTable.exchange, "extended")
      ),
    });
    if (!strategy) return res.status(404).json({ error: "Strategy Extended tidak ditemukan" });

    const frArbState = strategy.frArbState as FrArbState | null;
    const wasInPosition = frArbState?.isInPosition === true;

    stopFrArbBot(strategyId);

    await db.update(strategiesTable)
      .set({ isRunning: false, updatedAt: new Date() })
      .where(eq(strategiesTable.id, strategyId));

    if (wasInPosition && frArbState && strategy.userId != null) {
      notifyFrArbStopWhileInPosition(strategy.userId, strategy.name, "extended", frArbState)
        .catch(() => {});
    }

    res.json({
      strategyId,
      isRunning: false,
      message: "FR Arb bot Extended berhasil dihentikan",
      frArbState: frArbState ?? null,
      currentFr: null,
      warning: wasInPosition
        ? "⚠️ Bot dihentikan saat posisi aktif. Close posisi manual di exchange diperlukan."
        : undefined,
    });
  } catch (err) {
    req.log.error({ err, strategyId }, "[FrArb Extended] Failed to stop bot");
    res.status(500).json({ error: "Gagal menghentikan FR Arb bot Extended" });
  }
});

// ─── STATUS FR ARB BOT ────────────────────────────────────────────────────────

router.get("/:strategyId/status", async (req: AuthRequest, res) => {
  const strategyId = parseInt(String(req.params.strategyId));
  if (isNaN(strategyId)) return res.status(400).json({ error: "strategyId tidak valid" });

  try {
    const strategy = await db.query.strategiesTable.findFirst({
      where: and(
        eq(strategiesTable.id, strategyId),
        eq(strategiesTable.userId, req.userId!),
        eq(strategiesTable.exchange, "extended")
      ),
    });
    if (!strategy) return res.status(404).json({ error: "Strategy Extended tidak ditemukan" });

    // Fetch live FR
    let currentFr: number | null = null;
    try {
      const creds = await getExtendedCredentials(req.userId!).catch(() => null);
      const network = (creds?.extendedNetwork ?? "mainnet") as ExtendedNetwork;
      const stats = await getMarketStats(strategy.marketSymbol, network);
      if (stats?.fundingRate) {
        const fr = parseFloat(stats.fundingRate);
        if (!isNaN(fr)) currentFr = fr;
      }
    } catch (_) {}

    res.json({
      strategyId,
      isRunning: isFrArbBotRunning(strategyId),
      message: isFrArbBotRunning(strategyId) ? "Bot sedang berjalan" : "Bot tidak aktif",
      frArbState: strategy.frArbState ?? null,
      currentFr,
    });
  } catch (err) {
    req.log.error({ err, strategyId }, "[FrArb Extended] Failed to get status");
    res.status(500).json({ error: "Gagal mengambil status FR Arb bot Extended" });
  }
});

export default router;
