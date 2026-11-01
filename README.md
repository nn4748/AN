# Nourah & Aziz

A private journal for the two of us: what we did for each other each day, who did it more, and the small moments worth keeping.

## Run it

```bash
npm start            # http://localhost:3000
```

It needs Node 18 or newer and has no dependencies.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `DATA_DIR` | `./data` | Where `journal.json` is stored. Put this on a persistent disk |
| `PASSCODE_HASH` | built in | scrypt hash of the passcode. Generate one with `npm run hash -- 123456` |
| `TRUST_PROXY` | off | Set to `1` behind a reverse proxy, so rate limits use the real client IP |

## How privacy works

- The passcode is never stored in plain text. The server checks it against a salted **scrypt** hash.
- A correct passcode gets a random session token. The browser keeps the token **in memory only**, so refreshing or reopening the page locks the site again.
- Every journal API call requires the token. Sessions expire after 30 minutes of inactivity, 12 hours at most, or when you press the lock button. The page also locks itself after 5 minutes in the background.
- Failed attempts are rate-limited. After 5 wrong tries the client is locked out, starting at 30 seconds and doubling each time. There is also a global cap on failures.
- Strict security headers are sent (CSP, no framing, no-referrer, `noindex`).

Serve it over **HTTPS** in production (any host with a TLS proxy, such as Render, Railway, Fly.io or a VPS behind Caddy).

## Checks

```bash
TEST_PASSCODE=<passcode> npm test
```
