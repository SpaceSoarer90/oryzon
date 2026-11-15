"""Weather and soil readers.

No local data store. Weather comes from the NASA POWER point API: ONE request per year and grid cell
returns every variable the simulator needs (temperature, humidity, solar radiation, rain). Responses
are cached in memory and on disk, so each location + year is downloaded once.

  T2M, T2M_MAX, T2M_MIN   air temperature (C)
  RH2M                    relative humidity (%)
  ALLSKY_SFC_SW_DWN       solar radiation (MJ/m2/day)
  PRECTOTCORR             rain (mm/day)       <- replaces GPM IMERG, which needs an Earthdata login

Soil: nearest profile in a DSSAT country .SOL file (downloaded from Hugging Face by config.py).

daily_weather() returns ONE continuous daily record for a scenario window (spec §4):
DATE index + SRAD, TMAX, TMIN, RAIN, DEWP. Gaps up to MAX_GAP_DAYS are interpolated;
anything longer raises — a broken scenario is a failed run, never a fabricated one.
"""
import json
import os
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd


def _nearest(values: np.ndarray, target: float) -> int:
    return int(np.argmin(np.abs(values - target)))


def _dewpoint(tmean: float, rh: float) -> float:
    """Magnus formula: dewpoint (C) from mean air temperature (C) and RH (%)."""
    a, b = 17.625, 243.04
    gamma = np.log(rh / 100.0) + a * tmean / (b + tmean)
    return float(b * gamma / (a - gamma))


class WeatherStore:
    PARAMS = ("T2M", "T2M_MAX", "T2M_MIN", "RH2M", "ALLSKY_SFC_SW_DWN", "PRECTOTCORR")
    API = "https://power.larc.nasa.gov/api/temporal/daily/point"
    LAT_STEP, LON_STEP = 0.5, 0.625   # the POWER grid; farms in the same cell share one download
    FIRST_YEAR = 2001                 # earliest year offered as a scenario
    MAX_GAP_DAYS = 5
    FILL = -999.0
    API_TIMEOUT_S = 90
    API_TRIES = 3

    def __init__(self, data_root=None):
        # `data_root` is accepted and ignored so old call sites keep working.
        self.cache_dir = Path(os.environ.get(
            "ORYZON_WEATHER_CACHE", str(Path(tempfile.gettempdir()) / "oryzon_weather")))
        try:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass   # caching is an optimisation; requests still work without it
        self._years: dict[tuple, pd.DataFrame] = {}
        self._weather: dict[tuple, pd.DataFrame] = {}

    def available_years(self) -> list[int]:
        """Complete calendar years that can be requested: FIRST_YEAR up to last year."""
        return list(range(self.FIRST_YEAR, date.today().year))

    def daily_weather(self, lat: float, lon: float, years: list[int]) -> pd.DataFrame:
        key = (round(lat, 4), round(lon, 4), tuple(years))
        if key in self._weather:
            return self._weather[key]
        glat = round(lat / self.LAT_STEP) * self.LAT_STEP
        glon = round(lon / self.LON_STEP) * self.LON_STEP

        index = pd.date_range(date(years[0], 1, 1), date(years[-1], 12, 31), freq="D", name="DATE")
        raw = pd.concat([self._year(y, glat, glon) for y in years]).reindex(index)

        frame = pd.DataFrame(index=index)
        frame["TMAX"] = raw["T2M_MAX"]
        frame["TMIN"] = raw["T2M_MIN"]
        frame["SRAD"] = raw["ALLSKY_SFC_SW_DWN"]
        frame["RAIN"] = raw["PRECTOTCORR"].where(raw["PRECTOTCORR"] >= 0)
        frame["DEWP"] = [
            _dewpoint(t, h) if np.isfinite(t) and np.isfinite(h) and 0.0 < h <= 100.0 else np.nan
            for t, h in zip(raw["T2M"], raw["RH2M"])
        ]
        frame = frame.interpolate(method="time", limit_area="inside")
        missing = frame.isna().any(axis=1)
        if missing.any():
            first = frame.index[missing][0].date()
            raise RuntimeError(f"weather ({lat}, {lon}) has a gap longer than "
                               f"{self.MAX_GAP_DAYS} days around {first}")
        frame = frame[["SRAD", "TMAX", "TMIN", "RAIN", "DEWP"]]
        self._weather[key] = frame
        return frame

    # -- one year of one grid cell: memory -> disk -> API -------------------------------------

    def _year(self, year: int, glat: float, glon: float) -> pd.DataFrame:
        k = (year, round(glat, 4), round(glon, 4))
        if k in self._years:
            return self._years[k]
        cache = self.cache_dir / f"power_{year}_{glat:.3f}_{glon:.3f}.json"
        values = None
        if cache.exists():
            try:
                values = json.loads(cache.read_text())
            except (OSError, ValueError):
                values = None          # unreadable cache file: download it again
        if values is None:
            values = self._fetch(year, glat, glon)
            try:
                cache.write_text(json.dumps(values))
            except OSError:
                pass
        missing = [p for p in self.PARAMS if p not in values]
        if missing:
            raise RuntimeError(f"NASA POWER response for ({glat}, {glon}), {year} lacks {missing}")
        df = pd.DataFrame({p: pd.Series(values[p]) for p in self.PARAMS})
        df.index = pd.to_datetime(df.index, format="%Y%m%d")
        df = df.astype(float).where(lambda d: d != self.FILL)
        self._years[k] = df
        return df

    def _fetch(self, year: int, lat: float, lon: float) -> dict:
        """{"T2M": {"YYYYMMDD": value, ...}, ...} for one year at one point."""
        query = urllib.parse.urlencode({
            "parameters": ",".join(self.PARAMS),
            "community": "AG",
            "latitude": f"{lat:.4f}",
            "longitude": f"{lon:.4f}",
            "start": f"{year}0101",
            "end": f"{year}1231",
            "format": "JSON",
        })
        url = f"{self.API}?{query}"
        last_error: Exception | None = None
        for attempt in range(1, self.API_TRIES + 1):
            try:
                with urllib.request.urlopen(url, timeout=self.API_TIMEOUT_S) as resp:
                    payload = json.loads(resp.read().decode("utf-8"))
                values = payload["properties"]["parameter"]
                if not values:
                    raise RuntimeError("the API returned no values")
                return values
            except (urllib.error.URLError, TimeoutError, ValueError, KeyError, RuntimeError) as exc:
                last_error = exc
                if attempt < self.API_TRIES:
                    time.sleep(2 * attempt)     # brief back-off before trying again
        raise RuntimeError(f"could not get weather for ({lat}, {lon}), {year} from NASA POWER: "
                           f"{type(last_error).__name__}: {last_error}")


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
