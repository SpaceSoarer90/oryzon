import { useEffect, useRef, useState, SetStateAction, Dispatch } from "react";
import { MapContainer, Polygon, TileLayer, CircleMarker, Tooltip, useMapEvents } from "react-leaflet";
import type { Advice, DayData, GridMeta, GridPoint, LatLng, MetricKey } from "./types";
import { fetchDay, fetchMeta, fetchRegionData, toGeoJSONPolygon } from "./api";

interface ThePolygon {
  closed: boolean;
  points: LatLng[];
}

function isClose(a: LatLng, b: LatLng, threshold = 0.002): boolean {
  const dLat = a[0] - b[0];
  const dLng = a[1] - b[1];
  return Math.hypot(dLat, dLng) <= threshold;
}

function onAddPoint(setPolygon: Dispatch<SetStateAction<ThePolygon>>, newPoint: LatLng, zoom: number) {
  setPolygon((prev) => {
    // 1. If already closed, start a fresh polygon with the new click
    if (prev.closed) {
      return { closed: false, points: [newPoint] };
    }

    // 2. If we have at least 3 points and clicked near the first point, close it
    const baseZoom = 9;
    const baseThreshold = 0.02;
    const threshold = baseThreshold * Math.pow(2, baseZoom - zoom);
    if (prev.points.length >= 3 && isClose(prev.points[0], newPoint, threshold)) {
      return { ...prev, closed: true };
    }

    // 3. Otherwise, add the new point to a new array copy
    return { ...prev, points: [...prev.points, newPoint] };
  });
}

function DrawPolygon({ closed, points }: ThePolygon) {
  return (
    <>
      {points.map((pt, index) => (
        <CircleMarker
          key={index}
          center={pt}
          radius={5}
          pathOptions={
            index === 0
              ? { color: "#e0773a", fillColor: "#e0773a", fillOpacity: 1 }
              : { color: "#2e9e5b", fillColor: "#2e9e5b", fillOpacity: 1 }
          }
        />
      ))}
      {closed && <Polygon positions={points} pathOptions={{ color: "#2e9e5b", weight: 2 }} />}
    </>
  );
}

function ClickToSelect({ onSelect }: { onSelect: (p: LatLng, zoom: number) => void }) {
  const map = useMapEvents({ click: (e) => onSelect([e.latlng.lat, e.latlng.lng], map.getZoom()) });
  return null;
}

interface ChartProps {
  data: DayData[];
  field: MetricKey;
  index: number;
  color: string;
}

function Chart({ data, field, index, color }: ChartProps) {
  const vals = data.map((d) => d[field]);
  const valid = vals.filter((v): v is number => v !== null);
  if (valid.length === 0) return <p className="hint">No data</p>;

  const min = Math.min(0, ...valid);   // rainfall bars start at zero
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

const METRICS: { key: MetricKey; label: string; unit: string; color: string }[] = [
  { key: "precipitation", label: "Precipitation", unit: " mm/day", color: "#2f7fd1" },
];

// Placeholder rule: replace with real logic / your model's output later.
function getAdvice(data: DayData[], index: number): Advice {
  const recent = data.slice(Math.max(0, index - 13), index + 1);
  const total = recent.reduce((sum, d) => sum + (d.precipitation ?? 0), 0);
  if (total < 10) return { level: "warn", text: `Only ${total.toFixed(1)} mm in the last 14 days. Consider irrigating.` };
  return { level: "ok", text: `${total.toFixed(1)} mm in the last 14 days.` };
}

export function Map() {
  // --- map layer (every grid point, one day) ---
  const [meta, setMeta] = useState<GridMeta | null>(null);
  const [day, setDay] = useState<number>(0);              // index into meta.dates
  const [grid, setGrid] = useState<GridPoint[] | null>(null);
  const [gridError, setGridError] = useState<string | null>(null);
  const cache = useRef<Record<string, GridPoint[]>>({});  // plain object: `Map` is shadowed by this component

  // --- polygon average ---
  const [data, setData] = useState<DayData[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [poly, setPolygon] = useState<ThePolygon>({ closed: false, points: [] });

  // Load the available dates (and cell size, colour range) once
  useEffect(() => {
    const controller = new AbortController();
    fetchMeta(controller.signal)
      .then(setMeta)
      .catch((e) => { if (e.name !== "AbortError") setGridError(e.message); });
    return () => controller.abort();
  }, []);

  const date = meta ? meta.dates[day] : null;

  // Fetch the grid for the selected day. Cached days are instant; a stale request is cancelled.
  useEffect(() => {
    if (!date) return;
    const cached = cache.current[date];
    if (cached) { setGrid(cached); setGridError(null); return; }

    const controller = new AbortController();
    fetchDay(date, controller.signal)
      .then((g) => { cache.current[date] = g.points; setGrid(g.points); setGridError(null); })
      .catch((e) => { if (e.name !== "AbortError") setGridError(e.message); });
    return () => controller.abort();
  }, [date]);

  // Fetch the polygon average when a polygon is closed
  useEffect(() => {
    if (!poly.closed) { setData(null); setError(null); return; }

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    fetchRegionData(toGeoJSONPolygon(poly.points), controller.signal)
      .then(setData)
      .catch((e) => { if (e.name !== "AbortError") setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });

    return () => controller.abort();   // cancels the old request if the polygon changes
  }, [poly.closed, poly.points]);

  // The polygon data and the map layer share one slider, matched by date (not by array position)
  const polyIndex = data && date ? data.findIndex((d) => d.date === date) : -1;
  const current = data && polyIndex >= 0 ? data[polyIndex] : null;
  const advice = data && polyIndex >= 0 ? getAdvice(data, polyIndex) : null;

  return (
    <>
      <div className="map-wrap">
        <MapContainer center={[14.6, 121.0]} zoom={9} className="map">
          <TileLayer
            attribution="&copy; OpenStreetMap contributors"
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          {grid?.map((p) => (
            <CircleMarker
              key={`${p.lat},${p.lon}`}
              center={[p.lat, p.lon]}
              radius={4}
              pathOptions={{ color: "#2f7fd1", weight: 1, fillOpacity: 1.0 }}
            >
              <Tooltip>{p.precipitation === null ? "no data" : `${p.precipitation} mm`}</Tooltip>
            </CircleMarker>
          ))}
          <ClickToSelect onSelect={(newPoint, zoom) => onAddPoint(setPolygon, newPoint, zoom)} />
          <DrawPolygon {...poly} />
        </MapContainer>
      </div>

      <aside className="panel">
        {gridError && <div className="advice warn">{gridError}</div>}

        {meta && date && (
          <div className="timeline">
            <label>Day: <b>{date}</b></label>
            <input
              type="range" min={0} max={meta.dates.length - 1} value={day}
              onChange={(e) => setDay(Number(e.target.value))}
            />
            <p className="hint">{grid ? `${grid.length} grid points on the map` : "Loading map layer…"}</p>
          </div>
        )}

        {loading && <p className="hint">Loading…</p>}
        {error && <div className="advice warn">{error}</div>}

        {!loading && !error && !data && (
          <p className="hint">Click the map to draw a region. Click the orange point to close it.</p>
        )}
        {data && !current && <p className="hint">No region data for this date.</p>}

        {data && current && advice && (
          <>
            <div className={`advice ${advice.level}`}>{advice.text}</div>
            <p className="hint">Region start: {current.latlong[0].toFixed(3)}, {current.latlong[1].toFixed(3)}</p>

            {METRICS.map((m) => {
              const value = current[m.key];
              return (
                <div className="card" key={m.key}>
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
      </aside>
    </>
  );
}
