import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface PriceDisplayProps {
  value: number;
  format?: "currency" | "percent" | "decimal";
  decimals?: number;
  /**
   * Optional upper bound for fraction digits. Defaults to `decimals` (fixed width).
   * Use when you want a min/max range, e.g. `decimals={2} maxDecimals={6}` so prices
   * show at least 2 decimals but allow up to 6 for sub-cent values.
   */
  maxDecimals?: number;
  showIcon?: boolean;
  className?: string;
  colored?: boolean;
}

export function PriceDisplay({ 
  value, 
  format = "decimal", 
  decimals = 2, 
  maxDecimals,
  showIcon = false,
  className,
  colored = true
}: PriceDisplayProps) {
  const isPositive = value > 0;
  const isNegative = value < 0;
  const isZero = value === 0;

  const effectiveMax = maxDecimals !== undefined && maxDecimals >= decimals
    ? maxDecimals
    : decimals;

  const formattedValue = new Intl.NumberFormat('en-US', {
    style: format === "currency" ? "currency" : "decimal",
    currency: "USD",
    minimumFractionDigits: decimals,
    maximumFractionDigits: effectiveMax,
  }).format(Math.abs(value));

  const finalString = format === "percent" ? `${formattedValue}%` : formattedValue;

  return (
    <div className={cn(
      "flex items-center gap-1 font-mono tracking-tight",
      colored && isPositive && "text-success",
      colored && isNegative && "text-destructive",
      colored && isZero && "text-muted-foreground",
      className
    )}>
      {showIcon && !isZero && (
        isPositive ? <ArrowUpRight className="w-3.5 h-3.5" /> : <ArrowDownRight className="w-3.5 h-3.5" />
      )}
      <span>
        {isNegative && "-"}{finalString}
      </span>
    </div>
  );
}
