/**
 * WriteLens — paid-tier text quality scoring API.
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
  // Shared fleet money rail. PAYRAIL is a service binding (preferred — a direct
  // internal worker→worker call that skips the public edge, so it dodges both the
  // *.workers.dev same-zone restriction and edge bot-management). PAYRAIL_URL is the
  // public-hostname fallback (used when the binding is absent, e.g. local/standby).
  // SHIP_HMAC_SECRET (a wrangler secret, unset by default) signs receipt writes.
  PAYRAIL?: Fetcher;
  PAYRAIL_URL?: string;
  SHIP_HMAC_SECRET?: string;
}

interface KeyRecord {
  id: string;
  key_hash: string;
  email: string;
  created_at: string;
  plan?: string;
  subscription_status?: 'active' | 'inactive' | 'expired';
  period_start?: string;
  period_end?: string;
  call_count: number;
  calls_this_period?: number;
  quota_calls?: number;
  price_cents?: number;
  paid_at?: string;
  last_payment_quote_id?: string;
  last_payment_tx_hash?: string;
  active: boolean;
  // Legacy metered fields can still exist on records minted before the paid
  // subscription gate. They are intentionally not enough to authorize calls.
  cents_owed?: number;
  cap_cents?: number;
}

const FREE_DAILY_LIMIT = 50;
const MAX_TEXT_CHARS = 16_000;
const PAID_PLAN_ID = 'paid_1000';
const PAID_PLAN_SKU = 'writelens:paid-tier-1000';
const PAID_PLAN_PRICE = '49';
const PAID_PLAN_PRICE_CENTS = 4900;
const PAID_PLAN_CALLS = 1000;
const PAID_PLAN_PERIOD_DAYS = 30;

// === payrail (shared fleet money rail) ===
// writelens plugs into the live payrail Worker instead of re-implementing
// "wallet unset / no checkout". payrail returns where to send money + a memo
// (quote_id); the buyer pays on-chain, then /api/confirm records the receipt
// and mints an active API key. writelens is subscription-gated: $49 USDC unlocks
// 1000 authenticated calls for the current paid period.
const PAYRAIL_DEFAULT = 'https://payrail.ivixivi.workers.dev';

interface PayrailQuote {
  quote_id: string;
  pay_to: { rail: string; chain: string; asset: string; address: string; amount: string } | null;
  checkout: string | null;
  instructions: string;
  expires_in_seconds: number;
}

// Single egress point to payrail. Prefers the service binding (an internal
// worker→worker call that never touches the public edge → immune to both the
// *.workers.dev same-zone restriction and edge bot-management). Falls back to the
// public hostname with a browser UA so even the fallback clears bot filters. When
// the binding is used the host in the URL is ignored — only path/query/method/body.
function payrailFetch(env: Env, path: string, init?: RequestInit): Promise<Response> {
  if (env.PAYRAIL) return env.PAYRAIL.fetch(new Request(`https://payrail${path}`, init));
  const base = env.PAYRAIL_URL ?? PAYRAIL_DEFAULT;
  const headers = new Headers(init?.headers);
  if (!headers.has('user-agent')) {
    headers.set('user-agent', 'Mozilla/5.0 (compatible; writelens/1.0; +https://writelens.ivixivi.workers.dev)');
  }
  return fetch(base + path, { ...init, headers });
}

async function payrailSubscriptionQuote(env: Env): Promise<PayrailQuote> {
  const qs = new URLSearchParams({
    ship: 'writelens',
    sku: PAID_PLAN_SKU,
    amount: PAID_PLAN_PRICE,
    currency: 'USDC',
  });
  const r = await payrailFetch(env, `/pay?${qs.toString()}`);
  if (!r.ok) throw new Error(`payrail /pay ${r.status}`);
  return r.json();
}

// HMAC-SHA256 hex, byte-identical to payrail's hmac() so timingSafeEqual passes.
// Only used when SHIP_HMAC_SECRET is set (payrail has none today → optional).
async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

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

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function newKeyId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return 'wl_' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '').replace(/\//g, '').replace(/=+$/, '');
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

async function handleKeyRequest(req: Request, env: Env): Promise<Response> {
  return handleSubscribe(req, env);
}

async function handleKeyStatus(req: Request, env: Env, id: string): Promise<Response> {
  const v = await env.WL_KEYS.get(`id:${id}`);
  if (!v) return Response.json({ error: 'not found' }, { status: 404 });
  const r = JSON.parse(v) as KeyRecord;
  const used = callsUsedThisPeriod(r);
  const quota = Number(r.quota_calls ?? 0);
  return Response.json({
    id: r.id,
    email: r.email,
    active: r.active,
    plan: r.plan ?? null,
    subscription_status: r.subscription_status ?? null,
    period_start: r.period_start ?? null,
    period_end: r.period_end ?? null,
    call_count: r.call_count,
    calls_this_period: used,
    quota_calls: quota,
    paid_calls_remaining: Math.max(0, quota - used),
    price_cents: r.price_cents ?? null,
    created_at: r.created_at,
  });
}

// === payrail-backed paid subscription ===

// A buyer POSTs { email } to start the $49/1000-call paid tier. We get a live
// quote from the shared payrail rail and return a 402 carrying the on-chain
// address + memo (quote_id). The buyer pays, then POSTs the tx hash to
// /api/confirm to mint an active subscription-backed API key.
async function handleSubscribe(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: 'invalid JSON' }, { status: 400 }); }
  const email = String(body?.email ?? '').trim().toLowerCase();
  if (!email || !email.includes('@')) return Response.json({ error: 'valid email required' }, { status: 400 });

  let q: PayrailQuote;
  try {
    q = await payrailSubscriptionQuote(env);
  } catch (err) {
    return Response.json({ error: 'rail_unavailable', detail: String(err) }, { status: 502 });
  }
  await env.WL_KEYS.put(
    `pending:${q.quote_id}`,
    JSON.stringify({
      email,
      quote_id: q.quote_id,
      plan: PAID_PLAN_ID,
      quota_calls: PAID_PLAN_CALLS,
      price_cents: PAID_PLAN_PRICE_CENTS,
      period_days: PAID_PLAN_PERIOD_DAYS,
    }),
    { expirationTtl: 60 * 60 * 24 * 7 },
  );
  return Response.json({
    status: 'payment_required',
    tier: PAID_PLAN_ID,
    plan: {
      name: '$49 / 1000 calls',
      price_cents: PAID_PLAN_PRICE_CENTS,
      quota_calls: PAID_PLAN_CALLS,
      period_days: PAID_PLAN_PERIOD_DAYS,
    },
    quote_id: q.quote_id,
    pay_to: q.pay_to,
    checkout: q.checkout,
    instructions: q.instructions,
    expires_in_seconds: q.expires_in_seconds,
    confirm_url: '/api/confirm',
  }, { status: 402 });
}

// A buyer who paid posts { quote_id, tx_hash }. We forward it to payrail
// /receipt, then mint an active KeyRecord and return the raw key once.
async function handleConfirm(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: 'invalid JSON' }, { status: 400 }); }
  const quote_id = String(body?.quote_id ?? '');
  const tx_hash = String(body?.tx_hash ?? '');
  if (!quote_id || !tx_hash) {
    return Response.json({ error: 'quote_id and tx_hash required' }, { status: 400 });
  }
  const pendingRaw = await env.WL_KEYS.get(`pending:${quote_id}`);
  if (!pendingRaw) return Response.json({ error: 'quote_not_found_or_expired' }, { status: 404 });
  const pending = JSON.parse(pendingRaw) as {
    email: string;
    quote_id: string;
    plan: string;
    quota_calls: number;
    price_cents: number;
    period_days: number;
  };
  if (pending.quote_id !== quote_id || pending.plan !== PAID_PLAN_ID) {
    return Response.json({ error: 'invalid_pending_plan' }, { status: 400 });
  }

  const payload = JSON.stringify({
    quote_id,
    ship: 'writelens',
    sku: PAID_PLAN_SKU,
    amount: PAID_PLAN_PRICE,
    currency: 'USDC',
    rail: 'crypto',
    tx_hash,
  });
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (env.SHIP_HMAC_SECRET) headers['x-payrail-signature'] = await hmacHex(env.SHIP_HMAC_SECRET, payload);

  const rr = await payrailFetch(env, '/receipt', { method: 'POST', headers, body: payload });
  if (!rr.ok) {
    return Response.json(
      { error: 'receipt_rejected', status: rr.status, detail: await rr.text().catch(() => '') },
      { status: 502 },
    );
  }
  const receiptResp = await rr.json().catch(() => ({})) as { ok?: boolean; receipt?: unknown };

  const rawKey = newKeyId();
  const hash = await sha256Hex(rawKey);
  const id = newKeyId();
  const now = new Date();
  const periodEnd = addDays(now, pending.period_days || PAID_PLAN_PERIOD_DAYS);
  const record: KeyRecord = {
    id,
    key_hash: hash,
    email: pending.email,
    created_at: now.toISOString(),
    plan: PAID_PLAN_ID,
    subscription_status: 'active',
    period_start: now.toISOString(),
    period_end: periodEnd.toISOString(),
    call_count: 0,
    calls_this_period: 0,
    quota_calls: pending.quota_calls || PAID_PLAN_CALLS,
    price_cents: pending.price_cents || PAID_PLAN_PRICE_CENTS,
    paid_at: now.toISOString(),
    last_payment_quote_id: quote_id,
    last_payment_tx_hash: tx_hash,
    active: true,
  };
  await env.WL_KEYS.put(`hash:${hash}`, JSON.stringify(record));
  await env.WL_KEYS.put(`id:${id}`, JSON.stringify(record));
  await env.WL_KEYS.put(`email:${pending.email}`, id);
  await env.WL_KEYS.delete(`pending:${quote_id}`);

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
    note: 'Save this key - shown once. Send to /v1/score as a Bearer token or X-API-Key.',
    receipt: receiptResp.receipt,
  }, { status: 201 });
}

// Poll payment status by proxying payrail's public receipt lookup.
async function handlePayStatus(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const quoteId = url.searchParams.get('quote_id');
  if (!quoteId) return Response.json({ error: 'quote_id required' }, { status: 400 });
  const r = await payrailFetch(env, `/receipt/${encodeURIComponent(quoteId)}`);
  if (r.status === 404) return Response.json({ paid: false, quote_id: quoteId });
  if (!r.ok) return Response.json({ error: 'status_unavailable', status: r.status }, { status: 502 });
  return Response.json({ paid: true, receipt: await r.json() });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/v1/score') return handleScore(req, env);
    if (url.pathname === '/api/key/request') return handleKeyRequest(req, env);
    if (url.pathname === '/api/subscribe') return handleSubscribe(req, env);
    if (url.pathname === '/api/confirm') return handleConfirm(req, env);
    if (url.pathname === '/api/pay-status') return handlePayStatus(req, env);
    const m = url.pathname.match(/^\/api\/key\/([a-zA-Z0-9_-]+)$/);
    if (m) return handleKeyStatus(req, env, m[1]);
    return env.ASSETS.fetch(req);
  },
};
