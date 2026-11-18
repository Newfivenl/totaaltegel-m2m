export type CalcMode = 'sill_m2' | 'sill_m1';

// Variant prices below €10,00 are ERP unit prices divided by 100 (same switch as the theme).
const LEGACY_PRICE_THRESHOLD_CENTS = 1000;

export const PRICE_TOLERANCE_CENTS = 1;

export const isCalcMode = (value: unknown): value is CalcMode => value === 'sill_m2' || value === 'sill_m1';

export const moneyToCents = (amount: string): number => Math.round(Number(amount) * 100);

export const centsToAmount = (cents: number): string => (cents / 100).toFixed(2);

export const unitCents = (variantPriceCents: number): number =>
  variantPriceCents < LEGACY_PRICE_THRESHOLD_CENTS ? variantPriceCents * 100 : variantPriceCents;

// Integer numerators keep results like 1,50 m × 8547 at exactly 12820.5 before rounding.
export const sillLineCents = (
  mode: CalcMode,
  variantPriceCents: number,
  depthCm: number | undefined,
  lengthCm: number,
): number => {
  const unit = unitCents(variantPriceCents);

  if (mode === 'sill_m2') {
    if (depthCm === undefined) throw new Error('sill_m2 requires depth');
    return Math.round((depthCm * lengthCm * unit) / 10_000);
  }

  return Math.round((lengthCm * unit) / 100);
};

export const withinTolerance = (a: number, b: number): boolean => Math.abs(a - b) <= PRICE_TOLERANCE_CENTS;
