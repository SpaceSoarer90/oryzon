export type LatLng = [number, number];

export interface DayData {
  date: string;                  // "2025-05-14"
  year: number;                  // kept so other years can be added later
  precipitation: number | null;  // mm/day, null = missing
  latlong: LatLng;               // first vertex of the polygon
}

export type MetricKey = Exclude<keyof DayData, "date" | "year" | "latlong">;

export interface Advice {
  level: "ok" | "warn";
  text: string;
}

// ---- Map layer: one value per grid point per day ----
export interface GridPoint {
  lat: number;
  lon: number;
  precipitation: number | null;
}

export interface DayGrid {
  date: string;
  points: GridPoint[];
}

export interface GridMeta {
  dates: string[];                                        // every day the data has
  cellSize: { lat: number | null; lon: number | null };   // grid spacing in degrees
  range: { min: number; max: number; p95: number };       // whole-year range, for the colour scale
  bounds: { west: number; south: number; east: number; north: number };
}
