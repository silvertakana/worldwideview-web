/* Umami custom-event helper — no-ops when the tracker hasn't loaded */

declare global {
  interface Window {
    umami?: { track: (name: string, data?: Record<string, unknown>) => void };
  }
}

export function trackEvent(
  name: string,
  data?: Record<string, unknown>,
): void {
  if (typeof window !== "undefined" && window.umami) {
    window.umami.track(name, data);
  }
}
