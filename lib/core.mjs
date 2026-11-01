/**
 * Nourah & Aziz — API core, shared by the Netlify Function and the local
 * dev server. Storage is injected so it runs on Netlify Blobs in production
 * and on memory/disk locally.
 *
 * store interface:
 *   get(key) -> object|null, set(key, object), del(key), list(prefix) -> string[]
 */
import crypto from 'node:crypto';

// scrypt$<salt>$<hex>. Override with the PASSCODE_HASH environment variable.
const DEFAULT_PASSCODE_HASH =
  'scrypt$d37f7d3170d1cd200918031022e6dbec$ba955ef170a26d15d0d965fa78b3bd395fba011232d16c81fe32947de9f5c121c94e2e59d9ff8b5cc2218d28a418eb426d46d4d1cb3945d0fdce831b4884bc24';

const SESSION_IDLE_MS = 30 * 60 * 1000; // sliding idle window
const SESSION_MAX_MS = 12 * 60 * 60 * 1000; // absolute cap
const MAX_BODY = 16 * 1024;
const GLOBAL_WINDOW = 10 * 60 * 1000;
const GLOBAL_MAX = 40;

const PEOPLE = ['nourah', 'aziz'];
const CHOICE_FIELDS = ['sleep', 'kissedMore', 'spoiled', 'affectionate', 'initiated'];

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

function scrypt(pin, salt, len) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(pin, salt, len, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? reject(e) : resolve(k))),
  );
}

function isValidDate(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = new Date(d + 'T00:00:00Z');
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}

function sanitizePatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const out = {};
  for (const f of CHOICE_FIELDS) {
    if (f in body) {
      if (body[f] === null || PEOPLE.includes(body[f])) out[f] = body[f];
      else return null;
    }
  }
  if ('kisses' in body) {
    const k = body.kisses;
    if (k === null || (Number.isInteger(k) && k >= 0 && k <= 9999)) out.kisses = k;
    else return null;
  }
  if ('note' in body) {
    const n = body.note;
    if (n === null || (typeof n === 'string' && n.length <= 1000)) out.note = n;
    else return null;
  }
  return out;
}

async function readBody(req) {
  const text = await req.text();
  if (text.length > MAX_BODY) throw Object.assign(new Error('too large'), { status: 413 });
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('bad json'), { status: 400 });
  }
}

export function createApi({ store, passcodeHash = DEFAULT_PASSCODE_HASH, now = () => Date.now() }) {
  const [, SALT, HASH_HEX] = passcodeHash.split('$');
  const EXPECTED = Buffer.from(HASH_HEX, 'hex');

  /* ---------- signing secret (generated once, kept in storage) ---------- */
  let secretPromise = null;
  function getSecret() {
    if (!secretPromise) {
      secretPromise = (async () => {
        const existing = await store.get('meta/secret');
        if (existing && existing.key) return Buffer.from(existing.key, 'base64');
        const key = crypto.randomBytes(32);
        await store.set('meta/secret', { key: key.toString('base64') });
        // re-read so concurrent cold starts converge on one secret
        const saved = await store.get('meta/secret');
        return Buffer.from(saved.key, 'base64');
      })().catch((e) => {
        secretPromise = null;
        throw e;
      });
    }
    return secretPromise;
  }

  /* ---------- tokens: payload.signature, sliding expiry ---------- */
  async function sign(payload) {
    const body = b64u(JSON.stringify(payload));
    const sig = b64u(crypto.createHmac('sha256', await getSecret()).update(body).digest());
    return `${body}.${sig}`;
  }

  async function verify(token) {
    if (typeof token !== 'string') return null;
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const expect = crypto.createHmac('sha256', await getSecret()).update(body).digest();
    const got = Buffer.from(sig, 'base64url');
    if (got.length !== expect.length || !crypto.timingSafeEqual(got, expect)) return null;
    let p;
    try {
      p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    const t = now();
    if (!p || typeof p.jti !== 'string' || t > p.exp || t > p.iat + SESSION_MAX_MS) return null;
    if (await store.get(`revoked/${p.jti}`)) return null;
    return p;
  }

  function issue(iat, jti) {
    const t = now();
    return sign({ jti, iat, exp: Math.min(t + SESSION_IDLE_MS, iat + SESSION_MAX_MS) });
  }

  /* ---------- rate limiting ---------- */
  async function lockStatus(ip) {
    const t = now();
    const g = (await store.get('meta/global-fails')) || { times: [] };
    const recent = g.times.filter((x) => t - x < GLOBAL_WINDOW);
    if (recent.length >= GLOBAL_MAX) return Math.max(1, Math.ceil((recent[0] + GLOBAL_WINDOW - t) / 1000));
    const rec = await store.get(`attempts/${ipKey(ip)}`);
    if (rec && rec.lockedUntil > t) return Math.ceil((rec.lockedUntil - t) / 1000);
    return 0;
  }

  async function registerFailure(ip) {
    const t = now();
    const g = (await store.get('meta/global-fails')) || { times: [] };
    g.times = [...g.times.filter((x) => t - x < GLOBAL_WINDOW), t];
    await store.set('meta/global-fails', g);
    const key = `attempts/${ipKey(ip)}`;
    const rec = (await store.get(key)) || { fails: 0, lockedUntil: 0 };
    // forget old failures after a quiet day
    if (rec.last && t - rec.last > 24 * 3600 * 1000) rec.fails = 0;
    rec.fails += 1;
    rec.last = t;
    if (rec.fails >= 5) rec.lockedUntil = t + Math.min(3600, 30 * 2 ** (rec.fails - 5)) * 1000;
    await store.set(key, rec);
  }

  function ipKey(ip) {
    return crypto.createHash('sha256').update(String(ip || 'unknown')).digest('hex').slice(0, 32);
  }

  /* ---------- journal ---------- */
  async function allEntries() {
    const keys = await store.list('entries/');
    const items = await Promise.all(keys.map(async (k) => [k.slice('entries/'.length), await store.get(k)]));
    const out = {};
    for (const [d, e] of items) if (e && isValidDate(d)) out[d] = e;
    return out;
  }

  /* ---------- router ---------- */
  async function route(req, ip) {
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, '');

    if (p === '/api/unlock' && req.method === 'POST') {
      const wait = await lockStatus(ip);
      if (wait) return json(429, { error: 'locked', retryAfter: wait }, { 'Retry-After': String(wait) });
      const body = await readBody(req);
      const pin = typeof body.passcode === 'string' && /^\d{6}$/.test(body.passcode) ? body.passcode : '______';
      const derived = await scrypt(pin, SALT, EXPECTED.length);
      if (!crypto.timingSafeEqual(derived, EXPECTED)) {
        await registerFailure(ip);
        await new Promise((r) => setTimeout(r, 400));
        const after = await lockStatus(ip);
        return json(401, { error: 'invalid', retryAfter: after || undefined });
      }
      await store.del(`attempts/${ipKey(ip)}`);
      const token = await issue(now(), b64u(crypto.randomBytes(16)));
      return json(200, { token, idleMs: SESSION_IDLE_MS });
    }

    const m = /^Bearer (\S+)$/.exec(req.headers.get('authorization') || '');
    const session = m ? await verify(m[1]) : null;
    if (!session) return json(401, { error: 'unauthorized' });

    if (p === '/api/lock' && req.method === 'POST') {
      await store.set(`revoked/${session.jti}`, { at: now(), until: session.iat + SESSION_MAX_MS });
      return json(200, { ok: true });
    }

    // every authenticated call slides the idle window
    const renewed = { 'X-Session-Token': await issue(session.iat, session.jti) };

    if (p === '/api/entries' && req.method === 'GET') {
      return json(200, { entries: await allEntries() }, renewed);
    }

    const dm = /^\/api\/entries\/(\d{4}-\d{2}-\d{2})$/.exec(p);
    if (dm && isValidDate(dm[1])) {
      const key = `entries/${dm[1]}`;
      if (req.method === 'GET') return json(200, { date: dm[1], entry: await store.get(key) }, renewed);
      if (req.method === 'PATCH') {
        const patch = sanitizePatch(await readBody(req));
        if (!patch) return json(400, { error: 'invalid fields' }, renewed);
        const next = { ...((await store.get(key)) || {}), ...patch, updatedAt: new Date(now()).toISOString() };
        for (const k of Object.keys(next)) if (next[k] === null || next[k] === '') delete next[k];
        if (Object.keys(next).length <= 1) {
          await store.del(key);
          return json(200, { date: dm[1], entry: null }, renewed);
        }
        await store.set(key, next);
        return json(200, { date: dm[1], entry: next }, renewed);
      }
      if (req.method === 'DELETE') {
        await store.del(key);
        return json(200, { date: dm[1], entry: null }, renewed);
      }
    }

    return json(404, { error: 'not found' }, renewed);
  }

  return async function handle(req, ip) {
    try {
      return await route(req, ip);
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      return json(status, { error: status === 500 ? 'server error' : e.message });
    }
  };
}

/** Simple in-memory store (tests / local dev). */
export function memoryStore() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? structuredClone(m.get(k)) : null; },
    async set(k, v) { m.set(k, structuredClone(v)); },
    async del(k) { m.delete(k); },
    async list(prefix) { return [...m.keys()].filter((k) => k.startsWith(prefix)); },
  };
}
