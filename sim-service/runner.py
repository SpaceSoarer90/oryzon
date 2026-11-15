"""Runner interface — the boundary between this service and the owner's DSSAT work
(AUDIT.md §5). The owner implements `Runner` against the calibrated DSSAT environment;
`StubRunner` stands in until then so the whole pipeline is testable end to end.

Contract notes (spec):
- Ideal runs: same cultivar / planting date / soil / weather, water + N stress OFF
  (switch names verified in the installed build before results are trusted, AUDIT.md A4),
  standalone — no carried-over state (spec §5).
- Actual sequence runs: ONE run per sequence, season 2 soil state = season 1 end state (D1).
- A failed run returns status "failed" with the error; it is excluded and reported,
  never imputed as zero (spec §5).
- All yields are kg dry matter/ha (spec §4).
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Literal, Protocol

import pandas as pd

CropKind = Literal["rice", "yield_crop", "cover"]
Establishment = Literal["T", "DS"]     # transplanted / direct-seeded (AUDIT.md O3)


@dataclass(frozen=True)
class Termination:
    """Cover-crop termination (AUDIT.md O2)."""
    dap: int
    residue: str = "incorporate"


@dataclass(frozen=True)
class SeasonSpec:
    kind: CropKind
    crop_or_variety: str
    planting_date: date
    establishment: Establishment
    termination: Termination | None = None    # cover crops only


@dataclass(frozen=True)
class SoilRef:
    profile_id: str
    file: Path


@dataclass(frozen=True)
class ICData:
    """Initial conditions, assembled by the orchestrator. Applied to the FIRST season
    of each actual run only (spec D1); None for ideal runs (standalone, spec §5).

    layers: per-layer dicts with keys slb (depth cm), sh2o, snh4, sno3 — the values the
    runner translates into DSSAT initial-conditions sections at SOIL_DEPTH coverage.
    """
    layers: tuple[dict, ...]
    planting_date: date


@dataclass(frozen=True)
class ExperimentSpec:
    """One DSSAT run: one scenario, one sequence, actual or ideal."""
    seasons: tuple[SeasonSpec, ...]
    potential: bool                 # True = ideal run (water + N stress off)
    weather: pd.DataFrame           # ONE continuous daily record: DATE index + SRAD, TMAX, TMIN, RAIN, DEWP
    soil: SoilRef
    initial_conditions: ICData | None
    work_dir: Path                  # isolated per run (spec §5)


@dataclass(frozen=True)
class SeasonResult:
    kind: CropKind
    crop_or_variety: str
    yield_kg_ha: float | None                    # harvested dry matter at maturity
    maturity_date: date | None
    biomass_at_termination_kg_ha: float | None   # cover crops only (spec §4)


@dataclass(frozen=True)
class SoilState:
    soc_kg_ha: float
    son_kg_ha: float
    mineral_n_kg_ha: float


@dataclass(frozen=True)
class RunResult:
    seasons: tuple[SeasonResult, ...]
    soil_start: SoilState | None   # state at run start (IC or carried-over state; D1)
    soil_end: SoilState | None     # state at end of the LAST season (spec §4 net change)
    status: Literal["ok", "failed"]
    error: str | None = None


class Runner(Protocol):
    """What the owner's DSSAT environment must expose (AUDIT.md §5)."""

    def calibrated_rice_varieties(self) -> list[str]: ...
    def calibrated_yield_crops(self) -> list[str]: ...
    def dssat_version(self) -> str: ...
    def cultivar_coefficient_source(self) -> str: ...
    def soil_version(self) -> str: ...
    def run_experiment(self, spec: ExperimentSpec) -> RunResult: ...


def _digest(*parts) -> int:
    """Stable, deterministic pseudo-random value in [0, 10**6) for the stub."""
    return int(hashlib.sha256("|".join(map(str, parts)).encode()).hexdigest(), 16) % 1_000_000


class StubRunner:
    """Deterministic placeholder runner. Yields react to weather (so scenario
    ensembles produce a spread) and to variety (so RY ranking is meaningful), but
    nothing here is agronomy — it exercises the pipeline until the real runner lands."""

    RICE_VARIETIES = ["IB0015", "STUB-002", "STUB-003", "STUB-004"]
    YIELD_CROPS = ["Corn", "Onion", "Garlic"]

    def calibrated_rice_varieties(self) -> list[str]:
        return list(self.RICE_VARIETIES)

    def calibrated_yield_crops(self) -> list[str]:
        return list(self.YIELD_CROPS)

    def dssat_version(self) -> str:
        return "stub"

    def cultivar_coefficient_source(self) -> str:
        return "stub (no calibrated coefficients)"

    def soil_version(self) -> str:
        return "stub"

    def run_experiment(self, spec: ExperimentSpec) -> RunResult:
        results: list[SeasonResult] = []
        for season in spec.seasons:
            h = _digest(season.kind, season.crop_or_variety,
                        season.planting_date.isoformat(), season.establishment)
            if season.kind == "cover":
                end = season.planting_date + timedelta(days=season.termination.dap)
                rain = self._rain(spec.weather, season.planting_date, end)
                # aboveground biomass at termination (kg DM/ha), reported only (spec §4)
                biomass = 2200.0 + h % 600 + rain / 50.0
                results.append(SeasonResult(season.kind, season.crop_or_variety,
                                            None, end, round(biomass, 1)))
                continue
            end = season.planting_date + timedelta(days=110 + h % 12)
            # Weather counts only up to this season's maturity, so a sequence run's
            # pre-crop yield equals the standalone stage-1 run for the same scenario
            # (spec §5 assertion).
            rain = self._rain(spec.weather, season.planting_date, end)
            base = 5500.0 + (h % 1500)
            if spec.potential:
                base *= 1.25   # ideal ceiling: same variety, stress off
            elif season.kind == "yield_crop":
                base *= 0.9
            results.append(SeasonResult(
                season.kind, season.crop_or_variety,
                round(base + rain / 200.0, 1), end, None))
        h = _digest("soil", spec.soil.profile_id, spec.seasons[0].planting_date.isoformat(),
                    spec.potential)
        start = SoilState(round(5000 + h % 500, 1), round(450 + h % 50, 1), round(28 + h % 10, 1))
        end = SoilState(round(start.soc_kg_ha + 80 + h % 120, 1),
                        round(start.son_kg_ha + 8 + h % 8, 1),
                        round(start.mineral_n_kg_ha + h % 12, 1))
        return RunResult(tuple(results), start, end, "ok", None)

    @staticmethod
    def _rain(weather: pd.DataFrame, start: date, end: date) -> float:
        if "RAIN" not in weather:
            return 0.0
        mask = (weather.index >= pd.Timestamp(start)) & (weather.index <= pd.Timestamp(end))
        return float(weather.loc[mask, "RAIN"].sum())


def build_runner(kind: str) -> Runner:
    """Fail fast at startup on an unknown runner name (spec §4 style validation)."""
    runners: dict[str, type[Runner]] = {"stub": StubRunner}
    if kind not in runners:
        raise RuntimeError(f"unknown runner {kind!r}; known: {sorted(runners)}")
    return runners[kind]()
