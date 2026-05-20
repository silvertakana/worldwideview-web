---
title: Troubleshooting
description: Common issues and how to fix them.
order: 10
---

# Troubleshooting

## App issues

### The globe is blank or shows a black screen

**Cause**: WebGL initialisation failed — usually a driver or GPU issue.

1. Open Settings → Display → Globe quality and set it to **Low**
2. If that doesn't help, set `WWV_DISABLE_GPU=1` in your environment variables to force software rendering
3. Update your GPU drivers
4. On Windows, check that hardware-accelerated GPU scheduling is enabled in Graphics Settings

If software rendering works but hardware doesn't, file a bug on [GitHub](https://github.com/worldwideview) with your GPU model and driver version.

---

### No aircraft / vessels are visible

1. Make sure ADS-B or AIS data feeds are enabled in **Settings → Data feeds**
2. Check that the relevant plugins are installed and enabled in the **Plugin Manager**
3. The globe may be zoomed out too far — zoom in to a populated area (e.g. Europe, eastern US coast) and wait 10–15 seconds
4. If you recently installed the app, the live data stream may take up to 60 seconds to establish

---

### The app is slow or frames are dropping

1. Open Settings → Display → Globe quality → **Medium** or **Low**
2. Reduce **Max entities** in Settings → Data feeds (default 10,000; try 2,000)
3. Disable plugins you're not actively using — some plugins update entities on every frame
4. Close other GPU-heavy applications running in the background
5. Check the FPS counter (Settings → Display → Show FPS counter) to confirm the source is GPU-bound, not CPU-bound

---

### App crashes on launch

1. Delete `%APPDATA%\WorldWideView\config.json` — the file may be corrupt. The app will regenerate defaults
2. Check `%APPDATA%\WorldWideView\logs\latest.log` for error details
3. If a plugin is crashing at load, disable all plugins by deleting `%APPDATA%\WorldWideView\plugins\enabled.json`, then re-enable them one by one

---

## Plugin development issues

### `activate` is never called

- Confirm the `entryPoint` in `manifest.json` points to your built output (e.g. `dist/index.js`), not your source
- Make sure `activate` is exported — either `export default function activate(ctx)` or `export function activate(ctx)`
- Check the DevTools console in developer mode for import errors

---

### `PermissionDeniedError` at runtime

Your plugin is calling an API it didn't declare in `manifest.json`. Add the missing permission to the `permissions` array and reload the plugin.

---

### Entities added in `activate` don't appear on the globe

- Confirm you declared `"globe.entities"` in `permissions`
- Check that `position.lat` and `position.lon` are valid numbers (not `NaN` or `undefined`)
- The globe may be pointing at the wrong region — fly to the entity's coordinates to confirm it was placed

```ts
ctx.globe.flyTo({ lat: 37.77, lon: -122.42, altitude: 1000000 });
```

---

### DataBus subscription receives no data

- Confirm you declared `"data.subscribe"` in `permissions`
- Check the channel name — it's case-sensitive. `'adsb.positions'` is correct; `'ADSB.Positions'` is not
- In developer mode, open the **DataBus Inspector** (toolbar) to see live channel traffic and confirm the publisher is active

---

### `pnpm dev` hot-reload isn't working

- Hot reload requires developer mode. Enable it in Settings → Advanced → Enable Developer Mode
- Make sure you loaded the plugin via **Load from disk** (not from the Marketplace), which enables the file watcher
- If the watcher stops reloading, save any file in your plugin's `src/` to trigger a new build

---

### Marketplace submission rejected

| Rejection reason | Fix |
|-----------------|-----|
| Undeclared permission used at runtime | Add the permission to `manifest.json` |
| `network.fetch` permission with no endpoint documentation | Add a "Network requests" section to your Marketplace listing |
| `icon` field missing or icon is too small | Provide a PNG at least 128×128 px |
| `description` missing | Add a short description to `manifest.json` |
| Entry point not found in bundle | Verify `entryPoint` matches your build output |

---

## Getting more help

- **[GitHub Issues](https://github.com/worldwideview)** — bug reports and feature requests
- **[Discord](https://worldwideview.dev/discord)** — community support and plugin developer chat
- **Logs**: `%APPDATA%\WorldWideView\logs\latest.log` — attach this when reporting bugs
