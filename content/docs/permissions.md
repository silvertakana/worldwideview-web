---
title: Permissions
description: Available plugin permissions and what each one unlocks.
order: 7
---

# Permissions

Plugins must declare every permission they need in `manifest.json`. Users see the list before installing. At runtime, calling an API without the required permission throws a `PermissionDeniedError`.

```json
"permissions": [
  "globe.entities",
  "data.subscribe",
  "ui.panel"
]
```

---

## Globe permissions

### `globe.entities`

Add, update, and remove entities on the 3D globe.

Unlocks:
- `ctx.globe.addEntity()`
- `ctx.globe.updateEntity()`
- `ctx.globe.removeEntity()`

---

### `globe.camera`

Read and control the camera viewport.

Unlocks:
- `ctx.globe.getCamera()`
- `ctx.globe.flyTo()`
- `ctx.globe.setCamera()`

---

### `globe.layers`

Add and remove imagery and terrain layers.

Unlocks:
- `ctx.globe.addLayer()`
- `ctx.globe.removeLayer()`

---

## Data permissions

### `data.subscribe`

Subscribe to named data channels on the DataBus.

Unlocks:
- `ctx.data.subscribe()`

Required to receive data from built-in channels like `adsb.positions` and `ais.vessels`.

---

### `data.publish`

Publish data to named channels on the DataBus.

Unlocks:
- `ctx.data.publish()`

---

## UI permissions

### `ui.panel`

Register a panel in the side drawer.

Unlocks:
- `ctx.ui.registerPanel()`

---

### `ui.toolbar`

Add a button to the main toolbar.

Unlocks:
- `ctx.ui.registerToolbarButton()`

---

### `ui.contextMenu`

Add items to the right-click context menu on the globe.

Unlocks:
- `ctx.ui.registerContextMenuItem()`

---

### `ui.popup`

Show floating popups anchored to globe positions.

Unlocks:
- `ctx.ui.showPopup()`

---

### `ui.toast`

Display brief toast notifications. This permission is granted by default to all plugins.

Unlocks:
- `ctx.ui.showToast()`

---

## Settings permissions

### `settings.read`

Read your plugin's persisted settings.

Unlocks:
- `ctx.settings.get()`

---

### `settings.write`

Write to your plugin's persisted settings.

Unlocks:
- `ctx.settings.set()`

---

## Network permissions

### `network.fetch`

Make outbound HTTP requests from the plugin. Required for any `fetch()` call initiated from plugin code.

Plugins using this permission are reviewed more carefully before Marketplace approval. You must document which endpoints you call and why.

---

## Permission review

Marketplace submissions are reviewed against the declared permissions. Common rejection reasons:

| Reason | Fix |
|--------|-----|
| Declared `network.fetch` without documenting the endpoint | Add endpoint documentation to your Marketplace listing |
| Declared `globe.camera` but only need entity updates | Remove unused permissions |
| Using an API at runtime that isn't declared | Add the missing permission to `manifest.json` |

The fewer permissions you request, the faster the review. Request only what you actually use.
