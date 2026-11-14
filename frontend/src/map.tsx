import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
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

const START_CENTER: LatLng = [16.155, 119.985]; // Alaminos City, Pangasinan
const START_ZOOM = 16;
const CLOSE_PX = 24; // tap within this many pixels of the first point to close the shape
const FARM_NAME = "FARM 1"; // placeholder until farms can be saved

interface ThePolygon {
  closed: boolean;
  points: LatLng[];
}
const EMPTY: ThePolygon = { closed: false, points: [] };

// Cards in the Condition sheet. Only precipitation has data for now.
const METRICS: { key: MetricKey; label: string; unit: string; color: string }[] = [
  { key: "precipitation", label: "Precipitation", unit: " mm/day", color: "#2f7fd1" },
];

// The three layer buttons on the right side of the screen.
type LayerKey = "temperature" | "soilMoisture" | "precipitation";

const LAYERS: { key: LayerKey; label: string; icon: string; iconClicked: string; available: boolean }[] = [
  { key: "temperature", label: "Temperature", icon: temperatureIcon, iconClicked: temperatureClicked, available: false },
  { key: "soilMoisture", label: "Soil Moisture", icon: soilMoistureIcon, iconClicked: soilMoistureClicked, available: false },
  { key: "precipitation", label: "Precipitation", icon: precipitationIcon, iconClicked: precipitationClicked, available: true },
];

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
  setPolygon: Dispatch<SetStateAction<ThePolygon>>;
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

// One marker per grid point for the selected day (plain dots for now; shading comes next).
function PrecipGrid({ points }: { points: GridPoint[] }) {
  return (
    <>
      {points.map((p) => (
        <CircleMarker
          key={`${p.lat},${p.lon}`}
          center={[p.lat, p.lon]}
          radius={4}
          pathOptions={{ color: "#2f7fd1", weight: 1, fillOpacity: 0.4 }}
        >
          <Tooltip>{p.precipitation === null ? "no data" : `${p.precipitation} mm`}</Tooltip>
        </CircleMarker>
      ))}
    </>
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

  const min = Math.min(0, ...valid); // rainfall starts at zero
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

export function FarmMap() {
  const [poly, setPolygon] = useState<ThePolygon>(EMPTY);
  const [drawing, setDrawing] = useState(true);
  const [layer, setLayer] = useState<LayerKey>("precipitation");
  const [layersOpen, setLayersOpen] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [place, setPlace] = useState<string | null>(null);

  // map layer: every grid point, one day at a time
  const [meta, setMeta] = useState<GridMeta | null>(null);
  const [day, setDay] = useState<number>(0); // index into meta.dates
  const [grid, setGrid] = useState<GridPoint[] | null>(null);
  const [gridError, setGridError] = useState<string | null>(null);
  const cache = useRef<Record<string, GridPoint[]>>({});

  // polygon average: one value per day
  const [data, setData] = useState<DayData[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const date = meta ? meta.dates[day] : null;

  // The polygon data and the map layer share one slider, matched by date (not array position).
  const polyIndex = data && date ? data.findIndex((d) => d.date === date) : -1;
  const current = data && polyIndex >= 0 ? data[polyIndex] : null;
  const advice = data && polyIndex >= 0 ? getAdvice(data, polyIndex) : null;

  // Finishing a shape ends drawing and opens the Condition sheet.
  useEffect(() => {
    if (poly.closed) {
      setDrawing(false);
      setSheetOpen(true);
    }
  }, [poly.closed]);

  // Load the available dates (plus cell size and colour range) once.
  useEffect(() => {
    const controller = new AbortController();
    fetchMeta(controller.signal)
      .then(setMeta)
      .catch((e) => {
        if (e.name !== "AbortError") setGridError(e.message);
      });
    return () => controller.abort();
  }, []);

  // Fetch the grid for the selected day. Cached days are instant; a stale request is cancelled.
  useEffect(() => {
    if (!date) return;
    const cached = cache.current[date];
    if (cached) {
      setGrid(cached);
      setGridError(null);
      return;
    }
    const controller = new AbortController();
    fetchDay(date, controller.signal)
      .then((g) => {
        cache.current[date] = g.points;
        setGrid(g.points);
        setGridError(null);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setGridError(e.message);
      });
    return () => controller.abort();
  }, [date]);

  // Load region data once the shape is closed.
  useEffect(() => {
    if (!poly.closed || poly.points.length < 3) {
      setData(null);
      setError(null);
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

  function startNewFarm() {
    setPolygon(EMPTY);
    setDrawing(true);
    setData(null);
    setError(null);
    setSheetOpen(false);
  }

  const pillText = poly.closed ? place ?? "Locating…" : "Outline your farm on the map";

  return (
    <div className={`app ${sheetOpen ? "sheet-open" : ""}`}>
      <MapContainer
        center={START_CENTER}
        zoom={START_ZOOM}
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
        {layer === "precipitation" && grid && <PrecipGrid points={grid} />}
        <DrawLayer poly={poly} setPolygon={setPolygon} drawing={drawing} />
      </MapContainer>

      {/* top bar */}
      <div className="topbar">
        <button className="menu-btn" aria-label="Menu" onClick={() => { /* TODO: open menu */ }}>
          <span /><span /><span />
        </button>
        <div className="place-pill">
          <span className="place-text">{pillText}</span>
          <button className="add-btn" aria-label="Add a new farm" onClick={startNewFarm}>+</button>
        </div>
      </div>

      {poly.closed && <div className="farm-label">{FARM_NAME}</div>}

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
                  onClick={() => setLayer(l.key)}
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

      {/* rainfall chip for the selected day */}
      {current?.precipitation != null && (
        <div className="weather-chip">🌧️ {current.precipitation.toFixed(1)} mm</div>
      )}

      {/* bottom sheet */}
      <section className="sheet" aria-label="Condition">
        <button
          className="sheet-head"
          onClick={() => setSheetOpen((o) => !o)}
          aria-expanded={sheetOpen}
        >
          <span className="sheet-handle" />
          <span className="sheet-title">CONDITION</span>
        </button>

        <div className="sheet-body">
          {gridError && <p className="hint error">{gridError}</p>}

          {/* day slider: drives the map layer, and the farm's chart once a shape is drawn */}
          {meta && date && (
            <div className="timeline">
              <label>
                Day: <b>{date}</b>
              </label>
              <input
                type="range"
                min={0}
                max={meta.dates.length - 1}
                value={day}
                onChange={(e) => setDay(Number(e.target.value))}
              />
              <p className="hint">{grid ? `${grid.length} grid points on the map` : "Loading map layer…"}</p>
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

              {METRICS.map((m) => {
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
        </div>
      </section>
    </div>
  );
}
