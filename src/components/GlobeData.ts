/** Geo points and arc generation for the 3D globe */

export interface GlobePoint {
  lat: number;
  lng: number;
}

export interface GlobeArc {
  start: GlobePoint;
  end: GlobePoint;
}

/** Key locations around the world for globe markers */
export const GLOBE_POINTS: GlobePoint[] = [
  { lat: 40.7, lng: -74.0 },    // New York
  { lat: 51.5, lng: -0.1 },     // London
  { lat: 35.7, lng: 139.7 },    // Tokyo
  { lat: -33.9, lng: 151.2 },   // Sydney
  { lat: 37.8, lng: -122.4 },   // San Francisco
  { lat: 55.8, lng: 37.6 },     // Moscow
  { lat: 1.3, lng: 103.8 },     // Singapore
  { lat: -23.5, lng: -46.6 },   // São Paulo
  { lat: 28.6, lng: 77.2 },     // New Delhi
  { lat: 30.0, lng: 31.2 },     // Cairo
  { lat: 48.9, lng: 2.35 },     // Paris
  { lat: -1.3, lng: 36.8 },     // Nairobi
  { lat: 22.3, lng: 114.2 },    // Hong Kong
  { lat: 59.3, lng: 18.1 },     // Stockholm
  { lat: -36.8, lng: 174.8 },   // Auckland
];

/** Generate arcs connecting random pairs of points */
export function generateArcs(count: number): GlobeArc[] {
  const arcs: GlobeArc[] = [];
  for (let i = 0; i < count; i++) {
    const a = GLOBE_POINTS[i % GLOBE_POINTS.length];
    const b = GLOBE_POINTS[(i + 5) % GLOBE_POINTS.length];
    arcs.push({ start: a, end: b });
  }
  return arcs;
}

/** Convert lat/lng to 3D coordinates on a sphere */
export function latLngToVec3(
  lat: number,
  lng: number,
  radius: number
): [number, number, number] {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lng + 180) * (Math.PI / 180);
  const x = -(radius * Math.sin(phi) * Math.cos(theta));
  const z = radius * Math.sin(phi) * Math.sin(theta);
  const y = radius * Math.cos(phi);
  return [x, y, z];
}
