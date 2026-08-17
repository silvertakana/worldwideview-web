# WorldWideView Web — Agent Rules

## 1. Project Identity

This repository (`worldwideview-web`) is the **Public Landing / Marketing Page** for the WorldWideView engine. Its purpose is to showcase the capabilities of the engine, provide aesthetic marketing copy, and serve as the entry point for new users.

---

## 2. Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (`output: "standalone"`) |
| Language | TypeScript 5, strict mode |
| 3D Visualization | React Three Fiber (`@react-three/fiber` + `drei`) |
| Styling | Vanilla CSS (`.module.css`) — **no Tailwind** |
| Deployment | Docker (Coolify), Node.js server |
| Package Manager | pnpm |

---

## 3. Architecture & Core Workflows

### 3.1 Node.js Server (Standalone)
This app runs as a Node.js server in production (Coolify Docker, `output: "standalone"`).
- **Has Server-Side Code**: API Routes (`/api/auth/*`), Server Actions, and Server Components are all in use.
- Session cookies are read/written server-side via `@supabase/ssr`.
- **IMPORTANT**: `NEXT_PUBLIC_*` env vars are inlined at build time in Next.js. The Dockerfile passes them via `ARG` + `ENV ${ARG}`. Coolify must have them marked as build-time variables. If an API route shows placeholder values, check the Dockerfile `ENV`/`ARG` directives.

### 3.2 3D Rendering (Three.js instead of Cesium)
To keep the marketing page lightweight and fast-loading, 3D visualizations here use **React Three Fiber (R3F)** instead of the full CesiumJS engine. 
- *Rule*: Do not attempt to import CesiumJS in this specific repository. Use Three.js primitives and shaders for background globes/esthetics.

---

## 4. Critical Conventions

1. **Aesthetics & Performance**: As a landing page, aesthetics (glassmorphism, subtle gradients, micro-animations) are paramount, but they must not compromise the Core Web Vitals (LCP, CLS, FID).
2. **File Size Limit**: Keep files under **150 lines**. Split massive 3D scenes into smaller R3F components.
3. **Styling Rules**: Strict vanilla CSS.

---

## 5. Development & Deployment

```bash
pnpm dev    # Start the local development server
pnpm build  # Runs `next build` to produce the `.next/standalone` output
```

- **Deployment**: The `Dockerfile` uses a minimal Node.js 22 runtime: it copies `.next/standalone` and runs `pm2-runtime server.js -i 4`. The app is a real Node.js server in production (no Nginx, no `nginx.conf`, no `out/` directory).
- **Fresh worktree bootstrap**: worktrees start with no `node_modules` and no env files. Run `pnpm install`, then copy `.env.local`, plus `certs/` (the dev script's `--experimental-https` needs `certs/wwv.local+4-key.pem` / `certs/wwv.local+4.pem`), from the main checkout or a sibling worktree. `pnpm dev` serves at `https://wwv.local:3001`. The main checkout is read-only and often stale: read `origin/main` or use a worktree.

---

## 6. Troubleshooting

| Symptom | Reference |
|---|---|
| OAuth callback redirects to `/login`, "Authentication failed", `unable to verify the first certificate`, chunked `sb-*` cookies, Mode 1 / Mode 2 / Pattern C | [`docs/troubleshooting/oauth-auth-flow.md`](docs/troubleshooting/oauth-auth-flow.md) |
