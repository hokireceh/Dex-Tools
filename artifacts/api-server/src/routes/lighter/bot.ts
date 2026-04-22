import { Router } from "express";
import { db } from "@workspace/db";
import { botLogsTable, tradesTable, strategiesTable } from "@workspace/db";
import { desc, eq, and, gte, asc } from "drizzle-orm";
import {
  startBot,
  stopBot,
  getNextRunAt,
  getAllRunningBots,
} from "../../lib/lighter/lighterBotEngine";
import { getBotConfig, deleteLighterCredentials } from "../configService";
import {
  getAccountByIndex,
  getDepositHistory,
  getTransferHistory,
  getWithdrawHistory,
} from "../../lib/lighter/lighterApi";
import { initSigner, createAuthToken } from "../../lib/lighter/lighterSigner";
import { authMiddleware, type AuthRequest } from "../../middlewares/auth";

const router = Router();
router.use(authMiddleware);

router.post("/start/:strategyId", async (req: AuthRequest, res) => {
  const strategyId = parseInt(String(req.params.strategyId));
  // ROUTE-NAN-GUARD-001: Guard identik dengan Extended (L34).
  if (isNaN(strategyId)) return res.status(400).json({ error: "strategyId tidak valid" });
  try {
    // LIGHTER-AUTH-001: Verifikasi kepemilikan strategy sebelum start.
    // Tanpa check ini, user mana pun bisa start bot milik user lain (mirror stop route baris ~54).
    const strategy = await db.query.strategiesTable.findFirst({
      where: and(eq(strategiesTable.id, strategyId), eq(strategiesTable.userId, req.userId!)),
    });
    if (!strategy) {
      return res.status(404).json({ error: "Strategy not found" });
    }
    const success = await startBot(strategyId);
    if (success === "starting") {
      return res.status(409).json({ error: "Bot is already starting, please wait" });
    }
    if (!success) {
      return res.status(404).json({ error: "Strategy not found" });
    }
    const nextRunAt = getNextRunAt(strategyId);
    res.json({
      strategyId,
      isRunning: true,
      message: "Bot started successfully",
      nextRunAt: nextRunAt?.toISOString() ?? null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to start bot";
    if (msg.startsWith("BOT_VALIDATION_FAILED:")) {
      return res.status(400).json({ error: msg.replace("BOT_VALIDATION_FAILED: ", "") });
    }
    req.log.error({ err, strategyId }, "Failed to start bot");
    res.status(500).json({ error: "Failed to start bot" });
  }
});

router.post("/stop/:strategyId", async (req: AuthRequest, res) => {
  const strategyId = parseInt(String(req.params.strategyId));
  if (isNaN(strategyId)) return res.status(400).json({ error: "strategyId tidak valid" });
  try {
    const strategy = await db.query.strategiesTable.findFirst({
      where: and(eq(strategiesTable.id, strategyId), eq(strategiesTable.userId, req.userId!)),
    });
    if (!strategy) {
      return res.status(404).json({ error: "Strategy not found" });
    }
    await stopBot(strategyId);
    res.json({
      strategyId,
      isRunning: false,
      message: "Bot stopped successfully",
      nextRunAt: null,
    });
  } catch (err) {
    req.log.error({ err, strategyId }, "Failed to stop bot");
    res.status(500).json({ error: "Failed to stop bot" });
  }
});

router.get("/status", async (req: AuthRequest, res) => {
  try {
    const runningBots = getAllRunningBots();

    // BUG-STATUS-001: Filter by req.userId — previously returned strategyIds from all users.
    const userStrategies = await db.query.strategiesTable.findMany({
      where: eq(strategiesTable.userId, req.userId!),
      columns: { id: true },
    });
    const userStrategyIds = new Set(userStrategies.map((s: { id: number }) => s.id));

    const bots = runningBots
      .filter((b) => userStrategyIds.has(b.strategyId))
      .map((b) => ({
        strategyId: b.strategyId,
        isRunning: true,
        message: "Running",
        nextRunAt: b.nextRunAt.toISOString(),
      }));
    res.json({ bots });
  } catch (err) {
    res.status(500).json({ error: "Failed to get bot status" });
  }
});

router.get("/account", async (req: AuthRequest, res) => {
  try {
    const config = await getBotConfig(req.userId!);

    if (config.accountIndex === null) {
      return res.json({
        isConfigured: false,
        network: config.network ?? "mainnet",
        accountIndex: null,
        l1Address: null,
        totalEquity: 0,
        availableBalance: 0,
        usedMargin: 0,
        positions: [],
      });
    }

    const accountRaw = await getAccountByIndex(config.accountIndex, config.network);

    if (!accountRaw || !accountRaw.accounts || accountRaw.accounts.length === 0) {
      res.setHeader("Cache-Control", "no-store");
      return res.json({
        isConfigured: true,
        network: config.network ?? "mainnet",
        accountIndex: config.accountIndex,
        l1Address: config.l1Address,
        totalEquity: 0,
        availableBalance: 0,
        usedMargin: 0,
        positions: [],
      });
    }

    const account = accountRaw.accounts[0];

    const positionsRaw = account.positions ?? [];

    const positions = positionsRaw
      .map((p) => {
        const size = parseFloat(p.position ?? "0");
        const posVal = parseFloat(p.position_value ?? "0");
        const markPrice = Math.abs(size) > 0 ? Math.abs(posVal) / Math.abs(size) : 0;

        // Lighter returns symbol ("BTC" for perp, "AAVE/USDC" for spot)
        // Convert to display format: "BTC" → "BTC-USDC", "AAVE/USDC" → "AAVE-USDC"
        let marketSymbol = p.symbol ?? "UNKNOWN";
        if (!marketSymbol.includes("-")) {
          marketSymbol = marketSymbol.includes("/")
            ? marketSymbol.replace("/", "-")
            : `${marketSymbol}-USDC`;
        }

        return {
          marketIndex: p.market_id ?? 0,
          marketSymbol,
          side: (p.sign ?? 1) >= 0 ? "long" : "short",
          size,
          entryPrice: parseFloat(p.avg_entry_price ?? "0"),
          markPrice,
          unrealizedPnl: parseFloat(p.unrealized_pnl ?? "0"),
          realizedPnl: parseFloat(p.realized_pnl ?? "0"),
          liquidationPrice: parseFloat(p.liquidation_price ?? "0"),
          allocatedMargin: parseFloat(p.allocated_margin ?? "0"),
        };
      })
      .filter((p) => Math.abs(p.size) > 0);

    const totalEquity = parseFloat(
      account.total_asset_value ?? account.collateral ?? account.available_balance ?? "0"
    );
    const availableBalance = parseFloat(account.available_balance ?? "0");
    // Use total_asset_value (equity incl. unrealized PnL) minus available_balance for accurate used margin
    const usedMargin = Math.max(0, totalEquity - availableBalance);

    res.setHeader("Cache-Control", "no-store");
    res.json({
      isConfigured: true,
      network: config.network ?? "mainnet",
      accountIndex: config.accountIndex,
      l1Address: account.l1_address ?? config.l1Address,
      totalEquity,
      availableBalance,
      usedMargin,
      positions,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get account info");
    res.status(502).json({ error: "Failed to fetch account info" });
  }
});

router.get("/pnl-chart", async (req: AuthRequest, res) => {
  const strategyId = parseInt(String(req.query.strategyId));
  if (!strategyId) return res.status(400).json({ error: "strategyId is required" });

  try {
    const strategy = await db.query.strategiesTable.findFirst({
      where: and(
        eq(strategiesTable.id, strategyId),
        eq(strategiesTable.userId, req.userId!)
      ),
    });
    if (!strategy) return res.status(404).json({ error: "Strategy not found" });

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const trades = await db.query.tradesTable.findMany({
      where: and(
        eq(tradesTable.strategyId, strategyId),
        eq(tradesTable.status, "filled"),
        gte(tradesTable.executedAt, thirtyDaysAgo)
      ),
      orderBy: [asc(tradesTable.executedAt)],
    });

    // AVCO (Average Cost) PnL — benar meski buy & sell terjadi di hari berbeda
    // Mode-aware: SHORT mode menghitung PnL saat BUY menutup posisi sell
    const strategyMode: string = (strategy.gridConfig as any)?.mode ?? "neutral";
    const dailyMap = new Map<string, { buys: number; sells: number; dailyPnl: number }>();
    let runningBuyVolume  = 0;
    let runningBuyValue   = 0;
    let runningSellVolume = 0;
    let runningSellValue  = 0;

    for (const trade of trades) {
      const date = (trade.executedAt ?? trade.createdAt).toISOString().split("T")[0];
      if (!dailyMap.has(date)) {
        dailyMap.set(date, { buys: 0, sells: 0, dailyPnl: 0 });
      }
      const d = dailyMap.get(date)!;
      const size  = parseFloat(trade.size);
      const price = parseFloat(trade.price);

      if (trade.side === "buy") {
        d.buys++;
        if (strategyMode === "short" && runningSellVolume > 0) {
          // BUY menutup posisi SHORT → hitung PnL
          const avgSellPrice = runningSellValue / runningSellVolume;
          d.dailyPnl += size * (avgSellPrice - price);
          const consumed = Math.min(size, runningSellVolume);
          runningSellValue  -= consumed * avgSellPrice;
          runningSellVolume -= consumed;
          if (runningSellVolume < 1e-10) { runningSellVolume = 0; runningSellValue = 0; }
        } else {
          runningBuyVolume += size;
          runningBuyValue  += size * price;
        }
      } else {
        d.sells++;
        if (strategyMode === "short") {
          // SELL membuka posisi SHORT → track sell cost basis
          runningSellVolume += size;
          runningSellValue  += size * price;
        } else if (runningBuyVolume > 0) {
          // SELL menutup posisi LONG/NEUTRAL
          const avgBuyPrice = runningBuyValue / runningBuyVolume;
          d.dailyPnl += size * (price - avgBuyPrice);
          const consumed = Math.min(size, runningBuyVolume);
          runningBuyValue  -= consumed * avgBuyPrice;
          runningBuyVolume -= consumed;
          if (runningBuyVolume < 1e-10) { runningBuyVolume = 0; runningBuyValue = 0; }
        }
      }
    }

    const sortedDates = Array.from(dailyMap.keys()).sort();
    let cumulativePnl = 0;
    const data = sortedDates.map((date) => {
      const d = dailyMap.get(date)!;
      cumulativePnl += d.dailyPnl;
      return {
        date,
        buys: d.buys,
        sells: d.sells,
        estimatedPnl: d.dailyPnl,
        cumulativePnl,
      };
    });

    res.json({ data });
  } catch (err) {
    req.log.error({ err }, "Failed to get PnL chart");
    res.status(500).json({ error: "Failed to get PnL chart" });
  }
});

router.get("/logs", async (req: AuthRequest, res) => {
  const limit = parseInt(String(req.query.limit ?? "100"));
  const strategyId = req.query.strategyId ? parseInt(String(req.query.strategyId)) : null;
  try {
    const logs = await db.query.botLogsTable.findMany({
      where: and(
        eq(botLogsTable.userId, req.userId!),
        eq(botLogsTable.exchange, "lighter"),
        strategyId ? eq(botLogsTable.strategyId, strategyId) : undefined,
      ),
      orderBy: [desc(botLogsTable.createdAt)],
      limit: Math.min(limit, 500),
    });

    res.setHeader("Cache-Control", "no-store");
    res.json({
      logs: logs.map((l: typeof botLogsTable.$inferSelect) => ({
        id: l.id,
        strategyId: l.strategyId ?? null,
        strategyName: l.strategyName ?? null,
        exchange: l.exchange ?? "lighter",
        level: l.level,
        message: l.message,
        details: l.details ?? null,
        createdAt: l.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get bot logs");
    res.status(500).json({ error: "Failed to get logs" });
  }
});

// ─── HISTORY: DEPOSIT / TRANSFER / WITHDRAW (BUG-L-012) ─────────────────────

router.get("/history/deposits", async (req: AuthRequest, res) => {
  try {
    const config = await getBotConfig(req.userId!);
    if (config.accountIndex === null || !config.l1Address) {
      return res.status(400).json({ error: "Konfigurasi Lighter tidak lengkap (accountIndex / l1Address)" });
    }
    if (!config.privateKey || config.apiKeyIndex === null) {
      return res.status(400).json({ error: "Private key atau API key index belum dikonfigurasi — diperlukan untuk generate auth token" });
    }

    initSigner("https://mainnet.zklighter.elliot.ai", config.privateKey, config.apiKeyIndex, config.accountIndex);

    let authorization: string;
    try {
      const tokenResult = createAuthToken(0, config.apiKeyIndex, config.accountIndex);
      if (!tokenResult.token) throw new Error(tokenResult.err ?? "Token null");
      authorization = tokenResult.token;
    } catch (tokenErr) {
      req.log.error({ err: tokenErr }, "[LighterBot] Failed to generate auth token for deposit history");
      return res.status(500).json({ error: "Gagal generate auth token Lighter" });
    }

    const cursor = req.query.cursor ? String(req.query.cursor) : undefined;
    const filter = req.query.filter as "all" | "pending" | "claimable" | undefined;
    const result = await getDepositHistory({
      accountIndex: config.accountIndex,
      l1Address: config.l1Address,
      authorization,
      cursor,
      filter,
      network: "mainnet",
    });
    res.setHeader("Cache-Control", "no-store");
    res.json(result ?? { entries: [], total: 0 });
  } catch (err) {
    req.log.error({ err }, "[LighterBot] Failed to get deposit history");
    res.status(500).json({ error: "Gagal mengambil riwayat deposit" });
  }
});

router.get("/history/transfers", async (req: AuthRequest, res) => {
  try {
    const config = await getBotConfig(req.userId!);
    if (config.accountIndex === null) {
      return res.status(400).json({ error: "Konfigurasi Lighter tidak lengkap (accountIndex)" });
    }
    const cursor = req.query.cursor ? String(req.query.cursor) : undefined;
    const types = req.query.type
      ? (Array.isArray(req.query.type) ? req.query.type : [req.query.type]).map(String)
      : undefined;
    const result = await getTransferHistory({
      accountIndex: config.accountIndex,
      authorization: config.l1Address ?? undefined,
      cursor,
      type: types,
      network: "mainnet",
    });
    res.setHeader("Cache-Control", "no-store");
    res.json(result ?? { entries: [], total: 0 });
  } catch (err) {
    req.log.error({ err }, "[LighterBot] Failed to get transfer history");
    res.status(500).json({ error: "Gagal mengambil riwayat transfer" });
  }
});

router.get("/history/withdrawals", async (req: AuthRequest, res) => {
  try {
    const config = await getBotConfig(req.userId!);
    if (config.accountIndex === null || !config.l1Address) {
      return res.status(400).json({ error: "Konfigurasi Lighter tidak lengkap (accountIndex / l1Address)" });
    }
    if (!config.privateKey || config.apiKeyIndex === null) {
      return res.status(400).json({ error: "Private key atau API key index belum dikonfigurasi — diperlukan untuk generate auth token" });
    }

    initSigner("https://mainnet.zklighter.elliot.ai", config.privateKey, config.apiKeyIndex, config.accountIndex);

    let authorization: string;
    try {
      const tokenResult = createAuthToken(0, config.apiKeyIndex, config.accountIndex);
      if (!tokenResult.token) throw new Error(tokenResult.err ?? "Token null");
      authorization = tokenResult.token;
    } catch (tokenErr) {
      req.log.error({ err: tokenErr }, "[LighterBot] Failed to generate auth token for withdraw history");
      return res.status(500).json({ error: "Gagal generate auth token Lighter" });
    }

    const cursor = req.query.cursor ? String(req.query.cursor) : undefined;
    const filter = req.query.filter as "all" | "pending" | "claimable" | undefined;
    const result = await getWithdrawHistory({
      accountIndex: config.accountIndex,
      authorization,
      cursor,
      filter,
      network: "mainnet",
    });
    res.setHeader("Cache-Control", "no-store");
    res.json(result ?? { entries: [], total: 0 });
  } catch (err) {
    req.log.error({ err }, "[LighterBot] Failed to get withdraw history");
    res.status(500).json({ error: "Gagal mengambil riwayat penarikan" });
  }
});

// ─── DELETE CREDENTIALS ───────────────────────────────────────────────────────

router.delete("/credentials", async (req: AuthRequest, res) => {
  try {
    await deleteLighterCredentials(req.userId!);
    res.json({ ok: true, message: "Credentials Lighter berhasil dihapus" });
  } catch (err) {
    req.log.error({ err }, "[LighterBot] Failed to delete credentials");
    res.status(500).json({ error: "Gagal menghapus credentials Lighter" });
  }
});

export default router;
