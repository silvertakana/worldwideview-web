import { writeFileSync } from "fs";

const body = 'data=[out:json][timeout:300];(node["landuse"="quarry"];way["landuse"="quarry"];node["industrial"="mine"];way["industrial"="mine"];);out center;';
const res = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", body });
const data = await res.json();

const features = data.elements
  .map(el => {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) return null;
    const tags = el.tags || {};
    return {
      type: "Feature",
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: {
        name: tags.name || tags["name:en"] || "Unknown Mine",
        resource: tags.resource || tags.product || "Unknown",
        operator: tags.operator || "Unknown",
        type: tags.landuse === "quarry" ? "Quarry" : "Mine",
      },
    };
  })
  .filter(Boolean);

writeFileSync("public/data/mineral_mines.geojson", JSON.stringify({ type: "FeatureCollection", features }));
console.log(`Wrote ${features.length} mining sites`);
