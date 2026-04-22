import { db } from "@workspace/db";
import { strategiesTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import type { GridConfig } from "@workspace/db";

export interface BudgetCheckResult {
  exceeded: boolean;
  newSpentUsd: number;
  maxBudgetUsd: number | null;
}

/**
 * F2 — Budget Cap tracker.
 * Tambahkan fee ke budgetSpentUsd di DB, kembalikan apakah cap sudah terlampaui.
 *
 * @param strategyId  ID strategi (null = skip, tidak ada tracking)
 * @param filledQty   Jumlah unit yang terisi
 * @param fillPrice   Harga fill (dalam USD)
 * @param feeRate     Fee rate maker/taker (contoh: 0.0002 untuk 0.02%). 0 untuk 0% maker DEX.
 */
export async function trackBudgetSpend(
  strategyId: number | null,
  filledQty: Decimal,
  fillPrice: Decimal,
  feeRate: number
): Promise<BudgetCheckResult> {
  if (!strategyId) return { exceeded: false, newSpentUsd: 0, maxBudgetUsd: null };

  const feeUsd = filledQty.mul(fillPrice).mul(feeRate).toNumber();

  const strategy = await db.query.strategiesTable.findFirst({
    where: eq(strategiesTable.id, strategyId),
    columns: { gridConfig: true },
  });

  if (!strategy) return { exceeded: false, newSpentUsd: 0, maxBudgetUsd: null };

  const maxBudgetUsd = (strategy.gridConfig as GridConfig | null)?.maxBudgetUsd ?? null;

  // Atomic SQL increment — menghindari read-modify-write race condition saat
  // WS fill handler dan tick loop memanggil trackBudgetSpend secara bersamaan.
  const [updated] = await db
    .update(strategiesTable)
    .set({ budgetSpentUsd: sql`${strategiesTable.budgetSpentUsd} + ${feeUsd.toFixed(8)}::numeric` })
    .where(eq(strategiesTable.id, strategyId))
    .returning({ budgetSpentUsd: strategiesTable.budgetSpentUsd });

  const newSpentUsd = parseFloat(updated?.budgetSpentUsd ?? "0");
  const exceeded = maxBudgetUsd !== null && newSpentUsd >= maxBudgetUsd;

  return { exceeded, newSpentUsd, maxBudgetUsd };
}
