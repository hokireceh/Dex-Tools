import { randomUUID } from "crypto";
import Decimal from "decimal.js";
import { logger } from "../logger";
import { signOrder, generateNonce, type ExtendedOrderSide } from "./extendedSigner";

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

export const BASE_URLS = {
  mainnet: "https://api.starknet.extended.exchange",
} as const;

export type ExtendedNetwork = "mainnet";

export function getBaseUrl(network: ExtendedNetwork = "mainnet"): string {
  return BASE_URLS[network];
}

const EXTENDED_FETCH_TIMEOUT_MS = 15_000;
const EXTENDED_MAX_RETRIES = 3;
const USER_AGENT = "HokirecehProjects/1.0 ExtendedIntegration";

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface ExtendedApiResponse<T> {
  status: "ok" | "error";
  data: T;
  error?: { code: number; message: string };
  pagination?: { cursor: number; count: number };
}

async function extendedFetch<T>(
  path: string,
  network: ExtendedNetwork = "mainnet",
  options?: RequestInit & { apiKey?: string }
): Promise<T> {
  const { apiKey, ...fetchOptions } = options ?? {};
  const url = `${getBaseUrl(network)}${path}`;

  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
    ...(fetchOptions.headers as Record<string, string> | undefined),
  };

  if (apiKey) {
    headers["X-Api-Key"] = apiKey;
  }

  for (let attempt = 0; attempt < EXTENDED_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXTENDED_FETCH_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(url, {
        ...fetchOptions,
        signal: controller.signal,
        headers,
      });
    } catch (err: any) {
      clearTimeout(timer);
      if (err.name === "AbortError") {
        throw new Error(`Extended API timeout after ${EXTENDED_FETCH_TIMEOUT_MS}ms: ${path}`);
      }
      throw err;
    }
    clearTimeout(timer);

    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : 2_000 * Math.pow(2, attempt);
      logger.warn({ path, attempt, waitMs }, "[Extended] Rate limited (429), retrying...");
      if (attempt < EXTENDED_MAX_RETRIES - 1) {
        await sleep(waitMs);
        continue;
      }
      throw new Error(`Extended API rate limited (429) after ${EXTENDED_MAX_RETRIES} attempts: ${path}`);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Extended API error ${res.status}: ${text}`);
    }

    const envelope = await res.json() as ExtendedApiResponse<T>;

    if (envelope.status === "error") {
      throw new Error(
        `Extended API error (${envelope.error?.code ?? "unknown"}): ${envelope.error?.message ?? JSON.stringify(envelope)}`
      );
    }

    return envelope.data;
  }

  throw new Error(`Extended API: max retries exceeded for ${path}`);
}

// ─── Markets ────────────────────────────────────────────────────────────────

/** L2 config dari market — dibutuhkan untuk SNIP-12 signing. */
export interface ExtendedMarketL2Config {
  type: string;
  collateralId: string;
  collateralResolution: number;
  /** Starknet synthetic asset ID — HARUS dipakai sebagai `market` felt dalam SNIP-12, BUKAN ASCII nama market. */
  syntheticId: string;
  /** Quantums per unit base asset. Misal ETH-USD = 100000 (10^5). */
  syntheticResolution: number;
}

export interface ExtendedTradingConfig {
  minOrderSize: string;
  minOrderSizeChange: string;
  minPriceChange: string;
  maxMarketOrderValue?: string;
  maxLimitOrderValue?: string;
  maxPositionValue?: string;
  maxLeverage?: string;
  maxNumOrders?: string;
  limitPriceCap?: string;
  limitPriceFloor?: string;
}

export interface ExtendedMarket {
  name: string;
  assetName: string;
  /** Bisa "PERPETUAL" atau lainnya */
  marketType?: string;
  collateralAsset?: string;
  collateralAssetName?: string;
  isActive?: boolean;
  active?: boolean;
  status?: string;
  maxLeverage?: string;
  tickSize?: string;
  stepSize?: string;
  minOrderSize?: string;
  maxOrderSize?: string;
  minOrderValue?: string;
  /** L2 config untuk signing — tersedia via /api/v1/info/markets */
  l2Config?: ExtendedMarketL2Config;
  tradingConfig?: ExtendedTradingConfig;
}

export async function getMarkets(
  network: ExtendedNetwork = "mainnet"
): Promise<ExtendedMarket[]> {
  try {
    // Endpoint yang benar: /api/v1/info/markets (bukan /api/v1/markets)
    const data = await extendedFetch<ExtendedMarket[]>(
      "/api/v1/info/markets",
      network
    );
    return Array.isArray(data) ? data : [];
  } catch (err) {
    logger.error({ err }, "[Extended] Failed to fetch markets from /api/v1/info/markets");
    throw err;
  }
}

// ─── Market Statistics ───────────────────────────────────────────────────────

export interface ExtendedMarketStats {
  market?: string;
  indexPrice: string;
  markPrice: string;
  /** Nama field dari /api/v1/info/markets/{market}/stats */
  lastPrice?: string;
  /** Legacy field name */
  lastTradedPrice?: string;
  dailyPriceChange: string;
  /** Nama field dari /api/v1/info/markets/{market}/stats */
  dailyPriceChangePercentage?: string;
  /** Legacy field name */
  dailyPriceChangePercent?: string;
  dailyVolume: string;
  /** Nama field dari /api/v1/info/markets/{market}/stats */
  dailyHigh?: string;
  /** Legacy field name */
  dailyHighPrice?: string;
  /** Nama field dari /api/v1/info/markets/{market}/stats */
  dailyLow?: string;
  /** Legacy field name */
  dailyLowPrice?: string;
  openInterest?: string;
  fundingRate?: string;
  askPrice?: string;
  bidPrice?: string;
}

export async function getMarketStats(
  market: string,
  network: ExtendedNetwork = "mainnet"
): Promise<ExtendedMarketStats | null> {
  try {
    // Endpoint yang benar: /api/v1/info/markets/{market}/stats
    const data = await extendedFetch<ExtendedMarketStats>(
      `/api/v1/info/markets/${encodeURIComponent(market)}/stats`,
      network
    );
    return data;
  } catch (err) {
    logger.error({ err, market }, "[Extended] Failed to fetch market stats");
    return null;
  }
}

// ─── Order Book ──────────────────────────────────────────────────────────────

export interface ExtendedOrderBookEntry {
  p: string;
  q: string;
  c: string;
}

export interface ExtendedOrderBook {
  market: string;
  bid: ExtendedOrderBookEntry[];
  ask: ExtendedOrderBookEntry[];
}

export async function getOrderBookDepth(
  market: string,
  network: ExtendedNetwork = "mainnet"
): Promise<ExtendedOrderBook | null> {
  try {
    const data = await extendedFetch<ExtendedOrderBook>(
      `/api/v1/info/markets/${encodeURIComponent(market)}/orderbook`,
      network
    );
    return data;
  } catch (err) {
    logger.error({ err, market }, "[Extended] Failed to fetch order book");
    return null;
  }
}

// ─── Candles ─────────────────────────────────────────────────────────────────

export type ExtendedCandleInterval =
  | "1m" | "3m" | "5m" | "15m" | "30m"
  | "1h" | "2h" | "4h" | "6h" | "12h"
  | "1d" | "1w";

export interface ExtendedCandle {
  time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

export interface ExtendedCandlesData {
  candles: ExtendedCandle[];
}

export async function getCandles(
  market: string,
  interval: ExtendedCandleInterval = "1h",
  limit: number = 100,
  network: ExtendedNetwork = "mainnet"
): Promise<ExtendedCandle[]> {
  try {
    const data = await extendedFetch<ExtendedCandlesData>(
      `/api/v1/candles?market=${encodeURIComponent(market)}&interval=${interval}&limit=${limit}`,
      network
    );
    return data.candles ?? [];
  } catch (err) {
    logger.error({ err, market }, "[Extended] Failed to fetch candles");
    return [];
  }
}

// ─── Account (Private — requires API key) ────────────────────────────────────

export interface ExtendedAccountDetails {
  accountId: number;
  /** Stark public key akun — nama field dari API Extended adalah "l2Key" (bukan starkKey). */
  l2Key: string;
  description?: string;
  accountIndex?: number;
  status: string;
  /** l2Vault = collateralPosition yang dipakai untuk SNIP-12 signing */
  l2Vault: number;
  bridgeStarknetAddress?: string;
  apiKeys?: unknown[];
  accountIndexForKeyGeneration?: number;
}

export async function getAccountDetails(
  apiKey: string,
  network: ExtendedNetwork = "mainnet"
): Promise<ExtendedAccountDetails | null> {
  try {
    const data = await extendedFetch<ExtendedAccountDetails>(
      "/api/v1/user/account/info",
      network,
      { apiKey }
    );
    return data;
  } catch (err) {
    logger.error({ err }, "[Extended] Failed to fetch account details");
    return null;
  }
}

export interface ExtendedBalance {
  collateralName: string;
  balance: string;
  equity: string;
  availableForTrade: string;
  availableForWithdrawal: string;
  unrealisedPnl: string;
  initialMargin: string;
  marginRatio: string;
  updatedTime: number;
  exposure: string;
  leverage: string;
}

export async function getBalance(
  apiKey: string,
  network: ExtendedNetwork = "mainnet"
): Promise<ExtendedBalance | null> {
  try {
    const data = await extendedFetch<ExtendedBalance>(
      "/api/v1/user/balance",
      network,
      { apiKey }
    );
    return data;
  } catch (err) {
    logger.error({ err }, "[Extended] Failed to fetch balance");
    return null;
  }
}

export interface ExtendedPosition {
  id: number;
  accountId: number;
  market: string;
  side: "LONG" | "SHORT";
  leverage: string;
  size: string;
  value: string;
  openPrice: string;
  markPrice: string;
  liquidationPrice: string;
  margin: string;
  unrealisedPnl: string;
  realisedPnl: string;
  adl: string;
  createdTime: number;
  updatedTime: number;
}

export interface ExtendedPositionsData {
  positions: ExtendedPosition[];
}

export async function getPositions(
  apiKey: string,
  network: ExtendedNetwork = "mainnet"
): Promise<ExtendedPosition[]> {
  try {
    // Docs resmi (api-reference.md line 3185): response adalah { "status": "OK", "data": [...] }.
    // extendedFetch sudah unwrap envelope.data → caller menerima ExtendedPosition[] langsung.
    const data = await extendedFetch<ExtendedPosition[]>(
      "/api/v1/user/positions",
      network,
      { apiKey }
    );
    return Array.isArray(data) ? data : [];
  } catch (err) {
    logger.error({ err }, "[Extended] Failed to fetch positions");
    return [];
  }
}

export interface ExtendedOrder {
  id: number;
  accountId: number;
  externalId: string;
  market: string;
  type: string;
  side: "BUY" | "SELL";
  status: string;
  price: string;
  averagePrice: string;
  qty: string;
  filledQty: string;
  payedFee: string;
  reduceOnly: boolean;
  postOnly: boolean;
  createdTime: number;
  updatedTime: number;
  expireTime: number;
}

export interface ExtendedOpenOrdersData {
  orders: ExtendedOrder[];
}

export async function getOpenOrders(
  apiKey: string,
  market?: string,
  network: ExtendedNetwork = "mainnet"
): Promise<ExtendedOrder[]> {
  // EXT-SYNC-GHOST-POISON-001 FIX: JANGAN catch di sini — biarkan error propagate ke caller.
  // Sebelumnya: catch → return [] → syncExtendedOrderBookState lanjut dengan empty openOrders
  // → ghost detection anggap SEMUA pending orders hilang dari exchange → DB di-update
  // status="cancelled" + semua grid orders di-queue replay → DUPLICATE ORDERS di exchange.
  //
  // Caller (syncExtendedOrderBookState) sudah punya try/catch yang mem-abort sync dengan aman
  // jika getOpenOrders gagal. Log error tetap dicatat di sana.
  const qs = market ? `?market=${encodeURIComponent(market)}` : "";
  const data = await extendedFetch<ExtendedOpenOrdersData>(
    `/api/v1/user/orders/open${qs}`,
    network,
    { apiKey }
  );
  return data.orders ?? [];
}

export interface ExtendedOrderHistoryData {
  orders: ExtendedOrder[];
}

export async function getOrderHistory(
  apiKey: string,
  opts: { market?: string; cursor?: number; limit?: number } = {},
  network: ExtendedNetwork = "mainnet"
): Promise<ExtendedOrder[]> {
  try {
    const qs = new URLSearchParams();
    if (opts.market) qs.set("market", opts.market);
    if (opts.cursor != null) qs.set("cursor", String(opts.cursor));
    if (opts.limit != null) qs.set("limit", String(opts.limit));
    const query = qs.toString() ? `?${qs.toString()}` : "";
    const data = await extendedFetch<ExtendedOrderHistoryData>(
      `/api/v1/user/orders/history${query}`,
      network,
      { apiKey }
    );
    return data.orders ?? [];
  } catch (err) {
    logger.error({ err }, "[Extended] Failed to fetch order history");
    return [];
  }
}

/**
 * Ambil order berdasarkan externalId via GET /api/v1/user/orders/external/{externalId}.
 * Digunakan oleh pollPendingExtendedTrades untuk cek status order yang sedang pending di DB.
 * Response Extended mengembalikan array data[], kita ambil elemen pertama.
 * Return null jika order tidak ditemukan atau terjadi error.
 */
export async function getOrderByExternalId(
  apiKey: string,
  externalId: string,
  network: ExtendedNetwork = "mainnet"
): Promise<ExtendedOrder | null> {
  try {
    const data = await extendedFetch<ExtendedOrder[]>(
      `/api/v1/user/orders/external/${encodeURIComponent(externalId)}`,
      network,
      { apiKey }
    );
    return Array.isArray(data) && data.length > 0 ? data[0] : null;
  } catch (err) {
    logger.error({ err, externalId }, "[Extended] Failed to fetch order by externalId");
    return null;
  }
}

export interface ExtendedFees {
  makerFee: string;
  takerFee: string;
}

export async function getFees(
  apiKey: string,
  network: ExtendedNetwork = "mainnet"
): Promise<ExtendedFees | null> {
  try {
    const data = await extendedFetch<ExtendedFees>(
      "/api/v1/user/fees",
      network,
      { apiKey }
    );
    return data;
  } catch (err) {
    logger.error({ err }, "[Extended] Failed to fetch fees");
    return null;
  }
}

// ─── Validasi API Key ─────────────────────────────────────────────────────────

/**
 * Validasi API key Extended dengan memanggil endpoint read-only (GET /api/v1/user/account/info).
 * Mengembalikan { valid: true } jika API key benar, { valid: false, reason } jika tidak.
 * Tidak pernah throw — cocok untuk pre-flight check sebelum bot mulai.
 */
export async function validateExtendedApiKey(
  apiKey: string,
  network: ExtendedNetwork = "mainnet"
): Promise<{ valid: boolean; reason?: string }> {
  if (!apiKey || !apiKey.trim()) {
    return { valid: false, reason: "API key kosong" };
  }

  const url = `${BASE_URLS[network]}/api/v1/user/account/info`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        "X-Api-Key": apiKey,
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (res.status === 401) {
      return {
        valid: false,
        reason:
          `API key tidak valid untuk ${network}. ` +
          `Pastikan: 1) API key diambil dari https://app.extended.exchange/api-management, ` +
          `2) API key sesuai dengan network yang dipilih (${network}), ` +
          `3) API key tidak expired/dihapus.`,
      };
    }

    if (res.status === 403) {
      return {
        valid: false,
        reason: `API key tidak punya akses (403). Cek permission di API management Extended.`,
      };
    }

    if (!res.ok) {
      return {
        valid: false,
        reason: `Server Extended mengembalikan HTTP ${res.status} — kemungkinan masalah jaringan atau server down.`,
      };
    }

    return { valid: true };
  } catch (err: any) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      return { valid: false, reason: `Timeout saat validasi API key Extended (${network})` };
    }
    return { valid: false, reason: `Error jaringan: ${err.message}` };
  }
}

// ─── Utility helpers ─────────────────────────────────────────────────────────

export function getMidPrice(orderBook: ExtendedOrderBook): Decimal | null {
  const bestBid = orderBook.bid[0]?.p;
  const bestAsk = orderBook.ask[0]?.p;
  if (!bestBid || !bestAsk) return null;
  return new Decimal(bestBid).add(new Decimal(bestAsk)).div(2);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ORDER MANAGEMENT (merged from extendedOrderManager.ts)
// Berisi: placeExtendedOrder, cancelExtendedOrderById,
//         cancelExtendedOrderByExternalId, massCancelExtendedOrders,
//         calcMarketOrderPrice
// ═══════════════════════════════════════════════════════════════════════════════

/** Waktu kedaluwarsa default: 7 hari. */
const ORDER_DEFAULT_EXPIRY_DAYS = 7;

/** Batas maksimum fee taker yang di-sign (0.05%) — fee aktual Extended = 0.025%. Ini adalah ceiling authorized, bukan fee yang dibayar. */
const ORDER_MAX_SIGNED_TAKER_FEE = "0.0005";
/** Max fee maker (0%). */
const ORDER_DEFAULT_MAKER_FEE = "0.00000";

// ─── Market l2Config Cache ─────────────────────────────────────────────────────

/**
 * Cache l2Config per market per network (TTL 1 jam).
 * syntheticId/collateralId/resolution jarang berubah.
 */
const MARKET_L2_CACHE_TTL_MS = 60 * 60 * 1000;

interface L2CacheEntry {
  config: ExtendedMarketL2Config;
  fetchedAt: number;
}

const marketL2Cache: Map<string, L2CacheEntry> = new Map();

export function clearMarketL2Cache(): void {
  marketL2Cache.clear();
}

async function getMarketL2Config(
  market: string,
  network: ExtendedNetwork
): Promise<ExtendedMarketL2Config> {
  const cacheKey = `${network}:${market}`;
  const now = Date.now();
  const cached = marketL2Cache.get(cacheKey);

  if (cached && now - cached.fetchedAt < MARKET_L2_CACHE_TTL_MS) {
    return cached.config;
  }

  const markets = await getMarkets(network);
  for (const m of markets) {
    if (m.l2Config) {
      marketL2Cache.set(`${network}:${m.name}`, { config: m.l2Config, fetchedAt: now });
    }
  }

  const entry = marketL2Cache.get(cacheKey);
  if (!entry) {
    throw new Error(
      `[ExtendedApi] Market "${market}" tidak ditemukan di /api/v1/info/markets ` +
      `(network: ${network}). Pastikan nama market benar, e.g. "ETH-USD".`
    );
  }
  return entry.config;
}

// ─── Authenticated HTTP Helper ────────────────────────────────────────────────
// Berbeda dari extendedFetch: selalu memakai X-Api-Key, tidak ada retry/rate-limit.
// Digunakan khusus untuk mutating requests (POST order, DELETE order, POST massCancel).

async function extendedAuthRequest<T>(
  method: "GET" | "POST" | "DELETE" | "PATCH",
  path: string,
  apiKey: string,
  network: ExtendedNetwork,
  body?: unknown
): Promise<T> {
  const url = `${getBaseUrl(network)}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": USER_AGENT,
    "X-Api-Key": apiKey,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXTENDED_FETCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      throw new Error(`[ExtendedApi] Request timeout: ${method} ${path}`);
    }
    throw err;
  }
  clearTimeout(timer);

  const text = await res.text();

  if (!res.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      detail = parsed.error?.message ?? parsed.message ?? text;
    } catch {}

    if (res.status === 401) {
      throw new Error(
        `[ExtendedApi] HTTP 401 ${method} ${path}: API key tidak valid atau tidak punya akses. ` +
        `Periksa API key di Pengaturan → Extended DEX dan pastikan sesuai dengan network yang dipilih. ` +
        `(body: "${detail || "kosong"}")`
      );
    }

    throw new Error(`[ExtendedApi] HTTP ${res.status} ${method} ${path}: ${detail}`);
  }

  if (!text || text === "null") return null as unknown as T;

  const envelope = JSON.parse(text) as { status: string; data: T; error?: { code: number; message: string } };

  if (envelope.status === "error") {
    logger.error(
      { fullErrorResponse: envelope },
      "[ExtendedApi] API returned error status — full response logged for diagnosis"
    );
    throw new Error(
      `[ExtendedApi] API error (${envelope.error?.code ?? "?"}): ${envelope.error?.message ?? JSON.stringify(envelope)}`
    );
  }

  return envelope.data;
}

// ─── Tipe publik order ────────────────────────────────────────────────────────

export type ExtendedOrderType = "LIMIT" | "MARKET" | "CONDITIONAL";
export type ExtendedTimeInForce = "GTT" | "IOC" | "FOK";

export interface PlaceOrderParams {
  apiKey: string;
  privateKey: string;
  collateralPosition: string;
  market: string;
  type: ExtendedOrderType;
  side: ExtendedOrderSide;
  qty: string;
  price: string;
  fee?: string;
  timeInForce?: ExtendedTimeInForce;
  expiryEpochMillis?: number;
  reduceOnly?: boolean;
  postOnly?: boolean;
  nonce?: number;
  externalId?: string;
  cancelId?: string;
  syntheticResolution?: number;
  collateralResolution?: number;
  syntheticId?: string;
  network?: ExtendedNetwork;
}

export interface PlaceOrderResult {
  orderId: number;
  externalId: string;
}

export interface MassCancelParams {
  apiKey: string;
  markets?: string[];
  orderIds?: number[];
  externalOrderIds?: string[];
  cancelAll?: boolean;
  network?: ExtendedNetwork;
}

// ─── Order placement ──────────────────────────────────────────────────────────

/**
 * Menempatkan order baru di Extended DEX.
 * Signing menggunakan Stark Poseidon/SNIP-12 via extendedSigner.
 */
export async function placeExtendedOrder(
  params: PlaceOrderParams
): Promise<PlaceOrderResult> {
  const {
    apiKey,
    privateKey,
    collateralPosition,
    market,
    type,
    side,
    qty,
    price,
    fee,
    timeInForce,
    expiryEpochMillis,
    reduceOnly = false,
    postOnly = false,
    nonce,
    externalId,
    cancelId,
    network = "mainnet",
  } = params;

  let l2Config: ExtendedMarketL2Config;
  try {
    l2Config = await getMarketL2Config(market, network);
    logger.debug(
      { market, syntheticId: l2Config.syntheticId, syntheticResolution: l2Config.syntheticResolution },
      "[ExtendedApi] Fetched market l2Config"
    );
  } catch (err) {
    logger.error({ err, market, network }, "[ExtendedApi] Failed to fetch market l2Config");
    throw err;
  }

  const resolvedSyntheticId = params.syntheticId ?? l2Config.syntheticId;
  const resolvedCollateralId = l2Config.collateralId;
  const resolvedSyntheticRes = params.syntheticResolution ?? l2Config.syntheticResolution;
  const resolvedCollateralRes = params.collateralResolution ?? l2Config.collateralResolution;

  const resolvedNonce = nonce ?? generateNonce();
  const resolvedExternalId = externalId ?? randomUUID();
  const resolvedExpiry = expiryEpochMillis ?? Date.now() + ORDER_DEFAULT_EXPIRY_DAYS * 24 * 3600 * 1000;
  const resolvedFee = fee ?? (postOnly ? ORDER_DEFAULT_MAKER_FEE : ORDER_MAX_SIGNED_TAKER_FEE);
  const resolvedTif: ExtendedTimeInForce = timeInForce ?? (type === "MARKET" ? "IOC" : "GTT");

  let settlement: ReturnType<typeof signOrder>;
  try {
    settlement = signOrder({
      privateKey,
      market,
      syntheticId: resolvedSyntheticId,
      collateralId: resolvedCollateralId,
      side,
      qty,
      price,
      nonce: resolvedNonce,
      expiryEpochMillis: resolvedExpiry,
      fee: resolvedFee,
      collateralPosition,
      syntheticResolution: resolvedSyntheticRes,
      collateralResolution: resolvedCollateralRes,
      network,
    });
  } catch (err) {
    logger.error({ err, market, side, qty, price }, "[ExtendedApi] Failed to sign order");
    throw err;
  }

  const body: Record<string, unknown> = {
    id: resolvedExternalId,
    market,
    type: type.toUpperCase(),
    side: side.toUpperCase(),
    qty: qty,
    price: price,
    timeInForce: resolvedTif,
    expiryEpochMillis: resolvedExpiry,
    fee: resolvedFee,
    nonce: String(resolvedNonce),
    selfTradeProtectionLevel: "ACCOUNT",
    reduceOnly,
    postOnly,
    settlement: {
      signature: settlement.signature,
      starkKey: settlement.starkKey,
      collateralPosition: settlement.collateralPosition,
    },
  };

  if (cancelId) {
    body.cancelId = cancelId;
  }

  logger.info(
    { market, side, type, qty, price, externalId: resolvedExternalId, nonce: resolvedNonce, network },
    "[ExtendedApi] Placing order"
  );

  const result = await extendedAuthRequest<{ id: number; externalId: string }>(
    "POST",
    "/api/v1/user/order",
    apiKey,
    network,
    body
  );

  logger.info(
    { orderId: result.id, externalId: resolvedExternalId, market, side },
    "[ExtendedApi] Order accepted"
  );

  return { orderId: result.id, externalId: resolvedExternalId };
}

// ─── Order cancellation ───────────────────────────────────────────────────────

export async function cancelExtendedOrderById(
  apiKey: string,
  orderId: number | string,
  network: ExtendedNetwork = "mainnet"
): Promise<void> {
  logger.info({ orderId, network }, "[ExtendedApi] Cancelling order by ID");
  await extendedAuthRequest<null>(
    "DELETE",
    `/api/v1/user/order/${encodeURIComponent(String(orderId))}`,
    apiKey,
    network
  );
  logger.info({ orderId }, "[ExtendedApi] Cancel accepted");
}

export async function cancelExtendedOrderByExternalId(
  apiKey: string,
  externalId: string,
  network: ExtendedNetwork = "mainnet"
): Promise<void> {
  logger.info({ externalId, network }, "[ExtendedApi] Cancelling order by externalId");

  // Retry on network/timeout errors only — safe because cancel is idempotent
  // (cancelling an already-cancelled order returns an error but causes no harm).
  // Do NOT retry on 4xx: order-not-found and auth errors must surface immediately.
  const MAX_CANCEL_RETRIES = 3;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_CANCEL_RETRIES; attempt++) {
    try {
      await extendedAuthRequest<null>(
        "DELETE",
        `/api/v1/user/order?externalId=${encodeURIComponent(externalId)}`,
        apiKey,
        network
      );
      logger.info({ externalId }, "[ExtendedApi] Cancel accepted");
      return;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      // Don't retry on 4xx (order not found, not cancellable, unauthorized, etc.)
      if (/HTTP 4\d\d/.test(msg)) {
        logger.warn({ externalId, msg }, "[ExtendedApi] Cancel failed with client error — no retry");
        throw err;
      }
      if (attempt < MAX_CANCEL_RETRIES) {
        const delayMs = Math.pow(2, attempt - 1) * 1000; // 1s, 2s backoff
        logger.warn(
          { externalId, attempt, delayMs },
          "[ExtendedApi] Cancel failed with network error — retrying"
        );
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  logger.error({ externalId }, "[ExtendedApi] Cancel failed after all retries");
  throw lastErr;
}

export async function massCancelExtendedOrders(
  params: MassCancelParams
): Promise<void> {
  const { apiKey, markets, orderIds, externalOrderIds, cancelAll, network = "mainnet" } = params;

  if (!markets?.length && !orderIds?.length && !externalOrderIds?.length && !cancelAll) {
    throw new Error("[ExtendedApi] massCancelExtendedOrders: minimal satu parameter harus diisi");
  }

  const body: Record<string, unknown> = {};
  if (markets?.length) body.markets = markets;
  if (orderIds?.length) body.orderIds = orderIds;
  if (externalOrderIds?.length) body.externalOrderIds = externalOrderIds;
  if (cancelAll) body.cancelAll = true;

  logger.info({ body, network }, "[ExtendedApi] Mass cancelling orders");
  await extendedAuthRequest<null>("POST", "/api/v1/user/order/massCancel", apiKey, network, body);
  logger.info({ body }, "[ExtendedApi] Mass cancel accepted");
}

// ─── Trade History & Funding History (H-02) ──────────────────────────────────

export interface ExtendedUserTrade {
  id: string;
  accountId: number;
  market: string;
  orderId: string;
  externalId: string;
  side: "BUY" | "SELL";
  price: string;
  qty: string;
  value: string;
  fee: string;
  tradeType: string;
  createdTime: number;
  isTaker: boolean;
}

export interface ExtendedFundingPayment {
  id: number;
  accountId: number;
  market: string;
  positionId: string;
  side: "LONG" | "SHORT";
  size: string;
  value: string;
  markPrice: string;
  fundingFee: string;
  fundingRate: string;
  paidTime: number;
}

export interface ExtendedPositionHistory {
  id: string;
  accountId: number;
  market: string;
  side: "LONG" | "SHORT";
  /** Exit type: TRADE, LIQUIDATION, or DELEVERAGE */
  exitType?: string;
  size: string;
  maxPositionSize?: string;
  openPrice: string;
  /** Weighted average exit price (null for open positions) */
  exitPrice?: string;
  /** British spelling — field dari Extended API */
  realisedPnl: string;
  leverage: string;
  /** Epoch ms — kapan posisi dibuka */
  createdTime: number;
  /** Epoch ms — kapan posisi ditutup (null untuk posisi masih open) */
  closedTime?: number;
}

/**
 * GET /api/v1/user/trades — riwayat trade user.
 * Max 10.000 records per request. Filter opsional via params.
 */
export async function getExtendedUserTrades(
  apiKey: string,
  network: ExtendedNetwork = "mainnet",
  params?: {
    market?: string;
    type?: string;
    side?: string;
    cursor?: number;
    limit?: number;
  }
): Promise<ExtendedUserTrade[]> {
  const qs = new URLSearchParams();
  if (params?.market) qs.set("market", params.market);
  if (params?.type) qs.set("type", params.type);
  if (params?.side) qs.set("side", params.side);
  if (params?.cursor !== undefined) qs.set("cursor", String(params.cursor));
  if (params?.limit !== undefined) qs.set("limit", String(params.limit));
  const q = qs.toString();
  const path = `/api/v1/user/trades${q ? "?" + q : ""}`;
  return extendedFetch<ExtendedUserTrade[]>(path, network, { apiKey });
}

/**
 * GET /api/v1/user/funding-payments — riwayat funding payments.
 * `startTime` wajib (epoch ms). Max 10.000 records.
 */
export async function getExtendedFundingHistory(
  apiKey: string,
  network: ExtendedNetwork = "mainnet",
  params: {
    startTime: number;
    market?: string;
    side?: string;
    cursor?: number;
    limit?: number;
  }
): Promise<ExtendedFundingPayment[]> {
  const qs = new URLSearchParams();
  qs.set("startTime", String(params.startTime));
  if (params.market) qs.set("market", params.market);
  if (params.side) qs.set("side", params.side);
  if (params.cursor !== undefined) qs.set("cursor", String(params.cursor));
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  const path = `/api/v1/user/funding-payments?${qs.toString()}`;
  return extendedFetch<ExtendedFundingPayment[]>(path, network, { apiKey });
}

/**
 * GET /api/v1/user/positions/history — semua posisi (open + closed).
 * Max 10.000 records per request.
 */
export async function getExtendedPositionsHistory(
  apiKey: string,
  network: ExtendedNetwork = "mainnet",
  params?: {
    market?: string;
    side?: string;
    cursor?: number;
    limit?: number;
  }
): Promise<ExtendedPositionHistory[]> {
  const qs = new URLSearchParams();
  if (params?.market) qs.set("market", params.market);
  if (params?.side) qs.set("side", params.side);
  if (params?.cursor !== undefined) qs.set("cursor", String(params.cursor));
  if (params?.limit !== undefined) qs.set("limit", String(params.limit));
  const q = qs.toString();
  const path = `/api/v1/user/positions/history${q ? "?" + q : ""}`;
  return extendedFetch<ExtendedPositionHistory[]>(path, network, { apiKey });
}

// ─── Utilitas harga untuk market order ───────────────────────────────────────

/**
 * Hitung harga worst-case untuk MARKET order:
 * - BUY : bestAsk × 1.0075
 * - SELL: bestBid × 0.9925
 */
export function calcMarketOrderPrice(
  bestPrice: string,
  side: ExtendedOrderSide,
  priceDecimals: number
): string {
  const p = new Decimal(bestPrice);
  const multiplier = side === "BUY" ? new Decimal("1.0075") : new Decimal("0.9925");
  return p.mul(multiplier).toDecimalPlaces(priceDecimals, Decimal.ROUND_HALF_UP).toFixed(priceDecimals);
}
