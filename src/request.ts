export type CheckoutLine = {
  variantId: string;
  quantity: number;
  properties: Record<string, string>;
};

export type CheckoutRequest = {
  cartToken: string;
  customerId: string | null;
  email: string | null;
  discountCodes: string[];
  expectedTotalCents: number;
  lines: CheckoutLine[];
};

export type QuoteCustomer = {
  name: string;
  email: string;
  phone: string | null;
  address: string | null;
  zip: string | null;
  city: string | null;
};

export type QuoteRequest = {
  customer: QuoteCustomer;
  note: string;
  lines: CheckoutLine[];
};

export class InvalidRequestError extends Error {
  constructor(readonly code: 'invalid_request' | 'invalid_line' | 'no_maatwerk_line') {
    super(code);
  }
}

const MAX_LINES = 499;
const MAX_QUANTITY = 10_000;
const MAX_DISCOUNT_CODES = 10;
const MAX_STRING_LENGTH = 500;
const MAX_NOTE_LENGTH = 5000;
const MAX_QUOTE_LINES = 100;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isShortString = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= MAX_STRING_LENGTH;

const parseNumericId = (value: unknown): string | null => {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof id === 'string' && /^[1-9]\d{0,19}$/.test(id) ? id : null;
};

const parseProperties = (value: unknown): Record<string, string> => {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new InvalidRequestError('invalid_line');

  const properties: Record<string, string> = {};

  for (const [key, raw] of Object.entries(value)) {
    if (!isShortString(raw) || key.length === 0 || key.length > MAX_STRING_LENGTH) {
      throw new InvalidRequestError('invalid_line');
    }

    properties[key] = raw;
  }

  return properties;
};

const parseLine = (value: unknown): CheckoutLine => {
  if (!isRecord(value)) throw new InvalidRequestError('invalid_line');

  const variantId = parseNumericId(value.variantId);
  const { quantity } = value;

  if (!variantId) throw new InvalidRequestError('invalid_line');

  if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
    throw new InvalidRequestError('invalid_line');
  }

  return { variantId, quantity, properties: parseProperties(value.properties) };
};

const parseOptionalString = (value: unknown): string | null => {
  if (value === undefined || value === null || value === '') return null;
  if (!isShortString(value)) throw new InvalidRequestError('invalid_request');
  return value.trim() || null;
};

const parseDiscountCodes = (value: unknown): string[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_DISCOUNT_CODES) throw new InvalidRequestError('invalid_request');

  const codes: string[] = [];

  for (const code of value) {
    if (!isShortString(code)) throw new InvalidRequestError('invalid_request');
    if (code.trim()) codes.push(code.trim());
  }

  return [...new Set(codes)];
};

export const parseCheckoutRequest = (body: unknown): CheckoutRequest => {
  if (!isRecord(body)) throw new InvalidRequestError('invalid_request');

  const { cartToken, expectedTotalCents, lines } = body;

  if (!isShortString(cartToken) || cartToken.trim() === '') throw new InvalidRequestError('invalid_request');

  if (typeof expectedTotalCents !== 'number' || !Number.isSafeInteger(expectedTotalCents) || expectedTotalCents < 0) {
    throw new InvalidRequestError('invalid_request');
  }

  if (!Array.isArray(lines) || lines.length === 0 || lines.length > MAX_LINES) {
    throw new InvalidRequestError('invalid_request');
  }

  const customerId = body.customerId === undefined || body.customerId === null ? null : parseNumericId(body.customerId);
  if (customerId === null && body.customerId !== undefined && body.customerId !== null) {
    throw new InvalidRequestError('invalid_request');
  }

  return {
    cartToken,
    customerId,
    email: parseOptionalString(body.email),
    discountCodes: parseDiscountCodes(body.discountCodes),
    expectedTotalCents,
    lines: lines.map(parseLine),
  };
};

const parseRequiredString = (value: unknown): string => {
  const parsed = parseOptionalString(value);
  if (!parsed) throw new InvalidRequestError('invalid_request');
  return parsed;
};

const parseQuoteCustomer = (value: unknown): QuoteCustomer => {
  if (!isRecord(value)) throw new InvalidRequestError('invalid_request');

  const email = parseRequiredString(value.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new InvalidRequestError('invalid_request');

  return {
    name: parseRequiredString(value.name),
    email,
    phone: parseOptionalString(value.phone),
    address: parseOptionalString(value.address),
    zip: parseOptionalString(value.zip),
    city: parseOptionalString(value.city),
  };
};

export const parseQuoteRequest = (body: unknown): QuoteRequest => {
  if (!isRecord(body)) throw new InvalidRequestError('invalid_request');

  const { lines, note } = body;

  if (!Array.isArray(lines) || lines.length === 0 || lines.length > MAX_QUOTE_LINES) {
    throw new InvalidRequestError('invalid_request');
  }

  if (note !== undefined && (typeof note !== 'string' || note.length > MAX_NOTE_LENGTH)) {
    throw new InvalidRequestError('invalid_request');
  }

  return {
    customer: parseQuoteCustomer(body.customer),
    note: typeof note === 'string' ? note.trim() : '',
    lines: lines.map(parseLine),
  };
};
