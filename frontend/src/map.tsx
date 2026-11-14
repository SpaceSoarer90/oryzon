import { useMemo, useEffect, useState, SetStateAction, Dispatch } from "react";
import { MapContainer, Polygon, TileLayer, Rectangle, CircleMarker, useMapEvents } from "react-leaflet";
import { MONTHS, getRegionData, getAdvice } from "./fakeData";
import type { LatLng, MetricKey, MonthData } from "./types";
import { fetchRegionData, toGeoJSONPolygon } from "./api";

interface ThePolygon {
  closed: boolean,
  points: LatLng[]
}

function isClose(a: LatLng, b: LatLng, threshold = 0.002): boolean {
  const dLat = a[0] - b[0];
  const dLng = a[1] - b[1];
  return Math.hypot(dLat, dLng) <= threshold;
}

function onAddPoint(setPolygon: Dispatch<SetStateAction<ThePolygon>>, newPoint: LatLng, zoom: number) {
  setPolygon((prev) => {
    console.log(`values: ${zoom}`);
    // 1. If already closed, start a fresh polygon with the new click
    if (prev.closed) {
      return { closed: false, points: [newPoint] };
    }

    // 2. If we have at least 3 points and clicked near the first point, close it
    var baseZoom = 9;
    var baseThreshold = 0.02;
    const threshold = baseThreshold * Math.pow(2, baseZoom - zoom);
    if (prev.points.length >= 3 && isClose(prev.points[0], newPoint, threshold)) {
      return { ...prev, closed: true };
    }

    // 3. Otherwise, add the new point to a new array copy
    return {
      ...prev,
      points: [...prev.points, newPoint],
    };
  })
}

function DrawPolygon(poly: ThePolygon) {
  
  return (<>

    {poly.points.map((pt, index) => (
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
    {
      poly.closed &&
      <Polygon positions={poly.points} pathOptions={{ color: "#2e9e5b", weight: 2 }} />
    }
  </>);
}


function ClickToSelect({ onSelect }: { onSelect: (p: LatLng, zoom: number) => void }) {
  const map = useMapEvents({ click: (e) => onSelect([e.latlng.lat, e.latlng.lng], map.getZoom()) });
  return null;
}

interface ChartProps {
  data: MonthData[];
  field: MetricKey;
  month: number;
  color: string;
}

function Chart({ data, field, month, color }: ChartProps) {
  const vals = data.map((d) => d[field]);
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

const METRICS: { key: MetricKey; label: string; unit: string; color: string }[] = [
  { key: "ndvi", label: "Vegetation (NDVI)", unit: "", color: "#2e9e5b" },
  { key: "soilMoisture", label: "Soil moisture", unit: " m³/m³", color: "#2f7fd1" },
  { key: "rainfall", label: "Rainfall", unit: " mm", color: "#6b5bd6" },
  { key: "temperature", label: "Temperature", unit: " °C", color: "#e0773a" },
];

export function Map() {
  // const [point, setPoint] = useState<LatLng | null>(null);
  const [month, setMonth] = useState<number>(new Date().getMonth());
  // const data = useMemo(() => (point ? getRegionData(point[0], point[1]) : null), [point]);
  const [data, setData] = useState<MonthData[] | null>(null);
  const current = data ? data[month] : null;
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null);
  const advice = current ? getAdvice(current) : null;
  const [poly, setPolygon] = useState<ThePolygon>({ closed: false, points: []});
  

  // const [polygon, setPolygon] = useState<LatLng[]>([]);   // your existing polygon state
  // const [data, setData] = useState<MonthData[] | null>(null);
  // const [loading, setLoading] = useState(false);
  // const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (poly.points.length < 3) { setData(null); return; }

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    fetchRegionData(toGeoJSONPolygon(poly.points), controller.signal)
      .then(setData)
      .catch((e) => { if (e.name !== "AbortError") setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });

    return () => controller.abort();   // cancels the old request if the polygon changes
  }, [poly.closed]);
  /**<ClickToSelect onSelect={setPoint} />
  {point && (
    <Rectangle
      bounds={[[point[0] - HALF, point[1] - HALF], [point[0] + HALF, point[1] + HALF]]}
      pathOptions={{ color: "#2e9e5b", weight: 2 }}
    />
  )}**/
      /**<Polygon positions={poly.points} pathOptions={{ color: "#2e9e5b", weight: 2 }} />**/
  return (
    <>  
      <div className="map-wrap">
        <MapContainer center={[14.6, 121.0]} zoom={9} className="map">
          <TileLayer
            attribution="&copy; OpenStreetMap contributors"
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <ClickToSelect onSelect={(newPoint, zoom) => onAddPoint(setPolygon, newPoint, zoom)} />
          { DrawPolygon(poly) }
        </MapContainer>
      </div>

      <aside className="panel">
        {!data || !current || !advice ? (
          <p className="hint">Click the map to select a region.</p>
        ) : (
          <>
            <div className={`advice ${advice.level}`}>{advice.text}</div>

            <div className="timeline">
              <label>Timeline: <b>{MONTHS[month]}</b></label>
              <input
                type="range" min={0} max={11} value={month}
                onChange={(e) => setMonth(Number(e.target.value))}
              />
            </div>

            {METRICS.map((m) => (
              <div className="card" key={m.key}>
                <div className="row">
                  <span>{m.label}</span>
                  <b>{current[m.key]}{m.unit}</b>
                </div>
                <Chart data={data} field={m.key} month={month} color={m.color} />
              </div>
            ))}
            <p className="hint">Demo data only. Not real measurements.</p>
          </>
        )}
      </aside>
     </>
  );
}
