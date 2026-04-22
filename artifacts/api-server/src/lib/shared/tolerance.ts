/**
 * Dynamic duplicate order tolerance
 * Mencegah overlap di market harga rendah (HYPE, dll)
 *
 * Formula: min(0.1% harga, 40% grid spacing)
 * - BTC $67k, spacing $5 → radius = min($67, $2) = $2
 * - HYPE $35, spacing $0.002 → radius = min($0.035, $0.0008) = $0.0008
 */
export function getDuplicateTolerance(
  targetPrice: number,
  gridSpacing: number
): { lower: number; upper: number } {
  const priceTol   = targetPrice * 0.001;  // max 0.1% harga
  const spacingTol = gridSpacing * 0.4;    // max 40% grid spacing
  const radius     = Math.min(priceTol, spacingTol);
  return {
    lower: targetPrice - radius,
    upper: targetPrice + radius,
  };
}
