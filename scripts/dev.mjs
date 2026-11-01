// Local preview: `npm run dev` → http://localhost:8888
// Serves ./public and the same API the Netlify Function runs, storing data in ./data.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from '../lib/core.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(root, 'public');
const DATA = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const PORT = Number(process.env.PORT) || 8888;

const file = path.join(DATA, 'store.json');
let db = {};
try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
const save = () => { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(file, JSON.stringify(db, null, 2)); };
const store = {
  async get(k) { return k in db ? structuredClone(db[k]) : null; },
  async set(k, v) { db[k] = structuredClone(v); save(); },
  async del(k) { delete db[k]; save(); },
  async list(p) { return Object.keys(db).filter((k) => k.startsWith(p)); },
};
const api = createApi({ store, passcodeHash: process.env.PASSCODE_HASH || undefined });

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith('/api/')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
    const r = await api(new Request(url, { method: req.method, headers: req.headers, body }), req.socket.remoteAddress);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    return res.end(Buffer.from(await r.arrayBuffer()));
  }
  const rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const f = path.normalize(path.join(PUBLIC, rel));
  if (!f.startsWith(PUBLIC + path.sep) || !fs.existsSync(f)) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(PORT, () => console.log(`Preview on http://localhost:${PORT}`));
