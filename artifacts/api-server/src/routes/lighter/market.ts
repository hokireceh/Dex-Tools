import { Router } from "express";
import { getOrderBookDepth, getCandles } from "../../lib/lighter/lighterApi";
import { getMarkets, getMarketInfo, type MarketInfo } from "../../lib/lighter/marketCache";
import { logger } from "../../lib/logger";

const router = Router();

// ─── Sparkline Cache (30-min TTL) ────────────────────────────────────────────
const sparklineCache = new Map<number, { prices: number[]; fetchedAt: number }>();
const SPARKLINE_TTL = 30 * 60 * 1000;

// ─── In-flight deduplication: prevents duplicate API calls for the same market ─
const inFlightSparkline = new Map<number, Promise<number[]>>();

// ─── Global background-fetch lock: only one sweep runs at a time ──────────────
let bgFetchRunning = false;

// ─── Rate-safe throttle: 1 concurrent request at a time ──────────────────────
// Lighter standard accounts: 60 req/min total.
// 1 req per 1200ms ≈ 50 req/min — leaves headroom for other API calls.
// 168 markets × 1200ms ≈ 3.4 min — acceptable since cache TTL is 30 min.
async function throttleAll<T>(
  items: number[],
  fn: (item: number) => Promise<T>,
  concurrency = 1,
  delayMs = 1200
): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
    if (i + concurrency < items.length) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return results;
}

async function fetchOneSparkline(marketId: number): Promise<number[]> {
  const cached = sparklineCache.get(marketId);
  if (cached && Date.now() - cached.fetchedAt < SPARKLINE_TTL) return cached.prices;

  const inFlight = inFlightSparkline.get(marketId);
  if (inFlight) return inFlight;

  const promise = (async () => {
    try {
      const data = await getCandles(marketId, "4h", 42);
      const prices = (data.c ?? []).map((candle) => parseFloat(candle.c)).filter((p) => !isNaN(p));
      sparklineCache.set(marketId, { prices, fetchedAt: Date.now() });
      return prices;
    } catch {
      return [];
    } finally {
      inFlightSparkline.delete(marketId);
    }
  })();

  inFlightSparkline.set(marketId, promise);
  return promise;
}

// ─── Background sparkline sweep ───────────────────────────────────────────────
// Fetches sparklines for every market that is missing or stale, at a rate-safe
// pace (1 req/1200ms). Runs asynchronously — never blocks an HTTP response.
function triggerBackgroundFetch(marketIds: number[]): void {
  if (bgFetchRunning) return;

  const stale = marketIds.filter((id) => {
    const c = sparklineCache.get(id);
    return !c || Date.now() - c.fetchedAt >= SPARKLINE_TTL;
  });

  if (stale.length === 0) return;

  bgFetchRunning = true;
  logger.info({ count: stale.length }, "[Sparkline] Background fetch started");

  throttleAll(stale, fetchOneSparkline, 1, 1200)
    .then(() => {
      logger.info({ count: stale.length }, "[Sparkline] Background fetch complete");
    })
    .catch((err) => {
      logger.warn({ err }, "[Sparkline] Background fetch error");
    })
    .finally(() => {
      bgFetchRunning = false;
    });
}

function toRow(m: MarketInfo, sparkline: number[]) {
  return {
    index: m.index,
    symbol: m.symbol,
    baseAsset: m.baseAsset,
    quoteAsset: m.quoteAsset,
    type: m.type,
    lastPrice: m.lastTradePrice,
    priceChange24h: m.dailyPriceChange,
    volume24h: m.dailyVolumeQuote,
    high24h: m.dailyHigh,
    low24h: m.dailyLow,
    priceDecimals: m.priceDecimals,
    minBaseAmount: m.minBaseAmount,
    minQuoteAmount: m.minQuoteAmount,
    listedAt: m.listedAt ?? null,
    openInterest: m.openInterest ?? null,
    maxLeverage: m.maxLeverage ?? null,
    sparkline,
  };
}

// ─── GET /market/all ─────────────────────────────────────────────────────────
// Returns immediately using whatever sparklines are already cached.
// A background sweep fills any missing/stale sparklines at a rate-safe pace.
// This avoids blocking the response on 168 sequential Lighter API calls.
router.get("/all", async (req, res) => {
  try {
    const markets = await getMarkets();
    const marketIds = markets.map((m) => m.index);

    // Return cached sparklines instantly (empty [] for markets not yet fetched)
    const sl = (id: number) => sparklineCache.get(id)?.prices ?? [];

    // Start background fetch for any stale/missing sparklines (non-blocking)
    triggerBackgroundFetch(marketIds);

    const totalVolume24h = markets.reduce((s, m) => s + m.dailyVolumeQuote, 0);
    const totalOpenInterest = markets.reduce((s, m) => s + (m.openInterest ?? 0), 0);

    const byChange = [...markets].sort((a, b) => b.dailyPriceChange - a.dailyPriceChange);
    const gainers = byChange
      .filter((m) => m.dailyPriceChange > 0)
      .slice(0, 6)
      .map((m) => toRow(m, sl(m.index)));
    const losers = byChange
      .filter((m) => m.dailyPriceChange < 0)
      .reverse()
      .slice(0, 6)
      .map((m) => toRow(m, sl(m.index)));

    const recentlyListed = [...markets]
      .sort((a, b) => b.index - a.index)
      .slice(0, 6)
      .map((m) => toRow(m, sl(m.index)));

    res.json({
      markets: markets.map((m) => toRow(m, sl(m.index))),
      stats: {
        totalMarkets: markets.length,
        totalVolume24h,
        totalOpenInterest,
        perpCount: markets.filter((m) => m.type === "perp").length,
        spotCount: markets.filter((m) => m.type === "spot").length,
      },
      recentlyListed,
      gainers,
      losers,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch all markets");
    res.status(502).json({ error: "Failed to fetch market data" });
  }
});

// ─── GET /market/orderbooks ───────────────────────────────────────────────────
router.get("/orderbooks", async (req, res) => {
  try {
    const markets = await getMarkets();
    res.json({
      markets: markets.map((m) => ({
        index: m.index,
        symbol: m.symbol,
        baseAsset: m.baseAsset,
        quoteAsset: m.quoteAsset,
        type: m.type,
        sizeDecimals: m.sizeDecimals,
        priceDecimals: m.priceDecimals,
        minBaseAmount: m.minBaseAmount,
        minQuoteAmount: m.minQuoteAmount,
      })),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch order books");
    res.status(502).json({ error: "Failed to fetch market data from Lighter" });
  }
});

// ─── GET /market/ticker/:marketIndex ─────────────────────────────────────────
router.get("/ticker/:marketIndex", async (req, res) => {
  const marketIndex = parseInt(req.params.marketIndex);
  try {
    const [market, ob] = await Promise.all([
      getMarketInfo(marketIndex),
      getOrderBookDepth(marketIndex),
    ]);
    const lastPrice = market?.lastTradePrice ?? 0;
    const priceChangePct24h = market?.dailyPriceChange ?? 0;
    const bidPrice = ob.bids.length > 0 ? parseFloat(ob.bids[0].price) : lastPrice;
    const askPrice = ob.asks.length > 0 ? parseFloat(ob.asks[0].price) : lastPrice;
    res.json({
      marketIndex,
      lastPrice,
      bidPrice,
      askPrice,
      spread: askPrice > 0 && bidPrice > 0 ? askPrice - bidPrice : 0,
      volume24h: market?.dailyVolumeQuote ?? 0,
      high24h: market?.dailyHigh ?? 0,
      low24h: market?.dailyLow ?? 0,
      priceChange24h:
        lastPrice > 0 && priceChangePct24h !== 0
          ? lastPrice - lastPrice / (1 + priceChangePct24h / 100)
          : 0,
      priceChangePct24h,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    req.log.error({ err, marketIndex }, "Failed to fetch ticker");
    res.status(502).json({ error: "Failed to fetch ticker" });
  }
});

// ─── GET /market/orderbook/:marketIndex ──────────────────────────────────────
router.get("/orderbook/:marketIndex", async (req, res) => {
  const marketIndex = parseInt(req.params.marketIndex);
  try {
    const ob = await getOrderBookDepth(marketIndex);
    let bt = 0, at = 0;
    const bids = (ob.bids ?? []).slice(0, 20).map((b) => {
      const size = parseFloat(b.size);
      bt += size;
      return { price: parseFloat(b.price), size, total: bt };
    });
    const asks = (ob.asks ?? []).slice(0, 20).map((a) => {
      const size = parseFloat(a.size);
      at += size;
      return { price: parseFloat(a.price), size, total: at };
    });
    const lastPrice =
      bids.length > 0 && asks.length > 0 ? (bids[0].price + asks[0].price) / 2 : 0;
    res.json({ marketIndex, bids, asks, lastPrice, updatedAt: new Date().toISOString() });
  } catch (err) {
    req.log.error({ err, marketIndex }, "Failed to fetch order book");
    res.status(502).json({ error: "Failed to fetch order book" });
  }
});

export default router;
