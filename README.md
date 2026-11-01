# Nourah & Aziz

A private journal for the two of us: what we did for each other each day, who did it more, and the small moments worth keeping.

## Deploy on Netlify

1. On Netlify: **Add new site → Import an existing project → GitHub**, then pick this repository and branch.
2. Leave the build settings as they are (`netlify.toml` handles them) and click **Deploy**.

That's it. The journal is stored in **Netlify Blobs**, and the signing key for sessions is generated automatically on first use. No database or extra setup is needed.

Optional: to use a passcode hash that isn't in the code, run `npm run hash -- <passcode>`. Then add the output as the environment variable `PASSCODE_HASH` under **Site configuration → Environment variables** and redeploy.

## Local preview

```bash
npm install
npm run dev          # http://localhost:8888, data saved in ./data
```

## How privacy works

- The passcode is never stored in plain text. The server checks it against a salted **scrypt** hash.
- A correct passcode returns a signed session token. The browser keeps it **in memory only**, so refreshing or reopening the page locks the site again.
- Every journal request requires a valid token. Sessions expire after 30 minutes of inactivity, 12 hours at most, or when you press the lock button. The page also locks itself after 5 minutes in the background.
- Failed attempts are rate-limited. After 5 wrong tries the client is locked out, starting at 30 seconds and doubling each time. There is also a global cap on failures.
- Strict security headers are sent (CSP, HSTS, no framing, `noindex`).

## Checks

```bash
TEST_PASSCODE=<passcode> npm test
```
