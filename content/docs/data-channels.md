---
title: Data Channels
description: Built-in data channels and how to publish your own.
order: 5
---

# Data Channels

WorldWideView moves data between plugins and the globe through named channels on the DataBus. Any plugin can publish to or subscribe from any channel — including the built-in system channels that stream live ADS-B, AIS, and other feeds.

---

## Subscribing to a channel

```ts
import type { PluginContext } from '@wwv/sdk';

export default function activate(ctx: PluginContext) {
  const unsub = ctx.data.subscribe('adsb.positions', (data) => {
    // data is typed as `unknown` — cast to the expected shape
    const positions = data as ADSBPosition[];
    for (const pos of positions) {
      ctx.globe.updateEntity(pos.icao, { position: { lat: pos.lat, lon: pos.lon } });
    }
  });

  return { deactivate: () => unsub() };
}
```

The callback fires every time a new batch of data arrives on the channel. The subscription is push-based — you do not need to poll.

---

## Publishing to a channel

```ts
ctx.data.publish('my-plugin.alerts', {
  id: 'alert-001',
  severity: 'high',
  message: 'Transponder squawking 7700',
});
```

Other plugins that subscribe to `'my-plugin.alerts'` will receive this payload immediately.

---

## Built-in channels

### `adsb.positions`

Real-time ADS-B aircraft positions aggregated from global receivers.

```ts
interface ADSBPosition {
  icao: string;        // 6-char hex ICAO address
  callsign?: string;
  lat: number;
  lon: number;
  altitude: number;    // feet
  speed?: number;      // knots
  heading?: number;    // degrees
  verticalRate?: number; // ft/min
  timestamp: number;   // Unix ms
}
```

**Update rate**: ~1 second (varies by receiver density)

---

### `ais.vessels`

Real-time AIS vessel positions from maritime receivers.

```ts
interface AISVessel {
  mmsi: string;
  name?: string;
  callsign?: string;
  lat: number;
  lon: number;
  speed?: number;       // knots
  course?: number;      // degrees
  heading?: number;     // degrees
  vesselType?: number;  // ITU vessel type code
  timestamp: number;    // Unix ms
}
```

**Update rate**: ~30 seconds (AIS Class A); longer for Class B

---

### `adsb.alerts`

Squawk-code alerts and emergency transponder events.

```ts
interface ADSBAlert {
  icao: string;
  squawk: string;   // e.g. '7700', '7600', '7500'
  type: 'emergency' | 'radio_failure' | 'hijack';
  timestamp: number;
}
```

---

### `globe.camera`

Current camera state. Emitted on every frame while the camera is moving.

```ts
interface CameraState {
  lat: number;
  lon: number;
  altitude: number;   // meters above surface
  heading: number;    // degrees
  pitch: number;      // degrees
  roll: number;       // degrees
}
```

Subscribe to this channel to sync your plugin's state with the current viewport.

---

### `globe.click`

Fires when the user clicks the globe surface (not an entity).

```ts
interface GlobeClick {
  lat: number;
  lon: number;
  altitude: number;  // meters
  screenX: number;
  screenY: number;
}
```

---

### `globe.entityClick`

Fires when the user clicks an entity (aircraft, vessel, custom marker).

```ts
interface EntityClick {
  entityId: string;
  lat: number;
  lon: number;
  screenX: number;
  screenY: number;
}
```

---

## Channel naming conventions

| Prefix | Meaning |
|--------|---------|
| `adsb.*` | ADS-B aircraft data (reserved by WWV) |
| `ais.*` | AIS vessel data (reserved by WWV) |
| `globe.*` | Globe viewport and interaction events (reserved by WWV) |
| `com.<org>.*` | Third-party plugin channels — use your plugin's reverse-domain ID |

Avoid publishing to `adsb.*`, `ais.*`, or `globe.*` channels — these are reserved for the WWV core. Use a scoped prefix like `com.example.my-plugin.*` for your own channels.

---

## Batching and backpressure

The DataBus delivers messages synchronously in the render thread. Keep your subscriber callbacks fast — expensive processing (parsing, sorting, rendering large datasets) should be deferred to a web worker or batched with `requestAnimationFrame`. If your handler takes longer than 16 ms you will drop frames.

```ts
// Bad — blocks the render thread
ctx.data.subscribe('adsb.positions', (data) => {
  expensiveTransform(data);  // might take 50ms
});

// Good — defer work
ctx.data.subscribe('adsb.positions', (data) => {
  requestAnimationFrame(() => expensiveTransform(data));
});
```
