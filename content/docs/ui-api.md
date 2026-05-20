---
title: UI API Reference
description: Register panels, toolbar buttons, and popups from your plugin.
order: 4
---

# UI API Reference

The `UIAPI` is accessed via `ctx.ui` inside your plugin's `activate()` function. It lets plugins register their own UI surfaces — panels, toolbar buttons, context menus, and popups — without needing access to the React tree.

```ts
interface UIAPI {
  registerPanel(panel: PanelConfig): () => void;
  registerToolbarButton(button: ToolbarButtonConfig): () => void;
  registerContextMenuItem(item: ContextMenuItemConfig): () => void;
  showPopup(popup: PopupConfig): () => void;
  showToast(message: string, options?: ToastOptions): void;
}
```

All registration methods return an **unregister function**. Call it in your `deactivate()` to remove the UI element cleanly.

---

## registerPanel

Adds a panel to the side drawer. Users can open it from the panel list.

```ts
ctx.ui.registerPanel({
  id: 'my-plugin.panel',
  title: 'My Panel',
  icon: 'satellite',  // icon name from the WWV icon set
  render: (container) => {
    container.innerHTML = '<p>Hello from my plugin</p>';
    // or mount a framework component into container
  },
});
```

### PanelConfig

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | Yes | Unique panel ID — scoped to your plugin ID |
| `title` | `string` | Yes | Label shown in the panel header |
| `icon` | `string` | No | Icon name from the WWV icon set |
| `render` | `(container: HTMLElement) => void` | Yes | Called once when the panel first opens |
| `onClose` | `() => void` | No | Called when the panel is collapsed |
| `width` | `number` | No | Default width in pixels (default: `320`) |

---

## registerToolbarButton

Adds a button to the main toolbar strip.

```ts
const unregister = ctx.ui.registerToolbarButton({
  id: 'my-plugin.toggle',
  tooltip: 'Toggle my overlay',
  icon: 'layers',
  onClick: () => {
    // handle click
  },
});

export function deactivate() {
  unregister();
}
```

### ToolbarButtonConfig

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | Yes | Unique button ID |
| `tooltip` | `string` | Yes | Shown on hover |
| `icon` | `string` | Yes | Icon name from the WWV icon set |
| `onClick` | `() => void` | Yes | Click handler |
| `active` | `boolean` | No | Highlights the button as toggled on |

---

## registerContextMenuItem

Adds an item to the right-click context menu on the globe. The `filter` callback controls when it appears.

```ts
ctx.ui.registerContextMenuItem({
  id: 'my-plugin.inspect',
  label: 'Inspect entity',
  filter: (target) => target.type === 'entity',
  onClick: (target) => {
    console.log('Inspecting', target.id);
  },
});
```

### ContextMenuItemConfig

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | Yes | Unique item ID |
| `label` | `string` | Yes | Text shown in the menu |
| `filter` | `(target: ClickTarget) => boolean` | No | Return `false` to hide the item for this target |
| `onClick` | `(target: ClickTarget) => void` | Yes | Click handler |

### ClickTarget

```ts
interface ClickTarget {
  type: 'entity' | 'globe' | 'label';
  id?: string;       // entity ID if type === 'entity'
  lat: number;
  lon: number;
  altitude?: number;
}
```

---

## showPopup

Renders a floating popup anchored to a globe position or screen coordinate.

```ts
const close = ctx.ui.showPopup({
  anchor: { lat: 37.77, lon: -122.42 },
  content: (container) => {
    container.innerHTML = '<strong>San Francisco</strong>';
  },
  onClose: () => console.log('popup closed'),
});

// Close programmatically:
close();
```

### PopupConfig

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `anchor` | `LatLon \| { x: number, y: number }` | Yes | Globe position or screen pixel coordinates |
| `content` | `(container: HTMLElement) => void` | Yes | Renders popup content into the container |
| `onClose` | `() => void` | No | Called when the user dismisses the popup |
| `width` | `number` | No | Width in pixels (default: `240`) |

---

## showToast

Displays a brief notification in the corner of the screen. Not persistent — disappears after a few seconds.

```ts
ctx.ui.showToast('Data feed connected', { type: 'success' });
ctx.ui.showToast('Rate limit reached', { type: 'warning' });
ctx.ui.showToast('Connection failed', { type: 'error' });
```

### ToastOptions

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | `'info' \| 'success' \| 'warning' \| 'error'` | `'info'` | Visual style |
| `duration` | `number` | `4000` | Time in ms before auto-dismiss |
