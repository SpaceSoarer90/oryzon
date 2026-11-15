/* Plan next season: the spec's recommendation flow (AGENT-README.md §3, §6).
   Previous Farm Record -> branch selector -> planting date -> top-3 lists -> Yields.
   Top-3 lists display ascending: rank 3, rank 2, rank 1 (best last), with rank badges.
   "percent of ideal" is relative yield (RY) — the term RY never appears in the UI.
   Absolute yields are never summed (rule 4): the end screen shows separate figures. */
import { useEffect, useRef, useState } from "react";
import { centroid, loadStore, type Farm } from "./map";
import { fetchCandidates, getRecommendation, startRecommendation } from "./api";
import type { Branch, Candidates, CropEntry, RecommendationResult, RangeStat, VarietyEntry } from "./types";

const BRANCHES: { value: Branch; label: string; hint: string }[] = [
  { value: "rice", label: "Rice", hint: "Which rice variety to plant next" },
  { value: "yield_crops", label: "A crop before rice", hint: "Compare crops for the season before rice" },
  { value: "monggo", label: "Monggo cover crop", hint: "Rice after a mung bean cover crop" },
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
function kg(v: number | null | undefined) {
  return v == null ? "—" : `${Math.round(v).toLocaleString("en-US")} kg DM/ha`;
}

type Phase =
  | { kind: "form" }
  | { kind: "running"; runId: string; label: string }
  | { kind: "crops"; result: RecommendationResult }
  | { kind: "varieties"; result: RecommendationResult }
  | { kind: "yields"; result: RecommendationResult };

export function PlanNext({ onBack }: { onBack?: () => void }) {
  const [store] = useState(() => loadStore());
  const [farmId, setFarmId] = useState(store.activeId ?? store.farms[0]?.id ?? "");
  const [branch, setBranch] = useState<Branch>("rice");
  const [establishment, setEstablishment] = useState<"T" | "DS">("DS");
  const [pdate, setPdate] = useState("");
  const [cands, setCands] = useState<Candidates | null>(null);
  const [candsError, setCandsError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [progress, setProgress] = useState<{ done: number; total: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false); // waiting for the service to accept the request
  const poll = useRef<number | null>(null);

  const farm: Farm | null = store.farms.find((f) => f.id === farmId) ?? null;

  useEffect(() => {
    const c = new AbortController();
    fetchCandidates(c.signal)
      .then(setCands)
      .catch((e) => {
        if (!c.signal.aborted) setCandsError(String(e?.message ?? e));
      });
    return () => c.abort();
  }, []);
  useEffect(() => () => { if (poll.current) window.clearInterval(poll.current); }, []);

  function watch(runId: string, after: (r: RecommendationResult) => void) {
    if (poll.current) window.clearInterval(poll.current);
    poll.current = window.setInterval(() => {
      getRecommendation(runId)
        .then((st) => {
          setProgress(st.progress);
          if (st.status === "done" && st.result) {
            if (poll.current) window.clearInterval(poll.current);
            after(st.result);
          } else if (st.status === "failed") {
            if (poll.current) window.clearInterval(poll.current);
            setError(st.error ?? "The recommendation run failed.");
            setPhase({ kind: "form" });
          }
        })
        .catch(() => { /* transient network hiccup: keep polling */ });
    }, 1500);
  }

  function launch(preCrop?: string) {
    if (!farm || !pdate) return;
    setError(null);
    setStarting(true);
    const [lat, lng] = centroid(farm.points);
    startRecommendation({
      farm: { lat, lon: lng, establishment },
      branch,
      planting_date: pdate,
      ...(preCrop ? { pre_crop: preCrop } : {}),
    })
      .then(({ run_id }) => {
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
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setStarting(false));
  }

  const ascending = (list: VarietyEntry[]) => [...list].sort((a, b) => b.rank - a.rank);

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

              <fieldset className="plan-radios">
                <legend>How will the rice be established?</legend>
                <label className="plan-radio">
                  <input type="radio" name="est" checked={establishment === "T"} onChange={() => setEstablishment("T")} />
                  <span><b>Transplanted</b></span>
                </label>
                <label className="plan-radio">
                  <input type="radio" name="est" checked={establishment === "DS"} onChange={() => setEstablishment("DS")} />
                  <span><b>Direct-seeded</b></span>
                </label>
              </fieldset>

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
                  ? `Simulating with ${cands.rice_varieties.length} rice variety(ies), ${cands.yield_crops.length} calibrated crop(s).`
                  : "Checking what is calibrated on the service…"}
                {candsError && <> Could not reach the recommendation service: {candsError}</>}
              </p>

              <button className="plan-run" type="submit" disabled={!farm || !pdate || starting} aria-busy={starting}>
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

      {phase.kind === "running" && (
        <div className="plan-running" role="status">
          <span className="spinner" aria-hidden="true" />
          <p>{phase.label}</p>
          {progress && (
            <p className="plan-progress">
              {progress.done}{progress.total != null ? ` of ${progress.total}` : ""} simulation runs
            </p>
          )}
          <p className="plan-note">Real crop-model runs; this can take a while.</p>
        </div>
      )}

      {phase.kind === "crops" && (
        <div className="plan-step">
          <h2>Top 3 crops to plant before rice</h2>
          <p className="plan-note">Compared as percent of each crop's own ideal yield.</p>
          <ol className="plan-ranks">
            {[...phase.result.crops ?? []].sort((a, b) => b.rank - a.rank).map((c: CropEntry) => (
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
              <button key={c.crop} type="button" className="plan-choice" onClick={() => launch(c.crop)}>
                <span className="plan-badge" aria-label={`Rank ${c.rank}`}>#{c.rank}</span> {c.crop}
              </button>
            ))}
          </div>
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
          <VarietyList varieties={ascending(phase.result.varieties)} />
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