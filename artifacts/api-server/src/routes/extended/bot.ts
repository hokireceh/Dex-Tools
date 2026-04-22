import { Router } from "express";
import { db } from "@workspace/db";
import { botLogsTable, tradesTable, strategiesTable } from "@workspace/db";
import { desc, eq, and, gte, asc, or, isNull } from "drizzle-orm";
import {
  startExtendedBot,
  stopExtendedBot,
  isExtendedBotRunning,
  getExtendedBotNextRunAt,
  getAllRunningExtendedBots,
} from "../../lib/extended/extendedBotEngine";
import { authMiddleware, type AuthRequest } from "../../middlewares/auth";
import { getExtendedCredentials, updateExtendedCredentials, deleteExtendedCredentials } from "../configService";
import { getExtendedMarkets } from "../../lib/extended/extendedMarkets";
import {
  getBalance,
  getPositions,
  getAccountDetails,
  getExtendedUserTrades,
  getExtendedFundingHistory,
  getExtendedPositionsHistory,
  type ExtendedNetwork,
} from "../../lib/extended/extendedApi";
import { derivePublicKey } from "../../lib/extended/extendedSigner";
import { placeExtendedOrder } from "../../lib/extended/extendedApi";

const router = Router();
router.use(authMiddleware);

// ─── START BOT ────────────────────────────────────────────────────────────────

router.post("/start/:strategyId", async (req: AuthRequest, res) => {
  const strategyId = parseInt(String(req.params.strategyId));
  if (isNaN(strategyId)) {
    return res.status(400).json({ error: "strategyId tidak valid" });
  }

  try {
    const strategy = await db.query.strategiesTable.findFirst({
      where: and(
        eq(strategiesTable.id, strategyId),
        eq(strategiesTable.userId, req.userId!),
        eq(strategiesTable.exchange, "extended")
      ),
    });

    if (!strategy) {
      return res.status(404).json({ error: "Strategy Extended tidak ditemukan" });
    }

    const success = await startExtendedBot(strategyId);
    if (!success) {
      return res.status(500).json({ error: "Gagal memulai bot Extended" });
    }

    const nextRunAt = getExtendedBotNextRunAt(strategyId);
    res.json({
      strategyId,
      isRunning: true,
      message: "Bot Extended berhasil dimulai",
      nextRunAt: nextRunAt?.toISOString() ?? null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Gagal memulai bot Extended";
    if (msg.startsWith("EXTENDED_BOT_VALIDATION_FAILED:")) {
      return res.status(400).json({ error: msg.replace("EXTENDED_BOT_VALIDATION_FAILED: ", "") });
    }
    req.log.error({ err, strategyId }, "[ExtendedBot] Failed to start bot");
    res.status(500).json({ error: "Gagal memulai bot Extended" });
  }
});

// ─── STOP BOT ─────────────────────────────────────────────────────────────────

router.post("/stop/:strategyId", async (req: AuthRequest, res) => {
  const strategyId = parseInt(String(req.params.strategyId));
  if (isNaN(strategyId)) {
    return res.status(400).json({ error: "strategyId tidak valid" });
  }

  try {
    const strategy = await db.query.strategiesTable.findFirst({
      where: and(
        eq(strategiesTable.id, strategyId),
        eq(strategiesTable.userId, req.userId!),
        eq(strategiesTable.exchange, "extended")
      ),
    });

    if (!strategy) {
      return res.status(404).json({ error: "Strategy Extended tidak ditemukan" });
    }

    await stopExtendedBot(strategyId);
    res.json({
      strategyId,
      isRunning: false,
      message: "Bot Extended berhasil dihentikan",
      nextRunAt: null,
    });
  } catch (err) {
    req.log.error({ err, strategyId }, "[ExtendedBot] Failed to stop bot");
    res.status(500).json({ error: "Gagal menghentikan bot Extended" });
  }
});

// ─── DAFTAR MARKET EXTENDED (DINAMIS, DARI API EXTENDED) ─────────────────────
// Menggunakan network dari konfigurasi user (selalu mainnet).
// Statis → harus sebelum wildcard /:strategyId

router.get("/markets", async (req: AuthRequest, res) => {
  try {
    const creds = await getExtendedCredentials(req.userId!).catch(() => null);
    const network = (creds?.extendedNetwork ?? "mainnet") as ExtendedNetwork;

    const markets = await getExtendedMarkets(creds?.apiKey ?? undefined, network);

    const result = markets
      .filter(m => m.isActive)
      .map(m => ({
        symbol: m.market,
        baseAsset: m.baseAsset,
        quoteAsset: m.quoteAsset,
        lastPrice: m.lastPrice,
        markPrice: m.markPrice,
        tickSize: parseFloat(m.tickSize),
        stepSize: parseFloat(m.stepSize),
        minBaseAmount: parseFloat(m.minOrderSize),
        minOrderValue: parseFloat(m.minOrderValue),
      }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol));

    res.setHeader("Cache-Control", "public, max-age=60");
    res.json({ markets: result, network });
  } catch (err) {
    req.log.error({ err }, "[ExtendedBot] Failed to fetch markets");
    res.status(500).json({ error: "Gagal mengambil daftar market Extended" });
  }
});

// ─── ACCOUNT INFO EXTENDED (BALANCE + POSITIONS) ──────────────────────────────
// Membutuhkan API key user yang valid. Endpoint ini mengembalikan null jika
// credentials belum dikonfigurasi, bukan error — agar Dashboard bisa tampil gracefully.

router.get("/account", async (req: AuthRequest, res) => {
  try {
    const creds = await getExtendedCredentials(req.userId!).catch(() => null);
    if (!creds?.apiKey) {
      return res.json({ configured: false, balance: null, positions: [] });
    }

    const network = (creds.extendedNetwork ?? "mainnet") as ExtendedNetwork;
    const [balance, positions] = await Promise.allSettled([
      getBalance(creds.apiKey, network),
      getPositions(creds.apiKey, network),
    ]);

    const balanceData = balance.status === "fulfilled" ? balance.value : null;
    const positionsData = positions.status === "fulfilled" ? positions.value : [];

    res.setHeader("Cache-Control", "no-store");
    res.json({
      configured: true,
      network,
      balance: balanceData
        ? {
            equity: parseFloat(balanceData.equity),
            availableForTrade: parseFloat(balanceData.availableForTrade),
            unrealisedPnl: parseFloat(balanceData.unrealisedPnl),
            marginRatio: parseFloat(balanceData.marginRatio),
            collateralName: balanceData.collateralName,
          }
        : null,
      positions: positionsData.map(p => ({
        id: p.id,
        market: p.market,
        side: p.side,
        size: p.size,
        openPrice: parseFloat(p.openPrice),
        markPrice: parseFloat(p.markPrice),
        unrealisedPnl: parseFloat(p.unrealisedPnl),
        realisedPnl: parseFloat(p.realisedPnl),
        leverage: p.leverage,
        liquidationPrice: parseFloat(p.liquidationPrice),
      })),
    });
  } catch (err) {
    req.log.error({ err }, "[ExtendedBot] Failed to fetch account info");
    res.status(500).json({ error: "Gagal mengambil data akun Extended" });
  }
});

// ─── STATUS SEMUA BOT EXTENDED YANG RUNNING ───────────────────────────────────
// CATATAN: endpoint statis (/status, /logs/recent, /pnl-chart/data) harus
// didaftarkan SEBELUM wildcard (/:strategyId) agar Express tidak salah routing.

router.get("/status", async (req: AuthRequest, res) => {
  try {
    const runningBots = getAllRunningExtendedBots();

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
        nextRunAt: b.nextRunAt.toISOString(),
      }));
    res.json({ bots });
  } catch (err) {
    res.status(500).json({ error: "Gagal mendapatkan status bot Extended" });
  }
});

// ─── LOGS BOT EXTENDED ────────────────────────────────────────────────────────
// Statis → harus sebelum /:strategyId

router.get("/logs/recent", async (req: AuthRequest, res) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? "100")), 500);
  const strategyId = req.query.strategyId
    ? parseInt(String(req.query.strategyId))
    : null;

  try {
    const whereClause = strategyId
      ? and(eq(botLogsTable.userId, req.userId!), eq(botLogsTable.strategyId, strategyId), eq(botLogsTable.exchange, "extended"))
      : and(eq(botLogsTable.userId, req.userId!), eq(botLogsTable.exchange, "extended"));

    const logs = await db.query.botLogsTable.findMany({
      where: whereClause,
      orderBy: [desc(botLogsTable.createdAt)],
      limit,
    });

    res.setHeader("Cache-Control", "no-store");
    res.json({
      logs: logs.map((l: typeof botLogsTable.$inferSelect) => ({
        id: l.id,
        strategyId: l.strategyId ?? null,
        strategyName: l.strategyName ?? null,
        level: l.level,
        message: l.message,
        details: l.details ?? null,
        createdAt: l.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    req.log.error({ err }, "[ExtendedBot] Failed to get bot logs");
    res.status(500).json({ error: "Gagal mengambil log bot Extended" });
  }
});

// ─── PNL CHART STRATEGY EXTENDED ─────────────────────────────────────────────
// Statis → harus sebelum /:strategyId

router.get("/pnl-chart/data", async (req: AuthRequest, res) => {
  const strategyId = parseInt(String(req.query.strategyId));
  if (isNaN(strategyId)) {
    return res.status(400).json({ error: "strategyId diperlukan" });
  }

  try {
    const strategy = await db.query.strategiesTable.findFirst({
      where: and(
        eq(strategiesTable.id, strategyId),
        eq(strategiesTable.userId, req.userId!),
        eq(strategiesTable.exchange, "extended")
      ),
    });

    if (!strategy) {
      return res.status(404).json({ error: "Strategy Extended tidak ditemukan" });
    }

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

    // AVCO (Average Cost) PnL — akurat meski buy dan sell di hari berbeda
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
      const size = parseFloat(trade.size);
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
    req.log.error({ err }, "[ExtendedBot] Failed to get PnL chart");
    res.status(500).json({ error: "Gagal mengambil data PnL chart Extended" });
  }
});

// ─── CREATE STRATEGY EXTENDED ─────────────────────────────────────────────────
// Statis → harus sebelum /:strategyId

router.post("/", async (req: AuthRequest, res) => {
  const { name, type, marketSymbol, gridConfig } = req.body ?? {};

  if (!name || typeof name !== "string" || name.trim().length < 3) {
    return res.status(400).json({ error: "Nama minimal 3 karakter" });
  }
  if (type !== "grid" && type !== "funding_arb") {
    return res.status(400).json({ error: "Tipe harus 'grid' atau 'funding_arb'" });
  }
  if (!marketSymbol || typeof marketSymbol !== "string") {
    return res.status(400).json({ error: "marketSymbol diperlukan" });
  }
  if (type === "grid" && !gridConfig) {
    return res.status(400).json({ error: "gridConfig diperlukan untuk tipe Grid" });
  }
  const { frArbConfig } = req.body ?? {};
  if (type === "funding_arb" && !frArbConfig) {
    return res.status(400).json({ error: "frArbConfig diperlukan untuk tipe funding_arb" });
  }

  try {
    const inserted = await db
      .insert(strategiesTable)
      .values({
        userId: req.userId!,
        name: name.trim(),
        type,
        exchange: "extended",
        marketSymbol: marketSymbol.toUpperCase(),
        marketIndex: 0,
        isRunning: false,
        isActive: true,
        gridConfig: type === "grid" ? gridConfig : null,
        frArbConfig: type === "funding_arb" ? frArbConfig : null,
        totalOrders: 0,
        successfulOrders: 0,
        totalBought: "0",
        totalSold: "0",
        avgBuyPrice: "0",
        avgSellPrice: "0",
        realizedPnl: "0",
      })
      .returning();

    const strategy = inserted[0];
    res.status(201).json({
      id: strategy.id,
      name: strategy.name,
      type: strategy.type,
      exchange: strategy.exchange,
      marketSymbol: strategy.marketSymbol,
      isRunning: strategy.isRunning,
      isActive: strategy.isActive,
      createdAt: strategy.createdAt.toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, "[ExtendedBot] Failed to create extended strategy");
    res.status(500).json({ error: "Gagal membuat strategy Extended" });
  }
});

// ─── LIST STRATEGIES EXTENDED MILIK USER ─────────────────────────────────────

router.get("/", async (req: AuthRequest, res) => {
  try {
    const strategies = await db.query.strategiesTable.findMany({
      where: and(
        eq(strategiesTable.userId, req.userId!),
        eq(strategiesTable.exchange, "extended")
      ),
      orderBy: [desc(strategiesTable.createdAt)],
    });

    res.setHeader("Cache-Control", "no-store");
    res.json({
      strategies: strategies.map((s: typeof strategiesTable.$inferSelect) => ({
        id: s.id,
        name: s.name,
        type: s.type,
        exchange: s.exchange,
        marketSymbol: s.marketSymbol,
        isRunning: s.isRunning,
        isActive: s.isActive,
        totalOrders: s.totalOrders,
        successfulOrders: s.successfulOrders,
        totalBought: s.totalBought,
        totalSold: s.totalSold,
        avgBuyPrice: s.avgBuyPrice,
        avgSellPrice: s.avgSellPrice,
        realizedPnl: s.realizedPnl,
        nextRunAt: s.nextRunAt?.toISOString() ?? null,
        lastRunAt: s.lastRunAt?.toISOString() ?? null,
        createdAt: s.createdAt.toISOString(),
        updatedAt: s.updatedAt.toISOString(),
        gridConfig: s.gridConfig ?? null,
        frArbConfig: s.frArbConfig ?? null,
        frArbState: s.frArbState ?? null,
        nextRunAtLive: isExtendedBotRunning(s.id)
          ? (getExtendedBotNextRunAt(s.id)?.toISOString() ?? null)
          : null,
      })),
    });
  } catch (err) {
    req.log.error({ err }, "[ExtendedBot] Failed to list extended strategies");
    res.status(500).json({ error: "Gagal mengambil daftar strategy Extended" });
  }
});

// ─── KONFIGURASI EXTENDED USER (API Key, Stark PK, Account ID) ───────────────
// Statis → harus sebelum wildcard /:strategyId

router.get("/user-config", async (req: AuthRequest, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const creds = await getExtendedCredentials(req.userId!);
    res.json({
      hasApiKey: creds.hasApiKey,
      hasPrivateKey: creds.hasPrivateKey,
      hasAccountId: creds.hasAccountId,
      accountId: creds.accountId ?? null,
      extendedNetwork: creds.extendedNetwork,
    });
  } catch (err) {
    req.log.error({ err }, "[ExtendedBot] Failed to read user config");
    res.status(500).json({ error: "Gagal membaca konfigurasi Extended" });
  }
});

router.put("/user-config", async (req: AuthRequest, res) => {
  const { apiKey, privateKey, accountId, extendedNetwork } = req.body ?? {};
  try {
    const updates: {
      apiKey?: string | null;
      privateKey?: string | null;
      accountId?: string | null;
      extendedNetwork?: "mainnet";
    } = {};
    if (apiKey !== undefined) updates.apiKey = apiKey;
    if (privateKey !== undefined) updates.privateKey = privateKey;
    if (accountId !== undefined) updates.accountId = accountId;
    if (extendedNetwork === "mainnet") {
      updates.extendedNetwork = extendedNetwork;
    }

    if (Object.keys(updates).length === 0) {
      return res.json({ success: true, message: "Tidak ada perubahan" });
    }

    await updateExtendedCredentials(req.userId!, updates);
    res.json({ success: true, message: "Konfigurasi Extended disimpan" });
  } catch (err) {
    req.log.error({ err }, "[ExtendedBot] Failed to update user config");
    res.status(500).json({ error: "Gagal menyimpan konfigurasi Extended" });
  }
});

// ─── TEST SIGNING / VERIFIKASI CREDENTIALS (DIAGNOSIS) ───────────────────────
// Verifikasi credentials dan test signing tanpa menunggu crossing grid.
//
// dry_run=true (default): cek starkKey match + l2Vault saja, tanpa kirim order.
// dry_run=false: kirim LIMIT order nyata ke exchange untuk verifikasi signature end-to-end.
//   PERHATIAN: gunakan harga jauh dari market agar order tidak terisi (e.g. price=1 untuk BUY).
//
// POST /api/extended/strategies/test-sign
// Body: { market?, side?, qty?, price?, dry_run? }

router.post("/test-sign", async (req: AuthRequest, res) => {
  const {
    market = "ETH-USD",
    side = "BUY",
    qty = "0.001",
    price = "100",
    dry_run = true,
  } = req.body ?? {};

  try {
    const creds = await getExtendedCredentials(req.userId!);

    if (!creds.apiKey || !creds.privateKey) {
      return res.status(400).json({
        error: "Credentials Extended belum dikonfigurasi. Set API key dan Stark private key terlebih dahulu.",
      });
    }

    const network = (creds.extendedNetwork ?? "mainnet") as ExtendedNetwork;

    // Ambil account details: l2Key (starkKey) dan l2Vault (collateralPosition)
    const accountDetails = await getAccountDetails(creds.apiKey, network);
    if (!accountDetails) {
      return res.status(502).json({ error: "Gagal fetch account info dari Extended Exchange." });
    }

    const registeredL2Key = accountDetails.l2Key ?? null;
    const l2Vault = accountDetails.l2Vault != null ? String(accountDetails.l2Vault) : (creds.accountId ?? null);

    if (!l2Vault) {
      return res.status(400).json({ error: "l2Vault tidak tersedia. Isi Account ID di pengaturan Extended." });
    }

    // Verifikasi starkKey match
    let derivedKey: string;
    try {
      derivedKey = derivePublicKey(creds.privateKey);
    } catch (keyErr: any) {
      return res.status(400).json({
        error: `Stark private key tidak valid: ${keyErr.message}`,
        l2Vault,
        registeredL2Key,
      });
    }

    const regNorm = registeredL2Key?.toLowerCase().replace(/^0x/, "") ?? null;
    const derivedNorm = derivedKey.toLowerCase().replace(/^0x/, "");
    const starkKeyMatch = regNorm !== null ? derivedNorm === regNorm : null;

    // Jika mismatch — gagal dengan pesan jelas
    if (starkKeyMatch === false) {
      return res.status(400).json({
        success: false,
        starkKeyMatch: false,
        derivedKey: `0x${derivedNorm}`,
        registeredKey: `0x${regNorm}`,
        l2Vault,
        network,
        error: "StarkKey mismatch! Stark Private Key yang tersimpan menghasilkan public key yang berbeda dari akun Exchange. Pastikan private key sudah benar.",
      });
    }

    // dry_run: hanya verifikasi credentials, tidak kirim order
    if (dry_run) {
      return res.json({
        success: true,
        dry_run: true,
        starkKeyMatch,
        derivedKey: `0x${derivedNorm}`,
        registeredL2Key,
        l2Vault,
        network,
        message: starkKeyMatch
          ? "Credentials OK: StarkKey match + l2Vault tersedia. Gunakan dry_run=false untuk tes kirim order nyata."
          : "l2Vault tersedia tapi starkKey tidak bisa diverifikasi (registeredL2Key null di response API).",
      });
    }

    // non-dry_run: kirim order nyata ke exchange untuk tes signature end-to-end
    // placeExtendedOrder menangani l2Config fetch otomatis dari /api/v1/info/markets
    try {
      const result = await placeExtendedOrder({
        apiKey: creds.apiKey,
        privateKey: creds.privateKey,
        collateralPosition: l2Vault,
        market: String(market).toUpperCase(),
        type: "LIMIT",
        side: String(side).toUpperCase() === "SELL" ? "SELL" : "BUY",
        qty: String(qty),
        price: String(price),
        timeInForce: "GTT",
        network,
      });

      return res.json({
        success: true,
        dry_run: false,
        starkKeyMatch,
        derivedKey: `0x${derivedNorm}`,
        registeredL2Key,
        l2Vault,
        network,
        orderResult: result,
        message: "Order DITERIMA oleh Extended Exchange! Signing berfungsi dengan benar.",
      });
    } catch (orderErr: any) {
      return res.status(422).json({
        success: false,
        dry_run: false,
        starkKeyMatch,
        derivedKey: `0x${derivedNorm}`,
        registeredL2Key,
        l2Vault,
        network,
        error: orderErr.message,
        message: "Credentials valid (starkKey match) tapi order ditolak exchange. Pesan error di atas menunjukkan penyebabnya.",
      });
    }
  } catch (err: any) {
    req.log.error({ err }, "[ExtendedBot] test-sign failed");
    res.status(500).json({ error: err.message ?? "Gagal test signing" });
  }
});

// ─── UPDATE STRATEGY EXTENDED ─────────────────────────────────────────────────

router.put("/:strategyId", async (req: AuthRequest, res) => {
  const strategyId = parseInt(String(req.params.strategyId));
  if (isNaN(strategyId)) {
    return res.status(400).json({ error: "strategyId tidak valid" });
  }

  const { name, gridConfig } = req.body ?? {};

  try {
    const strategy = await db.query.strategiesTable.findFirst({
      where: and(
        eq(strategiesTable.id, strategyId),
        eq(strategiesTable.userId, req.userId!),
        eq(strategiesTable.exchange, "extended")
      ),
    });

    if (!strategy) {
      return res.status(404).json({ error: "Strategy Extended tidak ditemukan" });
    }

    // BUG-EDIT-002: Ganti DB check (strategy.isRunning) ke in-memory check agar akurat.
    // DB bisa stale jika server crash/restart — in-memory adalah sumber kebenaran runtime.
    if (isExtendedBotRunning(strategyId)) {
      return res.status(409).json({ error: "Hentikan bot sebelum mengubah strategy" });
    }

    const updates: Record<string, any> = { updatedAt: new Date() };
    if (name && typeof name === "string" && name.trim().length >= 3) {
      updates.name = name.trim();
    }
    if (strategy.type === "grid" && gridConfig) {
      updates.gridConfig = gridConfig;
    }

    await db.update(strategiesTable).set(updates).where(
      and(eq(strategiesTable.id, strategyId), eq(strategiesTable.userId, req.userId!))
    );

    res.json({ success: true, message: "Strategy Extended diperbarui" });
  } catch (err) {
    req.log.error({ err, strategyId }, "[ExtendedBot] Failed to update extended strategy");
    res.status(500).json({ error: "Gagal memperbarui strategy Extended" });
  }
});

// ─── DELETE CREDENTIALS ───────────────────────────────────────────────────────
// HARUS didaftarkan SEBELUM wildcard /:strategyId agar tidak tertangkap duluan.

router.delete("/credentials", async (req: AuthRequest, res) => {
  try {
    await deleteExtendedCredentials(req.userId!);
    res.json({ ok: true, message: "Credentials Extended berhasil dihapus" });
  } catch (err) {
    req.log.error({ err }, "[ExtendedBot] Failed to delete credentials");
    res.status(500).json({ error: "Gagal menghapus credentials Extended" });
  }
});

// ─── HAPUS STRATEGY EXTENDED ─────────────────────────────────────────────────

router.delete("/:strategyId", async (req: AuthRequest, res) => {
  const strategyId = parseInt(String(req.params.strategyId));
  if (isNaN(strategyId)) {
    return res.status(400).json({ error: "strategyId tidak valid" });
  }

  try {
    const strategy = await db.query.strategiesTable.findFirst({
      where: and(
        eq(strategiesTable.id, strategyId),
        eq(strategiesTable.userId, req.userId!),
        eq(strategiesTable.exchange, "extended")
      ),
    });

    if (!strategy) {
      return res.status(404).json({ error: "Strategy Extended tidak ditemukan" });
    }

    // BUG-EDIT-004: Ganti DB check ke in-memory check — DB bisa stale jika crash.
    // Jika bot running di memori tapi DB isRunning=false, bot terus jalan setelah strategy dihapus.
    if (isExtendedBotRunning(strategyId)) {
      await stopExtendedBot(strategyId).catch(() => null);
    }

    await db.delete(strategiesTable).where(
      and(eq(strategiesTable.id, strategyId), eq(strategiesTable.userId, req.userId!))
    );

    res.json({ success: true, message: "Strategy Extended dihapus" });
  } catch (err) {
    req.log.error({ err, strategyId }, "[ExtendedBot] Failed to delete extended strategy");
    res.status(500).json({ error: "Gagal menghapus strategy Extended" });
  }
});

// ─── TRADE HISTORY (H-02) ─────────────────────────────────────────────────────
// GET /api/extended/strategies/trades?market=...&type=...&side=...&limit=...

router.get("/trades", async (req: AuthRequest, res) => {
  try {
    const creds = await getExtendedCredentials(req.userId!).catch(() => null);
    if (!creds?.apiKey) {
      return res.status(400).json({ error: "Credentials Extended belum dikonfigurasi" });
    }

    const { market, type, side, cursor, limit } = req.query as Record<string, string | undefined>;
    const trades = await getExtendedUserTrades(creds.apiKey, (creds.extendedNetwork ?? "mainnet") as ExtendedNetwork, {
      market,
      type,
      side,
      cursor: cursor ? parseInt(cursor) : undefined,
      limit: limit ? Math.min(parseInt(limit), 100) : 50,
    });

    res.setHeader("Cache-Control", "no-store");
    res.json({ trades, count: trades.length });
  } catch (err) {
    req.log.error({ err }, "[ExtendedBot] Failed to fetch trade history");
    res.status(500).json({ error: "Gagal mengambil trade history" });
  }
});

// ─── FUNDING HISTORY (H-02) ───────────────────────────────────────────────────
// GET /api/extended/strategies/funding?market=...&startTime=...&limit=...

router.get("/funding", async (req: AuthRequest, res) => {
  try {
    const creds = await getExtendedCredentials(req.userId!).catch(() => null);
    if (!creds?.apiKey) {
      return res.status(400).json({ error: "Credentials Extended belum dikonfigurasi" });
    }

    const { market, side, cursor, limit, startTime } = req.query as Record<string, string | undefined>;
    // Default startTime: 30 hari yang lalu
    const resolvedStartTime = startTime ? parseInt(startTime) : Date.now() - 30 * 24 * 60 * 60 * 1000;

    const payments = await getExtendedFundingHistory(creds.apiKey, (creds.extendedNetwork ?? "mainnet") as ExtendedNetwork, {
      startTime: resolvedStartTime,
      market,
      side,
      cursor: cursor ? parseInt(cursor) : undefined,
      limit: limit ? Math.min(parseInt(limit), 100) : 50,
    });

    res.setHeader("Cache-Control", "no-store");
    res.json({ payments, count: payments.length });
  } catch (err) {
    req.log.error({ err }, "[ExtendedBot] Failed to fetch funding history");
    res.status(500).json({ error: "Gagal mengambil funding history" });
  }
});

// ─── POSITIONS HISTORY (H-02) ─────────────────────────────────────────────────
// GET /api/extended/strategies/positions/history?market=...&side=...&limit=...

router.get("/positions/history", async (req: AuthRequest, res) => {
  try {
    const creds = await getExtendedCredentials(req.userId!).catch(() => null);
    if (!creds?.apiKey) {
      return res.status(400).json({ error: "Credentials Extended belum dikonfigurasi" });
    }

    const { market, side, cursor, limit } = req.query as Record<string, string | undefined>;
    const positions = await getExtendedPositionsHistory(creds.apiKey, (creds.extendedNetwork ?? "mainnet") as ExtendedNetwork, {
      market,
      side,
      cursor: cursor ? parseInt(cursor) : undefined,
      limit: limit ? Math.min(parseInt(limit), 100) : 50,
    });

    res.setHeader("Cache-Control", "no-store");
    res.json({ positions, count: positions.length });
  } catch (err) {
    req.log.error({ err }, "[ExtendedBot] Failed to fetch positions history");
    res.status(500).json({ error: "Gagal mengambil positions history" });
  }
});

// ─── DETAIL SATU STRATEGY ─────────────────────────────────────────────────────
// Wildcard → harus paling bawah agar tidak menangkap path statis di atas

router.get("/:strategyId", async (req: AuthRequest, res) => {
  const strategyId = parseInt(String(req.params.strategyId));
  if (isNaN(strategyId)) {
    return res.status(400).json({ error: "strategyId tidak valid" });
  }

  try {
    const strategy = await db.query.strategiesTable.findFirst({
      where: and(
        eq(strategiesTable.id, strategyId),
        eq(strategiesTable.userId, req.userId!),
        eq(strategiesTable.exchange, "extended")
      ),
    });

    if (!strategy) {
      return res.status(404).json({ error: "Strategy Extended tidak ditemukan" });
    }

    res.setHeader("Cache-Control", "no-store");
    res.json({
      id: strategy.id,
      name: strategy.name,
      type: strategy.type,
      exchange: strategy.exchange,
      marketSymbol: strategy.marketSymbol,
      marketIndex: strategy.marketIndex,
      isRunning: strategy.isRunning,
      isActive: strategy.isActive,
      gridConfig: strategy.gridConfig ?? null,
      totalOrders: strategy.totalOrders,
      successfulOrders: strategy.successfulOrders,
      totalBought: strategy.totalBought,
      totalSold: strategy.totalSold,
      avgBuyPrice: strategy.avgBuyPrice,
      avgSellPrice: strategy.avgSellPrice,
      realizedPnl: strategy.realizedPnl,
      nextRunAt: strategy.nextRunAt?.toISOString() ?? null,
      lastRunAt: strategy.lastRunAt?.toISOString() ?? null,
      createdAt: strategy.createdAt.toISOString(),
      updatedAt: strategy.updatedAt.toISOString(),
      nextRunAtLive: isExtendedBotRunning(strategyId)
        ? (getExtendedBotNextRunAt(strategyId)?.toISOString() ?? null)
        : null,
    });
  } catch (err) {
    req.log.error({ err, strategyId }, "[ExtendedBot] Failed to get extended strategy detail");
    res.status(500).json({ error: "Gagal mengambil detail strategy Extended" });
  }
});

export default router;
