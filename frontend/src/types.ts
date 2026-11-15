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

// ---- Recommendation service (sim-service; spec §7 result schema) ----

export type Branch = "rice" | "yield_crops" | "monggo";

export interface RangeStat {
  mean: number;
  p10: number | null;   // null in deterministic mode (one weather year)
  p90: number | null;
}
export interface IdealStat { mean: number }
export interface CropEntry {
  rank: number;
  crop: string;
  actual_yield: RangeStat;
  ideal_yield: IdealStat;
  relative_yield: RangeStat;
  maturity_days: RangeStat | null;
}
export interface PreCrop { type: "yield_crop" | "cover"; id: string; actual_yield_mean: number }
export interface SoilDelta { d_soc_kg_ha: number; d_son_kg_ha: number; mineral_n_end_kg_ha: number }
export interface RunMeta {
  dssat_version: string;
  weather_source: string;
  soil_om_module: string;
  cultivar_coefficient_source: string;
  ideal_yield_source: string;
}
export interface FailedRun { sequence: string; scenario: number; run_type: "actual" | "ideal"; error: string }
export interface VarietyEntry {
  rank: number;
  variety: string;
  pre_crop: PreCrop | null;   // null for the Rice branch
  rice_actual: RangeStat;
  rice_ideal: IdealStat;
  relative_yield: RangeStat;
  maturity_days: RangeStat | null;
  days_from_plan_start: RangeStat | null;
  soil_delta: SoilDelta;
  metadata: RunMeta;
  failed_runs: FailedRun[];
}
export interface RecommendationResult {
  branch: Branch;
  scenarios: number[];        // weather years the scenarios used
  crops: CropEntry[] | null;  // Yield Crops branch, stage 1 only
  varieties: VarietyEntry[];
  metadata: RunMeta;
  notes: string[];
  failed_runs: FailedRun[];
}
export interface RiceCultivar { id: string; name: string }
export interface Candidates { rice_varieties: RiceCultivar[]; yield_crops: string[]; source: string; weather_windows: number }
export interface RecRunStatus {
  status: "queued" | "running" | "done" | "failed";
  progress: { done: number; total: number | null };
  result: RecommendationResult | null;
  error: string | null;
}

// A selectable management preset (GET /api/experiments); its id goes in experiment_id.
export interface ExperimentPreset {
  id: string;
  title: string;
  cultivar: string;
  cultivar_name: string;
  establishment: "T" | "DS";
  irrigation: "automatic" | "scheduled" | "rainfed";
  fertilizer_events: number;
  fertilizer_kg_n_ha: number;
  file_planting_date: string;
}

// ---- Crops the farmer has chosen for coming seasons (saved on the farm, shown on the Dashboard) ----
// Money is per hectare, in pesos: income = yield x farmgate price, cost = seed / planting material.
export interface PlanEcon {
  incomeLow: number;
  incomeMid: number;
  incomeHigh: number;
  costLow: number;
  costMid: number;
  costHigh: number;
}
export interface FuturePlan {
  id: "pre" | "rice";            // one crop before rice, and one rice
  kind: "yield_crop" | "rice";
  name: string;                  // "Maize", or the rice variety
  cropKey: string | null;        // key into CROP_DATA for yield crops
  plantingDate: string;          // YYYY-MM-DD
  harvestDate: string;           // YYYY-MM-DD
  maturityDays: number;
  yieldKgHa: number | null;
  econ: PlanEcon | null;
  savedAt: number;
}