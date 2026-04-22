import crypto from "crypto";
import Decimal from "decimal.js";

export function generatePassword(): string {
  return crypto.randomBytes(5).toString("hex").toUpperCase();
}

export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

export function getExecModeMultiplier(mode?: "aggressive" | "normal" | "passive" | null): number {
  if (mode === "aggressive") return 0.5;
  if (mode === "passive") return 1.5;
  return 1.0;
}

// ── F4: Follow-Market Grid ────────────────────────────────────────────────────

export interface FollowMarketState {
  gridCenterPrice: Decimal;
  lastReanchorAt: Date | null;
  originalRange: Decimal; // upperPrice - lowerPrice at bot start; preserved across re-anchors
}

// ── F3: Inventory Skew Management ────────────────────────────────────────────

export interface SkewState {
  cumulativeBuyQty: Decimal;
  cumulativeSellQty: Decimal;
}

/**
 * F3 — Compute buy/sell offset multipliers based on net inventory position.
 * Returns 1.0 multipliers and no pause when skew is disabled or referenceQty = 0.
 *
 * @param state         Cumulative buy/sell qty filled so far (resets on bot stop)
 * @param config        Inventory skew config from gridConfig
 * @param referenceQty  Total expected grid qty = amountPerGrid × gridLevels ÷ midPrice
 */
export function computeSkewMultipliers(
  state: SkewState,
  config: {
    enabled?: boolean;
    threshold?: number;
    maxMult?: number;
    pauseAt?: number | null;
  },
  referenceQty: Decimal
): { buyMult: number; sellMult: number; pauseBuy: boolean; pauseSell: boolean } {
  if (!config.enabled || referenceQty.lte(0)) {
    return { buyMult: 1.0, sellMult: 1.0, pauseBuy: false, pauseSell: false };
  }

  const netInventory = state.cumulativeBuyQty.sub(state.cumulativeSellQty);
  const skewRatio = netInventory.div(referenceQty).toNumber();

  const threshold = (config.threshold ?? 20) / 100;
  const maxMult = config.maxMult ?? 2.0;
  const effectiveSkew = Math.abs(skewRatio) > threshold ? skewRatio : 0;
  const skewIntensity = maxMult - 1.0;

  const buyMult = Math.min(1.0 + Math.max(0, effectiveSkew) * skewIntensity, maxMult);
  const sellMult = Math.min(1.0 + Math.max(0, -effectiveSkew) * skewIntensity, maxMult);

  const pauseAt = config.pauseAt != null ? config.pauseAt / 100 : null;
  return {
    buyMult,
    sellMult,
    pauseBuy: pauseAt !== null && skewRatio >= pauseAt,
    pauseSell: pauseAt !== null && -skewRatio >= pauseAt,
  };
}
