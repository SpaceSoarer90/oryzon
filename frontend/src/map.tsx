import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import {
  MapContainer,
  TileLayer,
  Polygon,
  Polyline,
  CircleMarker,
  Marker,
  Tooltip,
  useMap,
  useMapEvents,
} from "react-leaflet";
import type { Advice, DayData, GridMeta, GridPoint, LatLng, MetricKey } from "./types";
import { fetchDay, fetchMeta, fetchRegionData, toGeoJSONPolygon } from "./api";
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
  totalYield: string; // digits and at most one decimal point
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
  totalYield: "",
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
  const num = String(d.totalYield ?? "").match(/\d+(\.\d+)?|\.\d+/);
  d.totalYield = num ? num[0] : "";
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

const MOISTURE_MAX = 60;
const CROPS = ["Rice", "Corn", "Onion", "Garlic", "Mung beans", "Vegetables", "Other"];
const PERFORMANCES: { value: Performance; label: string }[] = [
  { value: "good", label: "Good Harvest" },
  { value: "average", label: "Average Harvest" },
  { value: "poor", label: "Poor Harvest" },
  { value: "failure", label: "Crop Failure" },
  { value: "unknown", label: "I don't know" },
];
const SOIL_TEXTURES = [
  "Clay",
  "Silty clay",
  "Sandy clay",
  "Clay loam",
  "Silty clay loam",
  "Sandy clay loam",
  "Loam",
  "Silt loam",
  "Sandy loam",
  "Loamy sand",
  "Sand",
  "I don't know",
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
  if (d && (d.lastCrop || d.totalYield || d.harvestDate)) {
    plot.cropRecords = [
      { ...newCropRecord(), crop: d.lastCrop, amount: d.totalYield, unit: d.yieldUnit, harvestDate: d.harvestDate },
    ];
  }
  plot.soil.soilTest = d?.soilTest ?? null;
  return [plot];
}

interface Farm {
  id: string;
  name: string;
  points: LatLng[];
  location?: string; // filled in on the Set up farm screen
  details?: FarmDetails;
  plots?: Plot[]; // each plot: its name, area, past crop records and soil readings
}
interface FarmStore {
  farms: Farm[];
  activeId: string | null;
}
const FARMS_KEY = "oryzon:farms";
const LEGACY_KEY = "oryzon:farm"; // an earlier version stored a single outline

const isPoints = (v: unknown): v is LatLng[] =>
  Array.isArray(v) &&
  v.length >= 3 &&
  v.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite));

function loadStore(): FarmStore {
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
  { key: "precipitation", label: "Precipitation", unit: " mm/day", color: "#2f7fd1" },
  { key: "temperature", label: "Temperature", unit: " °C", color: "#e0773a" },
  // Set `unit` from the file (e.g. " m³/m³" if its metadata says so, "" for a plain 0-1 wetness fraction).
  { key: "soilMoisture", label: "Soil moisture", unit: "", color: "#8a5a2b" },
];

// The three layer buttons on the right side of the screen.
// `available` = the backend has data for it. Set it to false to grey a button out.
type LayerKey = MetricKey;

const LAYERS: { key: LayerKey; label: string; icon: string; iconClicked: string; available: boolean }[] = [
  { key: "temperature", label: "Temperature", icon: temperatureIcon, iconClicked: temperatureClicked, available: true },
  { key: "soilMoisture", label: "Soil Moisture", icon: soilMoistureIcon, iconClicked: soilMoistureClicked, available: true },
  { key: "precipitation", label: "Precipitation", icon: precipitationIcon, iconClicked: precipitationClicked, available: true },
];

const isMetric = (k: LayerKey | null): k is MetricKey => METRICS.some((m) => m.key === k);

const farmIcon = L.divIcon({
  className: "",
  html: '<div class="farm-pin">🏠</div>',
  iconSize: [36, 36],
  iconAnchor: [18, 18],
});

/* ---------- helpers ---------- */

function centroid(points: LatLng[]): LatLng {
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

// Placeholder rule: pick the weather picture from the day's rainfall (mm/day). Tune the numbers later.
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

/* ---------- map layers ---------- */

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
    map.fitBounds(L.latLngBounds(points), {
      paddingTopLeft: [40, 100],
      paddingBottomRight: [40, Math.round(window.innerHeight * 0.5)],
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

// The label / value rows shown under "Farm details" in the Condition view.
function farmDetailRows(farm: Farm, place: string | null): [string, string][] {
  const d = farm.details;
  const or = (v: string | undefined | null) => (v && v.trim() ? v.trim() : "Not provided");
  const waterText: Record<Water, string> = {
    rainfed: "Rain-fed",
    irrigation: "Irrigation",
    both: "Rain-fed and irrigation",
  };
  const unitLabel = YIELD_UNITS.find((u) => u.value === d?.yieldUnit)?.label ?? "tons";
  const yieldText = d?.totalYield && /\d/.test(d.totalYield) ? `${d.totalYield} ${unitLabel}` : "Not provided";
  const rows: [string, string][] = [
    ["Location", or(farm.location || place)],
    ["Farm size", `${polygonAreaHa(farm.points).toFixed(2)} ha`],
  ];

  if (farm.plots && farm.plots.length > 0) {
    // New format: one group of rows per plot.
    farm.plots.forEach((p, i) => {
      const label = plotLabel(p, i);
      rows.push([`${label}: area`, p.area && /\d/.test(p.area) ? `${p.area} ha` : "Not provided"]);
      const r = latestRecord(p);
      rows.push([`${label}: last crop`, or(r?.crop)]);
      if (r) {
        rows.push([`${label}: planted`, or(r.plantingDate ? formatDate(r.plantingDate) : null)]);
        rows.push([`${label}: harvested`, or(r.harvestDate ? formatDate(r.harvestDate) : null)]);
        rows.push([`${label}: harvest amount`, or(amountText(r))]);
        rows.push([`${label}: performance`, r.performance ? PERFORMANCE_LABEL[r.performance] : "Not provided"]);
      }
      if (p.cropRecords.filter((x) => !recordBlank(x)).length > 1) {
        rows.push([`${label}: crop records`, String(p.cropRecords.filter((x) => !recordBlank(x)).length)]);
      }
      rows.push([`${label}: soil texture`, or(p.soil.texture)]);
      rows.push([
        `${label}: soil moisture`,
        p.soil.moisture === null
          ? "Not provided"
          : `${p.soil.moisture}% VWC${p.soil.depth ? ` at ${p.soil.depth} cm` : ""}${p.soil.source ? ` (${SOURCE_LABEL[p.soil.source]})` : ""}`,
      ]);
      rows.push([`${label}: soil test results`, p.soil.soilTest == null ? "Not provided" : p.soil.soilTest ? "Yes" : "No"]);
    });
    rows.push(["Water availability", d?.water ? waterText[d.water] : "Not provided"]);
  } else {
    // Farms saved before plots existed.
    rows.push(
      ["Last crop planted", or(d?.lastCrop)],
      ["Total yield", yieldText],
      ["Harvest date", or(d?.harvestDate ? formatDate(d.harvestDate) : null)],
      ["Water availability", d?.water ? waterText[d.water] : "Not provided"],
    );
  }

  if (d?.water === "irrigation" || d?.water === "both") {
    const source = IRRIGATION_SOURCES.find((o) => o.value === d.irrigationSource)?.label;
    rows.push(["Irrigation water source", or(source)]);
    if (d.irrigationSource === "government") {
      rows.push(["Irrigation starts", or(d.irrigationStart ? formatDate(d.irrigationStart) : null)]);
      rows.push(["Irrigation ends", or(d.irrigationEnd ? formatDate(d.irrigationEnd) : null)]);
    }
  }
  if (!(farm.plots && farm.plots.length > 0)) {
    rows.push(["Soil test results", d?.soilTest == null ? "Not provided" : d.soilTest ? "Yes" : "No"]);
  }
  return rows;
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
  const amount = d ? parseFloat(d.totalYield) : NaN;
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

const YES_NO: { value: "yes" | "no"; label: string }[] = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
];

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
  const updateSoil = (patch: Partial<SoilInfo>) => updatePlot({ soil: { ...plot.soil, ...patch } });
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
  function removePlot() {
    if (plots.length < 2) return;
    if (
      plot.cropRecords.some((x) => !recordBlank(x)) &&
      !window.confirm(`Remove ${plotLabel(plot, plotIndex)} and its crop records?`)
    )
      return;
    setPlots((prev) => prev.filter((p) => p !== plot));
    setActive(Math.max(0, plotIndex - 1));
  }

  // Computed from the outline, never typed in.
  const sizeHa = polygonAreaHa(farm.points);
  const waterOptions: { value: Water; label: string }[] = [
    { value: "rainfed", label: "Rain-fed" },
    { value: "irrigation", label: "Irrigation" },
    { value: "both", label: "Both" },
  ];
  const usesIrrigation = d.water === "irrigation" || d.water === "both";
  const isGovernment = usesIrrigation && d.irrigationSource === "government";
  const datesBackwards = isGovernment && d.irrigationStart && d.irrigationEnd && d.irrigationEnd < d.irrigationStart;

  const plotsValid = plots.every(
    (p) => p.area !== "." && p.cropRecords.every((r) => r.amount !== "." && !recordError(r)),
  );
  const step1Valid = name.trim().length > 0 && plotsValid;
  const canSave = step1Valid && !datesBackwards;

  function goToStep(next: 1 | 2) {
    setStep(next);
    // The sheet body is the scrolling part; start the new page at the top.
    formRef.current?.closest(".sheet-body")?.scrollTo({ top: 0 });
  }

  // Only keep irrigation answers that still apply, and drop blank crop records.
  function cleanedDetails(): FarmDetails {
    return {
      ...d,
      irrigationSource: usesIrrigation ? d.irrigationSource : "",
      irrigationStart: isGovernment ? d.irrigationStart : "",
      irrigationEnd: isGovernment ? d.irrigationEnd : "",
      // These old farm-level answers now live in each plot's crop records and soil answers.
      lastCrop: "",
      totalYield: "",
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

          <h3 className="setup-heading">Soil Characteristics</h3>
          {plots.length > 1 && tabs}

          <label className="setup-field">
            <span>What is your soil texture?</span>
            <select value={plot.soil.texture} onChange={(e) => updateSoil({ texture: e.target.value })}>
              <option value="">Select a texture</option>
              {SOIL_TEXTURES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>

          <div className="setup-field">
            <div className="setup-slider-head">
              <label htmlFor="soil-moisture">Soil Moisture</label>
              <small>Volumetric Water Content (VWC)</small>
              <output htmlFor="soil-moisture" className={plot.soil.moisture === null ? "unset" : ""}>
                {plot.soil.moisture === null ? "Not set" : `${plot.soil.moisture}%`}
              </output>
            </div>
            <div className="setup-slider">
              <input
                id="soil-moisture"
                type="range"
                min={0}
                max={MOISTURE_MAX}
                step={1}
                value={plot.soil.moisture ?? 15}
                onChange={(e) => updateSoil({ moisture: Number(e.target.value) })}
              />
            </div>
            <div className="setup-scale">
              <span>0% - Dry</span>
              {plot.soil.moisture !== null && (
                <button type="button" className="setup-link" onClick={() => updateSoil({ moisture: null })}>
                  Clear
                </button>
              )}
              <span>{MOISTURE_MAX}% - High Reading</span>
            </div>
          </div>

          <label className="setup-field">
            <span>Measurement depth (cm)</span>
            <input
              value={plot.soil.depth}
              onChange={(e) => updateSoil({ depth: sanitizeDecimal(e.target.value) })}
              inputMode="decimal"
              placeholder="e.g. 15"
              autoComplete="off"
            />
          </label>

          <RadioList
            label="Where did the measurement come from?"
            name={`source-${plot.id}`}
            value={plot.soil.source}
            options={SOIL_SOURCES}
            onChange={(v) => updateSoil({ source: v })}
          />

          <h3 className="setup-heading">Soil Nutrient Assessment</h3>
          <RadioList
            row
            label="Do you have soil test results?"
            name={`soiltest-${plot.id}`}
            value={plot.soil.soilTest === null ? "" : plot.soil.soilTest ? "yes" : "no"}
            options={YES_NO}
            onChange={(v) => updateSoil({ soilTest: v === "yes" })}
          />

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

          {usesIrrigation && (
            <label className="setup-field">
              <span>For irrigation, what is your water source?</span>
              <select
                value={d.irrigationSource}
                onChange={(e) => set("irrigationSource", e.target.value as IrrigationSource | "")}
              >
                <option value="">Select a source</option>
                {IRRIGATION_SOURCES.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          )}

          {isGovernment && (
            <>
              <label className="setup-field">
                <span>When does irrigation start to be distributed?</span>
                <input type="date" value={d.irrigationStart} onChange={(e) => set("irrigationStart", e.target.value)} />
              </label>
              <label className="setup-field">
                <span>When does irrigation end?</span>
                <input
                  type="date"
                  value={d.irrigationEnd}
                  min={d.irrigationStart || undefined}
                  onChange={(e) => set("irrigationEnd", e.target.value)}
                />
              </label>
              {datesBackwards && <p className="setup-error">The end date must be on or after the start date.</p>}
            </>
          )}
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

export function FarmMap({ onBack }: { onBack?: () => void }) {
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
  // the slide-out menu on the left
  const [menuOpen, setMenuOpen] = useState(false);
  // what the bottom sheet shows: the Dashboard, the detailed Condition view, the My Farms screen,
  // or the Set up farm form (opens right after a new outline is finished)
  const [sheetView, setSheetView] = useState<"dashboard" | "condition" | "farms" | "setup">("dashboard");
  // the "My Farms" drop-down in the menu
  const [farmsOpen, setFarmsOpen] = useState(false);
  // the farm in the menu that is waiting for "Delete?" confirmation
  const [confirmId, setConfirmId] = useState<string | null>(null);

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
  const [day, setDay] = useState<number>(0); // index into dates
  const [grid, setGrid] = useState<{ layer: MetricKey; points: GridPoint[] } | null>(null);
  const [gridError, setGridError] = useState<string | null>(null);
  const cache = useRef<Record<string, GridPoint[]>>({}); // key: "layer:date"

  const dataLayer = isMetric(layer) ? layer : null;
  const metric = METRICS.find((m) => m.key === dataLayer);

  // One shared slider. Its days come from the first layer the backend reports.
  const firstMeta = METRICS.map((m) => metas[m.key]).find((m) => m !== undefined);
  const dates = firstMeta ? firstMeta.dates : null;
  const date = dates ? dates[Math.min(day, dates.length - 1)] : null;

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

  // Forget any pending "Delete?" question when the menu closes.
  useEffect(() => {
    if (!menuOpen) setConfirmId(null);
  }, [menuOpen]);

  // Close the slide-out menu with the Esc key.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  // Load each layer's dates, cell size and colour range once.
  useEffect(() => {
    const controller = new AbortController();
    METRICS.forEach((m) => {
      fetchMeta(m.key, controller.signal)
        .then((meta) => setMetas((prev) => ({ ...prev, [m.key]: meta })))
        .catch((e) => {
          if (e.name !== "AbortError") setGridError(e.message);
        });
    });
    return () => controller.abort();
  }, []);

  // Fetch the grid for the selected layer and day. Cached days are instant; a stale request is cancelled.
  useEffect(() => {
    if (!dataLayer || !date) return;
    const key = `${dataLayer}:${date}`;
    const cached = cache.current[key];
    if (cached) {
      setGrid({ layer: dataLayer, points: cached });
      setGridError(null);
      return;
    }
    const controller = new AbortController();
    fetchDay(dataLayer, date, controller.signal)
      .then((g) => {
        cache.current[key] = g.points;
        setGrid({ layer: dataLayer, points: g.points });
        setGridError(null);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setGridError(e.message);
      });
    return () => controller.abort();
  }, [dataLayer, date]);

  // Load region data once the shape is closed.
  useEffect(() => {
    if (!poly.closed || poly.points.length < 3) {
      setData(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    fetchRegionData(toGeoJSONPolygon(poly.points), controller.signal)
      .then(setData)
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [poly]);

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

  // Show a saved farm on the map.
  function selectFarm(f: Farm) {
    setSelectedPlotId(null);
    setMenuOpen(false);
    setWelcome(false);
    setDrawing(false);
    setActiveId(f.id);
    setPolygon({ closed: true, points: f.points });
    setSheetView("dashboard");
    setSheet("half");
    setFitNonce((n) => n + 1);
  }

  // Remove a saved farm. If it was the one on the map, show another one (or go back to the first-visit prompt).
  function deleteFarm(id: string) {
    const remaining = farms.filter((f) => f.id !== id);
    setFarms(remaining);
    setConfirmId(null);
    if (id !== activeId) return;
    setSelectedPlotId(null);

    const next = remaining[0] ?? null;
    if (next) {
      setActiveId(next.id);
      setPolygon({ closed: true, points: next.points });
      setFitNonce((n) => n + 1);
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

  const pillText = plotDraw
    ? "Outline your plot on the map"
    : poly.closed
      ? activeFarm?.location || place || "Locating…"
      : "Outline your farm on the map";
  const shownPlots = sheetView === "setup" ? livePlots : savedPlots;
  const selectedPlot = shownPlots.find((p) => p.id === selectedPlotId);
  const drawingPlot = plotDraw ? livePlots.find((p) => p.id === plotDraw.plotId) : undefined;
  const drawingPlotLabel = drawingPlot ? plotLabel(drawingPlot, livePlots.indexOf(drawingPlot)) : "the plot";
  const orderedMetrics = [...METRICS].sort((a, b) => Number(b.key === layer) - Number(a.key === layer));
  const weather = weatherFor(current?.precipitation);
  const dashDate = dashboardDate(date);
  const readings: { key: MetricKey; label: string; icon: string }[] = [
    { key: "temperature", label: "TEMPERATURE", icon: tempDashboard },
    { key: "soilMoisture", label: "SOIL MOISTURE", icon: soilMoistureDashboard },
    { key: "precipitation", label: "PRECIPITATION", icon: precipitationDashboard },
  ];
  const sheetTitle =
    sheetView === "farms" ? "MY FARMS" : sheetView === "setup" ? "SET UP FARM" : sheetView === "dashboard" ? "DASHBOARD" : (activeFarm?.name ?? "Condition").toUpperCase();
  const viewClass = sheetView === "condition" ? "" : sheetView === "setup" ? "setup" : "banner";
  const gridShown = grid !== null && grid.layer === dataLayer ? grid.points : null;

  return (
    <div className={`app sheet-${sheet}`}>
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
        {metric && gridShown && <GridLayer points={gridShown} color={metric.color} unit={metric.unit} />}
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
      </MapContainer>

      {/* top bar */}
      <div className="topbar">
        <button
          className="menu-btn"
          aria-label="Menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(true)}
        >
          <span /><span /><span />
        </button>
        <div className="place-pill">
          <span className="place-text">{pillText}</span>
          <button className="add-btn" aria-label="Add a new farm" onClick={startNewFarm}>+</button>
        </div>
      </div>

      {onBack && (
        <button className="back-btn" aria-label="Back to home" onClick={onBack}>
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </button>
      )}

      {poly.closed && activeFarm && <div className="farm-label">{activeFarm.name}</div>}

      {/* checking / water warning */}
      {checkingArea && <div className="map-toast" role="status">Checking that the area is land…</div>}
      {drawError && (
        <div className={`map-toast error ${plotDraw ? "above-bar" : ""}`} role="alert">
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
            <button type="button" onClick={cancelPlotDraw}>
              Cancel
            </button>
          </div>
        </div>
      )}

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
      <section className="sheet" aria-label={sheetTitle.charAt(0) + sheetTitle.slice(1).toLowerCase()}>
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
          onClick={() => setSheet((s) => (s === "full" ? "peek" : "full"))}
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

                  {error && <p className="hint error">Couldn't load data: {error}</p>}
                  {loading && <p className="hint">Loading satellite data…</p>}

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
                        </div>
                      );
                    })}
                  </div>

                  <button className="dash-details" onClick={() => setSheetView("condition")}>
                    See details
                  </button>
                  {activeFarm && (
                    <button className="dash-details secondary" onClick={openEditDetails}>
                      Edit farm details
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
                <p className="hint">No farms yet. Tap + at the top, or open the menu, to add one.</p>
              )}
              {farms.map((f) => (
                <button
                  key={f.id}
                  className={`farm-card ${f.id === activeId ? "active" : ""}`}
                  onClick={() => selectFarm(f)}
                >
                  <FarmThumb points={f.points} />
                  <span className="farm-card-name">{f.name}</span>
                </button>
              ))}
            </div>
          ) : (
            <>
          <button className="dash-back-link" onClick={() => setSheetView("dashboard")}>
            ‹ Back to dashboard
          </button>
          {activeFarm && poly.closed && (
            <div className="card farm-info">
              <div className="farm-info-head">
                <h3>Farm details</h3>
                <button className="setup-link" onClick={openEditDetails}>
                  Edit
                </button>
              </div>
              {farmDetailRows(activeFarm, place).map(([label, value], i) => (
                <div className="row" key={`${i}-${label}`}>
                  <span>{label}</span>
                  <b>{value}</b>
                </div>
              ))}
            </div>
          )}
          {gridError && <p className="hint error">{gridError}</p>}

          {/* day slider: drives the map layer, and the farm's values once a shape is drawn */}
          {dates && date && (
            <div className="timeline">
              <label>
                Day: <b>{date}</b>
              </label>
              <input
                type="range"
                min={0}
                max={dates.length - 1}
                value={Math.min(day, dates.length - 1)}
                onChange={(e) => setDay(Number(e.target.value))}
              />
              <p className="hint">
                {gridShown
                  ? `${gridShown.length} grid points on the map`
                  : dataLayer
                    ? "Loading map layer…"
                    : "Pick a layer on the right to show it on the map."}
              </p>
              {dataLayer && metas[dataLayer]?.period === "month" && (
                <p className="hint">Monthly average: every day in a month shows the same value.</p>
              )}
            </div>
          )}

          {!poly.closed && (
            <p className="hint">
              Tap the map to place the corners of your field. Tap a point to delete it. Tap the orange first point to finish.
            </p>
          )}
          {poly.closed && loading && <p className="hint">Loading satellite data…</p>}
          {poly.closed && error && <p className="hint error">Couldn't load data: {error}</p>}
          {poly.closed && data && !current && <p className="hint">No farm data for this date.</p>}

          {data && current && advice && (
            <>
              <div className={`advice ${advice.level}`}>{advice.text}</div>
              <p className="hint">
                Region start: {current.latlong[0].toFixed(3)}, {current.latlong[1].toFixed(3)}
              </p>

              {orderedMetrics.map((m) => {
                const value = current[m.key];
                return (
                  <div className={`card ${layer === m.key ? "active" : ""}`} key={m.key}>
                    <div className="row">
                      <span>{m.label}</span>
                      <b>{value === null ? "no data" : `${value}${m.unit}`}</b>
                    </div>
                    <Chart data={data} field={m.key} index={polyIndex} color={m.color} />
                  </div>
                );
              })}
              <p className="hint">Averaged over grid points in the area; small areas use the nearest grid point.</p>
            </>
          )}
            </>
          )}
        </div>
      </section>

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
                {farms.map((f) =>
                  confirmId === f.id ? (
                    <div className="side-menu-confirm" key={f.id}>
                      <span>Delete {f.name}?</span>
                      <button className="confirm-btn cancel" onClick={() => setConfirmId(null)}>
                        Cancel
                      </button>
                      <button className="confirm-btn danger" onClick={() => deleteFarm(f.id)}>
                        Delete
                      </button>
                    </div>
                  ) : (
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
                        onClick={() => setConfirmId(f.id)}
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
                  ),
                )}
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
    </div>
  );
}