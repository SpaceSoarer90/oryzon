import type { LatLng, DayData, DayGrid, GridMeta } from "./types";

// Leaflet uses [lat, lng]; GeoJSON uses [lng, lat] and the ring must be closed.
export function toGeoJSONPolygon(points: LatLng[]): GeoJSON.Polygon {
  const ring = points.map(([lat, lng]) => [lng, lat]);
  ring.push(ring[0]);
  return { type: "Polygon", coordinates: [ring] };
}

async function getJSON<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail ?? `Request failed (${res.status})`);
  }
  return res.json();
}

export async function fetchRegionData(
  polygon: GeoJSON.Polygon,
  signal?: AbortSignal,
): Promise<DayData[]> {
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

export const fetchMeta = (signal?: AbortSignal) => getJSON<GridMeta>("/api/precip/meta", signal);

export const fetchDay = (date: string, signal?: AbortSignal) =>
  getJSON<DayGrid>(`/api/precip/day?date=${encodeURIComponent(date)}`, signal);
