/* ================================================================
   REBEL & CLOVER — STRIPE CHECKOUT  (Cloudflare Pages Function)
   ----------------------------------------------------------------
   Turns the shopping bag into a Stripe Checkout page.

   It only switches on when Brian's Stripe secret key is saved in
   Cloudflare:  Workers & Pages → rebel-and-clover → Settings →
   Variables and Secrets → Add → Type: Secret →
   Name: STRIPE_SECRET_KEY   Value: sk_live_…  (or sk_test_… to test)
   The key never goes in this file or on GitHub.

   Prices are NOT taken from the shopper's browser — they are looked
   up again here from the site's own catalog, so nobody can edit them.
   ================================================================ */

/* ---------- SETTINGS (change these when Brian decides) ----------
   Each one can also be set in Cloudflare as a plain-text variable
   with the same name, which wins over the value written here.     */
const SETTINGS = {
  // Flat shipping charge in dollars for orders with physical items.
  // 0 = free shipping. Cloudflare variable: SHIPPING_FLAT_RATE
  SHIPPING_FLAT_RATE: 0,
  // Orders at or above this subtotal ship free (dollars). 0 = off.
  // Cloudflare variable: FREE_SHIPPING_OVER
  FREE_SHIPPING_OVER: 0,
  // Label shown on Stripe's checkout for the shipping line.
  SHIPPING_LABEL: 'Standard shipping',
  // Countries you ship to (2-letter codes). Cloudflare variable: SHIP_TO (e.g. "US,CA")
  SHIP_TO: ['US'],
  // true = let Stripe add sales tax automatically (Stripe Tax must be
  // turned on in Brian's Stripe dashboard first). Cloudflare variable: STRIPE_TAX
  STRIPE_TAX: false,
  // Short message shown above Stripe's Pay button.
  CHECKOUT_MESSAGE: 'Thank you for supporting Rebel & Clover. Pieces are made to order — we will email you with production and delivery updates.',
};

const MAX_LINES = 50;
const MAX_QTY = 99;

/* ---------- helpers ---------- */
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

function setting(env, name) {
  const raw = env && env[name];
  if (raw === undefined || raw === null || raw === '') return SETTINGS[name];
  if (name === 'SHIP_TO') return String(raw).split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (name === 'STRIPE_TAX') return /^(1|true|yes|on)$/i.test(String(raw));
  if (typeof SETTINGS[name] === 'number') return Number(raw) || 0;
  return String(raw);
}

const clean = (s, max) =>
  String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

let catalogCache = null;
async function loadCatalog(context) {
  if (catalogCache) return catalogCache;
  const url = new URL('/', context.request.url);
  const res = context.env.ASSETS ? await context.env.ASSETS.fetch(url) : await fetch(url);
  const html = await res.text();
  const m = html.match(/<script id="rc-data" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('catalog not found');
  const data = JSON.parse(m[1]);
  const byId = {};
  for (const p of data.products || []) byId[p.id] = p;
  catalogCache = { byId, assets: data.assets || {} };
  return catalogCache;
}

/* Which artwork format a bag line is for (matches the site's own logic). */
const artFormat = option => (/poster/i.test(option) ? 'poster' : /digital/i.test(option) ? 'wallpaper' : 'framed');
const FORMAT_LABEL = { framed: 'Framed print', poster: 'Poster (unframed)', wallpaper: 'Digital wallpaper (download)' };

/* Works out the real price and a clean description for one bag line.
   Returns null when the item can't be sold. */
function priceLine(p, option) {
  if (!p) return null;
  if (p.type === 'capsule' || p.catalogState === 'review' || p.catalogState === 'collection') return null;

  if (p.dept === 'art' && p.prices) {
    const fmt = artFormat(option);
    const price = p.prices[fmt];
    if (typeof price !== 'number' || price <= 0) return null;
    return { price, description: FORMAT_LABEL[fmt], digital: fmt === 'wallpaper' };
  }

  if (typeof p.price !== 'number' || p.price <= 0) return null;

  const wearable = (p.dept === 'apparel' || p.dept === 'hats');
  if (wearable) {
    const size = String(option).split('|')[0].trim();
    if (Array.isArray(p.sizes) && p.sizes.length && !p.sizes.includes(size)) return { sizeProblem: true };
    const rest = clean(String(option).split('|').slice(1).join('|'), 160);
    const description = clean(`Size ${size}${rest ? ' · ' + rest : ''}`, 250);
    return { price: p.price, description, digital: false };
  }

  const digital = p.dept === 'wallpapers' && p.catalogState !== 'active';
  return { price: p.price, description: digital ? 'Digital artwork (download)' : (clean(option, 120) || 'Made to order'), digital };
}

/* ---------- GET /api/checkout → is checkout switched on? ---------- */
export async function onRequestGet({ env }) {
  const key = env && env.STRIPE_SECRET_KEY;
  return json({
    ready: !!key,
    mode: key ? (/_test_/.test(key) ? 'test' : 'live') : null,
  });
}

/* ---------- POST /api/checkout → create a Stripe Checkout Session ---------- */
export async function onRequestPost(context) {
  const { request, env } = context;
  const key = env && env.STRIPE_SECRET_KEY;
  if (!key) return json({ error: 'Checkout is not switched on yet.' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  const items = Array.isArray(body && body.items) ? body.items.slice(0, MAX_LINES) : [];
  if (!items.length) return json({ error: 'Your bag is empty.' }, 400);

  let catalog;
  try { catalog = await loadCatalog(context); } catch (e) { return json({ error: 'Store catalog unavailable. Please try again.' }, 500); }

  const origin = new URL(request.url).origin;
  const lines = [];
  for (const it of items) {
    const p = catalog.byId[it && it.id];
    const option = clean(it && it.option, 300);
    const qty = Math.floor(Number(it && it.qty));
    if (!p || !(qty >= 1 && qty <= MAX_QTY)) return json({ error: 'Something in your bag is no longer available. Please remove it and try again.' }, 400);
    const priced = priceLine(p, option);
    if (!priced) return json({ error: `“${p.title}” can't be ordered online yet. Please remove it from your bag.` }, 400);
    if (priced.sizeProblem) return json({ error: `Please remove “${p.title}” and add it again with a size.` }, 400);
    const img = catalog.assets[p.image];
    lines.push({ p, qty, ...priced, image: img ? origin + '/' + img.replace(/^\//, '') : null });
  }

  const ref = 'RC-' + Date.now().toString(36).toUpperCase().slice(-6) + Math.random().toString(36).slice(2, 5).toUpperCase();
  const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const physical = lines.some(l => !l.digital);

  const f = new URLSearchParams();
  f.append('mode', 'payment');
  f.append('success_url', `${origin}/?order=${ref}#order-complete`);
  f.append('cancel_url', `${origin}/#bag`);
  f.append('client_reference_id', ref);
  f.append('billing_address_collection', 'auto');
  f.append('phone_number_collection[enabled]', 'true');
  lines.forEach((l, i) => {
    const b = `line_items[${i}]`;
    f.append(`${b}[quantity]`, String(l.qty));
    f.append(`${b}[price_data][currency]`, 'usd');
    f.append(`${b}[price_data][unit_amount]`, String(Math.round(l.price * 100)));
    f.append(`${b}[price_data][product_data][name]`, clean(l.p.title, 120));
    if (l.description) f.append(`${b}[price_data][product_data][description]`, l.description);
    if (l.image) f.append(`${b}[price_data][product_data][images][0]`, l.image);
    f.append(`${b}[price_data][product_data][metadata][product_id]`, l.p.id);
  });

  if (physical) {
    setting(env, 'SHIP_TO').forEach((c, i) => f.append(`shipping_address_collection[allowed_countries][${i}]`, c));
    const flat = setting(env, 'SHIPPING_FLAT_RATE');
    const freeOver = setting(env, 'FREE_SHIPPING_OVER');
    const charge = flat > 0 && !(freeOver > 0 && subtotal >= freeOver) ? flat : 0;
    f.append('shipping_options[0][shipping_rate_data][type]', 'fixed_amount');
    f.append('shipping_options[0][shipping_rate_data][display_name]', charge ? setting(env, 'SHIPPING_LABEL') : 'Free shipping');
    f.append('shipping_options[0][shipping_rate_data][fixed_amount][amount]', String(Math.round(charge * 100)));
    f.append('shipping_options[0][shipping_rate_data][fixed_amount][currency]', 'usd');
  }
  if (setting(env, 'STRIPE_TAX')) f.append('automatic_tax[enabled]', 'true');

  const msg = physical ? setting(env, 'CHECKOUT_MESSAGE') : 'Thank you for supporting Rebel & Clover. Your digital artwork will be emailed to you after payment.';
  if (msg) f.append('custom_text[submit][message]', clean(msg, 1000));

  // Order summary on the payment itself, so Brian sees it in Stripe and in his email.
  const summary = lines.map(l => `${l.qty}× ${l.p.title} — ${l.description}`).join(' | ');
  f.append('metadata[order_ref]', ref);
  f.append('metadata[items]', clean(summary, 490));
  f.append('payment_intent_data[description]', clean(`Rebel & Clover order ${ref}: ${summary}`, 900));
  f.append('payment_intent_data[metadata][order_ref]', ref);

  let res, out;
  try {
    res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: f.toString(),
    });
    out = await res.json();
  } catch (e) {
    return json({ error: 'Could not reach Stripe. Please try again in a moment.' }, 502);
  }
  if (!res.ok || !out || !out.url) {
    console.log('Stripe error', res && res.status, out && out.error && out.error.message);
    return json({ error: 'Checkout could not start. Please try again or contact us.' }, 502);
  }
  return json({ url: out.url, ref });
}
