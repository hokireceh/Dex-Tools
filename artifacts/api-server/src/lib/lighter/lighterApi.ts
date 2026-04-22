import Decimal from "decimal.js";
import { logger } from "../logger";

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

export const BASE_URLS = {
  mainnet: "https://mainnet.zklighter.elliot.ai",
};

export type Network = "mainnet";

export function getBaseUrl(network: Network = "mainnet"): string {
  return BASE_URLS[network];
}

const LIGHTER_FETCH_TIMEOUT_MS = 15_000;
const LIGHTER_MAX_RETRIES = 3;

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function lighterFetch<T>(path: string, network: Network = "mainnet", options?: RequestInit): Promise<T> {
  const url = `${getBaseUrl(network)}${path}`;

  for (let attempt = 0; attempt < LIGHTER_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LIGHTER_FETCH_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          accept: "application/json",
          // Content-Type hanya dikirim saat ada body (POST/PUT/PATCH) — tidak relevan di GET
          ...(options?.body ? { "content-type": "application/json" } : {}),
          ...options?.headers,
        },
      });
    } catch (err: any) {
      clearTimeout(timer);
      if (err.name === "AbortError") throw new Error(`Lighter API timeout after ${LIGHTER_FETCH_TIMEOUT_MS}ms: ${path}`);
      throw err;
    }
    clearTimeout(timer);

    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : 2000 * Math.pow(2, attempt);
      logger.warn({ path, attempt, waitMs }, "Lighter API rate limited (429), retrying...");
      if (attempt < LIGHTER_MAX_RETRIES - 1) {
        await sleep(waitMs);
        continue;
      }
      throw new Error(`Lighter API rate limited (429) after ${LIGHTER_MAX_RETRIES} attempts: ${path}`);
    }

    if (res.status >= 500) {
      if (attempt < LIGHTER_MAX_RETRIES - 1) {
        const waitMs = 1000 * (attempt + 1);
        logger.warn({ path, attempt, status: res.status, waitMs }, "Lighter API 5xx — retrying...");
        await sleep(waitMs);
        continue;
      }
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Lighter API error ${res.status}: ${text}`);
    }

    return res.json() as T;
  }

  throw new Error(`Lighter API: max retries exceeded for ${path}`);
}

export interface LighterOrderBook {
  market_id: number;
  order_book_type: string;
  base_asset_symbol: string;
  quote_asset_symbol: string;
  pair_symbol: string;
  supported_size_decimals: number;
  supported_price_decimals: number;
  supported_quote_decimals: number;
  min_base_amount: string;
  min_quote_amount: string;
  exchange_type: string;
  last_trade_price?: number;
  daily_price_change?: number;
  daily_base_token_volume?: number;
  daily_quote_token_volume?: number;
  daily_price_high?: number;
  daily_price_low?: number;
  created_at?: string;
  open_interest?: number;
  max_leverage?: number;
}

export interface LighterOrderBooksResponse {
  order_books: LighterOrderBook[];
}

interface LighterOrderBookDetailV2 {
  symbol: string;
  market_id: number;
  market_type: string;
  min_base_amount: string;
  min_quote_amount: string;
  supported_size_decimals: number;
  supported_price_decimals: number;
  supported_quote_decimals: number;
  last_trade_price: number;
  daily_price_change: number;
  daily_base_token_volume: number;
  daily_quote_token_volume: number;
  daily_price_high: number;
  daily_price_low: number;
  created_at?: string;
  open_interest?: number;
  min_initial_margin_fraction?: number;
}

interface LighterOrderBooksResponseV2 {
  code?: number;
  order_book_details?: LighterOrderBookDetailV2[];
  spot_order_book_details?: LighterOrderBookDetailV2[];
}

function mapV2ToOrderBook(ob: LighterOrderBookDetailV2): LighterOrderBook {
  const isSpot = ob.market_type === "spot";
  let pairSymbol: string;
  let baseAsset: string;
  let quoteAsset: string;

  if (isSpot) {
    const parts = ob.symbol.split("/");
    baseAsset = parts[0] ?? ob.symbol;
    quoteAsset = parts[1] ?? "USDC";
    pairSymbol = `${baseAsset}-${quoteAsset}`;
  } else {
    baseAsset = ob.symbol;
    quoteAsset = "USDC";
    pairSymbol = `${ob.symbol}-USDC`;
  }

  return {
    market_id: ob.market_id,
    order_book_type: ob.market_type,
    base_asset_symbol: baseAsset,
    quote_asset_symbol: quoteAsset,
    pair_symbol: pairSymbol,
    supported_size_decimals: ob.supported_size_decimals ?? 4,
    supported_price_decimals: ob.supported_price_decimals ?? 2,
    supported_quote_decimals: ob.supported_quote_decimals ?? 6,
    min_base_amount: ob.min_base_amount ?? "0",
    min_quote_amount: ob.min_quote_amount ?? "0",
    exchange_type: ob.market_type,
    last_trade_price: ob.last_trade_price ?? 0,
    daily_price_change: ob.daily_price_change ?? 0,
    daily_base_token_volume: ob.daily_base_token_volume ?? 0,
    daily_quote_token_volume: ob.daily_quote_token_volume ?? 0,
    daily_price_high: ob.daily_price_high ?? 0,
    daily_price_low: ob.daily_price_low ?? 0,
    created_at: ob.created_at,
    open_interest: ob.open_interest ?? undefined,
    max_leverage: (ob.min_initial_margin_fraction && ob.min_initial_margin_fraction > 0) ? Math.round(10000 / ob.min_initial_margin_fraction) : undefined,
  };
}

export async function getOrderBooks(network: Network = "mainnet"): Promise<LighterOrderBooksResponse> {
  try {
    const raw = await lighterFetch<LighterOrderBooksResponseV2>("/api/v1/orderBookDetails", network);
    const perp = (raw.order_book_details ?? []).map(mapV2ToOrderBook);
    const spot = (raw.spot_order_book_details ?? []).map(mapV2ToOrderBook);
    return { order_books: [...perp, ...spot] };
  } catch (err) {
    logger.error({ err }, "Failed to fetch order books");
    throw err;
  }
}

export interface LighterCandleData {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
}

export interface LighterCandlesResponse {
  code?: number;
  r?: string;
  // Official API response key is "c" (array of candles), NOT "candles"
  // See: /api/v1/candles → Candles schema → field "c"
  c?: LighterCandleData[];
}

// Resolution enum values accepted by the Lighter API
export type CandleResolution = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "12h" | "1d" | "1w";

// Map resolution string to minutes (for start_timestamp calculation)
const RESOLUTION_MINUTES: Record<CandleResolution, number> = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "4h": 240,
  "12h": 720,
  "1d": 1440,
  "1w": 10080,
};

export async function getCandles(
  marketId: number,
  resolution: CandleResolution = "1h",
  countBack: number = 100,
  network: Network = "mainnet"
): Promise<LighterCandlesResponse> {
  try {
    const endTs = Date.now(); // milliseconds
    const startTs = endTs - countBack * RESOLUTION_MINUTES[resolution] * 60 * 1000;
    return await lighterFetch<LighterCandlesResponse>(
      `/api/v1/candles?market_id=${marketId}&resolution=${resolution}&start_timestamp=${startTs}&end_timestamp=${endTs}&count_back=${countBack}`,
      network
    );
  } catch (err) {
    logger.error({ err, marketId }, "Failed to fetch candles");
    return {};
  }
}

export interface LighterOrderBookEntry {
  price: string;
  size: string;
}

export interface LighterOrderBookResponse {
  bids: LighterOrderBookEntry[];
  asks: LighterOrderBookEntry[];
}

// Raw response from /api/v1/orderBookOrders — verified 2026-03-31 against live API.
// bids/asks are at ROOT level (not nested under order_book).
// Each entry uses remaining_base_amount (not size) as the quantity field.
interface LighterSimpleOrder {
  price: string;
  remaining_base_amount: string;
}

interface LighterOrderBookOrdersRaw {
  code?: number;
  total_bids?: number;
  total_asks?: number;
  bids?: LighterSimpleOrder[];
  asks?: LighterSimpleOrder[];
}

export async function getOrderBookDepth(marketId: number, network: Network = "mainnet"): Promise<LighterOrderBookResponse> {
  try {
    const raw = await lighterFetch<LighterOrderBookOrdersRaw>(
      `/api/v1/orderBookOrders?market_id=${marketId}&limit=20`,
      network
    );
    return {
      bids: (raw.bids ?? []).map((e) => ({ price: e.price, size: e.remaining_base_amount })),
      asks: (raw.asks ?? []).map((e) => ({ price: e.price, size: e.remaining_base_amount })),
    };
  } catch (err) {
    logger.error({ err, marketId }, "Failed to fetch order book depth");
    return { bids: [], asks: [] };
  }
}

// ─── Funding Rates ───────────────────────────────────────────────────────────
// Source: GET /api/v1/funding-rates
// Docs: docs/lighter-docs/reference/funding-rates.md
// Response includes rates from multiple exchanges: lighter, binance, bybit, hyperliquid.
// The "lighter" entry rate = fundingRate per 8h (formula: clamp(premium)/8).
// Funding is settled every hour, so effective per-hour cost = rate / 8.

export interface LighterFundingRate {
  market_id: number;
  exchange: "binance" | "bybit" | "hyperliquid" | "lighter";
  symbol: string;
  rate: number;
}

export interface LighterFundingRatesResponse {
  code: number;
  message?: string;
  funding_rates: LighterFundingRate[];
}

export async function getFundingRates(network: Network = "mainnet"): Promise<LighterFundingRatesResponse> {
  return await lighterFetch<LighterFundingRatesResponse>("/api/v1/funding-rates", network);
}

export interface LighterPosition {
  market_id: number;
  market_index?: number;
  symbol?: string;
  sign?: number;
  position?: string;
  position_value?: string;
  avg_entry_price: string;
  unrealized_pnl?: string;
  realized_pnl?: string;
  liquidation_price?: string;
  allocated_margin?: string;
  initial_margin_fraction?: string;
  open_order_count?: number;
  pending_order_count?: number;
}

export interface LighterAccountEntry {
  code?: number;
  account_type?: number;
  index: number;
  account_index?: number;
  l1_address: string;
  available_balance: string;
  collateral?: string;
  total_asset_value?: string;
  cross_asset_value?: string;
  positions: LighterPosition[];
  assets?: unknown[];
  status?: number;
}

export interface LighterAccountResponse {
  code?: number;
  total?: number;
  accounts: LighterAccountEntry[];
}

export async function getAccountByIndex(
  accountIndex: number,
  network: Network = "mainnet"
): Promise<LighterAccountResponse | null> {
  try {
    return await lighterFetch<LighterAccountResponse>(
      `/api/v1/account?by=index&value=${accountIndex}`,
      network
    );
  } catch (err) {
    logger.error({ err, accountIndex }, "Failed to fetch account by index");
    return null;
  }
}

export async function getAccountByL1Address(
  l1Address: string,
  network: Network = "mainnet"
): Promise<LighterAccountResponse | null> {
  try {
    return await lighterFetch<LighterAccountResponse>(
      `/api/v1/account?by=l1_address&value=${l1Address}`,
      network
    );
  } catch (err) {
    logger.error({ err, l1Address }, "Failed to fetch account by L1 address");
    return null;
  }
}

export interface LighterNextNonceResponse {
  nonce: number;
}

export async function getNextNonce(
  accountIndex: number,
  apiKeyIndex: number,
  network: Network = "mainnet"
): Promise<number> {
  const res = await lighterFetch<LighterNextNonceResponse>(
    `/api/v1/nextNonce?account_index=${accountIndex}&api_key_index=${apiKeyIndex}`,
    network
  );
  return res.nonce;
}

export interface SendTxResponse {
  code?: number;
  message?: string;
  error?: string;
  tx_hash?: string;   // Lighter-indexed tx hash — LEBIH AKURAT dari signer txHash
  predicted_execution_time_ms?: number;
  volume_quota_remaining?: number;
}

export async function sendTx(
  txType: number,
  txInfo: string,
  network: Network = "mainnet",
  priceProtection: boolean = true
): Promise<SendTxResponse> {
  const url = `${getBaseUrl(network)}/api/v1/sendTx`;
  const body = new URLSearchParams();
  body.set("tx_type", String(txType));
  body.set("tx_info", txInfo);
  body.set("price_protection", priceProtection ? "true" : "false");

  for (let attempt = 0; attempt < LIGHTER_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LIGHTER_FETCH_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });
    } catch (err: any) {
      clearTimeout(timer);
      if (err.name === "AbortError") throw new Error(`sendTx timeout after ${LIGHTER_FETCH_TIMEOUT_MS}ms`);
      throw err;
    }
    clearTimeout(timer);

    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : 2000 * Math.pow(2, attempt);
      logger.warn({ attempt, waitMs }, "sendTx rate limited (429), retrying...");
      if (attempt < LIGHTER_MAX_RETRIES - 1) {
        await sleep(waitMs);
        continue;
      }
      throw new Error(`sendTx rate limited (429) after ${LIGHTER_MAX_RETRIES} attempts`);
    }

    if (res.status === 502 || res.status === 503) {
      if (attempt < LIGHTER_MAX_RETRIES - 1) {
        const waitMs = 1000 * (attempt + 1);
        logger.warn({ attempt, status: res.status, waitMs }, "sendTx gateway error — retrying...");
        await sleep(waitMs);
        continue;
      }
    }

    let data: SendTxResponse = {};
    try {
      data = await res.json() as SendTxResponse;
    } catch {
      data = { message: await res.text() };
    }

    if (!res.ok) {
      throw new Error(
        `sendTx failed (HTTP ${res.status}): ${data.error ?? data.message ?? JSON.stringify(data)}`
      );
    }

    if (data.code !== undefined && data.code !== 200 && data.code !== 0) {
      throw new Error(
        `sendTx rejected by sequencer (code ${data.code}): ${data.error ?? data.message ?? JSON.stringify(data)}`
      );
    }

    return data;
  }

  throw new Error("sendTx: max retries exceeded");
}

export function toBaseAmount(sizeInBase: number, sizeDecimals: number): number {
  return new Decimal(sizeInBase)
    .mul(new Decimal(10).pow(sizeDecimals))
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .toNumber();
}

export function toPriceInt(priceInUsdc: number, priceDecimals: number): number {
  return new Decimal(priceInUsdc)
    .mul(new Decimal(10).pow(priceDecimals))
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .toNumber();
}

export interface SendTxBatchResponse {
  code?: number;
  message?: string;
  error?: string;
  tx_hash?: string[];
  predicted_execution_time_ms?: number;
  volume_quota_remaining?: number;
}

export async function sendTxBatch(
  transactions: Array<{ txType: number; txInfo: string }>,
  network: Network = "mainnet"
): Promise<SendTxBatchResponse> {
  // NOTE: ReqSendTxBatch schema only accepts "tx_types" and "tx_infos".
  // "price_protection" is NOT part of the batch schema (unlike single sendTx).
  // tx_infos are JSON strings (e.g. {"...": ...}) so they CANNOT be comma-joined —
  // the server would misparse them. Python SDK uses json.dumps() for both fields:
  //   tx_types = json.dumps([14, 14])      → "[14,14]"
  //   tx_infos = json.dumps(["{...}", "..."]) → JSON array of JSON strings
  const url = `${getBaseUrl(network)}/api/v1/sendTxBatch`;
  const body = new URLSearchParams();
  body.set("tx_types", JSON.stringify(transactions.map((t) => t.txType)));
  body.set("tx_infos", JSON.stringify(transactions.map((t) => t.txInfo)));

  for (let attempt = 0; attempt < LIGHTER_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LIGHTER_FETCH_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });
    } catch (err: any) {
      clearTimeout(timer);
      if (err.name === "AbortError") throw new Error(`sendTxBatch timeout after ${LIGHTER_FETCH_TIMEOUT_MS}ms`);
      throw err;
    }
    clearTimeout(timer);

    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : 2000 * Math.pow(2, attempt);
      logger.warn({ attempt, waitMs }, "sendTxBatch rate limited (429), retrying...");
      if (attempt < LIGHTER_MAX_RETRIES - 1) { await sleep(waitMs); continue; }
      throw new Error(`sendTxBatch rate limited (429) after ${LIGHTER_MAX_RETRIES} attempts`);
    }

    if (res.status === 502 || res.status === 503) {
      if (attempt < LIGHTER_MAX_RETRIES - 1) {
        const waitMs = 1000 * (attempt + 1);
        logger.warn({ attempt, status: res.status, waitMs }, "sendTxBatch gateway error — retrying...");
        await sleep(waitMs);
        continue;
      }
    }

    let data: SendTxBatchResponse = {};
    try { data = await res.json() as SendTxBatchResponse; } catch { data = { message: await res.text() }; }

    if (!res.ok) {
      throw new Error(`sendTxBatch failed (HTTP ${res.status}): ${data.error ?? data.message ?? JSON.stringify(data)}`);
    }

    // Mirror the same sequencer-rejection check as sendTx.
    // Lighter can return HTTP 200 with a non-200 body code when the sequencer
    // rejects all transactions (e.g. code=21508 insufficient margin, code=21601 order book full).
    // Without this check the caller would silently record all orders as "pending"
    // and only discover the failure after the 10-minute poll timeout.
    if (data.code !== undefined && data.code !== 200 && data.code !== 0) {
      throw new Error(
        `sendTxBatch rejected by sequencer (code ${data.code}): ${data.error ?? data.message ?? JSON.stringify(data)}`
      );
    }

    return data;
  }

  throw new Error("sendTxBatch: max retries exceeded");
}

// EnrichedTx — response dari GET /api/v1/tx dan /api/v1/txFromL1TxHash
// Data FLAT di root level, bukan nested di dalam key "transaction"
export interface LighterTxResponse {
  code?: number;
  message?: string;
  hash?: string;
  type?: number;
  info?: string;
  event_info?: string;
  status?: number;
  transaction_index?: number;
  l1_address?: string;
  account_index?: number;
  nonce?: number;
  expire_at?: number;
  block_height?: number;
  queued_at?: number;
  executed_at?: number;
  sequence_index?: number;
  parent_hash?: string;
  api_key_index?: number;
  transaction_time?: number;
  committed_at?: number;
  verified_at?: number;
}

export async function getTx(
  by: "hash" | "sequence_index",
  value: string,
  network: Network = "mainnet"
): Promise<LighterTxResponse | null> {
  try {
    return await lighterFetch<LighterTxResponse>(
      `/api/v1/tx?by=${by}&value=${encodeURIComponent(value)}`,
      network
    );
  } catch (err) {
    // code 21500 = "transaction not found" — Lighter hasn't indexed the tx yet.
    // This is a normal transient condition during order confirmation polling;
    // the bot will retry on the next poll cycle. Use warn, not error.
    const msg = err instanceof Error ? err.message : String(err);
    const isNotFound = msg.includes("21500") || msg.includes("transaction not found");
    if (isNotFound) {
      logger.warn({ by, value, network }, "Tx not yet indexed by Lighter (code 21500) — will retry");
    } else {
      logger.error({ err, by, value }, "Failed to fetch transaction");
    }
    return null;
  }
}

export async function getTxFromL1TxHash(
  hash: string,
  network: Network = "mainnet"
): Promise<LighterTxResponse | null> {
  try {
    return await lighterFetch<LighterTxResponse>(
      `/api/v1/txFromL1TxHash?hash=${encodeURIComponent(hash)}`,
      network
    );
  } catch (err) {
    logger.error({ err, hash }, "Failed to fetch transaction from L1 hash");
    return null;
  }
}

export interface LighterHistoryEntry {
  [key: string]: unknown;
}

export interface LighterHistoryResponse {
  code?: number;
  cursor?: string;
  entries?: LighterHistoryEntry[];
  total?: number;
}

export async function getDepositHistory(params: {
  accountIndex: number;
  l1Address: string;
  authorization: string;
  cursor?: string;
  filter?: "all" | "pending" | "claimable";
  network?: Network;
}): Promise<LighterHistoryResponse | null> {
  const { accountIndex, l1Address, authorization, cursor, filter, network = "mainnet" } = params;
  const qs = new URLSearchParams({
    account_index: String(accountIndex),
    l1_address: l1Address,
    ...(cursor ? { cursor } : {}),
    ...(filter ? { filter } : {}),
  });
  try {
    return await lighterFetch<LighterHistoryResponse>(
      `/api/v1/deposit/history?${qs.toString()}`,
      network,
      { headers: { Authorization: authorization } }
    );
  } catch (err) {
    logger.error({ err, accountIndex }, "Failed to fetch deposit history");
    return null;
  }
}

export async function getTransferHistory(params: {
  accountIndex: number;
  authorization?: string;
  cursor?: string;
  type?: string[];
  network?: Network;
}): Promise<LighterHistoryResponse | null> {
  const { accountIndex, authorization, cursor, type, network = "mainnet" } = params;
  const qs = new URLSearchParams({
    account_index: String(accountIndex),
    ...(authorization ? { authorization } : {}),
    ...(cursor ? { cursor } : {}),
  });
  if (type && type.length > 0) {
    type.forEach((t) => qs.append("type", t));
  }
  try {
    return await lighterFetch<LighterHistoryResponse>(
      `/api/v1/transfer/history?${qs.toString()}`,
      network
    );
  } catch (err) {
    logger.error({ err, accountIndex }, "Failed to fetch transfer history");
    return null;
  }
}

export async function getWithdrawHistory(params: {
  accountIndex: number;
  authorization: string;
  cursor?: string;
  filter?: "all" | "pending" | "claimable";
  network?: Network;
}): Promise<LighterHistoryResponse | null> {
  const { accountIndex, authorization, cursor, filter, network = "mainnet" } = params;
  const qs = new URLSearchParams({
    account_index: String(accountIndex),
    ...(cursor ? { cursor } : {}),
    ...(filter ? { filter } : {}),
  });
  try {
    return await lighterFetch<LighterHistoryResponse>(
      `/api/v1/withdraw/history?${qs.toString()}`,
      network,
      { headers: { Authorization: authorization } }
    );
  } catch (err) {
    logger.error({ err, accountIndex }, "Failed to fetch withdraw history");
    return null;
  }
}

// ── Account Active Orders (read-only token required) ─────────────────────────

export interface LighterActiveOrder {
  order_index: number;
  client_order_index: number;
  order_id: string;
  client_order_id: string;
  market_index: number;
  price: string;
  // BUG-ORPHAN-SIDE-ROOT-001: Field `side` deprecated oleh Lighter API
  // (docs: "TODO: remove this") — Lighter sudah tidak mengisi field ini → selalu "".
  // Field canonical yang benar adalah `is_ask: boolean` (true=sell/ask, false=buy/bid).
  // Gunakan is_ask untuk menentukan arah order; side hanya sebagai legacy fallback.
  is_ask: boolean;
  side: string;
  status: string;
  time_in_force: string;
  initial_base_amount: string;
  remaining_base_amount: string;
  filled_base_amount: string;
  order_expiry: number;
  created_at: number;
}

interface LighterActiveOrdersResponse {
  code: number;
  message?: string;
  next_cursor?: string;
  orders: LighterActiveOrder[];
}

export async function fetchAccountActiveOrders(
  accountIndex: number,
  readonlyToken: string,
  marketId?: number,
  network: Network = "mainnet"
): Promise<LighterActiveOrder[]> {
  const qs = new URLSearchParams({ account_index: String(accountIndex) });
  if (marketId !== undefined) {
    qs.set("market_id", String(marketId));
  }
  const data = await lighterFetch<LighterActiveOrdersResponse>(
    `/api/v1/accountActiveOrders?${qs.toString()}`,
    network,
    { headers: { authorization: readonlyToken } }
  );
  return data.orders ?? [];
}
