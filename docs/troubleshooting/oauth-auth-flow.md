# Troubleshooting: OAuth / Supabase auth flow

This document captures the multi-day OAuth debugging session in 2026-05 so future me (or future contributors) can short-circuit the same issues.

## The symptom

After clicking "Continue with Google" on `https://wwv.local:3001/login`, one of these things would happen:

1. **Mode 1 (fast failure, ~20ms)** — `GET /api/auth/callback?code=... 307` with `application-code: 11-28ms`, then redirect to `/login?error=Authentication%20failed.%20Please%20try%20again`. Exchange failed because the PKCE code verifier cookie was not in the request.
2. **Mode 2 (slow success, ~550ms)** — `GET /api/auth/callback?code=... 307` with `application-code: 553-581ms`, redirect appears to work, but `/accounts` immediately returns 307 to `/login?next=/accounts`. Exchange succeeded; session was set; but the next page couldn't read it.
3. **Pattern C (intermittent)** — `failed to get redirect response [TypeError: fetch failed] [cause]: Error: unable to verify the first certificate; if the root CA is installed locally, try running Node.js with --use-system-ca`

## The actual root cause (Mode 2)

The dev script bound the Next.js server to `localhost` (the default), not `wwv.local`. Browser would request `https://wwv.local:3001/api/auth/callback`, but Next.js's `request.url` was computed from the bound hostname, giving `https://localhost:3001/api/auth/callback`.

Our callback route used `origin` from `new URL(request.url)` to build the post-exchange redirect in development mode:

```ts
const { origin } = new URL(request.url)  // 'https://localhost:3001'
const redirectBase = process.env.NODE_ENV === 'development' ? origin : base
return NextResponse.redirect(`${redirectBase}${next}`)
```

That sent the browser to `https://localhost:3001/accounts` after a successful exchange. But the session cookies were just set with `domain=.wwv.local` — a totally different cookie jar from `localhost`. `/accounts` on `localhost` saw no session and redirected to `/login`.

Manually navigating to `https://wwv.local:3001/accounts` afterward worked because the session was on `wwv.local`.

### The fix

1. **`src/app/api/auth/callback/route.ts`** — removed the dev-mode `origin` branch. Always use `NEXT_PUBLIC_SITE_URL`:
   ```ts
   const base = process.env.NEXT_PUBLIC_SITE_URL || origin
   // ...
   return NextResponse.redirect(`${base}${next}`)
   ```

2. **`package.json` dev script** — added `--hostname wwv.local` so Next.js binds explicitly and `request.url` matches the browser host. Defensive — once `NEXT_PUBLIC_SITE_URL` is authoritative, `request.url` no longer needs to match, but mismatched hostnames create cookie-jar isolation bugs in other code paths too.

3. **`src/lib/supabase/server.ts`** — already followed the canonical `cookies()` store pattern; the callback now uses `createClient()` from this factory and lets Next.js auto-attach cookies to the redirect response (instead of manually building a `NextResponse.redirect` first and writing cookies onto it).

## The actual root cause (Mode 1 + Pattern C)

`NODE_EXTRA_CA_CERTS=mkcert/rootCA.pem` in `.env.local` was conflicting with Node.js 22+ on Windows. Node's certificate handling treats `NODE_EXTRA_CA_CERTS` as an "in addition to bundled Mozilla list" hint, but on Windows there's a known interaction where the bundled list ordering gets confused and outbound fetches to `*.supabase.co` intermittently fail with `unable to verify the first certificate`.

When that fetch fails inside `signInWithOAuth` (the server action), the PKCE code verifier never gets written to a cookie. The user still gets redirected to Google (because the URL was generated locally before the fetch attempt), Google completes auth, the callback fires — but the verifier isn't in the cookie jar, so `exchangeCodeForSession` returns "code verifier should be non-empty" in ~20ms.

### The fix

Add `--use-system-ca` to Node's options. This flag (Node 22.10+) tells Node to merge the Windows system certificate store with the bundled Mozilla list. Since `mkcert -install` puts the dev CA in Windows trust, no separate `NODE_EXTRA_CA_CERTS` env var is needed and the bundled list keeps trusting public CAs reliably.

`package.json`:
```diff
-  "dev": "next dev --port 3001 --experimental-https ..."
+  "dev": "cross-env NODE_OPTIONS=--use-system-ca next dev --port 3001 --hostname wwv.local --experimental-https ..."
```

`cross-env` is required because Windows shells (PowerShell, cmd) don't support the inline `NODE_OPTIONS=value command` syntax that Unix shells do.

## Confounders that wasted time during debugging

These were investigated and ruled out. If you see similar symptoms, do not waste time on these:

- **`domain=.wwv.local` being rejected by Edge** — `.local` is RFC 6762 reserved for mDNS but Chromium accepts it for cookies. The cookies in the jar (visible in DevTools → Application → Cookies) confirmed they were stored correctly. Ruled out via direct inspection.
- **Chunked cookie corruption** — cookies were chunked (`sb-...-auth-token.0` and `.1`) because the Google OAuth session payload exceeds the `MAX_CHUNK_SIZE = 3180` boundary. The chunker reassembled them correctly when accessed manually; the bug was elsewhere.
- **`proxy.ts` missing `headers` argument in `setAll`** — Supabase SSR's canonical proxy passes a second argument carrying `Cache-Control: no-store` headers that prevent intermediary caches from caching responses with `Set-Cookie`. This is a security correctness issue worth fixing, but it does not cause the symptoms above. Filed as a follow-up.

## Diagnostic playbook (if it breaks again)

1. **First check: which host are you on?** Look at the browser address bar. Stay on `https://wwv.local:3001` for the entire test. Mixing `localhost:3001` and `wwv.local:3001` produces two isolated cookie jars and every flow looks broken.

2. **Then check: dev server logs.** Look at the `pnpm dev` terminal directly (the Monitor tool's grep filter swallows route-handler `console.log`). Look for:
   - `failed to get redirect response [TypeError: fetch failed]` → TLS cert issue, ensure `--use-system-ca` is in the dev script.
   - `@supabase/ssr: chunked cookie decoded to invalid JSON` → stale chunks in the jar, clear all `sb-*` cookies in DevTools.
   - `Error [AuthApiError]: Invalid Refresh Token` → expired session; clear cookies and re-auth.

3. **Then check: cookies in DevTools.** Application → Cookies → `https://wwv.local:3001`. Expected after a successful sign-in:
   - `sb-kvlnzjtcstnaqkpqrquf-auth-token.0` (and possibly `.1`, `.2`) — chunked session.
   - Domain column: `.wwv.local`, HttpOnly ✓, Secure ✓, SameSite Lax.

4. **Then check: timing breakdown in the request log.** Next.js 16 logs `(next.js: Xms, proxy.ts: Yms, application-code: Zms)`. For `/api/auth/callback`:
   - `application-code: 11-30ms` → PKCE verifier missing (Mode 1).
   - `application-code: 500-600ms` → real exchange happened.
   - For `/accounts`: 200 response is success; 307 means session not readable.

5. **If all else fails, clear all `sb-*` cookies in DevTools and restart `pnpm dev`.** This rules out chunked-cookie staleness from previous interrupted writes.

## Related files

- `src/app/api/auth/callback/route.ts` — OAuth callback handler
- `src/app/login/oauth-actions.ts` — `signInWithOAuth` server action
- `src/lib/supabase/server.ts` — server-side Supabase client factory (canonical pattern)
- `src/lib/supabase/cookieOptions.ts` — `domain=.wwv.local`, `httpOnly`, `secure`, `sameSite: lax`
- `src/proxy.ts` — Next.js middleware that calls `getClaims()` on every request to keep the session fresh
- `package.json` — dev script with `--use-system-ca`, `--hostname wwv.local`, and `--experimental-https`
