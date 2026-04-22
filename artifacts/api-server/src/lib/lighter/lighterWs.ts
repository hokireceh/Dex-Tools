import WebSocket from "ws";
import Decimal from "decimal.js";
import { logger } from "../logger";

const WS_URL = "wss://mainnet.zklighter.elliot.ai/stream";

export type PriceCallback = (midPrice: Decimal, marketIndex: number) => void;

// marketIndex → { price, timestamp }
export const wsPriceCache = new Map<number, { price: Decimal; ts: number }>();

// marketIndex → Map<strategyId, callback>
const priceCallbacks = new Map<number, Map<number, PriceCallback>>();

// marketIndex → subscriber count
const marketRefCount = new Map<number, number>();

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
let reconnectDelay = 2_000;
let isDestroyed = false;

function getActiveMarkets(): number[] {
  return Array.from(marketRefCount.entries())
    .filter(([, count]) => count > 0)
    .map(([idx]) => idx);
}

function sendJson(payload: object): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function subscribeMarket(marketIndex: number): void {
  sendJson({ type: "subscribe", channel: `ticker/${marketIndex}` });
  logger.debug({ marketIndex }, "[WS] Subscribed to ticker channel");
}

function unsubscribeMarket(marketIndex: number): void {
  sendJson({ type: "unsubscribe", channel: `ticker/${marketIndex}` });
}

function startKeepalive(): void {
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  // Ping setiap 25 s — well within Lighter's 2-minute requirement.
  // Menggunakan WebSocket protocol-level PING frame (bukan application-level JSON)
  // sesuai dokumentasi resmi Lighter. Lebih robust dari subscribe JSON karena
  // tidak bergantung pada channel yang di-support server.
  keepaliveTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 25_000);
}

function stopKeepalive(): void {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer || isDestroyed) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  logger.info({ delayMs: delay }, "[WS] Scheduling reconnect");
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!isDestroyed && getActiveMarkets().length > 0) {
      connect();
    }
  }, delay);
}

export function connect(): void {
  if (isDestroyed) return;
  if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) return;

  const url = WS_URL;
  logger.info({ url }, "[WS] Connecting to Lighter WebSocket");

  ws = new WebSocket(url);

  ws.addEventListener("open", () => {
    logger.info("[WS] Connected to Lighter WebSocket");
    reconnectDelay = 2_000;
    startKeepalive();
    for (const mkt of getActiveMarkets()) {
      subscribeMarket(mkt);
    }
  });

  ws.addEventListener("message", (event: WebSocket.MessageEvent) => {
    try {
      const msg = JSON.parse(event.data as string);
      if (msg.type !== "update/ticker" || !msg.ticker) return;

      const channel: string = msg.channel ?? "";
      // Server may return "ticker:1" or "ticker/1" — handle both formats
      const marketIndex = parseInt(channel.split(/[:/]/)[1] ?? "");
      if (isNaN(marketIndex)) return;

      const ask = parseFloat(msg.ticker?.a?.price ?? "0");
      const bid = parseFloat(msg.ticker?.b?.price ?? "0");
      if (!ask || !bid || ask <= 0 || bid <= 0) return;

      const midPrice = new Decimal(ask).add(bid).div(2);

      wsPriceCache.set(marketIndex, { price: midPrice, ts: Date.now() });

      const callbacks = priceCallbacks.get(marketIndex);
      if (callbacks) {
        for (const cb of callbacks.values()) {
          try { cb(midPrice, marketIndex); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore parse errors */ }
  });

  ws.addEventListener("close", () => {
    logger.warn("[WS] Disconnected from Lighter WebSocket");
    stopKeepalive();
    scheduleReconnect();
  });

  ws.addEventListener("error", (event: any) => {
    logger.error({ err: event.error, message: event.message }, "[WS] WebSocket error");
    // Do NOT call ws.close() here — the WebSocket spec guarantees that an error
    // event is always followed by a close event. Calling close() here causes
    // infinite recursion in Node.js undici: failWebsocketConnection() fires
    // another error event → handler calls close() again → stack overflow.
    // Reconnect is already handled by the close event handler above.
  });
}

export function registerPriceCallback(
  marketIndex: number,
  strategyId: number,
  callback: PriceCallback,
): void {
  isDestroyed = false;

  if (!priceCallbacks.has(marketIndex)) {
    priceCallbacks.set(marketIndex, new Map());
  }
  priceCallbacks.get(marketIndex)!.set(strategyId, callback);

  const prev = marketRefCount.get(marketIndex) ?? 0;
  marketRefCount.set(marketIndex, prev + 1);

  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    connect();
  } else if (ws.readyState === WebSocket.OPEN && prev === 0) {
    subscribeMarket(marketIndex);
  }
}

export function unregisterPriceCallback(marketIndex: number, strategyId: number): void {
  const callbacks = priceCallbacks.get(marketIndex);
  if (callbacks) {
    callbacks.delete(strategyId);
    if (callbacks.size === 0) priceCallbacks.delete(marketIndex);
  }

  const newCount = Math.max(0, (marketRefCount.get(marketIndex) ?? 0) - 1);
  if (newCount === 0) {
    marketRefCount.delete(marketIndex);
    wsPriceCache.delete(marketIndex);
    unsubscribeMarket(marketIndex);
  } else {
    marketRefCount.set(marketIndex, newCount);
  }

  if (getActiveMarkets().length === 0) {
    stopKeepalive();
    isDestroyed = true;
    ws?.close();
  }
}

export function getWsCachedPrice(marketIndex: number, maxAgeMs = 5_000): Decimal | null {
  const entry = wsPriceCache.get(marketIndex);
  if (!entry) return null;
  if (Date.now() - entry.ts > maxAgeMs) return null;
  return entry.price;
}
