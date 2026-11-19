import { moneyToCents, withinTolerance } from './pricing';
import { adminGraphql, ShopifyError, type UserError } from './shopify';

export const BYPASS_TAG = 'maatwerk-prijs-controle';
const HOLD_HANDLE = 'maatwerk-prijs-controle';
const DRAFT_ORDER_SOURCE = 'shopify_draft_order';
const HOLDABLE_STATUSES = new Set(['OPEN', 'SCHEDULED']);

const encoder = new TextEncoder();

type WebhookLineItem = {
  price?: string;
  properties?: { name: string; value: unknown }[];
};

type OrderWebhook = {
  admin_graphql_api_id?: string;
  name?: string;
  source_name?: string;
  line_items?: WebhookLineItem[];
};

export type BypassCheck = { bypassed: boolean; reasons: string[] };

const log = (event: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ event, ...fields }));

const base64ToBytes = (base64: string): Uint8Array | null => {
  try {
    return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
};

export const verifyWebhookHmac = async (body: ArrayBuffer, header: string | null, secret: string): Promise<boolean> => {
  const signature = base64ToBytes(header ?? '');
  if (!signature || !secret) return false;

  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'verify',
  ]);
  return crypto.subtle.verify('HMAC', key, signature, body);
};

const property = (line: WebhookLineItem, name: string): string | undefined => {
  const match = line.properties?.find((entry) => entry.name === name);
  return match === undefined ? undefined : String(match.value);
};

// A maatwerk line only has the right price if it came through the draft order with priceOverride.
// Any other path (direct /checkout, old links) charges the shared catalog price.
export const checkMaatwerkBypass = (order: OrderWebhook): BypassCheck => {
  const maatwerkLines = (order.line_items ?? []).filter((line) => property(line, '_maatwerk') === '1');
  if (!maatwerkLines.length) return { bypassed: false, reasons: [] };

  const reasons: string[] = [];
  if (order.source_name !== DRAFT_ORDER_SOURCE) reasons.push(`source:${order.source_name ?? 'unknown'}`);

  for (const line of maatwerkLines) {
    const expected = Number(property(line, '_expected_line_cents'));
    const charged = moneyToCents(line.price ?? '');

    if (!Number.isFinite(expected) || !Number.isFinite(charged) || !withinTolerance(expected, charged)) {
      reasons.push(`price:${Number.isFinite(charged) ? charged : 'unknown'}!=${Number.isFinite(expected) ? expected : 'unknown'}`);
    }
  }

  return { bypassed: reasons.length > 0, reasons };
};

const ORDER_QUERY = /* GraphQL */ `
  query MaatwerkOrder($id: ID!) {
    order(id: $id) {
      id
      fulfillmentOrders(first: 20) {
        nodes {
          id
          status
          fulfillmentHolds {
            handle
          }
        }
      }
    }
  }
`;

const TAG_MUTATION = /* GraphQL */ `
  mutation TagMaatwerkOrder($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      userErrors {
        field
        message
      }
    }
  }
`;

const HOLD_MUTATION = /* GraphQL */ `
  mutation HoldMaatwerkOrder($id: ID!, $hold: FulfillmentOrderHoldInput!) {
    fulfillmentOrderHold(id: $id, fulfillmentHold: $hold) {
      userErrors {
        field
        message
      }
    }
  }
`;

type FulfillmentOrderNode = { id: string; status: string; fulfillmentHolds: { handle: string | null }[] };

const assertNoUserErrors = (operation: string, userErrors: UserError[]) => {
  if (userErrors.length) throw new ShopifyError(`${operation}: ${userErrors.map((error) => error.message).join('; ')}`);
};

const tagAndHold = async (env: Env, orderId: string, reasons: string[]): Promise<number> => {
  const tagged = await adminGraphql<{ tagsAdd: { userErrors: UserError[] } }>(env, TAG_MUTATION, {
    id: orderId,
    tags: [BYPASS_TAG],
  });
  assertNoUserErrors('tagsAdd', tagged.tagsAdd.userErrors);

  const data = await adminGraphql<{ order: { fulfillmentOrders: { nodes: FulfillmentOrderNode[] } } | null }>(
    env,
    ORDER_QUERY,
    { id: orderId },
  );
  const fulfillmentOrders = data.order?.fulfillmentOrders.nodes ?? [];
  // Fulfillment orders are created right after the order; an empty list makes Shopify retry the webhook.
  if (!fulfillmentOrders.length) throw new ShopifyError('no_fulfillment_orders_yet');

  let held = 0;

  for (const fulfillmentOrder of fulfillmentOrders) {
    if (!HOLDABLE_STATUSES.has(fulfillmentOrder.status)) continue;
    if (fulfillmentOrder.fulfillmentHolds.some((hold) => hold.handle === HOLD_HANDLE)) continue;

    const result = await adminGraphql<{ fulfillmentOrderHold: { userErrors: UserError[] } }>(env, HOLD_MUTATION, {
      id: fulfillmentOrder.id,
      hold: {
        handle: HOLD_HANDLE,
        reason: 'OTHER',
        reasonNotes: `Maatwerk niet via conceptorder afgerekend (${reasons.join(', ')}). Controleer de prijs.`,
        notifyMerchant: true,
      },
    });
    assertNoUserErrors('fulfillmentOrderHold', result.fulfillmentOrderHold.userErrors);
    held++;
  }

  return held;
};

export const handleOrderCreated = async (request: Request, env: Env): Promise<Response> => {
  const body = await request.arrayBuffer();
  const valid = await verifyWebhookHmac(body, request.headers.get('X-Shopify-Hmac-Sha256'), env.SHOPIFY_CLIENT_SECRET);
  if (!valid) return new Response(null, { status: 401 });
  if (request.headers.get('X-Shopify-Shop-Domain') !== env.SHOPIFY_SHOP) return new Response(null, { status: 200 });

  let order: OrderWebhook;
  try {
    order = JSON.parse(new TextDecoder().decode(body)) as OrderWebhook;
  } catch {
    return new Response(null, { status: 400 });
  }

  const check = checkMaatwerkBypass(order);
  if (!check.bypassed) {
    if (order.line_items?.some((line) => property(line, '_maatwerk') === '1')) {
      log('maatwerk_order_ok', { order: order.name, source: order.source_name });
    }
    return new Response(null, { status: 200 });
  }

  if (!order.admin_graphql_api_id) return new Response(null, { status: 400 });

  try {
    const held = await tagAndHold(env, order.admin_graphql_api_id, check.reasons);
    log('maatwerk_bypass_held', { order: order.name, reasons: check.reasons, heldFulfillmentOrders: held });
    return new Response(null, { status: 200 });
  } catch (error) {
    log('maatwerk_bypass_hold_failed', {
      order: order.name,
      reasons: check.reasons,
      message: error instanceof Error ? error.message : String(error),
    });
    return new Response(null, { status: 500 });
  }
};
