/* Plan next season: the spec's recommendation flow (AGENT-README.md §3, §6).
   Previous Farm Record -> branch selector -> planting date -> top-3 lists -> Yields.
   Top-3 lists display best first: rank 1, rank 2, rank 3, with rank badges.
   "percent of ideal" is relative yield (RY) — the term RY never appears in the UI.
   Absolute yields are never summed (rule 4): the end screen shows separate figures. */
import { useEffect, useRef, useState } from "react";
import { centroid, loadStore, type Farm } from "./map";
import { fetchCandidates, fetchExperiments, getRecommendation, startRecommendation, HttpError } from "./api";
import type { Branch, Candidates, CropEntry, ExperimentPreset, RecommendationResult, RangeStat, VarietyEntry } from "./types";

const BRANCHES: { value: Branch; label: string; hint: string }[] = [
  { value: "rice", label: "Rice", hint: "Which rice variety to plant next" },
  { value: "yield_crops", label: "A crop before rice", hint: "Compare crops for the season before rice" },
];

// Spec §4: the fixed label for the soil net-change block.
const SOIL_NOTE =
  "Model-derived, not field-validated; two-season carbon change is small relative to model uncertainty.";

function pct(v: number) {
  return `${Math.round(v * 100)}%`;
}
function pctOf(r: RangeStat) {
  const base = `${pct(r.mean)} of ideal`;
  if (r.p10 == null || r.p90 == null) return base;
  return `${base} (${pct(r.p10)}–${pct(r.p90)})`;
}
function presetSummary(x: ExperimentPreset) {
  const est = x.establishment === "T" ? "transplanted" : "direct-seeded";
  return `${est} · ${x.irrigation} irrigation · ${x.fertilizer_kg_n_ha} kg N/ha in ${x.fertilizer_events} splits`;
}
function kg(v: number | null | undefined) {
  return v == null ? "—" : `${Math.round(v).toLocaleString("en-US")} kg DM/ha`;
}

// Waits `ms`, or less if `signal` is aborted.
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = window.setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { window.clearTimeout(t); resolve(); }, { once: true });
  });
}
function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const POLL_MS = 2000;           // how often a running simulation is checked (one check at a time, never overlapping)
const MAX_FAILS = 8;            // this many checks in a row without an answer (about 2 minutes) and we stop and say so
const STALL_HINT_MS = 90_000;   // still at 0 runs after this long: explain why

type Phase =
  | { kind: "form" }
  | { kind: "running"; runId: string; label: string }
  | { kind: "crops"; result: RecommendationResult }
  | { kind: "varieties"; result: RecommendationResult }
  | { kind: "yields"; result: RecommendationResult };

export function PlanNext({ onBack, initialBranch }: { onBack?: () => void; initialBranch?: Branch }) {
  const [store] = useState(() => loadStore());
  const [farmId, setFarmId] = useState(store.activeId ?? store.farms[0]?.id ?? "");
  const [branch, setBranch] = useState<Branch>(initialBranch ?? "rice");
  const [establishment, setEstablishment] = useState<"T" | "DS">("DS");
  const [pdate, setPdate] = useState("");
  const [cands, setCands] = useState<Candidates | null>(null);
  const [selectedCultivars, setSelectedCultivars] = useState<string[]>([]);
  const [candsError, setCandsError] = useState<string | null>(null);
  const [presets, setPresets] = useState<ExperimentPreset[]>([]);
  const [experimentId, setExperimentId] = useState(""); // "" = the service's default management
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [progress, setProgress] = useState<{ done: number; total: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false); // waiting for the service to accept the request
  const runCtl = useRef<AbortController | null>(null);   // stops the checking loop of the current run
  const startCtl = useRef<AbortController | null>(null);  // stops the "start the run" request
  const backTo = useRef<Phase>({ kind: "form" });         // where to return if a run fails or is cancelled
  // what the running screen shows: the service's own status ("waiting" = no answer yet), when it began, failed checks
  const [runInfo, setRunInfo] = useState<{ status: "waiting" | "queued" | "running"; startedAt: number; fails: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const farm: Farm | null = store.farms.find((f) => f.id === farmId) ?? null;
  const preset = presets.find((x) => x.id === experimentId) ?? null;
  // A preset fixes how the rice is established (transplanted vs. direct-seeded).
  const effectiveEstablishment = preset ? preset.establishment : establishment;

  useEffect(() => {
    // The service sleeps when idle and can take a minute to wake: keep trying instead of giving up on the first miss.
    const c = new AbortController();
    (async () => {
      for (let attempt = 0; attempt < 8 && !c.signal.aborted; attempt++) {
        try {
          const available = await fetchCandidates(c.signal);
          setCands(available);
          setSelectedCultivars((current) => current.filter((id) => available.rice_varieties.some((v) => v.id === id)));
          setCandsError(null);
          return;
        } catch (e) {
          if (c.signal.aborted) return;
          setCandsError(String((e as Error)?.message ?? e));
          await sleep(5000, c.signal);
        }
      }
    })();
    return () => c.abort();
  }, []);
  useEffect(() => {
    // Presets are optional: if the list can't be loaded the picker is simply not shown.
    const c = new AbortController();
    fetchExperiments(c.signal)
      .then((r) => setPresets(r.experiments))
      .catch(() => { /* no picker */ });
    return () => c.abort();
  }, []);
  useEffect(() => () => { runCtl.current?.abort(); startCtl.current?.abort(); }, []);

  // A clock for the "elapsed" time, only while a run is on screen.
  useEffect(() => {
    if (phase.kind !== "running") return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [phase.kind]);

  function stopWatching() {
    runCtl.current?.abort();
    runCtl.current = null;
  }

  // Stop, go back to the screen the farmer came from, and say what happened.
  function failRun(message: string) {
    stopWatching();
    setError(message);
    setProgress(null);
    setRunInfo(null);
    setPhase(backTo.current);
  }

  function cancelRun() {
    stopWatching();
    setError(null);
    setProgress(null);
    setRunInfo(null);
    setPhase(backTo.current);
  }

  // Checks the run one request at a time (the old version fired a new request every 1.5 s even when the last had not
  // come back, which piled requests onto a slow free server). Transient misses are tolerated; a lost run or a long
  // silence is reported instead of spinning forever.
  function watch(runId: string, after: (r: RecommendationResult) => void) {
    stopWatching();
    const ctl = new AbortController();
    runCtl.current = ctl;
    const startedAt = Date.now();
    setRunInfo({ status: "waiting", startedAt, fails: 0 });
    (async () => {
      let fails = 0;
      while (!ctl.signal.aborted) {
        try {
          const st = await getRecommendation(runId, ctl.signal);
          if (ctl.signal.aborted) return;
          fails = 0;
          setProgress(st.progress);
          if (st.status === "done") {
            if (st.result) {
              stopWatching();
              setRunInfo(null);
              after(st.result);
            } else {
              failRun("The simulation finished but returned no result. Please try again.");
            }
            return;
          }
          if (st.status === "failed") {
            failRun(st.error ?? "The recommendation run failed.");
            return;
          }
          setRunInfo({ status: st.status === "queued" ? "queued" : "running", startedAt, fails: 0 });
        } catch (e) {
          if (ctl.signal.aborted) return;
          if (e instanceof HttpError && e.status === 404) {
            // The service no longer knows this run: it restarted (free servers do) and runs are kept in memory.
            failRun("The simulation service restarted and lost this run. Please start it again.");
            return;
          }
          fails += 1;
          setRunInfo((prev) => (prev ? { ...prev, fails } : prev));
          if (fails >= MAX_FAILS) {
            failRun("Lost contact with the simulation service. Wait a minute for it to wake up, then try again.");
            return;
          }
        }
        await sleep(POLL_MS, ctl.signal);
      }
    })();
  }

  function launch(preCrop?: string) {
    if (!farm || !pdate || starting || (branch === "rice" && selectedCultivars.length === 0)) return;
    setError(null);
    setStarting(true);
    // If this run fails or is cancelled, return to where the farmer is now (the crop choice, or the form).
    backTo.current = phase.kind === "crops" ? phase : { kind: "form" };
    startCtl.current?.abort();
    const ctl = new AbortController();
    startCtl.current = ctl;
    const [lat, lng] = centroid(farm.points);
    startRecommendation({
      farm: { lat, lon: lng, establishment: effectiveEstablishment },
      branch,
      planting_date: pdate,
      ...(preCrop ? { pre_crop: preCrop } : {}),
      ...(experimentId ? { experiment_id: experimentId } : {}),
      ...(branch === "rice" ? { cultivar_ids: selectedCultivars } : {}),
    }, ctl.signal)
      .then(({ run_id }) => {
        if (ctl.signal.aborted) return;
        setProgress(null);
        setPhase({
          kind: "running",
          runId: run_id,
          label: preCrop ? `After ${preCrop}: comparing rice varieties…` : "Simulating the season under past weather…",
        });
        watch(run_id, (r) => {
          // Yield Crops stage 1 presents crops; stage 2 presents varieties.
          if (r.branch === "yield_crops" && r.crops && r.varieties.length === 0) {
            setPhase({ kind: "crops", result: r });
          } else {
            setPhase({ kind: "varieties", result: r });
          }
        });
      })
      .catch((e) => {
        if (!ctl.signal.aborted) setError(String(e?.message ?? e));
      })
      .finally(() => setStarting(false));
  }

  // The service wants the crop's id exactly as listed in /api/candidates (for example "corn", not "Corn").
  // Match the name from the results to that list, ignoring upper/lower case; fall back to the name as given.
  const preCropId = (name: string) =>
    cands?.yield_crops.find((id) => id.trim().toLowerCase() === name.trim().toLowerCase()) ?? name;

  const byRank = (list: VarietyEntry[]) => [...list].sort((a, b) => a.rank - b.rank);

  return (
    <>
      {phase.kind === "form" && (
        <form
          className="plan-form plan"
          onSubmit={(e) => { e.preventDefault(); launch(); }}
        >
          <header className="plan-top">
            <button type="button" className="plan-back" onClick={onBack}>
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M15 5l-7 7 7 7" />
              </svg>
              Dashboard
            </button>
            <p className="plan-intro">
              Choose what you want to plant and when. We simulate the season under past weather to compare your options.
            </p>
          </header>
          {store.farms.length === 0 ? (
            <p className="plan-note">Set up a farm on the map first — the plan uses your farm's answers.</p>
          ) : (
            <>
                  <label className="plan-field">
                <span>Farm</span>
                <select value={farmId} onChange={(e) => setFarmId(e.target.value)}>
                  {store.farms.map((f) => (
                    <option key={f.id} value={f.id}>{f.name.trim() || "Unnamed farm"}</option>
                  ))}
                </select>
              </label>

              <fieldset className="plan-radios">
                <legend>What to plant next?</legend>
                {BRANCHES.map((b) => (
                  <label key={b.value} className="plan-radio">
                    <input
                      type="radio"
                      name="branch"
                      value={b.value}
                      checked={branch === b.value}
                      onChange={() => setBranch(b.value)}
                    />
                    <span>
                      <b>{b.label}</b>
                      <small>{b.hint}</small>
                    </span>
                  </label>
                ))}
              </fieldset>

              {branch === "rice" && (
                <fieldset className="plan-radios">
                  <legend>How will the rice be established?</legend>
                  <label className="plan-radio">
                    <input type="radio" name="est" disabled={!!preset} checked={effectiveEstablishment === "T"} onChange={() => setEstablishment("T")} />
                    <span><b>Transplanted</b></span>
                  </label>
                  <label className="plan-radio">
                    <input type="radio" name="est" disabled={!!preset} checked={effectiveEstablishment === "DS"} onChange={() => setEstablishment("DS")} />
                    <span><b>Direct-seeded</b></span>
                  </label>
                </fieldset>
              )}

              {presets.length > 0 && (
                <label className="plan-field">
                  <span>Farming practice</span>
                  <select value={experimentId} onChange={(e) => setExperimentId(e.target.value)}>
                    <option value="">Standard practice (default)</option>
                    {presets.map((x) => (
                      <option key={x.id} value={x.id}>{x.title || x.id}</option>
                    ))}
                  </select>
                  {preset && (
                    <small className="plan-raw">
                      {presetSummary(preset)}. Dates are moved onto your planting date; weather and soil are your farm's.
                    </small>
                  )}
                </label>
              )}

              {branch === "rice" && (
                <fieldset className="plan-radios">
                  <legend>Which rice cultivars should be simulated?</legend>
                  <p className="plan-note">
                    Choose 1–10 cultivars from the installed RICER048.CUL file.
                    {cands ? ` ${cands.rice_varieties.length} available.` : ""}
                  </p>
                  <div className="plan-cultivar-actions">
                    <button type="button" className="plan-run secondary"
                      onClick={() => setSelectedCultivars(cands?.rice_varieties.slice(0, 10).map((v) => v.id) ?? [])}
                      disabled={!cands || cands.rice_varieties.length === 0}>
                      Select first 10
                    </button>
                    <button type="button" className="plan-run secondary"
                      onClick={() => setSelectedCultivars([])}
                      disabled={selectedCultivars.length === 0}>
                      Clear
                    </button>
                    <b>{selectedCultivars.length}/10 selected</b>
                  </div>
                  {cands?.rice_varieties.map((v) => {
                    const checked = selectedCultivars.includes(v.id);
                    return (
                      <label key={v.id} className="plan-radio">
                        <input type="checkbox" checked={checked}
                          disabled={!checked && selectedCultivars.length >= 10}
                          onChange={(e) => setSelectedCultivars((current) =>
                            e.target.checked ? [...current, v.id] : current.filter((id) => id !== v.id)
                          )} />
                        <span><b>{v.id}</b><small>{v.name}</small></span>
                      </label>
                    );
                  })}
                  {cands && selectedCultivars.length > 0 && (
                    <p className="plan-note">
                      Estimated runs: {selectedCultivars.length * cands.weather_windows * 2}
                      {" "}({selectedCultivars.length} cultivars × {cands.weather_windows} weather windows × actual/ideal).
                    </p>
                  )}
                </fieldset>
              )}

              <label className="plan-field">
                <span>Planting date</span>
                <input
                  type="date"
                  required
                  value={pdate}
                  onChange={(e) => setPdate(e.target.value)}
                />
              </label>

              <p className="plan-note">
                {cands
                  ? `Available rice cultivars: ${cands.rice_varieties.length}; ${cands.yield_crops.length} calibrated crop(s).`
                  : "Checking what is calibrated on the service…"}
                {candsError && !cands && <> Could not reach the recommendation service yet ({candsError}). It may be waking up, so we keep trying.</>}
              </p>

              <button className="plan-run" type="submit"
            disabled={!farm || !pdate || starting || (branch === "rice" && (selectedCultivars.length === 0 || selectedCultivars.length > 10))}
            aria-busy={starting}>
                {starting ? (
                  <>
                    <span className="spinner" aria-hidden="true" />
                    Starting…
                  </>
                ) : (
                  "Get recommendation"
                )}
              </button>
            </>
          )}
          {error && <p className="plan-error" role="alert">{error}</p>}
          {store.farms.length === 0 && onBack && (
            <button type="button" className="plan-run" onClick={onBack}>Back to the map</button>
          )}
        </form>
      )}

      {phase.kind === "running" && (() => {
        const elapsed = runInfo ? now - runInfo.startedAt : 0;
        const done = progress?.done ?? 0;
        const stalled = elapsed > STALL_HINT_MS && done === 0;
        const headline =
          !runInfo || runInfo.status === "waiting"
            ? "Contacting the simulation service…"
            : runInfo.status === "queued"
              ? "Waiting for the simulation to start…"
              : phase.label;
        return (
          <div className="plan-running" role="status">
            <span className="spinner" aria-hidden="true" />
            <p>{headline}</p>
            {progress && progress.total != null && progress.total > 0 ? (
              <>
                <progress className="plan-bar" max={progress.total} value={done} aria-label="Simulation progress" />
                <p className="plan-progress">{done} of {progress.total} simulation runs</p>
              </>
            ) : (
              <p className="plan-progress">{done} simulation runs finished</p>
            )}
            <p className="plan-raw">Time so far: {clock(elapsed)}</p>
            {runInfo && runInfo.fails > 0 && (
              <p className="plan-note">Having trouble reaching the service (try {runInfo.fails} of {MAX_FAILS}). Still trying…</p>
            )}
            {stalled && (!runInfo || runInfo.fails === 0) && (
              <p className="plan-note">
                Still working. The service may be waking up or finishing an earlier run, and the first crop-model runs are the slowest. You can keep this open.
              </p>
            )}
            <p className="plan-note">Real crop-model runs; this can take a few minutes.</p>
            <button type="button" className="plan-run secondary" onClick={cancelRun}>Cancel</button>
          </div>
        );
      })()}

      {phase.kind === "crops" && (
        <div className="plan-step">
          <h2>Top 3 crops to plant before rice</h2>
          <p className="plan-note">Compared as percent of each crop's own ideal yield.</p>
          <ol className="plan-ranks">
            {[...phase.result.crops ?? []].sort((a, b) => a.rank - b.rank).map((c: CropEntry) => (
              <li key={c.crop} className="plan-entry">
                <span className="plan-badge" aria-label={`Rank ${c.rank}`}>#{c.rank}</span>
                <div>
                  <b>{c.crop}</b>
                  <div>{pctOf(c.relative_yield)}</div>
                  <div className="plan-raw">mean yield {kg(c.actual_yield.mean)}</div>
                </div>
              </li>
            ))}
          </ol>
          <h3 className="plan-ask">Which crop will you plant?</h3>
          <div className="plan-choices">
            {(phase.result.crops ?? []).map((c) => (
              <button key={c.crop} type="button" className="plan-choice" disabled={starting} aria-busy={starting} onClick={() => launch(preCropId(c.crop))}>
                <span className="plan-badge" aria-label={`Rank ${c.rank}`}>#{c.rank}</span> {c.crop}
              </button>
            ))}
          </div>
          {starting && (
            <p className="plan-note" role="status">
              <span className="spinner" aria-hidden="true" />
              Starting the simulation…
            </p>
          )}
          {error && <p className="plan-error" role="alert">{error}</p>}
          <ResultMetaFooter result={phase.result} />
          <button type="button" className="plan-run secondary" onClick={() => setPhase({ kind: "form" })}>
            Start over
          </button>
        </div>
      )}

      {phase.kind === "varieties" && (
        <div className="plan-step">
          <h2>Top 3 rice varieties</h2>
          {phase.result.varieties[0]?.pre_crop && (
            <p className="plan-precrop">
              {phase.result.varieties[0].pre_crop.type === "cover" ? "Cover crop" : "Pre-crop"}{" "}
              <b>{phase.result.varieties[0].pre_crop.id}</b> produced{" "}
              <b>{kg(phase.result.varieties[0].pre_crop.actual_yield_mean)}</b>
              {phase.result.varieties[0].pre_crop.type === "cover" ? " of aboveground biomass" : ""}
            </p>
          )}
          <VarietyList varieties={byRank(phase.result.varieties)} />
          <ResultNotes result={phase.result} />
          <button type="button" className="plan-run" onClick={() => setPhase({ kind: "yields", result: phase.result })}>
            See yields
          </button>
          <button type="button" className="plan-run secondary" onClick={() => setPhase({ kind: "form" })}>
            Start over
          </button>
        </div>
      )}

      {phase.kind === "yields" && (
        <div className="plan-step">
          <h2>Yields</h2>
          <p className="plan-note">Separate figures — they are never added together.</p>
          {phase.result.varieties[0]?.pre_crop && (
            <div className="plan-yieldbox">
              <h3>
                {phase.result.varieties[0].pre_crop.type === "cover" ? "Cover crop" : "Pre-crop"}:{" "}
                {phase.result.varieties[0].pre_crop.id}
              </h3>
              <p>{kg(phase.result.varieties[0].pre_crop.actual_yield_mean)}
                {phase.result.varieties[0].pre_crop.type === "cover" ? " aboveground biomass" : ""}</p>
            </div>
          )}
          {phase.result.varieties.map((v) => (
            <div className="plan-yieldbox" key={v.variety}>
              <h3>Rice: {v.variety} <span className="plan-badge" aria-label={`Rank ${v.rank}`}>#{v.rank}</span></h3>
              <p>{kg(v.rice_actual.mean)} — {pctOf(v.relative_yield)}</p>
              <p className="plan-raw">compared with an ideal yield of {kg(v.rice_ideal.mean)}</p>
              <SoilBlock d={v.soil_delta} />
            </div>
          ))}
          <ResultMetaFooter result={phase.result} />
          <ResultNotes result={phase.result} />
          <button type="button" className="plan-run secondary" onClick={onBack}>Back to the map</button>
        </div>
      )}
    </>
  );
}

function VarietyList({ varieties }: { varieties: VarietyEntry[] }) {
  return (
    <ol className="plan-ranks">
      {varieties.map((v) => (
        <li key={v.variety} className="plan-entry">
          <span className="plan-badge" aria-label={`Rank ${v.rank}`}>#{v.rank}</span>
          <div>
            <b>{v.variety}</b>
            <div>{pctOf(v.relative_yield)}</div>
            <div className="plan-raw">mean rice yield {kg(v.rice_actual.mean)}</div>
            <SoilBlock d={v.soil_delta} />
          </div>
        </li>
      ))}
    </ol>
  );
}

function SoilBlock({ d }: { d: { d_soc_kg_ha: number; d_son_kg_ha: number; mineral_n_end_kg_ha: number } }) {
  return (
    <details className="plan-soil">
      <summary>Soil net change over the run</summary>
      <div>
        Soil organic carbon: {d.d_soc_kg_ha > 0 ? "+" : ""}{Math.round(d.d_soc_kg_ha)} kg C/ha
        {" · "}soil organic N: {d.d_son_kg_ha > 0 ? "+" : ""}{Math.round(d.d_son_kg_ha)} kg N/ha
        {" · "}mineral N at end: {Math.round(d.mineral_n_end_kg_ha)} kg N/ha
      </div>
      <small>{SOIL_NOTE}</small>
    </details>
  );
}

function ResultNotes({ result }: { result: RecommendationResult }) {
  if (result.notes.length === 0 && result.failed_runs.length === 0) return null;
  return (
    <div className="plan-notes">
      {result.notes.map((n, i) => <p key={i}>{n}</p>)}
      {result.failed_runs.length > 0 && (
        <details>
          <summary>{result.failed_runs.length} simulation run(s) failed and were excluded</summary>
          <ul>
            {result.failed_runs.map((f, i) => (
              <li key={i}>{f.sequence} · {f.run_type} · scenario {f.scenario}: {f.error}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function ResultMetaFooter({ result }: { result: RecommendationResult }) {
  const m = result.metadata;
  return (
    <details className="plan-meta">
      <summary>About these numbers</summary>
      <ul>
        <li>Weather scenarios: {result.scenarios.join(", ")}</li>
        <li>Weather source: {m.weather_source}</li>
        <li>DSSAT version: {m.dssat_version}</li>
        <li>Soil organic matter module: {m.soil_om_module}</li>
        <li>Cultivar coefficients: {m.cultivar_coefficient_source}</li>
        <li>Ideal yield source: {m.ideal_yield_source}</li>
      </ul>
      <small>
        ORYZON supports, and does not replace, farmer and agronomist judgment. Confirm with your
        local agriculture office or irrigators' association before deciding.
      </small>
    </details>
  );
}