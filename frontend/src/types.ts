export type LatLng = [number, number];

// One day for a farm polygon, from POST /api/region (all layers together)
export interface DayData {
  date: string;                   // "2025-05-14"
  year: number;                   // kept so other years can be added later
  latlong: LatLng;                // first vertex of the polygon (debugging)
  precipitation: number | null;   // mm/day, null = missing
  temperature: number | null;     // °C, null = missing
  soilMoisture: number | null;    // unit comes from the soil moisture file; null = missing
}

// The data layers the backend serves. Must match the names in DATASETS in main.py.
export type MetricKey = Exclude<keyof DayData, "date" | "year" | "latlong">;

export interface Advice {
  level: "ok" | "warn";
  text: string;
}

// ---- Map layer: one value per grid point per day ----
export interface GridPoint {
  lat: number;
  lon: number;
  value: number | null;
}

export interface DayGrid {
  date: string;
  points: GridPoint[];
}

export interface GridMeta {
  dates: string[];                                        // every day the data has
  period: "day" | "month";                                // "month" = one value per month, repeated on each of its days
  cellSize: { lat: number | null; lon: number | null };   // grid spacing in degrees
  range: { min: number; max: number; p95: number };       // whole-year range, for the colour scale
  bounds: { west: number; south: number; east: number; north: number };
}

// [[south, west], [north, east]]: where a heat map image is pinned on the map (Leaflet ImageOverlay bounds)
export type Bounds = [[number, number], [number, number]];
