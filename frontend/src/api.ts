import type { LatLng, DayData, DayGrid, GridMeta, MetricKey, Bounds, Branch, Candidates, ExperimentPreset, RecRunStatus } from "./types";

// Both base URLs come from the environment when set; the defaults match the current
// deployment (weather API on Render) and local development (recommendation service).
const API = ((import.meta.env.VITE_API_URL as string | undefined) ?? "https://oryzon-wyyo.onrender.com").replace(/\/$/, "");
const SIM_API = ((import.meta.env.VITE_SIM_API_URL as string | undefined) ?? "https://oryzon-sim.onrender.com").replace(/\/$/, "");

export const apiHealthUrl = `${API}/health`;

// Leaflet uses [lat, lng]; GeoJSON uses [lng, lat] and the ring must be closed.
export function toGeoJSONPolygon(points: LatLng[]): GeoJSON.Polygon {
  const ring = points.map(([lat, lng]) => [lng, lat]);
  ring.push(ring[0]);
  return { type: "Polygon", coordinates: [ring] };
}

// An error that remembers the HTTP status, so callers can tell "not found" (404) from "server busy" (5xx).
export class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

// fetch() that gives up after `ms` (and still stops when the caller's own `signal` aborts).
// Free servers can go quiet while they wake up; without a limit a request can hang for minutes.
async function fetchWithTimeout(url: string, init: RequestInit, ms: number | undefined, outer?: AbortSignal): Promise<Response> {
  if (!ms) return fetch(url, { ...init, signal: outer });
  const ctl = new AbortController();
  let timedOut = false;
  const timer = window.setTimeout(() => { timedOut = true; ctl.abort(); }, ms);
  const onAbort = () => ctl.abort();
  outer?.addEventListener("abort", onAbort, { once: true });
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } catch (e) {
    if (timedOut) throw new Error("The service took too long to answer.");
    throw e;
  } finally {
    window.clearTimeout(timer);
    outer?.removeEventListener("abort", onAbort);
  }
}

async function failure(res: Response): Promise<HttpError> {
  const body = await res.json().catch(() => null);
  const detail = typeof body?.detail === "string" ? body.detail : null;
  return new HttpError(detail ?? `Request failed (${res.status})`, res.status);
}

async function getJSON<T>(url: string, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
  const res = await fetchWithTimeout(url, {}, timeoutMs, signal);
  if (!res.ok) throw await failure(res);
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

// ---- Recommendation service (branch -> top 3 -> Yields; spec §3) ---------------------------

export const simHealthUrl = `${SIM_API}/health`;

export const fetchCandidates = (signal?: AbortSignal) =>
  getJSON<Candidates>(`${SIM_API}/api/candidates`, signal, 30_000);

// Optional management presets for the "Farming practice" picker on the Plan screen.
export const fetchExperiments = (signal?: AbortSignal) =>
  getJSON<{ experiments: ExperimentPreset[] }>(`${SIM_API}/api/experiments`, signal);

export async function startRecommendation(
  body: {
    farm: { lat: number; lon: number; establishment: "T" | "DS" };
    branch: Branch;
    planting_date: string;
    pre_crop?: string;
    experiment_id?: string;
    cultivar_ids?: string[];
  },
  signal?: AbortSignal,
): Promise<{ run_id: string }> {
  // 90 s: enough for a sleeping free server to wake up, but not forever.
  const res = await fetchWithTimeout(
    `${SIM_API}/api/recommendations`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    90_000,
    signal,
  );
  if (!res.ok) throw await failure(res);
  return res.json();
}

// A status check must be quick: if one hangs, the caller counts it as a miss and tries again.
export const getRecommendation = (runId: string, signal?: AbortSignal) =>
  getJSON<RecRunStatus>(`${SIM_API}/api/recommendations/${runId}`, signal, 20_000);