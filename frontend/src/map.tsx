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
} from "react-leaflet";
import { MONTHS, getAdvice } from "./fakeData";
import type { LatLng, MetricKey, MonthData } from "./types";
import { fetchRegionData, toGeoJSONPolygon } from "./api";
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

const METRICS: { key: MetricKey; label: string; unit: string; color: string }[] = [
  { key: "ndvi", label: "Vegetation (NDVI)", unit: "", color: "#2e9e5b" },
  { key: "soilMoisture", label: "Soil moisture", unit: " m³/m³", color: "#2f7fd1" },
  { key: "rainfall", label: "Rainfall", unit: " mm", color: "#6b5bd6" },
  { key: "temperature", label: "Temperature", unit: " °C", color: "#e0773a" },
];

// The three layer buttons on the right side of the screen.
const LAYERS: { key: MetricKey; label: string; icon: string; iconClicked: string }[] = [
  { key: "temperature", label: "Temperature", icon: temperatureIcon, iconClicked: temperatureClicked },
  { key: "soilMoisture", label: "Soil Moisture", icon: soilMoistureIcon, iconClicked: soilMoistureClicked },
  { key: "rainfall", label: "Precipitation", icon: precipitationIcon, iconClicked: precipitationClicked },
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
  month,
  color,
}: {
  data: MonthData[];
  field: MetricKey;
  month: number;
  color: string;
}) {
  const vals = data.map((d) => d[field] ?? 0);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const ys = vals.map((v) => 50 - ((v - min) / (max - min || 1)) * 46 - 2);
  const pts = ys.map((y, i) => `${(i / 11) * 220},${y}`);
  return (
    <svg viewBox="0 0 220 52" className="chart">
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth="2" />
      <circle cx={(month / 11) * 220} cy={ys[month]} r="4" fill={color} />
    </svg>
  );
}

/* ---------- main screen ---------- */

export function FarmMap() {
  const [poly, setPolygon] = useState<ThePolygon>(EMPTY);
  const [drawing, setDrawing] = useState(true);
  const [month, setMonth] = useState<number>(new Date().getMonth());
  const [data, setData] = useState<MonthData[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [place, setPlace] = useState<string | null>(null);
  // null = no layer selected, so the plain satellite map is shown
  const [layer, setLayer] = useState<MetricKey | null>(null);
  const [layersOpen, setLayersOpen] = useState(true);
  // peek = just the "CONDITION" bar, half = partly open, full = covers the whole screen
  const [sheet, setSheet] = useState<"peek" | "half" | "full">("peek");

  const current = data ? data[month] : null;
  const advice = current ? getAdvice(current) : null;

  // Finishing a shape ends drawing and opens the Condition sheet.
  useEffect(() => {
    if (poly.closed) {
      setDrawing(false);
      setSheet("half");
    }
  }, [poly.closed]);

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
          {!poly.closed && (
            <p className="hint">
              Tap the map to place the corners of your field. Tap the orange first point to finish.
            </p>
          )}
          {poly.closed && loading && <p className="hint">Loading satellite data…</p>}
          {poly.closed && error && <p className="hint error">Couldn't load data: {error}</p>}

          {data && current && advice && (
            <>
              <div className={`advice ${advice.level}`}>{advice.text}</div>

              <div className="timeline">
                <label>
                  Timeline: <b>{MONTHS[month]}</b>
                </label>
                <input
                  type="range"
                  min={0}
                  max={11}
                  value={month}
                  onChange={(e) => setMonth(Number(e.target.value))}
                />
              </div>

              {orderedMetrics.map((m) => (
                <div className={`card ${layer === m.key ? "active" : ""}`} key={m.key}>
                  <div className="row">
                    <span>{m.label}</span>
                    <b>
                      {current[m.key]}
                      {m.unit}
                    </b>
                  </div>
                  <Chart data={data} field={m.key} month={month} color={m.color} />
                </div>
              ))}
              <p className="hint">Demo data only. Not real measurements.</p>
            </>
          )}
        </div>
      </section>
    </div>
  );
}