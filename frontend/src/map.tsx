import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import {
  MapContainer,
  TileLayer,
  Polygon,
  Polyline,
  CircleMarker,
  Marker,
  ImageOverlay,
  Pane,
  Tooltip,
  useMap,
  useMapEvents,
} from "react-leaflet";
import { PlanNext } from "./recommend";
import type { Advice, Bounds, DayData, GridMeta, GridPoint, LatLng, MetricKey } from "./types";
import { fetchDay, fetchHeatmapBounds, heatmapUrl, fetchMeta, fetchRegionData, toGeoJSONPolygon } from "./api";
import temperatureIcon from "./assets/temperature.png";
import soilMoistureIcon from "./assets/soil-moisture.png";
import precipitationIcon from "./assets/precipitation.png";
import temperatureClicked from "./assets/temperature_clicked.png";
import soilMoistureClicked from "./assets/soil-moisture_clicked.png";
import precipitationClicked from "./assets/precipitation_clicked.png";

/* ---------- constants ---------- */

// Opening view: Alaminos City and the Hundred Islands coast, with farmland inland.
// Lower zoom = further out (try 10 for more of Pangasinan, 12 to get closer).
const START_CENTER: LatLng = [16.19, 119.99];
const START_ZOOM = 11;
const CLOSE_PX = 24; // tap within this many pixels of the first point to close the shape
const WATER_LIMIT = 0.5; // an outline is rejected when at least this share of it is open water

// Finds the logo by file name in src/assets, whatever the extension is (.png, .jpg, .webp, .svg...).
const logoFiles = import.meta.glob("./assets/logo.*", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;
const logo = Object.values(logoFiles)[0] ?? "";

// Dashboard pictures. Found by file name in src/assets, whatever the extension is (.png, .jpg, .webp, .svg...).
// A missing file shows a console message instead of stopping the app.
const dashFiles = import.meta.glob(
  "./assets/{location_dashboard,temp_dashboard,soil_moisture_dashboard,precipitation_dashboard,weather_sunny,weather_cloudy,weather_rainy}.*",
  { eager: true, query: "?url", import: "default" },
) as Record<string, string>;

function dashAsset(name: string): string {
  const path = Object.keys(dashFiles).find((p) => p.startsWith(`./assets/${name}.`));
  if (!path) console.error(`Missing image: src/assets/${name}.(png|jpg|webp|svg)`);
  return path ? dashFiles[path] : "";
}

const locationDashboard = dashAsset("location_dashboard");
const tempDashboard = dashAsset("temp_dashboard");
const soilMoistureDashboard = dashAsset("soil_moisture_dashboard");
const precipitationDashboard = dashAsset("precipitation_dashboard");
const weatherSunny = dashAsset("weather_sunny");
const weatherCloudy = dashAsset("weather_cloudy");
const weatherRainy = dashAsset("weather_rainy");

// Optional photo for the top of the Set up farm screen: put it in src/assets as setup_background.(png|jpg|webp).
// Without it the header is plain olive green.
const setupBgFiles = import.meta.glob("./assets/setup_background.*", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;
const setupBg = Object.values(setupBgFiles)[0] ?? "";

interface ThePolygon {
  closed: boolean;
  points: LatLng[];
}
const EMPTY: ThePolygon = { closed: false, points: [] };

// A saved farm (one "map" the user monitors). The list is remembered in this browser.
type Water = "rainfed" | "irrigation" | "both";
// Answers from the Set up farm screen.
type YieldUnit = "tons" | "kg" | "cavans";
type IrrigationSource = "government" | "communal" | "pump" | "river" | "other";
interface FarmDetails {
  lastCrop: string;
  lastHarvestYield: string; // digits and at most one decimal point
  yieldUnit: YieldUnit;
  harvestDate: string; // YYYY-MM-DD
  water: Water | null;
  irrigationSource: IrrigationSource | "";
  irrigationStart: string; // government irrigation only: when distribution starts (YYYY-MM-DD)
  irrigationEnd: string; // ...and when it ends
  soilTest: boolean | null; // has soil test results?
}
const EMPTY_DETAILS: FarmDetails = {
  lastCrop: "",
  lastHarvestYield: "",
  yieldUnit: "tons",
  harvestDate: "",
  water: null,
  irrigationSource: "",
  irrigationStart: "",
  irrigationEnd: "",
  soilTest: null,
};

const YIELD_UNITS: { value: YieldUnit; label: string }[] = [
  { value: "tons", label: "tons" },
  { value: "kg", label: "kg" },
  { value: "cavans", label: "cavans (50 kg)" },
];
const IRRIGATION_SOURCES: { value: IrrigationSource; label: string }[] = [
  { value: "government", label: "Government / regulated (e.g. NIA)" },
  { value: "communal", label: "Communal (farmers' association)" },
  { value: "pump", label: "Pump or well" },
  { value: "river", label: "River, creek or stream" },
  { value: "other", label: "Other" },
];

// Keep only digits and a single decimal point, so the yield box accepts numbers only.
function sanitizeDecimal(v: string): string {
  const x = v.replace(/[^\d.]/g, "");
  const i = x.indexOf(".");
  return i < 0 ? x : x.slice(0, i + 1) + x.slice(i + 1).replace(/\./g, "");
}

// Older saves may hold text like "4.5 tons" or a free-typed water source: keep what still fits.
function normalizeDetails(raw: Partial<FarmDetails> | undefined): FarmDetails {
  const d = { ...EMPTY_DETAILS, ...raw };
  const num = String(d.lastHarvestYield ?? "").match(/\d+(\.\d+)?|\.\d+/);
  d.lastHarvestYield = num ? num[0] : "";
  if (!YIELD_UNITS.some((u) => u.value === d.yieldUnit)) d.yieldUnit = "tons";
  if (!IRRIGATION_SOURCES.some((o) => o.value === d.irrigationSource)) d.irrigationSource = "";
  return d;
}

// "2026-04-01" -> "April 1, 2026"
function formatDate(iso: string): string | null {
  const date = new Date(`${iso}T00:00:00`);
  return iso && !Number.isNaN(date.getTime())
    ? date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
    : null;
}
// "2026-04-01" -> "Apr 1, 2026"
function shortDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
/* ---------- Farm plots: crop records and soil ---------- */

type Performance = "good" | "average" | "poor" | "failure" | "unknown";
type SoilSource = "sensor" | "lab" | "manual";
// One past crop on a plot ("Crop record 1", "Crop record 2", ...).
interface CropRecord {
  id: string;
  crop: string;
  plantingDate: string; // YYYY-MM-DD
  harvestDate: string; // YYYY-MM-DD
  amount: string; // digits and at most one decimal point
  unit: YieldUnit;
  performance: Performance | "";
}
interface SoilInfo {
  texture: string;
  moisture: number | null; // volumetric water content (VWC) in %, null until the slider is used
  depth: string; // measurement depth in cm
  source: SoilSource | "";
  soilTest: boolean | null; // has soil test results?
}
interface Plot {
  id: string;
  name: string;
  area: string; // hectares, digits and at most one decimal point (calculated when `points` is set)
  points?: LatLng[]; // the plot's outline on the map, drawn inside the farm outline
  cropRecords: CropRecord[];
  soil: SoilInfo;
}

const CROPS = ["Rice", "Corn", "Onion", "Garlic", "Mung beans", "Vegetables", "Other"];
const PERFORMANCES: { value: Performance; label: string }[] = [
  { value: "good", label: "Good Harvest" },
  { value: "average", label: "Average Harvest" },
  { value: "poor", label: "Poor Harvest" },
  { value: "failure", label: "Crop Failure" },
  { value: "unknown", label: "I don't know" },
];
const SOIL_SOURCES: { value: SoilSource; label: string }[] = [
  { value: "sensor", label: "Soil moisture sensor" },
  { value: "lab", label: "Laboratory test" },
  { value: "manual", label: "Manual estimate" },
];
const SOURCE_LABEL = Object.fromEntries(SOIL_SOURCES.map((s) => [s.value, s.label])) as Record<SoilSource, string>;
const PERFORMANCE_LABEL = Object.fromEntries(PERFORMANCES.map((p) => [p.value, p.label])) as Record<Performance, string>;

const uid = () => Math.random().toString(36).slice(2, 9);
const newCropRecord = (): CropRecord => ({
  id: uid(),
  crop: "",
  plantingDate: "",
  harvestDate: "",
  amount: "",
  unit: "tons",
  performance: "",
});
const emptySoil = (): SoilInfo => ({ texture: "", moisture: null, depth: "", source: "", soilTest: null });
const newPlot = (area = ""): Plot => ({ id: uid(), name: "", area, cropRecords: [], soil: emptySoil() });

const plotLabel = (p: Plot, i: number) => p.name.trim() || `Plot ${i + 1}`;
const recordBlank = (r: CropRecord) => !r.crop && !r.plantingDate && !r.harvestDate && !r.amount && !r.performance;
const recordError = (r: CropRecord): string | null =>
  r.plantingDate && r.harvestDate && r.harvestDate < r.plantingDate
    ? "The harvest date must be on or after the planting date."
    : null;

// The plot's most recent crop (by harvest date); records without a date count as oldest.
function latestRecord(p: Plot): CropRecord | null {
  const filled = p.cropRecords.filter((r) => !recordBlank(r));
  if (filled.length === 0) return null;
  const sorted = [...filled].sort((a, b) => (a.harvestDate || "").localeCompare(b.harvestDate || ""));
  return sorted[sorted.length - 1];
}

function amountText(r: CropRecord): string | null {
  if (!r.amount || !/\d/.test(r.amount)) return null;
  return `${r.amount} ${YIELD_UNITS.find((u) => u.value === r.unit)?.label ?? r.unit}`;
}

// Saved plots, or (for farms saved before plots existed) one plot built from the old farm-level answers.
function normalizePlots(farm: Farm): Plot[] {
  if (farm.plots && farm.plots.length > 0) {
    return farm.plots.map((p) => {
      const records = (p.cropRecords ?? []).map((r) => ({ ...newCropRecord(), ...r }));
      return {
        ...newPlot(""),
        ...p,
        cropRecords: records,
        soil: { ...emptySoil(), ...p.soil },
      };
    });
  }
  const plot = newPlot(polygonAreaHa(farm.points).toFixed(2));
  const d = farm.details;
  if (d && (d.lastCrop || d.lastHarvestYield || d.harvestDate)) {
    plot.cropRecords = [
      { ...newCropRecord(), crop: d.lastCrop, amount: d.lastHarvestYield, unit: d.yieldUnit, harvestDate: d.harvestDate },
    ];
  }
  plot.soil.soilTest = d?.soilTest ?? null;
  return [plot];
}

export interface Farm {
  id: string;
  name: string;
  points: LatLng[];
  location?: string; // filled in on the Set up farm screen
  details?: FarmDetails;
  plots?: Plot[]; // each plot: its name, area, past crop records and soil readings
}
export interface FarmStore {
  farms: Farm[];
  activeId: string | null;
}
const FARMS_KEY = "oryzon:farms";
const LEGACY_KEY = "oryzon:farm"; // an earlier version stored a single outline

const isPoints = (v: unknown): v is LatLng[] =>
  Array.isArray(v) &&
  v.length >= 3 &&
  v.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite));

export function loadStore(): FarmStore {
  try {
    const raw = localStorage.getItem(FARMS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const farms: Farm[] = Array.isArray(parsed?.farms)
        ? parsed.farms.filter(
            (f: Farm) => f && typeof f.id === "string" && typeof f.name === "string" && isPoints(f.points),
          )
        : [];
      const activeId = farms.some((f) => f.id === parsed.activeId) ? parsed.activeId : farms[0]?.id ?? null;
      return { farms, activeId };
    }
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const pts = JSON.parse(legacy);
      if (isPoints(pts)) return { farms: [{ id: "farm-1", name: "Farm 1", points: pts }], activeId: "farm-1" };
    }
  } catch {
    /* unreadable storage: start with no farms */
  }
  return { farms: [], activeId: null };
}

// Data the backend has. Cards in the Condition sheet, and the layers that can be drawn on the map.
const METRICS: { key: MetricKey; label: string; unit: string; color: string }[] = [
  { key: "precipitation", label: "Precipitation", unit: " mm", color: "#2f7fd1" },
  { key: "temperature", label: "Temperature", unit: " °C", color: "#e0773a" },
  // Set `unit` from the file (e.g. " m³/m³" if its metadata says so, "" for a plain 0-1 wetness fraction).
  { key: "soilMoisture", label: "Soil moisture", unit: "", color: "#43c864" },
];

// The three layer buttons on the right side of the screen.
// `available` = the backend has data for it. Set it to false to grey a button out.
type LayerKey = MetricKey;

const LAYERS: { key: LayerKey; label: string; icon: string; iconClicked: string; available: boolean }[] = [
  { key: "temperature", label: "Temperature", icon: temperatureIcon, iconClicked: temperatureClicked, available: true },
  { key: "soilMoisture", label: "Soil Moisture", icon: soilMoistureIcon, iconClicked: soilMoistureClicked, available: true },
  { key: "precipitation", label: "Precipitation", icon: precipitationIcon, iconClicked: precipitationClicked, available: true },
];

// Colour scale shown in the legend for each map layer.
// NOTE: the heat map picture is painted by the backend. Make `stops`, `min` and `max` match the colormap and
// value range it uses, otherwise the legend will not describe what is on the map.
interface LegendSpec {
  title: string;
  unit: string;
  min: number;
  max: number;
  openEnd?: boolean; // values above `max` use the last colour, so the top label reads "40+"
  stops: string[]; // colours from `min` to `max`
  low: string;
  high: string;
}
const LEGENDS: Record<MetricKey, LegendSpec> = {
  temperature: {
    title: "Temperature",
    unit: "°C",
    min: 20,
    max: 40,
    openEnd: true,
    stops: ["#3b4cc0", "#7ab6e8", "#f5e663", "#f39c3d", "#c0392b"], // = COLORMAPS.temperature (heatmap_service.py)
    low: "Cooler",
    high: "Hotter",
  },
  soilMoisture: {
    title: "Soil moisture",
    unit: "%",
    min: 0,
    max: 50,
    openEnd: true,
    stops: ["#8c5a2b", "#d9b36c", "#7fc97f", "#2c8f6d", "#1d5fa8"],
    low: "Drier",
    high: "Wetter",
  },
  precipitation: {
    title: "Precipitation",
    unit: "mm",
    min: 0,
    max: 50,
    openEnd: true,
    stops: ["#9be7ff", "#35b6ff", "#2ecc71", "#f7e11e", "#ff8c1a", "#e5252a"], // = COLORMAPS.precipitation
    low: "Less",
    high: "More",
  },
};

const isMetric = (k: LayerKey | null): k is MetricKey => METRICS.some((m) => m.key === k);

const farmIcon = L.divIcon({
  className: "",
  html: '<div class="farm-pin">🏠</div>',
  iconSize: [36, 36],
  iconAnchor: [18, 18],
});

/* ---------- helpers ---------- */

export function centroid(points: LatLng[]): LatLng {
  const n = points.length;
  return [
    points.reduce((s, p) => s + p[0], 0) / n,
    points.reduce((s, p) => s + p[1], 0) / n,
  ];
}

// Placeholder rule: replace with real logic / your model's output later.
function getAdvice(data: DayData[], index: number): Advice {
  const recent = data.slice(Math.max(0, index - 13), index + 1);
  const total = recent.reduce((sum, d) => sum + (d.precipitation ?? 0), 0);
  if (total < 10) return { level: "warn", text: `Only ${total.toFixed(1)} mm in the last 14 days. Consider irrigating.` };
  return { level: "ok", text: `${total.toFixed(1)} mm in the last 14 days.` };
}

// Area of the outlined field in hectares. Points are flattened to metres around the shape's centre,
// then the shoelace formula is applied (accurate to well under 1% for field-sized shapes).
function polygonAreaHa(points: LatLng[]): number {
  if (points.length < 3) return 0;
  const R = 6371008.8; // mean Earth radius, metres
  const rad = (d: number) => (d * Math.PI) / 180;
  const [lat0, lng0] = centroid(points);
  const xy = points.map(([lat, lng]) => [
    R * rad(lng - lng0) * Math.cos(rad(lat0)),
    R * rad(lat - lat0),
  ]);
  let sum = 0;
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i];
    const [x2, y2] = xy[(i + 1) % xy.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2 / 10000;
}

// Dashboard helpers --------------------------------------------------------------

// Placeholder rule: pick the weather picture from the day's rainfall (mm). Tune the numbers later.
function weatherFor(precip: number | null | undefined): { src: string; label: string } {
  if (precip != null && precip >= 5) return { src: weatherRainy, label: "Rainy" };
  if (precip != null && precip >= 1) return { src: weatherCloudy, label: "Cloudy" };
  return { src: weatherSunny, label: "Sunny" };
}

// "2026-04-01" -> { line1: "APRIL 01,", line2: "2026" } (shown on two lines, like the design)
function dashboardDate(iso: string | null): { line1: string; line2: string } {
  const d = iso ? new Date(`${iso}T00:00:00`) : new Date();
  const safe = Number.isNaN(d.getTime()) ? new Date() : d;
  const month = safe.toLocaleDateString("en-US", { month: "long" }).toUpperCase();
  const day = String(safe.getDate()).padStart(2, "0");
  return { line1: `${month} ${day},`, line2: String(safe.getFullYear()) };
}

// Big value + optional smaller unit for the three dashboard readings.
function formatReading(key: MetricKey, v: number | null | undefined): { value: string; unit: string } {
  if (v == null) return { value: "--", unit: "" };
  if (key === "temperature") return { value: String(Math.round(v)), unit: "°C" };
  // Soil moisture: a 0-1 fraction is shown as a percentage. Change this if your file uses another unit.
  if (key === "soilMoisture") return v <= 1 ? { value: String(Math.round(v * 100)), unit: "%" } : { value: String(Math.round(v)), unit: "" };
  return { value: v.toFixed(1), unit: " mm" };
}

/* ---------- plain-language status: Good / Watch / Alert ---------- */

type Level = "good" | "watch" | "alert" | "none";
interface Status {
  level: Level;
  label: string; // shown in the coloured pill
  text: string; // the one-line meaning
}
const LEVEL_LABEL: Record<Level, string> = { good: "Good", watch: "Watch", alert: "Alert", none: "No data" };
const mk = (level: Level, text: string): Status => ({ level, label: LEVEL_LABEL[level], text });
const pendingStatus = (label: string): Status => ({ level: "none", label, text: "" });

const MIN_HISTORY = 10; // readings needed before a reading is compared with the area's history
const sentenceCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();
const monthName = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleString("en-US", { month: "long" });
const fractionBelow = (values: number[], v: number) => values.filter((x) => x < v).length / values.length;

// What this area normally looks like. Same month in other years when there are at least 2 years of data
// ("...for July"), otherwise the whole record we have ("...for this area").
function baseline(data: DayData[], key: MetricKey, date: string): { values: number[]; where: string } | null {
  const others = data.filter((d) => d.date !== date && d[key] != null);
  const month = date.slice(5, 7);
  const sameMonth = others.filter((d) => d.date.slice(5, 7) === month);
  const years = new Set(sameMonth.map((d) => d.date.slice(0, 4)));
  if (years.size >= 2 && sameMonth.length >= MIN_HISTORY) {
    return { values: sameMonth.map((d) => d[key] as number), where: `for ${monthName(date)}` };
  }
  if (others.length >= MIN_HISTORY) return { values: others.map((d) => d[key] as number), where: "for this area" };
  return null;
}

// Compares one reading with the area's own history. The limits below are PLACEHOLDERS:
// check and change them with a local agronomist.
function interpret(
  key: MetricKey,
  data: DayData[] | null,
  date: string | null,
  v: number | null | undefined,
  monthly: boolean,
): Status {
  if (v == null) return mk("none", "No reading for this day.");
  if (!data || !date) return mk("none", "Waiting for this farm's history.");
  const base = baseline(data, key, date);
  const rank = base ? fractionBelow(base.values, v) : null; // 0 = lowest ever seen, 1 = highest
  const where = base ? base.where : "for this area";

  if (key === "temperature") {
    if (v >= 35) return mk("alert", "Very hot. Heat can stress rice, especially when it flowers.");
    if (rank !== null && rank >= 0.9) return mk("watch", `Hotter than usual ${where}.`);
    if (v >= 33) return mk("watch", "Hot. Watch the crop for heat stress.");
    if (rank !== null && rank <= 0.1) return mk("watch", `Cooler than usual ${where}.`);
    return mk("good", rank !== null ? `Normal temperature ${where}.` : "No unusual heat.");
  }

  if (key === "precipitation") {
    const i = data.findIndex((d) => d.date === date);
    const recent = !monthly && i >= 0 ? data.slice(Math.max(0, i - 13), i + 1) : [];
    const total = recent.reduce((sum, d) => sum + (d.precipitation ?? 0), 0);
    const haveTwoWeeks = recent.length >= 10;
    if (v >= 50) return mk("alert", "Very heavy rain. Fields may flood.");
    if (haveTwoWeeks && total < 5) return mk("alert", `Very little rain: ${total.toFixed(1)} mm in 14 days. Crops may need water.`);
    if (v >= 25) return mk("watch", "Heavy rain. Check that fields can drain.");
    if (rank !== null && rank >= 0.9 && v >= 10) return mk("watch", `Heavier rain than usual ${where}.`);
    if (haveTwoWeeks && total < 10) return mk("watch", `Dry spell: ${total.toFixed(1)} mm in the last 14 days.`);
    return mk("good", rank !== null ? `Rain is normal ${where}.` : "No unusual rain.");
  }

  // soil moisture
  const pct = v <= 1 ? v * 100 : v;
  if (rank === null) return pct < 15 ? mk("watch", "The soil looks dry.") : mk("none", "Not enough history yet to compare.");
  if (rank <= 0.1) return mk("alert", `Much drier than usual ${where}. Crops may need water.`);
  if (rank <= 0.25) return mk("watch", `Drier than usual ${where}.`);
  if (rank >= 0.95) return mk("watch", `Much wetter than usual ${where}. Fields may be waterlogged.`);
  return mk("good", `Soil moisture is normal ${where}.`);
}

/* ---------- friendly loading and error messages ---------- */

// Turns a technical error into a short message a farmer can act on.
function friendlyError(raw: string | null | undefined): string {
  const m = (raw ?? "").toLowerCase();
  if (m.includes("heat map")) return "The map layer for this day couldn't be loaded.";
  if (!m || m.includes("failed to fetch") || m.includes("networkerror") || m.includes("load failed") || m.includes("econnrefused") || /\b(502|503|504)\b/.test(m)) {
    return "We can't reach the data service right now. Check your internet connection and try again.";
  }
  return "Something went wrong while loading the data. Please try again.";
}

// "just now", "5 min ago", "3 h ago", or the date for anything older.
function agoText(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// A short message with a Try again button, and when the numbers were last loaded (if they ever were).
function DataNotice({ message, onRetry, loadedAt }: { message: string; onRetry?: () => void; loadedAt?: number | null }) {
  return (
    <div className="data-notice" role="alert">
      <div className="data-notice-text">
        <b>{message}</b>
        {loadedAt != null && <span>Last updated {agoText(loadedAt)}.</span>}
      </div>
      {onRetry && (
        <button className="data-notice-retry" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

function LoadingNote({ text }: { text: string }) {
  return (
    <p className="data-loading" role="status">
      <span className="spinner" aria-hidden="true" />
      {text}
    </p>
  );
}

// ---- water check -------------------------------------------------------------------
// Looks at the standard OpenStreetMap map tiles under the outline. Water (ocean, lakes, wide rivers) is
// painted in one exact colour there, so counting those pixels inside the shape tells us how much of it
// is water. Returns the water share (0 to 1), or null if the tiles could not be read (offline, blocked).

const TILE = 256;
const OSM_WATER = [170, 211, 223]; // #aad3df
const WATER_TOLERANCE = 18;

function worldPx(lat: number, lng: number, z: number): [number, number] {
  const n = TILE * 2 ** z;
  const sin = Math.sin((lat * Math.PI) / 180);
  return [((lng + 180) / 360) * n, (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * n];
}

function pointInPolygon(lat: number, lng: number, pts: LatLng[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [yi, xi] = pts[i];
    const [yj, xj] = pts[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function loadTile(z: number, x: number, y: number): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous"; // needed so the pixels can be read back
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("tile failed"));
    img.src = `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
  });
}

async function waterShare(points: LatLng[]): Promise<number | null> {
  try {
    const lats = points.map((p) => p[0]);
    const lngs = points.map((p) => p[1]);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);

    // Most detailed zoom at which the shape still fits in at most 2 x 2 tiles.
    let z = 16;
    for (; z > 3; z--) {
      const a = worldPx(maxLat, minLng, z);
      const b = worldPx(minLat, maxLng, z);
      if (Math.floor(b[0] / TILE) - Math.floor(a[0] / TILE) <= 1 && Math.floor(b[1] / TILE) - Math.floor(a[1] / TILE) <= 1) break;
    }
    const tl = worldPx(maxLat, minLng, z);
    const br = worldPx(minLat, maxLng, z);
    const tx0 = Math.floor(tl[0] / TILE);
    const ty0 = Math.floor(tl[1] / TILE);
    const tx1 = Math.floor(br[0] / TILE);
    const ty1 = Math.floor(br[1] / TILE);

    const canvas = document.createElement("canvas");
    canvas.width = (tx1 - tx0 + 1) * TILE;
    canvas.height = (ty1 - ty0 + 1) * TILE;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;

    const jobs: Promise<void>[] = [];
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) {
        jobs.push(loadTile(z, tx, ty).then((img) => ctx.drawImage(img, (tx - tx0) * TILE, (ty - ty0) * TILE)));
      }
    }
    await Promise.all(jobs);
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);

    // Sample a grid of spots inside the outline (plus its corners if it is very thin).
    const samples: LatLng[] = [];
    const N = 24;
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const lat = minLat + ((i + 0.5) / N) * (maxLat - minLat);
        const lng = minLng + ((j + 0.5) / N) * (maxLng - minLng);
        if (pointInPolygon(lat, lng, points)) samples.push([lat, lng]);
      }
    }
    if (samples.length < 10) samples.push(...points);

    let water = 0;
    for (const [lat, lng] of samples) {
      const [px, py] = worldPx(lat, lng, z);
      const x = Math.min(width - 1, Math.max(0, Math.floor(px - tx0 * TILE)));
      const y = Math.min(height - 1, Math.max(0, Math.floor(py - ty0 * TILE)));
      const k = (y * width + x) * 4;
      const diff = Math.abs(data[k] - OSM_WATER[0]) + Math.abs(data[k + 1] - OSM_WATER[1]) + Math.abs(data[k + 2] - OSM_WATER[2]);
      if (diff <= WATER_TOLERANCE) water++;
    }
    return water / samples.length;
  } catch {
    return null; // could not check: let the outline through rather than block the farmer
  }
}

async function reverseGeocode(lat: number, lng: number, signal: AbortSignal): Promise<string> {
  const fallback = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  try {
    const url =
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=16` +
      `&accept-language=en&lat=${lat}&lon=${lng}`;
    const res = await fetch(url, { signal });
    if (!res.ok) return fallback;
    const json = await res.json();
    const a = json.address ?? {};
    const parts = [
      a.suburb || a.village || a.neighbourhood || a.hamlet,
      a.city || a.town || a.municipality,
      a.state || a.province || a.region,
    ].filter(Boolean);
    return parts.length ? parts.join(", ") : json.display_name ?? fallback;
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    return fallback;
  }
}

/* ---------- place search ---------- */

interface PlaceHit {
  name: string; // the place itself, e.g. "Alaminos"
  detail: string; // where it is, e.g. "Pangasinan, Ilocos Region, Philippines"
  lat: number;
  lng: number;
  km: number; // distance from the middle of the map when the search was made
  bbox?: [number, number, number, number]; // south, west, north, east
}

function distanceKm(a: LatLng, b: LatLng): number {
  const R = 6371.0088;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function formatDistance(km: number): string {
  if (km < 1) return `${Math.max(10, Math.round((km * 1000) / 10) * 10)} m`;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km).toLocaleString("en-US")} km`;
}

// Looks a place name up on OpenStreetMap's Nominatim (the same service used for reverse geocoding above).
// Results near the map's view are favoured, and the list is sorted nearest first from the camera's centre.
async function searchPlaces(q: string, map: L.Map | null, signal: AbortSignal): Promise<PlaceHit[]> {
  const center: LatLng = map ? [map.getCenter().lat, map.getCenter().lng] : START_CENTER;
  let url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=10&accept-language=en&q=${encodeURIComponent(q)}`;
  if (map) {
    const b = map.getBounds().pad(1);
    const clampLng = (x: number) => Math.max(-180, Math.min(180, x));
    const clampLat = (x: number) => Math.max(-90, Math.min(90, x));
    // viewbox = left,top,right,bottom. It only nudges the ranking (no "bounded=1"), so far-away places still appear.
    url += `&viewbox=${clampLng(b.getWest())},${clampLat(b.getNorth())},${clampLng(b.getEast())},${clampLat(b.getSouth())}`;
  }
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  const json = (await res.json()) as { display_name: string; lat: string; lon: string; boundingbox?: string[] }[];
  const seen = new Set<string>();
  return json
    .map((r): PlaceHit => {
      const parts = r.display_name.split(", ");
      const bb = r.boundingbox?.map(Number);
      const lat = Number(r.lat);
      const lng = Number(r.lon);
      return {
        name: parts[0],
        detail: parts.slice(1).join(", "),
        lat,
        lng,
        km: distanceKm(center, [lat, lng]),
        bbox: bb && bb.length === 4 && bb.every(Number.isFinite) ? [bb[0], bb[2], bb[1], bb[3]] : undefined,
      };
    })
    .filter((h) => Number.isFinite(h.lat) && Number.isFinite(h.lng))
    .filter((h) => {
      const key = `${h.lat.toFixed(3)},${h.lng.toFixed(3)}`; // drop near-identical duplicates
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.km - b.km)
    .slice(0, 6);
}

// Gives FarmMap the Leaflet map, so a search can read where the camera is.
function MapHandle({ mapRef }: { mapRef: React.MutableRefObject<L.Map | null> }) {
  const map = useMap();
  mapRef.current = map;
  return null;
}

// Flies the map to a searched place whenever `target` changes.
function FlyTo({ target }: { target: { hit: PlaceHit; nonce: number } | null }) {
  const map = useMap();
  useEffect(() => {
    if (!target) return;
    const { hit } = target;
    if (hit.bbox) {
      const [s, w, n, e] = hit.bbox;
      map.flyToBounds([[s, w], [n, e]], { maxZoom: 17, duration: 1.6 });
    } else {
      map.flyTo([hit.lat, hit.lng], 15, { duration: 1.6 });
    }
  }, [target, map]);
  return null;
}

/* ---------- map layers ---------- */

// Colour bar with numbers, shown over the map while a layer is selected.
function MapLegend({ layer }: { layer: MetricKey }) {
  const s = LEGENDS[layer];
  const mid = (s.min + s.max) / 2;
  const top = `${s.max}${s.openEnd ? "+" : ""}`;
  return (
    <div
      className="map-legend"
      role="img"
      aria-label={`${s.title} colour scale, ${s.min} to ${top} ${s.unit}. ${s.low} on the left, ${s.high} on the right.`}
    >
      <div className="legend-title">
        <b>{s.title}</b>
        <span>{s.unit}</span>
        <em>
          {s.low} → {s.high}
        </em>
      </div>
      <div className="legend-bar" style={{ background: `linear-gradient(90deg, ${s.stops.join(", ")})` }} />
      <div className="legend-nums" aria-hidden="true">
        <span>{s.min}</span>
        <span>{mid}</span>
        <span>{top}</span>
      </div>
    </div>
  );
}

// Small card over the map: which day is shown, and a way to leave or open past data. The slider itself lives in the
// Dashboard (so it never covers the reading tiles). The colour scale of the selected layer sits under the date.
function MapTimeline({
  dates,
  day,
  layer,
  monthly,
  onPast,
}: {
  dates: string[];
  day: number;
  layer: MetricKey | null;
  monthly: boolean;
  onPast: (open: boolean) => void;
}) {
  const last = dates.length - 1;
  const idx = Math.min(day, last);
  const date = dates[idx];
  const behind = last - idx;
  const sub = monthly
    ? "Monthly average"
    : behind === 0
      ? "Latest data"
      : `${behind} day${behind === 1 ? "" : "s"} before the latest`;
  return (
    <div className="map-timeline" role="group" aria-label="Day shown">
      <div className="tl-head">
        <div className="tl-date tl-date-left" aria-live="polite">
          {shortDate(date)}
          <small>{sub}</small>
        </div>
        {last > 0 && (
          <button type="button" className="tl-latest" onClick={() => onPast(behind === 0)}>
            {behind === 0 ? "Past data" : "Latest"}
          </button>
        )}
      </div>
      {layer && <MapLegend layer={layer} />}
    </div>
  );
}

function DrawLayer({
  poly,
  setPolygon,
  drawing,
  busy,
  onClose,
  onFarmTap,
}: {
  poly: ThePolygon;
  setPolygon: React.Dispatch<React.SetStateAction<ThePolygon>>;
  drawing: boolean;
  busy: boolean; // the outline is being checked: ignore taps
  onClose: () => void; // the farmer asked to finish the shape
  onFarmTap?: () => void; // a tap on the finished farm shape (used when a plot has no outline of its own)
}) {
  const map = useMap();

  useMapEvents({
    click(e) {
      if (!drawing || busy) return;
      const pt: LatLng = [e.latlng.lat, e.latlng.lng];
      // Finish the shape when the tap lands near the first point (measured in screen pixels,
      // so it feels the same at every zoom level).
      if (poly.points.length >= 3) {
        const first = map.latLngToContainerPoint(poly.points[0]);
        if (first.distanceTo(e.containerPoint) <= CLOSE_PX) {
          onClose();
          return;
        }
      }
      setPolygon((prev) => ({ ...prev, points: [...prev.points, pt] }));
    },
  });

  return (
    <>
      {poly.closed ? (
        <Polygon
          positions={poly.points}
          pathOptions={{ color: "#7bd88f", weight: 3, fillColor: "#7bd88f", fillOpacity: 0.18 }}
          eventHandlers={{ click: () => onFarmTap?.() }}
        />
      ) : (
        poly.points.length >= 2 && (
          <Polyline positions={poly.points} pathOptions={{ color: "#7bd88f", weight: 3 }} />
        )
      )}

      {poly.points.map((pt, i) => (
        <CircleMarker
          key={i}
          center={pt}
          radius={i === 0 && !poly.closed ? 9 : 6}
          // bubblingMouseEvents: false = a tap on a point is not also a tap on the map underneath
          pathOptions={
            i === 0
              ? { color: "#fff", weight: 2, fillColor: "#e0773a", fillOpacity: 1, bubblingMouseEvents: false }
              : { color: "#fff", weight: 2, fillColor: "#2e9e5b", fillOpacity: 1, bubblingMouseEvents: false }
          }
          eventHandlers={{
            click: () => {
              if (!drawing || poly.closed || busy) return;
              // With 3+ points, tapping the first (orange) point finishes the shape.
              if (i === 0 && poly.points.length >= 3) {
                onClose();
                return;
              }
              // Tapping any other point deletes it.
              setPolygon((prev) => ({ ...prev, points: prev.points.filter((_, k) => k !== i) }));
            },
          }}
        />
      ))}

      {poly.closed && <Marker position={centroid(poly.points)} icon={farmIcon} interactive={false} />}
    </>
  );
}

// A plot outline being drawn inside the farm.
interface PlotDraw {
  plotId: string;
  points: LatLng[];
}
const PLOT_COLORS = ["#ffd54a", "#4fc3f7", "#ff8a65", "#ba68c8", "#a5d6a7", "#f06292"];
const formatHa = (ha: number) => (ha < 0.1 ? ha.toFixed(3) : ha.toFixed(2));

// The saved plot outlines, drawn on top of the farm with their names.
function PlotsLayer({
  plots,
  hideId,
  selectedId,
  onSelect,
}: {
  plots: Plot[];
  hideId: string | null;
  selectedId: string | null;
  onSelect: (plotId: string) => void;
}) {
  return (
    <>
      {plots.map((p, i) =>
        p.points && p.points.length >= 3 && p.id !== hideId ? (
          <Polygon
            key={p.id}
            positions={p.points}
            pathOptions={{
              color: PLOT_COLORS[i % PLOT_COLORS.length],
              weight: p.id === selectedId ? 4.5 : 2.5,
              fillColor: PLOT_COLORS[i % PLOT_COLORS.length],
              fillOpacity: p.id === selectedId ? 0.5 : 0.28,
            }}
            // A tap on a plot also reaches the map underneath, so outlining a new plot over it still works.
            eventHandlers={{ click: () => onSelect(p.id) }}
          >
            <Tooltip permanent direction="center" className="plot-label">
              {plotLabel(p, i)}
            </Tooltip>
          </Polygon>
        ) : null,
      )}
    </>
  );
}

// Tapping empty map closes the open plot card. A tap on a plot also reaches the map underneath,
// so `skip` is set by that tap and makes this handler ignore it.
function MapTapDismiss({
  active,
  skip,
  onDismiss,
}: {
  active: boolean;
  skip: React.MutableRefObject<boolean>;
  onDismiss: () => void;
}) {
  useMapEvents({
    click() {
      if (skip.current) {
        skip.current = false;
        return;
      }
      if (active) onDismiss();
    },
  });
  return null;
}

// The details of one plot, shown over the map when the farmer taps it.
function PlotCard({
  plot,
  index,
  onEdit,
  onClose,
}: {
  plot: Plot;
  index: number;
  onEdit: () => void;
  onClose: () => void;
}) {
  const rec = latestRecord(plot);
  const areaHa = plot.area && /\d/.test(plot.area) ? plot.area : plot.points ? formatHa(polygonAreaHa(plot.points)) : "";
  const s = plot.soil;
  const rows: [string, string][] = [];
  if (areaHa) rows.push(["Area", `${areaHa} ha`]);
  if (rec?.crop) rows.push(["Last crop", rec.crop]);
  if (rec?.plantingDate) rows.push(["Planted", formatDate(rec.plantingDate) ?? rec.plantingDate]);
  if (rec?.harvestDate) rows.push(["Harvested", formatDate(rec.harvestDate) ?? rec.harvestDate]);
  if (rec && amountText(rec)) rows.push(["Harvest", amountText(rec)!]);
  if (rec?.performance) rows.push(["Performance", PERFORMANCE_LABEL[rec.performance]]);
  if (s.texture) rows.push(["Soil texture", s.texture]);
  if (s.moisture !== null)
    rows.push([
      "Soil moisture",
      `${s.moisture}% VWC${s.depth ? ` at ${s.depth} cm` : ""}${s.source ? ` (${SOURCE_LABEL[s.source]})` : ""}`,
    ]);
  if (s.soilTest !== null) rows.push(["Soil test results", s.soilTest ? "Yes" : "No"]);
  return (
    <div className="plot-card" role="dialog" aria-label={`${plotLabel(plot, index)} details`}>
      <div className="plot-card-head">
        <h3>
          <i style={{ background: PLOT_COLORS[index % PLOT_COLORS.length] }} aria-hidden="true" />
          {plotLabel(plot, index)}
        </h3>
        <button type="button" aria-label="Close plot details" onClick={onClose}>
          ×
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="hint">No details entered for this plot yet.</p>
      ) : (
        <div className="plot-card-rows">
          {rows.map(([label, value]) => (
            <div className="row" key={label}>
              <span>{label}</span>
              <b>{value}</b>
            </div>
          ))}
        </div>
      )}
      <button type="button" className="plot-card-edit" onClick={onEdit}>
        Edit this plot
      </button>
    </div>
  );
}

// Lets the farmer outline one plot by tapping inside the farm. Same tap rules as the farm outline.
function PlotDrawLayer({
  farm,
  draw,
  setDraw,
  onFinish,
  onReject,
}: {
  farm: LatLng[];
  draw: PlotDraw | null;
  setDraw: React.Dispatch<React.SetStateAction<PlotDraw | null>>;
  onFinish: (points: LatLng[]) => void;
  onReject: (message: string) => void;
}) {
  const map = useMap();
  const outside = "Keep every corner of the plot inside your farm outline.";

  function finish(points: LatLng[]) {
    const [clat, clng] = centroid(points);
    if (!pointInPolygon(clat, clng, farm)) {
      onReject(outside);
      return;
    }
    onFinish(points);
  }

  useMapEvents({
    click(e) {
      if (!draw) return;
      const pt: LatLng = [e.latlng.lat, e.latlng.lng];
      if (draw.points.length >= 3) {
        const first = map.latLngToContainerPoint(draw.points[0]);
        if (first.distanceTo(e.containerPoint) <= CLOSE_PX) {
          finish(draw.points);
          return;
        }
      }
      if (!pointInPolygon(pt[0], pt[1], farm)) {
        onReject(outside);
        return;
      }
      setDraw((prev) => (prev ? { ...prev, points: [...prev.points, pt] } : prev));
    },
  });

  if (!draw) return null;
  return (
    <>
      {draw.points.length >= 3 ? (
        <Polygon
          positions={draw.points}
          pathOptions={{ color: "#ffd54a", weight: 3, fillColor: "#ffd54a", fillOpacity: 0.2, interactive: false }}
        />
      ) : (
        draw.points.length >= 2 && (
          <Polyline positions={draw.points} pathOptions={{ color: "#ffd54a", weight: 3, interactive: false }} />
        )
      )}
      {draw.points.map((pt, i) => (
        <CircleMarker
          key={i}
          center={pt}
          radius={i === 0 ? 9 : 6}
          pathOptions={
            i === 0
              ? { color: "#fff", weight: 2, fillColor: "#e0773a", fillOpacity: 1, bubblingMouseEvents: false }
              : { color: "#fff", weight: 2, fillColor: "#ffd54a", fillOpacity: 1, bubblingMouseEvents: false }
          }
          eventHandlers={{
            click: () => {
              if (i === 0 && draw.points.length >= 3) {
                finish(draw.points);
                return;
              }
              setDraw((prev) => (prev ? { ...prev, points: prev.points.filter((_, k) => k !== i) } : prev));
            },
          }}
        />
      ))}
    </>
  );
}

// One dot per grid point for the selected day and layer (plain dots for now; shading comes next).
function GridLayer({ points, color, unit }: { points: GridPoint[]; color: string; unit: string }) {
  return (
    <>
      {points.map((p) => (
        <CircleMarker
          key={`${p.lat},${p.lon}`}
          center={[p.lat, p.lon]}
          radius={4}
          pathOptions={{ color, weight: 1, fillOpacity: 0.4 }}
        >
          <Tooltip>{p.value === null ? "no data" : `${p.value}${unit}`}</Tooltip>
        </CircleMarker>
      ))}
    </>
  );
}

// Zooms the map to the chosen farm whenever `nonce` changes (not on first load).
function FitFarm({ points, nonce }: { points: LatLng[] | null; nonce: number }) {
  const map = useMap();
  useEffect(() => {
    if (nonce === 0 || !points) return;
    // Same rule as the landscape-phone block in styles.css: the sheet becomes a panel on the left.
    const panel = window.matchMedia("(orientation: landscape) and (max-height: 600px) and (max-width: 999px)").matches;
    map.fitBounds(L.latLngBounds(points), {
      paddingTopLeft: panel ? [Math.min(window.innerWidth * 0.48, 440) + 40, 80] : [40, 100],
      paddingBottomRight: panel ? [40, 40] : [40, Math.round(window.innerHeight * 0.5)],
      maxZoom: 17,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);
  return null;
}

// A small, non-interactive satellite picture of one farm (used on the My Farms screen).
function FarmThumb({ points }: { points: LatLng[] }) {
  return (
    <div className="farm-thumb">
      <MapContainer
        bounds={L.latLngBounds(points)}
        boundsOptions={{ padding: [30, 30], maxZoom: 17 }}
        maxZoom={19}
        zoomControl={false}
        attributionControl={false}
        dragging={false}
        touchZoom={false}
        doubleClickZoom={false}
        scrollWheelZoom={false}
        boxZoom={false}
        keyboard={false}
        className="thumb-map"
      >
        <TileLayer
          url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
          maxNativeZoom={18}
          maxZoom={19}
        />
        <Polygon
          positions={points}
          pathOptions={{ color: "#7bd88f", weight: 2, fillColor: "#7bd88f", fillOpacity: 0.15 }}
        />
        <Marker position={centroid(points)} icon={farmIcon} interactive={false} />
      </MapContainer>
    </div>
  );
}

/* ---------- small chart ---------- */

function Chart({
  data,
  field,
  index,
  color,
}: {
  data: DayData[];
  field: MetricKey;
  index: number;
  color: string;
}) {
  const vals = data.map((d) => d[field]);
  const valid = vals.filter((v): v is number => v !== null);
  if (valid.length === 0) return <p className="hint">No data</p>;

  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const x = (i: number) => (i / (data.length - 1 || 1)) * 220;
  const y = (v: number) => 50 - ((v - min) / (max - min || 1)) * 46 - 2;

  // Break the line at missing days instead of drawing across them
  let path = "";
  let gap = true;
  vals.forEach((v, i) => {
    if (v === null) { gap = true; return; }
    path += `${gap ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
    gap = false;
  });

  const selected = vals[index];
  return (
    <svg viewBox="0 0 220 52" className="chart">
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" />
      {selected !== null && <circle cx={x(index)} cy={y(selected)} r="4" fill={color} />}
    </svg>
  );
}

/* ---------- Farm details (the visual summary shown in the Condition view) ---------- */

const CROP_EMOJI: Record<string, string> = {
  Rice: "🌾",
  Corn: "🌽",
  Onion: "🧅",
  Garlic: "🧄",
  "Mung beans": "🫘",
  Vegetables: "🥬",
};
const PERF_LEVEL: Record<Performance, { level: number; color: string }> = {
  good: { level: 4, color: "#2e9e5b" },
  average: { level: 3, color: "#c9a824" },
  poor: { level: 2, color: "#e0773a" },
  failure: { level: 1, color: "#c0392b" },
  unknown: { level: 0, color: "#9aa39a" },
};
const WATER_STEPS: { value: Water; label: string; icon: string }[] = [
  { value: "rainfed", label: "Rain-fed", icon: "🌧️" },
  { value: "both", label: "Both", icon: "🌦️" },
  { value: "irrigation", label: "Irrigation", icon: "💧" },
];

const plotAreaHa = (p: Plot): number => {
  const typed = parseFloat(p.area);
  if (Number.isFinite(typed) && typed > 0) return typed;
  return p.points && p.points.length >= 3 ? polygonAreaHa(p.points) : 0;
};

// Ring chart: how the farm is split between its plots.
function PlotDonut({ slices, totalHa }: { slices: { color: string; ha: number }[]; totalHa: number }) {
  const R = 40;
  const C = 2 * Math.PI * R;
  const sum = slices.reduce((s, x) => s + x.ha, 0) || 1;
  let offset = 0;
  return (
    <svg viewBox="0 0 100 100" className="fd-donut" role="img" aria-label="Share of the farm taken by each plot">
      <circle cx="50" cy="50" r={R} fill="none" stroke="#e3e9d2" strokeWidth="14" />
      <g transform="rotate(-90 50 50)">
        {slices.map((s, i) => {
          const len = (s.ha / sum) * C;
          const el = (
            <circle
              key={i}
              cx="50"
              cy="50"
              r={R}
              fill="none"
              stroke={s.color}
              strokeWidth="14"
              strokeDasharray={`${Math.max(0, len - 1.5)} ${C}`}
              strokeDashoffset={-offset}
            />
          );
          offset += len;
          return el;
        })}
      </g>
      <text x="50" y="49" textAnchor="middle" className="fd-donut-num">
        {formatHa(totalHa)}
      </text>
      <text x="50" y="62" textAnchor="middle" className="fd-donut-unit">
        hectares
      </text>
    </svg>
  );
}

function FarmSummary({
  farm,
  place,
  onEdit,
  onDelete,
}: {
  farm: Farm;
  place: string | null;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const plots = normalizePlots(farm);
  const sizeHa = polygonAreaHa(farm.points);
  const location = (farm.location || place || "").trim();
  const water = farm.details?.water ?? null;
  const areas = plots.map(plotAreaHa);
  const plotted = areas.reduce((s, a) => s + a, 0);
  const slices = plots.map((_, i) => ({ color: PLOT_COLORS[i % PLOT_COLORS.length], ha: areas[i] })).filter((s) => s.ha > 0);
  // Part of the farm not given to any plot (shown grey), when the plots add up to less than the farm.
  const spare = sizeHa - plotted;
  if (slices.length > 0 && spare > sizeHa * 0.03) slices.push({ color: "#cdd5bb", ha: spare });
  const donutTotal = slices.length > 0 ? Math.max(sizeHa, plotted) : sizeHa;

  return (
    <div className="fd">
      <div className="fd-hero">
        <FarmThumb points={farm.points} />
        <div className="fd-hero-text">
          <div className="fd-title-row">
            <h3>{farm.name}</h3>
            <button type="button" className="fd-edit" onClick={onEdit}>
              Edit
            </button>
          </div>
          <p className="fd-loc">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z" />
              <circle cx="12" cy="9.5" r="2.4" />
            </svg>
            {location || "Locating…"}
          </p>
        </div>
      </div>

      <div className="fd-stats">
        <div className="fd-stat">
          <b>{formatHa(sizeHa)}</b>
          <small>hectares</small>
          <span>{Math.round(sizeHa * 10000).toLocaleString("en-US")} m²</span>
        </div>
        <div className="fd-stat">
          <b>{plots.length}</b>
          <small>{plots.length === 1 ? "plot" : "plots"}</small>
          <span>{plots.reduce((n, p) => n + p.cropRecords.filter((r) => !recordBlank(r)).length, 0)} crop records</span>
        </div>
        <div className="fd-stat">
          <b className="fd-stat-icon" aria-hidden="true">
            {water ? WATER_STEPS.find((w) => w.value === water)?.icon : "–"}
          </b>
          <small>water</small>
          <span>{water ? WATER_STEPS.find((w) => w.value === water)?.label : "Not provided"}</span>
        </div>
      </div>

      <section className="fd-card" aria-label="Water availability">
        <h4>Water availability</h4>
        <div className="fd-water" role="img" aria-label={water ? `Water: ${WATER_STEPS.find((w) => w.value === water)?.label}` : "Water not provided"}>
          {WATER_STEPS.map((w) => (
            <div key={w.value} className={`fd-water-step ${water === w.value ? "on" : ""}`}>
              <span aria-hidden="true">{w.icon}</span>
              {w.label}
            </div>
          ))}
        </div>
      </section>

      {slices.length > 0 && (
        <section className="fd-card" aria-label="Land use">
          <h4>How your land is split</h4>
          <div className="fd-split">
            <PlotDonut slices={slices} totalHa={donutTotal} />
            <ul className="fd-legend">
              {plots.map((p, i) =>
                areas[i] > 0 ? (
                  <li key={p.id}>
                    <i style={{ background: PLOT_COLORS[i % PLOT_COLORS.length] }} aria-hidden="true" />
                    <span>{plotLabel(p, i)}</span>
                    <b>{formatHa(areas[i])} ha</b>
                  </li>
                ) : null,
              )}
              {slices.length > plots.filter((_, i) => areas[i] > 0).length && (
                <li>
                  <i style={{ background: "#cdd5bb" }} aria-hidden="true" />
                  <span>Not in a plot</span>
                  <b>{formatHa(spare)} ha</b>
                </li>
              )}
            </ul>
          </div>
        </section>
      )}

      <h4 className="fd-heading">Your plots</h4>
      {plots.map((p, i) => {
        const rec = latestRecord(p);
        const color = PLOT_COLORS[i % PLOT_COLORS.length];
        const perf = rec?.performance ? PERF_LEVEL[rec.performance] : null;
        const days =
          rec?.plantingDate && rec.harvestDate
            ? Math.round((new Date(`${rec.harvestDate}T00:00:00`).getTime() - new Date(`${rec.plantingDate}T00:00:00`).getTime()) / 86400000)
            : null;
        const share = sizeHa > 0 && areas[i] > 0 ? Math.min(100, (areas[i] / sizeHa) * 100) : null;
        const records = p.cropRecords.filter((r) => !recordBlank(r)).length;
        return (
          <article className="fd-plot" key={p.id} style={{ "--plot": color } as React.CSSProperties}>
            <header>
              <h5>
                <i aria-hidden="true" />
                {plotLabel(p, i)}
              </h5>
              <span className="fd-plot-area">{areas[i] > 0 ? `${formatHa(areas[i])} ha` : "Area not given"}</span>
            </header>
            {share !== null && (
              <div className="fd-share" title={`${share.toFixed(0)}% of the farm`}>
                <div style={{ width: `${share}%` }} />
              </div>
            )}
            {rec ? (
              <>
                <div className="fd-crop">
                  <span className="fd-crop-emoji" aria-hidden="true">
                    {CROP_EMOJI[rec.crop] ?? "🌱"}
                  </span>
                  <div>
                    <b>{rec.crop || "Crop not given"}</b>
                    <small>Last crop{records > 1 ? ` · ${records} records` : ""}</small>
                  </div>
                  <div className="fd-harvest">
                    <b>{amountText(rec) ?? "–"}</b>
                    <small>harvested</small>
                  </div>
                </div>
                {(rec.plantingDate || rec.harvestDate) && (
                  <div className="fd-timeline">
                    <div className="fd-tl-dates">
                      <span>
                        <small>Planted</small>
                        {rec.plantingDate ? shortDate(rec.plantingDate) : "–"}
                      </span>
                      {days !== null && days >= 0 && <em>{days} days</em>}
                      <span>
                        <small>Harvested</small>
                        {rec.harvestDate ? shortDate(rec.harvestDate) : "–"}
                      </span>
                    </div>
                    <div className="fd-tl-track" aria-hidden="true">
                      <i />
                      <b />
                      <i />
                    </div>
                  </div>
                )}
                {rec.performance && perf && (
                  <div className="fd-perf">
                    <span>{PERFORMANCE_LABEL[rec.performance]}</span>
                    <div className="fd-meter" aria-hidden="true">
                      {[1, 2, 3, 4].map((n) => (
                        <i key={n} style={n <= perf.level ? { background: perf.color } : undefined} />
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <p className="fd-empty">No crop records yet.</p>
            )}
          </article>
        );
      })}

      <section className="fd-card" aria-label="Harvest by season">
        <h4>Harvest by season</h4>
        <YieldChart farm={farm} />
      </section>

      <button type="button" className="farm-delete-btn" onClick={onDelete}>
        Delete this farm
      </button>
    </div>
  );
}

/* ---------- Dashboard extras: yield chart, commodities, farm carousel ---------- */

const SEASONS = [
  { label: "Winter", color: "#737a33" },
  { label: "Spring", color: "#c1c682" },
  { label: "Summer", color: "#cfba4a" },
  { label: "Fall", color: "#ffcc00" },
];
// Shown until the farmer records a harvest (with a date) on the Set up farm screen.
const SAMPLE_YIELD = [60, 44, 78, 30];
const TONS_PER_UNIT: Record<YieldUnit, number> = { tons: 1, kg: 0.001, cavans: 0.05 };

// December-February = Winter, March-May = Spring, June-August = Summer, September-November = Fall.
function seasonOf(iso: string): number | null {
  const month = Number(iso.slice(5, 7));
  if (!(month >= 1 && month <= 12)) return null;
  return month === 12 || month <= 2 ? 0 : month <= 5 ? 1 : month <= 8 ? 2 : 3;
}

// One value per season, in tons. Real data comes from the farm's recorded harvest; otherwise sample bars.
function yieldSeries(farm: Farm): { values: number[]; sample: boolean; note: string } {
  // Crop records from every plot that have both an amount and a harvest date.
  const records = (farm.plots ?? []).flatMap((p) => p.cropRecords).filter((r) => {
    const n = parseFloat(r.amount);
    return Number.isFinite(n) && n > 0 && seasonOf(r.harvestDate) !== null;
  });
  if (records.length > 0) {
    const dates = records.map((r) => r.harvestDate).sort();
    const latest = dates[dates.length - 1];
    const cutoff = new Date(`${latest}T00:00:00`).getTime() - 365 * 24 * 3600 * 1000;
    const values = [0, 0, 0, 0];
    records.forEach((r) => {
      if (new Date(`${r.harvestDate}T00:00:00`).getTime() < cutoff) return;
      values[seasonOf(r.harvestDate)!] += parseFloat(r.amount) * TONS_PER_UNIT[r.unit];
    });
    return {
      values: values.map((v) => Math.round(v * 100) / 100),
      sample: false,
      note: `Harvests in the year up to ${formatDate(latest) ?? latest}, all plots. Tons.`,
    };
  }
  const d = farm.details;
  const amount = d ? parseFloat(d.lastHarvestYield) : NaN;
  const season = d?.harvestDate ? seasonOf(d.harvestDate) : null;
  if (d && Number.isFinite(amount) && amount > 0 && season !== null) {
    const values = [0, 0, 0, 0];
    values[season] = Math.round(amount * TONS_PER_UNIT[d.yieldUnit] * 100) / 100;
    return { values, sample: false, note: `Latest harvest, ${formatDate(d.harvestDate) ?? d.harvestDate}. Tons.` };
  }
  return {
    values: SAMPLE_YIELD,
    sample: true,
    note: "Sample data. Add a crop record with a harvest amount and date when you set up the farm to see your own.",
  };
}

// Round the top of the axis up to a tidy number so there are always four even steps.
function niceAxis(maxValue: number): { max: number; ticks: number[] } {
  const raw = Math.max(maxValue, 0.0001) / 4;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((v) => v >= raw) ?? 10 * pow;
  return { max: step * 4, ticks: [0, 1, 2, 3, 4].map((i) => Math.round(step * i * 1000) / 1000) };
}

function YieldChart({ farm }: { farm: Farm }) {
  const { values, sample, note } = yieldSeries(farm);
  const { max, ticks } = niceAxis(Math.max(...values));
  const summary = SEASONS.map((s, i) => `${s.label} ${values[i]} tons`).join(", ");
  return (
    <>
      <div className="yield-chart" role="img" aria-label={`Yield in tons. ${summary}${sample ? ". Sample data" : ""}`}>
        <div className="yield-axis" aria-hidden="true">
          {ticks.map((t) => (
            <span key={t} style={{ bottom: `${(t / max) * 100}%` }}>
              {t}
            </span>
          ))}
        </div>
        <div className="yield-plot" aria-hidden="true">
          {ticks.map((t) => (
            <i key={t} className="yield-grid" style={{ bottom: `${(t / max) * 100}%` }} />
          ))}
          <div className="yield-bars">
            {SEASONS.map((s, i) => (
              <div key={s.label} className="yield-bar" style={{ height: `${(values[i] / max) * 100}%`, background: s.color }} />
            ))}
          </div>
        </div>
        <div className="yield-xlabels" aria-hidden="true">
          {SEASONS.map((s) => (
            <span key={s.label}>{s.label}</span>
          ))}
        </div>
      </div>
      <p className="yield-note">{note}</p>
    </>
  );
}

// Optional photos for the Commodities row: src/assets/commodity_rice, commodity_onion, commodity_garlic,
// commodity_mung_beans (.png/.jpg/.webp). Without a file the tile shows an emoji instead.
const commodityFiles = import.meta.glob(
  "./assets/{commodity_rice,commodity_onion,commodity_garlic,commodity_mung_beans}.*",
  { eager: true, query: "?url", import: "default" },
) as Record<string, string>;
const COMMODITIES = [
  { key: "rice", label: "Rice", emoji: "🌾" },
  { key: "onion", label: "Onion", emoji: "🧅" },
  { key: "garlic", label: "Garlic", emoji: "🧄" },
  { key: "mung_beans", label: "Mung beans", emoji: "🫘" },
].map((c) => {
  const path = Object.keys(commodityFiles).find((p) => p.startsWith(`./assets/commodity_${c.key}.`));
  return { ...c, src: path ? commodityFiles[path] : "" };
});

// Swipeable row of the saved farms, with an arrow and page dots when there are more than fit.
function FarmCarousel({
  farms,
  activeId,
  onSelect,
  onAdd,
}: {
  farms: Farm[];
  activeId: string | null;
  onSelect: (f: Farm) => void;
  onAdd: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [more, setMore] = useState(false);

  function measure() {
    const el = ref.current;
    if (!el) return;
    const room = el.scrollWidth - el.clientWidth;
    const count = room > 4 ? Math.ceil(el.scrollWidth / el.clientWidth) : 1;
    setPages(count);
    setPage(room > 4 ? Math.round((el.scrollLeft / room) * (count - 1)) : 0);
    setMore(el.scrollLeft < room - 4);
  }

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [farms.length]);

  const behavior: ScrollBehavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  function scrollToPage(i: number) {
    const el = ref.current;
    if (!el) return;
    const room = el.scrollWidth - el.clientWidth;
    el.scrollTo({ left: pages > 1 ? (room * i) / (pages - 1) : 0, behavior });
  }

  if (farms.length === 0)
    return (
      <div className="carousel">
        <button className="farm-card carousel-card add-farm-card" onClick={onAdd}>
          <span className="add-farm-plus" aria-hidden="true">+</span>
          <span className="farm-card-name">Add a new farm</span>
        </button>
      </div>
    );

  return (
    <div className="carousel">
      <div className="carousel-wrap">
        <div className="farm-carousel" ref={ref} onScroll={measure}>
          {farms.map((f) => (
            <button
              key={f.id}
              className={`farm-card carousel-card ${f.id === activeId ? "active" : ""}`}
              onClick={() => onSelect(f)}
            >
              <FarmThumb points={f.points} />
              <span className="farm-card-name">{f.name}</span>
            </button>
          ))}
          <button className="farm-card carousel-card add-farm-card" onClick={onAdd}>
            <span className="add-farm-plus" aria-hidden="true">+</span>
            <span className="farm-card-name">Add a new farm</span>
          </button>
        </div>
        {more && (
          <button
            className="carousel-next"
            aria-label="Show more farms"
            onClick={() => ref.current?.scrollBy({ left: ref.current.clientWidth * 0.8, behavior })}
          >
            <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 4l8 8-8 8" />
            </svg>
          </button>
        )}
      </div>
      {pages > 1 && (
        <div className="carousel-dots">
          {Array.from({ length: pages }, (_, i) => (
            <button
              key={i}
              className={i === page ? "on" : ""}
              aria-label={`Farms, page ${i + 1} of ${pages}`}
              aria-current={i === page ? "true" : undefined}
              onClick={() => scrollToPage(i)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- Set up farm form ---------- */

// A labelled group of radio buttons (the round choices in the design).
function RadioList<T extends string>({
  label,
  name,
  value,
  options,
  onChange,
  row,
}: {
  label: string;
  name: string;
  value: T | "" | null;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  row?: boolean;
}) {
  return (
    <fieldset className={`setup-radios ${row ? "row" : ""}`}>
      <legend>{label}</legend>
      <div className="setup-radio-list">
        {options.map((o) => (
          <label className="setup-radio" key={o.value}>
            <input type="radio" name={name} checked={value === o.value} onChange={() => onChange(o.value)} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function SetupForm({
  farm,
  place,
  onSubmit,
  onBack,
  onPlotsChange,
  onDrawPlot,
  pendingOutline,
  onOutlineApplied,
  focusPlotId,
  onShowUndo,
  onClearUndo,
}: {
  farm: Farm;
  place: string | null;
  onSubmit: (patch: { name: string; location: string; details: FarmDetails; plots: Plot[] }) => void;
  onBack: () => void;
  onPlotsChange: (plots: Plot[]) => void; // lets the map show the plots as they are being edited
  onDrawPlot: (plotId: string) => void; // switch to the map so the farmer can outline this plot
  pendingOutline: { plotId: string; points: LatLng[] } | null; // an outline just drawn on the map
  onOutlineApplied: () => void;
  focusPlotId: string | null; // the plot whose tab should be open (the one tapped on the map)
  onShowUndo: (kind: "plot", message: string, undo: () => void) => void; // shows "Deleted. Undo"
  onClearUndo: (kind: "plot") => void; // this form is closing, so its undo no longer applies
}) {
  const [name, setName] = useState(farm.name);
  const [location, setLocation] = useState(farm.location ?? place ?? "");
  const [locationEdited, setLocationEdited] = useState(Boolean(farm.location));
  const [d, setD] = useState<FarmDetails>(() => normalizeDetails(farm.details));
  const [plots, setPlots] = useState<Plot[]>(() => {
    const initial = normalizePlots(farm);
    // Start with one empty crop record to fill in.
    if (initial.every((p) => p.cropRecords.length === 0)) initial[0] = { ...initial[0], cropRecords: [newCropRecord()] };
    return initial;
  });
  const [active, setActive] = useState(() => Math.max(0, plots.findIndex((p) => p.id === focusPlotId))); // which plot tab is open
  useEffect(() => {
    const i = plots.findIndex((p) => p.id === focusPlotId);
    if (i >= 0) setActive(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusPlotId]);
  const [step, setStep] = useState<1 | 2>(1); // 1 = plots and crop records, 2 = soil characteristics
  const formRef = useRef<HTMLFormElement>(null);

  // Once this form closes, an "Undo" for a deleted plot would have nothing to restore into.
  useEffect(() => () => onClearUndo("plot"), []); // eslint-disable-line react-hooks/exhaustive-deps

  // The place name arrives a moment after the outline is closed; fill it in unless the user already typed.
  useEffect(() => {
    if (!locationEdited && place) setLocation(place);
  }, [place, locationEdited]);

  const set = <K extends keyof FarmDetails>(key: K, value: FarmDetails[K]) =>
    setD((prev) => ({ ...prev, [key]: value }));

  // Keep the map in step with the plots being edited.
  useEffect(() => {
    onPlotsChange(plots);
  }, [plots, onPlotsChange]);

  // An outline was just drawn on the map: store it on its plot and use it for the plot's area.
  useEffect(() => {
    if (!pendingOutline) return;
    const idx = plots.findIndex((p) => p.id === pendingOutline.plotId);
    if (idx >= 0) {
      setPlots((prev) =>
        prev.map((p) =>
          p.id === pendingOutline.plotId
            ? { ...p, points: pendingOutline.points, area: formatHa(polygonAreaHa(pendingOutline.points)) }
            : p,
        ),
      );
      setActive(idx);
    }
    onOutlineApplied();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingOutline]);

  const plot = plots[Math.min(active, plots.length - 1)];
  const plotIndex = plots.indexOf(plot);

  const updatePlot = (patch: Partial<Plot>) =>
    setPlots((prev) => prev.map((p) => (p === plot ? { ...p, ...patch } : p)));
  // Crop records are listed together; each one says which plot it is from.
  const allRecords = plots.flatMap((p) => p.cropRecords.map((r) => ({ r, plotId: p.id })));
  const updateRecord = (id: string, patch: Partial<CropRecord>) =>
    setPlots((prev) =>
      prev.map((p) => ({ ...p, cropRecords: p.cropRecords.map((r) => (r.id === id ? { ...r, ...patch } : r)) })),
    );
  const removeRecord = (id: string) =>
    setPlots((prev) => prev.map((p) => ({ ...p, cropRecords: p.cropRecords.filter((r) => r.id !== id) })));
  const moveRecord = (id: string, toPlotId: string) =>
    setPlots((prev) => {
      const rec = prev.flatMap((p) => p.cropRecords).find((r) => r.id === id);
      if (!rec) return prev;
      return prev.map((p) => {
        const rest = p.cropRecords.filter((r) => r.id !== id);
        return p.id === toPlotId ? { ...p, cropRecords: [...rest, rec] } : { ...p, cropRecords: rest };
      });
    });

  function addPlot() {
    setPlots((prev) => [...prev, newPlot()]);
    setActive(plots.length);
  }
  // No "are you sure?": the plot goes right away and "Deleted. Undo" brings it back, crop records included.
  function removePlot() {
    if (plots.length < 2) return;
    const removed = plot;
    const at = plotIndex;
    setPlots((prev) => prev.filter((p) => p.id !== removed.id));
    setActive(Math.max(0, at - 1));
    onShowUndo("plot", `${plotLabel(removed, at)} deleted.`, () => {
      setPlots((prev) => {
        if (prev.some((p) => p.id === removed.id)) return prev;
        const next = [...prev];
        next.splice(Math.min(at, next.length), 0, removed);
        return next;
      });
      setActive(at);
    });
  }

  // Computed from the outline, never typed in.
  const sizeHa = polygonAreaHa(farm.points);
  const waterOptions: { value: Water; label: string }[] = [
    { value: "rainfed", label: "Rain-fed" },
    { value: "irrigation", label: "Irrigation" },
    { value: "both", label: "Both" },
  ];

  const plotsValid = plots.every(
    (p) => p.area !== "." && p.cropRecords.every((r) => r.amount !== "." && !recordError(r)),
  );
  const step1Valid = name.trim().length > 0 && plotsValid;
  const canSave = step1Valid;

  function goToStep(next: 1 | 2) {
    setStep(next);
    // The sheet body is the scrolling part; start the new page at the top.
    formRef.current?.closest(".sheet-body")?.scrollTo({ top: 0 });
  }

  // Only keep irrigation answers that still apply, and drop blank crop records.
  function cleanedDetails(): FarmDetails {
    return {
      ...d,
      // irrigation follow-up questions are no longer asked
      irrigationSource: "",
      irrigationStart: "",
      irrigationEnd: "",
      // These old farm-level answers now live in each plot's crop records and soil answers.
      lastCrop: "",
      lastHarvestYield: "",
      harvestDate: "",
      soilTest: null,
    };
  }
  function cleanedPlots(): Plot[] {
    return plots.map((p) => ({
      ...p,
      name: p.name.trim(),
      cropRecords: p.cropRecords.filter((r) => !recordBlank(r)),
    }));
  }

  const lastRecord = latestRecord(plot);
  const cropOptions = (current: string) => (current && !CROPS.includes(current) ? [...CROPS, current] : CROPS);

  const tabs = (
    <div className="plot-tabs" role="tablist" aria-label="Plots">
      {plots.map((p, i) => (
        <button
          type="button"
          role="tab"
          key={p.id}
          aria-selected={p === plot}
          className={`plot-tab ${p === plot ? "on" : ""}`}
          onClick={() => setActive(i)}
        >
          {plotLabel(p, i)}
        </button>
      ))}
      {step === 1 && (
        <button type="button" className="plot-tab add" onClick={addPlot}>
          + Add Plot
        </button>
      )}
    </div>
  );

  return (
    <form
      className="setup"
      ref={formRef}
      onSubmit={(e) => {
        e.preventDefault();
        if (step === 1) {
          if (step1Valid) goToStep(2);
        } else if (canSave) {
          onSubmit({ name: name.trim(), location: location.trim(), details: cleanedDetails(), plots: cleanedPlots() });
        }
      }}
    >
      {step === 1 ? (
        <>
          <div className="setup-card">
            <label className="setup-row">
              <span>Farm Name:</span>
              <input value={name} onChange={(e) => setName(e.target.value)} required autoComplete="off" />
            </label>
            <label className="setup-row">
              <span>Location:</span>
              <input
                value={location}
                placeholder={place ? "" : "Locating…"}
                onChange={(e) => {
                  setLocation(e.target.value);
                  setLocationEdited(true);
                }}
                autoComplete="off"
              />
            </label>
            <label className="setup-row">
              <span>Farm Size:</span>
              <input value={`${sizeHa.toFixed(2)} ha`} readOnly aria-readonly="true" className="computed" />
            </label>
            <p className="setup-note">Calculated from your outline ({Math.round(sizeHa * 10000).toLocaleString()} m²).</p>
          </div>

          <h3 className="setup-heading">Your Farm Plots</h3>
          <div className="setup-card">
            {tabs}
            <div className="plot-title-row">
              <h4 className="plot-title">{plotLabel(plot, plotIndex)}</h4>
              {plots.length > 1 && (
                <button type="button" className="setup-link" onClick={removePlot}>
                  Remove plot
                </button>
              )}
            </div>
            <label className="setup-row">
              <span>Plot Name:</span>
              <input
                value={plot.name}
                onChange={(e) => updatePlot({ name: e.target.value })}
                placeholder={`Plot ${plotIndex + 1}`}
                autoComplete="off"
              />
            </label>
            <label className="setup-row">
              <span>Plot Area:</span>
              <input
                value={plot.area}
                onChange={(e) => updatePlot({ area: sanitizeDecimal(e.target.value) })}
                inputMode="decimal"
                placeholder="hectares, e.g. 0.5"
                autoComplete="off"
                aria-label="Plot area in hectares"
                readOnly={Boolean(plot.points)}
                className={plot.points ? "computed" : undefined}
              />
            </label>
            <div className="plot-outline">
              <button type="button" className="plot-draw-btn" onClick={() => onDrawPlot(plot.id)}>
                {plot.points ? "Redraw on the map" : "Draw this plot on the map"}
              </button>
              {plot.points && (
                <button type="button" className="setup-link" onClick={() => updatePlot({ points: undefined })}>
                  Clear outline
                </button>
              )}
            </div>
            <p className="setup-note">
              {plot.points
                ? "Area calculated from the outline you drew."
                : "Optional: outline this plot inside your farm on the map."}
            </p>
          </div>

          <h3 className="setup-heading">Previous Crop Records</h3>
          {allRecords.map(({ r, plotId }, ri) => {
            const err = recordError(r);
            return (
              <div className="setup-record" key={r.id}>
                <div className="setup-record-head">
                  <h4>Crop record {ri + 1}</h4>
                  <button type="button" className="setup-link" onClick={() => removeRecord(r.id)}>
                    Remove
                  </button>
                </div>
                <label className="setup-field">
                  <span>Which plot is this from?</span>
                  <select
                    value={plotId}
                    onChange={(e) => {
                      moveRecord(r.id, e.target.value);
                      setActive(plots.findIndex((p) => p.id === e.target.value));
                    }}
                  >
                    {plots.map((p, pi) => (
                      <option key={p.id} value={p.id}>
                        {plotLabel(p, pi)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="setup-field">
                  <span className="sr-only">Crop</span>
                  <select value={r.crop} onChange={(e) => updateRecord(r.id, { crop: e.target.value })} aria-label={`Crop for record ${ri + 1}`}>
                    <option value="">Select a crop</option>
                    {cropOptions(r.crop).map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="setup-grid2">
                  <label className="setup-field">
                    <span>Planting date</span>
                    <input type="date" value={r.plantingDate} onChange={(e) => updateRecord(r.id, { plantingDate: e.target.value })} />
                  </label>
                  <label className="setup-field">
                    <span>Harvest date</span>
                    <input
                      type="date"
                      value={r.harvestDate}
                      min={r.plantingDate || undefined}
                      onChange={(e) => updateRecord(r.id, { harvestDate: e.target.value })}
                    />
                  </label>
                </div>
                {err && <p className="setup-error">{err}</p>}

                <h5 className="setup-sub">Harvest information</h5>
                <div className="setup-field">
                  <span>How much did you harvest?</span>
                  <div className="setup-inline">
                    <input
                      value={r.amount}
                      onChange={(e) => updateRecord(r.id, { amount: sanitizeDecimal(e.target.value) })}
                      inputMode="decimal"
                      placeholder="e.g. 4.5"
                      autoComplete="off"
                      aria-label="Amount harvested (number)"
                    />
                    <select
                      value={r.unit}
                      onChange={(e) => updateRecord(r.id, { unit: e.target.value as YieldUnit })}
                      aria-label="Harvest unit"
                    >
                      {YIELD_UNITS.map((u) => (
                        <option key={u.value} value={u.value}>
                          {u.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <RadioList
                  label="How was the crop’s overall performance?"
                  name={`perf-${r.id}`}
                  value={r.performance}
                  options={PERFORMANCES}
                  onChange={(v) => updateRecord(r.id, { performance: v })}
                />
              </div>
            );
          })}
          {/* a new record starts on the plot tab that is open */}
          <button
            type="button"
            className="setup-add"
            onClick={() => updatePlot({ cropRecords: [...plot.cropRecords, newCropRecord()] })}
          >
            <span aria-hidden="true">⊕</span> Add another crop record
          </button>
        </>
      ) : (
        <>
          {plots.length > 1 && tabs}
          <div className="setup-card">
            <h3 className="setup-card-title">Your Previous Harvest</h3>
            <div className="setup-summary">
              <div className="setup-thumb">
                <FarmThumb key={plot.id + (plot.points ? "p" : "f")} points={plot.points ?? farm.points} />
              </div>
              <div className="setup-summary-text">
                <b>{lastRecord?.crop || "No crop recorded"}</b>
                <span>
                  {plotLabel(plot, plotIndex)}
                  {plot.area && /\d/.test(plot.area) ? `, ${plot.area} ha` : ""}
                </span>
                <span>{lastRecord ? (amountText(lastRecord) ?? "Harvest amount not given") : "No harvest amount"}</span>
                <span>
                  {lastRecord?.harvestDate ? `Harvested ${formatDate(lastRecord.harvestDate) ?? lastRecord.harvestDate}` : "No harvest date"}
                </span>
              </div>
            </div>
            <p className="setup-note">
              Previous crop history will be used to evaluate nutrient demand and rotation compatibility.
            </p>
          </div>

          <h3 className="setup-heading">Farming Conditions</h3>
          <div className="setup-choice">
            <span id="water-label">Water Availability</span>
            <div className="setup-pills" role="group" aria-labelledby="water-label">
              {waterOptions.map((o) => (
                <button
                  type="button"
                  key={o.value}
                  className={`setup-pill ${d.water === o.value ? "on" : ""}`}
                  aria-pressed={d.water === o.value}
                  onClick={() => set("water", d.water === o.value ? null : o.value)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>

        </>
      )}

      <div className="setup-actions">
        <button type="button" className="setup-back" onClick={() => (step === 1 ? onBack() : goToStep(1))}>
          Back
        </button>
        <button type="submit" className="setup-next" disabled={step === 1 ? !step1Valid : !canSave}>
          Next
        </button>
      </div>
    </form>
  );
}

/* ---------- main screen ---------- */

// Makes the browser Back button close the top-most open layer (the menu first, then the sheet).
// `depth` = how many layers are open. Each opened layer adds one history entry, and Back closes one.
// When a layer is closed by tapping, its entries are removed again so Back does not feel stuck.
function useBackToClose(depth: number, closeTop: () => void) {
  const pushed = useRef(0); // history entries added by this hook that are still on the stack
  const ignore = useRef(0); // popstate events caused by our own history.go()
  const closeRef = useRef(closeTop);
  closeRef.current = closeTop;

  useEffect(() => {
    while (pushed.current < depth) {
      pushed.current += 1;
      history.pushState({ oryzonLayer: pushed.current }, "");
    }
    if (pushed.current > depth) {
      const extra = pushed.current - depth;
      pushed.current = depth;
      ignore.current += 1;
      history.go(-extra);
    }
  }, [depth]);

  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      if (ignore.current > 0) {
        ignore.current -= 1;
        return;
      }
      if (pushed.current > 0) {
        pushed.current -= 1;
        closeRef.current();
      } else if (e.state && typeof e.state === "object" && "oryzonLayer" in e.state) {
        history.back(); // an entry left over from before a page reload: skip it
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
}

// "Deleted. Undo" message at the bottom of the screen.
interface UndoItem {
  kind: "farm" | "plot";
  message: string;
  undo: () => void;
}
const UNDO_MS = 7000;
const SHEET_ORDER = ["peek", "half", "full"] as const;
const TILE_LABEL: Record<MetricKey, string> = { temperature: "Temp", soilMoisture: "Soil", precipitation: "Rain" };
const STATUS_GLYPH: Record<Level, string> = { good: "✓", watch: "!", alert: "▲", none: "–" };

// True on wide windows and landscape phones, where there is room on the map beside the sheet.
// Keep this number in sync with the 800px media queries in styles.css.
const WIDE_QUERY = "(min-width: 1000px)";
function useWide() {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(WIDE_QUERY);
    const update = () => setWide(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return wide;
}

// True on tablet-sized and bigger windows (700px+), where the reading tiles fit beside a half-open sheet.
const MID_QUERY = "(min-width: 700px)";
function useMid() {
  const [mid, setMid] = useState(() => window.matchMedia(MID_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(MID_QUERY);
    const update = () => setMid(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return mid;
}

export function FarmMap() {
  // Farms saved on earlier visits (empty the first time).
  const [initial] = useState(loadStore);
  const [farms, setFarms] = useState<Farm[]>(initial.farms);
  // the farm shown on the map; null while a new one is being outlined
  const [activeId, setActiveId] = useState<string | null>(initial.activeId);
  const activeFarm = farms.find((f) => f.id === activeId) ?? null;
  // The farm's plots as saved. Farms saved before plots existed get one plot built from their old answers;
  // memoised so that plot keeps the same id between renders.
  const savedPlots = useMemo(() => (activeFarm ? normalizePlots(activeFarm) : []), [activeFarm]);
  const [startFarm] = useState(activeFarm);
  const [poly, setPolygon] = useState<ThePolygon>(
    startFarm ? { closed: true, points: startFarm.points } : EMPTY,
  );
  const [drawing, setDrawing] = useState(false);
  // finishing an outline checks that it is on land: true while that check runs, and the message if it fails
  const [checkingArea, setCheckingArea] = useState(false);
  const [drawError, setDrawError] = useState<string | null>(null);
  // bump to zoom the map to the active farm
  const [fitNonce, setFitNonce] = useState(0);
  // First visit with no farm: show a prompt asking the user to add one.
  const [welcome, setWelcome] = useState(initial.farms.length === 0);
  const [data, setData] = useState<DayData[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [place, setPlace] = useState<string | null>(null);
  // null = no layer selected, so the plain satellite map is shown
  const [layer, setLayer] = useState<LayerKey | null>(null);
  const [layersOpen, setLayersOpen] = useState(false); // the three map layers stay hidden until the button is tapped
  // peek = just the "CONDITION" bar, half = partly open, full = covers the whole screen
  const [sheet, setSheet] = useState<"peek" | "half" | "full">("peek");
  const wide = useWide();
  const mid = useMid();
  // the slide-out menu on the left
  const [menuOpen, setMenuOpen] = useState(false);
  // place search in the top bar
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<PlaceHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchNote, setSearchNote] = useState<string | null>(null); // "No places found" or an error
  const [flyTarget, setFlyTarget] = useState<{ hit: PlaceHit; nonce: number } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchAbort = useRef<AbortController | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  // what the bottom sheet shows: the Dashboard, the detailed Condition view, the My Farms screen,
  // the Set up farm form (opens right after a new outline is finished), or the Plan next season screen
  const [sheetView, setSheetView] = useState<"dashboard" | "condition" | "farms" | "setup" | "plan">("dashboard");
  // the "My Farms" drop-down in the menu
  const [farmsOpen, setFarmsOpen] = useState(false);
  // the "Deleted. Undo" message, and the timer that hides it
  const [undoItem, setUndoItem] = useState<UndoItem | null>(null);
  const undoTimer = useRef<number | undefined>(undefined);
  // which reading's details are open over the map (null = just the small tiles)
  const [openMetric, setOpenMetric] = useState<MetricKey | null>(null);
  // dragging the sheet handle
  const appRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startY: number; startH: number; lastY: number; lastT: number; v: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false); // a drag must not also count as a tap on the handle

  // Plot outlines: the plots as the Set up form currently has them, the outline being drawn on the map,
  // and a finished outline waiting to be handed back to the form.
  const [livePlots, setLivePlots] = useState<Plot[]>([]);
  const [plotDraw, setPlotDraw] = useState<PlotDraw | null>(null);
  const [plotOutline, setPlotOutline] = useState<{ plotId: string; points: LatLng[] } | null>(null);
  // the plot the farmer tapped on the map (its details card is open)
  const [selectedPlotId, setSelectedPlotId] = useState<string | null>(null);
  const skipMapTap = useRef(false); // set by a tap on a plot so the map-tap handler does not close the card right away

  // map layer: every grid point, one day at a time
  const [metas, setMetas] = useState<Partial<Record<MetricKey, GridMeta>>>({});
  const [heatBounds, setHeatBounds] = useState<Partial<Record<MetricKey, Bounds>>>({});

  const [day, setDay] = useState<number>(0); // index into dates (kept on the latest day unless the farmer browses past data)
  const [pastMode, setPastMode] = useState(false); // the farmer asked to browse past days
  const [grid, setGrid] = useState<{ layer: MetricKey; points: GridPoint[] } | null>(null);
  const [imageDate, setImageDate] = useState<string | null>(null); // the day whose image we actually request
  const [gridError, setGridError] = useState<string | null>(null);
  // bump these to load again after a failure ("Try again")
  const [regionTry, setRegionTry] = useState(0);
  const [metaTry, setMetaTry] = useState(0);
  const [overlayTry, setOverlayTry] = useState(0);
  const [layerBusy, setLayerBusy] = useState(false); // the heat map image is still being fetched
  // when the farm's numbers were last loaded, and for which outline
  const [lastUpdated, setLastUpdated] = useState<{ key: string; at: number } | null>(null);
  const cache = useRef<Record<string, GridPoint[]>>({}); // key: "layer:date"

  const dataLayer = isMetric(layer) ? layer : null;
  const metric = METRICS.find((m) => m.key === dataLayer);

  // One shared slider. Its days come from the first layer the backend reports.
  const firstMeta = METRICS.map((m) => metas[m.key]).find((m) => m !== undefined);
  const dates = firstMeta ? firstMeta.dates : null;
  const date = dates ? dates[Math.min(day, dates.length - 1)] : null;

  // Start on the latest day, and go back to it whenever the farmer is not browsing past data.
  useEffect(() => {
    if (dates && !pastMode) setDay(dates.length - 1);
  }, [dates?.length, pastMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // The farm's data and the map layer share the slider, matched by date (not array position).
  const polyIndex = data && date ? data.findIndex((d) => d.date === date) : -1;
  const current = data && polyIndex >= 0 ? data[polyIndex] : null;
  const advice = data && polyIndex >= 0 ? getAdvice(data, polyIndex) : null;

  // Finishing a shape ends drawing and opens the Condition sheet.
  useEffect(() => {
    if (poly.closed) {
      setDrawing(false);
      setSheet("half");
    }
  }, [poly.closed]);

  // A newly finished outline becomes a saved farm ("Farm 1", "Farm 2", ...).
  useEffect(() => {
    if (!poly.closed || activeId !== null) return;
    const id = `farm-${Date.now()}`;
    setFarms((prev) => {
      let n = 1;
      while (prev.some((f) => f.name === `Farm ${n}`)) n++;
      return [...prev, { id, name: `Farm ${n}`, points: poly.points }];
    });
    setActiveId(id);
    // Ask for the farm's details right after the outline is finished.
    setSheetView("setup");
    setSheet("full");
  }, [poly, activeId]);

  // Leaving the Set up form drops any plot drawing in progress.
  useEffect(() => {
    if (sheetView !== "setup") {
      setPlotDraw(null);
      setPlotOutline(null);
    }
  }, [sheetView]);

  // Remember the farms in this browser.
  useEffect(() => {
    try {
      localStorage.setItem(FARMS_KEY, JSON.stringify({ farms, activeId }));
    } catch {
      /* storage unavailable: farms just won't be remembered */
    }
  }, [farms, activeId]);

  // Editing the outline clears the water warning.
  useEffect(() => {
    setDrawError(null);
  }, [poly.points.length]);

  // Close the slide-out menu with the Esc key.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  // The browser Back button closes the menu first, then the bottom sheet.
  useBackToClose((menuOpen ? 1 : 0) + (sheet !== "peek" ? 1 : 0), () => {
    if (menuOpen) setMenuOpen(false);
    else setSheet("peek");
  });

  // Stop the undo timer if the screen goes away.
  useEffect(() => () => window.clearTimeout(undoTimer.current), []);

  // Load each layer's dates and the corners its heat map image is pinned to (again after "Try again").
  useEffect(() => {
    const controller = new AbortController();
    const onError = (e: Error) => {
      if (e.name !== "AbortError") setGridError(e.message || "Request failed");
    };
    METRICS.forEach((m) => {
      fetchMeta(m.key, controller.signal)
        .then((meta) => setMetas((prev) => ({ ...prev, [m.key]: meta })))
        .catch(onError);
      fetchHeatmapBounds(m.key, controller.signal)
        .then((b) => setHeatBounds((prev) => ({ ...prev, [m.key]: b })))
        .catch(onError);
    });
    return () => controller.abort();
  }, [metaTry]);

  // Dragging the slider changes `date` many times a second. Wait until it settles for a moment before asking
  // for a new image, so the server isn't asked to draw days you only passed through.
  useEffect(() => {
    if (!date) return;
      const t = setTimeout(() => setImageDate(date), 120);
      return () => clearTimeout(t);
  }, [date]);

  // The layer image counts as loading from the moment a layer and day are chosen until it arrives.
  useEffect(() => {
    setLayerBusy(!!dataLayer && !!imageDate);
  }, [dataLayer, imageDate]);

  // Load region data once the shape is closed (and again after "Try again").
  useEffect(() => {
    if (!poly.closed || poly.points.length < 3) {
      setData(null);
      return;
    }
    const controller = new AbortController();
    const key = poly.points.map((p) => p.join(",")).join(";");
    setLoading(true);
    setError(null);
    setData(null);

    fetchRegionData(toGeoJSONPolygon(poly.points), controller.signal)
      .then((d) => {
        setData(d);
        setLastUpdated({ key, at: Date.now() });
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message || "Request failed");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [poly, regionTry]);

  // "Try again" buttons.
  function retryRegion() {
    setRegionTry((n) => n + 1);
  }
  function retryLayers() {
    setGridError(null);
    setMetaTry((n) => n + 1);
    setOverlayTry((n) => n + 1);
  }

  // Name the farm's location from its center point.
  useEffect(() => {
    if (!poly.closed) {
      setPlace(null);
      return;
    }
    const [lat, lng] = centroid(poly.points);
    const controller = new AbortController();
    reverseGeocode(lat, lng, controller.signal)
      .then(setPlace)
      .catch(() => {});
    return () => controller.abort();
  }, [poly]);

  // Focus the search box when it opens.
  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  // Suggestions appear a moment after the person stops typing (Nominatim asks for gentle use).
  useEffect(() => {
    const q = query.trim();
    if (!searchOpen || q.length < 3) {
      searchAbort.current?.abort();
      setHits([]);
      setSearchNote(null);
      setSearching(false);
      return;
    }
    const t = window.setTimeout(() => {
      void lookup(q);
    }, 700);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, searchOpen]);

  async function lookup(q: string): Promise<PlaceHit[]> {
    searchAbort.current?.abort();
    const controller = new AbortController();
    searchAbort.current = controller;
    setSearching(true);
    setSearchNote(null);
    try {
      const found = await searchPlaces(q, mapRef.current, controller.signal);
      if (controller.signal.aborted) return [];
      setHits(found);
      setSearchNote(found.length === 0 ? "No places found. Try another name." : null);
      return found;
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setHits([]);
        setSearchNote("Couldn't search right now. Check your connection and try again.");
      }
      return [];
    } finally {
      if (!controller.signal.aborted) setSearching(false);
    }
  }

  function closeSearch() {
    searchAbort.current?.abort();
    setSearchOpen(false);
    setQuery("");
    setHits([]);
    setSearchNote(null);
    setSearching(false);
  }

  // Teleport: fly the map to the place and collapse the bottom sheet so the map is visible.
  function goToPlace(hit: PlaceHit) {
    setFlyTarget((prev) => ({ hit, nonce: (prev?.nonce ?? 0) + 1 }));
    setSelectedPlotId(null);
    setSheet("peek");
    closeSearch();
  }

  // Enter (or the magnifier) goes straight to the nearest match.
  async function submitSearch() {
    const q = query.trim();
    if (!q) return;
    const found = await lookup(q);
    if (found[0]) goToPlace(found[0]);
  }

  // Show a saved farm on the map.
  // Browse past days (opens the Dashboard, where the slider is) or go back to the latest day.
  function openPast(open: boolean) {
    setPastMode(open);
    if (!open) return;
    setSheetView("dashboard");
    setSheet((s) => (s === "peek" ? "half" : s));
  }

  function selectFarm(f: Farm) {
    setSelectedPlotId(null);
    setPastMode(false);
    setMenuOpen(false);
    setWelcome(false);
    setDrawing(false);
    setActiveId(f.id);
    setPolygon({ closed: true, points: f.points });
    setSheetView("dashboard");
    setSheet("half");
    setFitNonce((n) => n + 1);
  }

  // "Deleted. Undo" message. A newer one replaces the older one; it hides itself after a few seconds.
  function showUndo(kind: UndoItem["kind"], message: string, undo: () => void) {
    window.clearTimeout(undoTimer.current);
    setUndoItem({ kind, message, undo });
    undoTimer.current = window.setTimeout(() => setUndoItem(null), UNDO_MS);
  }
  function hideUndo(kind?: UndoItem["kind"]) {
    setUndoItem((prev) => {
      if (!prev || (kind && prev.kind !== kind)) return prev;
      window.clearTimeout(undoTimer.current);
      return null;
    });
  }

  // Put a deleted farm back where it was in the list (and on the map, if it was the one being shown).
  function restoreFarm(removed: Farm, index: number, wasActive: boolean) {
    setFarms((prev) => {
      if (prev.some((f) => f.id === removed.id)) return prev;
      const next = [...prev];
      next.splice(Math.min(index, next.length), 0, removed);
      return next;
    });
    if (!wasActive) return;
    setSelectedPlotId(null);
    setWelcome(false);
    setDrawing(false);
    setActiveId(removed.id);
    setPolygon({ closed: true, points: removed.points });
    setSheetView("dashboard");
    setSheet("half");
    setFitNonce((n) => n + 1);
  }

  // Remove a saved farm right away (no question), with "Deleted. Undo".
  // If it was the one on the map, show another one (or go back to the first-visit prompt).
  function deleteFarm(id: string) {
    const index = farms.findIndex((f) => f.id === id);
    if (index < 0) return;
    const removed = farms[index];
    const wasActive = id === activeId;
    const remaining = farms.filter((f) => f.id !== id);
    setFarms(remaining);
    showUndo("farm", `${removed.name} deleted.`, () => restoreFarm(removed, index, wasActive));
    if (!wasActive) return;
    setSelectedPlotId(null);

    const next = remaining[0] ?? null;
    if (next) {
      setActiveId(next.id);
      setPolygon({ closed: true, points: next.points });
      setFitNonce((n) => n + 1);
      if (sheetView === "condition" || sheetView === "plan") setSheetView("dashboard");
    } else {
      setActiveId(null);
      setPolygon(EMPTY);
      setData(null);
      setError(null);
      setDrawing(false);
      setSheetView("dashboard");
      setSheet("peek");
      setMenuOpen(false);
      setWelcome(true);
    }
  }

  // Open the My Farms screen in the bottom sheet.
  function openFarmsView() {
    setMenuOpen(false);
    setSheetView("farms");
    setSheet("full");
  }

  // "Next" on the Set up farm screen: save the answers on the farm and show its dashboard.
  function saveSetup(patch: { name: string; location: string; details: FarmDetails; plots: Plot[] }) {
    setFarms((prev) => prev.map((f) => (f.id === activeId ? { ...f, ...patch } : f)));
    setSelectedPlotId(null);
    setSheetView("dashboard");
    setSheet("half");
  }

  // Plot outlining: hide the form, let the farmer tap the plot's corners, then bring the form back.
  function startPlotDraw(plotId: string) {
    setDrawError(null);
    setPlotDraw({ plotId, points: [] });
    setSheet("peek");
    setFitNonce((n) => n + 1);
  }
  function finishPlotDraw(points: LatLng[]) {
    if (!plotDraw) return;
    setPlotOutline({ plotId: plotDraw.plotId, points });
    setPlotDraw(null);
    setDrawError(null);
    setSheet("full");
  }
  function cancelPlotDraw() {
    setPlotDraw(null);
    setDrawError(null);
    setSheet("full");
  }

  // A tap on a plot outline: show its details over the map (not while an outline is being drawn).
  function selectPlot(plotId: string) {
    if (plotDraw || drawing || sheetView === "setup") return;
    skipMapTap.current = true;
    setTimeout(() => {
      skipMapTap.current = false;
    }, 0);
    setSelectedPlotId(plotId);
    setSheet("peek"); // make room so the card does not cover the map
  }

  // A tap on the farm shape itself (not on a drawn plot). Plots with no outline cannot be tapped on the map,
  // so a farm with one plot, or with exactly one un-outlined plot, opens that plot's details.
  function tapFarm() {
    if (shownPlots.length === 1) {
      selectPlot(shownPlots[0].id);
      return;
    }
    const unoutlined = shownPlots.filter((p) => !(p.points && p.points.length >= 3));
    if (unoutlined.length === 1) selectPlot(unoutlined[0].id);
  }

  // Reopen the Set up farm form with the answers already saved for this farm.
  function openEditDetails() {
    setMenuOpen(false);
    setSheetView("setup");
    setSheet("full");
  }

  // Go back to the Dashboard (from the side menu or the My Farms screen).
  function openDashboardView() {
    setMenuOpen(false);
    setSheetView("dashboard");
    setSheet(poly.closed ? "half" : "peek");
  }

  // Called when the farmer taps the first point to finish. Closes the shape only if it is on land.
  async function finishOutline() {
    if (checkingArea || poly.closed || poly.points.length < 3) return;
    const pointsNow = poly.points;
    setDrawError(null);
    setCheckingArea(true);
    const share = await waterShare(pointsNow);
    setCheckingArea(false);
    if (share !== null && share >= WATER_LIMIT) {
      setDrawError("That area is open water, such as the ocean or a lake. Move the points onto your farmland, then tap the orange point again.");
      return;
    }
    // Only close it if nothing changed while checking (for example, a new farm was started).
    setPolygon((prev) => (prev.points === pointsNow ? { ...prev, closed: true } : prev));
  }

  function startNewFarm() {
    setSelectedPlotId(null);
    setDrawError(null);
    setCheckingArea(false);
    setSheetView("dashboard");
    setMenuOpen(false);
    setWelcome(false);
    setActiveId(null);
    setPolygon(EMPTY);
    setDrawing(true);
    setData(null);
    setError(null);
    setSheet("peek");
  }

  // Dragging the handle: the sheet follows the finger, then settles on peek, half or full.
  function onHandleDown(e: React.PointerEvent<HTMLButtonElement>) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const el = sheetRef.current;
    if (!el) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      startY: e.clientY,
      startH: el.getBoundingClientRect().height,
      lastY: e.clientY,
      lastT: e.timeStamp,
      v: 0,
      moved: false,
    };
  }
  function onHandleMove(e: React.PointerEvent<HTMLButtonElement>) {
    const d = dragRef.current;
    const el = sheetRef.current;
    const app = appRef.current;
    if (!d || !el || !app) return;
    const dy = e.clientY - d.startY;
    if (!d.moved) {
      if (Math.abs(dy) < 6) return; // still a tap
      d.moved = true;
      setDragging(true);
    }
    const dt = e.timeStamp - d.lastT;
    if (dt > 0) d.v = (e.clientY - d.lastY) / dt; // px per ms, negative = moving up
    d.lastY = e.clientY;
    d.lastT = e.timeStamp;
    el.style.height = `${Math.min(app.clientHeight - 100, Math.max(96, d.startH - dy))}px`;
  }
  function onHandleUp(e: React.PointerEvent<HTMLButtonElement>) {
    const d = dragRef.current;
    dragRef.current = null;
    const el = sheetRef.current;
    const app = appRef.current;
    if (!d || !d.moved || !el || !app) return; // a plain tap is handled by onClick
    suppressClick.current = true;
    window.setTimeout(() => (suppressClick.current = false), 350);
    let next: (typeof SHEET_ORDER)[number];
    if (e.type === "pointercancel") {
      next = sheet;
    } else if (Math.abs(d.v) > 0.5) {
      // a quick flick moves one step in its direction
      const i = SHEET_ORDER.indexOf(sheet) + (d.v < 0 ? 1 : -1);
      next = SHEET_ORDER[Math.min(2, Math.max(0, i))];
    } else {
      const f = el.getBoundingClientRect().height / app.clientHeight;
      next = f < 0.38 ? "peek" : f < 0.75 ? "half" : "full";
    }
    el.style.height = "";
    setDragging(false);
    setSheet(next);
  }

  const pillText = plotDraw
    ? "Outline your plot on the map"
    : poly.closed
      ? activeFarm?.location || place || "Locating…"
      : "Outline your farm on the map";
  const shownPlots = sheetView === "setup" ? livePlots : savedPlots;
  const selectedPlot = shownPlots.find((p) => p.id === selectedPlotId);
  const drawingPlot = plotDraw ? livePlots.find((p) => p.id === plotDraw.plotId) : undefined;
  const drawingPlotLabel = drawingPlot ? plotLabel(drawingPlot, livePlots.indexOf(drawingPlot)) : "the plot";
  // Undo / Clear bar while outlining the farm (the plot bar has its own).
  const farmDrawBar = drawing && !poly.closed && !plotDraw;
  // Readings sit on the map while the sheet is collapsed; when the sheet is open the dashboard shows them.
  // On a wide window or landscape phone the sheet leaves room beside it, so they stay on the map in every state.
  const showConditions = poly.closed && !!activeFarm && (sheet === "peek" || wide || (mid && sheet === "half")) && sheetView !== "setup" && sheetView !== "plan" && !plotDraw && !farmDrawBar;
  // The day picker (with the legend of the selected layer) floats above the sheet.
  const showTimeline =
    !!dates && !!date && (pastMode || !!dataLayer) && !plotDraw && !farmDrawBar && !(selectedPlot && sheetView !== "setup");
  useEffect(() => {
    if (!showConditions) setOpenMetric(null);
  }, [showConditions]);
  const weather = weatherFor(current?.precipitation);
  const dashDate = dashboardDate(date);
  const readings: { key: MetricKey; label: string; icon: string }[] = [
    { key: "temperature", label: "TEMPERATURE", icon: tempDashboard },
    { key: "soilMoisture", label: "SOIL MOISTURE", icon: soilMoistureDashboard },
    { key: "precipitation", label: "PRECIPITATION", icon: precipitationDashboard },
  ];
  // Good / Watch / Alert for each reading, compared with this area's own history.
  const statusOf = (key: MetricKey): Status =>
    loading
      ? pendingStatus("Loading…")
      : error && !current
        ? pendingStatus("Unavailable")
        : interpret(key, data, date, current?.[key], metas[key]?.period === "month");
  const polyKey = poly.points.map((p) => p.join(",")).join(";");
  const loadedAt = lastUpdated && lastUpdated.key === polyKey ? lastUpdated.at : null;
  // the selected day is more than 30 days ago
  const stale = !!date && Date.now() - new Date(`${date}T00:00:00`).getTime() > 30 * 86400000;
  const sheetTitle =
    sheetView === "farms" ? "MY FARMS" : sheetView === "setup" ? "SET UP FARM" : sheetView === "plan" ? "PLAN NEXT SEASON" : sheetView === "dashboard" ? "DASHBOARD" : (activeFarm?.name ?? "Condition").toUpperCase();
  const viewClass = sheetView === "condition" ? "" : sheetView === "setup" ? "setup" : "banner";
  // True whenever the app is waiting on something: the farm's numbers, a map layer, a place search, the water check.
  const busy =
    loading ||
    searching ||
    checkingArea ||
    (!!dataLayer && (layerBusy || !bounds) && !gridError) ||
    (Object.keys(metas).length === 0 && !gridError);
  const heatUrl = dataLayer && imageDate ? heatmapUrl(dataLayer, imageDate) : null;
  const bounds = dataLayer ? heatBounds[dataLayer] : undefined;

  return (
    <div className={`app sheet-${sheet}`} ref={appRef}>
      <MapContainer
        center={startFarm ? centroid(startFarm.points) : START_CENTER}
        zoom={startFarm ? 15 : START_ZOOM}
        maxZoom={19}
        zoomControl={false}
        className="map"
      >
        <TileLayer
          attribution="Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics"
          url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
          maxNativeZoom={18}
          maxZoom={19}
        />
        {/* own pane: above the satellite tiles, below the farm and plot outlines */}
        <Pane name="heat" className="heat-pane" style={{ zIndex: 350 }}>
        {heatUrl && bounds && (
          <ImageOverlay
            key={`${dataLayer}-${overlayTry}`} // a new layer has different corners, so start a fresh overlay
            url={heatUrl}
            bounds={bounds}
            opacity={1}
            eventHandlers={{
              load: () => {
                setGridError(null);
                setLayerBusy(false);
              },
              error: () => {
                setGridError("Couldn't load the heat map for this day.");
                setLayerBusy(false);
              },
            }}
          />
        )}
        </Pane>
        <DrawLayer
          poly={poly}
          setPolygon={setPolygon}
          drawing={drawing}
          busy={checkingArea}
          onClose={finishOutline}
          onFarmTap={tapFarm}
        />
        <MapTapDismiss
          active={selectedPlotId !== null && sheetView !== "setup" && !plotDraw}
          skip={skipMapTap}
          onDismiss={() => setSelectedPlotId(null)}
        />
        {poly.closed && (
          <PlotsLayer
            plots={shownPlots}
            hideId={plotDraw?.plotId ?? null}
            selectedId={selectedPlotId}
            onSelect={selectPlot}
          />
        )}
        {activeFarm && (
          <PlotDrawLayer
            farm={activeFarm.points}
            draw={plotDraw}
            setDraw={setPlotDraw}
            onFinish={finishPlotDraw}
            onReject={setDrawError}
          />
        )}
        <FitFarm points={activeFarm?.points ?? null} nonce={fitNonce} />
        <MapHandle mapRef={mapRef} />
        <FlyTo target={flyTarget} />
      </MapContainer>

      {/* loading bar: runs along the top edge while the app is working */}
      {busy && <div className="busy-bar" role="progressbar" aria-label="Loading" aria-busy="true" />}

      {/* top bar */}
      {searchOpen && <div className="search-scrim" onClick={closeSearch} aria-hidden="true" />}
      <div className="topbar">
        <button
          className="menu-btn"
          aria-label="Menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(true)}
        >
          <span /><span /><span />
        </button>
        <div
          className={`place-pill ${searchOpen ? "searching" : ""}`}
          onClick={(e) => {
            // a tap anywhere on the bar (not on one of its buttons) opens the search, or focuses the box
            if ((e.target as HTMLElement).closest("button")) return;
            if (!searchOpen) setSearchOpen(true);
            else searchRef.current?.focus();
          }}
        >
          {searchOpen ? (
            <form
              className="search-form"
              role="search"
              onSubmit={(e) => {
                e.preventDefault();
                void submitSearch();
              }}
            >
              <input
                ref={searchRef}
                className="search-input"
                type="search"
                value={query}
                placeholder="Search for a place"
                aria-label="Search for a place"
                autoComplete="off"
                enterKeyHint="search"
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") closeSearch();
                }}
              />
            </form>
          ) : (
            <span className="place-text">{pillText}</span>
          )}
          {searchOpen && (
            <button type="button" className="search-close" aria-label="Close search" onClick={closeSearch}>
              ×
            </button>
          )}
          <button
            type="button"
            className="search-btn"
            aria-label={searchOpen ? "Search" : "Search for a place"}
            onClick={() => {
              if (!searchOpen) setSearchOpen(true);
              else if (query.trim()) void submitSearch();
              else closeSearch();
            }}
          >
            {searching ? (
              <span className="search-spin" aria-hidden="true" />
            ) : (
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="6.5" />
                <path d="M20 20l-4.2-4.2" />
              </svg>
            )}
          </button>

          {searchOpen && (searching || hits.length > 0 || searchNote) && (
            <div className="search-panel">
              {hits.length > 0 && <div className="search-head">Closest to the map first</div>}
              <ul className="search-results" role="listbox" aria-label="Search results">
                {searching && hits.length === 0 && (
                <li className="search-note">
                  <span className="spinner" aria-hidden="true" />
                  Searching…
                </li>
              )}
                {searchNote && <li className="search-note">{searchNote}</li>}
                {hits.map((h, i) => (
                  <li key={`${h.lat},${h.lng},${i}`} role="option" aria-selected="false">
                    <button type="button" className="search-hit" onClick={() => goToPlace(h)}>
                      <span className="search-hit-pin" aria-hidden="true">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z" />
                          <circle cx="12" cy="9.5" r="2.4" />
                        </svg>
                      </span>
                      <span className="search-hit-text">
                        <b>{h.name}</b>
                        {h.detail && <small>{h.detail}</small>}
                      </span>
                      <span className="search-hit-dist">{formatDistance(h.km)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {poly.closed && activeFarm && (
        <div className="farm-label">
          <span className="farm-label-chip">
            <span className="farm-label-pin" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z" />
                <circle cx="12" cy="9.5" r="2.4" />
              </svg>
            </span>
            <span className="farm-label-name">{activeFarm.name}</span>
          </span>
        </div>
      )}

      {/* checking / water warning */}
      {checkingArea && (
        <div className={`map-toast ${farmDrawBar ? "above-bar" : ""}`} role="status">
          Checking that the area is land…
        </div>
      )}
      {drawError && (
        <div className={`map-toast error ${plotDraw || farmDrawBar ? "above-bar" : ""}`} role="alert">
          <span>{drawError}</span>
          <button aria-label="Dismiss" onClick={() => setDrawError(null)}>×</button>
        </div>
      )}

      {/* details of the plot the farmer tapped on the map */}
      {selectedPlot && sheetView !== "setup" && !plotDraw && sheet !== "full" && (
        <PlotCard
          plot={selectedPlot}
          index={shownPlots.indexOf(selectedPlot)}
          onEdit={openEditDetails}
          onClose={() => setSelectedPlotId(null)}
        />
      )}

      {/* farm outlining: visible Undo and Clear */}
      {farmDrawBar && (
        <div className="plot-bar" role="status">
          <span>
            Tap the map to place the corners of your field. Tap the orange first point to finish.
          </span>
          <div className="plot-bar-actions">
            <button
              type="button"
              disabled={poly.points.length === 0 || checkingArea}
              onClick={() => setPolygon((prev) => ({ ...prev, points: prev.points.slice(0, -1) }))}
            >
              Undo
            </button>
            <button
              type="button"
              disabled={poly.points.length === 0 || checkingArea}
              onClick={() => setPolygon(EMPTY)}
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* plot outlining instructions */}
      {plotDraw && (
        <div className="plot-bar" role="status">
          <span>
            Tap inside your farm to place the corners of <b>{drawingPlotLabel}</b>. Tap the orange first point to
            finish.
          </span>
          <div className="plot-bar-actions">
            <button
              type="button"
              disabled={plotDraw.points.length === 0}
              onClick={() => setPlotDraw((prev) => (prev ? { ...prev, points: prev.points.slice(0, -1) } : prev))}
            >
              Undo
            </button>
            <button
              type="button"
              disabled={plotDraw.points.length === 0}
              onClick={() => setPlotDraw((prev) => (prev ? { ...prev, points: [] } : prev))}
            >
              Clear
            </button>
            <button type="button" onClick={cancelPlotDraw}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* day picker and colour scale */}
      {showTimeline && dates && (
        <MapTimeline
          dates={dates}
          day={day}
          layer={dataLayer}
          monthly={!!dataLayer && metas[dataLayer]?.period === "month"}
          onPast={openPast}
        />
      )}

      {/* today's readings, small tiles on the map */}
      {showConditions && !openMetric && (
        <div className="conditions" role="group" aria-label="Readings for this day">
          {readings.map((r) => {
            const mt = METRICS.find((x) => x.key === r.key)!;
            const f = formatReading(r.key, current?.[r.key]);
            const st = statusOf(r.key);
            return (
              <button
                type="button"
                key={r.key}
                className={`cond-tile ${layer === r.key ? "layer" : ""}`}
                style={{ "--accent": mt.color } as React.CSSProperties}
                aria-label={`${sentenceCase(r.label)}: ${f.value}${f.unit}, ${st.label}. Show details`}
                onClick={() => setOpenMetric(r.key)}
              >
                <span className="cond-name">{TILE_LABEL[r.key]}</span>
                <span className={`cond-glyph ${st.level}`} aria-hidden="true">
                  {loading ? <span className="spinner" /> : STATUS_GLYPH[st.level]}
                </span>
                <span className="cond-value">
                  {f.value}
                  {f.unit && <small>{f.unit}</small>}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* details of one reading */}
      {showConditions && openMetric && (() => {
        const mt = METRICS.find((x) => x.key === openMetric)!;
        const f = formatReading(openMetric, current?.[openMetric]);
        const st = statusOf(openMetric);
        return (
          <div className="cond-pop" role="dialog" aria-label={`${mt.label} details`}>
            <div className="cond-pop-top">
              <div className="cond-tabs" role="tablist" aria-label="Reading">
                {readings.map((r) => {
                  const x = METRICS.find((q) => q.key === r.key)!;
                  return (
                    <button
                      type="button"
                      role="tab"
                      key={r.key}
                      aria-selected={r.key === openMetric}
                      className={`cond-tab ${r.key === openMetric ? "on" : ""}`}
                      style={{ "--accent": x.color } as React.CSSProperties}
                      onClick={() => setOpenMetric(r.key)}
                    >
                      {TILE_LABEL[r.key]}
                    </button>
                  );
                })}
              </div>
              <button type="button" className="cond-close" aria-label="Close details" onClick={() => setOpenMetric(null)}>
                ×
              </button>
            </div>
            <div className="cond-big">
              <b>
                {f.value}
                {f.unit && <small>{f.unit}</small>}
              </b>
              <span className={`status-pill ${st.level}`}>{st.label}</span>
            </div>
            {loading && <LoadingNote text="Loading satellite data…" />}
            {error && !current && <DataNotice message={friendlyError(error)} onRetry={retryRegion} loadedAt={loadedAt} />}
            {st.text && <p className="cond-text">{st.text}</p>}
            {data && current && <Chart data={data} field={openMetric} index={polyIndex} color={mt.color} />}
            {openMetric === "precipitation" && advice && <p className="cond-advice">{advice.text}</p>}
            {current && date && (
              <p className={`cond-asof ${stale ? "stale" : ""}`}>
                {mt.label} on {formatDate(date) ?? date}
                {stale && <>. This is not recent data.</>}
              </p>
            )}
          </div>
        );
      })()}

      {/* layer picker */}
      <div className={`layers ${layersOpen ? "" : "collapsed"}`}>
        <div className="layers-stack">
          <button
            className="layers-toggle"
            aria-expanded={layersOpen}
            onClick={() => setLayersOpen((o) => !o)}
          >
            <span>Weather &amp; Soil Maps</span>
            <svg className="layers-chevron" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 9l7 7 7-7" />
            </svg>
          </button>
          {layersOpen &&
            LAYERS.map((l) => (
              <div className="layer-row" key={l.key}>
                <span className="layer-label">{l.label}</span>
                <button
                  className={`layer-btn ${layer === l.key ? "active" : ""}`}
                  aria-label={l.label}
                  aria-pressed={layer === l.key}
                  disabled={!l.available}
                  title={l.available ? l.label : `${l.label}: no data yet`}
                  onClick={() => setLayer((prev) => (prev === l.key ? null : l.key))}
                >
                  <img
                    src={layer === l.key ? l.iconClicked : l.icon}
                    alt=""
                    draggable={false}
                  />
                </button>
              </div>
            ))}
        </div>
      </div>

      {/* bottom sheet */}
      <section className={`sheet ${dragging ? "dragging" : ""}`} ref={sheetRef} aria-label={sheetTitle.charAt(0) + sheetTitle.slice(1).toLowerCase()}>
        {sheetView === "farms" && (
          <button className="sheet-back" onClick={openDashboardView}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 5l-7 7 7 7" />
            </svg>
            Dashboard
          </button>
        )}
        <button
          className={`sheet-head ${viewClass}`}
          style={sheetView === "setup" && setupBg ? ({ "--setup-bg": `url(${setupBg})` } as React.CSSProperties) : undefined}
          onClick={() => {
            if (suppressClick.current) return; // this tap was the end of a drag
            setSheet((s) => (s === "full" ? "peek" : "full"));
          }}
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={onHandleUp}
          aria-expanded={sheet === "full"}
        >
          <span className="sheet-handle" />
          <span className="sheet-title">{sheetTitle}</span>
        </button>

        <div className={`sheet-body ${viewClass}`}>
          {sheetView === "setup" && activeFarm ? (
            <SetupForm
              key={activeFarm.id}
              farm={activeFarm}
              place={place}
              onSubmit={saveSetup}
              onBack={() => {
                setSelectedPlotId(null);
                setSheetView("dashboard");
                setSheet("half");
              }}
              focusPlotId={selectedPlotId}
              onPlotsChange={setLivePlots}
              onDrawPlot={startPlotDraw}
              pendingOutline={plotOutline}
              onOutlineApplied={() => setPlotOutline(null)}
              onShowUndo={showUndo}
              onClearUndo={hideUndo}
            />
          ) : sheetView === "plan" ? (
            <PlanNext
              onBack={() => {
                setSheetView("dashboard");
                setSheet("half");
              }}
            />
          ) : sheetView === "dashboard" || sheetView === "setup" ? (
            <>
            <div className="dash-card">
              {!poly.closed ? (
                <p className="hint">
                  {drawing
                    ? "Tap the map to place the corners of your field. Tap a point to delete it. Tap the orange first point to finish."
                    : "No farm selected. Open the menu to pick or add a farm."}
                </p>
              ) : (
                <>
                  <div className="dash-top">
                    <div className="dash-place">
                      <img src={locationDashboard} alt="" draggable={false} />
                      <span>{activeFarm?.name ?? "Farm"}</span>
                    </div>
                    <div className="dash-date">
                      <div className="dash-date-text">
                        <span>{dashDate.line1}</span>
                        <span>{dashDate.line2}</span>
                      </div>
                      <img className="dash-weather" src={weather.src} alt={weather.label} draggable={false} />
                    </div>
                  </div>

                  {error && <DataNotice message={friendlyError(error)} onRetry={retryRegion} loadedAt={loadedAt} />}
                  {loading && <LoadingNote text="Loading satellite data…" />}
                  {gridError && !dates && (
                    <DataNotice message={friendlyError(gridError)} onRetry={retryLayers} />
                  )}

                  <div className="dash-metrics">
                    {readings.map((r) => {
                      const f = formatReading(r.key, current?.[r.key]);
                      return (
                        <div className="dash-metric" key={r.key}>
                          <img src={r.icon} alt="" draggable={false} />
                          <b className="dash-value">
                            {f.value}
                            {f.unit && <small>{f.unit}</small>}
                          </b>
                          <span className="dash-label">{r.label}</span>
                          <span className={`status-pill ${statusOf(r.key).level}`}>{statusOf(r.key).label}</span>
                        </div>
                      );
                    })}
                  </div>

                  {/* what the numbers mean, in plain words */}
                  <ul className="dash-meanings">
                    {readings.map((r) => {
                      const st = statusOf(r.key);
                      return st.text ? (
                        <li className={st.level} key={r.key}>
                          <b>{sentenceCase(r.label)}:</b> {st.text}
                        </li>
                      ) : null;
                    })}
                  </ul>
                  {current && date && (
                    <p className={`dash-asof ${stale ? "stale" : ""}`}>
                      Data as of {formatDate(date) ?? date}
                      {loadedAt != null && <> &middot; loaded {agoText(loadedAt)}</>}
                      {stale && <>. This is not recent data.</>}
                    </p>
                  )}

                  {dates && dates.length > 1 && (() => {
                    const lastI = dates.length - 1;
                    const i = Math.min(day, lastI);
                    const behind = lastI - i;
                    return pastMode ? (
                      <div className="dash-picker" role="group" aria-label="Choose a day">
                        <div className="dp-head">
                          <button type="button" className="dp-step" aria-label="Previous day" disabled={i <= 0} onClick={() => setDay(i - 1)}>
                            ‹
                          </button>
                          <div className="dp-date" aria-live="polite">
                            {shortDate(dates[i])}
                            <small>{behind === 0 ? "Latest data" : `${behind} day${behind === 1 ? "" : "s"} before the latest`}</small>
                          </div>
                          <button type="button" className="dp-step" aria-label="Next day" disabled={i >= lastI} onClick={() => setDay(i + 1)}>
                            ›
                          </button>
                        </div>
                        <input
                          className="tl-range dp-range"
                          type="range"
                          min={0}
                          max={lastI}
                          value={i}
                          aria-label="Day"
                          aria-valuetext={shortDate(dates[i])}
                          style={{ "--pct": `${(i / (lastI || 1)) * 100}%` } as React.CSSProperties}
                          onChange={(e) => setDay(Number(e.target.value))}
                        />
                        <button type="button" className="dash-past" onClick={() => setPastMode(false)}>
                          Back to latest data
                        </button>
                      </div>
                    ) : (
                      <button type="button" className="dash-past" onClick={() => openPast(true)}>
                        View past data
                      </button>
                    );
                  })()}

                  <button className="dash-details" onClick={() => setSheetView("condition")}>
                    See details
                  </button>
                  {activeFarm && (
                    <button className="dash-details secondary" onClick={openEditDetails}>
                      Edit farm details
                    </button>
                  )}
                  {activeFarm && poly.closed && (
                    <button className="dash-details plan-cta" onClick={() => { setSheetView("plan"); setSheet("full"); }}>
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M7 20h10" />
                        <path d="M10 20c5.5-2.5.8-6.4 3-10" />
                        <path d="M9.5 9.4c1.1.8 1.8 2.2 2.3 3.7-2 .4-3.5.4-4.8-.3-1.2-.6-2.3-1.9-3-4.2 2.8-.5 4.4 0 5.5.8z" />
                        <path d="M14.1 6a7 7 0 0 0-1.1 4c1.9-.1 3.3-.6 4.3-1.4 1-1 1.6-2.3 1.7-4.6-2.7.1-4 1-4.9 2z" />
                      </svg>
                      Plan next season
                    </button>
                  )}
                </>
              )}
            </div>

            {poly.closed && activeFarm && (
              <>
                <section className="dash-panel" aria-label="Yield">
                  <h3 className="dash-panel-title">YIELD</h3>
                  <YieldChart farm={activeFarm} />
                </section>

                <h3 className="dash-heading">COMMODITIES AND FOOD</h3>
                <div className="commodities">
                  {COMMODITIES.map((c) => (
                    <div className="commodity" key={c.key} role="img" aria-label={c.label} title={c.label}>
                      {c.src ? <img src={c.src} alt="" draggable={false} /> : <span aria-hidden="true">{c.emoji}</span>}
                    </div>
                  ))}
                </div>

                <h3 className="dash-heading">MY FARMS</h3>
                <FarmCarousel farms={farms} activeId={activeId} onSelect={selectFarm} onAdd={startNewFarm} />
              </>
            )}
            </>
          ) : sheetView === "farms" ? (
            <div className="farm-grid">
              {farms.length === 0 && (
                <p className="hint">No farms yet. Open the menu to add one.</p>
              )}
              {farms.map((f) => (
                <div className="farm-card-wrap" key={f.id}>
                  <button
                    className={`farm-card ${f.id === activeId ? "active" : ""}`}
                    onClick={() => selectFarm(f)}
                  >
                    <FarmThumb points={f.points} />
                    <span className="farm-card-name">{f.name}</span>
                  </button>
                  <button
                    type="button"
                    className="farm-card-delete"
                    aria-label={`Delete ${f.name}`}
                    title="Delete this farm"
                    onClick={() => deleteFarm(f.id)}
                  >
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M4 7h16" />
                      <path d="M10 11v6" />
                      <path d="M14 11v6" />
                      <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
                      <path d="M9 7V4h6v3" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <>
          <button className="dash-back-link" onClick={() => setSheetView("dashboard")}>
            ‹ Back to dashboard
          </button>
          {activeFarm && poly.closed && (
            <FarmSummary farm={activeFarm} place={place} onEdit={openEditDetails} onDelete={() => deleteFarm(activeFarm.id)} />
          )}
          {gridError && <DataNotice message={friendlyError(gridError)} onRetry={retryLayers} />}

          {!poly.closed && (
            <p className="hint">
              Tap the map to place the corners of your field. Tap a point to delete it. Tap the orange first point to finish.
            </p>
          )}
          {poly.closed && loading && <LoadingNote text="Loading satellite data…" />}
          {poly.closed && error && <DataNotice message={friendlyError(error)} onRetry={retryRegion} loadedAt={loadedAt} />}
          {poly.closed && data && !current && <p className="hint">No farm data for this date.</p>}

          {poly.closed && (
            <p className="hint">The day slider and today's readings are on the map. Collapse this sheet to see them.</p>
          )}
            </>
          )}
        </div>
      </section>

      {/* shown over the map while a layer is loading, or when it could not be loaded */}
      {dataLayer && (gridError || layerBusy || !bounds) && (
        <div className={`map-notice ${showTimeline ? "above-legend" : ""}`} role="status">
          {gridError ? (
            <>
              <span>{friendlyError(gridError)}</span>
              <button onClick={retryLayers}>Try again</button>
            </>
          ) : (
            <>
              <span className="spinner" aria-hidden="true" />
              <span>Loading the {metric?.label.toLowerCase()} layer…</span>
            </>
          )}
        </div>
      )}

      {/* first-visit prompt: no farm yet */}
      {welcome && (
        <div className="welcome-backdrop">
          <div className="welcome-card" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
            <h2 id="welcome-title">Add your first farm</h2>
            <p>
              You have no farm selected yet. Tap the button, then tap the map to place the corners of
              your field. Tap the orange first point to finish.
            </p>
            <button className="welcome-btn" onClick={startNewFarm}>
              Add a new farm
            </button>
          </div>
        </div>
      )}

      {/* slide-out menu (sits above everything else) */}
      <div
        className={`menu-backdrop ${menuOpen ? "open" : ""}`}
        onClick={() => setMenuOpen(false)}
      />
      <nav className={`side-menu ${menuOpen ? "open" : ""}`} aria-label="Main menu">
        <div className="side-menu-header">
          <img className="side-menu-logo" src={logo} alt="Oryzon" draggable={false} />
        </div>
        <div className="side-menu-items">
          <button
            className={`side-menu-item ${sheetView === "dashboard" ? "active" : ""}`}
            aria-current={sheetView === "dashboard" ? "page" : undefined}
            tabIndex={menuOpen ? 0 : -1}
            onClick={openDashboardView}
          >
            Dashboard
          </button>
          <div className="myfarms">
            <div className="myfarms-row">
              <button className="myfarms-main" tabIndex={menuOpen ? 0 : -1} onClick={openFarmsView}>
                My Farms
              </button>
              <button
                className="myfarms-toggle"
                aria-label={farmsOpen ? "Hide farm list" : "Show farm list"}
                aria-expanded={farmsOpen}
                tabIndex={menuOpen ? 0 : -1}
                onClick={() => setFarmsOpen((o) => !o)}
              >
                <svg className={farmsOpen ? "open" : ""} viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
            </div>

            {farmsOpen && (
              <div className="myfarms-list">
                {farms.length === 0 && <p className="hint">No farms yet.</p>}
                {farms.map((f) => (
                  <div className="side-menu-row" key={f.id}>
                    <button
                      className={`side-menu-item ${f.id === activeId ? "active" : ""}`}
                      aria-current={f.id === activeId ? "true" : undefined}
                      tabIndex={menuOpen ? 0 : -1}
                      onClick={() => selectFarm(f)}
                    >
                      {f.name}
                    </button>
                    <button
                      className="side-menu-delete"
                      aria-label={`Delete ${f.name}`}
                      tabIndex={menuOpen ? 0 : -1}
                      onClick={() => deleteFarm(f.id)}
                    >
                      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 7h16" />
                        <path d="M10 11v6" />
                        <path d="M14 11v6" />
                        <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
                        <path d="M9 7V4h6v3" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <button
            className="side-menu-item add"
            tabIndex={menuOpen ? 0 : -1}
            onClick={startNewFarm}
          >
            + Add new map
          </button>
        </div>
      </nav>

      {/* "Deleted. Undo" */}
      {undoItem && (
        <div className="undo-toast" role="status">
          <span>{undoItem.message}</span>
          <button
            type="button"
            onClick={() => {
              undoItem.undo();
              hideUndo();
            }}
          >
            Undo
          </button>
        </div>
      )}
    </div>
  );
}