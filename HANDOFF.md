# Maatwerk checkout handoff

How Totaaltegel sells made-to-measure sills (vensterbanken, raamdorpels) at the right price, who does what, and what to do when something breaks. Current status and open items live in `STATE.md`; this file explains the system.

## Why this exists

Shopify's checkout can only charge `quantity × variant price`. A sill's price depends on its cut size, so the store used to encode the size in the quantity (0,01 m² or cm steps). That worked for the price but made quantities meaningless for customers and the ERP.

Now each sill is one cart line of quantity 1 carrying its size. Checkout goes through a **draft order** whose line prices are set server-side (`priceOverride`). Cart Transform functions would avoid draft orders, but Functions in custom apps require Shopify Plus, and the store isn't on Plus.

## The flow

1. **Product page** (`totaaltegel-theme`, `scripts/tile-calculator.js`): the customer enters depth/length and pieces. The calculator shows the price per piece using the same formula as the Worker (`sillPieceCents()`), and adds each piece as its own line with quantity 1 and hidden properties:

   | Property | Meaning |
   |---|---|
   | `_maatwerk` | `1` marks a maatwerk line |
   | `_calc_mode` | `sill_m2` (priced per m²) or `sill_m1` (per metre) |
   | `_length_cm`, `_depth_cm` | Cut size; depth only for `sill_m2`. The ERP reads these |
   | `_expected_line_cents` | Price per piece the customer saw |

   Verstek and neut stay normal lines, linked by `_line_uid` / `_parent_uid`.

2. **Cart** (`assets/cart-store.js`): Shopify's cart still holds the catalog price, so the cart shows `_expected_line_cents` for maatwerk lines (`lineTotalCents`, `subtotalCents`).

3. **Checkout button** (drawer, cart page, add-to-cart modal, discount field all call `$store.cart.checkout()`):
   - No maatwerk line in the cart: normal `/checkout`.
   - Any maatwerk line: POST the whole cart to the Worker, then redirect to the returned `invoiceUrl` (Shopify's checkout for the draft order). On an error the cart shows a message; it **never** falls back to `/checkout`, which would charge the catalog price.

4. **Worker** `POST /maatwerk-checkout` (this repo): checks the Origin, rate-limits, reads variant prices and ERP width limits from the Admin API, recalculates every sill price, and compares it with `_expected_line_cents` and the cart total (±1 cent). Then it creates or updates one open draft order per cart token (tag `maatwerk-storefront`) and returns its `invoiceUrl`. Regular products in the same cart go into the same draft at their catalog price.

5. **Payment**: the customer pays the draft order. It becomes a normal order with one line per sill piece; the ERP imports it.

6. **Safety net** `POST /webhooks/orders-create` (this repo): for every new order with a maatwerk line, the Worker checks that it came from a draft order (`source_name = shopify_draft_order`) and that each sill was charged `_expected_line_cents`. If not (someone reached `/checkout` directly), it tags the order `maatwerk-prijs-controle` and puts its fulfillment on hold with a note.

## Quote requests (offerte aanvraag)

The "Offerte aanvragen" dialog on the product page (`snippets/quote-request-dialog.liquid`, `scripts/quote-request.js`) still sends Shopify's contact-form email. When Theme settings → Prices → Quote form → **Draft order URL** is set (`…/quote-request`), it also posts the quote to the Worker, which creates a draft order for staff to finish and send:

- Tags `offerte-aanvraag` + `quote`, customer email, shipping and billing address (country NL), and the same summary as the email as the note. The phone number is only in the note. No invoice or checkout link is sent; the draft is only a draft.
- The ERP middleware (`totaaltegel-erp-integration`, `pushShopifyDraftOrderToErp`) turns every new draft order into an ERP quote and refuses drafts without an address, so these quotes reach the ERP as quotes.
- Vensterbank/raamdorpel: one quantity-1 line per piece plus verstek/neut, priced by the Worker formula. `_expected_line_cents` is rewritten to the Worker price.
- Tiles: the tile variant with area, material and installation as line properties, at the quantity add-to-cart would use for the entered m² without cutting loss (m² for per-m² variants, otherwise boxes or boxes × pack size; 1 if the page has no tile calculator), no accessory lines. Accessories (plinth, adhesive, grout, care) are plain yes/no checkboxes in the dialog and appear in the note by name only; nothing is calculated for them.
- The request is fire-and-forget (`keepalive`, `text/plain` so there's no CORS preflight). If it fails, the customer still sees success and the email still arrives; look for `quote_draft_failed` in the logs.
- The safety net doesn't hold paid orders that came from a draft tagged `offerte-aanvraag`, so staff can change prices on a quote.

## Pricing formula

Variant prices under €10,00 are legacy: ERP unit price ÷ 100. So `unit = price < 1000 cents ? price × 100 : price`.

- `sill_m2`: `round(depth_cm × length_cm × unit / 10000)`
- `sill_m1`: `round(length_cm × unit / 100)`

Example: Designo Blue at €2,65 → unit €265/m² → 40 × 200 cm = €212,00. The formula exists twice (`src/pricing.ts` and `sillPieceCents()` in the theme). **Change both together**, or every checkout answers 409.

## Where things live

| What | Where |
|---|---|
| Worker code | this repo, deployed to `https://totaaltegel-maatwerk-checkout.newfive.workers.dev` (Cloudflare account `newfive`) |
| Theme code | `totaaltegel-theme`: `scripts/tile-calculator.js` (→ `assets/main.js`), `assets/cart-store.js`, cart snippets, `snippets/cart-config.liquid` |
| On/off switch | Theme settings → Cart → **Maatwerk checkout** (`maatwerk_checkout_enabled`) + **Worker URL** (`…/maatwerk-checkout`). Off = old quantity-encoded flow, unchanged |
| Shopify app | "Totaaltegel M2M" in Newfive's Dev Dashboard, custom distribution to `totaaltegel.myshopify.com` |
| Admin token | Worker secret `SHOPIFY_ADMIN_ACCESS_TOKEN` (non-expiring offline token) and local `.dev.vars` |
| Webhook signing | Worker secret `SHOPIFY_CLIENT_SECRET` |
| App IP allowlist | Dev Dashboard → Settings. `2a06:98c0:3600::103` is the Worker; add your own IP only for local Admin API work |

Secrets never go in git: `.dev.vars` is gitignored and `.githooks/pre-commit` blocks secret files and token patterns.

## Go-live checklist

1. Test order through a draft has **no** `maatwerk-prijs-controle` tag and no hold (confirms the source check).
2. VAT is right: the draft checkout added 21% on top of the sill price. Correct only if store prices are excl. VAT.
3. Protected customer data access (orders) is granted for the app.
4. Temporary IPs (office) are removed from the app's IP allowlist.
5. ERP imports cut size from `_length_cm` / `_depth_cm` (confirmed) and skips orders tagged `maatwerk-prijs-controle`.
6. All vensterbank/raamdorpel products use the `vensterbank` / `raamdorpel` product template. Without it there's no calculator and no maatwerk line.
7. Translators added the four `cart.errors.maatwerk_*` strings to `nl.json`.
8. Turn on the theme setting with the Worker URL. Test one sill to checkout on the live site.
9. Quote draft orders: enabled on live (Prices → Quote form → Draft order URL = `…/quote-request`).

## Runbook

| Symptom | Cause | Fix |
|---|---|---|
| Customer sees "price has changed" (409) | Variant price changed after the item was added, or the formula differs between theme and Worker | Customer re-adds the item. If it happens for fresh items, compare both formulas |
| "Item no longer valid" (400 `invalid_line`) | Unknown variant, missing properties, or depth outside the ERP width limits | Check the variant's `erp.min_width_mm` / `max_width_mm` |
| "Checkout could not be started" + `admin_http_401` in logs | Token revoked or app uninstalled | `npm run token` (from an allowlisted IP) |
| Same, with `admin_http_403` | IP allowlist rejected the Worker | Make sure `2a06:98c0:3600::103` is on the allowlist |
| "Too many attempts" (429) | More than 10 checkout attempts per minute from one IP | Wait; raise the limit in `wrangler.jsonc` if it hits real customers |
| Order tagged `maatwerk-prijs-controle`, on hold | Maatwerk line paid outside the draft flow, or charged a different price | Check the price in the hold note, settle with the customer, release the hold |
| Every maatwerk order gets held | Shopify's draft-order source label isn't `shopify_draft_order` | Read `source` in `maatwerk_order_ok` / `maatwerk_bypass_held` logs and fix `DRAFT_ORDER_SOURCE` in `src/webhooks.ts` |
| Logs show `maatwerk_bypass_hold_failed` | Tagging or holding failed (scopes, no fulfillment orders yet) | Shopify retries the webhook; check scopes if it keeps failing |
| Quote email arrived but no `offerte-aanvraag` draft | Draft order URL empty, or `quote_draft_failed` / a 400 in the logs (invalid email, sill outside ERP width limits) | Set the URL; otherwise make the draft by hand from the email |

Logs: `npx wrangler tail` (live) or the Cloudflare dashboard → Workers → `totaaltegel-maatwerk-checkout` → Logs. Events: `draft_saved`, `quote_draft_saved`, `quote_draft_failed`, `maatwerk_order_ok`, `maatwerk_bypass_held`, `maatwerk_bypass_hold_failed`. No emails or tokens are logged.

## Working on this repo

```bash
npm install          # also enables the pre-commit hook
npm test             # 50 tests, Shopify mocked
npm run typecheck
npm run deploy       # wrangler deploy
npm run token        # reinstall the app / new token; needs SHOPIFY_CLIENT_ID + SECRET in .dev.vars
```

New Admin API scopes: add them to `shopify.app.toml` and `scripts/get-access-token.mjs`, release a new app version in the Dev Dashboard, then `npm run token`.

## Known limitations

- The token never expires; if it leaks, uninstall and reinstall the app, then `npm run token`.
- The IP allowlist entry is shared by all Cloudflare Workers, so it stops a leaked token used from a normal machine, not from another Worker.
- The draft lookup scans the 50 most recently updated open drafts; two clicks at the same instant can create two drafts.
- Every quote submit creates a new draft; a customer who submits twice gets two.
- Nothing can block `/checkout` itself without Shopify Plus; the safety net catches it after the order is placed.
