"""Field Shift API.  Run with:  uvicorn main:app --reload   (http://localhost:8000)

POST /api/region  with a GeoJSON Polygon (or a Feature wrapping one)
  -> list of 12 objects matching MonthData in the React app's types.ts
"""
from pathlib import Path

import rasterio
from fastapi import FastAPI, HTTPException
from rasterio.features import geometry_mask

DATA_DIR = Path(__file__).parent / "data"
PRECTOTCOR_PATH = "PRECTOTCORR_2025"
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
VARIABLES = {"ndvi": 2, "soilMoisture": 2, "rainfall": 0, "temperature": 1}  # name -> decimals

app = FastAPI(title="Field Shift API")


# def raster_path(variable: str, month_index: int) -> Path:
#     return DATA_DIR / f"{variable}_{month_index + 1:02d}.tif"

def raster_path() -> Path:
    return DATA_DIR /  PRECTOTCOR_PATH


def extract_geometry(body: dict) -> dict:
    """Accepts a bare GeoJSON geometry or a Feature (what Leaflet's toGeoJSON() gives)."""
    geom = body.get("geometry", body)
    if not isinstance(geom, dict) or geom.get("type") not in ("Polygon", "MultiPolygon"):
        raise HTTPException(422, "Body must be a GeoJSON Polygon/MultiPolygon or a Feature of one.")
    return geom


def inside_mask(geom: dict, src: rasterio.DatasetReader):
    """Boolean grid, True where a pixel is inside the polygon. Computed once, reused for every raster
    (all rasters share the same grid)."""
    for all_touched in (False, True):  # fall back for polygons smaller than a pixel
        mask = geometry_mask(
            [geom], out_shape=(src.height, src.width), transform=src.transform,
            invert=True, all_touched=all_touched,
        )
        if mask.any():
            return mask
    return None


def zonal_mean(path: Path, mask) -> float | None:
    with rasterio.open(path) as src:
        data = src.read(1, masked=True)  # nodata pixels come back masked
    valid = data[mask].compressed()      # only pixels inside the polygon AND with valid data
    return float(valid.mean()) if valid.size else None


@app.post("/api/region")
def region(body: dict):
    geom = extract_geometry(body)

    first = raster_path("ndvi", 0)
    if not first.exists():
        raise HTTPException(500, "No rasters found. Run: python make_fake_rasters.py")
    with rasterio.open(first) as src:
        mask = inside_mask(geom, src)
    if mask is None:
        raise HTTPException(422, "Polygon does not overlap the data coverage area.")

    months = []
    for i, month in enumerate(MONTHS):
        row: dict = {"month": month}
        for variable, decimals in VARIABLES.items():
            value = zonal_mean(raster_path(variable, i), mask)
            row[variable] = None if value is None else round(value, decimals)  # None = no valid pixels
        months.append(row)

    # --- Model hook (later) ---------------------------------------------------
    # `months` is now a clean 12-month feature table for this region. Load your
    # trained model once at startup (e.g. joblib.load("model.joblib")), build a
    # feature vector from `months`, and add its output to the response here.
    # ---------------------------------------------------------------------------
    return months
