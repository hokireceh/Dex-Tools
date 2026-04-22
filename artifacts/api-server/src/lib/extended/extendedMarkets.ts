import { getMarkets, clearMarketL2Cache, type ExtendedNetwork } from "./extendedApi";
import { logger } from "../logger";

export interface ExtendedMarketInfo {
  market: string;
  baseAsset: string;
  quoteAsset: string;
  marketType: string;
  isActive: boolean;
  maxLeverage: number;
  tickSize: string;
  stepSize: string;
  minOrderSize: string;
  maxOrderSize: string;
  minOrderValue: string;
  lastPrice: number;
  dailyChange: number;
  dailyChangePercent: number;
  dailyVolume: string;
  dailyHigh: number;
  dailyLow: number;
  markPrice: number;
  indexPrice: number;
  openInterest: string;
  fundingRate: string;
  /** true jika tickSize atau stepSize menggunakan nilai fallback hardcoded (M-02).
   * Bot engine harus menolak start jika ini true — nilai fallback bisa salah untuk market baru. */
  hasFallbackPrecision: boolean;
}

interface CacheEntry {
  markets: ExtendedMarketInfo[];
  fetchedAt: Date;
}

const marketCache = new Map<ExtendedNetwork, CacheEntry>();
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes — same TTL as Lighter cache

function parseMarket(m: any): ExtendedMarketInfo {
  const stats = m.marketStats ?? null;
  const [baseAsset, quoteAsset] = (m.name as string).includes("-")
    ? (m.name as string).split("-")
    : [m.name, m.collateralAsset ?? "USDT"];

  const tc = m.tradingConfig;
  const tickSizeRaw = tc?.minPriceChange ?? m.tickSize;
  const stepSizeRaw = tc?.minOrderSizeChange ?? m.stepSize;

  if (!tickSizeRaw) {
    logger.error({ market: m.name }, "[ExtendedMarkets] tickSize fallback ke \"0.01\" — tradingConfig.minPriceChange tidak tersedia. Bot tidak akan bisa start untuk market ini!");
  }
  if (!stepSizeRaw) {
    logger.error({ market: m.name }, "[ExtendedMarkets] stepSize fallback ke \"0.001\" — tradingConfig.minOrderSizeChange tidak tersedia. Bot tidak akan bisa start untuk market ini!");
  }

  return {
    market: m.name,
    baseAsset: baseAsset ?? m.name,
    quoteAsset: quoteAsset ?? (m.collateralAssetName ?? m.collateralAsset ?? "USDT"),
    marketType: m.marketType ?? "perpetual",
    isActive: m.active ?? m.isActive ?? (m.status === "ACTIVE"),
    maxLeverage: parseFloat(tc?.maxLeverage ?? m.maxLeverage ?? "100"),
    tickSize: tickSizeRaw ?? "0.01",
    stepSize: stepSizeRaw ?? "0.001",
    hasFallbackPrecision: !tickSizeRaw || !stepSizeRaw,
    minOrderSize: tc?.minOrderSize ?? m.minOrderSize ?? "0",
    maxOrderSize: tc?.maxLimitOrderValue ?? m.maxOrderSize ?? "0",
    minOrderValue: m.minOrderValue ?? "0",
    lastPrice: stats ? parseFloat(stats.lastPrice ?? stats.lastTradedPrice ?? "0") : 0,
    dailyChange: stats ? parseFloat(stats.dailyPriceChange) : 0,
    dailyChangePercent: stats ? parseFloat(stats.dailyPriceChangePercentage ?? stats.dailyPriceChangePercent ?? "0") : 0,
    dailyVolume: stats?.dailyVolume ?? "0",
    dailyHigh: stats ? parseFloat(stats.dailyHigh ?? stats.dailyHighPrice ?? "0") : 0,
    dailyLow: stats ? parseFloat(stats.dailyLow ?? stats.dailyLowPrice ?? "0") : 0,
    markPrice: stats ? parseFloat(stats.markPrice) : 0,
    indexPrice: stats ? parseFloat(stats.indexPrice) : 0,
    openInterest: stats?.openInterest ?? "0",
    fundingRate: stats?.fundingRate ?? "0",
  };
}

export async function getExtendedMarkets(
  apiKey?: string,
  network: ExtendedNetwork = "mainnet"
): Promise<ExtendedMarketInfo[]> {
  const now = new Date();
  const cached = marketCache.get(network);
  if (cached && cached.markets.length > 0 && now.getTime() - cached.fetchedAt.getTime() < CACHE_TTL_MS) {
    return cached.markets;
  }

  try {
    // /api/v1/info/markets sudah include marketStats inline — tidak perlu fetch terpisah
    const markets = await getMarkets(network);

    const marketInfoList: ExtendedMarketInfo[] = markets.map((m) => {
      if (!(m as any).marketStats && process.env.NODE_ENV !== "production") {
        logger.warn({ market: m.name }, "[ExtendedMarkets] marketStats tidak ada di response — price data akan nol");
      }
      return parseMarket(m);
    });

    marketCache.set(network, { markets: marketInfoList, fetchedAt: now });
    logger.info({ count: marketInfoList.length, network }, "[Extended] Market cache refreshed");

    return marketInfoList;
  } catch (err) {
    logger.error({ err }, "[Extended] Failed to fetch markets, returning cached data");
    const existing = marketCache.get(network);
    return existing && existing.markets.length > 0 ? existing.markets : [];
  }
}

export async function getExtendedMarketInfo(
  market: string,
  apiKey?: string,
  network: ExtendedNetwork = "mainnet"
): Promise<ExtendedMarketInfo | null> {
  const markets = await getExtendedMarkets(apiKey, network);
  return markets.find((m) => m.market === market) ?? null;
}

export async function refreshExtendedMarketCache(
  apiKey?: string,
  network: ExtendedNetwork = "mainnet"
): Promise<void> {
  marketCache.delete(network);
  await getExtendedMarkets(apiKey, network);
}

export function clearExtendedMarketCache(): void {
  marketCache.clear();
  clearMarketL2Cache();
}

/**
 * Fetch live market info for a specific symbol directly from the exchange API,
 * bypassing the bot engine cache entirely.
 * Use this for on-demand requests (e.g. AI analysis) where stale data is unacceptable
 * and the shared cache must not be disturbed.
 */
export async function fetchLiveExtendedMarketInfo(
  symbol: string,
  network: ExtendedNetwork = "mainnet"
): Promise<ExtendedMarketInfo | null> {
  const markets = await getMarkets(network);
  const m = markets.find((mk: any) => mk.name === symbol);
  if (!m) return null;
  return parseMarket(m);
}
