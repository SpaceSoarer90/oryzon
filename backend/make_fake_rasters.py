"""Creates fake monthly GeoTIFFs in ./data so the averaging pipeline can be tested
before real NASA data exists.  Run once:  python make_fake_rasters.py

Files: data/<variable>_<MM>.tif  (4 variables x 12 months), 100x100 pixels each,
covering lon 120.5..121.5, lat 14.0..15.2 (around Metro Manila / Luzon).
"""
from pathlib import Path
import numpy as np
import rasterio
from rasterio.transform import from_bounds

OUT = Path(__file__).parent / "data"
OUT.mkdir(exist_ok=True)

WEST, SOUTH, EAST, NORTH = 120.5, 14.0, 121.5, 15.2
H = W = 100
NODATA = -9999.0
rng = np.random.default_rng(42)
transform = from_bounds(WEST, SOUTH, EAST, NORTH, W, H)

# (base, seasonal amplitude, season phase in months, east-west gradient strength)
VARS = {
    "ndvi":         (0.25, 0.55, 0, 0.10),
    "soilMoisture": (0.15, 0.25, 3, 0.05),
    "rainfall":     (20.0, 220.0, 5, 30.0),
    "temperature":  (18.0, 12.0, 2, 3.0),
}

xx = np.linspace(0, 1, W)[None, :].repeat(H, axis=0)  # 0 on the west edge, 1 on the east edge

for name, (base, amp, phase, grad) in VARS.items():
    for m in range(12):
        season = 0.5 + 0.5 * np.sin(((m + phase) / 12) * 2 * np.pi)
        grid = base + amp * season + grad * xx + rng.normal(0, amp * 0.02, (H, W))
        # fake "cloud" patch in some months so nodata handling gets exercised
        if m % 4 == 1:
            grid[10:40, 20:50] = NODATA
        with rasterio.open(
            OUT / f"{name}_{m + 1:02d}.tif", "w", driver="GTiff",
            height=H, width=W, count=1, dtype="float32",
            crs="EPSG:4326", transform=transform, nodata=NODATA,
        ) as dst:
            dst.write(grid.astype("float32"), 1)

print(f"Wrote {len(VARS) * 12} files to {OUT}")
