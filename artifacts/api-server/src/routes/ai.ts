import { Router } from "express";
import { authMiddleware, type AuthRequest } from "../middlewares/auth";
import { fetchLiveMarketInfo } from "../lib/lighter/marketCache";
import { fetchLiveExtendedMarketInfo } from "../lib/extended/extendedMarkets";
import { analyzeMarketForStrategy, analyzeMarketConditionOnly } from "../lib/groqAI";
import { getBotConfig } from "./configService";
import { getAccountByIndex } from "../lib/lighter/lighterApi";
import type { ExtendedNetwork } from "../lib/extended/extendedApi";

const router = Router();
router.use(authMiddleware);

router.post("/analyze", async (req: AuthRequest, res) => {
  const { strategyType, marketIndex, marketSymbol, exchange, forcedMarketCondition } = req.body as {
    strategyType: "grid";
    marketIndex?: number;
    marketSymbol?: string;
    exchange?: string;
    forcedMarketCondition?: "bullish" | "bearish" | "sideways" | "volatile";
  };

  if (strategyType !== "grid") {
    return res.status(400).json({ error: "strategyType must be 'grid'" });
  }

  const isExtended = exchange === "extended" && typeof marketSymbol === "string" && marketSymbol.trim().length > 0;
  const isLighter = !isExtended && (marketIndex !== undefined && marketIndex !== null && !isNaN(Number(marketIndex)));

  if (!isExtended && !isLighter) {
    return res.status(400).json({ error: "Sertakan marketIndex (Lighter) atau marketSymbol (Extended) dengan exchange yang sesuai" });
  }

  try {
    // ─── Extended branch ───────────────────────────────────────────────────────
    if (isExtended) {
      const network: ExtendedNetwork = "mainnet";

      // BUG-AI-004 fix: bypass cache — call API langsung agar harga selalu live.
      // Bot engine cache tidak disentuh sama sekali → zero side effect.
      const market = await fetchLiveExtendedMarketInfo(marketSymbol!.trim(), network);
      if (!market) {
        return res.status(404).json({ error: `Market Extended '${marketSymbol}' tidak ditemukan` });
      }

      const minQuoteAmount = parseFloat(market.minOrderValue) || 1;
      const minBaseAmount = parseFloat(market.minOrderSize) || 0.001;

      const result = await analyzeMarketForStrategy(strategyType, {
        exchange: "extended",
        symbol: market.market,
        type: "perp",
        lastPrice: market.lastPrice,
        high24h: market.dailyHigh,
        low24h: market.dailyLow,
        volume24h: parseFloat(market.dailyVolume),
        priceChangePct24h: market.dailyChangePercent,
        minBaseAmount,
        minQuoteAmount,
        fundingRate: market.fundingRate ? parseFloat(market.fundingRate) : null,
        forcedMarketCondition,
      });

      return res.json({ ...result, availableBalance: undefined });
    }

    // ─── Lighter branch ────────────────────────────────────────────────────────
    // BUG-AI-004 fix: bypass cache — call API langsung agar harga selalu live.
    // Bot engine cache tidak disentuh sama sekali → zero side effect.
    const [market, config] = await Promise.all([
      fetchLiveMarketInfo(Number(marketIndex)),
      getBotConfig(req.userId!).catch(() => null),
    ]);

    if (!market) {
      return res.status(404).json({ error: "Market tidak ditemukan" });
    }

    let availableBalance: number | undefined;
    if (config?.accountIndex) {
      try {
        const accountRaw = await getAccountByIndex(config.accountIndex, config.network);
        const account = accountRaw?.accounts?.[0];
        if (account?.available_balance) {
          availableBalance = parseFloat(account.available_balance);
        }
      } catch {
        req.log.warn("Failed to fetch account balance for AI context, using default");
      }
    }

    const result = await analyzeMarketForStrategy(strategyType, {
      exchange: "lighter",
      symbol: market.symbol,
      type: market.type,
      lastPrice: market.lastTradePrice,
      high24h: market.dailyHigh,
      low24h: market.dailyLow,
      volume24h: market.dailyVolumeQuote,
      priceChangePct24h: market.dailyPriceChange,
      minBaseAmount: market.minBaseAmount,
      minQuoteAmount: market.minQuoteAmount,
      availableBalance,
      forcedMarketCondition,
    });

    res.json({ ...result, availableBalance });
  } catch (err: any) {
    req.log.error({ err }, "AI analysis failed");
    const msg = err?.message ?? "AI analysis failed";
    const isConfig = msg.includes("GROQ_API_KEY");
    res.status(isConfig ? 503 : 502).json({ error: msg });
  }
});

// ─── Shared Market Condition Endpoint ─────────────────────────────────────────
// Dipanggil SEKALI sebelum analisis per-exchange. Hasilnya (marketCondition)
// dikembalikan ke frontend, lalu frontend meneruskan sebagai forcedMarketCondition
// ke setiap panggilan /api/analyze. Ini memastikan semua exchange mendapat
// penilaian kondisi pasar yang sama untuk simbol yang sama.
router.post("/analyze/market-condition", async (req: AuthRequest, res) => {
  const { marketSymbol, marketIndex, exchange } = req.body as {
    marketSymbol?: string;
    marketIndex?: number;
    exchange?: string;
  };

  try {
    let symbol = "";
    let lastPrice = 0;
    let high24h = 0;
    let low24h = 0;
    let priceChangePct24h = 0;
    let volume24h = 0;

    if (exchange === "extended" && marketSymbol) {
      const market = await fetchLiveExtendedMarketInfo(marketSymbol.trim(), "mainnet");
      if (!market) return res.status(404).json({ error: `Market Extended '${marketSymbol}' tidak ditemukan` });
      symbol = market.market;
      lastPrice = market.lastPrice;
      high24h = market.dailyHigh;
      low24h = market.dailyLow;
      priceChangePct24h = market.dailyChangePercent;
      volume24h = parseFloat(market.dailyVolume);
    } else if (marketIndex !== undefined && !isNaN(Number(marketIndex))) {
      const market = await fetchLiveMarketInfo(Number(marketIndex));
      if (!market) return res.status(404).json({ error: "Market Lighter tidak ditemukan" });
      symbol = market.symbol;
      lastPrice = market.lastTradePrice;
      high24h = market.dailyHigh;
      low24h = market.dailyLow;
      priceChangePct24h = market.dailyPriceChange;
      volume24h = market.dailyVolumeQuote;
    } else {
      return res.status(400).json({ error: "Sertakan marketIndex (Lighter) atau marketSymbol + exchange (Extended)" });
    }

    const result = await analyzeMarketConditionOnly(symbol, lastPrice, high24h, low24h, priceChangePct24h, volume24h);
    return res.json(result);
  } catch (err: any) {
    req.log.error({ err }, "Market condition analysis failed");
    const msg = err?.message ?? "Market condition analysis failed";
    return res.status(502).json({ error: msg });
  }
});

export default router;
