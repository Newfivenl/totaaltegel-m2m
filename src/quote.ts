import { isCalcMode, sillLineCents, tileAreaThousandths, tileLineCents, withinTolerance } from './pricing';
import { type CheckoutLine, type CheckoutRequest, InvalidRequestError } from './request';

export type VariantInfo = {
  priceCents: number;
  minWidthMm: number | null;
  maxWidthMm: number | null;
  /** m² per box (`erp.pieces_per_box`); null when the variant has none. */
  boxM2: number | null;
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
const MAX_BOXES = 10_000;
const TILE_CALC_MODE = 'tiles';

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

const sillPieceCents = (properties: Record<string, string>, variant: VariantInfo): number => {
  const mode = properties._calc_mode;
  if (!isCalcMode(mode)) throw new InvalidRequestError('invalid_line');

  const depthCm = parseDimensionCm(properties._depth_cm);
  const lengthCm = parseDimensionCm(properties._length_cm);
  if (lengthCm === undefined) throw new InvalidRequestError('invalid_line');
  if (mode === 'sill_m2' && depthCm === undefined) throw new InvalidRequestError('invalid_line');

  assertWithinWidthBounds(depthCm, variant);
  return sillLineCents(mode, variant.priceCents, depthCm, lengthCm);
};

const parseBoxes = (value: string | undefined): number => {
  if (value === undefined || !/^\d+$/.test(value.trim())) throw new InvalidRequestError('invalid_line');

  const boxes = Number(value.trim());
  if (boxes < 1 || boxes > MAX_BOXES) throw new InvalidRequestError('invalid_line');
  return boxes;
};

const parseAreaThousandths = (value: string | undefined): number => {
  const m2 = Number((value ?? '').trim().replace(',', '.'));
  if (!Number.isFinite(m2) || m2 <= 0) throw new InvalidRequestError('invalid_line');
  return Math.round(m2 * 1000);
};

// The area comes from the box count and the variant's own box size, never from the client.
// `_area_m2` must still match it, because the ERP reads the m² from that property.
const tileLineCentsFor = (properties: Record<string, string>, variant: VariantInfo): number => {
  if (variant.boxM2 === null) throw new InvalidRequestError('invalid_line');

  const boxes = parseBoxes(properties._boxes);
  if (parseAreaThousandths(properties._area_m2) !== tileAreaThousandths(boxes, variant.boxM2)) {
    throw new InvalidRequestError('invalid_line');
  }
  return tileLineCents(variant.priceCents, boxes, variant.boxM2);
};

const maatwerkLineCents = (properties: Record<string, string>, variant: VariantInfo): number =>
  properties._calc_mode === TILE_CALC_MODE ? tileLineCentsFor(properties, variant) : sillPieceCents(properties, variant);

// The ERP reads quantity as pieces, so every piece becomes its own quantity-1 draft line.
const pushPieces = (lines: DraftLine[], line: CheckoutLine, properties: Record<string, string>, pieceCents: number) => {
  for (let piece = 0; piece < line.quantity; piece++) {
    lines.push({ ...line, properties, quantity: 1, priceOverrideCents: pieceCents });
  }
};

const variantFor = (variants: Map<string, VariantInfo>, line: CheckoutLine): VariantInfo => {
  const variant = variants.get(line.variantId);
  if (!variant) throw new InvalidRequestError('invalid_line');
  return variant;
};

export const quoteCheckout = (request: CheckoutRequest, variants: Map<string, VariantInfo>): Quote => {
  if (!request.lines.some((line) => isMaatwerkLine(line.properties))) {
    throw new InvalidRequestError('no_maatwerk_line');
  }

  const lines: DraftLine[] = [];
  let computedCents = 0;

  for (const line of request.lines) {
    const variant = variantFor(variants, line);

    if (!isMaatwerkLine(line.properties)) {
      lines.push({ ...line, priceOverrideCents: null });
      computedCents += variant.priceCents * line.quantity;
      continue;
    }

    const expectedLineCents = parseCents(line.properties._expected_line_cents);
    const lineCents = maatwerkLineCents(line.properties, variant);
    if (!withinTolerance(lineCents, expectedLineCents)) throw new PriceMismatchError(expectedLineCents, lineCents);

    pushPieces(lines, line, line.properties, lineCents);
    computedCents += lineCents * line.quantity;
  }

  if (!withinTolerance(computedCents, request.expectedTotalCents)) {
    throw new PriceMismatchError(request.expectedTotalCents, computedCents);
  }

  return { lines, computedCents };
};

// Quotes carry no client price to compare against: the Worker price wins, and `_expected_line_cents`
// is rewritten to it so the orders/create safety net accepts the paid draft.
export const quoteRequestLines = (requestLines: CheckoutLine[], variants: Map<string, VariantInfo>): Quote => {
  const lines: DraftLine[] = [];
  let computedCents = 0;

  for (const line of requestLines) {
    const variant = variantFor(variants, line);

    if (!isMaatwerkLine(line.properties)) {
      lines.push({ ...line, priceOverrideCents: null });
      computedCents += variant.priceCents * line.quantity;
      continue;
    }

    const lineCents = maatwerkLineCents(line.properties, variant);
    pushPieces(lines, line, { ...line.properties, _expected_line_cents: String(lineCents) }, lineCents);
    computedCents += lineCents * line.quantity;
  }

  return { lines, computedCents };
};
