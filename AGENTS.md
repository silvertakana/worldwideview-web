# WorldWideView Web — Agent Rules

## 1. Project Identity

This repository (`worldwideview-web`) is the **Public Landing / Marketing Page** for the WorldWideView engine. Its purpose is to showcase the capabilities of the engine, provide aesthetic marketing copy, and serve as the entry point for new users.

---

## 2. Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16 (Static Export: `output: "export"`) |
| Language | TypeScript 5, strict mode |
| 3D Visualization | React Three Fiber (`@react-three/fiber` + `drei`) |
| Styling | Vanilla CSS (`.module.css`) — **no Tailwind** |
| Deployment | Nginx serving static `out/` directory |
| Package Manager | pnpm |

---

## 3. Architecture & Core Workflows

### 3.1 Static Site Generation (SSG)
Unlike the main engine or the marketplace, this is a **Static Export**.
- **No Server-Side Code**: You cannot use Next.js API Routes (`/api/*`), NextAuth, or server actions here.
- Everything runs on the client or is baked at build time.

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
pnpm build  # Runs `next build` to generate the `/out` directory
```

- **Deployment**: The `Dockerfile` uses Nginx (`nginx.conf`) to serve the static HTML/JS/CSS assets from the `out/` directory. No Node.js process runs in production.

---

## 6. Troubleshooting

| Symptom | Reference |
|---|---|
| OAuth callback redirects to `/login`, "Authentication failed", `unable to verify the first certificate`, chunked `sb-*` cookies, Mode 1 / Mode 2 / Pattern C | [`docs/troubleshooting/oauth-auth-flow.md`](docs/troubleshooting/oauth-auth-flow.md) |
