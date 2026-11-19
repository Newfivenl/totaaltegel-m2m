import { centsToAmount, moneyToCents } from './pricing';
import type { DraftLine, VariantInfo } from './quote';
import type { CheckoutRequest, QuoteRequest } from './request';

export const DRAFT_TAG = 'maatwerk-storefront';
export const QUOTE_TAG = 'offerte-aanvraag';
const QUOTE_COUNTRY = 'NL';
const CART_TOKEN_ATTRIBUTE = 'cart_token';
const CURRENCY = 'EUR';
const MAX_NODES_PER_QUERY = 250;

export class ShopifyError extends Error {}

type GraphqlResponse<T> = {
  data?: T;
  errors?: { message: string; extensions?: { code?: string } }[];
};

export type UserError = { field: string[] | null; message: string };

type SavedDraft = { id: string; name: string; invoiceUrl: string | null; status: string };

export const adminGraphql = async <T>(env: Env, query: string, variables: Record<string, unknown>): Promise<T> => {
  const response = await fetch(`https://${env.SHOPIFY_SHOP}/admin/api/${env.SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': env.SHOPIFY_ADMIN_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  // 401 means the token was revoked or the app uninstalled: run `npm run token` again.
  // 403 here usually means the request came from outside the app's IP allowlist.
  if (!response.ok) throw new ShopifyError(`admin_http_${response.status}`);

  const json = (await response.json()) as GraphqlResponse<T>;
  if (json.errors?.length) {
    throw new ShopifyError(`admin_graphql: ${json.errors.map((error) => error.extensions?.code ?? error.message).join(', ')}`);
  }
  if (!json.data) throw new ShopifyError('admin_graphql: empty response');

  return json.data;
};

const VARIANTS_QUERY = /* GraphQL */ `
  query MaatwerkVariants($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        price
        minWidth: metafield(namespace: "erp", key: "min_width_mm") {
          value
        }
        maxWidth: metafield(namespace: "erp", key: "max_width_mm") {
          value
        }
      }
    }
  }
`;

type VariantNode = {
  id: string;
  price: string;
  minWidth: { value: string } | null;
  maxWidth: { value: string } | null;
} | null;

const variantGid = (id: string) => `gid://shopify/ProductVariant/${id}`;

const parseMillimetres = (metafield: { value: string } | null): number | null => {
  if (!metafield) return null;

  const mm = Number(metafield.value);
  return Number.isFinite(mm) && mm > 0 ? mm : null;
};

export const fetchVariants = async (env: Env, variantIds: string[]): Promise<Map<string, VariantInfo>> => {
  const ids = [...new Set(variantIds)];
  if (ids.length > MAX_NODES_PER_QUERY) throw new ShopifyError('too_many_variants');

  const data = await adminGraphql<{ nodes: VariantNode[] }>(env, VARIANTS_QUERY, { ids: ids.map(variantGid) });
  const variants = new Map<string, VariantInfo>();

  for (const node of data.nodes) {
    if (!node?.id || node.price === undefined) continue;

    variants.set(node.id.replace('gid://shopify/ProductVariant/', ''), {
      priceCents: moneyToCents(node.price),
      minWidthMm: parseMillimetres(node.minWidth),
      maxWidthMm: parseMillimetres(node.maxWidth),
    });
  }

  return variants;
};

const OPEN_DRAFTS_QUERY = /* GraphQL */ `
  query OpenMaatwerkDrafts($query: String!) {
    draftOrders(first: 50, query: $query, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        id
        status
        customAttributes {
          key
          value
        }
      }
    }
  }
`;

type DraftNode = { id: string; status: string; customAttributes: { key: string; value: string | null }[] };

export const findOpenDraftId = async (env: Env, cartToken: string): Promise<string | null> => {
  const data = await adminGraphql<{ draftOrders: { nodes: DraftNode[] } }>(env, OPEN_DRAFTS_QUERY, {
    query: `tag:${DRAFT_TAG} status:open`,
  });

  const match = data.draftOrders.nodes.find(
    (draft) =>
      draft.status !== 'COMPLETED' &&
      draft.customAttributes.some((attribute) => attribute.key === CART_TOKEN_ATTRIBUTE && attribute.value === cartToken),
  );

  return match?.id ?? null;
};

const draftLineItems = (lines: DraftLine[]) =>
  lines.map((line) => ({
    variantId: variantGid(line.variantId),
    quantity: line.quantity,
    customAttributes: Object.entries(line.properties).map(([key, value]) => ({ key, value })),
    ...(line.priceOverrideCents !== null && {
      priceOverride: { amount: centsToAmount(line.priceOverrideCents), currencyCode: CURRENCY },
    }),
  }));

export const buildDraftInput = (request: CheckoutRequest, lines: DraftLine[]) => ({
  presentmentCurrencyCode: CURRENCY,
  acceptAutomaticDiscounts: true,
  allowDiscountCodesInCheckout: true,
  discountCodes: request.discountCodes,
  tags: [DRAFT_TAG],
  customAttributes: [{ key: CART_TOKEN_ATTRIBUTE, value: request.cartToken }],
  ...(request.customerId && { purchasingEntity: { customerId: `gid://shopify/Customer/${request.customerId}` } }),
  ...(request.email && { email: request.email }),
  lineItems: draftLineItems(lines),
});

const splitName = (name: string) => {
  const [firstName, ...rest] = name.split(/\s+/);
  return { firstName, lastName: rest.join(' ') || firstName };
};

// Phone stays in the note: Shopify rejects drafts whose phone isn't valid E.164.
export const buildQuoteDraftInput = (request: QuoteRequest, lines: DraftLine[]) => {
  const { customer } = request;

  return {
    presentmentCurrencyCode: CURRENCY,
    tags: [QUOTE_TAG],
    email: customer.email,
    ...(request.note && { note: request.note }),
    ...(customer.address && {
      shippingAddress: {
        ...splitName(customer.name),
        address1: customer.address,
        ...(customer.zip && { zip: customer.zip }),
        ...(customer.city && { city: customer.city }),
        countryCode: QUOTE_COUNTRY,
      },
    }),
    lineItems: draftLineItems(lines),
  };
};

const DRAFT_FIELDS = /* GraphQL */ `
  draftOrder {
    id
    name
    invoiceUrl
    status
  }
  userErrors {
    field
    message
  }
`;

const CREATE_DRAFT_MUTATION = /* GraphQL */ `
  mutation CreateMaatwerkDraft($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      ${DRAFT_FIELDS}
    }
  }
`;

const UPDATE_DRAFT_MUTATION = /* GraphQL */ `
  mutation UpdateMaatwerkDraft($id: ID!, $input: DraftOrderInput!) {
    draftOrderUpdate(id: $id, input: $input) {
      ${DRAFT_FIELDS}
    }
  }
`;

type DraftPayload = { draftOrder: SavedDraft | null; userErrors: UserError[] };

const unwrapDraft = (payload: DraftPayload): SavedDraft => {
  if (payload.userErrors.length) {
    throw new ShopifyError(`draft_user_errors: ${payload.userErrors.map((error) => error.message).join('; ')}`);
  }
  if (!payload.draftOrder?.invoiceUrl) throw new ShopifyError('draft_without_invoice_url');

  return payload.draftOrder;
};

export const saveDraft = async (
  env: Env,
  existingDraftId: string | null,
  input: ReturnType<typeof buildDraftInput> | ReturnType<typeof buildQuoteDraftInput>,
): Promise<SavedDraft> => {
  if (existingDraftId) {
    const data = await adminGraphql<{ draftOrderUpdate: DraftPayload }>(env, UPDATE_DRAFT_MUTATION, {
      id: existingDraftId,
      input,
    });
    return unwrapDraft(data.draftOrderUpdate);
  }

  const data = await adminGraphql<{ draftOrderCreate: DraftPayload }>(env, CREATE_DRAFT_MUTATION, { input });
  return unwrapDraft(data.draftOrderCreate);
};
