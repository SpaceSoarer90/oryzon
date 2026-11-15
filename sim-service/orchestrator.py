"""Recommendation pipeline (spec §3 flow, §4 metrics, §5 rules, §7 schema).

Ranking: mean relative yield (RY = actual/ideal, paired by scenario) descending,
ties by id ascending, top 3 (spec §4, §6). Absolute yields are never summed or
compared across crops (rule 4); the soil net change is displayed only (§4).

Scenario windows (O5): each scenario is one continuous 2-year record [Y, Y+1], so
any planting date's run fits inside it; when Y+1 is not on disk the window shifts
back one year ([Y-1, Y]).

Stage-2 date rule (O1): the pre-crop runs to simulated maturity, rice planted
STAGE2_GAP_DAYS later, per scenario. Cover-crop termination (O2): fixed DAP,
residue incorporated; rice follows after the same gap.
"""
from __future__ import annotations

import hashlib
import threading
from dataclasses import dataclass
from datetime import date, timedelta

import numpy as np

import config
from runner import ExperimentSpec, ICData, Runner, SeasonSpec, SoilRef, Termination
from schema import (CropEntry, FailedRun, IdealStat, Metadata, PreCrop, RangeStat,
                    RecommendationResult, SoilDelta, VarietyEntry)
from store import SoilStore, WeatherStore

TOP_N = 3          # spec §6
RY_TOL = 1e-6      # RY above 1 beyond this tolerance is a setup error (spec §4)
YIELD_TOL = 0.5    # kg/ha tolerance for the stage-1/stage-2 equality assertion (spec §5)


class Progress:
    """Run progress shared with the API layer (spec §6)."""

    def __init__(self):
        self._lock = threading.Lock()
        self.done = 0
        self.total: int | None = None

    def set_total(self, n: int) -> None:
        with self._lock:
            self.total = n

    def tick(self, n: int = 1) -> None:
        with self._lock:
            self.done += n

    def snapshot(self) -> dict:
        with self._lock:
            return {"done": self.done, "total": self.total}


def _stats(values: list[float]) -> RangeStat:
    vals = [float(v) for v in values if v is not None and np.isfinite(v)]
    if not vals:
        raise ValueError("no scenarios to aggregate")
    p10 = p90 = None
    if len(vals) > 1:
        p10 = round(float(np.percentile(vals, 10)), 4)
        p90 = round(float(np.percentile(vals, 90)), 4)
    return RangeStat(mean=round(float(np.mean(vals)), 4), p10=p10, p90=p90)


def _rebase(d: date, year: int) -> date:
    """Same month/day in the scenario year; Feb 29 becomes Feb 28 off-leap years."""
    try:
        return d.replace(year=year)
    except ValueError:
        return date(year, 2, 28)


@dataclass
class _RunOutcome:
    result: object | None          # RunResult when ok/failed-with-result, None on exception
    failure: FailedRun | None


class Orchestrator:
    def __init__(self, runner: Runner, weather: WeatherStore, soil: SoilStore):
        self.runner = runner
        self.weather = weather
        self.soil = soil
        self._cache: dict[tuple, _RunOutcome] = {}
        self._windows: list[tuple[int, ...]] | None = None

    # -- scenarios (spec §4 + O5) ---------------------------------------------------------

    def scenario_windows(self) -> list[tuple[int, ...]]:
        if self._windows is None:
            years = self.weather.available_years()
            if not years:
                raise RuntimeError("no complete weather years in the store")
            if config.WEATHER_YEARS:
                starts = [y for y in config.WEATHER_YEARS if y in years]
            else:
                starts = years[-10:]     # 10 most recent complete years (spec §4)
            windows: list[tuple[int, ...]] = []
            for y in starts:
                w = self._window_for(y, years)
                if w not in windows:     # a shifted window can duplicate its neighbour
                    windows.append(w)
            self._windows = windows
        return self._windows

    @staticmethod
    def _window_for(y: int, years: list[int]) -> tuple[int, ...]:
        if y + 1 in years:
            return (y, y + 1)
        if y - 1 in years:
            return (y - 1, y)
        return (y,)

    # -- IC and one cached run (spec §5) ----------------------------------------------------

    def _ic(self, layers: list[dict], pdate_s: date) -> ICData:
        ic_layers = tuple(
            {"slb": L["slb"], "sh2o": min(L["sdul"], L["ssat"]),   # soil at field capacity
             "snh4": config.IC_NH4_TOP if i < 3 else config.IC_NH4_DEEP,
             "sno3": config.IC_NO3_TOP if i < 3 else config.IC_NO3_DEEP}
            for i, L in enumerate(layers))
        return ICData(ic_layers, pdate_s)

    def _run(self, *, label: str, seasons: list[SeasonSpec], potential: bool,
             weather, soil_ref: SoilRef, ic: ICData | None, work_root, window,
             run_type: str, tick) -> _RunOutcome:
        """One runner call, cached per spec §5 (farm, planting dates, sequence, run
        type, scenario, DSSAT version, soil/IC version)."""
        ic_key = "none" if ic is None else hashlib.md5(
            repr((ic.layers, ic.planting_date)).encode()).hexdigest()[:8]
        key = (round(self._lat, 4), round(self._lon, 4), label, run_type, window[0],
               tuple(s.planting_date for s in seasons),
               self.runner.dssat_version(), self.runner.soil_version(), ic_key)
        if key in self._cache:
            tick()
            return self._cache[key]
        work_dir = work_root / f"{label.replace(':', '_').replace('->', '-')}_{run_type}_{window[0]}"
        work_dir.mkdir(parents=True, exist_ok=True)
        try:
            result = self.runner.run_experiment(ExperimentSpec(
                tuple(seasons), potential, weather, soil_ref, ic, work_dir))
            failure = None
            if result.status != "ok":
                failure = FailedRun(sequence=label, scenario=window[0], run_type=run_type,
                                    error=result.error or "runner reported failure")
        except Exception as exc:     # a failed run is excluded and reported, never zero (spec §5)
            result, failure = None, FailedRun(sequence=label, scenario=window[0],
                                              run_type=run_type, error=f"{type(exc).__name__}: {exc}")
        outcome = _RunOutcome(result, failure)
        self._cache[key] = outcome
        tick()
        return outcome

    # -- variety aggregation (spec §4, §7) ----------------------------------------------------

    def _rank_varieties(self, *, varieties: list[str], actual: dict, ideal: dict,
                        pre_crop: PreCrop | None, meta: Metadata,
                        windows, notes: list[str]) -> list[VarietyEntry]:
        """actual/ideal: (variety|crop_id, window) -> _RunOutcome. Rice ideal ceiling
        per scenario = max over varieties (spec §4), so varieties rank in yield order."""
        ceiling: dict[tuple, float] = {}
        for w in windows:
            vals = [o.result.seasons[-1].yield_kg_ha for (vid, ww), o in ideal.items()
                    if ww == w and o.result is not None and o.result.status == "ok"
                    and o.result.seasons[-1].yield_kg_ha is not None]
            if vals:
                ceiling[w] = max(vals)
        entries: list[VarietyEntry] = []
        for v in varieties:
            ys, rys, ideals, soils, fails = [], [], [], [], []
            for w in windows:
                a_out = actual.get((v, w))
                i_out = ideal.get((v, w))
                if a_out is None or a_out.result is None or a_out.result.status != "ok":
                    if a_out and a_out.failure:
                        fails.append(a_out.failure)
                    continue
                if a_out.result.seasons[-1].yield_kg_ha is None:
                    # runner reported ok but no harvest: exclude the scenario, report it
                    fails.append(FailedRun(sequence=f"actual:{v}", scenario=w[0], run_type="actual",
                                           error="runner returned no yield for the ranked season"))
                    continue
                if w not in ceiling or i_out is None or i_out.result is None or i_out.result.status != "ok":
                    if i_out and i_out.failure:
                        fails.append(i_out.failure)
                    continue      # scenario excluded, reported (spec §4)
                a = a_out.result.seasons[-1].yield_kg_ha
                ry = a / ceiling[w]
                if ry > 1 + RY_TOL:
                    notes.append(f"RY > 1 for {v} in scenario {w[0]} — setup error: the ideal "
                                 f"ceiling must dominate every actual yield (spec §4)")
                ys.append(a)
                rys.append(ry)
                ideals.append(ceiling[w])
                res = a_out.result
                if res.soil_start is not None and res.soil_end is not None:
                    soils.append((res.soil_end.soc_kg_ha - res.soil_start.soc_kg_ha,
                                  res.soil_end.son_kg_ha - res.soil_start.son_kg_ha,
                                  res.soil_end.mineral_n_kg_ha))
            if not ys:
                continue          # every scenario failed for this candidate
            if soils:
                soil = SoilDelta(
                    d_soc_kg_ha=round(float(np.mean([s[0] for s in soils])), 4),
                    d_son_kg_ha=round(float(np.mean([s[1] for s in soils])), 4),
                    mineral_n_end_kg_ha=round(float(np.mean([s[2] for s in soils])), 4))
            else:
                notes.append(f"no soil state reported for {v}; soil net change unavailable")
                soil = SoilDelta(d_soc_kg_ha=0.0, d_son_kg_ha=0.0, mineral_n_end_kg_ha=0.0)
            entries.append(VarietyEntry(
                rank=0, variety=v, pre_crop=pre_crop,
                rice_actual=_stats(ys),
                rice_ideal=IdealStat(mean=round(float(np.mean(ideals)), 4)),
                relative_yield=_stats(rys), soil_delta=soil,
                metadata=meta, failed_runs=fails))
        entries.sort(key=lambda e: (-e.relative_yield.mean, e.variety))
        for i, e in enumerate(entries, 1):
            e.rank = i
        return entries[:TOP_N]

    # -- branches -----------------------------------------------------------------------------

    def recommend(self, req: dict, *, run_id: str, tick, set_total) -> RecommendationResult:
        farm = req["farm"]
        self._lat, self._lon = float(farm["lat"]), float(farm["lon"])
        est = farm.get("establishment", "DS")
        branch = req["branch"]
        pdate = req["planting_date"] if isinstance(req["planting_date"], date) else \
            date.fromisoformat(str(req["planting_date"]))
        pre_crop = req.get("pre_crop")

        windows = self.scenario_windows()
        profile_id, layers = self.soil.find_profile(self._lat, self._lon)
        soil_ref = SoilRef(profile_id, self.soil.path)
        work_root = config.DSSAT_DIR / "intermediate-input-files" / run_id
        meta = Metadata(dssat_version=self.runner.dssat_version(),
                        weather_source=config.WEATHER_SOURCE,
                        soil_om_module=config.SOIL_OM_MODULE,
                        cultivar_coefficient_source=self.runner.cultivar_coefficient_source(),
                        ideal_yield_source=config.IDEAL_YIELD_SOURCE)
        notes: list[str] = []
        failed: list[FailedRun] = []
        scenarios = [w[0] for w in windows]

        varieties = self.runner.calibrated_rice_varieties()
        crops = self.runner.calibrated_yield_crops()

        # ---- Rice branch: every variety, actual + ideal, ranked by mean RY ------------------
        if branch == "rice":
            if not varieties:
                return RecommendationResult(branch=branch, scenarios=scenarios, crops=None,
                                            varieties=[], metadata=meta, failed_runs=[],
                                            notes=["No calibrated rice varieties yet."])
            set_total(len(varieties) * len(windows) * 2)
            actual: dict = {}
            ideal: dict = {}
            for w in windows:
                weather = self.weather.daily_weather(self._lat, self._lon, list(w))
                pdate_s = _rebase(pdate, w[0])
                ic = self._ic(layers, pdate_s)
                for v in varieties:
                    actual[v, w] = self._run(label=f"rice:{v}",
                                             seasons=[SeasonSpec("rice", v, pdate_s, est)],
                                             potential=False, weather=weather, soil_ref=soil_ref,
                                             ic=ic, work_root=work_root, window=w,
                                             run_type="actual", tick=tick)
                    ideal[v, w] = self._run(label=f"rice:{v}",
                                            seasons=[SeasonSpec("rice", v, pdate_s, est)],
                                            potential=True, weather=weather, soil_ref=soil_ref,
                                            ic=None, work_root=work_root, window=w,
                                            run_type="ideal", tick=tick)
                    if actual[v, w].failure:
                        failed.append(actual[v, w].failure)
                    if ideal[v, w].failure:
                        failed.append(ideal[v, w].failure)
            entries = self._rank_varieties(varieties=varieties, actual=actual, ideal=ideal,
                                           pre_crop=None, meta=meta, windows=windows, notes=notes)
            return RecommendationResult(branch=branch, scenarios=scenarios, crops=None,
                                        varieties=entries, metadata=meta,
                                        failed_runs=failed, notes=notes)

        # ---- Yield Crops branch -------------------------------------------------------------
        if branch == "yield_crops":
            if pre_crop is None:
                # Stage 1: rank the yield crops; user picks one (spec §3).
                if not crops:
                    return RecommendationResult(branch=branch, scenarios=scenarios, crops=[],
                                                varieties=[], metadata=meta, failed_runs=[],
                                                notes=["No calibrated yield crops yet."])
                set_total(len(crops) * len(windows) * 2)
                entries: list[CropEntry] = []
                for w in windows:
                    weather = self.weather.daily_weather(self._lat, self._lon, list(w))
                    pdate_s = _rebase(pdate, w[0])
                    ic = self._ic(layers, pdate_s)
                    for c in crops:
                        a = self._run(label=f"yield_crop:{c}",
                                      seasons=[SeasonSpec("yield_crop", c, pdate_s, est)],
                                      potential=False, weather=weather, soil_ref=soil_ref,
                                      ic=ic, work_root=work_root, window=w,
                                      run_type="actual", tick=tick)
                        i = self._run(label=f"yield_crop:{c}",
                                      seasons=[SeasonSpec("yield_crop", c, pdate_s, est)],
                                      potential=True, weather=weather, soil_ref=soil_ref,
                                      ic=None, work_root=work_root, window=w,
                                      run_type="ideal", tick=tick)
                        if a.failure:
                            failed.append(a.failure)
                        if i.failure:
                            failed.append(i.failure)
                        if (a.result is None or i.result is None
                                or a.result.status != "ok" or i.result.status != "ok"
                                or a.result.seasons[0].yield_kg_ha is None
                                or i.result.seasons[0].yield_kg_ha is None):
                            continue      # scenario excluded for this crop, reported above
                        ay = a.result.seasons[0].yield_kg_ha
                        iy = i.result.seasons[0].yield_kg_ha
                        ry = ay / iy
                        if ry > 1 + RY_TOL:
                            notes.append(f"RY > 1 for {c} in scenario {w[0]} — setup error "
                                         f"(spec §4)")
                        entries.append(CropEntry(rank=0, crop=c,
                                                 actual_yield=_stats([ay]),
                                                 ideal_yield=IdealStat(mean=round(iy, 4)),
                                                 relative_yield=_stats([ry])))
                # aggregate per crop across scenarios
                by_crop: dict[str, list[CropEntry]] = {}
                for e in entries:
                    by_crop.setdefault(e.crop, []).append(e)
                ranked: list[CropEntry] = []
                for c, rows in by_crop.items():
                    ranked.append(CropEntry(
                        rank=0, crop=c,
                        actual_yield=_stats([r.actual_yield.mean for r in rows]),
                        ideal_yield=IdealStat(mean=round(
                            float(np.mean([r.ideal_yield.mean for r in rows])), 4)),
                        relative_yield=_stats([r.relative_yield.mean for r in rows])))
                ranked.sort(key=lambda e: (-e.relative_yield.mean, e.crop))
                for i, e in enumerate(ranked, 1):
                    e.rank = i
                return RecommendationResult(branch=branch, scenarios=scenarios,
                                            crops=ranked[:TOP_N], varieties=[], metadata=meta,
                                            failed_runs=failed, notes=notes)

            # Stage 2: one sequence run per variety [c -> rice(v)] from IC (spec §5).
            if pre_crop not in crops:
                raise ValueError(f"pre-crop {pre_crop!r} is not a calibrated yield crop")
            if not varieties:
                return RecommendationResult(branch=branch, scenarios=scenarios, crops=None,
                                            varieties=[], metadata=meta, failed_runs=[],
                                            notes=["No calibrated rice varieties yet."])
            set_total(len(windows) * (2 * len(varieties) + 1))
            stage1: dict = {}
            actual, ideal = {}, {}
            for w in windows:
                weather = self.weather.daily_weather(self._lat, self._lon, list(w))
                pdate_s = _rebase(pdate, w[0])
                ic = self._ic(layers, pdate_s)
                stage1[w] = self._run(label=f"yield_crop:{pre_crop}",
                                      seasons=[SeasonSpec("yield_crop", pre_crop, pdate_s, est)],
                                      potential=False, weather=weather, soil_ref=soil_ref,
                                      ic=ic, work_root=work_root, window=w,
                                      run_type="actual", tick=tick)
                if stage1[w].failure:
                    failed.append(stage1[w].failure)
                    continue          # no maturity date -> no stage-2 planting date (O1)
                maturity1 = stage1[w].result.seasons[0].maturity_date
                if maturity1 is None:
                    notes.append(f"pre-crop {pre_crop} never matured in scenario {w[0]}; "
                                 f"scenario excluded (O1 fallback)")
                    continue
                pdate2 = maturity1 + timedelta(days=config.STAGE2_GAP_DAYS)
                for v in varieties:
                    seq = self._run(label=f"{pre_crop}->rice:{v}",
                                    seasons=[SeasonSpec("yield_crop", pre_crop, pdate_s, est),
                                             SeasonSpec("rice", v, pdate2, est)],
                                    potential=False, weather=weather, soil_ref=soil_ref,
                                    ic=ic, work_root=work_root, window=w,
                                    run_type="actual", tick=tick)
                    ideal_rice = self._run(label=f"rice:{v}",
                                           seasons=[SeasonSpec("rice", v, pdate2, est)],
                                           potential=True, weather=weather, soil_ref=soil_ref,
                                           ic=None, work_root=work_root, window=w,
                                           run_type="ideal", tick=tick)
                    # Stage-2 pre-crop yield must equal the stage-1 actual yield (spec §5).
                    if seq.result is not None and seq.result.status == "ok" and stage1[w].result:
                        s1 = seq.result.seasons[0].yield_kg_ha
                        s1_ref = stage1[w].result.seasons[0].yield_kg_ha
                        if s1 is not None and s1_ref is not None and abs(s1 - s1_ref) > YIELD_TOL:
                            notes.append(f"stage-2 pre-crop yield mismatch for {pre_crop}/{v} "
                                         f"in scenario {w[0]} — runner contract violation "
                                         f"(spec §5); scenario excluded")
                            seq = _RunOutcome(None, seq.failure)
                    if seq.failure:
                        failed.append(seq.failure)
                    if ideal_rice.failure:
                        failed.append(ideal_rice.failure)
                    actual[v, w], ideal[v, w] = seq, ideal_rice
            mean_stage1 = round(float(np.mean([
                stage1[w].result.seasons[0].yield_kg_ha for w in windows
                if stage1.get(w) and stage1[w].result is not None
                and stage1[w].result.status == "ok"
                and stage1[w].result.seasons[0].yield_kg_ha is not None])), 4) \
                if any(stage1.get(w) and stage1[w].result and stage1[w].result.status == "ok"
                       for w in windows) else 0.0
            entries = self._rank_varieties(varieties=varieties, actual=actual, ideal=ideal,
                                           pre_crop=PreCrop(type="yield_crop", id=pre_crop,
                                                            actual_yield_mean=mean_stage1),
                                           meta=meta, windows=windows, notes=notes)
            return RecommendationResult(branch=branch, scenarios=scenarios, crops=None,
                                        varieties=entries, metadata=meta,
                                        failed_runs=failed, notes=notes)

        # ---- Monggo branch: cover crop -> rice(v), one sequence run from IC ------------------
        if not varieties:
            return RecommendationResult(branch=branch, scenarios=scenarios, crops=None,
                                        varieties=[], metadata=meta, failed_runs=[],
                                        notes=["No calibrated rice varieties yet."])
        set_total(len(varieties) * len(windows) * 2)
        actual, ideal = {}, {}
        for w in windows:
            weather = self.weather.daily_weather(self._lat, self._lon, list(w))
            pdate_s = _rebase(pdate, w[0])
            ic = self._ic(layers, pdate_s)
            pdate2 = pdate_s + timedelta(days=config.COVER_TERM_DAP + config.STAGE2_GAP_DAYS)
            for v in varieties:
                seq = self._run(label="cover->rice:" + v,
                                seasons=[SeasonSpec("cover", "mung bean", pdate_s, est,
                                                    Termination(config.COVER_TERM_DAP,
                                                                config.COVER_RESIDUE)),
                                         SeasonSpec("rice", v, pdate2, est)],
                                potential=False, weather=weather, soil_ref=soil_ref,
                                ic=ic, work_root=work_root, window=w,
                                run_type="actual", tick=tick)
                ideal_rice = self._run(label=f"rice:{v}",
                                       seasons=[SeasonSpec("rice", v, pdate2, est)],
                                       potential=True, weather=weather, soil_ref=soil_ref,
                                       ic=None, work_root=work_root, window=w,
                                       run_type="ideal", tick=tick)
                if seq.failure:
                    failed.append(seq.failure)
                if ideal_rice.failure:
                    failed.append(ideal_rice.failure)
                actual[v, w], ideal[v, w] = seq, ideal_rice
        # Cover biomass is identical across varieties WITHIN a scenario (spec §5): shown once.
        by_window: dict[tuple, list[float]] = {}
        for (v, w), o in actual.items():
            if o.result is not None and o.result.status == "ok" and o.result.seasons \
                    and o.result.seasons[0].biomass_at_termination_kg_ha is not None:
                by_window.setdefault(w, []).append(o.result.seasons[0].biomass_at_termination_kg_ha)
        for w, vals in by_window.items():
            if vals and max(vals) - min(vals) > YIELD_TOL:
                notes.append(f"cover-crop biomass varies between varieties in scenario "
                             f"{w[0]} — runner contract violation (spec §5)")
        biomasses = [b for vals in by_window.values() for b in vals]
        pre = PreCrop(type="cover", id="mung bean",
                      actual_yield_mean=round(float(np.mean(biomasses)), 4)) if biomasses else None
        entries = self._rank_varieties(varieties=varieties, actual=actual, ideal=ideal,
                                       pre_crop=pre, meta=meta, windows=windows, notes=notes)
        return RecommendationResult(branch=branch, scenarios=scenarios, crops=None,
                                    varieties=entries, metadata=meta,
                                    failed_runs=failed, notes=notes)
