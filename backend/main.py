"""Field Shift API.  Run with:  uvicorn main:app --reload   (http://localhost:8000)

Every dataset (precipitation, temperature, soil moisture, ...) is a "layer" built by the same code.
To add a new one, add ONE entry to DATASETS below. Nothing else on the backend needs to be copied.

GET  /api/layers                  -> layers that loaded, plus the reason for any that failed
GET  /api/layers/{name}/meta      -> dates, cell size, colour range, bounds for that layer
GET  /api/layers/{name}/day       -> every grid point for one day (?date=YYYY-MM-DD)
GET  /api/heatmap/{name}/bounds   -> where on the map the heat map image goes
GET  /api/heatmap/{name}/{date}   -> the heat map for one day, as a transparent PNG
POST /api/region                  -> daily average over a GeoJSON polygon, all layers together
"""
from dataclasses import dataclass
from datetime import date as Date
from pathlib import Path

import numpy as np
import pandas as pd
import xarray as xr
from fastapi import FastAPI, HTTPException, Response
from shapely import contains_xy
from shapely.geometry import shape

from heatmap_service import build_heatmaps

import os
from fnmatch import fnmatch
from huggingface_hub import HfApi, hf_hub_download

HF_REPO = os.environ.get("HF_REPO", "JyanMan/NASA_data")
HF_TOKEN = os.environ.get("HF_TOKEN")

DATA_DIR = Path(__file__).parent / "data/"
YEAR = 2025                    # only this year is served for now
MAX_NEAREST_DEG = 1.0          # if no grid point is inside the polygon, use the nearest one only if within this many degrees
# Values used by data providers to mean "no measurement here" (POWER uses -999, FLDAS uses -9999). Turned into NaN,
# and finally null in the API. None of our variables can legitimately be this low.
FILL_VALUES = (-999, -9999)

# NetCDF files from NASA are often GLOBAL. Flattened into a table that is tens of millions of rows, which
# would exhaust memory. Crop NetCDF layers to the area we care about: (west, south, east, north) in degrees.
# None = keep everything (only safe for small files).
BBOX: tuple[float, float, float, float] | None = None
MAX_NETCDF_CELLS = 30_000_000  # safety stop: refuse to load more than this many values, and say how to fix it

# Column names shared by all the CSV files
COL_LAT, COL_LON = "LAT", "LON"
COL_DATE = "DATE"                  # used if present...
COL_YEAR, COL_DOY = "YEAR", "DOY"  # ...otherwise the date is built from year + day-of-year

# One entry per dataset. The key is the layer name: it becomes the URL (/api/layers/<name>/...) and the
# field name in /api/region, so it must match DayData / METRICS in the frontend.
#   file     path inside DATA_DIR. May contain wildcards ("soil/*.nc4") to read many files as one dataset.
#   format   "csv" or "netcdf" (.nc / .nc4) - decides which reader is used
#   column   the CSV column, or the NetCDF variable name, holding the values
#   decimals how many decimals to round values to in the API
#   isel     (netcdf, optional) pick one slice of an extra dimension, e.g. {"lev": 0} for the top soil layer
#   period   (netcdf, optional) "day" (default) or "month". A monthly dataset is spread over the days of each
#            month (every day shows its month's value), so it fits the same daily slider as everything else.
#   color    (heat map) colour of the HIGH values;  low_color  colour of the LOW values. Dark = more.
#   fade     (heat map, optional) 0..1: how much of the low end is see-through. 0 = low values drawn solid,
#            0.35 (default) = the lowest values fade out so they don't look like white haze over the map.
DATASETS = {
    "precipitation": {"file": "power_daily/PRECTOTCORR_2025.csv", "format": "csv", "column": "PRECTOTCORR", "decimals": 2,
                      "color": "#0b3d91", "low_color": None, "fade": 0.1 },
    "temperature":   {"file": "power_daily/T2M_2025.csv",         "format": "csv", "column": "T2M",         "decimals": 1,
                      "color": "#c0392b", "low_color": None},
    # FLDAS monthly soil moisture. It has four depths (SoilMoi00_10cm_tavg, ...10_40cm..., ...40_100cm..., ...100_200cm...);
    # this is the top 0-10 cm. To serve another depth, add one more entry here with that variable name.
    # If `file`/`column` are wrong the server still starts, and /api/layers says why.
    "soilMoisture":  {"file": "fldas_monthly/fldas_monthly_ph_2025.nc4", "format": "netcdf", "column": "SoilMoi00_10cm_tavg",
                      "decimals": 2, "period": "month", "color": "#43c864", "low_color": None},
}

_REPO_FILES = None

def fetch_files(pattern: str) -> list[Path]:
    """Files in the Hugging Face dataset repo matching `pattern` (wildcards work), downloaded and cached locally."""
    global _REPO_FILES
    if _REPO_FILES is None:
        _REPO_FILES = HfApi(token=HF_TOKEN).list_repo_files(HF_REPO, repo_type="dataset")
    matches = sorted(f for f in _REPO_FILES if fnmatch(f, pattern))
    return [Path(hf_hub_download(HF_REPO, f, repo_type="dataset", token=HF_TOKEN)) for f in matches]


# ---- Readers: each turns raw files into the same tidy table: date, lat, lon, <layer name> ------------------

def read_csv(files: list[Path], name: str, cfg: dict) -> pd.DataFrame:
    """CSV: one row per grid point per day, with YEAR + DOY (or DATE) columns."""
    column = cfg["column"]
    raw = pd.concat((pd.read_csv(f) for f in files), ignore_index=True)

    missing = [c for c in (COL_LAT, COL_LON, column) if c not in raw.columns]
    if missing:
        raise RuntimeError(f"Missing columns {missing}. Columns found: {list(raw.columns)}")

    if COL_DATE in raw.columns:
        dates = pd.to_datetime(raw[COL_DATE])
    else:
        try:
            # year + day-of-year (1..366) -> real date
            dates = pd.to_datetime(raw[COL_YEAR].astype(str), format="%Y") + pd.to_timedelta(raw[COL_DOY] - 1, unit="D")
        except KeyError:
            raise RuntimeError(f"Need a '{COL_DATE}' column or '{COL_YEAR}'/'{COL_DOY}'. Columns found: {list(raw.columns)}")

    return pd.DataFrame({"date": dates, "lat": raw[COL_LAT], "lon": raw[COL_LON], name: raw[column]})


# NetCDF files name their axes differently from one product to the next. Map the usual alternatives
# onto the names the rest of the code uses.
COORD_ALIASES = {
    "lat": ["latitude", "Latitude", "LAT"],
    "lon": ["longitude", "Longitude", "LON"],
    "time": ["TIME", "Time", "date"],
}


def as_text(values) -> list[str]:
    """Time stamps stored as text may come back as str or bytes; return plain strings."""
    return [v.decode() if isinstance(v, bytes) else str(v) for v in np.asarray(values).ravel()]


def standardize_coords(ds: xr.Dataset, variable: str, filename: str) -> xr.DataArray:
    """Return `variable` with axes named lat / lon / time, whatever the file called them or however it stored them."""
    da = ds[variable]
    for target, aliases in COORD_ALIASES.items():
        names = [target, *aliases]

        # Case 1: the axis is a proper coordinate (maybe under another name) -> just rename it.
        src = next((n for n in names if n in da.coords), None)
        if src:
            if src != target:
                da = da.rename({src: target})
            continue

        # Case 2: the file has "phony" dimensions: lat/lon/time are stored as ordinary 1-D variables and the data
        # axes are anonymous. The dimension each variable sits on tells us which axis of the data it describes
        # (so this also copes with files whose axes are in an unusual order, like time/lon/lat).
        src = next((n for n in names if n in ds.variables and ds[n].ndim == 1 and ds[n].dims[0] in da.dims), None)
        if src:
            axis = ds[src].dims[0]
            da = da.rename({axis: target}).assign_coords({target: ds[src].values})

    absent = [c for c in ("lat", "lon", "time") if c not in da.coords]
    if absent:
        raise RuntimeError(f"{filename}: can't find {absent}. Variables in the file: {list(ds.variables)}")

    # Time stamps stored as text ("2025-01") -> real dates
    if not np.issubdtype(da["time"].dtype, np.datetime64):
        texts = [t.replace("_", "-").replace("/", "-") for t in as_text(da["time"].values)]
        try:
            da = da.assign_coords(time=pd.to_datetime(texts).to_numpy())
        except ValueError:
            raise RuntimeError(f"{filename}: can't read the time stamps as dates. First ones: {texts[:3]}")

    if "time" not in da.dims:                 # a file holding a single time step: make time a proper axis
        da = da.expand_dims("time")
    return da


def read_netcdf(files: list[Path], name: str, cfg: dict) -> pd.DataFrame:
    """NetCDF (.nc/.nc4): a grid per time step. Cropped, turned into one value per day, then flattened into rows."""
    variable = cfg["column"]
    pieces = []
    for f in files:
        with xr.open_dataset(f) as ds:
            if variable not in ds.data_vars:
                raise RuntimeError(f"{f.name}: no variable '{variable}'. Variables found: {list(ds.data_vars)}")
            da = standardize_coords(ds, variable, f.name)

            if cfg.get("isel"):                # e.g. choose one soil layer
                da = da.isel(cfg["isel"])
            extra = [d for d in da.dims if d not in ("time", "lat", "lon")]
            if extra:
                raise RuntimeError(f"{f.name}: '{variable}' has extra dimensions {extra}. "
                                   f"Choose one slice with e.g. \"isel\": {{\"{extra[0]}\": 0}} in DATASETS.")

            # Shrink BEFORE loading into memory: only our year, and only our area.
            da = da.sortby("lat").sortby("lon").sortby("time")
            da = da.sel(time=slice(f"{YEAR}-01-01", f"{YEAR}-12-31"))
            if BBOX:
                west, south, east, north = BBOX
                da = da.sel(lat=slice(south, north), lon=slice(west, east))
            if da.size > MAX_NETCDF_CELLS:
                raise RuntimeError(f"{f.name}: {da.size:,} values is too many to load. Set BBOX to crop to your area.")
            pieces.append(da.load())           # .load() reads the values now, while the file is still open

    da = xr.concat(pieces, dim="time").sortby("time") if len(pieces) > 1 else pieces[0]
    if da.sizes["time"] == 0:
        raise RuntimeError(f"No time steps in {YEAR}.")

    if cfg.get("period") == "month":
        # Monthly data: one value per month. Spread it over the days of that month so the daily slider works.
        # (Only up to the end of the last month present; we never invent values for months the file lacks.)
        months = da.indexes["time"].to_period("M").to_timestamp()      # snap stamps to the 1st of their month
        da = da.assign_coords(time=months)
        days = pd.date_range(months[0], months[-1] + pd.offsets.MonthEnd(0), freq="D")
        da = da.reindex(time=days, method="ffill")                     # each day takes the latest month start before it
    else:
        # Hourly / 3-hourly / daily data: the app works in days, so average each day.
        da = da.resample(time="1D").mean()

    df = da.to_dataframe(name=name).reset_index().rename(columns={"time": "date"})
    return df[["date", "lat", "lon", name]]


READERS = {"csv": read_csv, "netcdf": read_netcdf}


def load_data(name: str, cfg: dict) -> pd.DataFrame:
    """Read one dataset with the reader for its format, then apply the clean-up every format shares."""
    files = fetch_files(cfg["file"])
    if not files:
        raise RuntimeError(f"No files in Hugging Face repo {HF_REPO} match '{cfg['file']}'")
    # files = sorted(DATA_DIR.glob(cfg["file"]))   # works for a plain file name and for wildcards
    # if not files:
    #     raise RuntimeError(f"No files match {DATA_DIR / cfg['file']}")
    reader = READERS.get(cfg["format"])
    if reader is None:
        raise RuntimeError(f"Unknown format '{cfg['format']}'. Use one of {list(READERS)}")

    df = reader(files, name, cfg)

    df[name] = df[name].where(~df[name].isin(FILL_VALUES))    # "missing" markers -> NaN
    years_found = sorted(df["date"].dt.year.unique().tolist())
    df = df[df["date"].dt.year == YEAR]
    if df.empty:
        raise RuntimeError(f"No rows for YEAR = {YEAR}. Years found in the file(s): {years_found}")

    # Drop grid points that never have a value (e.g. ocean points in a land-only product), so they
    # don't show up as permanent "no data" dots and can't be picked as the nearest point.
    has_data = df.groupby(["lat", "lon"])[name].transform("count") > 0
    return df[has_data].reset_index(drop=True)


# ---- Layers: everything precomputed once at startup so each request is just a lookup -------------------

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
    df = load_data(name, cfg)
    locations = df[["lat", "lon"]].drop_duplicates().reset_index(drop=True)
    by_date = {
        d: g[["lat", "lon", name]].reset_index(drop=True)
        for d, g in df.groupby(df["date"].dt.date)
    }
    meta = {
        "dates": [d.isoformat() for d in sorted(by_date)],
        "period": cfg.get("period", "day"),   # "month" = each month's value is repeated on all its days
        # each layer measures its own grid, so datasets at different resolutions can coexist
        "cellSize": {"lat": grid_step(locations["lat"]), "lon": grid_step(locations["lon"])},
        # one colour scale for the whole year, so shading doesn't jump between days
        "range": {
            "min": round(float(df[name].min()), 6),
            "max": round(float(df[name].max()), 6),
            "p95": round(float(df[name].quantile(0.95)), 6),   # precipitation-like data is skewed; p95 avoids outliers
        },
        "bounds": {
            "west": float(locations["lon"].min()), "east": float(locations["lon"].max()),
            "south": float(locations["lat"].min()), "north": float(locations["lat"].max()),
        },
    }
    return Layer(name, cfg["decimals"], df, locations, by_date, meta)


# A broken dataset (typo in a file name, wrong variable name) must not take the other layers down with it.
# It is skipped, reported loudly here, and its reason is exposed at /api/layers.
LAYERS: dict[str, Layer] = {}
LOAD_ERRORS: dict[str, str] = {}
print("FETCHING DATA")
for _name, _cfg in DATASETS.items():
    try:
        LAYERS[_name] = build_layer(_name, _cfg)
    except Exception as e:
        LOAD_ERRORS[_name] = str(e)
        print(f"WARNING: layer '{_name}' failed to load and is disabled: {e}")
print("FINISHED FETCHING DATA")

# Heat map images, built once from the layers above (the data is only read in one place).
HEATMAPS = build_heatmaps(LAYERS, DATASETS)

app = FastAPI(title="Field Shift API")


def get_layer(name: str) -> Layer:
    layer = LAYERS.get(name)
    if layer is None:
        if name in LOAD_ERRORS:
            raise HTTPException(503, f"Layer '{name}' failed to load: {LOAD_ERRORS[name]}")
        raise HTTPException(404, f"Unknown layer '{name}'. Available: {list(LAYERS)}")
    return layer


# ---- Polygon helpers -----------------------------------------------------------------------------------

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
    # Cheap first cut: only rows inside the polygon's bounding rectangle, so the exact test below has less to do.
    minx, miny, maxx, maxy = poly.bounds
    box = df[(df["lon"] >= minx) & (df["lon"] <= maxx) & (df["lat"] >= miny) & (df["lat"] <= maxy)]
    inside = box[contains_xy(poly, box["lon"], box["lat"])]   # exact point-in-polygon test
    if not inside.empty:
        return inside

    # Grid cells are often bigger than a farm, so a small polygon may hold no points at all.
    c = poly.centroid
    d2 = (layer.locations["lon"] - c.x) ** 2 + (layer.locations["lat"] - c.y) ** 2
    if d2.min() ** 0.5 > MAX_NEAREST_DEG:
        return df.iloc[0:0]   # too far from any data: report "no data" instead of a misleading value
    nearest = layer.locations.loc[d2.idxmin()]
    return df[(df["lat"] == nearest["lat"]) & (df["lon"] == nearest["lon"])]


# ---- Endpoints -----------------------------------------------------------------------------------------

@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/api/layers")
def list_layers():
    """Which layers are usable, and why any are not (handy when a new dataset doesn't show up)."""
    return {"layers": list(LAYERS), "errors": LOAD_ERRORS}


@app.post("/api/region")
def region(body: dict):
    geom = extract_geometry(body)
    poly = shape(geom)
    latlong = first_vertex(geom)  # for debugging purposes

    # Daily average over the polygon, separately for each layer (each has its own grid)
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
        # Every configured layer always gets a field, so the frontend never sees "undefined".
        # null = this layer failed to load, has no data near the polygon, or is missing that day.
        for name, cfg in DATASETS.items():
            v = row.get(name)
            item[name] = None if v is None or pd.isna(v) else round(float(v), cfg["decimals"])
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

    # "value" because the layer is already named in the URL
    grid = grid.rename(columns={name: "value"})
    # float64 first: NetCDF data is float32, and rounding that gives values like 0.10999999940395355 in the JSON
    grid = grid.assign(value=grid["value"].astype("float64").round(layer.decimals))
    points = grid.astype(object).where(grid.notna(), None).to_dict("records")   # NaN -> null
    return {"date": date.isoformat(), "points": points}

def get_heatmap(name: str):
    heat = HEATMAPS.get(name)
    if heat is None:
        if name in LOAD_ERRORS:
            raise HTTPException(503, f"Layer '{name}' failed to load: {LOAD_ERRORS[name]}")
        raise HTTPException(404, f"No heat map for layer '{name}'. Available: {list(HEATMAPS)}")
    return heat


# IMPORTANT: this route must be declared BEFORE the "{date}" one below. Routes are matched in order, so if
# "{date}" came first it would swallow ".../bounds" (treating the word "bounds" as a date) and this would never run.
@app.get("/api/heatmap/{name}/bounds")
def heatmap_bounds(name: str):
    """[[south, west], [north, east]]: the corners to pin the image to (Leaflet ImageOverlay bounds)."""
    return get_heatmap(name).bounds


@app.get("/api/heatmap/{name}/{date}")
def heatmap_png(name: str, date: Date):
    heat = get_heatmap(name)
    try:
        png = heat.render(date)
    except KeyError:
        dates = LAYERS[name].meta["dates"]
        raise HTTPException(404, f"No data for {date}. Available: {dates[0]} to {dates[-1]}")

    return Response(
        content=png,
        media_type="image/png",
        # The server also caches rendered images; this lets the browser reuse them for a few minutes.
        # Kept short so a restart with new data or new colours isn't hidden behind a day-old cached image.
        headers={"Cache-Control": "public, max-age=300"},
    )
