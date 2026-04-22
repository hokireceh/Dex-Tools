import { getOrderBooks, type Network } from "./lighterApi";
import { logger } from "../logger";

export interface MarketInfo {
  index: number;
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  type: "perp" | "spot";
  sizeDecimals: number;
  priceDecimals: number;
  minBaseAmount: number;
  minQuoteAmount: number;
  lastTradePrice: number;
  dailyPriceChange: number;
  dailyVolume: number;
  dailyVolumeQuote: number;
  dailyHigh: number;
  dailyLow: number;
  listedAt?: string;
  openInterest?: number;
  maxLeverage?: number;
}

const marketCache = new Map<Network, { markets: MarketInfo[]; fetchedAt: Date }>();
// Fix #5: TTL dinaikkan 2 menit → 10 menit.
// Market config (min sizes, decimals, symbols) sangat jarang berubah.
// Dengan 10 menit TTL: maks 6 request/jam ke /orderBookDetails per network,
// jauh di bawah budget 60 request/menit Lighter.
const CACHE_TTL_MS = 10 * 60 * 1000;

// Fix #1: In-flight deduplication — mencegah N bot yang start bersamaan
// masing-masing memanggil getOrderBooks() sendiri saat cache cold.
// Semua pemanggil yang datang saat fetch sedang berjalan akan menunggu
// Promise yang sama, bukan membuat request baru.
const fetchInFlight = new Map<Network, Promise<MarketInfo[]>>();

// Fallback market data used ONLY if Lighter API is unreachable.
// IMPORTANT: minBaseAmount MUST reflect real exchange minimums.
// With minBaseAmount=0 the order-size validation is skipped entirely,
// meaning the sequencer would reject undersized orders with a cryptic error
// instead of a clear "below minimum" warning in the bot logs.
// Values below are sourced from Lighter's /api/v1/orderBookDetails as of 2026-Q1.
const FALLBACK_MARKETS: MarketInfo[] = [
  { index: 1, symbol: "BTC-USDC",  baseAsset: "BTC",  quoteAsset: "USDC", type: "perp", sizeDecimals: 5, priceDecimals: 1, minBaseAmount: 0.0002, minQuoteAmount: 10, lastTradePrice: 0, dailyPriceChange: 0, dailyVolume: 0, dailyVolumeQuote: 0, dailyHigh: 0, dailyLow: 0 },
  { index: 2, symbol: "ETH-USDC",  baseAsset: "ETH",  quoteAsset: "USDC", type: "perp", sizeDecimals: 4, priceDecimals: 2, minBaseAmount: 0.003,  minQuoteAmount: 10, lastTradePrice: 0, dailyPriceChange: 0, dailyVolume: 0, dailyVolumeQuote: 0, dailyHigh: 0, dailyLow: 0 },
  { index: 3, symbol: "SOL-USDC",  baseAsset: "SOL",  quoteAsset: "USDC", type: "perp", sizeDecimals: 2, priceDecimals: 3, minBaseAmount: 0.1,    minQuoteAmount: 10, lastTradePrice: 0, dailyPriceChange: 0, dailyVolume: 0, dailyVolumeQuote: 0, dailyHigh: 0, dailyLow: 0 },
];

async function fetchAndCacheMarkets(network: Network): Promise<MarketInfo[]> {
  const now = new Date();
  try {
    const data = await getOrderBooks(network);
    const markets = (data.order_books ?? []).map((ob) => ({
      index: ob.market_id,
      symbol: ob.pair_symbol,
      baseAsset: ob.base_asset_symbol,
      quoteAsset: ob.quote_asset_symbol,
      type: (ob.order_book_type === "perp" ? "perp" : "spot") as "perp" | "spot",
      sizeDecimals: ob.supported_size_decimals ?? 4,
      priceDecimals: ob.supported_price_decimals ?? 2,
      minBaseAmount: parseFloat(ob.min_base_amount ?? "0"),
      minQuoteAmount: parseFloat(ob.min_quote_amount ?? "0"),
      lastTradePrice: ob.last_trade_price ?? 0,
      dailyPriceChange: ob.daily_price_change ?? 0,
      dailyVolume: ob.daily_base_token_volume ?? 0,
      dailyVolumeQuote: ob.daily_quote_token_volume ?? 0,
      dailyHigh: ob.daily_price_high ?? 0,
      dailyLow: ob.daily_price_low ?? 0,
      listedAt: ob.created_at,
      openInterest: ob.open_interest,
      maxLeverage: ob.max_leverage,
    }));
    marketCache.set(network, { markets, fetchedAt: now });
    logger.info({ count: markets.length, network }, "Market cache refreshed");
    return markets;
  } catch (err) {
    logger.error({ err }, "Failed to fetch markets, using fallback");
    // Fix #1: Tulis fallback ke cache dengan sisa TTL 30 detik agar
    // pemanggil berikutnya tidak langsung retry getOrderBooks lagi.
    // Tanpa ini, cache tetap kosong → setiap cycle terus retry → cascade 429.
    const existing = marketCache.get(network);
    const fallback = existing && existing.markets.length > 0 ? existing.markets : FALLBACK_MARKETS;
    marketCache.set(network, {
      markets: fallback,
      fetchedAt: new Date(now.getTime() - CACHE_TTL_MS + 30_000),
    });
    return fallback;
  } finally {
    fetchInFlight.delete(network);
  }
}

export async function getMarkets(network: Network = "mainnet"): Promise<MarketInfo[]> {
  const now = new Date();
  const cached = marketCache.get(network);
  if (cached && cached.markets.length > 0 && (now.getTime() - cached.fetchedAt.getTime()) < CACHE_TTL_MS) {
    return cached.markets;
  }

  // Fix #1: Jika sudah ada fetch yang sedang berjalan untuk network ini,
  // tunggu Promise yang sama — tidak buat request baru.
  const inflight = fetchInFlight.get(network);
  if (inflight) return inflight;

  const promise = fetchAndCacheMarkets(network);
  fetchInFlight.set(network, promise);
  return promise;
}

export async function getMarketSymbol(marketIndex: number, network: Network = "mainnet"): Promise<string> {
  const markets = await getMarkets(network);
  return markets.find((m) => m.index === marketIndex)?.symbol ?? `MARKET-${marketIndex}`;
}

export async function getMarketInfo(marketIndex: number, network: Network = "mainnet"): Promise<MarketInfo | null> {
  const markets = await getMarkets(network);
  return markets.find((m) => m.index === marketIndex) ?? null;
}

/**
 * Fetch live market info directly from the exchange API for a specific market index,
 * bypassing the bot engine cache entirely.
 * Use this for on-demand requests (e.g. AI analysis) where stale data is unacceptable
 * and the shared cache must not be disturbed.
 */
export async function fetchLiveMarketInfo(
  marketIndex: number,
  network: Network = "mainnet"
): Promise<MarketInfo | null> {
  const data = await getOrderBooks(network);
  const ob = (data.order_books ?? []).find((o: any) => o.market_id === marketIndex);
  if (!ob) return null;
  return {
    index: ob.market_id,
    symbol: ob.pair_symbol,
    baseAsset: ob.base_asset_symbol,
    quoteAsset: ob.quote_asset_symbol,
    type: (ob.order_book_type === "perp" ? "perp" : "spot") as "perp" | "spot",
    sizeDecimals: ob.supported_size_decimals ?? 4,
    priceDecimals: ob.supported_price_decimals ?? 2,
    minBaseAmount: parseFloat(ob.min_base_amount ?? "0"),
    minQuoteAmount: parseFloat(ob.min_quote_amount ?? "0"),
    lastTradePrice: ob.last_trade_price ?? 0,
    dailyPriceChange: ob.daily_price_change ?? 0,
    dailyVolume: ob.daily_base_token_volume ?? 0,
    dailyVolumeQuote: ob.daily_quote_token_volume ?? 0,
    dailyHigh: ob.daily_price_high ?? 0,
    dailyLow: ob.daily_price_low ?? 0,
    listedAt: ob.created_at,
    openInterest: ob.open_interest,
    maxLeverage: ob.max_leverage,
  };
}
