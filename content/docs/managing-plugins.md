---
title: Managing Plugins
description: Install, enable, disable, and remove data layer plugins.
order: 12
---

# Managing Plugins

Plugins add new data layers to the globe. This guide covers how to find, install, and manage them.

## Opening the Plugin Manager

The Layer Panel opens from the left side of the screen. Click the arrow toggle at the left edge to expand it. Inside the panel, click the **Plugins** tab to see your installed plugins and manage them.

## Trust Badges

Every plugin carries a trust badge that tells you who maintains it and how it has been reviewed.

| Badge | Meaning |
|-------|---------|
| Built-in | Ships with WorldWideView and is maintained by the platform team. These are the most stable and tested layers. |
| Verified | Submitted by a third party and reviewed and approved by the marketplace team before listing. |
| Community | User-submitted plugin that has not been formally reviewed. Use with care - inspect the source if you are unsure. |

## Installing a Plugin from the Marketplace

1. Open the Layer Panel and click the **Plugins** tab.
2. Click **Browse Marketplace**. This opens [marketplace.worldwideview.dev](https://marketplace.worldwideview.dev) in your browser.
3. Find a plugin you want and click **Install**.
4. The plugin appears in your installed list immediately. No app restart is required.
5. Switch to the **Layers** tab to enable the new layer and see it on the globe.

## Enabling and Disabling Layers

Each layer in the **Layers** tab has a toggle switch on its row.

- **Enabled:** The layer fetches live data and renders entities on the globe.
- **Disabled:** Data fetching stops and entities are hidden from the globe. The plugin stays installed and can be re-enabled at any time.

Disabling a layer is useful when you want to reduce visual clutter or stop background data fetching without permanently removing the plugin.

## Uninstalling a Plugin

1. Open the Layer Panel and click the **Plugins** tab.
2. Find the plugin you want to remove.
3. Click the uninstall icon (trash can) on that plugin's row.
4. Confirm the removal. The plugin is removed from your installed list immediately.

Note: **Built-in** plugins cannot be uninstalled. The uninstall action is only available for community and marketplace-installed plugins.

## Updating a Plugin

When an update is available for an installed plugin, an **Update** button appears on that plugin's row in the Plugins tab. Click it to apply the update. Updates take effect immediately without restarting the app.
