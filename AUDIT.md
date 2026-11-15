# ORYZON audit — traceability and discrepancies

Date: 2026-11-15. Scope: repo `repository/` (frontend, backend, dssat). Source of truth: `AGENT-README.md` (the spec).
Method: every node of spec §3 plus every named pipeline piece (§4–§7) mapped to implementing code, or `missing`.
No code changed for this report (spec working rule 1, deliverable 1).

## 1. Decisions recorded this session (project owner, acting as architect)

The spec's §10 OPEN list is architect-owned. The owner decided the items that gate the frontend/backend
layers in chat on 2026-11-15. Pending spec-owner sign-off, these are treated as resolved:

| # | OPEN item (spec §10) | Decision |
|---|---|---|
| O1 | Season-2 planting date derivation | Maturity-driven: `pdate2(s) = simulated pre-crop maturity date(s) + STAGE2_GAP_DAYS` (config, proposed 7). Per-scenario. If a scenario's pre-crop never reaches maturity, the scenario is excluded and reported (same rule as failed runs, spec §5). |
| O2 | Cover-crop termination timing | Fixed days after planting: `COVER_TERM_DAP` (config, proposed 45). All aboveground residue incorporated at termination (spec default). |
| O3 | Rice establishment method | UI input in the Previous Farm Record: transplanted vs direct-seeded. Backend maps to DSSAT `PLME` (`T`/`S`) and matching `PLDS`. Flooded/puddled lowland fixed in config. |
| O4 | Observed weather source | Owner's lane (simulator side). Backend uses NASA POWER/IMERG processed store until owner supplies observed data; config hook `WEATHER_SOURCE` reserved. |
| O5 | Weather record span across season boundaries | Wrap forward: scenario year Y covers season 1 in Y, season 2 continues into Y+1 (records concatenated). If Y+1 is not on disk, the scenario window shifts back one year so every scenario is one continuous record. On-disk archive: 2016–2025. |
| O6 | Designated cultivar per yield crop | Owner's lane (calibration). Backend enumerates calibrated crops/varieties from the simulator at runtime (spec §5); never hardcodes. |
| O7 | Table values if `IDEAL_YIELD_SOURCE="table"` | Not needed: owner chose `simulated_potential` (spec default). Config must still validate the "table" path at startup per spec §4. |

Architecture decisions (same session):

| Decision | Choice |
|---|---|
| Backend topology | Separate recommendation service beside the simulator code; existing weather API (`backend/`, deployed on Render) stays as-is. |
| Frontend flow | Keep the existing map wizard as the Previous Farm Record input; append the spec flow after it (branch selector → planting date → top-3 lists → Yields end screen). Existing dashboard untouched. |
| Branch order | All three branches scaffolded now; uncalibrated branches return an empty result with a "no calibrated crops" message until calibration lands. |
| Simulator boundary | Owner delivers the DSSAT environment + one run entry point (experiment in → parsed season yields + soil state out). Recommendation service owns IC assembly, weather ensemble, sequencing, cache, RY, ranking, API, UI. |

## 2. Traceability table (spec §3 nodes → code)

| # | Spec node | Implementing code | Status | Owner |
|---|---|---|---|---|
| 1 | Farm Initialization → Previous Farm Record (UI) | `frontend/src/map.tsx` — `SetupForm` (1504–2053), `FarmDetails`/`Plot`/`CropRecord`/`SoilInfo` (79–280), `FarmStore` persistence (274–309) | Partial: collects location, last crop, harvest yield, irrigation source/schedule, soil. Missing: establishment method field (O3). Field name `totalYield` violates spec rule 4 (see D1). | frontend |
| 2 | Farm Record + NASA data → Initial Conditions | missing | Missing | rec-service |
| 3 | "What to plant next?" branch selector (Rice/Yield Crops/Monggo) | missing | Missing | frontend |
| 4 | Rice branch: simulate each variety (actual + ideal, D4) | missing. Legacy `dssat/actual-sim/` simulated one variety, one run, no ideal runs — non-conforming; owner is removing it | Missing | rec-service + owner runner |
| 5 | Yield Crops: stage-1 crop ranking, "Which Crop?" (UI), stage-2 sequence runs | missing | Missing | rec-service + owner runner |
| 6 | Monggo: cover-crop run + sequence runs | missing | Missing | rec-service + owner runner |
| 7 | Present Top 3 Varieties / Top 3 Crops (rank 3→2→1, rank badges, §6) | missing | Missing | frontend |
| 8 | End node "Output Total Yield" → implemented as "Yields" (D3) | missing | Missing | frontend |
| P1 | Backend pipeline §7: IC → weather → DSSAT inputs → actual+ideal runs → parse → cache → RY → rank → return | missing | Missing | rec-service |
| P2 | Result schema §7 (crop entry, variety entry) | missing | Missing | rec-service |
| P3 | Cache (§5 key: farm, pdate, sequence, variety, run type, scenario, DSSAT version, soil/IC version) | missing | Missing | rec-service |
| P4 | Weather ensemble (§4): WEATHER_YEARS scenarios, continuous records, P10/P90 | missing. `backend/main.py` serves POWER/FLDAS layers for the map only | Missing | rec-service (reads owner's processed store) |
| P5 | Metric extraction (§4): HWAM/CWAM mapping verified against installed DSSAT | missing (legacy `sim_outputs.py` parsed Summary.OUT/PlantGro.OUT; being removed) | Missing | rec-service parser, mapping verified with owner |
| P6 | Startup validation: IDEAL_YIELD_SOURCE single-valued; "table" coverage fails startup; calibrated crops/varieties enumerated and reported | missing | Missing | rec-service |
| P7 | Metadata (rule 6): DSSAT version, weather source, soil OM module, cultivar coefficient source, IDEAL_YIELD_SOURCE | missing | Missing | rec-service |
| P8 | Async run model + progress/error states (§6) | missing | Missing | rec-service + frontend |

## 3. Discrepancy list (existing code vs spec)

| # | Where | Discrepancy | Rule | Proposed resolution |
|---|---|---|---|---|
| D1 | `frontend/src/map.tsx` lines 84, 95, 128–129, 258–260, 1192, 1228, 1290, 1660 | Field `totalYield` and UI label "Total yield" | rule 4: no variable/field/label may use "total yield" | Rename field to `lastHarvestYield`, label to "Last harvest yield". Data is an input (single crop), not a computed sum — renaming satisfies the acceptance search. Needs owner sign-off (R5 conflict list). |
| D2 | `frontend/src/api.ts` line 4 | API base URL hardcoded to `https://oryzon-wyyo.onrender.com`; `VITE_API_URL` line commented out | R5 / deployment | Re-enable `VITE_API_URL` for the weather API and add a second base URL for the recommendation service. |
| D3 | `frontend/src/fakeData.ts` | Dead file — nothing imports it | hygiene | Delete (owner sign-off). |
| D4 | `backend/old.main.py`, `backend/nasa-farm-api.zip`, `backend/make_fake_rasters.py` | Obsolete artifacts from earlier iterations | hygiene | Owner decides: delete or archive. |
| D5 | `dssat/actual-sim/*` | Non-conforming pipeline (single variety, no ideal runs, no RY, no ensemble, no carry-over, no cache) | spec §4–§5 | Owner is removing it. Recorded here for the traceability trail. |
| D6 | `dssat/actual-sim/paths.py` | Data paths point outside the repo (`../datasets/`); nothing in git pins those inputs | audit finding | Owner owns the data route (fetcher/converters). Rec-service consumes the processed store via config, not hardcoded sibling paths. |
| D7 | Flowchart image vs spec | End node labelled "Output Total Yield"; red double-headed arrows read as IC updates | D2, D3 | Spec wins; new code uses "Yields", IC applies to first season only. No legacy code affected. |
| D8 | Pitch README (outside repo, `../datasets/AGENT-README.md`) | Describes a different product vision (strategy cards A/B/C, NDVI dashboard, confidence labels, rotation scoring) | spec supremacy clause | Not part of this spec's scope; existing dashboard UI stays under R5. No rotation scoring will be built (also out of scope there and in spec §11). |

Rule 3 check: no profit/price/cost terms found in `frontend/src` or `backend` — compliant.

## 4. Target architecture (proposal, pending owner OK on layout)

```
repository/
  backend/            existing weather API — unchanged (deployed, Render)
  frontend/           wizard stays; new recommendation screens appended
  sim-service/        NEW: recommendation/orchestration FastAPI (local; near the data)
    main.py           endpoints (below)
    config.py         WEATHER_YEARS, IDEAL_YIELD_SOURCE, SOIL_DEPTH_CM, STAGE2_GAP_DAYS,
                      COVER_TERM_DAP, ESTABLISHMENT mapping, service port
    orchestrator.py   IC assembly, scenario builder (O5 wrap), sequence builder (stage 2),
                      run dispatch, RY + ranking, cache, result assembly (§7)
    metrics.py        HWAM/CWAM mapping (P5), soil net change (ΔSOC/ΔSON/mineral N), P10/P90
    store.py          processed weather/soil readers (owner's converter output)
    runner/           THIN ADAPTER to the owner's entry point (interface below);
                      a stub implementation ships so the pipeline is testable before calibration lands
  dssat/              DSSAT workspace: intermediate-input-files / intermediate-output-files /
                      output-files-for-frontend (owner's runner writes here; rec-service only reads)
```

Endpoints (all on the sim service; frontend talks to both services):

| Route | Purpose |
|---|---|
| `GET /api/candidates` | Calibrated crops + rice varieties, enumerated from the runner (spec §5, P6); drives "no calibrated crops" states |
| `POST /api/recommendations` | Body: farm record snapshot (farm polygon/centroid, establishment, last harvest), branch, planting date. Validates, starts the pipeline, returns `{run_id}` immediately |
| `GET /api/recommendations/{run_id}` | Status (`queued/running/done/failed`), progress (runs completed/total), final result JSON (§7 schema), `failed_runs` |
| `GET /health` | Liveness + config echo (rule 6 metadata sources) |

Async model is required: the Rice branch alone is up to `varieties × scenarios × 2` DSSAT runs.

Result schema follows §7 verbatim: crop entry
`{rank, crop, actual_yield{mean,p10,p90}, ideal_yield{mean}, relative_yield{mean,p10,p90}}`;
variety entry `{rank, variety, pre_crop{type,id,actual_yield_mean}|null, rice_actual{mean,p10,p90},
rice_ideal{mean}, relative_yield{mean,p10,p90}, soil_delta{dSOC,dSON,minN_end}, metadata, failed_runs}`.

## 5. Runner interface contract (draft for owner review — the boundary)

```python
# owner implements; rec-service consumes
def calibrated_rice_varieties() -> list[str]: ...
def calibrated_yield_crops() -> list[str]: ...        # empty until calibration lands

def run_experiment(spec: ExperimentSpec) -> RunResult: ...

# ExperimentSpec (draft)
#   seasons: [{kind: "rice"|"yield_crop"|"cover", crop_or_variety: str,
#              planting_date: date, establishment: "T"|"DS",
#              termination?: {dap: int, residue: "incorporate"} }]   # cover only
#   potential: bool            # ideal run: water + N stress off (verify switch names in installed DSSAT)
#   weather: WeatherRef        # continuous daily record for one scenario (path or handle)
#   soil: SoilRef              # profile id + file from owner's store
#   initial_conditions: ICData # assembled by orchestrator; first season of actual runs only (D1)
#   work_dir: Path             # isolated per run (spec §5)
#
# RunResult (draft)
#   per season: yield_kg_ha (actual), maturity_date, biomass_at_termination (cover only)
#   soil state at end: SOC_kg_ha, SON_kg_ha, mineral_N_kg_ha   (at SOIL_DEPTH_CM)
#   status: "ok" | "failed", error: str | None                # failed runs excluded + reported, never zero-imputed
```

Cache keys (spec §5) include DSSAT version + soil/IC version — the owner's environment must expose
both (e.g. `dssat_version()`, `soil_version()`). Weather file identity enters via the scenario reference.

## 6. Implementation plan (small, reviewable commits; spec deliverable 2)

1. **Contracts & scaffold** — sim-service skeleton, config with recorded decisions, §7 schema types
   (Python + TS), runner interface + stub, `/health`, `/api/candidates`. No DSSAT calls.
2. **Scenario engine** — weather ensemble builder (O5 wrap/shift), stage-2 date rule (O1),
   termination (O2), sequence assembly, cache keyed per spec §5.
3. **Rice branch end-to-end** — actual+ideal runs through the adapter, parsing (P5), RY, ranking,
   async API. Determinism test (same inputs → same ranking, spec §9).
4. **Yield + Monggo branches** — same machinery behind the branch flag; empty-candidate states until
   owner's calibration lands. Carry-over test (§9) once sequence runs work.
5. **Frontend flow** — branch selector, planting date, progress/polling, top-3 lists (rank 3→2→1,
   "percent of ideal" + raw kg DM/ha beside), Yields end screen (D3), D1 rename, D2 env URLs.
6. **Acceptance pass** — run every §9 test, repo-wide searches of the ban list, deliverables 3–4.

## 7. Assumptions and unresolved items (deliverable 4, living list)

- A1. Pre-crop runs harvest at physiological maturity (`HARVS=M` analog); required by O1's date rule.
- A2. Stage-2 gap default 7 days and cover DAP default 45 are proposals — config constants, owner can change without code.
- A3. Owner's processed weather store format is TBD; `store.py` is written against whatever the converters emit (co-design point in phase 2).
- A4. Switch names for "water + N stress off" must be verified in the installed DSSAT build before ideal runs are trusted (spec §4/§5).
- A5. `sim-service/` folder name/location needs owner OK (proposal in §4).
- A6. Renames/deletions in D1/D3/D4 need owner sign-off per R5 before touching existing UI conventions.
- U1. DSSAT version + soil/IC version identifiers for cache keys — pending owner's runner.
- U2. Whether the wizard's plot-level records (multiple plots) feed stage runs, or one farm-level record per recommendation — spec §2 says "Previous Farm Record" (farm-level); treated as farm-level (centroid) until the owner says otherwise.

## 8. Implementation status (same day, phases 1–6)

Built in `sim-service/` (stub runner; real DSSAT runner is the owner's interface, §5) and
`frontend/src/recommend.tsx`. Verification: every branch ran end-to-end over HTTP and in a real
browser; `npm run build` + `npx tsc --noEmit` pass (remaining tsc warnings are pre-existing).

| Spec item | Status |
|---|---|
| Node 1 Previous Farm Record (UI) | Wizard kept as the record source; plan screen picks a saved farm; D1 rename applied (`lastHarvestYield`, "Last harvest yield"); D2 env URLs applied |
| Node 2 IC | Built per scenario from the nearest PH.SOL profile + config defaults (field capacity, IC_NH4/NO3); O3 establishment selector on the plan screen |
| Node 3 branch selector | Plan screen radios: Rice / Yield Crops / Monggo |
| Node 4 Rice branch | Actual+ideal per variety per scenario; RY ceiling = max ideal; ranked, browser-verified |
| Node 5 Yield branch | Stage 1 top-3 crops + "Which crop?" picker; stage 2 sequence runs with the §5 equality assertion; empty-candidate states |
| Node 6 Monggo branch | Cover sequence (O2 fixed DAP) → rice varieties; biomass identity checked per scenario |
| Node 7 top-3 + Yields | Rank 3→2→1 with badges; "percent of ideal" (mean, P10–P90); raw kg DM/ha beside; Yields end screen, never summed |
| §4 metrics | RY paired per scenario; P10/P90 (null when one scenario); soil ΔSOC/ΔSON/mineral N at SOIL_DEPTH_CM |
| §5 rules | Cache per spec key; isolated work dirs under `dssat/intermediate-input-files/<run_id>/`; failed runs excluded + reported |
| §7 schema | `schema.py` + `types.ts` mirror §7 exactly; async POST/GET with progress |
| Rule 6 metadata | On every entry + `/health` echo |
| §9 acceptance | Determinism ✓; failed-run exclusion ✓ (observed live); ban-list searches clean ✓; carry-over test **pending the real runner** (A8); RY>1 flag path in place (stub cannot trigger it) |

New/updated assumptions:

- A7. The establishment (O3) selector currently lives on the plan screen (a per-season management
  choice), not inside the wizard's farm form. Moving it into the wizard is a small follow-up if the
  owner wants it recorded on the farm.
- A8. The §9 carry-over test (season-2 soil state equals season-1 end) needs the real runner; the
  contract already carries `soil_start`/`soil_end` and sequence runs are single runs from IC (D1).
- A9. The run registry is in-memory: recommendation results survive only within the service process
  (acceptable for the demo; persistence is a follow-up if needed).
- A10. A2 confirmed as config: `STAGE2_GAP_DAYS=7`, `COVER_TERM_DAP=45`; O5 wrap implemented as
  2-year windows with shift-back dedupe (verified: 10 start years → 9 unique windows, 2016–2024).
- U2 note: recommendation uses the farm centroid (farm-level record), consistent with spec §2.
- A11. The farm record feeds IC only via location (→ weather + nearest soil profile) and
  establishment. The wizard's `lastCrop` does NOT yet influence IC — `IC_PCR="RI"` is fixed in
  config. If the previous crop should condition the initial soil (e.g. legume N credit at IC),
  that is a contract/config decision for the owner (spec §2 ties IC to the farm record but does
  not name the fields).
- A12. Weather/soil lookups now reject farms farther than 1° from any data point (silence-to-
  garbage guard, matching the weather API's MAX_NEAREST_DEG behaviour).
- A13. An "ok" run that reports no yield for the ranked season is excluded and reported like a
  failed run (was: unguarded `None` that could crash the whole recommendation).
