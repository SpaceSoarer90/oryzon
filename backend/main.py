"""Field Shift API (CSV version).  Run with:  uvicorn main:app --reload   (http://localhost:8000)

Each dataset (precipitation, temperature, ...) is a "layer" built by the same code.
To add a new one, add a line to DATASETS below. Nothing else needs to be copied.

GET  /api/layers                  -> names of the available layers
GET  /api/layers/{name}/meta      -> dates, cell size, colour range, bounds for that layer
GET  /api/layers/{name}/day       -> every grid point for one day (?date=YYYY-MM-DD)
POST /api/region                  -> daily average over a GeoJSON polygon, all layers together
"""
from dataclasses import dataclass
from datetime import date as Date
from pathlib import Path

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException
from shapely import contains_xy
from shapely.geometry import shape

DATA_DIR = Path(__file__).parent / "data/power_daily/"
YEAR = 2025                    # only this year is served for now
MAX_NEAREST_DEG = 1.0          # if no grid point is inside the polygon, use the nearest one only if within this many degrees
FILL_VALUE = -999              # NASA POWER's "missing" marker; turned into null

# Column names shared by all the CSVs
COL_LAT, COL_LON = "LAT", "LON"
COL_DATE = "DATE"                  # used if present...
COL_YEAR, COL_DOY = "YEAR", "DOY"  # ...otherwise the date is built from year + day-of-year

# One entry per dataset:  layer name -> file, value column in that file, decimals to round to
DATASETS = {
    "precipitation": {"file": "PRECTOTCORR_2025.csv", "column": "PRECTOTCORR", "decimals": 2},
    "temperature":   {"file": "T2M_2025.csv",         "column": "T2M",         "decimals": 1},
}


def load_data(path: Path, value_col: str, name: str) -> pd.DataFrame:
    """Read one CSV into a tidy table with columns: date, lat, lon, <name>."""
    if not path.is_file():
        raise RuntimeError(f"Dataset not found: {path}")

    raw = pd.read_csv(path)

    missing = [c for c in (COL_LAT, COL_LON, value_col) if c not in raw.columns]
    if missing:
        raise RuntimeError(f"{path.name}: missing columns {missing}. Columns found: {list(raw.columns)}")

    if COL_DATE in raw.columns:
        dates = pd.to_datetime(raw[COL_DATE])
    else:
        try:
            # year + day-of-year (1..366) -> real date
            dates = pd.to_datetime(raw[COL_YEAR].astype(str), format="%Y") + pd.to_timedelta(raw[COL_DOY] - 1, unit="D")
        except KeyError:
            raise RuntimeError(
                f"{path.name}: need a '{COL_DATE}' column or '{COL_YEAR}'/'{COL_DOY}'. Columns found: {list(raw.columns)}"
            )

    df = pd.DataFrame({
        "date": dates,
        "lat": raw[COL_LAT],
        "lon": raw[COL_LON],
        name: raw[value_col].where(raw[value_col] != FILL_VALUE),  # fill value -> NaN
    })
    years_found = sorted(df["date"].dt.year.unique().tolist())
    df = df[df["date"].dt.year == YEAR].reset_index(drop=True)
    if df.empty:
        raise RuntimeError(f"{path.name}: no rows for YEAR = {YEAR}. Years found: {years_found}")
    return df


def grid_step(values: pd.Series) -> float | None:
    """Spacing between neighbouring grid lines, in degrees (None if there is only one)."""
    diffs = np.diff(np.sort(values.unique()))
    diffs = diffs[diffs > 0]
    return round(float(diffs.min()), 6) if len(diffs) else None


@dataclass
class Layer:
    name: str
    decimals: int
    df: pd.DataFrame          # one row per grid point per day
    locations: pd.DataFrame   # the distinct grid points
    by_date: dict             # date -> that day's rows, for fast lookups
    meta: dict                # served by /api/layers/{name}/meta


def build_layer(name: str, cfg: dict) -> Layer:
    """Everything precomputed once at startup for one dataset."""
    df = load_data(DATA_DIR / cfg["file"], cfg["column"], name)
    locations = df[["lat", "lon"]].drop_duplicates().reset_index(drop=True)
    by_date = {
        d: g[["lat", "lon", name]].reset_index(drop=True)
        for d, g in df.groupby(df["date"].dt.date)
    }
    meta = {
        "dates": [d.isoformat() for d in sorted(by_date)],
        "cellSize": {"lat": grid_step(locations["lat"]), "lon": grid_step(locations["lon"])},
        # one colour scale for the whole year, so shading doesn't jump between days
        "range": {
            "min": float(df[name].min()),
            "max": float(df[name].max()),
            "p95": float(df[name].quantile(0.95)),
        },
        "bounds": {
            "west": float(locations["lon"].min()), "east": float(locations["lon"].max()),
            "south": float(locations["lat"].min()), "north": float(locations["lat"].max()),
        },
    }
    return Layer(name, cfg["decimals"], df, locations, by_date, meta)


LAYERS = {name: build_layer(name, cfg) for name, cfg in DATASETS.items()}

app = FastAPI(title="Field Shift API")


def get_layer(name: str) -> Layer:
    layer = LAYERS.get(name)
    if layer is None:
        raise HTTPException(404, f"Unknown layer '{name}'. Available: {list(LAYERS)}")
    return layer


def extract_geometry(body: dict) -> dict:
    """Accepts a bare GeoJSON geometry or a Feature (what Leaflet's toGeoJSON() gives)."""
    geom = body.get("geometry", body)
    if not isinstance(geom, dict) or geom.get("type") not in ("Polygon", "MultiPolygon"):
        raise HTTPException(422, "Body must be a GeoJSON Polygon/MultiPolygon or a Feature of one.")
    return geom


def first_vertex(geom: dict) -> list[float]:
    """First vertex of the polygon as [lat, lng] (GeoJSON stores [lng, lat])."""
    coords = geom["coordinates"]
    while isinstance(coords[0], list):   # Polygon -> ring -> point (MultiPolygon is one level deeper)
        coords = coords[0]
    return [coords[1], coords[0]]


def points_for(layer: Layer, poly) -> pd.DataFrame:
    """Rows of the layer for grid points inside the polygon; if none, the single nearest grid point."""
    df = layer.df
    minx, miny, maxx, maxy = poly.bounds
    box = df[(df["lon"] >= minx) & (df["lon"] <= maxx) & (df["lat"] >= miny) & (df["lat"] <= maxy)]
    inside = box[contains_xy(poly, box["lon"], box["lat"])]
    if not inside.empty:
        return inside

    # Grid cells are often bigger than a farm, so a small polygon may hold no points at all.
    c = poly.centroid
    d2 = (layer.locations["lon"] - c.x) ** 2 + (layer.locations["lat"] - c.y) ** 2
    if d2.min() ** 0.5 > MAX_NEAREST_DEG:
        return df.iloc[0:0]   # too far from any data: report "no data" instead of a misleading value
    nearest = layer.locations.loc[d2.idxmin()]
    return df[(df["lat"] == nearest["lat"]) & (df["lon"] == nearest["lon"])]


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/api/layers")
def list_layers():
    return {"layers": list(LAYERS)}


@app.post("/api/region")
def region(body: dict):
    geom = extract_geometry(body)
    poly = shape(geom)
    latlong = first_vertex(geom)  # for debugging purposes

    # Daily average over the polygon, separately for each layer
    series = {}
    for name, layer in LAYERS.items():
        selected = points_for(layer, poly)
        if not selected.empty:
            series[name] = selected.groupby("date")[name].mean()   # mean skips NaN
    if not series:
        raise HTTPException(422, "No data available for this area.")

    daily = pd.DataFrame(series).sort_index()   # one row per date, one column per layer
    rows = []
    for d, row in daily.iterrows():
        item = {"date": d.strftime("%Y-%m-%d"), "year": int(d.year), "latlong": latlong}
        for name, layer in LAYERS.items():
            v = row.get(name)                      # None if this layer had no data for the area
            item[name] = None if v is None or pd.isna(v) else round(float(v), layer.decimals)
        rows.append(item)
    return rows


@app.get("/api/layers/{name}/meta")
def layer_meta(name: str):
    """Everything the map layer needs once, up front: available dates, cell size, colour range, bounds."""
    return get_layer(name).meta


@app.get("/api/layers/{name}/day")
def layer_day(
    name: str,
    date: Date,
    west: float | None = None, south: float | None = None,
    east: float | None = None, north: float | None = None,
):
    """Value for every grid point of a layer on one day. Optional west/south/east/north limit it to the map view."""
    layer = get_layer(name)
    grid = layer.by_date.get(date)
    if grid is None:
        dates = layer.meta["dates"]
        raise HTTPException(404, f"No data for {date}. Available: {dates[0]} to {dates[-1]}")

    if None not in (west, south, east, north):
        grid = grid[(grid["lon"] >= west) & (grid["lon"] <= east) & (grid["lat"] >= south) & (grid["lat"] <= north)]

    grid = grid.rename(columns={name: "value"})
    grid = grid.assign(value=grid["value"].round(layer.decimals))
    points = grid.astype(object).where(grid.notna(), None).to_dict("records")   # NaN -> null
    return {"date": date.isoformat(), "points": points}
