---
title: Configuration
description: App settings, performance options, and environment variables.
order: 8
---

# Configuration

WorldWideView stores its configuration in `%APPDATA%\WorldWideView\config.json` on Windows. Most settings are also accessible through the in-app Settings panel (gear icon in the toolbar).

---

## In-app Settings panel

Open Settings via the gear icon in the toolbar. Changes take effect immediately — no restart required.

### Display

| Setting | Default | Description |
|---------|---------|-------------|
| Globe quality | High | Rendering resolution. Reduce to Medium or Low on slower GPUs |
| Show FPS counter | Off | Displays a live frame-rate counter in the corner |
| UI scale | 100% | Scales the entire UI. Useful on 4K displays |
| Dark mode | System | Follows your OS dark/light preference, or override here |

### Data feeds

| Setting | Default | Description |
|---------|---------|-------------|
| ADS-B update rate | 1 s | How often aircraft positions refresh |
| AIS update rate | 30 s | How often vessel positions refresh |
| Stale entity timeout | 5 min | Entities older than this fade out |
| Max entities | 10,000 | Hard cap on simultaneous entities. Increase with caution |

### Privacy

| Setting | Default | Description |
|---------|---------|-------------|
| Send anonymous usage data | On | Opt out here if you prefer |
| Crash reporting | On | Sends stack traces on unexpected crashes |

---

## config.json

For headless or scripted deployments, edit `config.json` directly. The file is created on first launch with default values.

```json
{
  "display": {
    "quality": "high",
    "showFPS": false,
    "uiScale": 1.0,
    "theme": "system"
  },
  "data": {
    "adsbUpdateRate": 1000,
    "aisUpdateRate": 30000,
    "staleEntityTimeout": 300000,
    "maxEntities": 10000
  },
  "privacy": {
    "usageAnalytics": true,
    "crashReporting": true
  },
  "plugins": {
    "autoUpdate": true,
    "devMode": false
  }
}
```

---

## Developer mode

Developer mode enables local plugin loading and unlocks additional debug tooling.

**Enable via Settings** → Advanced → Enable Developer Mode

Or set in `config.json`:

```json
{
  "plugins": {
    "devMode": true
  }
}
```

When developer mode is active:
- The Plugin Manager shows a **Load from disk** button to load unpublished plugins
- The globe renders a coordinate overlay on hover
- The DataBus inspector is available in the toolbar (shows live channel traffic)
- Stack traces are shown in-app instead of the generic crash dialog

---

## Environment variables

These are read at launch and override `config.json`. Useful for CI environments or per-machine overrides.

| Variable | Type | Description |
|----------|------|-------------|
| `WWV_CONFIG_PATH` | `string` | Override the path to `config.json` |
| `WWV_DEV_MODE` | `0` or `1` | Force developer mode on/off |
| `WWV_MAX_ENTITIES` | `number` | Override `data.maxEntities` |
| `WWV_LOG_LEVEL` | `debug\|info\|warn\|error` | Set log verbosity (default: `info`) |
| `WWV_DISABLE_GPU` | `0` or `1` | Force software rendering (fallback for CI/headless) |

---

## Plugin settings

Individual plugin settings live in `%APPDATA%\WorldWideView\plugins\<plugin-id>\settings.json`. They are managed through `ctx.settings` in the plugin SDK and through the per-plugin settings panel in the Plugin Manager — you don't need to edit them directly.

To reset a plugin's settings to defaults, uninstall and reinstall the plugin, or delete the plugin's `settings.json`.
