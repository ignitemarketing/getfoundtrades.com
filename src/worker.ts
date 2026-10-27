// Worker entry for getfoundtrades.com. Static pages are served straight from the assets
// directory; wrangler.jsonc routes only /api/* here (assets.run_worker_first).
//
// POST /api/waitlist stores one early-access signup per email address in the WAITLIST KV
// namespace under `email:<lowercased address>`. Read leads with:
//   pnpm exec wrangler kv key list --binding WAITLIST --remote
//   pnpm exec wrangler kv key get --binding WAITLIST --remote 'email:someone@example.com'
// The JSON contract matches src/components/Waitlist.astro: { ok: true } on success,
// { ok: false, error: 'invalid_email' } for a bad address, any other error string otherwise.

interface KVStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  WAITLIST: KVStore;
  WAITLIST_LIMITER: RateLimiter;
}

export interface Lead {
  email: string;
  fsm: string;
  source: string;
  page: string;
  country: string;
  createdAt: string;
  updatedAt: string;
}

const MAX_BODY_BYTES = 8 * 1024;
const FSM_OPTIONS = new Set(['Jobber', 'ServiceTitan', 'Housecall Pro', 'Other']);
// Same shape the client checks (Waitlist.astro), plus the RFC 5321 length cap.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const BASE_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
};

type Reply = { status: number; error?: string };

export function isValidEmail(value: string): boolean {
  return value.length <= 254 && EMAIL_RE.test(value);
}

function field(data: Record<string, unknown>, name: string, max = 200): string {
  const v = data[name];
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

async function readBody(request: Request, isJson: boolean): Promise<Record<string, unknown> | null> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return null;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    if (isJson) {
      const parsed: unknown = JSON.parse(text);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    }
    return Object.fromEntries(new URLSearchParams(text));
  } catch {
    return null;
  }
}

async function handleWaitlist(request: Request, env: Env, isJson: boolean): Promise<Reply> {
  // Browsers send Origin on every POST; a mismatch is a cross-site form or script.
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return { status: 403, error: 'forbidden' };

  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const { success } = await env.WAITLIST_LIMITER.limit({ key: ip });
  if (!success) return { status: 429, error: 'rate_limited' };

  const data = await readBody(request, isJson);
  if (!data) return { status: 400, error: 'bad_request' };

  // Honeypot: real visitors never see the `company` field. Answer as if stored so bots learn nothing.
  if (field(data, 'company') !== '') return { status: 200 };

  const email = field(data, 'email', 320).toLowerCase();
  if (!isValidEmail(email)) return { status: 400, error: 'invalid_email' };

  const fsm = field(data, 'fsm');
  const key = `email:${email}`;
  const now = new Date().toISOString();
  const previous = await env.WAITLIST.get(key);
  const createdAt = previous ? ((JSON.parse(previous) as Partial<Lead>).createdAt ?? now) : now;
  const cf = (request as Request & { cf?: { country?: string } }).cf;
  const lead: Lead = {
    email,
    fsm: FSM_OPTIONS.has(fsm) ? fsm : '',
    source: field(data, 'source'),
    page: field(data, 'page'),
    country: cf?.country ?? '',
    createdAt,
    updatedAt: now,
  };
  await env.WAITLIST.put(key, JSON.stringify(lead));
  return { status: 200 };
}

// Without JavaScript the form posts natively, so answer with a page a person can read.
function htmlReply(reply: Reply): Response {
  const ok = reply.status === 200;
  const message = ok
    ? "You're on the list. We'll email you as early access opens."
    : reply.error === 'invalid_email'
      ? 'Please go back and check your email address.'
      : 'Something went wrong — please go back and try again.';
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Get Found Trades</title></head><body><p>${message}</p><p><a href="/">Back to Get Found Trades</a></p></body></html>`;
  return new Response(body, {
    status: reply.status,
    headers: { ...BASE_HEADERS, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" },
  });
}

function jsonReply(reply: Reply, extra: Record<string, string> = {}): Response {
  const body = reply.error ? { ok: false, error: reply.error } : { ok: true };
  return new Response(JSON.stringify(body), {
    status: reply.status,
    headers: { ...BASE_HEADERS, ...extra, 'content-type': 'application/json' },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname !== '/api/waitlist') return jsonReply({ status: 404, error: 'not_found' });
    if (request.method !== 'POST') return jsonReply({ status: 405, error: 'method_not_allowed' }, { allow: 'POST' });

    const isJson = (request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json');
    let reply: Reply;
    try {
      reply = await handleWaitlist(request, env, isJson);
    } catch (err) {
      console.error('waitlist: unhandled error', err);
      reply = { status: 500, error: 'server_error' };
    }
    return isJson ? jsonReply(reply) : htmlReply(reply);
  },
};
