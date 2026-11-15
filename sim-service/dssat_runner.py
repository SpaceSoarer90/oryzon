"""DssatRunner — the real `Runner` (runner.py protocol) backed by the DSSAT-CSM binary.

One `run_experiment` call = one isolated work dir containing everything DSSAT needs:

    DSSATPRO.L48      path profile pointing at DSSAT_HOME (Genotype, *.CDE, StandardData)
    ORYZ0001.RIX      FileX written by experiment_file.emit_filex (WATER/NITRO off if ideal)
    ORYZ<yy>01.WTH    the scenario's continuous daily weather (from spec.weather)
    PH.SOL            ONLY the one soil profile the run uses (copied out of the country file)

then `dscsm048 A ORYZ0001.RIX` is executed in that directory and the outputs are parsed:

    Summary.OUT   HWAM (harvested product, kg dry matter/ha), MDAT (maturity date)   [spec §4]
    SoilOrg.OUT   SCTD / SNTD: total soil organic C / N (kg/ha), first and last day
    SoilNi.OUT    NT1D..: total inorganic N (ppm) by depth, converted to kg N/ha

DSSAT_HOME layout (what `scripts/install_dssat.sh` builds):

    <home>/dscsm048            executable built from github.com/DSSAT/dssat-csm-os
    <home>/Genotype/           from dssat-csm-os/Data/Genotype (RICER048.CUL/.ECO/.SPE ...)
    <home>/*.CDE, StandardData, DSSATPRO.L48 ...   from dssat-csm-os/Data

Scope (be explicit, spec §5 "never silently substitute"):
  * Rice single-season runs (actual + ideal) are fully supported.
  * `calibrated_yield_crops()` is EMPTY and cover/pre-crop sequences are refused with a
    clear error: they need a calibrated crop model that is not in the stock DSSAT data
    (mung bean has none at all, spec §8). Nothing is substituted.
"""
from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
from datetime import date, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pandas as pd

import config
from experiment_file import emit_filex
from runner import (ExperimentSpec, RunResult, SeasonResult, SoilState)

EXE_NAME = "dscsm048"
WSTA = "ORYZ"
EXP_ID = "ORYZ0001"
_GENERIC_PREFIX = "99"      # 99xxxx = DSSAT generic / MINIMA / MAXIMA rows: not variety-specific calibrations
RUN_TIMEOUT_S = int(os.environ.get("ORYZON_DSSAT_TIMEOUT_S", "300"))


# Management used when a SeasonSpec carries none. Copied from the project owner's verified
# presets (sim-service/experiments: ARYZ0000 = irrigated dry-seeded, ARYZ0001 = irrigated
# transplanted) with dates turned into days-after-planting. ASSUMPTION (AUDIT.md §9): the
# owner may replace these by passing a Management from a selected preset.
DEFAULT_MANAGEMENT = {
    "DS": {"planting": {"ppop": 180, "ppoe": 180, "plrs": 0, "pldp": 2, "page": 0, "penv": 0, "plph": 0},
           "irrigation": ((0, 150, "IR009"),), "irrigation_auto": True,
           "fertilizer": ((0, 30, "AP002", 5), (21, 30, "AP001", 0), (42, 30, "AP001", 0))},
    "T": {"planting": {"ppop": 75, "ppoe": 75, "plrs": 20, "pldp": 3, "page": 21, "penv": 27, "plph": 3},
          "irrigation": ((0, 50, "IR006"),), "irrigation_auto": True,
          "fertilizer": ((0, 30, "AP002", 5), (20, 35, "AP001", 0), (41, 35, "AP001", 0))},
}


class DssatRunner:
    def __init__(self, dssat_home: str | Path | None = None, soil_file: str | Path | None = None):
        self.home = Path(dssat_home or os.environ.get("ORYZON_DSSAT_HOME", "")).expanduser()
        if not self.home or not (self.home / EXE_NAME).exists():
            raise RuntimeError(
                f"DSSAT executable not found: set ORYZON_DSSAT_HOME to a directory containing "
                f"{EXE_NAME} (see scripts/install_dssat.sh); got {str(self.home)!r}")
        self.exe = self.home / EXE_NAME
        self.cul = self.home / "Genotype" / "RICER048.CUL"
        if not self.cul.exists():
            raise RuntimeError(f"rice cultivar file missing: {self.cul}")
        self._soil_file = Path(soil_file) if soil_file else None
        self._version: str | None = None
        self._varieties: list[tuple[str, str]] | None = None

    # -- enumeration (spec §5: enumerate from the simulator, never hardcode) ----------------

    def _cultivars(self) -> list[tuple[str, str]]:
        if self._varieties is None:
            out = []
            for line in self.cul.read_text(errors="replace").splitlines():
                if not line.strip() or line[0] in "!@*":
                    continue
                vid = line[:6].strip()
                if not vid or vid.startswith(_GENERIC_PREFIX):
                    continue
                out.append((vid, line[7:23].strip()))
            self._varieties = out
        return self._varieties

    def calibrated_rice_varieties(self) -> list[str]:
        return [vid for vid, _ in self._cultivars()]

    def rice_cultivar_options(self) -> list[dict[str, str]]:
        """Cultivar IDs and display names parsed directly from RICER048.CUL."""
        return [{"id": vid, "name": name or vid} for vid, name in self._cultivars()]

    def calibrated_yield_crops(self) -> list[str]:
        return []      # none calibrated yet (see module docstring); branch returns empty state

    # -- metadata (spec rule 6, cache key) ----------------------------------------------------

    def dssat_version(self) -> str:
        if self._version is None:
            vf = self.home / "DSSAT_VERSION"          # written by scripts/install_dssat.sh
            self._version = vf.read_text().strip() if vf.exists() else "unknown"
        return self._version

    def cultivar_coefficient_source(self) -> str:
        digest = hashlib.md5(self.cul.read_bytes()).hexdigest()[:8]
        return (f"DSSAT stock RICER048.CUL (DSSAT/dssat-csm-os Data/Genotype, md5 {digest}); "
                f"{len(self._cultivars())} cultivars, NOT re-calibrated by ORYZON")

    def soil_version(self) -> str:
        f = self._soil_file or config.SOIL_FILE
        return f"{Path(f).name}:{hashlib.md5(Path(f).read_bytes()).hexdigest()[:8]}"

    # -- one run -------------------------------------------------------------------------------

    def run_experiment(self, spec: ExperimentSpec) -> RunResult:
        try:
            return self._run(spec)
        except _RunFailed as exc:
            return RunResult((), None, None, "failed", str(exc))

    def _run(self, spec: ExperimentSpec) -> RunResult:
        if len(spec.seasons) != 1 or spec.seasons[0].kind != "rice":
            raise _RunFailed(
                "only single-season rice runs are supported: no calibrated pre-/cover-crop "
                "model is installed (seasons=" + ",".join(f"{s.kind}:{s.crop_or_variety}"
                                                          for s in spec.seasons) + ")")
        season = spec.seasons[0]
        cultivars = dict(self._cultivars())
        if season.crop_or_variety not in cultivars:
            raise _RunFailed(f"rice variety {season.crop_or_variety!r} is not in RICER048.CUL")

        wd = spec.work_dir
        wd.mkdir(parents=True, exist_ok=True)
        pdate = season.planting_date
        w = spec.weather
        if w.index.min().date() > pdate or w.index.max().date() < pdate + timedelta(days=60):
            raise _RunFailed(f"weather record {w.index.min().date()}..{w.index.max().date()} "
                             f"does not cover planting date {pdate}")

        self._write_profile(wd)
        block = self._read_profile(Path(spec.soil.file), spec.soil.profile_id)
        lat, lon, soil_layers = self._profile_facts(block)
        (wd / f"{spec.soil.profile_id[:2]}.SOL").write_text(
            "*SOILS: ORYZON single-profile extract\n\n" + "\n".join(block) + "\n")
        soil_id = spec.soil.profile_id
        self._write_weather(wd, w, pdate, lat, lon)

        s = self._season_dict(season, spec)
        mgmt = season.management
        controls: dict = {}
        auto = None
        if mgmt is not None:
            controls = {"OPTIONS": {k: mgmt.controls[k] for k in ("MESOM", "MESOL") if k in mgmt.controls}}
            auto = mgmt.auto or None
        emit_filex(wd / f"{EXP_ID}.RIX", experiment_id=EXP_ID, title="ORYZON run",
                   seasons=[s], controls=controls, potential=spec.potential,
                   soil_id=soil_id, wsta=WSTA, auto=(auto or {}) if s["irrigation_auto"] and not spec.potential else None)

        try:
            proc = subprocess.run([str(self.exe), "A", f"{EXP_ID}.RIX"], cwd=wd, capture_output=True,
                                  text=True, timeout=RUN_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            raise _RunFailed(f"DSSAT timed out after {RUN_TIMEOUT_S}s")
        (wd / "dssat.stdout.log").write_text(proc.stdout + proc.stderr)
        return self._parse(wd, proc, season, soil_layers)

    @staticmethod
    def _season_dict(season, spec: ExperimentSpec) -> dict:
        """emit_filex season dict. Management comes from `season.management` (a selected
        preset, dates already rebased) or, when None, from DEFAULT_MANAGEMENT below."""
        pdate = season.planting_date
        s = {
            "cultivar": season.crop_or_variety, "planting": pdate,
            "establishment": season.establishment,
            "ic": None if spec.initial_conditions is None else SimpleNamespace(
                root_kg_ha=config.IC_ROOT_KG_HA, pcr=config.IC_PCR,
                layers=spec.initial_conditions.layers),
        }
        mgmt = season.management
        if mgmt is None:
            d = DEFAULT_MANAGEMENT[season.establishment]
            s.update(d["planting"])
            s["irrigation"] = tuple({"date": pdate + timedelta(days=dap), "amount_mm": mm, "method": code}
                                    for dap, mm, code in d["irrigation"])
            s["fertilizer"] = tuple({"date": pdate + timedelta(days=dap), "kg_n_ha": kg,
                                     "placement": plc, "depth_cm": dep}
                                    for dap, kg, plc, dep in d["fertilizer"])
            s["irrigation_auto"] = d["irrigation_auto"]
            return s
        p = {k.lower(): v for k, v in mgmt.planting.items()}
        for k in ("ppop", "ppoe", "pldp", "plrs", "page", "penv", "plph"):
            if p.get(k) not in (None, "-99"):
                s[k] = _num(p[k])
        s["irrigation"] = tuple({"date": e.date, "amount_mm": e.amount_mm, "method": e.method}
                                for e in mgmt.irrigation)
        s["fertilizer"] = tuple({"date": e.date, "kg_n_ha": e.kg_n_ha, "placement": e.placement,
                                 "depth_cm": e.depth_cm} for e in mgmt.fertilizer)
        s["irrigation_auto"] = mgmt.irrigation_auto
        return s

    # -- inputs ----------------------------------------------------------------------------------

    def _write_profile(self, wd: Path) -> None:
        src = (self.home / "DSSATPRO.L48").read_text()
        (wd / "DSSATPRO.L48").write_text(
            src.replace("/usr/local", str(self.home)) if "/usr/local" in src else src)

    @staticmethod
    def _write_weather(wd: Path, w: pd.DataFrame, pdate: date, lat: float, lon: float) -> None:
        """DSSAT .WTH for one continuous scenario record. The file is named for the YEAR OF
        THE START DATE (DSSAT's WSTA + YY + '01' rule) and may span several years."""
        missing = {"SRAD", "TMAX", "TMIN", "RAIN", "DEWP"} - set(w.columns)
        if missing or w[["SRAD", "TMAX", "TMIN", "RAIN"]].isna().any().any():
            raise _RunFailed(f"weather record is incomplete (missing {sorted(missing) or 'values'})")
        tmean = (w["TMAX"] + w["TMIN"]) / 2
        tav = tmean.mean()
        monthly = tmean.groupby(w.index.month).mean()
        amp = (monthly.max() - monthly.min()) / 2
        lines = [f"*WEATHER DATA : ORYZON scenario {w.index.min().date()}..{w.index.max().date()}",
                 "@ INSI      LAT     LONG  ELEV   TAV   AMP REFHT WNDHT",
                 f"  {WSTA}   {lat:7.3f} {lon:8.3f}   -99 {tav:5.1f} {amp:5.1f}  2.00  2.00",
                 "@DATE  SRAD  TMAX  TMIN  RAIN  DEWP"]
        for d, r in w.iterrows():
            lines.append(f"{d.year % 100:02d}{d.timetuple().tm_yday:03d} {r.SRAD:5.1f} {r.TMAX:5.1f} "
                         f"{r.TMIN:5.1f} {max(r.RAIN, 0):5.1f} {r.DEWP:5.1f}")
        (wd / f"{WSTA}{pdate.year % 100:02d}01.WTH").write_text("\n".join(lines) + "\n")

    @staticmethod
    def _read_profile(country_file: Path, profile_id: str) -> list[str]:
        """Lines of ONE profile out of the (11 MB) country .SOL file."""
        block: list[str] = []
        grab = False
        with open(country_file, errors="replace") as fh:
            for raw in fh:
                line = raw.rstrip("\r\n")
                if line.startswith("*") and not line.startswith("*SOILS"):
                    if grab:
                        break
                    grab = line[1:].split()[0] == profile_id
                if grab:
                    block.append(line)
        if not block:
            raise _RunFailed(f"soil profile {profile_id} not found in {country_file.name}")
        return block

    @staticmethod
    def _profile_facts(block: list[str]) -> tuple[float, float, list[dict]]:
        """(lat, lon, [{slb, bd}]) from a profile block: the @SITE row and the layer table."""
        lat = lon = None
        layers, hdr, site = [], None, False
        for line in block[1:]:
            if line.startswith("@"):
                toks = line[1:].split()
                site = bool(toks) and toks[0] == "SITE"
                hdr = toks if "SLB" in toks else None
            elif site and line.strip():
                t = line.split()
                lat, lon, site = float(t[2]), float(t[3]), False
            elif hdr and line.strip():
                v = line.split()
                if len(v) == len(hdr):
                    layers.append({"slb": float(v[hdr.index("SLB")]), "bd": float(v[hdr.index("SBDM")])})
        if lat is None or not layers:
            raise _RunFailed(f"soil profile {block[0][1:].split()[0]} lacks site coordinates or layers")
        return lat, lon, layers

    # -- outputs ---------------------------------------------------------------------------------

    def _parse(self, wd: Path, proc, season, soil_layers) -> RunResult:
        summary = wd / "Summary.OUT"
        if not summary.exists():
            raise _RunFailed(f"DSSAT produced no Summary.OUT (exit {proc.returncode}): {self._why(wd, proc)}")
        row = _table(summary)
        if not row:
            raise _RunFailed(f"DSSAT Summary.OUT has no data row: {self._why(wd, proc)}")
        hwam = _f(row.get("HWAM"))
        mdat = row.get("MDAT", "-99")
        if hwam is None or hwam < 0 or mdat in ("-99", "0"):
            raise _RunFailed(f"rice did not reach maturity / no yield reported "
                             f"(HWAM={row.get('HWAM')}, MDAT={mdat}): {self._why(wd, proc)}")
        maturity = datetime.strptime(mdat, "%Y%j").date()
        soil_start, soil_end = self._soil_states(wd, soil_layers)
        return RunResult((SeasonResult("rice", season.crop_or_variety, hwam, maturity, None),),
                         soil_start, soil_end, "ok", None)

    def _soil_states(self, wd: Path, layers: list[dict]) -> tuple[SoilState | None, SoilState | None]:
        org = _daily(wd / "SoilOrg.OUT", ("SCTD", "SNTD"))
        ni = _daily(wd / "SoilNi.OUT", ("NT1D", "NT2D", "NT3D"))
        if not org or not ni:
            return None, None

        def state(o, n) -> SoilState:
            # mineral N 0..SOIL_DEPTH_CM: ppm * bulk density (g/cm3) * thickness (cm) * 0.1 = kg/ha
            # DSSAT reports NT1D..NT3D for 0-5, 5-15, 15-20 cm.
            bounds, ppm, total, top = (5.0, 15.0, 20.0), (n["NT1D"], n["NT2D"], n["NT3D"]), 0.0, 0.0
            for hi, c in zip(bounds, ppm):
                hi_c = min(hi, config.SOIL_DEPTH_CM)
                if hi_c <= top:
                    continue
                bd = next((L["bd"] for L in layers if L["slb"] >= hi), layers[-1]["bd"])
                total += c * bd * (hi_c - top) * 0.1
                top = hi_c
            return SoilState(soc_kg_ha=o["SCTD"], son_kg_ha=o["SNTD"], mineral_n_kg_ha=round(total, 2))
        return state(org[0], ni[0]), state(org[-1], ni[-1])

    @staticmethod
    def _why(wd: Path, proc) -> str:
        for name in ("ERROR.OUT", "WARNING.OUT"):
            f = wd / name
            if f.exists():
                txt = " ".join(f.read_text(errors="replace").split())
                if txt:
                    return txt[:300]
        return (proc.stdout + proc.stderr).strip()[-300:] or "no diagnostic output"


# -- helpers ----------------------------------------------------------------------------------


class _RunFailed(Exception):
    pass


def _num(v):
    try:
        f = float(v)
        return int(f) if f == int(f) else f
    except ValueError:
        return v


def _f(v) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _table(path: Path) -> dict[str, str]:
    """First data row of a DSSAT Summary.OUT as {COLUMN: value} (column names from the '@' row)."""
    header = None
    for raw in path.read_text(errors="replace").splitlines():
        if raw.startswith("@"):
            header = raw[1:].split()
        elif header and raw.strip() and not raw.startswith(("!", "*")):
            vals = raw.split()
            return dict(zip(header, vals)) if len(vals) >= len(header) - 4 else {}
    return {}


def _daily(path: Path, cols: tuple[str, ...]) -> list[dict[str, float]]:
    """All daily rows of a *.OUT file as dicts of the requested columns."""
    if not path.exists():
        return []
    header, out = None, []
    for raw in path.read_text(errors="replace").splitlines():
        if raw.startswith("@"):
            header = raw[1:].split()
        elif header and raw.strip() and raw[0] == " ":
            vals = raw.split()
            if len(vals) == len(header):
                out.append({c: float(vals[header.index(c)]) for c in cols if c in header})
    return [r for r in out if len(r) == len(cols)]
