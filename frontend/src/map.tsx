import { useEffect, useRef, useState } from "react";
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

// Finds the logo by file name in src/assets, whatever the extension is (.png, .jpg, .webp, .svg...).
const logoFiles = import.meta.glob("./assets/logo.*", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;
const logo = Object.values(logoFiles)[0] ?? "";

interface ThePolygon {
  closed: boolean;
  points: LatLng[];
}
const EMPTY: ThePolygon = { closed: false, points: [] };

// A saved farm (one "map" the user monitors). The list is remembered in this browser.
interface Farm {
  id: string;
  name: string;
  points: LatLng[];
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
}: {
  poly: ThePolygon;
  setPolygon: React.Dispatch<React.SetStateAction<ThePolygon>>;
  drawing: boolean;
}) {
  const map = useMap();

  useMapEvents({
    click(e) {
      if (!drawing) return;
      const pt: LatLng = [e.latlng.lat, e.latlng.lng];
      setPolygon((prev) => {
        // Close the shape when the tap lands near the first point (measured in screen pixels,
        // so it feels the same at every zoom level).
        if (prev.points.length >= 3) {
          const first = map.latLngToContainerPoint(prev.points[0]);
          if (first.distanceTo(e.containerPoint) <= CLOSE_PX) {
            return { ...prev, closed: true };
          }
        }
        return { ...prev, points: [...prev.points, pt] };
      });
    },
  });

  return (
    <>
      {poly.closed ? (
        <Polygon
          positions={poly.points}
          pathOptions={{ color: "#7bd88f", weight: 3, fillColor: "#7bd88f", fillOpacity: 0.18 }}
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
          pathOptions={
            i === 0
              ? { color: "#fff", weight: 2, fillColor: "#e0773a", fillOpacity: 1 }
              : { color: "#fff", weight: 2, fillColor: "#2e9e5b", fillOpacity: 1 }
          }
        />
      ))}

      {poly.closed && <Marker position={centroid(poly.points)} icon={farmIcon} interactive={false} />}
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

/* ---------- main screen ---------- */

export function FarmMap({ onBack }: { onBack?: () => void }) {
  // Farms saved on earlier visits (empty the first time).
  const [initial] = useState(loadStore);
  const [farms, setFarms] = useState<Farm[]>(initial.farms);
  // the farm shown on the map; null while a new one is being outlined
  const [activeId, setActiveId] = useState<string | null>(initial.activeId);
  const activeFarm = farms.find((f) => f.id === activeId) ?? null;
  const [startFarm] = useState(activeFarm);
  const [poly, setPolygon] = useState<ThePolygon>(
    startFarm ? { closed: true, points: startFarm.points } : EMPTY,
  );
  const [drawing, setDrawing] = useState(false);
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
  const [layersOpen, setLayersOpen] = useState(true);
  // peek = just the "CONDITION" bar, half = partly open, full = covers the whole screen
  const [sheet, setSheet] = useState<"peek" | "half" | "full">("peek");
  // the slide-out menu on the left
  const [menuOpen, setMenuOpen] = useState(false);
  // what the bottom sheet shows: the Condition dashboard, or the My Farms screen
  const [sheetView, setSheetView] = useState<"condition" | "farms">("condition");
  // the "My Farms" drop-down in the menu
  const [farmsOpen, setFarmsOpen] = useState(false);
  // the farm in the menu that is waiting for "Delete?" confirmation
  const [confirmId, setConfirmId] = useState<string | null>(null);

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
  }, [poly, activeId]);

  // Remember the farms in this browser.
  useEffect(() => {
    try {
      localStorage.setItem(FARMS_KEY, JSON.stringify({ farms, activeId }));
    } catch {
      /* storage unavailable: farms just won't be remembered */
    }
  }, [farms, activeId]);

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
    setMenuOpen(false);
    setWelcome(false);
    setDrawing(false);
    setActiveId(f.id);
    setPolygon({ closed: true, points: f.points });
    setSheetView("condition");
    setSheet("half");
    setFitNonce((n) => n + 1);
  }

  // Remove a saved farm. If it was the one on the map, show another one (or go back to the first-visit prompt).
  function deleteFarm(id: string) {
    const remaining = farms.filter((f) => f.id !== id);
    setFarms(remaining);
    setConfirmId(null);
    if (id !== activeId) return;

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
      setSheetView("condition");
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

  function startNewFarm() {
    setSheetView("condition");
    setMenuOpen(false);
    setWelcome(false);
    setActiveId(null);
    setPolygon(EMPTY);
    setDrawing(true);
    setData(null);
    setError(null);
    setSheet("peek");
  }

  const pillText = poly.closed ? place ?? "Locating…" : "Outline your farm on the map";
  const orderedMetrics = [...METRICS].sort((a, b) => Number(b.key === layer) - Number(a.key === layer));
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
        <DrawLayer poly={poly} setPolygon={setPolygon} drawing={drawing} />
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

      {/* layer picker */}
      <div className={`layers ${layersOpen ? "" : "collapsed"}`}>
        <div className="layers-stack">
          <button
            className="layers-toggle"
            aria-label={layersOpen ? "Hide layers" : "Show layers"}
            aria-expanded={layersOpen}
            onClick={() => setLayersOpen((o) => !o)}
          >
            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 8l8 8 8-8" />
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

      {/* weather chip */}
      {current?.temperature != null && (
        <div className="weather-chip">☀️ {Math.round(current.temperature)}°</div>
      )}

      {/* bottom sheet */}
      <section className="sheet" aria-label={sheetView === "farms" ? "My farms" : "Condition"}>
        <button
          className={`sheet-head ${sheetView === "farms" ? "farms" : ""}`}
          onClick={() => setSheet((s) => (s === "full" ? "peek" : "full"))}
          aria-expanded={sheet === "full"}
        >
          <span className="sheet-handle" />
          <span className="sheet-title">{sheetView === "farms" ? "MY FARMS" : "CONDITION"}</span>
        </button>

        <div className={`sheet-body ${sheetView === "farms" ? "farms" : ""}`}>
          {sheetView === "farms" ? (
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
              Tap the map to place the corners of your field. Tap the orange first point to finish.
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