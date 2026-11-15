# oryzon_data — downloaded datasets for the Philippines rice app

All datasets verified on this machine on 2026-11-14. Provenance, checksums, and
per-file status: `tracker.csv`. Raw source files: `raw/`. Ready-to-use analysis
tables: `processed/`.

## Layout

```
oryzon_data/
  tracker.csv                  per-file provenance, sizes, sha256, verification notes
  raw/
    power/                     POWER regional daily JSON, 2016-2025 (as downloaded)
    worldcover_2021/           8 GeoTIFFs, ESA WorldCover v200 2021, clipped to PH
    gfsad30sea_2015/           GFSAD30SEACE tile N00E110 (completes PH coverage)
  processed/
    power_daily/               one CSV per param per year, PH-average ready
```

## Datasets

| Dataset | Version | Dates on disk | Coverage | Route |
|---|---|---|---|---|
| NASA POWER daily | MERRA-2 assimilation | 2016-01-01..2025-12-31 | PH bbox 116-127E, 4.5-21N | POWER regional API (200 requests, no login) |
| ESA WorldCover | v200, epoch 2021 | 2021 | full PH land | AWS public bucket, COG ranged reads |
| GFSAD30SEACE | 001, epoch 2015 | 2015 | full PH (5 tiles total) | LP DAAC direct HTTPS + Bearer token |
| GPM IMERG daily | V07B (Final + Late tail) | 2016-01-01..2025-12-31 | PH bbox, 0.1 deg | GES DISC presign + ranged HDF5 reads |
| MODIS VIIRS NDVI | MOD13A3.061 + VNP13A3.002 | 2016-2025 monthly | PH bbox, 500 m/1 km | AppEEARS area sample |
| FLDAS monthly | NOAH01_C_GL_M.001 | 2016-01..2025-12 | global 0.1 deg, sliced to PH | GES DISC direct HTTPS |

## Key file details

### processed/power_daily/
- Columns: date, T2M, T2M_MAX, T2M_MIN (C), PRECTOTCORR (mm/day), RH2M (%).
- Missing values: `-999` (none remaining in merged files; 0.00% nodata verified).
- Leap years have 366 rows, others 365 (223992 / 223380 rows per year).

### raw/worldcover_2021/
- EPSG:4326, LZW+predictor, nodata=0. Class 40 = cropland.
- 8 ESA tiles clipped to the PH bbox; 5 more ocean-only tiles (N12E114,
  N12E126, N15E114, N15E123, N15E126, N18E117, N18E123, N18E126) do not exist
  in the bucket — GFSAD confirms 0 land pixels in their PH overlap.

### raw/gfsad30sea_2015/ + cropland-mask/GFSAD30SEACE/
- EPSG:4326, classes 0 = water, 1 = non-cropland, 2 = cropland, no nodata.
- Tiles N00E110, N00E120, N10E110, N10E120, N20E120 cover the full PH bbox.
- Tile N10E110 covers Palawan below 10N; GFSAD classes Palawan largely
  non-cropland (coconut/cashew do not read as cropland at this resolution).

### processed/imerg_daily/ (merged per year)
- imerg_daily_ph_YYYY.nc4: precipitation(time, lon, lat) mm/day, 0.1 deg,
  111 x 166 px covering 116-127E x 4.5-21N. NaN = missing (none present).
- Final run (V07B) 2016-01-01..2025-09-30; Late run (V07B) for Oct-Dec 2025.
- All 3653 days present, 0 download failures.
- Per-day slices also kept: raw/imerg/slices/YYYYMMDD.npy.

### AppEEARS NDVI
- MOD13A3.061 monthly 1 km + VNP13A3.002 monthly 500 m, PH bbox, geotiff
  per date per layer, 2016-2025. Cloud cover in the wet season is significant;
  use monthly composites.
### processed/fldas_monthly/
- Per-year netCDFs (10 files, ~970 KB each): time (YYYY-MM), lon 116-127,
  lat 4.5-21, layers: SoilMoi00_10cm, SoilMoi10_40, SoilMoi40_100,
  SoilMoi100_200 (m3/m3), Rainf_f (kg/m2/s), Evap (kg/m2/s), Tair_f (K).
- Missing value: -9999 (ocean/non-land; ~84% of the bbox is ocean).
- Orientation: (time, lon, lat) to match IMERG processed files.
- Model output (NOAH 3.6.1, MERRA-2 + CHIRPS forcing) — regional trend signal,
  not a measurement. Source raw files deleted after slicing (approved 2026-11-14).

## Degradations and caveats

- IMERG V07B Final daily does not exist for 2025-10-01 onward; the tail uses
  the Late run (GPM_3IMERGDL.07), which is production-ready per GES DISC.
- GES DISC OPeNDAP/Harmony subsetting is broken server-side (403/404) for both
  IMERG and FLDAS as of 2026-11-14; both were fetched via direct HTTPS.
- WorldCover ocean-only tiles missing from the bucket are confirmed empty by
  GFSAD class counts; no land is lost.
- FLDAS global files are ~122 MB each; full files were downloaded then sliced
  per the user's explicit approval (2026-11-14).
