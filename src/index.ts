/**
 * WriteLens — pay-per-call text quality scoring API.
 *
 * POST /v1/score
 *   body: { text, criteria? }
 *   returns: { clarity, persuasiveness, structure, factuality_concerns, score, suggestions }
 *
 * Free tier: 50 calls / day / IP
 * Paid tier: API key with metered usage at $0.01/call (latent — meter accrues until billing wires up)
 */

interface Env {
  AI: any;
  ASSETS: Fetcher;
  WL_RATE: KVNamespace;
  WL_KEYS: KVNamespace;
}

interface KeyRecord {
  id: string;
  key_hash: string;
  email: string;
  created_at: string;
  call_count: number;
  cents_owed: number;       // accrues at 1¢/call until billing activates
  active: boolean;
  cap_cents: number;        // soft monthly cap
}

const FREE_DAILY_LIMIT = 50;
const MAX_TEXT_CHARS = 16_000;
const PER_CALL_CENTS = 1;

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

async function meterApiCall(rec: KeyRecord, env: Env) {
  rec.call_count += 1;
  rec.cents_owed += PER_CALL_CENTS;
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

  const authValue = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
  let usingKey: KeyRecord | null = null;
  let remaining: number | undefined;

  if (authValue) {
    usingKey = await getKeyRecord(authValue, env);
    if (!usingKey || !usingKey.active) {
      return Response.json({ error: 'invalid or inactive API key' }, { status: 401 });
    }
    if (usingKey.cents_owed >= usingKey.cap_cents) {
      return Response.json({ error: 'monthly cap exceeded for this key' }, { status: 402 });
    }
  } else {
    const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
    const rl = await rateCheckIp(ip, env);
    if (!rl.allowed) {
      return Response.json({
        error: 'free quota exhausted',
        message: 'Get an API key for unlimited (metered) access.',
        signup_url: '/api/key/request',
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
    ...(usingKey && { calls_this_period: usingKey.call_count, cents_owed: usingKey.cents_owed }),
  });
}

function clamp(n: any, lo: number, hi: number): number {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(lo, Math.min(hi, x));
}

async function handleKeyRequest(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: 'invalid JSON' }, { status: 400 }); }
  const email = String(body?.email ?? '').trim().toLowerCase();
  if (!email || !email.includes('@')) return Response.json({ error: 'valid email required' }, { status: 400 });

  const rawKey = newKeyId();
  const hash = await sha256Hex(rawKey);
  const id = newKeyId();
  const record: KeyRecord = {
    id,
    key_hash: hash,
    email,
    created_at: new Date().toISOString(),
    call_count: 0,
    cents_owed: 0,
    active: true,
    cap_cents: 1000,  // $10 soft cap until billing wires up
  };
  await env.WL_KEYS.put(`hash:${hash}`, JSON.stringify(record));
  await env.WL_KEYS.put(`id:${id}`, JSON.stringify(record));
  await env.WL_KEYS.put(`email:${email}`, id);

  return Response.json({
    key: rawKey,  // pass as Bearer header
    id,
    cap_cents: 1000,
    rate: '$0.01 per call (1¢)',
    note: 'Save this key — shown once. Cap is 1000 calls (soft, raises with billing). Send to /v1/score as Bearer token.',
  }, { status: 201 });
}

async function handleKeyStatus(req: Request, env: Env, id: string): Promise<Response> {
  const v = await env.WL_KEYS.get(`id:${id}`);
  if (!v) return Response.json({ error: 'not found' }, { status: 404 });
  const r = JSON.parse(v) as KeyRecord;
  return Response.json({
    id: r.id,
    email: r.email,
    active: r.active,
    call_count: r.call_count,
    cents_owed: r.cents_owed,
    cap_cents: r.cap_cents,
    created_at: r.created_at,
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/v1/score') return handleScore(req, env);
    if (url.pathname === '/api/key/request') return handleKeyRequest(req, env);
    const m = url.pathname.match(/^\/api\/key\/([a-zA-Z0-9_-]+)$/);
    if (m) return handleKeyStatus(req, env, m[1]);
    return env.ASSETS.fetch(req);
  },
};
