"""ORYZON recommendation service.  Run with (from this directory):

    ../backend/.venv/bin/python -m uvicorn main:app --port 8001

Endpoints:
  GET /health          -> liveness + config and runner echo (rule 6 sources)
  GET /api/candidates  -> calibrated crops + rice varieties (spec §5);
                          empty lists drive the "no calibrated crops" UI states
  POST /api/recommendations / GET /api/recommendations/{run_id}
                       -> arrive with the rice branch (AUDIT.md §6, phases 3+)

The existing weather API (../backend/) stays untouched and deployed; this service
runs wherever the processed data lives.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from typing import Literal
from uuid import uuid4

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import config
from experiment_file import describe, load_presets
from filex_runner import discover_filex, run_filex as execute_filex
from orchestrator import Orchestrator, Progress
from runner import build_runner
from store import SoilStore, WeatherStore


class FarmInput(BaseModel):
    lat: float
    lon: float
    establishment: Literal["T", "DS"] = "DS"   # transplanted / direct-seeded (O3)


class RecommendRequest(BaseModel):
    farm: FarmInput
    branch: Literal["rice", "yield_crops", "monggo"]
    planting_date: date                        # the ONE UI date (spec §2)
    pre_crop: str | None = None                # Yield Crops branch, stage 2: the picked crop
    experiment_id: str | None = None           # optional management preset (GET /api/experiments)
    cultivar_ids: list[str] | None = None       # selected rice cultivar IDs (maximum 10)


def _validate_startup() -> None:
    """Fail fast on configuration (spec §4 style startup validation)."""
    if not config.SOIL_FILE.exists():
        raise RuntimeError(f"soil file not found (set ORYZON_SOIL_FILE): {config.SOIL_FILE}")
    if config.IDEAL_YIELD_SOURCE not in ("simulated_potential", "table"):
        raise RuntimeError(f"IDEAL_YIELD_SOURCE must be 'simulated_potential' or 'table', "
                           f"got {config.IDEAL_YIELD_SOURCE!r}")
    if config.IDEAL_YIELD_SOURCE == "table":
        runner = build_runner(config.RUNNER)
        if not config.IDEAL_TABLE_PATH.exists():
            raise RuntimeError(f"IDEAL_YIELD_SOURCE=table but {config.IDEAL_TABLE_PATH} is missing")
        needed = set(runner.calibrated_yield_crops()) | {"rice"}
        have = {line.split(",")[0].strip() for line in
                config.IDEAL_TABLE_PATH.read_text().splitlines() if line.strip()}
        missing = needed - have
        if missing:
            raise RuntimeError(f"ideal table does not cover: {sorted(missing)}")


_validate_startup()
PRESETS = load_presets(config.EXPERIMENTS_DIR)
RUNNER = build_runner(config.RUNNER)

app = FastAPI(title="ORYZON Recommendation API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",            # local Vite dev
        "http://localhost:5174",            # Vite's fallback when 5173 is taken
        "https://oryzon-pied.vercel.app",   # deployed frontend
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "config": {
            "ideal_yield_source": config.IDEAL_YIELD_SOURCE,
            "weather_years": config.WEATHER_YEARS,       # None = 10 most recent complete years
            "soil_depth_cm": config.SOIL_DEPTH_CM,
            "stage2_gap_days": config.STAGE2_GAP_DAYS,
            "cover_term_dap": config.COVER_TERM_DAP,
            "weather_source": config.WEATHER_SOURCE,
            "soil_om_module": config.SOIL_OM_MODULE,
            "experiments_dir": str(config.EXPERIMENTS_DIR),
            "experiment_presets": sorted(PRESETS),
            # "data_root": str(config.DATA_ROOT),
            # "data_root_exists": config.DATA_ROOT.exists(),
        },
        "runner": {
            "kind": config.RUNNER,
            "dssat_version": RUNNER.dssat_version(),
            "soil_version": RUNNER.soil_version(),
            "cultivar_coefficient_source": RUNNER.cultivar_coefficient_source(),
        },
    }


@app.get("/api/candidates")
def candidates():
    """Return installed rice cultivars (ID/name from RICER048.CUL) and crop candidates.
    Rice cultivar presence in the stock CUL file does not itself imply local calibration."""
    return {
        "rice_varieties": RUNNER.rice_cultivar_options(),
        "yield_crops": RUNNER.calibrated_yield_crops(),
        "source": config.RUNNER,
        "weather_windows": len(ORCHESTRATOR.scenario_windows()),
    }


@app.get("/api/filex")
def filex_experiments():
    """Discover raw DSSAT FileX experiments placed in sim-service/experiments."""
    return {"experiments": discover_filex(config.EXPERIMENTS_DIR)}


@app.post("/api/filex/{filename}/run")
def run_filex(filename: str):
    """Run an original crop-specific FileX without converting it into a rice preset."""
    if not hasattr(RUNNER, "home") or not hasattr(RUNNER, "exe"):
        raise HTTPException(503, "direct FileX execution requires ORYZON_RUNNER=dssat")
    try:
        return execute_filex(RUNNER, config.EXPERIMENTS_DIR, filename)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc))
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    except RuntimeError as exc:
        raise HTTPException(500, str(exc))


@app.get("/api/experiments")
def experiments():
    """Selectable management presets (.RIX files in EXPERIMENTS_DIR), for the picker.
    Pass an `id` as `experiment_id` on POST /api/recommendations."""
    return {"experiments": [describe(p) for p in PRESETS.values()]}


WEATHER = WeatherStore()
SOILS = SoilStore(config.SOIL_FILE)
ORCHESTRATOR = Orchestrator(build_runner(config.RUNNER), WEATHER, SOILS, PRESETS)

_RUNS: dict[str, dict] = {}
_EXEC = ThreadPoolExecutor(max_workers=1)   # DSSAT is heavy: one recommendation at a time


def _execute(run_id: str, req: dict) -> None:
    entry = _RUNS[run_id]
    entry["status"] = "running"
    progress = Progress()
    entry["progress"] = progress.snapshot()
    try:
        result = ORCHESTRATOR.recommend(
            req, run_id=run_id,
            tick=lambda: entry.update(progress=progress.tick() or progress.snapshot()),
            set_total=lambda n: entry.update(progress=progress.set_total(n) or progress.snapshot()))
        entry.update(status="done", result=result.model_dump())
    except Exception as exc:
        entry.update(status="failed", error=f"{type(exc).__name__}: {exc}")


@app.post("/api/recommendations", status_code=202)
def start_recommendation(req: RecommendRequest):
    """Validate, queue the pipeline, return a run id. Poll the GET route for
    progress and the final result (spec §6 progress/error states)."""
    if req.experiment_id is not None and req.experiment_id not in PRESETS:
        raise HTTPException(422, f"unknown experiment_id {req.experiment_id!r}; "
                                 f"available: {sorted(PRESETS)}")
    if req.branch == "rice":
        selected = req.cultivar_ids or []
        if not selected:
            raise HTTPException(422, "select at least one rice cultivar")
        if len(selected) > 10:
            raise HTTPException(422, "select no more than 10 rice cultivars")
        if len(set(selected)) != len(selected):
            raise HTTPException(422, "duplicate rice cultivar IDs are not allowed")
        available = set(RUNNER.calibrated_rice_varieties())
        invalid = sorted(set(selected) - available)
        if invalid:
            raise HTTPException(422, f"unknown rice cultivar IDs: {invalid}")
    if req.branch == "rice" and req.pre_crop is not None:
        raise HTTPException(422, "pre_crop is only valid for the yield_crops branch")
    if req.branch == "yield_crops" and req.pre_crop is not None \
            and req.pre_crop not in RUNNER.calibrated_yield_crops():
        raise HTTPException(422, f"pre_crop {req.pre_crop!r} is not a calibrated yield crop")
    run_id = uuid4().hex[:12]
    _RUNS[run_id] = {"status": "queued", "progress": {"done": 0, "total": None},
                     "result": None, "error": None}
    _EXEC.submit(_execute, run_id, req.model_dump(mode="python"))
    return {"run_id": run_id}


@app.get("/api/recommendations/{run_id}")
def get_recommendation(run_id: str):
    entry = _RUNS.get(run_id)
    if entry is None:
        raise HTTPException(404, f"unknown run {run_id}")
    return entry
