import { PriceMismatchError, quoteCheckout, quoteRequestLines } from './quote';
import { InvalidRequestError, parseCheckoutRequest, parseQuoteRequest } from './request';
import { buildDraftInput, buildQuoteDraftInput, fetchVariants, findOpenDraftId, saveDraft } from './shopify';
import { handleOrderCreated } from './webhooks';

const CHECKOUT_ROUTE = '/maatwerk-checkout';
const QUOTE_ROUTE = '/quote-request';
const ORDERS_CREATE_WEBHOOK = '/webhooks/orders-create';
const MAX_BODY_BYTES = 256 * 1024;

const allowedOrigin = (origin: string | null, allowList: string): string | null => {
  if (!origin) return null;

  const origins = allowList.split(',').map((entry) => entry.trim());
  return origins.includes(origin) ? origin : null;
};

const corsHeaders = (origin: string): Record<string, string> => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'POST',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '600',
  Vary: 'Origin',
});

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });

const log = (event: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ event, ...fields }));

const readBody = async (request: Request): Promise<unknown> => {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new InvalidRequestError('invalid_request');

  try {
    return JSON.parse(text);
  } catch {
    throw new InvalidRequestError('invalid_request');
  }
};

const handleCheckout = async (request: Request, env: Env): Promise<[number, unknown]> => {
  let checkout;
  let quote;

  try {
    checkout = parseCheckoutRequest(await readBody(request));
    const variants = await fetchVariants(env, checkout.lines.map((line) => line.variantId));
    quote = quoteCheckout(checkout, variants);
  } catch (error) {
    if (error instanceof InvalidRequestError) return [400, { error: error.code }];

    if (error instanceof PriceMismatchError) {
      log('price_mismatch', { expectedCents: error.expectedCents, computedCents: error.computedCents });
      return [409, { error: 'price_mismatch', expectedCents: error.expectedCents, computedCents: error.computedCents }];
    }

    log('variant_lookup_failed', { message: error instanceof Error ? error.message : String(error) });
    return [500, { error: 'draft_failed' }];
  }

  try {
    const existingDraftId = await findOpenDraftId(env, checkout.cartToken);
    const draft = await saveDraft(env, existingDraftId, buildDraftInput(checkout, quote.lines));

    log('draft_saved', {
      draft: draft.name,
      updated: existingDraftId !== null,
      computedCents: quote.computedCents,
      lines: quote.lines.map((line) => ({ variantId: line.variantId, priceOverrideCents: line.priceOverrideCents })),
    });

    return [200, { invoiceUrl: draft.invoiceUrl }];
  } catch (error) {
    log('draft_failed', { message: error instanceof Error ? error.message : String(error) });
    return [500, { error: 'draft_failed' }];
  }
};

// The email from Shopify's contact form is the merchant's copy; the draft order is for working out the quote.
const handleQuoteRequest = async (request: Request, env: Env): Promise<[number, unknown]> => {
  let quoteRequest;
  let priced;

  try {
    quoteRequest = parseQuoteRequest(await readBody(request));
    const variants = await fetchVariants(env, quoteRequest.lines.map((line) => line.variantId));
    priced = quoteRequestLines(quoteRequest.lines, variants);
  } catch (error) {
    if (error instanceof InvalidRequestError) return [400, { error: error.code }];

    log('variant_lookup_failed', { message: error instanceof Error ? error.message : String(error) });
    return [500, { error: 'draft_failed' }];
  }

  try {
    const draft = await saveDraft(env, null, buildQuoteDraftInput(quoteRequest, priced.lines));
    log('quote_draft_saved', { draft: draft.name, computedCents: priced.computedCents, lines: priced.lines.length });
    return [201, { ok: true }];
  } catch (error) {
    log('quote_draft_failed', { message: error instanceof Error ? error.message : String(error) });
    return [500, { error: 'draft_failed' }];
  }
};

const STOREFRONT_ROUTES: Record<string, (request: Request, env: Env) => Promise<[number, unknown]>> = {
  [CHECKOUT_ROUTE]: handleCheckout,
  [QUOTE_ROUTE]: handleQuoteRequest,
};

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === ORDERS_CREATE_WEBHOOK) {
      return request.method === 'POST' ? handleOrderCreated(request, env) : new Response(null, { status: 405 });
    }

    const handler = STOREFRONT_ROUTES[pathname];
    if (!handler) return json(404, { error: 'not_found' });

    const origin = allowedOrigin(request.headers.get('Origin'), env.ALLOWED_ORIGINS);
    if (!origin) return json(403, { error: 'forbidden_origin' });

    const cors = corsHeaders(origin);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' }, { ...cors, Allow: 'POST' });

    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const { success } = await env.CHECKOUT_RATE_LIMITER.limit({ key: `${pathname}:${ip}` });
    if (!success) return json(429, { error: 'rate_limited' }, cors);

    const [status, body] = await handler(request, env);
    return json(status, body, cors);
  },
} satisfies ExportedHandler<Env>;
