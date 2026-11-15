"""Result schema (spec §7) — the exact JSON the recommendation API returns.

Field names are the spec's; nothing here may sum or compare absolute yields across
crops (spec rule 4). RY is returned as `relative_yield`; the UI labels it "percent
of ideal" (spec §6).
"""
from typing import Literal

from pydantic import BaseModel

Branch = Literal["rice", "yield_crops", "monggo"]


class RangeStat(BaseModel):
    """Mean over scenarios, with P10/P90. P10/P90 are null when WEATHER_YEARS is one
    year (deterministic mode, spec §4)."""
    mean: float
    p10: float | None = None
    p90: float | None = None


class IdealStat(BaseModel):
    """Ideal (potential) yield: one figure. For rice it is the highest ideal among
    calibrated varieties in that scenario (spec §4), averaged over scenarios."""
    mean: float


class CropEntry(BaseModel):
    """Yield Crops branch, stage 1 (spec §7)."""
    rank: int
    crop: str
    actual_yield: RangeStat
    ideal_yield: IdealStat
    relative_yield: RangeStat


class PreCrop(BaseModel):
    """The pre-crop in a stage-2 / Monggo sequence (spec §7)."""
    type: Literal["yield_crop", "cover"]
    id: str
    actual_yield_mean: float


class SoilDelta(BaseModel):
    """Soil net change over one actual run, mean over scenarios (spec §4).
    Displayed only; never used for ranking."""
    d_soc_kg_ha: float   # end of last season minus start of first season
    d_son_kg_ha: float
    mineral_n_end_kg_ha: float


class Metadata(BaseModel):
    """Rule 6: recorded on every result."""
    dssat_version: str
    weather_source: str
    soil_om_module: str
    cultivar_coefficient_source: str
    ideal_yield_source: str


class FailedRun(BaseModel):
    """A run that failed: excluded from ranking, never imputed as zero (spec §5)."""
    sequence: str            # e.g. "rice:IB0015", "Corn->rice:IB0015", "cover->rice:IB0015"
    scenario: int            # weather year the scenario started in
    run_type: Literal["actual", "ideal"]
    error: str


class VarietyEntry(BaseModel):
    """One ranked rice variety (spec §7)."""
    rank: int
    variety: str
    pre_crop: PreCrop | None                 # null for the Rice branch
    rice_actual: RangeStat
    rice_ideal: IdealStat
    relative_yield: RangeStat
    soil_delta: SoilDelta
    metadata: Metadata
    failed_runs: list[FailedRun]


class RecommendationResult(BaseModel):
    """Full result of one recommendation run. `crops` is present only for the
    Yield Crops branch (stage 1); `varieties` is the branch's final top-3 list."""
    branch: Branch
    scenarios: list[int]                     # weather years the scenarios used
    crops: list[CropEntry] | None = None
    varieties: list[VarietyEntry]
    metadata: Metadata
    notes: list[str] = []    # setup warnings, empty-candidate states, contract flags
    failed_runs: list[FailedRun]
