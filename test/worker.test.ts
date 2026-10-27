import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { type Env } from '../src/worker.ts';

const URL_ = 'https://getfoundtrades.com/api/waitlist';

function makeEnv(opts: { limited?: boolean; failPut?: boolean } = {}) {
  const store = new Map<string, string>();
  const env: Env = {
    WAITLIST: {
      async get(key) { return store.get(key) ?? null; },
      async put(key, value) {
        if (opts.failPut) throw new Error('kv down');
        store.set(key, value);
      },
    },
    WAITLIST_LIMITER: { async limit() { return { success: !opts.limited }; } },
  };
  return { env, store };
}

function postJson(body: unknown, headers: Record<string, string> = {}) {
  return new Request(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://getfoundtrades.com', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

// The exact payload Waitlist.astro builds from FormData.
const clientPayload = { company: '', source: 'getfoundtrades.com', page: '/', email: ' Owner@Plumbing.example ', fsm: 'Jobber' };

test('valid JSON signup is stored and answers { ok: true }', async () => {
  const { env, store } = makeEnv();
  const res = await worker.fetch(postJson(clientPayload), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  const lead = JSON.parse(store.get('email:owner@plumbing.example')!);
  assert.equal(lead.email, 'owner@plumbing.example');
  assert.equal(lead.fsm, 'Jobber');
  assert.equal(lead.page, '/');
  assert.equal(lead.source, 'getfoundtrades.com');
});

test('invalid email answers invalid_email and stores nothing', async () => {
  const { env, store } = makeEnv();
  for (const email of ['', 'not-an-email', 'a@b', `${'x'.repeat(250)}@example.com`]) {
    const res = await worker.fetch(postJson({ ...clientPayload, email }), env);
    assert.equal(res.status, 400, email);
    assert.deepEqual(await res.json(), { ok: false, error: 'invalid_email' });
  }
  assert.equal(store.size, 0);
});

test('honeypot submissions look accepted but are dropped', async () => {
  const { env, store } = makeEnv();
  const res = await worker.fetch(postJson({ ...clientPayload, company: 'Spam LLC' }), env);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(store.size, 0);
});

test('a repeat signup keeps the first createdAt and updates the answer', async () => {
  const { env, store } = makeEnv();
  await worker.fetch(postJson(clientPayload), env);
  const first = JSON.parse(store.get('email:owner@plumbing.example')!);
  await new Promise((r) => setTimeout(r, 5));
  await worker.fetch(postJson({ ...clientPayload, fsm: 'ServiceTitan' }), env);
  const second = JSON.parse(store.get('email:owner@plumbing.example')!);
  assert.equal(store.size, 1);
  assert.equal(second.createdAt, first.createdAt);
  assert.equal(second.fsm, 'ServiceTitan');
});

test('unknown fsm values are blanked', async () => {
  const { env, store } = makeEnv();
  await worker.fetch(postJson({ ...clientPayload, fsm: '<script>' }), env);
  assert.equal(JSON.parse(store.get('email:owner@plumbing.example')!).fsm, '');
});

test('rate-limited IPs get 429 rate_limited', async () => {
  const { env, store } = makeEnv({ limited: true });
  const res = await worker.fetch(postJson(clientPayload), env);
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), { ok: false, error: 'rate_limited' });
  assert.equal(store.size, 0);
});

test('cross-origin posts are refused', async () => {
  const { env, store } = makeEnv();
  const res = await worker.fetch(postJson(clientPayload, { origin: 'https://evil.example' }), env);
  assert.equal(res.status, 403);
  assert.equal(store.size, 0);
});

test('malformed and oversized bodies answer bad_request', async () => {
  const { env } = makeEnv();
  for (const body of ['{not json', '[1,2]', JSON.stringify({ ...clientPayload, page: 'x'.repeat(9000) })]) {
    const res = await worker.fetch(postJson(body), env);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { ok: false, error: 'bad_request' });
  }
});

test('storage failure answers a generic error the client shows as "try again"', async () => {
  const { env } = makeEnv({ failPut: true });
  const original = console.error;
  console.error = () => {};
  try {
    const res = await worker.fetch(postJson(clientPayload), env);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { ok: false, error: 'server_error' });
  } finally {
    console.error = original;
  }
});

test('a native (no-JS) form post is stored and answers readable HTML', async () => {
  const { env, store } = makeEnv();
  const body = new URLSearchParams({ ...clientPayload, email: 'crew@hvac.example' }).toString();
  const res = await worker.fetch(new Request(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://getfoundtrades.com' },
    body,
  }), env);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type')!, /text\/html/);
  assert.match(await res.text(), /on the list/);
  assert.ok(store.has('email:crew@hvac.example'));
});

test('GET is 405 and other /api paths are 404', async () => {
  const { env } = makeEnv();
  const get = await worker.fetch(new Request(URL_), env);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');
  const other = await worker.fetch(new Request('https://getfoundtrades.com/api/other', { method: 'POST' }), env);
  assert.equal(other.status, 404);
});
