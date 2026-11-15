import type { LatLng, DayData, DayGrid, GridMeta, MetricKey, Bounds } from "./types";

const API = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

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

// Daily average over a polygon, all layers together
export async function fetchRegionData(
  polygon: GeoJSON.Polygon,
  signal?: AbortSignal,
): Promise<DayData[]> {
  const res = await fetch(`${API}/api/region`, {
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

// Map layers: `layer` is a name from the backend, e.g. "precipitation" or "temperature"
export const fetchMeta = (layer: MetricKey, signal?: AbortSignal) =>
  getJSON<GridMeta>(`${API}/api/layers/${layer}/meta`, signal);

export const fetchDay = (layer: MetricKey, date: string, signal?: AbortSignal) =>
  getJSON<DayGrid>(`${API}/api/layers/${layer}/day?date=${encodeURIComponent(date)}`, signal);

// the same dev proxy as the other /api calls, so there is no cross-origin (CORS) problem.
export const heatmapUrl = (layer: MetricKey, date: string) =>
  `${API}/api/heatmap/${layer}/${encodeURIComponent(date)}`;

// Heat map: one transparent PNG per layer per day, drawn by the backend. A relative URL on purpose: it goes through
export const fetchHeatmapBounds = (layer: MetricKey, signal?: AbortSignal) =>
  getJSON<Bounds>(`${API}/api/heatmap/${layer}/bounds`, signal);
