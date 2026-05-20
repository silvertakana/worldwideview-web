---
title: Architecture
description: How WorldWideView is structured — the globe, plugin system, and DataBus.
order: 9
---

# Architecture

WorldWideView is built around three concepts: the **Globe** (a 3D Cesium renderer), the **DataBus** (a pub/sub message bus), and the **Plugin Manager** (a sandboxed plugin runtime). Everything data-driven flows through the DataBus. Plugins never touch the renderer directly — they go through the SDK.

```
┌─────────────────────────────────────────────────────┐
│                   WorldWideView App                 │
│                                                     │
│  ┌──────────────┐    ┌──────────────────────────┐  │
│  │   Plugin     │    │         Globe            │  │
│  │   Manager    │    │   (Cesium Ion renderer)  │  │
│  │              │    │                          │  │
│  │  plugin A ───┼────┤  Entities / Layers /     │  │
│  │  plugin B ───┼────┤  Camera                  │  │
│  │  plugin C ───┼────┤                          │  │
│  └──────┬───────┘    └──────────────────────────┘  │
│         │                                           │
│  ┌──────▼───────────────────────────────────────┐  │
│  │                   DataBus                    │  │
│  │  adsb.positions  |  ais.vessels  |  custom   │  │
│  └──────────────────────────────────────────────┘  │
│                                                     │
│  ┌──────────────────────────────────────────────┐  │
│  │            Live Data Ingestors               │  │
│  │   ADS-B aggregator  |  AIS aggregator  | …   │  │
│  └──────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

---

## Globe

The 3D globe is powered by [CesiumJS](https://cesium.com/platform/cesiumjs/) with Cesium Ion imagery. Plugins do not interact with CesiumJS directly — they use the `GlobeAPI` in the plugin SDK, which translates SDK calls into Cesium primitives and manages entity lifecycle.

**Key design choice**: Plugins add *entities* (points, labels, models), not Cesium primitives. This lets the core optimize rendering (batching, clustering, LOD) independently of plugin logic.

---

## DataBus

The DataBus is an in-process pub/sub bus. It is synchronous: when a publisher calls `ctx.data.publish()`, all subscribers on that channel receive the message in the same call stack before `publish()` returns.

This means:
- **No async coordination needed** between publisher and subscriber
- **Slow subscribers block the publisher** — keep handlers fast (< 1 ms ideally)
- **No persistence** — messages are not stored; a plugin that wasn't loaded when data was published will miss it

The DataBus is the primary integration point between plugins. Two plugins can coordinate by agreeing on a shared channel name and message shape, without any direct dependency between them.

---

## Plugin Manager

Plugins run in a **sandboxed iframe with a Web Worker backend**. The SDK (exposed via `PluginContext`) communicates over a structured-clone message bridge. This means:

- Plugins cannot access `window`, `document`, or the DOM directly
- Plugins cannot import arbitrary npm packages at runtime (only what's bundled into `dist/index.js`)
- A plugin that throws an unhandled error is caught, logged, and disabled — it does not crash the app
- CPU-intensive plugin code does not block the globe render thread

The sandbox does allow:
- `fetch()` (if the plugin has `network.fetch` permission)
- Web Workers spawned from plugin code
- `localStorage` scoped to the plugin's origin

---

## Plugin lifecycle

```
install → load → activate → [running] → deactivate → unload
```

| Phase | Trigger | What happens |
|-------|---------|-------------|
| **install** | User clicks Install | `manifest.json` is validated; plugin bundle is downloaded and cached |
| **load** | App launches / plugin enabled | Plugin module is imported into the sandbox |
| **activate** | After load | `activate(ctx)` is called with the `PluginContext` |
| **deactivate** | Plugin disabled / app closes | `deactivate()` is called; plugin should clean up subscriptions and UI registrations |
| **unload** | After deactivate | Sandbox is torn down |

If your plugin does not export `deactivate`, the Plugin Manager still tears down the sandbox — but any active subscriptions, panels, or timers may not clean up gracefully. Always export `deactivate`.

---

## SDK versioning

The `@wwv/sdk` package version matches the minimum WorldWideView app version required. If you build against SDK `1.2.0`, declare `"wwvVersion": ">=1.2.0"` in your manifest.

SDK APIs follow semantic versioning:
- **Patch**: bug fixes, no interface changes
- **Minor**: new APIs added (backwards compatible)
- **Major**: breaking API changes (rare; announced at least 6 months in advance)

Deprecated APIs log a console warning for one minor version cycle before removal.

---

## Rendering pipeline

Each frame:

1. DataBus delivers any queued messages to subscribers
2. Plugin Manager flushes pending `addEntity` / `updateEntity` / `removeEntity` calls from all plugins
3. CesiumJS renders the scene (globe, entities, UI overlays)

Frame time budget is 16 ms at 60 fps. The DataBus and entity updates must fit within that budget. The globe renderer adapts its level of detail based on remaining frame time.

---

## Data flow example: ADS-B

```
[External ADS-B aggregator]
         │ HTTP/WebSocket
         ▼
[WWV core ingestor]
         │ ctx.data.publish('adsb.positions', [...])
         ▼
[DataBus]
         │ subscriber callbacks
         ▼
[ADS-B plugin]  →  ctx.globe.updateEntity(...)  →  [Globe renderer]
```

The core ingestor is itself just a privileged internal plugin — it has no special access beyond what the SDK provides. This keeps the architecture uniform.
