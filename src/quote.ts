import { isCalcMode, sillLineCents, withinTolerance } from './pricing';
import { type CheckoutRequest, InvalidRequestError } from './request';

export type VariantInfo = {
  priceCents: number;
  minWidthMm: number | null;
  maxWidthMm: number | null;
};

export type DraftLine = {
  variantId: string;
  quantity: number;
  properties: Record<string, string>;
  priceOverrideCents: number | null;
};

export type Quote = {
  lines: DraftLine[];
  computedCents: number;
};

export class PriceMismatchError extends Error {
  constructor(
    readonly expectedCents: number,
    readonly computedCents: number,
  ) {
    super('price_mismatch');
  }
}

const MAX_DIMENSION_CM = 10_000;

const parseDimensionCm = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === '') return undefined;

  const cm = Number(value.trim().replace(',', '.'));
  if (!Number.isFinite(cm) || cm <= 0 || cm > MAX_DIMENSION_CM) throw new InvalidRequestError('invalid_line');
  return cm;
};

const parseCents = (value: string | undefined): number => {
  if (value === undefined || !/^\d+$/.test(value.trim())) throw new InvalidRequestError('invalid_line');
  return Number(value.trim());
};

const assertWithinWidthBounds = (depthCm: number | undefined, variant: VariantInfo) => {
  if (depthCm === undefined) return;

  const depthMm = depthCm * 10;
  if (variant.minWidthMm !== null && depthMm < variant.minWidthMm) throw new InvalidRequestError('invalid_line');
  if (variant.maxWidthMm !== null && depthMm > variant.maxWidthMm) throw new InvalidRequestError('invalid_line');
};

export const isMaatwerkLine = (properties: Record<string, string>): boolean => properties._maatwerk === '1';

export const quoteCheckout = (request: CheckoutRequest, variants: Map<string, VariantInfo>): Quote => {
  if (!request.lines.some((line) => isMaatwerkLine(line.properties))) {
    throw new InvalidRequestError('no_maatwerk_line');
  }

  const lines: DraftLine[] = [];
  let computedCents = 0;

  for (const line of request.lines) {
    const variant = variants.get(line.variantId);
    if (!variant) throw new InvalidRequestError('invalid_line');

    if (!isMaatwerkLine(line.properties)) {
      lines.push({ ...line, priceOverrideCents: null });
      computedCents += variant.priceCents * line.quantity;
      continue;
    }

    const mode = line.properties._calc_mode;
    if (!isCalcMode(mode)) throw new InvalidRequestError('invalid_line');

    const depthCm = parseDimensionCm(line.properties._depth_cm);
    const lengthCm = parseDimensionCm(line.properties._length_cm);
    if (lengthCm === undefined) throw new InvalidRequestError('invalid_line');
    if (mode === 'sill_m2' && depthCm === undefined) throw new InvalidRequestError('invalid_line');

    assertWithinWidthBounds(depthCm, variant);

    const expectedLineCents = parseCents(line.properties._expected_line_cents);
    const lineCents = sillLineCents(mode, variant.priceCents, depthCm, lengthCm);
    if (!withinTolerance(lineCents, expectedLineCents)) throw new PriceMismatchError(expectedLineCents, lineCents);

    // The ERP reads quantity as pieces, so every piece becomes its own quantity-1 draft line.
    for (let piece = 0; piece < line.quantity; piece++) {
      lines.push({ ...line, quantity: 1, priceOverrideCents: lineCents });
    }

    computedCents += lineCents * line.quantity;
  }

  if (!withinTolerance(computedCents, request.expectedTotalCents)) {
    throw new PriceMismatchError(request.expectedTotalCents, computedCents);
  }

  return { lines, computedCents };
};
