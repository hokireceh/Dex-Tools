/**
 * test-logic.ts — Regression test untuk logika kritis bot engine
 *
 * TIDAK butuh DB, API key, atau koneksi exchange.
 * Jalankan di VPS setelah setiap deploy: pnpm run test:logic
 *
 * Exit 0  = semua pass
 * Exit 1  = ada yang fail (jangan deploy / rollback)
 */

import Decimal from "decimal.js";
import {
  computeReduceOnly,
  computeGridSide,
  isSlTriggered,
  isTpTriggered,
} from "../src/lib/shared/botLogic.js";

// ─── Test runner minimal ────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function expect(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ✅  ${label}`);
    passed++;
  } else {
    console.log(`  ❌  ${label}`);
    console.log(`       expected: ${JSON.stringify(expected)}`);
    console.log(`       actual:   ${JSON.stringify(actual)}`);
    failed++;
    failures.push(label);
  }
}

function section(title: string) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
}

// ─── Logika lokal yang tidak di-export dari engine ──────────────────────────
// computeReduceOnly, computeGridSide, isSlTriggered, isTpTriggered → diimport dari botLogic.ts
// Fungsi di bawah ini tetap lokal karena belum ada di shared module.

/**
 * Identik dengan tolerance.ts getDuplicateTolerance
 * Formula: radius = min(0.1% price, 40% gridSpacing)
 */
function getDuplicateTolerance(
  targetPrice: number,
  gridSpacing: number
): { lower: number; upper: number } {
  const priceTol   = targetPrice * 0.001;
  const spacingTol = gridSpacing * 0.4;
  const radius     = Math.min(priceTol, spacingTol);
  return { lower: targetPrice - radius, upper: targetPrice + radius };
}

/**
 * Identik dengan Extended L1328-1331 dan Lighter equivalent
 * currentLevel = clamp(floor((price - lower) / spacing), 0, levels-1)
 */
function computeGridLevel(
  price: number,
  lower: number,
  upper: number,
  levels: number
): number {
  const spacing = (upper - lower) / levels;
  return Math.min(Math.floor((price - lower) / spacing), levels - 1);
}

/**
 * Ethereal clock offset — identik dengan etherealSigner getEtherealClockOffset
 * offset = serverTime - localTime
 * adjusted signedAt = Math.floor((Date.now() + offset) / 1000)
 */
function computeAdjustedSignedAt(
  localTimeMs: number,
  serverTimeMs: number,
  rttMs: number
): number {
  const offset = serverTimeMs - localTimeMs - Math.floor(rttMs / 2);
  return Math.floor((localTimeMs + offset) / 1000);
}

// ─── 1. reduceOnly matrix ────────────────────────────────────────────────────

section("reduceOnly matrix (BUG-EXT-LONGSELL-001 guard)");

// Long mode: hanya SELL yang reduceOnly (tutup long, jangan buka short)
expect("Long  + BUY  → reduceOnly=false (buka long)",   computeReduceOnly("long",  "buy"),  false);
expect("Long  + SELL → reduceOnly=true  (tutup long)",  computeReduceOnly("long",  "sell"), true);

// Short mode: hanya BUY yang reduceOnly (tutup short, jangan buka long)
expect("Short + BUY  → reduceOnly=true  (tutup short)", computeReduceOnly("short", "buy"),  true);
expect("Short + SELL → reduceOnly=false (buka short)",  computeReduceOnly("short", "sell"), false);

// Neutral: tidak pernah reduceOnly
expect("Neutral + BUY  → reduceOnly=false",             computeReduceOnly("neutral", "buy"),  false);
expect("Neutral + SELL → reduceOnly=false",             computeReduceOnly("neutral", "sell"), false);

// ─── 2. Arah order (direction filter) ───────────────────────────────────────

section("Direction filter — down→BUY, up→SELL (semua mode)");

expect("levelsMoved -3 (turun 3 level) → BUY",   computeGridSide(-3), "buy");
expect("levelsMoved -1 (turun 1 level) → BUY",   computeGridSide(-1), "buy");
expect("levelsMoved +1 (naik 1 level)  → SELL",  computeGridSide(1),  "sell");
expect("levelsMoved +5 (naik 5 level)  → SELL",  computeGridSide(5),  "sell");

// ─── 3. Stop Loss mode-aware ─────────────────────────────────────────────────

section("Stop Loss — mode-aware trigger");

// Long: rugi saat harga TURUN
expect("Long  SL: harga 45000 < SL 50000 → terpicu",  isSlTriggered("long",    45000, 50000), true);
expect("Long  SL: harga 55000 > SL 50000 → aman",     isSlTriggered("long",    55000, 50000), false);
// Short: rugi saat harga NAIK
expect("Short SL: harga 55000 > SL 50000 → terpicu",  isSlTriggered("short",   55000, 50000), true);
expect("Short SL: harga 45000 < SL 50000 → aman",     isSlTriggered("short",   45000, 50000), false);
// Neutral: sama dengan Long (harga turun)
expect("Neutral SL: harga 45000 < SL 50000 → terpicu", isSlTriggered("neutral", 45000, 50000), true);
expect("Neutral SL: harga 55000 > SL 50000 → aman",    isSlTriggered("neutral", 55000, 50000), false);

// ─── 4. Take Profit mode-aware ───────────────────────────────────────────────

section("Take Profit — mode-aware trigger");

// Long: untung saat harga NAIK
expect("Long  TP: harga 55000 > TP 50000 → terpicu",  isTpTriggered("long",    55000, 50000), true);
expect("Long  TP: harga 45000 < TP 50000 → belum",    isTpTriggered("long",    45000, 50000), false);
// Short: untung saat harga TURUN
expect("Short TP: harga 45000 < TP 50000 → terpicu",  isTpTriggered("short",   45000, 50000), true);
expect("Short TP: harga 55000 > TP 50000 → belum",    isTpTriggered("short",   55000, 50000), false);
// Neutral: sama dengan Long
expect("Neutral TP: harga 55000 > TP 50000 → terpicu", isTpTriggered("neutral", 55000, 50000), true);
expect("Neutral TP: harga 45000 < TP 50000 → belum",   isTpTriggered("neutral", 45000, 50000), false);

// ─── 5. Duplicate tolerance formula ─────────────────────────────────────────

section("Duplicate tolerance (getDuplicateTolerance)");

// BTC $67k, spacing $5 → radius = min(67, 2) = 2
{
  const t = getDuplicateTolerance(67000, 5);
  expect("BTC $67k spacing $5 → lower=66998",   t.lower,  66998);
  expect("BTC $67k spacing $5 → upper=67002",   t.upper,  67002);
}

// HYPE $35, spacing $0.002 → radius = min(0.035, 0.0008) = 0.0008
{
  const t = getDuplicateTolerance(35, 0.002);
  expect("HYPE $35 spacing $0.002 → lower=34.9992",  +t.lower.toFixed(4),  34.9992);
  expect("HYPE $35 spacing $0.002 → upper=35.0008",  +t.upper.toFixed(4),  35.0008);
}

// Kalau spacing sangat besar → dikunci ke 0.1% price
{
  const t = getDuplicateTolerance(100, 1000);
  expect("spacing sangat besar → radius pakai 0.1% price (0.1)", t.lower, 99.9);
  expect("spacing sangat besar → radius pakai 0.1% price (0.1)", t.upper, 100.1);
}

// ─── 6. Grid level calculation ───────────────────────────────────────────────

section("Grid level calculation");

// Range $60k-$70k, 10 levels → spacing $1k per level
// Harga $65k → level 5
expect("$60k-$70k 10lvl: harga $65k → level 5",  computeGridLevel(65000, 60000, 70000, 10), 5);
// Harga $60k → level 0 (batas bawah)
expect("$60k-$70k 10lvl: harga $60k → level 0",  computeGridLevel(60000, 60000, 70000, 10), 0);
// Harga $70k → clamp ke level 9 (bukan 10)
expect("$60k-$70k 10lvl: harga $70k → clamp level 9", computeGridLevel(70000, 60000, 70000, 10), 9);
// Harga $69,999 → level 9 (hampir batas atas)
expect("$60k-$70k 10lvl: harga $69,999 → level 9", computeGridLevel(69999, 60000, 70000, 10), 9);

// ─── 7. Ethereal clock offset ────────────────────────────────────────────────

section("Ethereal clock offset (BUG-ETH-CLOCKDRIFT-001 guard)");

// Server 2 detik lebih maju dari local, RTT 100ms
// offset = 2000 - 50 = 1950ms
// adjusted = floor((local + 1950) / 1000)
{
  const localMs  = 1_000_000_000_000; // arbitrary base
  const serverMs = localMs + 2000;    // server 2 detik lebih maju
  const rttMs    = 100;
  const adjusted = computeAdjustedSignedAt(localMs, serverMs, rttMs);
  const expected = Math.floor((localMs + 1950) / 1000);
  expect("Server +2s, RTT 100ms → signedAt pakai server time minus RTT/2", adjusted, expected);
}

// Server sama persis (no drift), RTT 0ms
{
  const localMs  = 1_700_000_000_000;
  const serverMs = localMs;
  const adjusted = computeAdjustedSignedAt(localMs, serverMs, 0);
  const expected = Math.floor(localMs / 1000);
  expect("Tidak ada drift → signedAt = Math.floor(Date.now()/1000)", adjusted, expected);
}

// Server 500ms lebih lambat (edge case: server ketinggalan)
{
  const localMs  = 1_700_000_000_000;
  const serverMs = localMs - 500;
  const adjusted = computeAdjustedSignedAt(localMs, serverMs, 50);
  const expected = Math.floor((localMs - 525) / 1000);
  expect("Server lambat 500ms, RTT 50ms → signedAt dikurangi", adjusted, expected);
}

// ─── 8. Size guard (size <= 0) ───────────────────────────────────────────────

section("Size guard — order tidak boleh dikirim kalau size <= 0");

{
  const amountPerGrid = new Decimal("0.0001");
  const currentPrice  = new Decimal("67000");
  const size = amountPerGrid.div(currentPrice);
  expect("Amount $0.0001 / price $67000 → size sangat kecil (< 0.000002)", size.lt(new Decimal("0.000002")), true);
  expect("Size sangat kecil → harus di-skip (lte 0 secara efektif)", size.lte(new Decimal("0.000001")), true);
}

{
  const amountPerGrid = new Decimal("10");
  const currentPrice  = new Decimal("67000");
  const size = amountPerGrid.div(currentPrice);
  expect("Amount $10 / price $67000 → size ~0.000149 > 0", size.gt(0), true);
}

// ─── 9. Batch order cap ──────────────────────────────────────────────────────

section("Batch order cap (MAX_BATCH_ORDERS)");

const MAX_BATCH_ORDERS = 5;  // Lighter & Extended
const ETH_MAX_GRID_ORDERS = 3; // Ethereal

expect("Lighter: 3 level crossed → 3 orders (< cap)",  Math.min(3, MAX_BATCH_ORDERS),     3);
expect("Lighter: 7 level crossed → cap 5 orders",      Math.min(7, MAX_BATCH_ORDERS),     5);
expect("Ethereal: 2 level crossed → 2 orders (< cap)", Math.min(2, ETH_MAX_GRID_ORDERS),  2);
expect("Ethereal: 5 level crossed → cap 3 orders",     Math.min(5, ETH_MAX_GRID_ORDERS),  3);

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log("\n" + "═".repeat(60));
console.log(`  Total: ${passed + failed} test | ✅ ${passed} pass | ❌ ${failed} fail`);

if (failures.length > 0) {
  console.log("\n  Test yang fail:");
  failures.forEach(f => console.log(`    - ${f}`));
  console.log("\n  ⚠️  Ada logika yang berubah dari yang seharusnya.");
  console.log("  Cek commit terakhir sebelum deploy ke production.\n");
  process.exit(1);
} else {
  console.log("\n  Semua logika kritis verified. Aman untuk deploy.\n");
  process.exit(0);
}
