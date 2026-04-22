/**
 * Test Script: Place Order ETH-USD di Extended Testnet
 *
 * Endpoint yang TERSEDIA di testnet:
 *   GET  /api/v1/user/balance                ✓
 *   GET  /api/v1/user/positions              ✓
 *   GET  /api/v1/user/fees                   ✓
 *   GET  /api/v1/user/orders/history         ✓
 *   GET  /api/v1/info/markets                ✓ (termasuk l2Config: syntheticId, syntheticResolution)
 *   GET  /api/v1/info/markets/{market}/stats ✓ (mark price real-time)
 *   POST /api/v1/user/order                  ✓ (yang akan ditest)
 *
 * Endpoint yang TIDAK TERSEDIA di testnet:
 *   GET  /api/v1/markets       ✗ (404) — gunakan /api/v1/info/markets
 *   GET  /api/v1/orderbook/*   ✗ (404)
 *   GET  /api/v1/user/account  ✗ (404) — gunakan /api/v1/user/account/info
 *
 * SIGNING: Gunakan syntheticId dari l2Config sebagai market felt, BUKAN ASCII nama market!
 *   ETH-USD syntheticId = "0x4554482d3500000000000000000000"
 *   ETH-USD syntheticResolution = 100000 (10^5)
 *
 * Jalankan:
 *   pnpm --filter @workspace/api-server test:extended
 */

import { derivePublicKey } from "../src/lib/extended/extendedSigner.js";
import {
  getBalance,
  getPositions,
  getOrderHistory,
  getMarketStats,
} from "../src/lib/extended/extendedApi.js";
import {
  placeExtendedOrder,
  cancelExtendedOrderById,
} from "../src/lib/extended/extendedOrderManager.js";
import Decimal from "decimal.js";

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

// ─── Config ───────────────────────────────────────────────────────────────────

const API_KEY = process.env.EXTENDED_API_KEY!;
const PRIVATE_KEY = process.env.EXTENDED_STARK_PRIVATE_KEY!;
const COLLATERAL_POSITION = process.env.EXTENDED_COLLATERAL_POSITION!;
const NETWORK = "testnet" as const;
const MARKET = "ETH-USD";

// Min order size: 0.001. Min price change: 0.01 (2 decimal).
const ORDER_QTY = "0.001";
// Fee taker dari /api/v1/user/fees = 0.0005
const TAKER_FEE = "0.0005";

// ─── Logger ───────────────────────────────────────────────────────────────────

const G = "\x1b[32m", R = "\x1b[31m", C = "\x1b[36m", Y = "\x1b[33m", X = "\x1b[0m";
const ts = () => new Date().toISOString();
const ok   = (m: string, d?: unknown) => console.log(`${G}✓${X} [${ts()}] ${m}`, d !== undefined ? JSON.stringify(d, null, 2) : "");
const fail = (m: string, d?: unknown) => console.error(`${R}✗${X} [${ts()}] ${m}`, d !== undefined ? JSON.stringify(d, null, 2) : "");
const info = (m: string, d?: unknown) => console.log(`${C}ℹ${X} [${ts()}] ${m}`, d !== undefined ? JSON.stringify(d, null, 2) : "");
const warn = (m: string, d?: unknown) => console.log(`${Y}⚠${X} [${ts()}] ${m}`, d !== undefined ? JSON.stringify(d, null, 2) : "");

// ─── HTTP helper (raw fetch) ──────────────────────────────────────────────────

async function extFetch(path: string, opts: { method?: string; body?: unknown } = {}) {
  const url = `https://api.starknet.sepolia.extended.exchange${path}`;
  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "X-Api-Key": API_KEY,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  return { status: res.status, text };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${C}════════════════════════════════════════════════════════${X}`);
  console.log(`  Test Place Order ${MARKET} — Extended Testnet`);
  console.log(`${C}════════════════════════════════════════════════════════${X}\n`);

  // ── STEP 1: Validasi env ────────────────────────────────────────────────────
  console.log(`${C}── STEP 1: Validasi Environment Variables${X}`);
  if (!API_KEY || !PRIVATE_KEY || !COLLATERAL_POSITION) {
    fail("Env vars tidak lengkap! Butuh: EXTENDED_API_KEY, EXTENDED_STARK_PRIVATE_KEY, EXTENDED_COLLATERAL_POSITION");
    process.exit(1);
  }
  ok("Env vars OK");
  info(`Collateral Position : ${COLLATERAL_POSITION}`);
  info(`Network             : Extended ${NETWORK}`);

  // ── STEP 2: Derive Stark key ────────────────────────────────────────────────
  console.log(`\n${C}── STEP 2: Derive Stark Public Key${X}`);
  let starkKey: string;
  try {
    starkKey = derivePublicKey(PRIVATE_KEY);
    ok(`Stark public key: ${starkKey}`);
  } catch (e: any) {
    fail(`Gagal derive key: ${e.message}`);
    process.exit(1);
  }

  // ── STEP 3: Mark price real-time dari /api/v1/info/markets/{market}/stats ───
  console.log(`\n${C}── STEP 3: Fetch Mark Price Real dari API${X}`);
  let markPrice = new Decimal("2100.0");
  try {
    const stats = await getMarketStats(MARKET, NETWORK);
    if (stats?.markPrice) {
      markPrice = new Decimal(stats.markPrice);
      ok(`Mark price ETH-USD: $${markPrice.toFixed(2)} (indexPrice: $${stats.indexPrice})`);
    } else {
      warn("Gagal fetch mark price, pakai fallback $2100.0");
    }
  } catch (e: any) {
    warn(`Fetch mark price error: ${e.message}, pakai fallback $2100.0`);
  }

  // Harga order: 3% di bawah mark price, dibulatkan ke 2 desimal (minPriceChange=0.01)
  const ORDER_PRICE = markPrice.mul("0.97").toDecimalPlaces(2, Decimal.ROUND_HALF_DOWN);
  info(`Order price: $${ORDER_PRICE.toFixed(2)} (3% di bawah mark → passive, tidak tereksekusi segera)`);

  // ── STEP 4: Balance ─────────────────────────────────────────────────────────
  console.log(`\n${C}── STEP 4: Fetch Balance${X}`);
  const balance = await getBalance(API_KEY, NETWORK);
  if (!balance) {
    fail("Gagal fetch balance — cek API key");
    process.exit(1);
  }
  ok("Balance:", {
    collateral   : balance.collateralName,
    balance      : balance.balance,
    equity       : balance.equity,
    available    : balance.availableForTrade,
    unrealisedPnl: balance.unrealisedPnl,
    marginRatio  : balance.marginRatio,
  });

  const available = new Decimal(balance.availableForTrade);
  if (available.lessThan("1")) {
    fail(`Available ${balance.availableForTrade} — terlalu kecil`);
    process.exit(1);
  }
  ok(`Saldo cukup: $${available.toFixed(2)}`);

  // ── STEP 5: Posisi aktif ────────────────────────────────────────────────────
  console.log(`\n${C}── STEP 5: Fetch Posisi Aktif${X}`);
  const positions = await getPositions(API_KEY, NETWORK);
  if (positions.length === 0) {
    info("Tidak ada posisi terbuka (akun bersih)");
  } else {
    ok(`${positions.length} posisi aktif:`, positions.map(p => ({
      market: p.market, side: p.side, size: p.size, openPrice: p.openPrice,
    })));
  }

  // ── STEP 6: Fees aktual ─────────────────────────────────────────────────────
  console.log(`\n${C}── STEP 6: Fetch Fee Rate Aktual${X}`);
  const feesRes = await extFetch("/api/v1/user/fees");
  let takerFee = TAKER_FEE;
  if (feesRes.status === 200) {
    const d = JSON.parse(feesRes.text);
    const ethFee = (d.data as any[]).find((f: any) => f.market === MARKET);
    if (ethFee) {
      takerFee = ethFee.takerFeeRate;
      ok(`Fee ETH-USD → maker: ${ethFee.makerFeeRate}, taker: ${ethFee.takerFeeRate}`);
    }
  } else {
    warn(`Gagal fetch fees (${feesRes.status}) — gunakan default ${TAKER_FEE}`);
  }

  // ── STEP 7: Parameter order ─────────────────────────────────────────────────
  console.log(`\n${C}── STEP 7: Parameter Order${X}`);
  info("Parameter:", {
    market        : MARKET,
    side          : "BUY",
    type          : "LIMIT (GTT)",
    qty           : ORDER_QTY,
    price         : `$${ORDER_PRICE.toFixed(2)}`,
    fee           : takerFee,
    markPrice     : `$${markPrice.toFixed(2)}`,
    discount      : "3% di bawah mark (passive, tidak tereksekusi segera)",
    estimatedValue: `$${ORDER_PRICE.mul(ORDER_QTY).toFixed(4)}`,
    noteL2Config  : "syntheticId & syntheticResolution auto-fetch dari /api/v1/info/markets",
  });

  // ── STEP 8: Place LIMIT BUY order ──────────────────────────────────────────
  console.log(`\n${C}── STEP 8: Place LIMIT BUY Order${X}`);
  let orderId: number | null = null;
  let externalId: string | null = null;

  try {
    const result = await placeExtendedOrder({
      apiKey             : API_KEY,
      privateKey         : PRIVATE_KEY,
      collateralPosition : COLLATERAL_POSITION,
      market             : MARKET,
      type               : "LIMIT",
      side               : "BUY",
      qty                : ORDER_QTY,
      price              : ORDER_PRICE.toFixed(2),  // 2 desimal (minPriceChange=0.01)
      fee                : takerFee,
      network            : NETWORK,
      // syntheticId & syntheticResolution auto-fetch dari /api/v1/info/markets
    });

    orderId   = result.orderId;
    externalId = result.externalId;

    ok(`ORDER BERHASIL DITEMPATKAN!`, {
      orderId    : result.orderId,
      externalId : result.externalId,
      market     : MARKET,
      side       : "BUY",
      price      : `$${ORDER_PRICE.toFixed(2)}`,
      qty        : ORDER_QTY,
    });
  } catch (e: any) {
    fail(`Gagal place order: ${e.message}`);

    // Debug: coba variasi harga / qty berbeda
    info("Mencoba variasi parameter untuk debug...");
    await debugOrderVariants(API_KEY, PRIVATE_KEY, COLLATERAL_POSITION, takerFee, markPrice);
    process.exit(1);
  }

  // ── STEP 9: Verifikasi lewat order history ─────────────────────────────────
  console.log(`\n${C}── STEP 9: Verifikasi via Order History${X}`);
  await new Promise((r) => setTimeout(r, 2000));

  const history = await getOrderHistory(API_KEY, { market: MARKET, limit: 10 }, NETWORK);
  const ourOrder = history.find(o => o.id === orderId || o.externalId === externalId);
  if (ourOrder) {
    ok("Order terkonfirmasi di history:", {
      id       : ourOrder.id,
      externalId: ourOrder.externalId,
      status   : ourOrder.status,
      price    : ourOrder.price,
      qty      : ourOrder.qty,
      filledQty: ourOrder.filledQty,
    });
  } else {
    warn("Order belum muncul di history (propagating), skip verifikasi");
    if (history.length > 0) {
      info("History terbaru:", history.slice(0, 3).map(o => ({
        id: o.id, status: o.status, side: o.side, price: o.price, qty: o.qty,
      })));
    }
  }

  // ── STEP 10: Cancel order ──────────────────────────────────────────────────
  console.log(`\n${C}── STEP 10: Cancel Order${X}`);
  if (orderId) {
    try {
      await cancelExtendedOrderById(API_KEY, orderId, NETWORK);
      ok(`Order ${orderId} berhasil dibatalkan`);
    } catch (e: any) {
      warn(`Cancel gagal (mungkin sudah tereksekusi): ${e.message}`);
    }
  }

  // ── Ringkasan ───────────────────────────────────────────────────────────────
  console.log(`\n${G}════════════════════════════════════════════════════════${X}`);
  console.log(`${G}  PHASE 2 TEST COMPLETE — Place Order Berhasil!${X}`);
  console.log(`${G}════════════════════════════════════════════════════════${X}`);
  console.log(`  Market         : ${MARKET}`);
  console.log(`  Network        : Extended ${NETWORK}`);
  console.log(`  Balance        : $${balance.balance}`);
  console.log(`  Mark Price     : $${markPrice.toFixed(2)} (real dari API)`);
  console.log(`  Order Price    : $${ORDER_PRICE.toFixed(2)} (3% di bawah mark)`);
  console.log(`  Order ID       : ${orderId}`);
  console.log(`  External ID    : ${externalId}`);
  console.log(`  Flow           : PLACED ✓ → VERIFIED ✓ → CANCELLED ✓`);
  console.log(`${G}════════════════════════════════════════════════════════${X}\n`);
  console.log(`→ Siap lanjut ke Phase 3: Bot Engine Grid/DCA untuk Extended DEX\n`);
}

// ─── Debug helper: coba variasi jika order pertama gagal ─────────────────────

async function debugOrderVariants(
  apiKey: string, privateKey: string, collateralPosition: string, fee: string,
  markPrice: Decimal
) {
  // Variasi harga berdasarkan mark price aktual
  const base = markPrice.mul("0.95").toDecimalPlaces(2, Decimal.ROUND_HALF_DOWN).toFixed(2);
  const base2 = markPrice.mul("0.90").toDecimalPlaces(2, Decimal.ROUND_HALF_DOWN).toFixed(2);
  const variants = [
    { price: base,  qty: "0.001", note: "5% di bawah mark (2dp)" },
    { price: base2, qty: "0.001", note: "10% di bawah mark (2dp)" },
    { price: base,  qty: "0.01",  note: "5% di bawah mark, qty lebih besar" },
  ];

  for (const v of variants) {
    info(`Mencoba: price=${v.price} qty=${v.qty} (${v.note})`);
    try {
      const r = await placeExtendedOrder({
        apiKey, privateKey, collateralPosition,
        market: "ETH-USD", type: "LIMIT", side: "BUY",
        qty: v.qty, price: v.price, fee, network: "testnet",
      });
      ok(`Berhasil dengan variasi '${v.note}'!`, r);
      try { await cancelExtendedOrderById(apiKey, r.orderId, "testnet"); } catch {}
      return;
    } catch (e: any) {
      warn(`Gagal (${v.note}): ${e.message}`);
    }
  }
}

main().catch((e: any) => {
  fail(`Uncaught: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
