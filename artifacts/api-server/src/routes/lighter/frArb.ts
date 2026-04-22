import { Router } from "express";
import { db } from "@workspace/db";
import { strategiesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { authMiddleware, type AuthRequest } from "../../middlewares/auth";
import {
  startLighterFrArbBot,
  stopLighterFrArbBot,
  isLighterFrArbBotRunning,
  notifyLighterFrArbStopWhileInPosition,
} from "../../lib/lighter/lighterFrArbEngine";
import type { FrArbState } from "@workspace/db";
import { getFundingRates } from "../../lib/lighter/lighterApi";
import { getMarkets } from "../../lib/lighter/marketCache";
import { getBotConfig } from "../configService";
import type { Network } from "../../lib/lighter/lighterApi";

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
        eq(strategiesTable.exchange, "lighter")
      ),
    });
    if (!strategy) return res.status(404).json({ error: "Strategy Lighter tidak ditemukan" });

    if (strategy.type !== "funding_arb") {
      return res.status(400).json({ error: "Strategy ini bukan tipe funding_arb" });
    }

    if (!strategy.frArbConfig) {
      return res.status(400).json({ error: "frArbConfig belum dikonfigurasi" });
    }

    if (isLighterFrArbBotRunning(strategyId)) {
      return res.status(409).json({ error: "Bot FR Arb Lighter sudah running", strategyId, isRunning: true });
    }

    // Start engine — jika throw sync, DB tidak di-set isRunning=true
    startLighterFrArbBot(strategyId);

    await db.update(strategiesTable)
      .set({ isRunning: true, updatedAt: new Date() })
      .where(eq(strategiesTable.id, strategyId));

    res.json({
      strategyId,
      isRunning: true,
      message: "FR Arb bot Lighter berhasil dimulai",
      frArbState: strategy.frArbState ?? null,
      currentFr: null,
    });
  } catch (err) {
    req.log.error({ err, strategyId }, "[FrArb Lighter] Failed to start bot");
    res.status(500).json({ error: "Gagal memulai FR Arb bot Lighter" });
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
        eq(strategiesTable.exchange, "lighter")
      ),
    });
    if (!strategy) return res.status(404).json({ error: "Strategy Lighter tidak ditemukan" });

    const frArbState = strategy.frArbState as FrArbState | null;
    const wasInPosition = frArbState?.isInPosition === true;

    stopLighterFrArbBot(strategyId);

    await db.update(strategiesTable)
      .set({ isRunning: false, updatedAt: new Date() })
      .where(eq(strategiesTable.id, strategyId));

    if (wasInPosition && frArbState && strategy.userId != null) {
      notifyLighterFrArbStopWhileInPosition(strategy.userId, strategy.name, frArbState)
        .catch(() => {});
    }

    res.json({
      strategyId,
      isRunning: false,
      message: "FR Arb bot Lighter berhasil dihentikan",
      frArbState: frArbState ?? null,
      currentFr: null,
      warning: wasInPosition
        ? "⚠️ Bot dihentikan saat posisi aktif. Close posisi manual di exchange diperlukan."
        : undefined,
    });
  } catch (err) {
    req.log.error({ err, strategyId }, "[FrArb Lighter] Failed to stop bot");
    res.status(500).json({ error: "Gagal menghentikan FR Arb bot Lighter" });
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
        eq(strategiesTable.exchange, "lighter")
      ),
    });
    if (!strategy) return res.status(404).json({ error: "Strategy Lighter tidak ditemukan" });

    // Fetch live FR dari /api/v1/funding-rates (exchange="lighter")
    let currentFr: number | null = null;
    try {
      const botCfg = await getBotConfig(req.userId!).catch(() => null);
      const network: Network = (botCfg?.network as Network | null) ?? "mainnet";

      const markets = await getMarkets(network);
      const market = markets.find((m) => m.symbol === strategy.marketSymbol);
      if (market) {
        const resp = await getFundingRates(network);
        const entry = (resp.funding_rates ?? []).find(
          (r) => r.exchange === "lighter" && r.market_id === market.index
        );
        if (entry != null) {
          // Konversi per-8h → per-jam (sama dengan engine)
          currentFr = entry.rate / 8;
        }
      }
    } catch (_) {}

    res.json({
      strategyId,
      isRunning: isLighterFrArbBotRunning(strategyId),
      message: isLighterFrArbBotRunning(strategyId) ? "Bot sedang berjalan" : "Bot tidak aktif",
      frArbState: strategy.frArbState ?? null,
      currentFr,
    });
  } catch (err) {
    req.log.error({ err, strategyId }, "[FrArb Lighter] Failed to get status");
    res.status(500).json({ error: "Gagal mengambil status FR Arb bot Lighter" });
  }
});

export default router;
