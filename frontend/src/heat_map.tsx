import { useEffect } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";
import { GridPoint } from "./types";

interface GridHeatmapProps {
  points: GridPoint[];
  color: string;
  minValue?: number;
  maxValue?: number;
  opacity?: number;
  resolution?: number;
}

// Find the interval containing a coordinate in a sorted array.
function findInterval(
  values: number[],
  value: number
): [number, number] | null {
  if (
    values.length < 2 ||
    value < values[0] ||
    value > values[values.length - 1]
  ) {
    return null;
  }

  let low = 0;
  let high = values.length - 1;

  while (low + 1 < high) {
    const mid = (low + high) >> 1;

    if (values[mid] <= value) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return [low, high];
}

// Bilinear interpolation.
function interpolate(
  v00: number,
  v10: number,
  v01: number,
  v11: number,
  x: number,
  y: number
): number {
  return (
    v00 * (1 - x) * (1 - y) +
    v10 * x * (1 - y) +
    v01 * (1 - x) * y +
    v11 * x * y
  );
}

export function GridHeatmap({
  points,
  color,
  minValue,
  maxValue,
  opacity = 1,
  resolution = 2,
}: GridHeatmapProps) {
  const map = useMap();

  useEffect(() => {
    const canvas = document.createElement("canvas");

    canvas.style.position = "absolute";
    canvas.style.pointerEvents = "none";

    map.getPanes().overlayPane.appendChild(canvas);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Build coordinate axes.
    const lats = [...new Set(points.map(p => p.lat))].sort(
      (a, b) => a - b
    );

    const lons = [...new Set(points.map(p => p.lon))].sort(
      (a, b) => a - b
    );

    // Store grid values using their coordinate indices.
    const grid = new Map<string, number | null>();

    for (const p of points) {
      const i = lats.indexOf(p.lat);
      const j = lons.indexOf(p.lon);

      grid.set(`${i},${j}`, p.value);
    }

    const values = points
      .map(p => p.value)
      .filter((v): v is number => v !== null && Number.isFinite(v));

    if (!values.length) return;

    const min = minValue ?? Math.min(...values);
    const max = maxValue ?? Math.max(...values);

    // Resolve the CSS color into RGB components.
    const colorCanvas = document.createElement("canvas");
    colorCanvas.width = 1;
    colorCanvas.height = 1;

    const colorCtx = colorCanvas.getContext("2d")!;
    colorCtx.fillStyle = color;
    colorCtx.fillRect(0, 0, 1, 1);

    const [r, g, b] = colorCtx.getImageData(0, 0, 1, 1).data;

    function draw() {
      const size = map.getSize();

      const width = Math.ceil(size.x / resolution);
      const height = Math.ceil(size.y / resolution);

      canvas.width = width;
      canvas.height = height;

      canvas.style.width = `${size.x}px`;
      canvas.style.height = `${size.y}px`;

      // Position canvas in Leaflet's layer coordinate system.
      const topLeft = map.containerPointToLayerPoint([0, 0]);
      L.DomUtil.setPosition(canvas, topLeft);

      const image = ctx!.createImageData(width, height);
      const data = image.data;

      for (let py = 0; py < height; py++) {
        for (let px = 0; px < width; px++) {
          // Convert canvas pixel to geographic coordinates.
          const latlng = map.containerPointToLatLng(
            L.point(
              px * resolution,
              py * resolution
            )
          );

          // Locate surrounding grid points.
          const latInterval = findInterval(lats, latlng.lat);
          const lonInterval = findInterval(lons, latlng.lng);

          if (!latInterval || !lonInterval) continue;

          const [i0, i1] = latInterval;
          const [j0, j1] = lonInterval;

          const lat0 = lats[i0];
          const lat1 = lats[i1];

          const lon0 = lons[j0];
          const lon1 = lons[j1];

          // Normalized position inside the grid cell.
          const x = (latlng.lng - lon0) / (lon1 - lon0);
          const y = (latlng.lat - lat0) / (lat1 - lat0);

          const v00 = grid.get(`${i0},${j0}`);
          const v10 = grid.get(`${i0},${j1}`);
          const v01 = grid.get(`${i1},${j0}`);
          const v11 = grid.get(`${i1},${j1}`);

          // Skip cells containing missing measurements.
          if (
            v00 == null ||
            v10 == null ||
            v01 == null ||
            v11 == null
          ) {
            continue;
          }

          // Interpolate the value at this pixel.
          const value = interpolate(
            v00,
            v10,
            v01,
            v11,
            x,
            y
          );

          // Convert value to opacity.
          const normalized =
            max === min
              ? 1
              : Math.max(0, Math.min(1, (value - min) / (max - min)));

          const alpha = Math.round(normalized * opacity * 255);

          const index = (py * width + px) * 4;

          data[index] = r;
          data[index + 1] = g;
          data[index + 2] = b;
          data[index + 3] = alpha;
        }
      }

      ctx!.putImageData(image, 0, 0);
    }

    draw();

    map.on("moveend", draw);
    map.on("zoomend", draw);
    map.on("resize", draw);

    return () => {
      map.off("moveend", draw);
      map.off("zoomend", draw);
      map.off("resize", draw);

      canvas.remove();
    };
  }, [map, points, color, minValue, maxValue, opacity, resolution]);

  return null;
}

