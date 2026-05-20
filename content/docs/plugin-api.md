---
title: Plugin API Reference
description: Full reference for the WorldWideView plugin SDK.
order: 3
---

# Plugin API Reference

## PluginContext

The `PluginContext` object is passed to your plugin's `activate()` function and is the entry point for all SDK features.

```ts
interface PluginContext {
  globe: GlobeAPI;
  data: DataAPI;
  ui: UIAPI;
  settings: SettingsAPI;
}
```

---

## GlobeAPI

### `addEntity(entity: Entity): void`

Adds a new entity to the globe.

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | `string` | Unique identifier for the entity |
| `position` | `LatLon` | `{ lat: number, lon: number }` |
| `label` | `string?` | Optional display label |
| `icon` | `string?` | Optional icon URL |
| `altitude` | `number?` | Altitude in meters above sea level |

### `removeEntity(id: string): void`

Removes an entity by ID. No-op if the entity does not exist.

### `updateEntity(id: string, patch: Partial<Entity>): void`

Partially updates an existing entity. Only the provided fields are changed.

---

## DataAPI

### `subscribe(channel: string, handler: (data: unknown) => void): () => void`

Subscribes to a named data channel. Returns an unsubscribe function — call it in your plugin's `deactivate()` to avoid memory leaks.

```ts
const unsub = ctx.data.subscribe('adsb.positions', (data) => {
  console.log(data);
});

export function deactivate() {
  unsub();
}
```

---

## SettingsAPI

### `get<T>(key: string, defaultValue: T): T`

Reads a persisted plugin setting.

### `set(key: string, value: unknown): void`

Writes a plugin setting. Values are persisted between sessions.

---

## Lifecycle hooks

| Export | When called |
|--------|-------------|
| `activate(ctx)` | Plugin is enabled by the user |
| `deactivate()` | Plugin is disabled or app closes |
