---
title: Getting Started
description: Set up WorldWideView locally and take your first look at the globe.
order: 1
---

# Getting Started

## Requirements

- Node.js v18.17 or higher
- pnpm v8 or higher
- A GPU with WebGL 2.0 support
- API keys for Cesium Ion and Bing Maps

## Setup

WorldWideView is a self-hosted Next.js application. Clone the repository and start the dev server:

```bash
git clone https://github.com/silvertakana/worldwideview.git
cd worldwideview && pnpm install
pnpm setup
pnpm dev
```

`pnpm setup` generates a `.env.local` file with a secure `AUTH_SECRET`. After that, open [http://localhost:3000](http://localhost:3000) in your browser.

For the full setup guide including API key configuration, see the [download page](/download).

## First launch

WorldWideView opens to a 3D globe with live ADS-B flight data loaded by default.

| Action | Input |
|--------|-------|
| Pan | Click and drag |
| Zoom | Scroll wheel or pinch |
| Rotate | Right-click and drag |
| Reset view | Double-click globe |

## Enabling plugins

1. Open the **Plugin Manager** from the toolbar (plug icon)
2. Browse the [Marketplace](https://marketplace.worldwideview.dev) or search by keyword
3. Click **Install** — the plugin activates immediately, no restart required

## Next steps

Once you have the app running, head to the [Plugin Quickstart](/docs/plugin-quickstart) to build your own data feed.
