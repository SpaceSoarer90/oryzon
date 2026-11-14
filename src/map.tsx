import { useMemo, useState, SetStateAction, Dispatch } from "react";
import { MapContainer, Polygon, TileLayer, Rectangle, useMapEvents } from "react-leaflet";
import { MONTHS, getRegionData, getAdvice } from "./fakeData";
import type { LatLng, MetricKey, MonthData } from "./types";

const HALF = 0.05; // half-size of the selected region in degrees (~10 km box)

interface ThePolygon {
  closed: boolean,
  points: LatLng[]
}

function isClose(a: LatLng, b: LatLng, threshold = 0.002): boolean {
  const dLat = a[0] - b[0];
  const dLng = a[1] - b[1];
  return Math.hypot(dLat, dLng) <= threshold;
}

function onAddPoint(setPolygon: Dispatch<SetStateAction<ThePolygon>>, poly: ThePolygon, newPoint: LatLng) {
  setPolygon(() => {
    var new_poly = poly;
    if (poly.closed) {
       // clear 
       new_poly.closed = false;
       new_poly.points = [newPoint]
    }
    else {
      const hasNearbyPoint: boolean = new_poly.points.some((pt) => isClose(pt, newPoint));
      if (hasNearbyPoint) {
         new_poly.closed = true; 
      }
      else {
        new_poly.points.push(newPoint)
      }
    }
    return new_poly
  })
}

function ClickToSelect({ onSelect }: { onSelect: (p: LatLng) => void }) {
  useMapEvents({ click: (e) => onSelect([e.latlng.lat, e.latlng.lng]) });
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
  const [point, setPoint] = useState<LatLng | null>(null);
  const [month, setMonth] = useState<number>(new Date().getMonth());
  const data = useMemo(() => (point ? getRegionData(point[0], point[1]) : null), [point]);
  const current = data ? data[month] : null;
  const advice = current ? getAdvice(current) : null;
  const [poly, setPolygon] = useState<ThePolygon>({ closed: false, points: []});
  return (
    <>  
      <div className="map-wrap">
        <MapContainer center={[14.6, 121.0]} zoom={9} className="map">
          <TileLayer
            attribution="&copy; OpenStreetMap contributors"
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <ClickToSelect onSelect={setPoint} />
          {point && (
            <Rectangle
              bounds={[[point[0] - HALF, point[1] - HALF], [point[0] + HALF, point[1] + HALF]]}
              pathOptions={{ color: "#2e9e5b", weight: 2 }}
            />
          )}
          /**<ClickToSelect onSelect={(newPoint) => onAddPoint(setPolygon, poly, newPoint)} />**/
          /**{
            poly.closed &&
            <Polygon positions={poly.points} pathOptions={{ color: "#2e9e5b", weight: 2 }} />
          }**/
        </MapContainer>
      </div>

      <aside className="panel">
        {!point || !data || !current || !advice ? (
          <p className="hint">Click the map to select a region.</p>
        ) : (
          <>
            <h2>{point[0].toFixed(3)}, {point[1].toFixed(3)}</h2>
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
