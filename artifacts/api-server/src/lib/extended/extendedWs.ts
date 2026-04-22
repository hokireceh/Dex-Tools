import WebSocket from "ws";
import Decimal from "decimal.js";
import { logger } from "../logger";
import type { ExtendedNetwork } from "./extendedApi";
import type { ExtendedOrder, ExtendedPosition, ExtendedBalance } from "./extendedApi";

const WS_HOST = "wss://api.starknet.extended.exchange";

const WS_PATH = "/stream.extended.exchange/v1/orderbooks";

export type ExtendedPriceCallback = (midPrice: Decimal, market: string) => void;

// ─── Isolated state (zero shared state with Lighter) ─────────────────────────

// market string → { price, timestamp }
export const extendedWsPriceCache = new Map<string, { price: Decimal; ts: number }>();

// market string → Map<strategyId, callback>
const priceCallbacks = new Map<string, Map<number, ExtendedPriceCallback>>();

// market string → subscriber count
const marketRefCount = new Map<string, number>();

// market string → WebSocket instance (one connection per market)
const wsConnections = new Map<string, WebSocket>();

// market string → reconnect timer
const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

// market string → reconnect delay (ms)
const reconnectDelays = new Map<string, number>();

let currentNetwork: ExtendedNetwork = "mainnet";
let isDestroyed = false;

// ─── Konstanta activity/keepalive (mengikuti pola account WS) ─────────────────

const MARKET_WS_ACTIVITY_TIMEOUT_MS   = 90_000;  // sama dengan ACCOUNT_ACTIVITY_TIMEOUT_MS
const MARKET_WS_KEEPALIVE_INTERVAL_MS = 30_000;  // kirim ping setiap 30 detik

// ─── Internal helpers ─────────────────────────────────────────────────────────

function getWsUrl(market: string): string {
  return `${WS_HOST}${WS_PATH}/${encodeURIComponent(market)}?depth=1`;
}

function scheduleReconnect(market: string): void {
  if (reconnectTimers.has(market) || isDestroyed) return;
  const delay = reconnectDelays.get(market) ?? 2_000;
  reconnectDelays.set(market, Math.min(delay * 2, 30_000));
  logger.info({ market, delayMs: delay }, "[Extended WS] Scheduling reconnect");

  const timer = setTimeout(() => {
    reconnectTimers.delete(market);
    if (!isDestroyed && (marketRefCount.get(market) ?? 0) > 0) {
      connectMarket(market);
    }
  }, delay);
  reconnectTimers.set(market, timer);
}

function parseBestBidAsk(data: {
  m?: string;
  b?: Array<{ p: string; q: string }>;
  a?: Array<{ p: string; q: string }>;
}): Decimal | null {
  const bestBid = data.b?.[0]?.p;
  const bestAsk = data.a?.[0]?.p;
  if (!bestBid || !bestAsk) return null;

  const bid = parseFloat(bestBid);
  const ask = parseFloat(bestAsk);
  if (!bid || !ask || bid <= 0 || ask <= 0) return null;

  return new Decimal(bid).add(new Decimal(ask)).div(2);
}

function connectMarket(market: string): void {
  if (isDestroyed) return;

  const existing = wsConnections.get(market);
  if (existing && existing.readyState !== WebSocket.CLOSED && existing.readyState !== WebSocket.CLOSING) {
    return;
  }

  const url = getWsUrl(market);
  logger.info({ market, url }, "[Extended WS] Connecting");

  const ws = new WebSocket(url, {
    headers: { "User-Agent": "HokirecehProjects/1.0 ExtendedIntegration" },
  });
  wsConnections.set(market, ws);

  // ── Activity timeout + keepalive (mengikuti pola account WS) ────────────────
  let activityTimer: ReturnType<typeof setTimeout> | null = null;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  function resetActivityTimer() {
    if (activityTimer) clearTimeout(activityTimer);
    activityTimer = setTimeout(() => {
      logger.warn({ market }, `[Extended WS] No activity for 90s on ${market}, forcing reconnect`);
      ws.close(1001, "activity timeout");
    }, MARKET_WS_ACTIVITY_TIMEOUT_MS);
  }

  function clearTimers() {
    if (activityTimer) { clearTimeout(activityTimer); activityTimer = null; }
    if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
  }
  // ────────────────────────────────────────────────────────────────────────────

  ws.addEventListener("open", () => {
    logger.info({ market }, "[Extended WS] Connected");
    reconnectDelays.set(market, 2_000);
    resetActivityTimer();

    keepaliveTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "ping" }));
          logger.debug({ market }, "[Extended WS] Keepalive ping sent");
        } catch {
          // ignore send errors — close event will handle reconnect
        }
      }
    }, MARKET_WS_KEEPALIVE_INTERVAL_MS);
  });

  ws.addEventListener("message", (event: WebSocket.MessageEvent) => {
    resetActivityTimer();
    try {
      const msg = JSON.parse(event.data as string);

      // Server sends pings — respond with pong to stay alive
      // (Extended: server pings every 15s, expects pong within 10s)
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }

      // Only process orderbook snapshots for price extraction
      // type="SNAPSHOT" or type="DELTA" — both contain b/a arrays when depth=1
      const orderBookData = msg.data;
      if (!orderBookData) return;

      const midPrice = parseBestBidAsk(orderBookData);
      if (!midPrice) return;

      extendedWsPriceCache.set(market, { price: midPrice, ts: Date.now() });

      const callbacks = priceCallbacks.get(market);
      if (callbacks) {
        for (const cb of callbacks.values()) {
          try {
            cb(midPrice, market);
          } catch {
            // ignore callback errors
          }
        }
      }
    } catch {
      // ignore parse errors
    }
  });

  ws.addEventListener("close", () => {
    logger.warn({ market }, "[Extended WS] Disconnected");
    clearTimers();
    wsConnections.delete(market);
    scheduleReconnect(market);
  });

  ws.addEventListener("error", () => {
    logger.error({ market }, "[Extended WS] WebSocket error");
    // Do NOT call ws.close() here — error event is always followed by close event.
    // Reconnect is handled by the close handler above.
  });
}

function disconnectMarket(market: string): void {
  const timer = reconnectTimers.get(market);
  if (timer) {
    clearTimeout(timer);
    reconnectTimers.delete(market);
  }
  reconnectDelays.delete(market);

  const ws = wsConnections.get(market);
  if (ws) {
    ws.close();
    wsConnections.delete(market);
  }

  extendedWsPriceCache.delete(market);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function registerExtendedPriceCallback(
  market: string,
  strategyId: number,
  callback: ExtendedPriceCallback,
  network: ExtendedNetwork = "mainnet"
): void {
  isDestroyed = false;
  currentNetwork = network;

  if (!priceCallbacks.has(market)) {
    priceCallbacks.set(market, new Map());
  }
  priceCallbacks.get(market)!.set(strategyId, callback);

  const prev = marketRefCount.get(market) ?? 0;
  marketRefCount.set(market, prev + 1);

  if (prev === 0) {
    connectMarket(market);
  }
}

export function unregisterExtendedPriceCallback(market: string, strategyId: number): void {
  const callbacks = priceCallbacks.get(market);
  if (callbacks) {
    callbacks.delete(strategyId);
    if (callbacks.size === 0) priceCallbacks.delete(market);
  }

  const newCount = Math.max(0, (marketRefCount.get(market) ?? 0) - 1);
  if (newCount === 0) {
    marketRefCount.delete(market);
    disconnectMarket(market);
  } else {
    marketRefCount.set(market, newCount);
  }
}

export function getExtendedWsCachedPrice(market: string, maxAgeMs = 5_000): Decimal | null {
  const entry = extendedWsPriceCache.get(market);
  if (!entry) return null;
  if (Date.now() - entry.ts > maxAgeMs) return null;
  return entry.price;
}

export function destroyExtendedWs(): void {
  isDestroyed = true;
  for (const market of Array.from(wsConnections.keys())) {
    disconnectMarket(market);
  }
  priceCallbacks.clear();
  marketRefCount.clear();
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACCOUNT WebSocket (merged from extendedAccountWs.ts)
// Stream private akun: ORDER, TRADE, BALANCE, POSITION events.
// WS_HOST sama dengan market WS — menggunakan konstanta yang sudah ada di atas.
// ═══════════════════════════════════════════════════════════════════════════════

const ACCOUNT_WS_PATH = "/stream.extended.exchange/v1/account";

// ─── Tipe event dari server ───────────────────────────────────────────────────

export interface ExtendedTrade {
  id: number;
  accountId: number;
  market: string;
  orderId: number;
  externalId?: string;
  side: "BUY" | "SELL";
  price: string;
  qty: string;
  value: string;
  fee: string;
  tradeType: "TRADE" | "LIQUIDATION" | "DELEVERAGE";
  createdTime: number;
  isTaker: boolean;
}

export type ExtendedAccountEventType = "ORDER" | "TRADE" | "BALANCE" | "POSITION" | "SNAPSHOT";

export interface ExtendedOrderEvent {
  type: "ORDER";
  data: { orders: ExtendedOrder[] };
  ts: number;
  seq: number;
}

export interface ExtendedTradeEvent {
  type: "TRADE";
  data: { trades: ExtendedTrade[] };
  ts: number;
  seq: number;
}

export interface ExtendedBalanceEvent {
  type: "BALANCE";
  data: { balance: ExtendedBalance };
  ts: number;
  seq: number;
}

export interface ExtendedPositionEvent {
  type: "POSITION";
  data: { positions: ExtendedPosition[] };
  ts: number;
  seq: number;
}

export type ExtendedAccountEvent =
  | ExtendedOrderEvent
  | ExtendedTradeEvent
  | ExtendedBalanceEvent
  | ExtendedPositionEvent;

// ─── Callback types ───────────────────────────────────────────────────────────

export type OnOrderUpdate = (orders: ExtendedOrder[]) => void;
export type OnTradeUpdate = (trades: ExtendedTrade[]) => void;
export type OnBalanceUpdate = (balance: ExtendedBalance) => void;
export type OnPositionUpdate = (positions: ExtendedPosition[]) => void;
export type OnConnected = () => void;
export type OnDisconnected = () => void;
export type OnError = (err: Error) => void;

export interface ExtendedAccountWsCallbacks {
  onOrder?: OnOrderUpdate;
  onTrade?: OnTradeUpdate;
  onBalance?: OnBalanceUpdate;
  onPosition?: OnPositionUpdate;
  onConnected?: OnConnected;
  onDisconnected?: OnDisconnected;
  onError?: OnError;
}

// ─── Instance state ───────────────────────────────────────────────────────────

interface AccountWsInstance {
  ws: WebSocket | null;
  apiKey: string;
  network: ExtendedNetwork;
  callbacks: ExtendedAccountWsCallbacks;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectDelay: number;
  lastSeq: number;
  destroyed: boolean;
  pingTimer: ReturnType<typeof setInterval> | null;
}

const ACCOUNT_INITIAL_RECONNECT_MS = 2_000;
const ACCOUNT_MAX_RECONNECT_MS = 30_000;
const ACCOUNT_PONG_TIMEOUT_MS = 20_000;
const ACCOUNT_PING_INTERVAL_MS = 30_000;
const ACCOUNT_ACTIVITY_TIMEOUT_MS = 90_000;

// Satu koneksi per apiKey@network
const accountWsInstances = new Map<string, AccountWsInstance>();

// ─── Internal helpers ─────────────────────────────────────────────────────────

function getAccountWsUrl(): string {
  return `${WS_HOST}${ACCOUNT_WS_PATH}`;
}

function clearAccountPingTimer(inst: AccountWsInstance): void {
  if (inst.pingTimer) {
    clearInterval(inst.pingTimer);
    inst.pingTimer = null;
  }
}

function clearAccountReconnectTimer(inst: AccountWsInstance): void {
  if (inst.reconnectTimer) {
    clearTimeout(inst.reconnectTimer);
    inst.reconnectTimer = null;
  }
}

function scheduleAccountReconnect(inst: AccountWsInstance, instanceKey: string): void {
  if (inst.destroyed || inst.reconnectTimer) return;

  const delay = inst.reconnectDelay;
  inst.reconnectDelay = Math.min(delay * 2, ACCOUNT_MAX_RECONNECT_MS);

  logger.info({ instanceKey, delayMs: delay }, "[ExtendedAccountWs] Reconnecting...");

  inst.reconnectTimer = setTimeout(() => {
    inst.reconnectTimer = null;
    if (!inst.destroyed) {
      connectAccountInstance(inst, instanceKey);
    }
  }, delay);
}

function dispatchAccountEvent(inst: AccountWsInstance, event: ExtendedAccountEvent): void {
  try {
    switch (event.type) {
      case "ORDER":
        inst.callbacks.onOrder?.(event.data.orders);
        break;
      case "TRADE":
        inst.callbacks.onTrade?.(event.data.trades);
        break;
      case "BALANCE":
        inst.callbacks.onBalance?.(event.data.balance);
        break;
      case "POSITION":
        inst.callbacks.onPosition?.(event.data.positions);
        break;
    }
  } catch (err) {
    logger.warn({ err }, "[ExtendedAccountWs] Error in user callback");
  }
}

function connectAccountInstance(inst: AccountWsInstance, instanceKey: string): void {
  if (inst.destroyed) return;

  const existing = inst.ws;
  if (
    existing &&
    existing.readyState !== WebSocket.CLOSED &&
    existing.readyState !== WebSocket.CLOSING
  ) {
    return;
  }

  const url = getAccountWsUrl();
  logger.info({ instanceKey, url }, "[ExtendedAccountWs] Connecting");

  const ws = new WebSocket(url, {
    headers: {
      "X-Api-Key": inst.apiKey,
      "User-Agent": "HokirecehProjects/1.0 ExtendedIntegration",
    },
  });

  inst.ws = ws;
  inst.lastSeq = 0;

  let pongTimer: ReturnType<typeof setTimeout> | null = null;
  let activityTimer: ReturnType<typeof setTimeout> | null = null;

  function resetActivityTimer() {
    if (activityTimer) clearTimeout(activityTimer);
    activityTimer = setTimeout(() => {
      logger.warn({ instanceKey }, "[ExtendedAccountWs] Activity timeout — closing");
      ws.close(1001, "activity timeout");
    }, ACCOUNT_ACTIVITY_TIMEOUT_MS);
  }

  ws.addEventListener("open", () => {
    logger.info({ instanceKey }, "[ExtendedAccountWs] Connected");
    inst.reconnectDelay = ACCOUNT_INITIAL_RECONNECT_MS;
    resetActivityTimer();

    try { inst.callbacks.onConnected?.(); } catch {}

    clearAccountPingTimer(inst);
    inst.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try { (ws as any).ping?.(); } catch {}

        if (pongTimer) clearTimeout(pongTimer);
        pongTimer = setTimeout(() => {
          logger.warn({ instanceKey }, "[ExtendedAccountWs] Pong timeout — closing");
          ws.close(1001, "pong timeout");
        }, ACCOUNT_PONG_TIMEOUT_MS);
      }
    }, ACCOUNT_PING_INTERVAL_MS);
  });

  (ws as any).on?.("pong", () => {
    if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
    resetActivityTimer();
  });

  (ws as any).on?.("ping", () => {
    if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
    resetActivityTimer();
  });

  ws.addEventListener("message", (event: WebSocket.MessageEvent) => {
    resetActivityTimer();
    if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }

    let msg: any;
    try {
      msg = JSON.parse(event.data as string);
    } catch {
      return;
    }

    if (msg.type === "ping") {
      try { ws.send(JSON.stringify({ type: "pong" })); } catch {}
      return;
    }

    if (msg.type === "pong") return;

    if (typeof msg.seq === "number") {
      if (inst.lastSeq > 0 && msg.seq !== inst.lastSeq + 1) {
        logger.warn(
          { instanceKey, expected: inst.lastSeq + 1, got: msg.seq },
          "[ExtendedAccountWs] Out-of-order seq — reconnecting"
        );
        ws.close(1001, "out-of-order seq");
        return;
      }
      inst.lastSeq = msg.seq;
    }

    const eventType = msg.type as ExtendedAccountEventType;
    if (["ORDER", "TRADE", "BALANCE", "POSITION"].includes(eventType)) {
      dispatchAccountEvent(inst, msg as ExtendedAccountEvent);
    } else if (eventType === "SNAPSHOT") {
      if (msg.data?.orders) inst.callbacks.onOrder?.(msg.data.orders);
      if (msg.data?.balance) inst.callbacks.onBalance?.(msg.data.balance);
      if (msg.data?.positions) inst.callbacks.onPosition?.(msg.data.positions);
      logger.info({ instanceKey }, "[ExtendedAccountWs] SNAPSHOT received — state synced");
    } else {
      logger.debug({ instanceKey, type: eventType }, "[ExtendedAccountWs] Unknown event type");
    }
  });

  ws.addEventListener("close", (event: WebSocket.CloseEvent) => {
    logger.warn(
      { instanceKey, code: event.code, reason: event.reason },
      "[ExtendedAccountWs] Disconnected"
    );
    clearAccountPingTimer(inst);
    if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
    if (activityTimer) { clearTimeout(activityTimer); activityTimer = null; }
    inst.ws = null;

    try { inst.callbacks.onDisconnected?.(); } catch {}

    scheduleAccountReconnect(inst, instanceKey);
  });

  ws.addEventListener("error", () => {
    logger.error({ instanceKey }, "[ExtendedAccountWs] WebSocket error");
    try { inst.callbacks.onError?.(new Error("WebSocket error on account stream")); } catch {}
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function connectExtendedAccountWs(opts: {
  apiKey: string;
  network?: ExtendedNetwork;
  callbacks: ExtendedAccountWsCallbacks;
}): string {
  const { apiKey, network = "mainnet", callbacks } = opts;
  const instanceKey = `${apiKey}@${network}`;

  const existing = accountWsInstances.get(instanceKey);
  if (existing && !existing.destroyed) {
    existing.callbacks = callbacks;
    logger.debug({ instanceKey }, "[ExtendedAccountWs] Updated callbacks on existing connection");
    return instanceKey;
  }

  const inst: AccountWsInstance = {
    ws: null,
    apiKey,
    network,
    callbacks,
    reconnectTimer: null,
    reconnectDelay: ACCOUNT_INITIAL_RECONNECT_MS,
    lastSeq: 0,
    destroyed: false,
    pingTimer: null,
  };

  accountWsInstances.set(instanceKey, inst);
  connectAccountInstance(inst, instanceKey);

  return instanceKey;
}

export function disconnectExtendedAccountWs(instanceKey: string): void {
  const inst = accountWsInstances.get(instanceKey);
  if (!inst) return;

  inst.destroyed = true;
  clearAccountPingTimer(inst);
  clearAccountReconnectTimer(inst);

  if (inst.ws) {
    inst.ws.close(1000, "client disconnect");
    inst.ws = null;
  }

  accountWsInstances.delete(instanceKey);
  logger.info({ instanceKey }, "[ExtendedAccountWs] Disconnected (destroyed)");
}

export function destroyAllExtendedAccountWs(): void {
  for (const key of Array.from(accountWsInstances.keys())) {
    disconnectExtendedAccountWs(key);
  }
}

export function isExtendedAccountWsConnected(instanceKey: string): boolean {
  const inst = accountWsInstances.get(instanceKey);
  if (!inst || inst.destroyed) return false;
  return inst.ws !== null && inst.ws.readyState === WebSocket.OPEN;
}
