---
title: Manifest Reference
description: Full reference for the manifest.json plugin descriptor.
order: 6
---

# Manifest Reference

Every plugin must include a `manifest.json` at the package root. WorldWideView reads this file at install time and whenever the plugin is loaded.

---

## Minimal example

```json
{
  "id": "com.example.my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "entryPoint": "dist/index.js"
}
```

---

## Full example

```json
{
  "id": "com.example.flight-alerts",
  "name": "Flight Alerts",
  "version": "2.1.0",
  "description": "Highlights aircraft squawking emergency codes.",
  "author": {
    "name": "Ada Lovelace",
    "email": "ada@example.com",
    "url": "https://example.com"
  },
  "homepage": "https://example.com/flight-alerts",
  "repository": "https://github.com/example/flight-alerts",
  "license": "MIT",
  "icon": "assets/icon.png",
  "entryPoint": "dist/index.js",
  "permissions": [
    "globe.entities",
    "data.subscribe",
    "data.publish",
    "ui.panel",
    "ui.toolbar",
    "settings.read",
    "settings.write"
  ],
  "wwvVersion": ">=1.0.0",
  "settings": [
    {
      "key": "alertSounds",
      "label": "Play alert sounds",
      "type": "boolean",
      "default": true
    },
    {
      "key": "minAltitude",
      "label": "Minimum altitude (ft)",
      "type": "number",
      "default": 0,
      "min": 0,
      "max": 60000
    }
  ]
}
```

---

## Fields

### `id` *(required)*

**Type**: `string`

Unique reverse-domain identifier for the plugin. Must be globally unique in the Marketplace.

```
"id": "com.example.my-plugin"
```

Use your own domain in reverse notation. If you don't own a domain, use `io.github.<username>.<plugin-name>`.

---

### `name` *(required)*

**Type**: `string`

Human-readable display name. Shown in the Plugin Manager and Marketplace. Max 50 characters.

---

### `version` *(required)*

**Type**: `string` (semver)

Plugin version. Must follow [Semantic Versioning](https://semver.org/). Bumping the version is required to publish an update to the Marketplace.

---

### `entryPoint` *(required)*

**Type**: `string`

Relative path to the compiled entry file. This file must export `activate` (and optionally `deactivate`) as named or default exports.

```json
"entryPoint": "dist/index.js"
```

---

### `description`

**Type**: `string`

Short description shown in the Plugin Manager and Marketplace search results. Max 150 characters.

---

### `author`

**Type**: `object`

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Display name |
| `email` | `string` | Contact email (not shown publicly) |
| `url` | `string` | Website or profile URL |

---

### `homepage`

**Type**: `string` (URL)

Link to the plugin's documentation or website. Shown as a "Learn more" link in the Marketplace.

---

### `repository`

**Type**: `string` (URL)

Link to the source repository.

---

### `license`

**Type**: `string`

SPDX license identifier (e.g. `"MIT"`, `"Apache-2.0"`, `"GPL-3.0"`). Shown in the Marketplace.

---

### `icon`

**Type**: `string`

Relative path to a PNG or SVG icon, at least 128×128 px. Used in the Plugin Manager and Marketplace.

---

### `permissions`

**Type**: `string[]`

List of permissions the plugin requires. Users are shown this list before installing. The plugin will not be able to call APIs beyond the permissions it declared.

See [Permissions](/permissions) for the full list.

---

### `wwvVersion`

**Type**: `string` (semver range)

Minimum WorldWideView version required. Plugins that declare a higher minimum version than the installed app will be disabled with an upgrade prompt.

```json
"wwvVersion": ">=1.2.0"
```

---

### `settings`

**Type**: `SettingDefinition[]`

Declares the settings your plugin exposes in the Settings panel. Each entry creates a UI control automatically.

#### SettingDefinition

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `key` | `string` | Yes | Key used with `ctx.settings.get/set` |
| `label` | `string` | Yes | Label shown in the Settings panel |
| `type` | `'boolean' \| 'number' \| 'string' \| 'select'` | Yes | Control type |
| `default` | `any` | Yes | Default value |
| `description` | `string` | No | Help text shown below the control |
| `min` | `number` | No | Minimum value (for `type: 'number'`) |
| `max` | `number` | No | Maximum value (for `type: 'number'`) |
| `options` | `{ value: string, label: string }[]` | No | Options list (for `type: 'select'`) |
