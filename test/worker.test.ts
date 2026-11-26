import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

const SILL_VARIANT = 44000000000001;
const MITER_VARIANT = 44000000000002;
const DORPEL_VARIANT = 44000000000003;
const TILE_VARIANT = 44000000000004;
const NO_BOX_TILE_VARIANT = 44000000000005;
const ORIGIN = 'https://www.totaaltegel.nl';

const variantNodes: Record<number, { price: string; minWidth?: string; maxWidth?: string; boxM2?: string; template?: string }> = {
  [SILL_VARIANT]: { price: '0.85', minWidth: '100', maxWidth: '600', template: 'vensterbank' },
  [MITER_VARIANT]: { price: '15.00' },
  [DORPEL_VARIANT]: { price: '85.47', template: 'raamdorpel' },
  [TILE_VARIANT]: { price: '47.01', boxM2: '1.44' },
  [NO_BOX_TILE_VARIANT]: { price: '47.01' },
};

type GraphqlCall = { query: string; variables: Record<string, any> };

const ACCESS_TOKEN = 'offline-access-token';

let calls: GraphqlCall[];
let adminTokens: (string | null)[];
let openDrafts: { id: string; status: string; customAttributes: { key: string; value: string }[] }[];
let rateLimitOk: boolean;

const env = () =>
  ({
    SHOPIFY_SHOP: 'totaaltegel.myshopify.com',
    SHOPIFY_ADMIN_ACCESS_TOKEN: ACCESS_TOKEN,
    SHOPIFY_API_VERSION: '2026-10',
    ALLOWED_ORIGINS: 'https://www.totaaltegel.nl,http://127.0.0.1:9292',
    CHECKOUT_RATE_LIMITER: { limit: async () => ({ success: rateLimitOk }) },
  }) as unknown as Env;

const shopifyFetch = async (_url: string, init: RequestInit) => {
  adminTokens.push(new Headers(init.headers).get('X-Shopify-Access-Token'));
  const call = JSON.parse(String(init.body)) as GraphqlCall;
  calls.push(call);

  if (call.query.includes('MaatwerkVariants')) {
    const nodes = call.variables.ids.map((gid: string) => {
      const id = Number(gid.split('/').pop());
      const variant = variantNodes[id];
      if (!variant) return null;

      return {
        id: gid,
        price: variant.price,
        minWidth: variant.minWidth ? { value: variant.minWidth } : null,
        maxWidth: variant.maxWidth ? { value: variant.maxWidth } : null,
        boxM2: variant.boxM2 ? { value: variant.boxM2 } : null,
        product: { templateSuffix: variant.template ?? null },
      };
    });
    return Response.json({ data: { nodes } });
  }

  if (call.query.includes('OpenMaatwerkDrafts')) {
    return Response.json({ data: { draftOrders: { nodes: openDrafts } } });
  }

  const draftOrder = { id: 'gid://shopify/DraftOrder/1', name: '#D1', invoiceUrl: 'https://invoice.test/1', status: 'OPEN' };
  const key = call.query.includes('draftOrderUpdate') ? 'draftOrderUpdate' : 'draftOrderCreate';
  return Response.json({ data: { [key]: { draftOrder, userErrors: [] } } });
};

const sillLine = (overrides: Record<string, string> = {}, quantity = 1) => ({
  variantId: SILL_VARIANT,
  quantity,
  properties: {
    _maatwerk: '1',
    _calc_mode: 'sill_m2',
    _depth_cm: '40',
    _length_cm: '200',
    _expected_line_cents: '6800',
    _line_uid: 'abc',
    Dikte: '3 cm',
    Diepte: '40 cm',
    Lengte: '200 cm',
    ...overrides,
  },
});

const tileLine = (overrides: Record<string, string> = {}, variantId = TILE_VARIANT) => ({
  variantId,
  quantity: 1,
  properties: {
    _maatwerk: '1',
    _calc_mode: 'tiles',
    _boxes: '35',
    _area_m2: '50.4',
    _expected_line_cents: '236930',
    Oppervlakte: '50,4 m²',
    Dozen: '35',
    ...overrides,
  },
});

const miterLine = { variantId: MITER_VARIANT, quantity: 1, properties: { _addon: 'miter', _parent_uid: 'abc', _line_uid: 'abc-x0' } };

const checkout = (body: Record<string, unknown>, origin: string | null = ORIGIN, method = 'POST') =>
  worker.fetch(
    new Request('https://worker.test/maatwerk-checkout', {
      method,
      headers: { 'Content-Type': 'application/json', ...(origin && { Origin: origin }) },
      body: method === 'POST' ? JSON.stringify({ cartToken: 'cart-1', ...body }) : undefined,
    }),
    env(),
  );

const mutationCall = () => calls.find((call) => call.query.includes('mutation'));

beforeEach(() => {
  calls = [];
  adminTokens = [];
  openDrafts = [];
  rateLimitOk = true;
  vi.stubGlobal('fetch', vi.fn(shopifyFetch));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('draft lines', () => {
  it('sets a price override of 68.00 on a 40 x 200 cm vensterbank', async () => {
    const response = await checkout({ expectedTotalCents: 6800, lines: [sillLine()] });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ invoiceUrl: 'https://invoice.test/1' });

    const [lineItem] = mutationCall()!.variables.input.lineItems;
    expect(lineItem).toMatchObject({
      variantId: `gid://shopify/ProductVariant/${SILL_VARIANT}`,
      quantity: 1,
      priceOverride: { amount: '68.00', currencyCode: 'EUR' },
    });
    expect(lineItem.customAttributes).toContainEqual({ key: 'Lengte', value: '200 cm' });
  });

  it('gives two pieces of the same cut two quantity-1 lines with the same override', async () => {
    const response = await checkout({
      expectedTotalCents: 13_600,
      lines: [sillLine({ _line_uid: 'a' }), sillLine({ _line_uid: 'b' })],
    });

    expect(response.status).toBe(200);
    const { lineItems } = mutationCall()!.variables.input;
    expect(lineItems).toHaveLength(2);
    for (const lineItem of lineItems) {
      expect(lineItem.quantity).toBe(1);
      expect(lineItem.priceOverride.amount).toBe('68.00');
    }
  });

  it('splits a sill line with quantity 2 into two quantity-1 lines', async () => {
    const response = await checkout({ expectedTotalCents: 13_600, lines: [sillLine({}, 2)] });

    expect(response.status).toBe(200);
    const { lineItems } = mutationCall()!.variables.input;
    expect(lineItems.map((lineItem: any) => lineItem.quantity)).toEqual([1, 1]);
  });

  it('prices a raamdorpel at 128.21', async () => {
    const response = await checkout({
      expectedTotalCents: 12_821,
      lines: [
        {
          variantId: DORPEL_VARIANT,
          quantity: 1,
          properties: { _maatwerk: '1', _calc_mode: 'sill_m1', _length_cm: '150', _expected_line_cents: '12821' },
        },
      ],
    });

    expect(response.status).toBe(200);
    expect(mutationCall()!.variables.input.lineItems[0].priceOverride.amount).toBe('128.21');
  });

  it('only overrides the sill; the miter keeps its catalog price', async () => {
    const response = await checkout({ expectedTotalCents: 6800 + 1500, lines: [sillLine(), miterLine] });

    expect(response.status).toBe(200);
    const [sill, miter] = mutationCall()!.variables.input.lineItems;
    expect(sill.priceOverride.amount).toBe('68.00');
    expect(miter).not.toHaveProperty('priceOverride');
    expect(miter.quantity).toBe(1);
  });
});

describe('tile lines', () => {
  it('prices 35 boxes of 1,44 m² at 47,01 as one line of 2.369,30', async () => {
    const response = await checkout({ expectedTotalCents: 236_930, lines: [tileLine()] });

    expect(response.status).toBe(200);
    const [lineItem] = mutationCall()!.variables.input.lineItems;
    expect(lineItem).toMatchObject({
      variantId: `gid://shopify/ProductVariant/${TILE_VARIANT}`,
      quantity: 1,
      priceOverride: { amount: '2369.30', currencyCode: 'EUR' },
    });
    expect(lineItem.customAttributes).toContainEqual({ key: '_area_m2', value: '50.4' });
    expect(lineItem.customAttributes).toContainEqual({ key: '_boxes', value: '35' });
  });

  it('returns 409 when _expected_line_cents does not match the box price', async () => {
    const response = await checkout({ expectedTotalCents: 230_349, lines: [tileLine({ _expected_line_cents: '230349' })] });

    expect(response.status).toBe(409);
    expect(mutationCall()).toBeUndefined();
  });

  it('returns 400 when _area_m2 is not the m² in the boxes', async () => {
    const response = await checkout({ expectedTotalCents: 236_930, lines: [tileLine({ _area_m2: '49' })] });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_line' });
  });

  it.each(['035', ' 35', '0'])('returns 400 for _boxes %j', async (boxes) => {
    const response = await checkout({ expectedTotalCents: 236_930, lines: [tileLine({ _boxes: boxes })] });

    expect(response.status).toBe(400);
  });

  it('returns 400 for a fractional box count', async () => {
    const response = await checkout({ expectedTotalCents: 236_930, lines: [tileLine({ _boxes: '34.5' })] });

    expect(response.status).toBe(400);
  });

  it('returns 400 for a tile bought as a 1 cm raamdorpel', async () => {
    const response = await checkout({
      expectedTotalCents: 47,
      lines: [tileLine({ _calc_mode: 'sill_m1', _length_cm: '1', _expected_line_cents: '47' })],
    });

    expect(response.status).toBe(400);
  });

  it('returns 400 for a sill priced as tile boxes', async () => {
    const response = await checkout({ expectedTotalCents: 236_930, lines: [tileLine({}, SILL_VARIANT)] });

    expect(response.status).toBe(400);
  });

  it('returns 400 for a catalog-priced line carrying an ERP size', async () => {
    const forged = { variantId: TILE_VARIANT, quantity: 1, properties: { _area_m2: '500', _boxes: '348' } };
    const response = await checkout({ expectedTotalCents: 4701, lines: [forged] });

    expect(response.status).toBe(400);
  });

  it.each(['5.04e1', '0x32', '50,4', ' 50.4abc'])('returns 400 for _area_m2 %j', async (area) => {
    const response = await checkout({ expectedTotalCents: 236_930, lines: [tileLine({ _area_m2: area })] });

    expect(response.status).toBe(400);
  });

  it('returns 400 for a catalog-priced line with a near-duplicate ERP key', async () => {
    const forged = { variantId: TILE_VARIANT, quantity: 1, properties: { '_Area_m2 ': '500' } };
    const response = await checkout({ expectedTotalCents: 4701, lines: [forged] });

    expect(response.status).toBe(400);
  });

  it('returns 400 for a tile line with a near-duplicate _area_m2 key', async () => {
    const response = await checkout({ expectedTotalCents: 236_930, lines: [tileLine({ '_area_m2 ': '500' })] });

    expect(response.status).toBe(400);
  });

  it('writes its own area into the draft line', async () => {
    const response = await checkout({ expectedTotalCents: 236_930, lines: [tileLine({ _area_m2: '50.400' })] });

    expect(response.status).toBe(200);
    expect(mutationCall()!.variables.input.lineItems[0].customAttributes).toContainEqual({ key: '_area_m2', value: '50.4' });
  });

  it('returns 400 when the variant has no m² per box', async () => {
    const response = await checkout({ expectedTotalCents: 236_930, lines: [tileLine({}, NO_BOX_TILE_VARIANT)] });

    expect(response.status).toBe(400);
  });
});

describe('draft settings', () => {
  it('tags the draft, links the cart token and the customer, and keeps discounts on', async () => {
    await checkout({
      expectedTotalCents: 6800,
      customerId: 123,
      email: 'klant@example.com',
      discountCodes: ['WINTER10'],
      lines: [sillLine()],
    });

    const { input } = mutationCall()!.variables;
    expect(input).toMatchObject({
      presentmentCurrencyCode: 'EUR',
      acceptAutomaticDiscounts: true,
      allowDiscountCodesInCheckout: true,
      discountCodes: ['WINTER10'],
      tags: ['maatwerk-storefront'],
      customAttributes: [{ key: 'cart_token', value: 'cart-1' }],
      purchasingEntity: { customerId: 'gid://shopify/Customer/123' },
      email: 'klant@example.com',
    });
    expect(input).not.toHaveProperty('shippingLine');
    expect(input).not.toHaveProperty('reserveInventoryUntil');
  });

  it('updates the open draft for the same cart instead of creating a second one', async () => {
    openDrafts = [
      { id: 'gid://shopify/DraftOrder/9', status: 'OPEN', customAttributes: [{ key: 'cart_token', value: 'other' }] },
      { id: 'gid://shopify/DraftOrder/7', status: 'OPEN', customAttributes: [{ key: 'cart_token', value: 'cart-1' }] },
    ];

    await checkout({ expectedTotalCents: 6800, lines: [sillLine()] });

    const mutation = mutationCall()!;
    expect(mutation.query).toContain('draftOrderUpdate');
    expect(mutation.variables.id).toBe('gid://shopify/DraftOrder/7');
  });

  it('creates a new draft when the matching draft is already completed', async () => {
    openDrafts = [
      { id: 'gid://shopify/DraftOrder/7', status: 'COMPLETED', customAttributes: [{ key: 'cart_token', value: 'cart-1' }] },
    ];

    await checkout({ expectedTotalCents: 6800, lines: [sillLine()] });

    expect(mutationCall()!.query).toContain('draftOrderCreate');
  });
});

describe('rejections', () => {
  it('returns 409 without a mutation when _expected_line_cents was tampered with', async () => {
    const response = await checkout({
      expectedTotalCents: 100,
      lines: [sillLine({ _expected_line_cents: '100' })],
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'price_mismatch', expectedCents: 100, computedCents: 6800 });
    expect(mutationCall()).toBeUndefined();
  });

  it('returns 409 when the cart total is off by more than 1 cent', async () => {
    const response = await checkout({ expectedTotalCents: 8500, lines: [sillLine(), miterLine] });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'price_mismatch', expectedCents: 8500, computedCents: 8300 });
    expect(mutationCall()).toBeUndefined();
  });

  it('accepts a 1 cent difference', async () => {
    const response = await checkout({ expectedTotalCents: 6801, lines: [sillLine({ _expected_line_cents: '6799' })] });
    expect(response.status).toBe(200);
  });

  it('returns 400 when _length_cm is missing', async () => {
    const response = await checkout({ expectedTotalCents: 6800, lines: [sillLine({ _length_cm: '' })] });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_line' });
    expect(mutationCall()).toBeUndefined();
  });

  it('returns 400 when the depth is outside the ERP width bounds', async () => {
    const response = await checkout({
      expectedTotalCents: 12_750,
      lines: [sillLine({ _depth_cm: '75', _expected_line_cents: '12750' })],
    });

    expect(response.status).toBe(400);
  });

  it('returns 400 for an unknown variant', async () => {
    const response = await checkout({ expectedTotalCents: 6800, lines: [{ ...sillLine(), variantId: 1 }] });
    expect(response.status).toBe(400);
  });

  it('returns 400 when the cart has no maatwerk line', async () => {
    const response = await checkout({ expectedTotalCents: 1500, lines: [miterLine] });
    expect(await response.json()).toEqual({ error: 'no_maatwerk_line' });
  });

  it('returns 500 draft_failed when Shopify returns user errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        if (!String(init.body).includes('mutation')) return shopifyFetch(url, init);
        return Response.json({ data: { draftOrderCreate: { draftOrder: null, userErrors: [{ field: null, message: 'nope' }] } } });
      }),
    );

    const response = await checkout({ expectedTotalCents: 6800, lines: [sillLine()] });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'draft_failed' });
  });
});

const customer = {
  name: 'Jan de Vries',
  email: 'jan@example.com',
  phone: '06 12345678',
  address: 'Dorpsstraat 1',
  zip: '5973 AA',
  city: 'Hegelsom',
};

const quoteRequest = (body: Record<string, unknown>, origin: string | null = ORIGIN) =>
  worker.fetch(
    new Request('https://worker.test/quote-request', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', ...(origin && { Origin: origin }) },
      body: JSON.stringify({ customer, note: 'Vensterbank\n40 x 200 cm', ...body }),
    }),
    env(),
  );

describe('quote request', () => {
  it('creates a tagged draft with the customer, address and note, without reusing an open draft', async () => {
    const response = await quoteRequest({ lines: [sillLine(), miterLine] });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
    expect(calls.some((call) => call.query.includes('OpenMaatwerkDrafts'))).toBe(false);

    const mutation = mutationCall()!;
    expect(mutation.query).toContain('draftOrderCreate');
    expect(mutation.variables.input).toMatchObject({
      presentmentCurrencyCode: 'EUR',
      tags: ['offerte-aanvraag', 'quote'],
      email: 'jan@example.com',
      note: 'Vensterbank\n40 x 200 cm',
      shippingAddress: {
        firstName: 'Jan',
        lastName: 'de Vries',
        address1: 'Dorpsstraat 1',
        zip: '5973 AA',
        city: 'Hegelsom',
        countryCode: 'NL',
      },
    });
    expect(mutation.variables.input.billingAddress).toEqual(mutation.variables.input.shippingAddress);
    expect(mutation.variables.input).not.toHaveProperty('phone');

    const [sill, miter] = mutation.variables.input.lineItems;
    expect(sill.priceOverride.amount).toBe('68.00');
    expect(miter).not.toHaveProperty('priceOverride');
  });

  it('uses the Worker price and rewrites _expected_line_cents to it', async () => {
    const response = await quoteRequest({ lines: [sillLine({ _expected_line_cents: '100' }, 2)] });

    expect(response.status).toBe(201);
    const { lineItems } = mutationCall()!.variables.input;
    expect(lineItems).toHaveLength(2);
    for (const lineItem of lineItems) {
      expect(lineItem.quantity).toBe(1);
      expect(lineItem.priceOverride.amount).toBe('68.00');
      expect(lineItem.customAttributes).toContainEqual({ key: '_expected_line_cents', value: '6800' });
    }
  });

  it('accepts a quote without maatwerk lines', async () => {
    const response = await quoteRequest({ lines: [{ variantId: MITER_VARIANT, quantity: 3, properties: { Oppervlakte: '24 m²' } }] });

    expect(response.status).toBe(201);
    expect(mutationCall()!.variables.input.lineItems[0]).toMatchObject({ quantity: 3 });
  });

  it('leaves out the address when the customer gave none', async () => {
    await quoteRequest({ customer: { ...customer, address: '' }, lines: [miterLine] });
    expect(mutationCall()!.variables.input).not.toHaveProperty('shippingAddress');
  });

  it('returns 400 without a valid email', async () => {
    const response = await quoteRequest({ customer: { ...customer, email: 'jan' }, lines: [miterLine] });

    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('returns 400 for a sill outside the ERP width bounds', async () => {
    const response = await quoteRequest({ lines: [sillLine({ _depth_cm: '75' })] });

    expect(response.status).toBe(400);
    expect(mutationCall()).toBeUndefined();
  });

  it('rejects other origins with 403', async () => {
    const response = await quoteRequest({ lines: [miterLine] }, 'https://evil.example');
    expect(response.status).toBe(403);
  });
});

describe('admin access token', () => {
  it('sends the stored access token on every Admin API call', async () => {
    await checkout({ expectedTotalCents: 6800, lines: [sillLine()] });

    expect(adminTokens).toHaveLength(3);
    expect(adminTokens.every((token) => token === ACCESS_TOKEN)).toBe(true);
  });

  it('returns 500 draft_failed when the IP allowlist rejects the Worker', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Forbidden', { status: 403 })));

    const response = await checkout({ expectedTotalCents: 6800, lines: [sillLine()] });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'draft_failed' });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('admin_http_403'));
  });

  it('returns 500 draft_failed when the token is revoked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Unauthorized', { status: 401 })));

    const response = await checkout({ expectedTotalCents: 6800, lines: [sillLine()] });

    expect(response.status).toBe(500);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('admin_http_401'));
  });
});

describe('access', () => {
  it('rejects other origins with 403', async () => {
    const response = await checkout({ expectedTotalCents: 6800, lines: [sillLine()] }, 'https://evil.example');
    expect(response.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('rejects requests without an origin', async () => {
    const response = await checkout({ expectedTotalCents: 6800, lines: [sillLine()] }, null);
    expect(response.status).toBe(403);
  });

  it('answers the CORS preflight for an allowed origin', async () => {
    const response = await checkout({}, 'http://127.0.0.1:9292', 'OPTIONS');

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://127.0.0.1:9292');
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('POST');
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
  });

  it('rejects GET', async () => {
    const response = await checkout({}, ORIGIN, 'GET');
    expect(response.status).toBe(405);
  });

  it('returns 429 when the rate limit is hit', async () => {
    rateLimitOk = false;
    const response = await checkout({ expectedTotalCents: 6800, lines: [sillLine()] });

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: 'rate_limited' });
  });

  it('never returns the draft id or the token', async () => {
    const response = await checkout({ expectedTotalCents: 6800, lines: [sillLine()] });
    const text = await response.text();

    expect(text).not.toContain('DraftOrder');
    expect(text).not.toContain(ACCESS_TOKEN);
  });
});
