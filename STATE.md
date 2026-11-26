# Project State

_Last updated: 2026-11-26_

Living status for **totaaltegel-m2m** (NewFivePlus): the Cloudflare Worker behind maatwerk checkout. Agents: read this at session start; update after significant work.

## Project overview (handoff)

| | |
|---|---|
| **Client** | Totaaltegel |
| **Store** | `totaaltegel.myshopify.com` (not Shopify Plus) |
| **Repo role** | `POST /maatwerk-checkout`: turns a cart with maatwerk lines (vensterbank/raamdorpel) into one Shopify draft order with `priceOverride`, returns `invoiceUrl`. `POST /webhooks/orders-create`: tags + holds orders whose maatwerk lines skipped the draft order |
| **Handoff** | `HANDOFF.md` in this repo: end-to-end flow, go-live checklist, runbook. Original spec `totaaltegel-theme/docs/plans/2026-11-18-maatwerk-draft-order-handoff.md` (Dutch, auth sections outdated) |
| **Live URL** | `https://totaaltegel-maatwerk-checkout.newfive.workers.dev` (Cloudflare account `newfive`) |
| **Shopify app** | “Totaaltegel M2M”, Dev Dashboard of Newfive’s org, custom distribution to `totaaltegel.myshopify.com` |

### Code map

| File | Role |
|------|------|
| `src/index.ts` | Routes (`/maatwerk-checkout`, `/quote-request`, webhook), Origin allowlist + CORS preflight, rate limit per route + IP, error → status mapping |
| `src/request.ts` | Body parsing/validation (checkout and quote) |
| `src/pricing.ts` | Legacy ÷100 switch, `sill_m2` / `sill_m1` formulas (integer math). Mirrored in the theme’s `sillPieceCents()` |
| `src/quote.ts` | Lines → draft lines, `_expected_line_cents` and total checks (±1 cent), ERP width bounds, qty>1 sill split into qty-1 lines. `quoteRequestLines`: same pricing without client checks, rewrites `_expected_line_cents` |
| `src/shopify.ts` | Admin GraphQL: variant prices + `erp.min/max_width_mm`, open-draft lookup by `cart_token`, `draftOrderCreate` / `draftOrderUpdate` |
| `src/webhooks.ts` | `orders/create`: HMAC check, bypass detection (`_maatwerk=1` line with `source_name ≠ shopify_draft_order` or price ≠ `_expected_line_cents`), `tagsAdd` `maatwerk-prijs-controle` + `fulfillmentOrderHold` (handle `maatwerk-prijs-controle`) |
| `scripts/get-access-token.mjs` | One-time localhost OAuth install → offline token into `.dev.vars` + Worker secret |
| `test/` | Vitest in Node (50 tests), Shopify mocked via `fetch` stub |

### Commands

`npm test` · `npm run typecheck` · `npm run deploy` · `npm run token` (re-install / new token) · `npm run cf-typegen` after binding changes.

## Current status

**Checkout: live and verified end to end (2026-11-19).** Real variant `55807134892375` (Black keramiek, €4,17 legacy) 40×200 → `200 invoiceUrl` (€333,60). Theme flow on the dev theme (Designo Blue, 2 × 40×200) → drawer €424,00 → Afrekenen → Shopify checkout with 2 × €212,00. Test drafts deleted.

**Webhook safety net: live (2026-11-19).** Scopes granted (order + merchant-managed fulfillment orders), new token installed. Subscription `gid://shopify/WebhookSubscription/2591017206103` (`ORDERS_CREATE` → `/webhooks/orders-create`) created via Admin API `webhookSubscriptionCreate` (shop-specific; the Dev Dashboard has no webhook form). Unsigned calls get 401.

**Quote requests → draft order: Worker live (2026-11-19).** `POST /quote-request` creates a draft tagged `offerte-aanvraag` (email, NL shipping address, summary as note, sills priced by the Worker). Live test via curl with variant `55807134892375` 40×200 → `#D12`, €333,60, address OK; deleted. Theme side pushed to `totaaltegel-theme` `main` and **enabled on live** (Prices → Quote form → **Draft order URL**). Drafts are tagged `offerte-aanvraag` + `quote`, carry shipping + billing address, and reach the ERP as quotes via the ERP middleware's `draft_orders/create` hook.

**Manual test order + ERP delivery checked OK (2026-11-19, with Bart).** Maatwerk checkout is **enabled on the live theme**; cart flow confirmed working. VAT confirmed correct (2026-11-19).

**Still open** (full checklist in `HANDOFF.md`):

1. **Safety net on the test order:** confirm it has **no** `maatwerk-prijs-controle` tag and no fulfillment hold (proves `source_name = shopify_draft_order`). If it was held: fix `DRAFT_ORDER_SOURCE` in `src/webhooks.ts`.
2. **Protected customer data access** (orders) granted in the Dev Dashboard, or Shopify may not deliver the webhook.
3. **Office IP** (`212.178.101.182`) removed from the app's IP allowlist again.
4. **ERP** skips orders tagged `maatwerk-prijs-controle`.
5. **ERP quote gate:** (more urgent since 2026-11-26: every cart with an m²-priced tile now checks out through a `maatwerk-storefront` draft) the ERP middleware turns *every* new draft into an ERP quote, including the `maatwerk-storefront` checkout drafts (refused without address → SRE alert, or a stray quote when an address is present). Gate it in `totaaltegel-erp-integration` (skip `maatwerk-storefront`). Test draft `#D12` ("Newfive Test") likely reached the ERP as a quote; remove it there.

## Live configuration

| Item | Value |
|------|-------|
| Worker secrets | `SHOPIFY_SHOP`, `SHOPIFY_ADMIN_ACCESS_TOKEN`, `SHOPIFY_CLIENT_SECRET` (webhook HMAC only) |
| Local `.dev.vars` (gitignored, 600) | `SHOPIFY_SHOP`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_ADMIN_ACCESS_TOKEN` |
| `ALLOWED_ORIGINS` var | `www.totaaltegel.nl`, `totaaltegel.nl`, `totaaltegel.myshopify.com`, `http://127.0.0.1:9292` (theme dev) |
| Rate limit | 10 req / 60 s per IP (`CHECKOUT_RATE_LIMITER`, namespace `1001`) |
| API version | `2026-10` |
| App scopes (live) | `read_draft_orders,write_draft_orders,read_products,read_orders,write_orders,read_merchant_managed_fulfillment_orders,write_merchant_managed_fulfillment_orders` |
| App URL / redirect | `http://localhost:3456` / `http://localhost:3456/callback` (only for `npm run token`) |
| App IP allowlist (enforced) | `2a06:98c0:3600::103` (Worker) + Damy’s home IPv4 (see Dev Dashboard). Office IP added temporarily on 2026-11-19 for the webhook setup; remove it |
| Webhook subscription | `gid://shopify/WebhookSubscription/2591017206103`, `ORDERS_CREATE` → `/webhooks/orders-create` (shop-specific, created via Admin API) |
| Theme switches | `totaaltegel-theme`: `maatwerk_checkout_enabled` + `maatwerk_checkout_url` (Cart group) and `quote_draft_url` (Prices → Quote form), all **on** in live `settings_data.json` |

## Decision Log

- **2026-11-26 — Price-integrity hardening (after security review).** (1) A `_calc_mode` only prices products whose template shows that calculator: `sill_m2` ↔ `vensterbank`, `sill_m1` ↔ `raamdorpel`, `tiles` ↔ any suffix except `vensterbank`/`raamdorpel`/`per-stuk`/`tegel-per-stuk` (unknown suffixes render `product.json`, the tile calculator). Blocks a tile bought as a 1 cm raamdorpel. (2) `_area_m2`, `_length_cm`, `_depth_cm` must be plain dot decimals (`^\d{1,6}(\.\d{1,3})?$`); `Number()` took `2e2`, `0x32`, `50,4`, which the ERP may read differently. The draft line carries the Worker's own `_area_m2`. (3) A catalog-priced line with ERP size properties (`_calc_mode`, `_area_m2`, `_boxes`, `_length_cm`, `_depth_cm`) is rejected at checkout and held by the orders/create safety net. Deployed `1d02c822`; live probes: Primewood tiles → computed 236930, Primewood as `sill_m1` → 400, Black keramiek `sill_m2` → computed 40400.

- **2026-11-26 — Tiles on the draft flow.** m²-priced tile lines carry `_calc_mode=tiles`, `_boxes`, `_area_m2`; the Worker prices `_boxes` × variant `erp.pieces_per_box` × price (area in thousandths, rounded once) and rejects an `_area_m2` that doesn't match. One quantity-1 line, so the ERP reads m² and boxes from the properties. Deployed (version `b4bea2f5`); probe against live variant 55816266580311 (35 × 1,44 m² at €47,01) computed 236930.

- **2026-11-19 — Quote drafts next to the contact email, fire-and-forget.** The dialog keeps the native Shopify contact-form submit (bot protection hooks into it) and sends the draft with `fetch(keepalive)` + `text/plain` (no preflight). A failed draft never blocks the email. Every submit creates a new draft (no cart token to dedupe on). Paid orders from a draft tagged `offerte-aanvraag` skip the price check in the safety net because staff may renegotiate quote prices. Tile quotes carry the tile at quantity 1 (the dialog only knows m², not boxes); staff set the quantity.
- **2026-11-19 — Stay on draft orders.** Cart Transform (bundle `lineExpand` / `lineUpdate`) would avoid drafts, but Functions in custom apps need Shopify Plus and the store isn’t on Plus.
- **2026-11-19 — Exact price formula.** Full-cent `sill_m2` variants used to round €/m² to whole cents per 0,01 m² on the PDP; the theme now uses the Worker formula (area × €/m², rounded once) when the draft flow is on.
- **2026-11-19 — Safety net = tag + fulfillment hold** on orders with maatwerk lines that didn’t come through a draft (direct `/checkout`, old links). Checkout validation would need a Function (Plus). Detection uses both order source and per-line price, so a wrong guess of the source value fails safe (holds instead of ships).
- **2026-11-18 — App lives in Newfive’s org; token via one-time OAuth.** Client credentials grant failed with `shop_not_permitted` (store is in Totaaltegel’s org). Chose a localhost OAuth script that mints a **non-expiring** offline token, stored as Worker secret. Rejected: full in-Worker OAuth with expiring tokens + Durable Object (more moving parts), app in Totaaltegel’s org (needs merchant access).
- **2026-11-18 — IP allowlist = `2a06:98c0:3600::103`.** `myshopify.com` is behind Cloudflare, so every cross-zone Worker subrequest arrives with that address (confirmed in Dev Dashboard logs). It is shared by all Workers worldwide: blocks a leaked token used from a normal machine, not from another Worker. A real dedicated IP would need egress outside Cloudflare.
- **2026-11-18 — Origin allowlist in the Worker, not IP.** Shoppers call from their own browsers; IP filtering there would block customers.
- **2026-11-18 — Sill line with quantity n becomes n draft lines of quantity 1**, so ERP quantity = pieces even if the cart merged identical cuts.
- **2026-11-18 — Extra error codes beyond the spec:** `400 invalid_request` (malformed body), `400 no_maatwerk_line`; depth outside ERP bounds uses `invalid_line`; per-line 409 reports that line’s cents.

## Known Issues & Gotchas

- **Token never expires.** Valid until the app is uninstalled. If leaked: uninstall/reinstall the app, then `npm run token`. A `401` in Worker logs (`admin_http_401`) means the token is dead → `npm run token`.
- **`403` in Worker logs (`admin_http_403`)** = IP allowlist rejected the call.
- **Local Admin API calls** only work from allowlisted IPs (home IPv4). Home IPv6 and the office IP get 403.
- **Webhook returns 500 when the order has no fulfillment orders yet**, so Shopify retries; it also returns 500 if tagging/holding fails (logged as `maatwerk_bypass_hold_failed`).
- **Draft lookup reads the 50 most recently updated open drafts** tagged `maatwerk-storefront`. Beyond that, a repeat click could create a duplicate draft. Two clicks in the same instant can also create two drafts.
- **First `wrangler deploy` of a new Worker** can fail with `10007 Worker does not exist` right after upload; rerun deploy.
- **npm 11 install scripts:** `esbuild` and `workerd` are approved in `package.json` (`allowScripts`); new versions need `npm install-scripts approve`.
- **Shell gotcha:** a shell that sourced `.dev.vars` overrides the script’s file values (env wins).

## Session Handoff

- **2026-11-19 (quote requests as draft orders):** Added `POST /quote-request` + quote exemption in the safety net, 50 tests, deployed, live-tested with curl (`#D12`, deleted). Theme: quote dialog posts to the Worker when Prices → Quote form → Draft order URL is set; calculator snapshot exposes `draftLines`; `assets/main.js` rebuilt. Follow-up same day: tile quotes get a real quantity, drafts also tagged `quote` with billing address; theme pulled, committed, pushed, `quote_draft_url` enabled on live. Maatwerk checkout was already enabled on live; cart confirmed working, VAT confirmed OK. **Next:** ERP gate for checkout drafts (item 5 under Still open), first real quote check.
- **2026-11-19 (bundle research, safety net, theme integration):** Researched bundles instead of drafts: not possible without Plus. Added the `orders/create` safety net: deployed, scopes granted, subscription created, committed (`c260bf9`). Theme integration committed in `totaaltegel-theme` (`f49c920`) behind the theme setting **Cart → Maatwerk checkout** (off on live). Verified on the dev theme; manual test order reached the ERP correctly (checked with Bart). Wrote `HANDOFF.md`. **Next:** the "Open before go-live" list above, then enable the theme setting.
- **2026-11-18 (Worker setup):** Built the Worker from the handoff spec, deployed it, created the Shopify app (Dev Dashboard, Newfive org), installed it via `npm run token`, enforced the IP allowlist, verified access. Secrets out of git (`.gitignore` + `.githooks/pre-commit`, enabled via `npm install`).
