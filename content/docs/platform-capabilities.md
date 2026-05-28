---
title: Platform Capabilities
description: What WorldWideView tracks and displays in real time.
order: 11
---

# Platform Capabilities

## What WorldWideView Displays

WorldWideView renders live and near-live geospatial data on a 3D globe. The data it shows depends on which plugins are active. Out of the box it comes with several built-in data layers; additional layers are available as installable plugins from the Marketplace.

## Built-in Data Layers

The following layers ship with WorldWideView and are available without any additional install.

| Layer | What it shows |
|-------|--------------|
| ADS-B Flights | Real-time commercial and general aviation positions worldwide. Loaded and enabled by default on first launch. |
| AIS Ships | Maritime vessel positions broadcast by AIS transponders. Covers commercial shipping, ferries, and coastguard vessels. |
| Wildfire | Active fire perimeters and hotspot detections sourced from satellite sensors. |
| Weather | Atmospheric overlays including cloud cover, precipitation, and wind patterns. |
| Military and Signals | Aviation and signals intelligence layers. Availability depends on your edition and access level. |

Each layer appears in the **Layers** tab of the Layer Panel. You can enable or disable any layer individually without affecting others.

## How Layers Are Updated

WorldWideView connects to live data feeds automatically. You do not need to refresh manually.

- The entity count shown next to each layer name updates as new data arrives.
- The timeline at the bottom of the screen reflects the data currently loaded for the selected time window.
- If a feed is temporarily unavailable, the layer shows a loading indicator until the connection is restored.

Data freshness depends on the source. ADS-B and AIS positions typically update every few seconds. Wildfire and weather data update on longer intervals set by the upstream data provider.

## The Layer Panel

The Layer Panel is the main control surface for what is visible on the globe. Open it by clicking the arrow toggle on the left edge of the screen. It contains five tabs:

| Tab | Purpose |
|-----|---------|
| Layers | Toggle active data sources on and off |
| Imagery | Switch the base map (satellite, terrain, etc.) |
| Favorites | Quick access to entities or locations you have pinned |
| GeoJSON Import | Load your own GeoJSON files directly onto the globe |
| Plugins | Manage installed plugins (see [Managing Plugins](/managing-plugins)) |

## Extending with Plugins

The Marketplace offers additional data layers as installable plugins - crowd-sourced radar feeds, earthquake data, port activity, and more. See [Managing Plugins](/managing-plugins) to learn how to browse and install them.
