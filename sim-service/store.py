"""Readers for the owner's processed data store.

Read-only. The store lives outside the repo; both locations arrive via config
(ORYZON_DATA_ROOT / ORYZON_SOIL_FILE env seams — AUDIT.md D6). Layout inside
DATA_ROOT (the owner's converter contract, verified against the current files):
  processed/power_daily/<PARAM>_<YEAR>.csv         LAT,LON,YEAR,DOY,<PARAM>  (fill = -999)
  raw/power/ALLSKY_SFC_SW_DWN_<Y>_<lat>_<lon>.csv  per 10-degree box, named by LOWER edges
  processed/imerg_daily/imerg_daily_ph_<YEAR>.nc4  h5py: lat, lon, time (ISO bytes), precipitation

daily_weather() returns ONE continuous daily record for a scenario window (spec §4):
DATE index + SRAD, TMAX, TMIN, RAIN, DEWP. Gaps up to MAX_GAP_DAYS are interpolated;
anything longer raises — a broken scenario is a failed run, never a fabricated one.
"""
from bisect import bisect_right
from datetime import date, timedelta

import h5py
import numpy as np
import pandas as pd


def _nearest(values: np.ndarray, target: float) -> int:
    return int(np.argmin(np.abs(values - target)))


def _dewpoint(tmean: float, rh: float) -> float:
    """Magnus formula: dewpoint (C) from mean air temperature (C) and RH (%)."""
    a, b = 17.625, 243.04
    gamma = np.log(rh / 100.0) + a * tmean / (b + tmean)
    return float(b * gamma / (a - gamma))


def _doy_dates(year: int, doys: pd.Series) -> pd.DatetimeIndex:
    return pd.DatetimeIndex([date(year, 1, 1) + timedelta(days=int(d) - 1) for d in doys])


def _check_near(lats, lons, lat: float, lon: float, max_deg: float) -> None:
    """Refuse silent nearest-cell garbage when the farm sits outside the data coverage."""
    d = float(np.hypot(lats[_nearest(lats, lat)] - lat, lons[_nearest(lons, lon)] - lon))
    if d > max_deg:
        raise RuntimeError(f"nearest data point is {d:.2f} deg from ({lat}, {lon}); "
                           f"outside the {max_deg:g} deg coverage of this store")


class WeatherStore:
    POWER_PARAMS = ("T2M", "T2M_MAX", "T2M_MIN", "RH2M")
    MAX_NEAREST_DEG = 1.0   # refuse a nearest cell farther than this (silent-garbage guard)
    SOLAR_LAT_EDGES = (4.5, 8.5, 12.5, 16.5, 20.5)
    SOLAR_LON_EDGES = (116.0, 120.0, 124.0)
    MAX_GAP_DAYS = 5
    FILL = -999.0

    def __init__(self, data_root):
        self.power_dir = data_root / "processed" / "power_daily"
        self.solar_dir = data_root / "raw" / "power"
        self.imerg_dir = data_root / "processed" / "imerg_daily"
        self._series: dict[tuple, pd.Series] = {}
        self._weather: dict[tuple, pd.DataFrame] = {}

    def available_years(self) -> list[int]:
        """Years with every source on disk (existence check; a broken file inside a
        listed year surfaces later as a failed scenario)."""
        years = None
        for p in self.POWER_PARAMS:
            ys = {int(f.stem.rsplit("_", 1)[1]) for f in self.power_dir.glob(f"{p}_*.csv")}
            years = ys if years is None else (years & ys)
        years &= {int(f.stem.rsplit("_", 1)[1]) for f in self.imerg_dir.glob("*.nc4")}
        boxes = {(la, lo) for la in self.SOLAR_LAT_EDGES for lo in self.SOLAR_LON_EDGES}
        solar: dict[int, set] = {}
        for f in self.solar_dir.glob("ALLSKY_SFC_SW_DWN_*.csv"):
            parts = f.stem.split("_")          # ALLSKY SFC SW DWN 2025 16.5 120.0
            solar.setdefault(int(parts[4]), set()).add((float(parts[5]), float(parts[6])))
        return sorted(y for y in years if solar.get(y) == boxes)

    def daily_weather(self, lat: float, lon: float, years: list[int]) -> pd.DataFrame:
        key = (round(lat, 4), round(lon, 4), tuple(years))
        if key in self._weather:
            return self._weather[key]
        index = pd.date_range(date(years[0], 1, 1), date(years[-1], 12, 31), freq="D", name="DATE")
        frame = pd.DataFrame(index=index)
        frame["TMAX"] = self._power("T2M_MAX", lat, lon, years, index)
        frame["TMIN"] = self._power("T2M_MIN", lat, lon, years, index)
        frame["SRAD"] = self._solar(lat, lon, years, index)
        frame["RAIN"] = self._imerg(lat, lon, years, index)
        t2m = self._power("T2M", lat, lon, years, index)
        rh = self._power("RH2M", lat, lon, years, index)
        frame["DEWP"] = [
            _dewpoint(t, h) if np.isfinite(t) and np.isfinite(h) and 0.0 < h <= 100.0 else np.nan
            for t, h in zip(t2m, rh)
        ]
        frame = frame.interpolate(method="time", limit_area="inside")
        missing = frame.isna().any(axis=1)
        if missing.any():
            first = frame.index[missing][0].date()
            raise RuntimeError(f"weather ({lat}, {lon}) has a gap longer than "
                               f"{self.MAX_GAP_DAYS} days around {first}")
        self._weather[key] = frame
        return frame[["SRAD", "TMAX", "TMIN", "RAIN", "DEWP"]]

    # -- per-source series, cached per (source, year, rounded cell) -------------------------

    def _concat(self, key: tuple, years: list[int], index, read) -> pd.Series:
        parts = []
        for y in years:
            k = (*key, y)
            if k not in self._series:
                self._series[k] = read(y)
            parts.append(self._series[k])
        joined = pd.concat(parts) if len(parts) > 1 else parts[0]
        return joined.reindex(index)

    def _power(self, param, lat, lon, years, index) -> pd.Series:
        return self._concat(("power", param, round(lat, 4), round(lon, 4)), years, index,
                            lambda y: self._read_power(param, y, lat, lon))

    def _read_power(self, param, year, lat, lon) -> pd.Series:
        df = pd.read_csv(self.power_dir / f"{param}_{year}.csv")
        lats, lons = df["LAT"].unique(), df["LON"].unique()
        _check_near(lats, lons, lat, lon, self.MAX_NEAREST_DEG)
        sel = df[(df["LAT"] == lats[_nearest(lats, lat)]) & (df["LON"] == lons[_nearest(lons, lon)])]
        s = pd.Series(sel[param].to_numpy(dtype=float), index=_doy_dates(year, sel["DOY"]))
        return s.where(s != self.FILL)

    def _solar(self, lat, lon, years, index) -> pd.Series:
        return self._concat(("solar", round(lat, 4), round(lon, 4)), years, index,
                            lambda y: self._read_solar(y, lat, lon))

    def _read_solar(self, year, lat, lon) -> pd.Series:
        # Box files are named by their LOWER edges (box 12.5 covers lat 12.5..16.5).
        la = self.SOLAR_LAT_EDGES[max(0, bisect_right(self.SOLAR_LAT_EDGES, lat) - 1)]
        lo = self.SOLAR_LON_EDGES[max(0, bisect_right(self.SOLAR_LON_EDGES, lon) - 1)]
        df = pd.read_csv(self.solar_dir / f"ALLSKY_SFC_SW_DWN_{year}_{la}_{lo}.csv")
        lats, lons = df["LAT"].unique(), df["LON"].unique()
        _check_near(lats, lons, lat, lon, self.MAX_NEAREST_DEG)
        sel = df[(df["LAT"] == lats[_nearest(lats, lat)]) & (df["LON"] == lons[_nearest(lons, lon)])]
        s = pd.Series(sel["ALLSKY_SFC_SW_DWN"].to_numpy(dtype=float), index=_doy_dates(year, sel["DOY"]))
        return s.where(s != self.FILL)

    def _imerg(self, lat, lon, years, index) -> pd.Series:
        return self._concat(("imerg", round(lat, 4), round(lon, 4)), years, index,
                            lambda y: self._read_imerg(y, lat, lon))

    def _read_imerg(self, year, lat, lon) -> pd.Series:
        with h5py.File(self.imerg_dir / f"imerg_daily_ph_{year}.nc4") as f:
            _check_near(f["lat"][:], f["lon"][:], lat, lon, self.MAX_NEAREST_DEG)
            j, i = _nearest(f["lat"][:], lat), _nearest(f["lon"][:], lon)
            times = pd.DatetimeIndex([t.decode() for t in f["time"][:]])
            vals = np.asarray(f["precipitation"][:, i, j], dtype=float)
        return pd.Series(vals, index=times).where(lambda v: v >= 0)


class SoilStore:
    """Nearest-profile lookup in a DSSAT v4 country .SOL file."""

    def __init__(self, path):
        self.path = path
        self._coords: dict[str, tuple[float, float]] | None = None
        self._layers: dict[str, list[dict]] = {}

    def _parse(self) -> None:
        if self._coords is not None:
            return
        coords: dict[str, tuple[float, float]] = {}
        layers: dict[str, list[dict]] = {}
        current, want_site, header, rows = None, False, None, []
        with open(self.path, errors="replace") as fh:
            for raw in fh:
                line = raw.rstrip("\r\n")
                if line.startswith("*"):
                    if current is not None and header is not None and rows:
                        layers[current] = rows
                    current, want_site, header, rows = line[1:].split()[0], False, None, []
                elif line.startswith("@") and current is not None:
                    toks = line[1:].split()
                    want_site = bool(toks) and toks[0] == "SITE"
                    if "SLB" in toks:
                        header, rows = toks, []
                elif not line.strip():
                    if header is not None:
                        layers[current] = rows
                        header, rows = None, []
                    want_site = False
                elif want_site:
                    toks = line.split()
                    try:
                        coords[current] = (float(toks[2]), float(toks[3]))
                    except (ValueError, IndexError):
                        pass
                    want_site = False
                elif header is not None:
                    vals = line.split()
                    if len(vals) == len(header):
                        rows.append(dict(zip(header, vals)))
        if current is not None and header is not None and rows:
            layers[current] = rows
        self._coords, self._layers = coords, layers
        if not coords:
            raise RuntimeError(f"no soil profiles parsed from {self.path}")

    def find_profile(self, lat: float, lon: float) -> tuple[str, list[dict]]:
        """Profile id and its layer table (slb/sdul/ssat in cm and vol fractions)
        for the profile nearest to the farm."""
        self._parse()
        ids = list(self._coords)
        arr = np.array([self._coords[i] for i in ids], dtype=float)
        d = (arr[:, 0] - lat) ** 2 + (arr[:, 1] - lon) ** 2
        if float(np.sqrt(d.min())) > 1.0:   # profile grid is ~10 km; farther means off-country
            raise RuntimeError(f"nearest soil profile is {float(np.sqrt(d.min())):.2f} deg from "
                               f"({lat}, {lon}); outside the soil coverage")
        pid = ids[int(np.argmin(d))]
        out = []
        for r in self._layers.get(pid, []):
            try:
                out.append({"slb": float(r["SLB"]), "sdul": float(r["SDUL"]), "ssat": float(r["SSAT"])})
            except (KeyError, ValueError):
                continue
        if not out:
            raise RuntimeError(f"soil profile {pid} has no layer table")
        return pid, out
