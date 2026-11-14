import { useEffect, useState } from "react";
import L from "leaflet";
import {
  MapContainer,
  TileLayer,
  Polygon,
  Polyline,
  CircleMarker,
  Marker,
  useMap,
  useMapEvents,
  ImageOverlay,
} from "react-leaflet";
import type { Advice, Bounds, DayData, GridMeta, LatLng, MetricKey } from "./types";
import { fetchHeatmapBounds, fetchMeta, fetchRegionData, heatmapUrl, toGeoJSONPolygon } from "./api";
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
const FARM_NAME = "FARM 1"; // placeholder until farms can be saved

interface ThePolygon {
  closed: boolean;
  points: LatLng[];
}
const EMPTY: ThePolygon = { closed: false, points: [] };

// Data the backend has. Cards in the Condition sheet, and the layers that can be drawn on the map.
const METRICS: { key: MetricKey; label: string; unit: string; color: string }[] = [
  { key: "precipitation", label: "Precipitation", unit: " mm", color: "#2f7fd1" },
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
  const [poly, setPolygon] = useState<ThePolygon>(EMPTY);
  const [drawing, setDrawing] = useState(true);
  const [data, setData] = useState<DayData[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [place, setPlace] = useState<string | null>(null);
  // null = no layer selected, so the plain satellite map is shown
  const [layer, setLayer] = useState<LayerKey | null>(null);
  const [layersOpen, setLayersOpen] = useState(true);
  // peek = just the "CONDITION" bar, half = partly open, full = covers the whole screen
  const [sheet, setSheet] = useState<"peek" | "half" | "full">("peek");

  // map layer: a heat map image for the selected layer and day, drawn by the backend
  const [metas, setMetas] = useState<Partial<Record<MetricKey, GridMeta>>>({});
  const [heatBounds, setHeatBounds] = useState<Partial<Record<MetricKey, Bounds>>>({});
  const [day, setDay] = useState<number>(0); // index into dates
  const [imageDate, setImageDate] = useState<string | null>(null); // the day whose image we actually request
  const [gridError, setGridError] = useState<string | null>(null);

  const dataLayer = isMetric(layer) ? layer : null;

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

  // Load each layer's dates and the corners its heat map image is pinned to, once.
  useEffect(() => {
    const controller = new AbortController();
    const onError = (e: Error) => {
      if (e.name !== "AbortError") setGridError(e.message);
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
  }, []);

  // Dragging the slider changes `date` many times a second. Wait until it settles for a moment before asking
  // for a new image, so the server isn't asked to draw days you only passed through.
  useEffect(() => {
    if (!date) return;
    const t = setTimeout(() => setImageDate(date), 120);
    return () => clearTimeout(t);
  }, [date]);

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

  function startNewFarm() {
    setPolygon(EMPTY);
    setDrawing(true);
    setData(null);
    setError(null);
    setSheet("peek");
  }

  const pillText = poly.closed ? place ?? "Locating…" : "Outline your farm on the map";
  const orderedMetrics = [...METRICS].sort((a, b) => Number(b.key === layer) - Number(a.key === layer));
  const heatUrl = dataLayer && imageDate ? heatmapUrl(dataLayer, imageDate) : null;
  const bounds = dataLayer ? heatBounds[dataLayer] : undefined;

  return (
    <div className={`app sheet-${sheet}`}>
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
        {heatUrl && bounds && (
          <ImageOverlay
            key={dataLayer} // a new layer has different corners, so start a fresh overlay
            url={heatUrl}
            bounds={bounds}
            opacity={1}
            eventHandlers={{
              load: () => setGridError(null),
              error: () => setGridError("Couldn't load the heat map for this day."),
            }}
          />
        )}
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

      {onBack && (
        <button className="back-btn" aria-label="Back to home" onClick={onBack}>
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </button>
      )}

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
      <section className="sheet" aria-label="Condition">
        <button
          className="sheet-head"
          onClick={() => setSheet((s) => (s === "full" ? "peek" : "full"))}
          aria-expanded={sheet === "full"}
        >
          <span className="sheet-handle" />
          <span className="sheet-title">CONDITION</span>
        </button>

        <div className="sheet-body">
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
                {dataLayer
                  ? "Shading is smoothed between grid points. The numbers in your farm card are the real grid values."
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
        </div>
      </section>
    </div>
  );
}
