/**
 * botLogic.ts — Pure logic functions yang dipakai semua 3 bot engine.
 *
 * Semua fungsi di sini adalah PURE (tidak ada side effect, tidak ada DB/API call).
 * Diimport oleh: lighterBotEngine, extendedBotEngine, dan test:logic.
 *
 * Dengan cara ini test:logic benar-benar menguji kode engine yang berjalan di production,
 * bukan copy formula terpisah.
 */

export type GridMode = "long" | "short" | "neutral";
export type OrderSide = "buy" | "sell";

/**
 * Hitung apakah order harus reduceOnly berdasarkan mode dan sisi.
 *
 * Long  + sell → reduceOnly=true  (tutup long, jangan buka short)
 * Short + buy  → reduceOnly=true  (tutup short, jangan buka long)
 * Semua yang lain → false
 */
export function computeReduceOnly(mode: GridMode, side: OrderSide): boolean {
  return mode === "long"  ? side === "sell"
       : mode === "short" ? side === "buy"
       : false;
}

/**
 * Hitung sisi order dari arah pergerakan level grid.
 * Harga turun (levelsMoved < 0) → BUY
 * Harga naik  (levelsMoved > 0) → SELL
 */
export function computeGridSide(levelsMoved: number): OrderSide {
  return levelsMoved < 0 ? "buy" : "sell";
}

/**
 * Cek apakah Stop Loss terpicu.
 *
 * Long/Neutral: rugi saat harga TURUN → terpicu jika currentPrice < stopLoss
 * Short:        rugi saat harga NAIK  → terpicu jika currentPrice > stopLoss
 */
export function isSlTriggered(
  mode: GridMode,
  currentPrice: number,
  stopLoss: number
): boolean {
  return mode === "short" ? currentPrice > stopLoss : currentPrice < stopLoss;
}

/**
 * Cek apakah Take Profit terpicu.
 *
 * Long/Neutral: untung saat harga NAIK  → terpicu jika currentPrice > takeProfit
 * Short:        untung saat harga TURUN → terpicu jika currentPrice < takeProfit
 */
export function isTpTriggered(
  mode: GridMode,
  currentPrice: number,
  takeProfit: number
): boolean {
  return mode === "short" ? currentPrice < takeProfit : currentPrice > takeProfit;
}
