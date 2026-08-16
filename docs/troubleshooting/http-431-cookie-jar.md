# HTTP 431 — Request Header Fields Too Large (dev stack)

## Symptom

Browser shows "This page isn't working right now — HTTP ERROR 431" on any `*.wwv.local` page (hub, globe, marketplace) during local development.

## What it means

The browser sent the server a request whose headers (mainly the Cookie header) exceed the server's reading limit. Node's default max header size is 16KB (`http.maxHeaderSize`). This is a **dev-stack-only** phenomenon: all local apps share the single `.wwv.local` domain, so every request carries cookies from every app, and heavy login/testing accumulates a large jar. Production apps live on separate real domains and do not share a cookie jar.

## Why cookies accumulate

- The hub and marketplace are separate apps but both write Supabase session cookies on the shared `.wwv.local` domain. Each session is a large chunked JWT (~3.2KB per chunk, 2-3 chunks typical).
- Signout historically cleared only the app's own current cookie name, leaving the sibling app's session and any stale differently-named cookies behind (fixed 2026-08-08: signout now clears both `wwv-hub-auth-token` and `sb-<project>-auth-token` plus all chunks).
- A cookie-name pin migration left pre-pin `sb-<project>-auth-token` cookies orphaned in browsers (no auto-cleanup existed).
- Typical jar: hub ~6.4KB + marketplace ~6.4KB + leftovers ≈ 13KB. One more chunk (Google OAuth sessions are documented to exceed the chunk boundary) crosses 16KB -> 431.

## Immediate fix (user)

1. Open an incognito/private window and go to `https://hub.wwv.local/login` — if it loads, the 431 is the cookie jar.
2. In your normal window, clear the site's cookies: lock icon next to the URL -> Site settings -> Clear data, or Ctrl+Shift+Delete -> "Cookies and other site data".
3. Log in again.

## Dev-stack mitigation (already applied)

- `docker-compose.dev.yml` sets `NODE_OPTIONS=--max-http-header-size=32768` on globe, hub, and marketplace (double the default ceiling) — dev-only, no production impact.
- Hub signout (commit b1e8d53) now expires every chunk of both the current and legacy cookie names on the shared domain.
- For any leftover stale cookies from before those fixes: clear site data once (see Immediate fix).

## If it still happens after clearing

Check the actual jar size in DevTools (Application -> Cookies -> wwv.local) and look for duplicate cookie sets (`wwv-hub-auth-token` AND `sb-<project>-auth-token` both present). Report the cookie names/sizes to the dev team — stale pre-migration cookies may need a manual clear.
