import Decimal from "decimal.js";

export type DecimalInput = string | number | null | undefined;

export function safeDec(value: DecimalInput): Decimal {
  if (value === null || value === undefined || value === "") return new Decimal(0);
  try {
    return new Decimal(value);
  } catch {
    return new Decimal(0);
  }
}

export function sumDec<T>(list: readonly T[], get: (item: T) => DecimalInput): Decimal {
  return list.reduce<Decimal>((acc, item) => acc.plus(safeDec(get(item))), new Decimal(0));
}
