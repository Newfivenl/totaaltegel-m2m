# Project State

_Last updated: 2026-11-18_

Living status for **totaaltegel-m2m** (NewFivePlus): the Cloudflare Worker behind maatwerk checkout. Agents: read this at session start; update after significant work.

## Project overview (handoff)

| | |
|---|---|
| **Client** | Totaaltegel |
| **Store** | `totaaltegel.myshopify.com` |
| **Repo role** | `POST /maatwerk-checkout`: turns a cart with maatwerk lines (vensterbank/raamdorpel) into one Shopify draft order with `priceOverride`, returns `invoiceUrl` |
| **Spec** | `totaaltegel-theme/docs/plans/2026-11-18-maatwerk-draft-order-handoff.md` (Dutch). The auth sections there (“Develop apps”, client credentials) are outdated; this file wins |
| **Live URL** | `https://totaaltegel-maatwerk-checkout.newfive.workers.dev/maatwerk-checkout` (Cloudflare account `newfive`) |
| **Shopify app** | “Totaaltegel M2M”, Dev Dashboard of Newfive’s org, custom distribution to `totaaltegel.myshopify.com` |

### Code map

| File | Role |
|------|------|
| `src/index.ts` | Route, Origin allowlist + CORS preflight, rate limit, error → status mapping |
| `src/request.ts` | Body parsing/validation |
| `src/pricing.ts` | Legacy ÷100 switch, `sill_m2` / `sill_m1` formulas (integer math) |
| `src/quote.ts` | Lines → draft lines, `_expected_line_cents` and total checks (±1 cent), ERP width bounds, qty>1 sill split into qty-1 lines |
| `src/shopify.ts` | Admin GraphQL: variant prices + `erp.min/max_width_mm`, open-draft lookup by `cart_token`, `draftOrderCreate` / `draftOrderUpdate` |
| `scripts/get-access-token.mjs` | One-time localhost OAuth install → offline token into `.dev.vars` + Worker secret |
| `test/` | Vitest in Node (31 tests), Shopify mocked via `fetch` stub |

### Commands

`npm test` · `npm run typecheck` · `npm run deploy` · `npm run token` (re-install / new token) · `npm run cf-typegen` after binding changes.

## Current status

**Worker: live and verified.** Smoke test with a non-existent variant returns `400 invalid_line`, which proves token + Admin API read + IP allowlist work without creating a draft. CORS preflight 204, foreign origin 403.

**Not done:**

1. **Nothing committed yet.** Whole repo is untracked on `main`. Pre-commit hook blocks `.dev.vars`/`.env*`/keys and Shopify token patterns.
2. **No real draft created yet.** No end-to-end test with a real vensterbank/raamdorpel variant, and no paid test order.
3. **Theme integration** (in `totaaltegel-theme`): hidden props `_maatwerk=1`, `_calc_mode`, `_depth_cm`, `_length_cm`, `_expected_line_cents` on the main line; qty 1 per piece; Afrekenen with a maatwerk line → POST to Worker → `location = invoiceUrl`; on 409/500 do **not** fall back to `/checkout`; dynamic checkout buttons off on `vensterbank` + `raamdorpel` templates; send `customer.id` from Liquid.
4. **ERP import** must read cut size from line properties before go-live (quantity becomes pieces).
5. Handoff plan in the theme repo still describes the old auth flow.

## Live configuration

| Item | Value |
|------|-------|
| Worker secrets | `SHOPIFY_SHOP`, `SHOPIFY_ADMIN_ACCESS_TOKEN` (nothing else; client ID/secret deliberately removed from the Worker) |
| Local `.dev.vars` (gitignored, 600) | `SHOPIFY_SHOP`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_ADMIN_ACCESS_TOKEN` |
| `ALLOWED_ORIGINS` var | `www.totaaltegel.nl`, `totaaltegel.nl`, `totaaltegel.myshopify.com`, `http://127.0.0.1:9292` (theme dev) |
| Rate limit | 10 req / 60 s per IP (`CHECKOUT_RATE_LIMITER`, namespace `1001`) |
| API version | `2026-10` |
| App scopes | `read_draft_orders,write_draft_orders,read_products` |
| App URL / redirect | `http://localhost:3456` / `http://localhost:3456/callback` (only for `npm run token`) |
| App IP allowlist (enforced) | `2a06:98c0:3600::103` (Worker) + Damy’s home IPv4 (see Dev Dashboard) |

## Decision Log

- **2026-11-18 — App lives in Newfive’s org; token via one-time OAuth.** Client credentials grant failed with `shop_not_permitted` (store is in Totaaltegel’s org). Chose a localhost OAuth script that mints a **non-expiring** offline token, stored as Worker secret. Rejected: full in-Worker OAuth with expiring tokens + Durable Object (more moving parts), app in Totaaltegel’s org (needs merchant access).
- **2026-11-18 — IP allowlist = `2a06:98c0:3600::103`.** `myshopify.com` is behind Cloudflare, so every cross-zone Worker subrequest arrives with that address (confirmed in Dev Dashboard logs). It is shared by all Workers worldwide: blocks a leaked token used from a normal machine, not from another Worker. Placement hint removed because location no longer matters. A real dedicated IP would need egress outside Cloudflare.
- **2026-11-18 — Origin allowlist in the Worker, not IP.** Shoppers call from their own browsers; IP filtering there would block customers.
- **2026-11-18 — Sill line with quantity n becomes n draft lines of quantity 1**, so ERP quantity = pieces even if the cart merged identical cuts.
- **2026-11-18 — Extra error codes beyond the spec:** `400 invalid_request` (malformed body), `400 no_maatwerk_line`; depth outside ERP bounds uses `invalid_line`; per-line 409 reports that line’s cents.

## Known Issues & Gotchas

- **Token never expires.** Valid until the app is uninstalled. If leaked: uninstall/reinstall the app, then `npm run token`. A `401` in Worker logs (`admin_http_401`) means the token is dead → `npm run token`.
- **`403` in Worker logs (`admin_http_403`)** = IP allowlist rejected the call.
- **Home IPv6 not on the allowlist.** Local Admin API calls often go over IPv6 and get 403; IPv4 works. The final check in `npm run token` may show 403; harmless. Add the `/64` if local calls are needed.
- **Draft lookup reads the 50 most recently updated open drafts** tagged `maatwerk-storefront`. Beyond that, a repeat click could create a duplicate draft. Two clicks in the same instant can also create two drafts.
- **First `wrangler deploy` of a new Worker** can fail with `10007 Worker does not exist` right after upload; rerun deploy.
- **npm 11 install scripts:** `esbuild` and `workerd` are approved in `package.json` (`allowScripts`); new versions need `npm install-scripts approve`.
- **Shell gotcha:** a shell that sourced `.dev.vars` overrides the script’s file values (env wins).

## Session Handoff

- **2026-11-18 (Worker setup):** Built the Worker from the handoff spec, deployed it, created the Shopify app (Dev Dashboard, Newfive org), installed it via `npm run token`, enforced the IP allowlist, verified access. Secrets out of git (`.gitignore` + `.githooks/pre-commit`, enabled via `npm install`). **Next:** commit the repo; end-to-end draft test with a real sill variant; theme integration (see Current status #3); ERP import change; refresh the theme’s handoff plan.
