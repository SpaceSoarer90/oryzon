import type { LatLng, MonthData } from "./types";

// Leaflet uses [lat, lng]; GeoJSON uses [lng, lat] and the ring must be closed.
export function toGeoJSONPolygon(points: LatLng[]): GeoJSON.Polygon {
  const ring = points.map(([lat, lng]) => [lng, lat]);
  ring.push(ring[0]);
  return { type: "Polygon", coordinates: [ring] };
}

export async function fetchRegionData(
  polygon: GeoJSON.Polygon,
  signal?: AbortSignal,
): Promise<MonthData[]> {
  const res = await fetch("/api/region", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(polygon),
    signal,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail ?? `Request failed (${res.status})`);
  }
  return res.json();
}
