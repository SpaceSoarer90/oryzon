"""Field Shift API (CSV version).  Run with:  uvicorn main:app --reload   (http://localhost:8000)

POST /api/region  with a GeoJSON Polygon (or a Feature wrapping one)
  -> list of daily objects matching DayData in the React app's types.ts
"""
from pathlib import Path

from datetime import date as Date

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException
from shapely import contains_xy
from shapely.geometry import shape

DATA_DIR = Path(__file__).parent / "data/power_daily/"
DATASET = "PRECTOTCORR_2025"   # a folder of .csv files, or a single file (with or without .csv)
YEAR = 2025                    # only this year is served for now
MAX_NEAREST_DEG = 1.0          # if no grid point is inside the polygon, use the nearest one only if within this many degrees

COL_LAT = "LAT"
COL_LON = "LON"
COL_VALUE = "PRECTOTCORR"      # the precipitation column
COL_DATE = "DATE"              # used if present...
COL_YEAR, COL_DOY = "YEAR", "DOY"  # ...otherwise the date is built from year + day-of-year

FILL_VALUE = -999              # NASA POWER's "missing" marker; turned into null


def load_data() -> pd.DataFrame:
    """Read the CSV(s) once at startup into one tidy table: date, lat, lon, precipitation."""
    base = DATA_DIR / DATASET
    if base.is_dir():
        files = sorted(base.glob("*.csv"))
    elif base.with_suffix(".csv").exists():
        files = [base.with_suffix(".csv")]
    elif base.is_file():
        files = [base]
    else:
        raise RuntimeError(f"Dataset not found: {base}")
    if not files:
        raise RuntimeError(f"No .csv files in {base}")

    raw = pd.concat((pd.read_csv(f) for f in files), ignore_index=True)

    missing = [c for c in (COL_LAT, COL_LON, COL_VALUE) if c not in raw.columns]
    if missing:
        raise RuntimeError(f"Missing columns {missing}. Columns found: {list(raw.columns)}")

    if COL_DATE in raw.columns:
        dates = pd.to_datetime(raw[COL_DATE])
    else:
        try:
            # year + day-of-year (1..366) -> real date
            dates = pd.to_datetime(raw[COL_YEAR].astype(str), format="%Y") + pd.to_timedelta(raw[COL_DOY] - 1, unit="D")
        except KeyError:
            raise RuntimeError(
                f"Need a '{COL_DATE}' column or '{COL_YEAR}'/'{COL_DOY}'. Columns found: {list(raw.columns)}"
            )

    df = pd.DataFrame({
        "date": dates,
        "lat": raw[COL_LAT],
        "lon": raw[COL_LON],
        "precipitation": raw[COL_VALUE].where(raw[COL_VALUE] != FILL_VALUE),  # fill value -> NaN
    })
    years_found = sorted(df["date"].dt.year.unique().tolist())
    df = df[df["date"].dt.year == YEAR].reset_index(drop=True)
    if df.empty:
        raise RuntimeError(f"No rows for YEAR = {YEAR}. Years found in the file(s): {years_found}")
    return df


df = load_data()
locations = df[["lat", "lon"]].drop_duplicates().reset_index(drop=True)  # the distinct grid points

# ---- Precomputed once at startup so each request is just a lookup ------------
by_date = {
    d: g[["lat", "lon", "precipitation"]].reset_index(drop=True)
    for d, g in df.groupby(df["date"].dt.date)
}
DATES = sorted(by_date)


def grid_step(values: pd.Series) -> float | None:
    """Spacing between neighbouring grid lines, in degrees (None if there is only one)."""
    diffs = np.diff(np.sort(values.unique()))
    diffs = diffs[diffs > 0]
    return round(float(diffs.min()), 6) if len(diffs) else None


META = {
    "dates": [d.isoformat() for d in DATES],
    "cellSize": {"lat": grid_step(locations["lat"]), "lon": grid_step(locations["lon"])},
    # one colour scale for the whole year, so shading doesn't jump between days
    "range": {
        "min": float(df["precipitation"].min()),
        "max": float(df["precipitation"].max()),
        "p95": float(df["precipitation"].quantile(0.95)),
    },
    "bounds": {
        "west": float(locations["lon"].min()), "east": float(locations["lon"].max()),
        "south": float(locations["lat"].min()), "north": float(locations["lat"].max()),
    },
}
# -----------------------------------------------------------------------------

app = FastAPI(title="Field Shift API")


def extract_geometry(body: dict) -> dict:
    """Accepts a bare GeoJSON geometry or a Feature (what Leaflet's toGeoJSON() gives)."""
    geom = body.get("geometry", body)
    if not isinstance(geom, dict) or geom.get("type") not in ("Polygon", "MultiPolygon"):
        raise HTTPException(422, "Body must be a GeoJSON Polygon/MultiPolygon or a Feature of one.")
    return geom


def points_for(poly) -> pd.DataFrame:
    """Rows of df for grid points inside the polygon; if none, the single nearest grid point."""
    minx, miny, maxx, maxy = poly.bounds
    box = df[(df["lon"] >= minx) & (df["lon"] <= maxx) & (df["lat"] >= miny) & (df["lat"] <= maxy)]
    inside = box[contains_xy(poly, box["lon"], box["lat"])]
    if not inside.empty:
        return inside

    # Grid cells are often bigger than a farm, so a small polygon may hold no points at all.
    c = poly.centroid
    d2 = (locations["lon"] - c.x) ** 2 + (locations["lat"] - c.y) ** 2
    if d2.min() ** 0.5 > MAX_NEAREST_DEG:
        return df.iloc[0:0]   # too far from any data: report "no data" instead of a misleading value
    nearest = locations.loc[d2.idxmin()]
    return df[(df["lat"] == nearest["lat"]) & (df["lon"] == nearest["lon"])]


def first_vertex(geom: dict) -> list[float]:
    """First vertex of the polygon as [lat, lng] (GeoJSON stores [lng, lat])."""
    coords = geom["coordinates"]
    while isinstance(coords[0], list):   # Polygon -> ring -> point (MultiPolygon is one level deeper)
        coords = coords[0]
    return [coords[1], coords[0]]


def first_vertex(geom: dict) -> list[float]:
    """First vertex of the polygon as [lat, lng] (GeoJSON stores [lng, lat])."""
    coords = geom["coordinates"]
    while isinstance(coords[0], list):   # Polygon -> ring -> point (MultiPolygon is one level deeper)
        coords = coords[0]
    return [coords[1], coords[0]]


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/api/region")
def region(body: dict):
    geom = extract_geometry(body)
    poly = shape(geom)
    latlong = first_vertex(geom)
    selected = points_for(poly)
    if selected.empty:
        raise HTTPException(422, "No data available for this area.")

    daily = (
        selected.groupby("date")["precipitation"].mean()   # mean skips NaN
        .reset_index().sort_values("date")
    )
    return [
        {
            "date": d.strftime("%Y-%m-%d"),
            "year": int(d.year),
            "precipitation": None if pd.isna(v) else round(float(v), 2),
            "latlong": latlong,
        }
        for d, v in zip(daily["date"], daily["precipitation"])
    ]


@app.get("/api/precip/meta")
def precip_meta():
    """Everything the map layer needs once, up front: available dates, cell size, colour range, bounds."""
    return META


@app.get("/api/precip/day")
def precip_day(
    date: Date,
    west: float | None = None, south: float | None = None,
    east: float | None = None, north: float | None = None,
):
    """Precipitation for every grid point on one day. Optional west/south/east/north limit it to the map view."""
    grid = by_date.get(date)
    if grid is None:
        raise HTTPException(404, f"No data for {date}. Available: {META['dates'][0]} to {META['dates'][-1]}")

    if None not in (west, south, east, north):
        grid = grid[(grid["lon"] >= west) & (grid["lon"] <= east) & (grid["lat"] >= south) & (grid["lat"] <= north)]

    grid = grid.assign(precipitation=grid["precipitation"].round(2))
    points = grid.astype(object).where(grid.notna(), None).to_dict("records")   # NaN -> null
    return {"date": date.isoformat(), "points": points}
