/**
 * WriteLens - paid-tier text quality scoring API.
 *
 * POST /v1/score
 *   body: { text, criteria? }
 *   returns: { clarity, persuasiveness, structure, factuality_concerns, overall, suggestions }
 *
 * Free tier: 50 calls / day / IP
 * Paid tier: $49 subscription for 1000 authenticated calls
 */

interface Env {
  AI: any;
  ASSETS: Fetcher;
  WL_RATE: KVNamespace;
  WL_KEYS: KVNamespace;
  PUBLIC_BASE_URL?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_PRICE_ID?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_SUCCESS_URL?: string;
  STRIPE_CANCEL_URL?: string;
  STRIPE_API_BASE?: string;
}

interface KeyRecord {
  id: string;
  key_hash: string;
  email: string;
  created_at: string;
  plan?: string;
  subscription_status?: 'active' | 'inactive' | 'expired';
  subscription_provider?: 'stripe' | string;
  period_start?: string;
  period_end?: string;
  call_count: number;
  calls_this_period?: number;
  quota_calls?: number;
  price_cents?: number;
  paid_at?: string;
  stripe_customer_id?: string;
  stripe_subscription_id?: string;
  stripe_checkout_session_id?: string;
  last_payment_id?: string;
  last_invoice_id?: string;
  active: boolean;
  // Legacy crypto checkout fields can still exist on records minted before the
  // Stripe subscription gate. They are intentionally not enough to authorize calls.
  last_payment_quote_id?: string;
  last_payment_tx_hash?: string;
  cents_owed?: number;
  cap_cents?: number;
}

interface PendingStripeCheckout {
  provider: 'stripe';
  pending_id: string;
  session_id: string;
  email: string;
  plan: string;
  quota_calls: number;
  price_cents: number;
  period_days: number;
  created_at: string;
  payment_status?: string;
  stripe_status?: string;
  paid_at?: string;
  claimed_at?: string;
  key_id?: string;
  stripe_customer_id?: string;
  stripe_subscription_id?: string;
  period_start?: string;
  period_end?: string;
}

interface StripeConfig {
  secretKey: string;
  priceId: string;
  apiBase: string;
}

interface StripeAuthConfig {
  secretKey: string;
  apiBase: string;
}

const FREE_DAILY_LIMIT = 50;
const MAX_TEXT_CHARS = 16_000;
const PAID_PLAN_ID = 'paid_1000';
const PAID_PLAN_SKU = 'writelens:paid-tier-1000';
const PAID_PLAN_NAME = '$49 / 1000 calls';
const PAID_PLAN_PRICE_CENTS = 4900;
const PAID_PLAN_CALLS = 1000;
const PAID_PLAN_PERIOD_DAYS = 30;
const STRIPE_API_DEFAULT = 'https://api.stripe.com/v1';
const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

const SYSTEM_PROMPT = `You are WriteLens, an expert evaluator of writing quality.

Read the user's text and return JSON with this shape:
{
  "clarity": <0-10>,
  "persuasiveness": <0-10>,
  "structure": <0-10>,
  "factuality_concerns": [<string short flags>],
  "overall": <0-10>,
  "suggestions": [<string short suggestions>]
}

Score guideline: 0=incoherent, 5=passable, 7=publishable, 9=excellent.
Return ONLY valid JSON, no preamble, no markdown.`;

class BillingConfigError extends Error {}

class StripeApiError extends Error {
  status: number;
  detail: string;

  constructor(status: number, detail: string) {
    super(`Stripe API ${status}`);
    this.status = status;
    this.detail = detail;
  }
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function randomId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return prefix + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '').replace(/\//g, '').replace(/=+$/, '');
}

function newKeyId(): string {
  return randomId('wl_');
}

function newPendingId(): string {
  return randomId('co_');
}

function checkoutKey(sessionId: string): string {
  return `stripe:checkout:${sessionId}`;
}

function sessionClaimKey(sessionId: string): string {
  return `stripe:session:${sessionId}:key`;
}

function subscriptionKey(subscriptionId: string): string {
  return `stripe:subscription:${subscriptionId}`;
}

function customerKey(customerId: string): string {
  return `stripe:customer:${customerId}`;
}

function eventKey(eventId: string): string {
  return `stripe:event:${eventId}`;
}

async function rateCheckIp(ip: string, env: Env): Promise<{ allowed: boolean; remaining: number }> {
  const key = `rl:${ip}:${new Date().toISOString().slice(0, 10)}`;
  const cur = Number(await env.WL_RATE.get(key) ?? 0);
  if (cur >= FREE_DAILY_LIMIT) return { allowed: false, remaining: 0 };
  await env.WL_RATE.put(key, String(cur + 1), { expirationTtl: 60 * 60 * 26 });
  return { allowed: true, remaining: FREE_DAILY_LIMIT - cur - 1 };
}

async function getKeyRecord(rawKey: string, env: Env): Promise<KeyRecord | null> {
  const hash = await sha256Hex(rawKey);
  const v = await env.WL_KEYS.get(`hash:${hash}`);
  if (!v) return null;
  return JSON.parse(v) as KeyRecord;
}

function apiKeyFromRequest(req: Request): string | null {
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim();
  if (bearer) return bearer;
  const headerKey = req.headers.get('x-api-key')?.trim();
  return headerKey || null;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function callsUsedThisPeriod(rec: KeyRecord): number {
  return Math.max(0, Number(rec.calls_this_period ?? rec.call_count ?? 0));
}

function paidKeyProblem(rec: KeyRecord): { error: string; message: string; status: number } | null {
  if (!rec.active) {
    return {
      error: 'invalid_or_inactive_api_key',
      message: 'This API key is inactive. Start a paid subscription to get a new key.',
      status: 401,
    };
  }
  if (rec.plan !== PAID_PLAN_ID || rec.subscription_status !== 'active') {
    return {
      error: 'subscription_required',
      message: 'Authenticated API calls require the $49/1000-calls paid tier.',
      status: 402,
    };
  }

  const periodEnd = rec.period_end ? Date.parse(rec.period_end) : NaN;
  if (!Number.isFinite(periodEnd) || Date.now() >= periodEnd) {
    return {
      error: 'subscription_expired',
      message: 'This paid period has expired. Renew to continue using this API key.',
      status: 402,
    };
  }

  const quota = Number(rec.quota_calls ?? 0);
  if (quota <= 0 || callsUsedThisPeriod(rec) >= quota) {
    return {
      error: 'subscription_quota_exhausted',
      message: 'This paid key has used its 1000 included calls. Renew to continue.',
      status: 402,
    };
  }
  return null;
}

async function meterApiCall(rec: KeyRecord, env: Env) {
  const used = callsUsedThisPeriod(rec);
  rec.call_count = Math.max(0, Number(rec.call_count ?? 0)) + 1;
  rec.calls_this_period = used + 1;
  await env.WL_KEYS.put(`hash:${rec.key_hash}`, JSON.stringify(rec));
  await env.WL_KEYS.put(`id:${rec.id}`, JSON.stringify(rec));
}

function tryParseJson(s: unknown): any | null {
  if (s == null) return null;
  if (typeof s === 'object') return s;
  const str = typeof s === 'string' ? s : String(s);
  const cleaned = str.replace(/^```json\s*|\s*```$/g, '').trim();
  try { return JSON.parse(cleaned); } catch { return null; }
}

async function handleScore(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: 'invalid JSON' }, { status: 400 }); }
  const text = String(body?.text ?? '');
  if (!text) return Response.json({ error: 'missing text' }, { status: 400 });
  if (text.length > MAX_TEXT_CHARS) {
    return Response.json({ error: `text exceeds ${MAX_TEXT_CHARS} chars` }, { status: 400 });
  }

  const authValue = apiKeyFromRequest(req);
  let usingKey: KeyRecord | null = null;
  let remaining: number | undefined;

  if (authValue) {
    usingKey = await getKeyRecord(authValue, env);
    if (!usingKey) {
      return Response.json({ error: 'invalid_or_inactive_api_key' }, { status: 401 });
    }
    const problem = paidKeyProblem(usingKey);
    if (problem) {
      return Response.json({
        error: problem.error,
        message: problem.message,
        subscribe_url: '/api/subscribe',
      }, { status: problem.status });
    }
  } else {
    const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
    const rl = await rateCheckIp(ip, env);
    if (!rl.allowed) {
      return Response.json({
        error: 'free quota exhausted',
        message: 'Subscribe for a paid API key with 1000 included calls.',
        signup_url: '/api/subscribe',
      }, { status: 429 });
    }
    remaining = rl.remaining;
  }

  let aiResp: any;
  try {
    aiResp = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Evaluate this text:\n\n---\n${text}\n---` },
      ],
      max_tokens: 1200,
    });
  } catch (err) {
    return Response.json({ error: `inference: ${(err as Error).message}` }, { status: 500 });
  }

  const raw = aiResp?.response ?? aiResp?.result ?? aiResp;
  const parsed = tryParseJson(raw);
  if (!parsed || typeof parsed.overall !== 'number') {
    return Response.json({
      error: 'analysis output malformed',
      raw_preview: typeof raw === 'string' ? raw.slice(0, 300) : JSON.stringify(raw).slice(0, 300),
    }, { status: 502 });
  }

  if (usingKey) await meterApiCall(usingKey, env);

  return Response.json({
    clarity: clamp(parsed.clarity, 0, 10),
    persuasiveness: clamp(parsed.persuasiveness, 0, 10),
    structure: clamp(parsed.structure, 0, 10),
    factuality_concerns: Array.isArray(parsed.factuality_concerns) ? parsed.factuality_concerns.slice(0, 8) : [],
    overall: clamp(parsed.overall, 0, 10),
    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 8) : [],
    char_count: text.length,
    ...(remaining !== undefined && { quota_remaining: remaining }),
    ...(usingKey && {
      plan: usingKey.plan,
      subscription_status: usingKey.subscription_status,
      calls_this_period: callsUsedThisPeriod(usingKey),
      quota_calls: usingKey.quota_calls,
      paid_calls_remaining: Math.max(0, Number(usingKey.quota_calls ?? 0) - callsUsedThisPeriod(usingKey)),
      period_end: usingKey.period_end,
    }),
  });
}

function clamp(n: any, lo: number, hi: number): number {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(lo, Math.min(hi, x));
}

function keyStatusJson(r: KeyRecord): Record<string, unknown> {
  const used = callsUsedThisPeriod(r);
  const quota = Number(r.quota_calls ?? 0);
  return {
    id: r.id,
    email: r.email,
    active: r.active,
    plan: r.plan ?? null,
    subscription_status: r.subscription_status ?? null,
    subscription_provider: r.subscription_provider ?? null,
    period_start: r.period_start ?? null,
    period_end: r.period_end ?? null,
    call_count: r.call_count,
    calls_this_period: used,
    quota_calls: quota,
    paid_calls_remaining: Math.max(0, quota - used),
    price_cents: r.price_cents ?? null,
    created_at: r.created_at,
  };
}

async function handleKeyRequest(req: Request, env: Env): Promise<Response> {
  return handleSubscribe(req, env);
}

async function handleKeyStatus(req: Request, env: Env, id: string): Promise<Response> {
  const v = await env.WL_KEYS.get(`id:${id}`);
  if (!v) return Response.json({ error: 'not found' }, { status: 404 });
  return Response.json(keyStatusJson(JSON.parse(v) as KeyRecord));
}

async function handleLicenseStatus(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'GET') return new Response('method not allowed', { status: 405 });
  const rawKey = apiKeyFromRequest(req);
  if (!rawKey) return Response.json({ error: 'api key required' }, { status: 401 });
  const rec = await getKeyRecord(rawKey, env);
  if (!rec) return Response.json({ error: 'invalid_or_inactive_api_key' }, { status: 401 });
  return Response.json({
    ...keyStatusJson(rec),
    entitled: paidKeyProblem(rec) == null,
  });
}

// === Stripe-backed paid subscription ===

function stripeAuthConfig(env: Env): StripeAuthConfig {
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) throw new BillingConfigError('STRIPE_SECRET_KEY is not configured');
  return {
    secretKey,
    apiBase: (env.STRIPE_API_BASE ?? STRIPE_API_DEFAULT).replace(/\/+$/, ''),
  };
}

function stripeConfig(env: Env): StripeConfig {
  const auth = stripeAuthConfig(env);
  const priceId = env.STRIPE_PRICE_ID?.trim();
  if (!priceId) throw new BillingConfigError('STRIPE_PRICE_ID is not configured');
  return {
    ...auth,
    priceId,
  };
}

function billingConfigResponse(err: BillingConfigError): Response {
  return Response.json({
    error: 'billing_not_configured',
    message: 'Stripe billing is not configured for this deployment.',
    detail: err.message,
  }, { status: 503 });
}

async function stripePostForm(env: Env, path: string, form: URLSearchParams): Promise<any> {
  const cfg = stripeAuthConfig(env);
  const r = await fetch(`${cfg.apiBase}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${cfg.secretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });
  const text = await r.text();
  if (!r.ok) throw new StripeApiError(r.status, text);
  return JSON.parse(text);
}

async function stripeGet(env: Env, path: string): Promise<any> {
  const cfg = stripeAuthConfig(env);
  const r = await fetch(`${cfg.apiBase}${path}`, {
    headers: { authorization: `Bearer ${cfg.secretKey}` },
  });
  const text = await r.text();
  if (!r.ok) throw new StripeApiError(r.status, text);
  return JSON.parse(text);
}

function publicBaseUrl(req: Request, env: Env): string {
  if (env.PUBLIC_BASE_URL) return env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

function successUrl(req: Request, env: Env): string {
  return env.STRIPE_SUCCESS_URL ?? `${publicBaseUrl(req, env)}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`;
}

function cancelUrl(req: Request, env: Env): string {
  return env.STRIPE_CANCEL_URL ?? `${publicBaseUrl(req, env)}/?checkout=cancelled`;
}

function stripeId(value: any): string | undefined {
  if (!value) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value.id === 'string') return value.id;
  return undefined;
}

function checkoutSessionPaid(session: any): boolean {
  return session?.status === 'complete' && session?.payment_status === 'paid';
}

async function stripeSubscriptionForSession(env: Env, session: any): Promise<any | null> {
  const sub = session?.subscription;
  if (sub && typeof sub === 'object') return sub;
  const id = stripeId(sub);
  if (!id) return null;
  return stripeGet(env, `/subscriptions/${encodeURIComponent(id)}`);
}

function stripeSubscriptionPeriod(subscription: any, fallback: Date): { start: Date; end: Date } {
  const item = Array.isArray(subscription?.items?.data) ? subscription.items.data[0] : null;
  const startSeconds = Number(subscription?.current_period_start ?? item?.current_period_start ?? 0);
  const endSeconds = Number(subscription?.current_period_end ?? item?.current_period_end ?? 0);
  const start = startSeconds > 0 ? new Date(startSeconds * 1000) : fallback;
  const end = endSeconds > 0 ? new Date(endSeconds * 1000) : addDays(start, PAID_PLAN_PERIOD_DAYS);
  return { start, end };
}

function stripeSubscriptionActive(subscription: any): boolean {
  const status = String(subscription?.status ?? '').toLowerCase();
  return status === 'active' || status === 'trialing';
}

function stripeSubscriptionStatus(subscription: any, periodEnd: Date): 'active' | 'inactive' | 'expired' {
  if (stripeSubscriptionActive(subscription) && Date.now() < periodEnd.getTime()) return 'active';
  if (Date.now() >= periodEnd.getTime()) return 'expired';
  return 'inactive';
}

async function retrieveCheckoutSession(env: Env, sessionId: string): Promise<any> {
  const qs = new URLSearchParams();
  qs.append('expand[]', 'subscription');
  return stripeGet(env, `/checkout/sessions/${encodeURIComponent(sessionId)}?${qs.toString()}`);
}

// A buyer POSTs { email } to start the $49/1000-call paid tier. We create a
// Stripe-hosted Checkout Session and return the URL. The API key is minted only
// after Stripe marks the session paid and the buyer returns to claim it.
async function handleSubscribe(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: 'invalid JSON' }, { status: 400 }); }
  const email = String(body?.email ?? '').trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return Response.json({ error: 'valid email required' }, { status: 400 });
  }

  let cfg: StripeConfig;
  try {
    cfg = stripeConfig(env);
  } catch (err) {
    if (err instanceof BillingConfigError) return billingConfigResponse(err);
    throw err;
  }

  const pendingId = newPendingId();
  const form = new URLSearchParams();
  form.set('mode', 'subscription');
  form.set('line_items[0][price]', cfg.priceId);
  form.set('line_items[0][quantity]', '1');
  form.set('customer_email', email);
  form.set('client_reference_id', pendingId);
  form.set('success_url', successUrl(req, env));
  form.set('cancel_url', cancelUrl(req, env));
  form.set('allow_promotion_codes', 'true');
  form.set('metadata[pending_id]', pendingId);
  form.set('metadata[plan]', PAID_PLAN_ID);
  form.set('metadata[sku]', PAID_PLAN_SKU);
  form.set('subscription_data[metadata][pending_id]', pendingId);
  form.set('subscription_data[metadata][plan]', PAID_PLAN_ID);
  form.set('subscription_data[metadata][sku]', PAID_PLAN_SKU);

  let session: any;
  try {
    session = await stripePostForm(env, '/checkout/sessions', form);
  } catch (err) {
    if (err instanceof StripeApiError) {
      return Response.json({ error: 'checkout_unavailable', status: err.status, detail: err.detail }, { status: 502 });
    }
    if (err instanceof BillingConfigError) return billingConfigResponse(err);
    throw err;
  }

  if (!session?.id || !session?.url) {
    return Response.json({ error: 'checkout_unavailable', detail: 'Stripe did not return a checkout URL' }, { status: 502 });
  }

  const pending: PendingStripeCheckout = {
    provider: 'stripe',
    pending_id: pendingId,
    session_id: session.id,
    email,
    plan: PAID_PLAN_ID,
    quota_calls: PAID_PLAN_CALLS,
    price_cents: PAID_PLAN_PRICE_CENTS,
    period_days: PAID_PLAN_PERIOD_DAYS,
    created_at: new Date().toISOString(),
    payment_status: session.payment_status,
    stripe_status: session.status,
    stripe_customer_id: stripeId(session.customer),
    stripe_subscription_id: stripeId(session.subscription),
  };
  await env.WL_KEYS.put(checkoutKey(session.id), JSON.stringify(pending), { expirationTtl: 60 * 60 * 24 * 14 });

  return Response.json({
    status: 'checkout_required',
    provider: 'stripe',
    tier: PAID_PLAN_ID,
    plan: {
      name: PAID_PLAN_NAME,
      price_cents: PAID_PLAN_PRICE_CENTS,
      quota_calls: PAID_PLAN_CALLS,
      period_days: PAID_PLAN_PERIOD_DAYS,
    },
    session_id: session.id,
    checkout_url: session.url,
    claim_url: '/api/checkout/claim',
  });
}

async function handleCheckoutClaim(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: 'invalid JSON' }, { status: 400 }); }
  const sessionId = String(body?.session_id ?? '').trim();
  if (!/^cs_(test|live)_[A-Za-z0-9_]+$/.test(sessionId)) {
    return Response.json({ error: 'valid Stripe checkout session_id required' }, { status: 400 });
  }

  const pendingRaw = await env.WL_KEYS.get(checkoutKey(sessionId));
  if (!pendingRaw) return Response.json({ error: 'checkout_not_found_or_expired' }, { status: 404 });
  const pending = JSON.parse(pendingRaw) as PendingStripeCheckout;
  if (pending.claimed_at || pending.key_id) {
    return Response.json({
      error: 'key_already_claimed',
      message: 'This checkout session has already claimed its API key.',
      id: pending.key_id ?? null,
      key_status_url: pending.key_id ? `/api/key/${pending.key_id}` : null,
    }, { status: 409 });
  }

  const existingKeyId = await env.WL_KEYS.get(sessionClaimKey(sessionId));
  if (existingKeyId) {
    pending.claimed_at = new Date().toISOString();
    pending.key_id = existingKeyId;
    await env.WL_KEYS.put(checkoutKey(sessionId), JSON.stringify(pending), { expirationTtl: 60 * 60 * 24 * 14 });
    return Response.json({
      error: 'key_already_claimed',
      message: 'This checkout session has already claimed its API key.',
      id: existingKeyId,
      key_status_url: `/api/key/${existingKeyId}`,
    }, { status: 409 });
  }

  let session: any;
  let subscription: any | null;
  try {
    session = await retrieveCheckoutSession(env, sessionId);
    subscription = await stripeSubscriptionForSession(env, session);
  } catch (err) {
    if (err instanceof StripeApiError) {
      return Response.json({ error: 'checkout_verification_failed', status: err.status, detail: err.detail }, { status: 502 });
    }
    if (err instanceof BillingConfigError) return billingConfigResponse(err);
    throw err;
  }

  if (session.id !== pending.session_id || session.client_reference_id !== pending.pending_id) {
    return Response.json({ error: 'checkout_session_mismatch' }, { status: 400 });
  }
  if (!checkoutSessionPaid(session)) {
    pending.payment_status = session.payment_status;
    pending.stripe_status = session.status;
    await env.WL_KEYS.put(checkoutKey(sessionId), JSON.stringify(pending), { expirationTtl: 60 * 60 * 24 * 14 });
    return Response.json({
      error: 'payment_not_complete',
      message: 'Stripe has not marked this checkout session paid yet.',
      payment_status: session.payment_status,
      stripe_status: session.status,
    }, { status: 402 });
  }
  if (!subscription || !stripeSubscriptionActive(subscription)) {
    return Response.json({
      error: 'subscription_not_active',
      message: 'Stripe has not activated the subscription for this checkout session yet.',
    }, { status: 402 });
  }

  const rawKey = newKeyId();
  const hash = await sha256Hex(rawKey);
  const id = newKeyId();
  const now = new Date();
  const period = stripeSubscriptionPeriod(subscription, now);
  const customerId = stripeId(session.customer) ?? stripeId(subscription.customer);
  const subscriptionId = stripeId(subscription);
  const email = String(session.customer_details?.email ?? session.customer_email ?? pending.email).trim().toLowerCase();
  const record: KeyRecord = {
    id,
    key_hash: hash,
    email,
    created_at: now.toISOString(),
    plan: PAID_PLAN_ID,
    subscription_status: stripeSubscriptionStatus(subscription, period.end),
    subscription_provider: 'stripe',
    period_start: period.start.toISOString(),
    period_end: period.end.toISOString(),
    call_count: 0,
    calls_this_period: 0,
    quota_calls: pending.quota_calls || PAID_PLAN_CALLS,
    price_cents: pending.price_cents || PAID_PLAN_PRICE_CENTS,
    paid_at: now.toISOString(),
    stripe_customer_id: customerId,
    stripe_subscription_id: subscriptionId,
    stripe_checkout_session_id: sessionId,
    last_payment_id: stripeId(session.payment_intent) ?? stripeId(session.invoice) ?? sessionId,
    active: stripeSubscriptionStatus(subscription, period.end) === 'active',
  };

  await env.WL_KEYS.put(`hash:${hash}`, JSON.stringify(record));
  await env.WL_KEYS.put(`id:${id}`, JSON.stringify(record));
  await env.WL_KEYS.put(`email:${email}`, id);
  await env.WL_KEYS.put(sessionClaimKey(sessionId), id, { expirationTtl: 60 * 60 * 24 * 90 });
  if (subscriptionId) await env.WL_KEYS.put(subscriptionKey(subscriptionId), id);
  if (customerId) await env.WL_KEYS.put(customerKey(customerId), id);

  pending.payment_status = session.payment_status;
  pending.stripe_status = session.status;
  pending.paid_at = now.toISOString();
  pending.claimed_at = now.toISOString();
  pending.key_id = id;
  pending.stripe_customer_id = customerId;
  pending.stripe_subscription_id = subscriptionId;
  pending.period_start = record.period_start;
  pending.period_end = record.period_end;
  await env.WL_KEYS.put(checkoutKey(sessionId), JSON.stringify(pending), { expirationTtl: 60 * 60 * 24 * 14 });

  return Response.json({
    ok: true,
    tier: PAID_PLAN_ID,
    key: rawKey,
    api_key: rawKey,
    id,
    price_cents: record.price_cents,
    quota_calls: record.quota_calls,
    period_start: record.period_start,
    period_end: record.period_end,
    subscription_status: record.subscription_status,
    note: 'Save this key - shown once. Send to /v1/score as a Bearer token or X-API-Key.',
  }, { status: 201 });
}

async function handleCheckoutStatus(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'GET') return new Response('method not allowed', { status: 405 });
  const url = new URL(req.url);
  const sessionId = url.searchParams.get('session_id') ?? url.searchParams.get('quote_id');
  if (!sessionId) return Response.json({ error: 'session_id required' }, { status: 400 });
  const pendingRaw = await env.WL_KEYS.get(checkoutKey(sessionId));
  if (!pendingRaw) return Response.json({ error: 'checkout_not_found_or_expired' }, { status: 404 });
  const pending = JSON.parse(pendingRaw) as PendingStripeCheckout;

  let live: any | null = null;
  try {
    live = await retrieveCheckoutSession(env, sessionId);
    pending.payment_status = live.payment_status;
    pending.stripe_status = live.status;
    if (checkoutSessionPaid(live) && !pending.paid_at) pending.paid_at = new Date().toISOString();
    await env.WL_KEYS.put(checkoutKey(sessionId), JSON.stringify(pending), { expirationTtl: 60 * 60 * 24 * 14 });
  } catch (err) {
    if (!(err instanceof BillingConfigError || err instanceof StripeApiError)) throw err;
  }

  return Response.json({
    provider: 'stripe',
    session_id: sessionId,
    paid: Boolean(pending.paid_at || checkoutSessionPaid(live)),
    claimed: Boolean(pending.claimed_at || pending.key_id),
    key_id: pending.key_id ?? null,
    payment_status: live?.payment_status ?? pending.payment_status ?? null,
    stripe_status: live?.status ?? pending.stripe_status ?? null,
    plan: pending.plan,
  });
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const aa = a.toLowerCase();
  const bb = b.toLowerCase();
  let mismatch = aa.length ^ bb.length;
  const len = Math.max(aa.length, bb.length);
  for (let i = 0; i < len; i++) {
    mismatch |= (aa.charCodeAt(i) || 0) ^ (bb.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}

async function verifyStripeSignature(payload: string, signatureHeader: string, secret: string): Promise<boolean> {
  const parts = signatureHeader.split(',').map(part => part.trim().split('='));
  const timestamp = parts.find(([k]) => k === 't')?.[1];
  const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v).filter(Boolean);
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > STRIPE_WEBHOOK_TOLERANCE_SECONDS) {
    return false;
  }
  const expected = await hmacHex(secret, `${timestamp}.${payload}`);
  return signatures.some(sig => timingSafeEqualHex(sig, expected));
}

async function updatePendingFromSession(env: Env, session: any): Promise<void> {
  const sessionId = stripeId(session);
  if (!sessionId) return;
  const pendingRaw = await env.WL_KEYS.get(checkoutKey(sessionId));
  if (!pendingRaw) return;
  const pending = JSON.parse(pendingRaw) as PendingStripeCheckout;
  pending.payment_status = session.payment_status;
  pending.stripe_status = session.status;
  pending.stripe_customer_id = stripeId(session.customer) ?? pending.stripe_customer_id;
  pending.stripe_subscription_id = stripeId(session.subscription) ?? pending.stripe_subscription_id;
  if (checkoutSessionPaid(session)) pending.paid_at = pending.paid_at ?? new Date().toISOString();

  try {
    const subscription = await stripeSubscriptionForSession(env, session);
    if (subscription) {
      const period = stripeSubscriptionPeriod(subscription, new Date());
      pending.period_start = period.start.toISOString();
      pending.period_end = period.end.toISOString();
      pending.stripe_subscription_id = stripeId(subscription) ?? pending.stripe_subscription_id;
    }
  } catch (err) {
    if (!(err instanceof StripeApiError || err instanceof BillingConfigError)) throw err;
  }

  await env.WL_KEYS.put(checkoutKey(sessionId), JSON.stringify(pending), { expirationTtl: 60 * 60 * 24 * 14 });
}

async function syncStripeSubscription(env: Env, subscription: any): Promise<void> {
  const subscriptionId = stripeId(subscription);
  if (!subscriptionId) return;
  const keyId = await env.WL_KEYS.get(subscriptionKey(subscriptionId));
  if (!keyId) return;
  const raw = await env.WL_KEYS.get(`id:${keyId}`);
  if (!raw) return;

  const rec = JSON.parse(raw) as KeyRecord;
  const previousPeriodStart = rec.period_start;
  const period = stripeSubscriptionPeriod(subscription, rec.period_start ? new Date(rec.period_start) : new Date());
  const status = stripeSubscriptionStatus(subscription, period.end);
  if (previousPeriodStart && previousPeriodStart !== period.start.toISOString()) {
    rec.calls_this_period = 0;
  }
  rec.subscription_status = status;
  rec.active = status === 'active';
  rec.period_start = period.start.toISOString();
  rec.period_end = period.end.toISOString();
  rec.stripe_subscription_id = subscriptionId;
  rec.stripe_customer_id = stripeId(subscription.customer) ?? rec.stripe_customer_id;

  await env.WL_KEYS.put(`id:${rec.id}`, JSON.stringify(rec));
  await env.WL_KEYS.put(`hash:${rec.key_hash}`, JSON.stringify(rec));
}

async function syncSubscriptionById(env: Env, subscriptionId: string): Promise<void> {
  const subscription = await stripeGet(env, `/subscriptions/${encodeURIComponent(subscriptionId)}`);
  await syncStripeSubscription(env, subscription);
}

async function handleStripeWebhook(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const secret = env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return Response.json({ error: 'webhook_not_configured' }, { status: 503 });
  }

  const payload = await req.text();
  const signature = req.headers.get('stripe-signature') ?? '';
  if (!signature || !(await verifyStripeSignature(payload, signature, secret))) {
    return Response.json({ error: 'invalid_signature' }, { status: 400 });
  }

  let event: any;
  try { event = JSON.parse(payload); } catch { return Response.json({ error: 'invalid JSON' }, { status: 400 }); }
  if (!event?.id || !event?.type) return Response.json({ error: 'invalid_event' }, { status: 400 });
  if (await env.WL_KEYS.get(eventKey(event.id))) return Response.json({ received: true, duplicate: true });

  const obj = event.data?.object;
  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await updatePendingFromSession(env, obj);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await syncStripeSubscription(env, obj);
        break;
      case 'invoice.paid':
      case 'invoice.payment_succeeded':
      case 'invoice.payment_failed': {
        const subscriptionId = stripeId(obj?.subscription);
        if (subscriptionId) await syncSubscriptionById(env, subscriptionId);
        break;
      }
      default:
        break;
    }
  } catch (err) {
    if (err instanceof StripeApiError) {
      return Response.json({ error: 'stripe_sync_failed', status: err.status, detail: err.detail }, { status: 502 });
    }
    if (err instanceof BillingConfigError) return billingConfigResponse(err);
    throw err;
  }

  await env.WL_KEYS.put(eventKey(event.id), '1', { expirationTtl: 60 * 60 * 24 * 30 });
  return Response.json({ received: true });
}

async function handleLegacyConfirm(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: 'invalid JSON' }, { status: 400 }); }
  if (body?.session_id) {
    return handleCheckoutClaim(new Request(req.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: body.session_id }),
    }), env);
  }
  return Response.json({
    error: 'checkout_flow_changed',
    message: 'WriteLens now uses Stripe Checkout. Start at /api/subscribe and claim with /api/checkout/claim.',
  }, { status: 410 });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/v1/score') return handleScore(req, env);
    if (url.pathname === '/api/key/request') return handleKeyRequest(req, env);
    if (url.pathname === '/api/subscribe') return handleSubscribe(req, env);
    if (url.pathname === '/api/checkout/claim') return handleCheckoutClaim(req, env);
    if (url.pathname === '/api/checkout/status') return handleCheckoutStatus(req, env);
    if (url.pathname === '/api/license') return handleLicenseStatus(req, env);
    if (url.pathname === '/api/stripe/webhook') return handleStripeWebhook(req, env);
    if (url.pathname === '/api/confirm') return handleLegacyConfirm(req, env);
    if (url.pathname === '/api/pay-status') return handleCheckoutStatus(req, env);
    const m = url.pathname.match(/^\/api\/key\/([a-zA-Z0-9_-]+)$/);
    if (m) return handleKeyStatus(req, env, m[1]);
    return env.ASSETS.fetch(req);
  },
};
