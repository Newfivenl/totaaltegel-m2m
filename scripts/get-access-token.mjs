#!/usr/bin/env node
// One-time install of the app on the store. Runs a localhost OAuth callback, exchanges the
// code for an offline Admin API token, stores it in .dev.vars and as a Worker secret.
// Usage: npm run token            (add -- --no-push to skip `wrangler secret put`)

import { spawn } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 3456);
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPES = 'read_draft_orders,write_draft_orders,read_products';
const API_VERSION = '2026-10';
const DEV_VARS = '.dev.vars';
const TOKEN_KEY = 'SHOPIFY_ADMIN_ACCESS_TOKEN';
const SHOP_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;
const PUSH_TO_WORKER = !process.argv.includes('--no-push');

const readDevVars = () => {
  if (!existsSync(DEV_VARS)) return {};

  const vars = {};

  for (const line of readFileSync(DEV_VARS, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match) vars[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }

  return vars;
};

const upsertDevVar = (key, value) => {
  const lines = existsSync(DEV_VARS) ? readFileSync(DEV_VARS, 'utf8').split('\n').filter(Boolean) : [];
  const next = lines.filter((line) => !line.startsWith(`${key}=`));
  next.push(`${key}=${value}`);
  writeFileSync(DEV_VARS, `${next.join('\n')}\n`);
  chmodSync(DEV_VARS, 0o600);
};

const fail = (message) => {
  console.error(`✘ ${message}`);
  process.exit(1);
};

const config = { ...readDevVars(), ...process.env };
const shop = config.SHOPIFY_SHOP;
const clientId = config.SHOPIFY_CLIENT_ID;
const clientSecret = config.SHOPIFY_CLIENT_SECRET;

if (!shop || !SHOP_PATTERN.test(shop)) fail('SHOPIFY_SHOP in .dev.vars must look like totaaltegel.myshopify.com');
if (!clientId || !clientSecret) fail('Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET in .dev.vars');

const state = randomBytes(16).toString('hex');
const authorizeUrl = `https://${shop}/admin/oauth/authorize?${new URLSearchParams({
  client_id: clientId,
  scope: SCOPES,
  redirect_uri: REDIRECT_URI,
  state,
})}`;

const safeEqual = (a, b) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

const validHmac = (params) => {
  const message = [...params.entries()]
    .filter(([key]) => key !== 'hmac')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  return safeEqual(createHmac('sha256', clientSecret).update(message).digest('hex'), params.get('hmac') ?? '');
};

const exchangeCode = async (code) => {
  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code }),
  });

  if (!response.ok) throw new Error(`token exchange failed with HTTP ${response.status}`);

  const body = await response.json();
  if (typeof body.access_token !== 'string') throw new Error('token response had no access_token');
  return body;
};

const checkToken = async (token) => {
  const response = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query: '{ shop { name } }' }),
  });

  if (response.status === 403) return 'blocked here (403), probably by the IP allowlist; the Worker can still use it';
  if (!response.ok) return `check failed with HTTP ${response.status}`;

  const { data } = await response.json();
  return `works for "${data?.shop?.name}"`;
};

const pushToWorker = (token) =>
  new Promise((resolve) => {
    const child = spawn('npx', ['wrangler', 'secret', 'put', TOKEN_KEY], { stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('close', (code) => resolve(code === 0));
    child.stdin.end(token);
  });

const page = (response, status, message) => {
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(`<!doctype html><meta charset="utf-8"><title>Totaaltegel M2M</title><p>${message}</p>`);
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://localhost:${PORT}`);

  if (url.pathname === '/') {
    response.writeHead(302, { Location: authorizeUrl });
    response.end();
    return;
  }

  if (url.pathname !== '/callback') return page(response, 404, 'Not found');

  const params = url.searchParams;

  if (params.get('state') !== state) return page(response, 403, 'State klopt niet. Start het script opnieuw.');
  if (!validHmac(params)) return page(response, 403, 'HMAC klopt niet. Controleer SHOPIFY_CLIENT_SECRET.');
  if (params.get('shop') !== shop) return page(response, 403, `Verkeerde winkel: ${params.get('shop')}`);

  const code = params.get('code');
  if (!code) return page(response, 400, 'Geen code ontvangen.');

  try {
    const { access_token: token, scope = '' } = await exchangeCode(code);
    page(response, 200, 'Token ontvangen. Je kunt dit venster sluiten en terug naar de terminal.');

    upsertDevVar(TOKEN_KEY, token);
    console.log(`✔ Token saved to ${DEV_VARS} (${TOKEN_KEY}). Granted scopes: ${scope || '(none reported)'}`);

    const missing = SCOPES.split(',').filter((needed) => !scope.split(',').includes(needed));
    if (missing.length) console.warn(`▲ Missing scopes: ${missing.join(', ')}. Add them to the app version and run again.`);

    console.log(`✔ Admin API check: ${await checkToken(token)}`);

    if (PUSH_TO_WORKER) {
      console.log(`… Uploading ${TOKEN_KEY} to the Worker`);
      const pushed = await pushToWorker(token);
      if (!pushed) console.warn(`▲ Upload failed. Run: npx wrangler secret put ${TOKEN_KEY}`);
    }
  } catch (error) {
    page(response, 502, 'Token ophalen mislukt. Zie de terminal.');
    console.error(`✘ ${error.message}`);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

server.listen(PORT, 'localhost', () => {
  console.log(`Redirect URL that must be allowed on the app: ${REDIRECT_URI}`);
  console.log(`Open http://localhost:${PORT} and approve the app on ${shop}.`);
  if (process.platform === 'darwin' && !process.argv.includes('--no-open')) spawn('open', [`http://localhost:${PORT}`], { stdio: 'ignore' }).unref();
});
