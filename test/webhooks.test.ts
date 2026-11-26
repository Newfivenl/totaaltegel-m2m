import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { checkMaatwerkBypass } from '../src/webhooks';

const SECRET = 'webhook-secret';
const ORDER_GID = 'gid://shopify/Order/1001';

type GraphqlCall = { query: string; variables: Record<string, any> };

let calls: GraphqlCall[];
let fulfillmentOrders: { id: string; status: string; fulfillmentHolds: { handle: string | null }[] }[];

const env = () =>
  ({
    SHOPIFY_SHOP: 'totaaltegel.myshopify.com',
    SHOPIFY_ADMIN_ACCESS_TOKEN: 'test-token',
    SHOPIFY_CLIENT_SECRET: SECRET,
    SHOPIFY_API_VERSION: '2026-10',
    ALLOWED_ORIGINS: 'https://www.totaaltegel.nl',
    CHECKOUT_RATE_LIMITER: { limit: async () => ({ success: true }) },
  }) as unknown as Env;

const sillLine = (price: string, expected = '6800') => ({
  price,
  quantity: 1,
  properties: [
    { name: '_maatwerk', value: '1' },
    { name: '_expected_line_cents', value: expected },
    { name: 'Lengte', value: '200 cm' },
  ],
});

const tileLine = { price: '45.00', quantity: 2, properties: [] };

const order = (overrides: Record<string, unknown> = {}) => ({
  admin_graphql_api_id: ORDER_GID,
  name: '#1001',
  source_name: 'shopify_draft_order',
  line_items: [sillLine('68.00')],
  ...overrides,
});

const sign = async (body: string, secret = SECRET) => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
};

const deliver = async (payload: unknown, { secret = SECRET, shop = 'totaaltegel.myshopify.com' } = {}) => {
  const body = JSON.stringify(payload);
  return worker.fetch(
    new Request('https://worker.test/webhooks/orders-create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Hmac-Sha256': await sign(body, secret),
        'X-Shopify-Shop-Domain': shop,
        'X-Shopify-Topic': 'orders/create',
      },
      body,
    }),
    env(),
  );
};

const mutations = (name: string) => calls.filter((call) => call.query.includes(name));

beforeEach(() => {
  calls = [];
  fulfillmentOrders = [{ id: 'gid://shopify/FulfillmentOrder/1', status: 'OPEN', fulfillmentHolds: [] }];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const call = JSON.parse(String(init.body)) as GraphqlCall;
      calls.push(call);

      if (call.query.includes('query MaatwerkOrder(')) {
        return Response.json({ data: { order: { id: ORDER_GID, fulfillmentOrders: { nodes: fulfillmentOrders } } } });
      }
      if (call.query.includes('tagsAdd')) return Response.json({ data: { tagsAdd: { userErrors: [] } } });
      return Response.json({ data: { fulfillmentOrderHold: { userErrors: [] } } });
    }),
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('checkMaatwerkBypass', () => {
  it('accepts a draft-order maatwerk line charged at the expected price', () => {
    expect(checkMaatwerkBypass(order())).toEqual({ bypassed: false, reasons: [] });
  });

  it('ignores orders without maatwerk lines', () => {
    expect(checkMaatwerkBypass(order({ source_name: 'web', line_items: [tileLine] })).bypassed).toBe(false);
  });

  it('flags a maatwerk line charged at the catalog price', () => {
    const check = checkMaatwerkBypass(order({ source_name: 'web', line_items: [sillLine('0.85')] }));

    expect(check.bypassed).toBe(true);
    expect(check.reasons).toEqual(['source:web', 'price:85!=6800']);
  });

  it('flags a correctly priced maatwerk line that did not come from a draft', () => {
    expect(checkMaatwerkBypass(order({ source_name: 'web' })).reasons).toEqual(['source:web']);
  });

  it('flags a hand-posted tile line with an ERP size but no _maatwerk', () => {
    const forged = { price: '47.01', quantity: 1, properties: [{ name: '_area_m2', value: '500' }, { name: '_boxes', value: '348' }] };
    const check = checkMaatwerkBypass(order({ source_name: 'web', line_items: [forged] }));

    expect(check.bypassed).toBe(true);
    expect(check.reasons).toEqual(['source:web', 'price:4701!=unknown']);
  });

  it('flags a draft line whose expected price is not plain digits', () => {
    const check = checkMaatwerkBypass(order({ line_items: [sillLine('68.00', '0x1a90')] }));
    expect(check.reasons).toEqual(['price:6800!=unknown']);
  });

  it('flags a line with a near-duplicate _expected_line_cents', () => {
    const line = sillLine('68.00');
    line.properties.push({ name: ' _Expected_line_cents', value: '1' });
    expect(checkMaatwerkBypass(order({ line_items: [line] })).bypassed).toBe(true);
  });

  it('checks a line whose _maatwerk is written differently', () => {
    const line = { price: '0.85', quantity: 1, properties: [{ name: '_Maatwerk ', value: ' 1' }] };
    expect(checkMaatwerkBypass(order({ source_name: 'web', line_items: [line] })).bypassed).toBe(true);
  });

  it('flags a hand-posted line with a near-duplicate ERP key', () => {
    const forged = { price: '47.01', quantity: 1, properties: [{ name: ' _AREA_M2', value: '500' }] };
    expect(checkMaatwerkBypass(order({ source_name: 'web', line_items: [forged] })).bypassed).toBe(true);
  });

  it('accepts a draft-order tile line charged at the expected price', () => {
    const tile = {
      price: '2369.30',
      quantity: 1,
      properties: [
        { name: '_maatwerk', value: '1' },
        { name: '_calc_mode', value: 'tiles' },
        { name: '_area_m2', value: '50.4' },
        { name: '_boxes', value: '35' },
        { name: '_expected_line_cents', value: '236930' },
      ],
    };
    expect(checkMaatwerkBypass(order({ line_items: [tile] }))).toEqual({ bypassed: false, reasons: [] });
  });

  it('accepts a quote draft whose sill price staff changed', () => {
    const check = checkMaatwerkBypass(order({ tags: 'VIP, offerte-aanvraag', line_items: [sillLine('60.00')] }));
    expect(check).toEqual({ bypassed: false, reasons: [] });
  });

  it('still flags a quote-tagged order that did not come from a draft', () => {
    const check = checkMaatwerkBypass(order({ source_name: 'web', tags: 'offerte-aanvraag', line_items: [sillLine('0.85')] }));
    expect(check.reasons).toEqual(['source:web', 'price:85!=6800']);
  });
});

describe('orders/create webhook', () => {
  it('rejects a webhook with a wrong signature', async () => {
    const response = await deliver(order({ source_name: 'web' }), { secret: 'wrong' });

    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('does nothing for a correct draft-order maatwerk order', async () => {
    const response = await deliver(order());

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it('tags the order and holds its open fulfillment order on a bypass', async () => {
    const response = await deliver(order({ source_name: 'web', line_items: [sillLine('0.85'), tileLine] }));

    expect(response.status).toBe(200);
    expect(mutations('tagsAdd')[0]!.variables).toEqual({ id: ORDER_GID, tags: ['maatwerk-prijs-controle'] });

    const [hold] = mutations('fulfillmentOrderHold');
    expect(hold!.variables.id).toBe('gid://shopify/FulfillmentOrder/1');
    expect(hold!.variables.hold).toMatchObject({ handle: 'maatwerk-prijs-controle', reason: 'OTHER', notifyMerchant: true });
  });

  it('does not hold the same fulfillment order twice on a redelivery', async () => {
    fulfillmentOrders = [
      { id: 'gid://shopify/FulfillmentOrder/1', status: 'ON_HOLD', fulfillmentHolds: [{ handle: 'maatwerk-prijs-controle' }] },
    ];

    const response = await deliver(order({ source_name: 'web' }));

    expect(response.status).toBe(200);
    expect(mutations('fulfillmentOrderHold')).toHaveLength(0);
  });

  it('asks Shopify to retry when fulfillment orders do not exist yet', async () => {
    fulfillmentOrders = [];

    const response = await deliver(order({ source_name: 'web' }));
    expect(response.status).toBe(500);
  });

  it('ignores webhooks for another shop', async () => {
    const response = await deliver(order({ source_name: 'web' }), { shop: 'other.myshopify.com' });

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(0);
  });
});
