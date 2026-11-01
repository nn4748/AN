'use strict';

/**
 * Nourah & Aziz — private journal server.
 *
 * Zero-dependency Node server:
 *  - serves the static front-end from ./public
 *  - verifies the passcode server-side against a scrypt hash (never plaintext)
 *  - issues short-lived, in-memory session tokens (the browser keeps them in
 *    memory only, so a refresh or reopen always returns to the lock screen)
 *  - rate-limits failed attempts per client and globally
 *  - stores the journal in a JSON file with atomic writes
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DATA_FILE = path.join(DATA_DIR, 'journal.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// scrypt$<salt>$<hex hash>. Override with PASSCODE_HASH (see `npm run hash`).
const PASSCODE_HASH =
  process.env.PASSCODE_HASH ||
  'scrypt$d37f7d3170d1cd200918031022e6dbec$ba955ef170a26d15d0d965fa78b3bd395fba011232d16c81fe32947de9f5c121c94e2e59d9ff8b5cc2218d28a418eb426d46d4d1cb3945d0fdce831b4884bc24';

const SESSION_IDLE_MS = 30 * 60 * 1000; // 30 min of inactivity
const SESSION_MAX_MS = 12 * 60 * 60 * 1000; // hard cap 12h
const MAX_BODY = 16 * 1024;

/* ------------------------------------------------------------------ */
/* Passcode verification                                               */
/* ------------------------------------------------------------------ */

const [, SALT, HASH_HEX] = PASSCODE_HASH.split('$');
const EXPECTED = Buffer.from(HASH_HEX, 'hex');

function verifyPasscode(pin) {
  return new Promise((resolve) => {
    if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
      // still burn comparable CPU so timing does not leak format checks
      pin = '______';
    }
    crypto.scrypt(pin, SALT, EXPECTED.length, { N: 16384, r: 8, p: 1 }, (err, derived) => {
      if (err) return resolve(false);
      resolve(crypto.timingSafeEqual(derived, EXPECTED));
    });
  });
}

/* ------------------------------------------------------------------ */
/* Rate limiting                                                       */
/* ------------------------------------------------------------------ */

const attempts = new Map(); // ip -> { fails, lockedUntil }
const globalFails = []; // timestamps
const GLOBAL_WINDOW = 10 * 60 * 1000;
const GLOBAL_MAX = 40;

function lockStatus(ip) {
  const now = Date.now();
  while (globalFails.length && now - globalFails[0] > GLOBAL_WINDOW) globalFails.shift();
  if (globalFails.length >= GLOBAL_MAX) {
    return Math.max(1, Math.ceil((globalFails[0] + GLOBAL_WINDOW - now) / 1000));
  }
  const rec = attempts.get(ip);
  if (rec && rec.lockedUntil > now) return Math.ceil((rec.lockedUntil - now) / 1000);
  return 0;
}

function registerFailure(ip) {
  const now = Date.now();
  globalFails.push(now);
  const rec = attempts.get(ip) || { fails: 0, lockedUntil: 0 };
  rec.fails += 1;
  if (rec.fails >= 5) {
    const secs = Math.min(3600, 30 * 2 ** (rec.fails - 5));
    rec.lockedUntil = now + secs * 1000;
  }
  attempts.set(ip, rec);
}

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

const sessions = new Map(); // sha256(token) -> { created, seen }

function hashToken(t) {
  return crypto.createHash('sha256').update(t).digest('hex');
}

function createSession() {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  sessions.set(hashToken(token), { created: now, seen: now });
  return token;
}

function getSession(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer ([A-Za-z0-9_-]{20,})$/.exec(h);
  if (!m) return null;
  const key = hashToken(m[1]);
  const s = sessions.get(key);
  if (!s) return null;
  const now = Date.now();
  if (now - s.seen > SESSION_IDLE_MS || now - s.created > SESSION_MAX_MS) {
    sessions.delete(key);
    return null;
  }
  s.seen = now;
  return { key, ...s };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, s] of sessions) {
    if (now - s.seen > SESSION_IDLE_MS || now - s.created > SESSION_MAX_MS) sessions.delete(k);
  }
  for (const [ip, r] of attempts) {
    if (r.lockedUntil < now - 24 * 3600 * 1000) attempts.delete(ip);
  }
}, 60 * 1000).unref();

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

const PEOPLE = ['nourah', 'aziz'];
const CHOICE_FIELDS = ['sleep', 'kissedMore', 'spoiled', 'affectionate', 'initiated'];

let journal = { entries: {} };
try {
  journal = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (!journal || typeof journal.entries !== 'object') journal = { entries: {} };
} catch (_) {
  /* first run */
}

let writeChain = Promise.resolve();
function persist() {
  const snapshot = JSON.stringify(journal, null, 2);
  writeChain = writeChain.then(async () => {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.' + process.pid + '.tmp';
    await fs.promises.writeFile(tmp, snapshot, { mode: 0o600 });
    await fs.promises.rename(tmp, DATA_FILE);
  }).catch((e) => console.error('persist failed', e));
  return writeChain;
}

function isValidDate(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
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
    if (k === null) out.kisses = null;
    else if (Number.isInteger(k) && k >= 0 && k <= 9999) out.kisses = k;
    else return null;
  }
  if ('note' in body) {
    if (body.note === null) out.note = null;
    else if (typeof body.note === 'string' && body.note.length <= 1000) out.note = body.note;
    else return null;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'X-Robots-Tag': 'noindex, nofollow',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    ...(isJson ? { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } : {}),
    ...headers,
  });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (_) {
        reject(Object.assign(new Error('bad json'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  try {
    const data = await fs.promises.readFile(file);
    const ext = path.extname(file);
    send(res, 200, data, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
  } catch (_) {
    send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  }
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

async function handleApi(req, res, url) {
  const p = url.pathname;

  if (p === '/api/unlock' && req.method === 'POST') {
    const ip = clientIp(req);
    const wait = lockStatus(ip);
    if (wait) return send(res, 429, { error: 'locked', retryAfter: wait }, { 'Retry-After': String(wait) });
    const body = await readJson(req);
    const ok = await verifyPasscode(body.passcode);
    if (!ok) {
      registerFailure(ip);
      // small fixed delay discourages scripted guessing
      await new Promise((r) => setTimeout(r, 400));
      const after = lockStatus(ip);
      return send(res, 401, { error: 'invalid', retryAfter: after || undefined });
    }
    attempts.delete(ip);
    return send(res, 200, { token: createSession(), idleMs: SESSION_IDLE_MS });
  }

  const session = getSession(req);
  if (!session) return send(res, 401, { error: 'unauthorized' });

  if (p === '/api/lock' && req.method === 'POST') {
    sessions.delete(session.key);
    return send(res, 200, { ok: true });
  }

  if (p === '/api/entries' && req.method === 'GET') {
    return send(res, 200, { entries: journal.entries });
  }

  const m = /^\/api\/entries\/(\d{4}-\d{2}-\d{2})$/.exec(p);
  if (m) {
    const date = m[1];
    if (!isValidDate(date)) return send(res, 400, { error: 'bad date' });
    if (req.method === 'GET') return send(res, 200, { date, entry: journal.entries[date] || null });
    if (req.method === 'PATCH') {
      const patch = sanitizePatch(await readJson(req));
      if (!patch) return send(res, 400, { error: 'invalid fields' });
      const prev = journal.entries[date] || {};
      const next = { ...prev, ...patch, updatedAt: new Date().toISOString() };
      for (const k of Object.keys(next)) if (next[k] === null || next[k] === '') delete next[k];
      if (Object.keys(next).length <= 1) delete journal.entries[date];
      else journal.entries[date] = next;
      await persist();
      return send(res, 200, { date, entry: journal.entries[date] || null });
    }
    if (req.method === 'DELETE') {
      delete journal.entries[date];
      await persist();
      return send(res, 200, { date, entry: null });
    }
  }

  return send(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { 'Content-Type': 'text/plain' });
    return await serveStatic(req, res, url.pathname);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'server error' : e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Nourah & Aziz — listening on http://${HOST}:${PORT}`);
});
