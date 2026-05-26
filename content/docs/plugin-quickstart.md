---
title: Plugin Quickstart
description: Build and publish your first WorldWideView plugin.
order: 2
---

# Plugin Quickstart

This guide walks you through creating a minimal plugin that places a custom entity on the globe.

## Prerequisites

- Node.js 18+
- `pnpm` or `npm`
- A WorldWideView account on the [Marketplace](https://marketplace.worldwideview.dev)

## 1. Scaffold the plugin

```bash
pnpm dlx create-wwv-plugin my-plugin
cd my-plugin
pnpm install
```

## 2. Define your manifest

Every plugin declares its identity in `manifest.json`:

```json
{
  "id": "com.example.my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "A short description shown in the Marketplace.",
  "entryPoint": "dist/index.js",
  "permissions": ["globe.entities"]
}
```

## 3. Write the entry point

```ts
import type { PluginContext } from '@wwv/sdk';

export default function activate(ctx: PluginContext) {
  ctx.globe.addEntity({
    id: 'hello-world',
    position: { lat: 37.77, lon: -122.42 },
    label: 'Hello from my plugin',
  });
}
```

## 4. Build and test locally

```bash
pnpm build
pnpm dev
```

`pnpm dev` opens a local test harness that loads your plugin into a live globe instance. Changes hot-reload automatically.

## 5. Publish to the Marketplace

```bash
pnpm publish:wwv
```

Follow the CLI prompts to authenticate and upload your plugin. After review it appears publicly in the Marketplace.

## Next steps

See the [Plugin API Reference](/docs/plugin-api) for the full SDK.
