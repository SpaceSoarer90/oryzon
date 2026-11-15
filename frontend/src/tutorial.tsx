import { Component, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Logo } from "./logo";
import { apiHealthUrl, simHealthUrl } from "./api";
import "./tutorial.css";

// Guided tour. Instead of separate slides, it dims the real app and spotlights the real control, one at a time,
// so the farmer learns where each part lives. It is rendered INSIDE FarmMap (see map.tsx), which gives it a
// `ctl` to put the screen in the right state for each step (open the menu, expand the bottom sheet, ...).
//
// Each step points at an element marked  data-tour="name"  in map.tsx.
// Replay any time:  window.dispatchEvent(new Event("oryzon:show-tutorial"))   or open  /#tutorial
// (the menu also has a "Take the tour" item).

export const TOUR_REPLAY_EVENT = "oryzon:show-tutorial";
// New key on purpose: the old slide tutorial saved "oryzon:tutorial-seen", which would hide this tour from
// everyone who already saw (or skipped) the old one.
const SEEN_KEY = "oryzon:tour-seen";

// What the real screen should look like for a step. FarmMap implements these in tourScene().
export type TourScene =
  | "intro"
  | "search"
  | "menu-btn"
  | "menu"
  | "layers"
  | "timeline"
  | "readings"
  | "reading"
  | "sheet"
  | "dashboard"
  | "past"
  | "plan"
  | "crops"
  | "farms"
  | "edit"
  | "done";

export interface TourControl {
  scene: (scene: TourScene) => void; // put the app in the state this step needs
  end: () => void; // the tour is over: remove the sample farm and restore the screen
}

function wasSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}
function markSeen() {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* storage blocked: the tour simply shows again next visit */
  }
}

// ---------------------------------------------------------------------------------------------
// Service warm-up: free Render instances sleep, and the first request can take a minute.
// Ping /health until it answers so the map and Plan screens are quick by the time the farmer arrives.
// ---------------------------------------------------------------------------------------------
type Ping = "wait" | "ok" | "slow";

function usePing(url: string): Ping {
  const [state, setState] = useState<Ping>("wait");
  useEffect(() => {
    let stop = false;
    const started = Date.now();
    (async () => {
      while (!stop && Date.now() - started < 300_000) {
        const ctl = new AbortController();
        const timer = window.setTimeout(() => ctl.abort(), 10_000);
        try {
          const res = await fetch(url, { signal: ctl.signal, cache: "no-store" });
          if (res.ok) {
            window.clearTimeout(timer);
            if (!stop) setState("ok");
            return;
          }
        } catch {
          /* still waking up: try again */
        }
        window.clearTimeout(timer);
        if (!stop && Date.now() - started > 60_000) setState("slow");
        await new Promise((r) => window.setTimeout(r, 3000));
      }
    })();
    return () => {
      stop = true;
    };
  }, [url]);
  return state;
}

// ---------------------------------------------------------------------------------------------
// The steps. `target` is the data-tour name of the real element to spotlight (none = centred card).
// ---------------------------------------------------------------------------------------------
interface Step {
  scene: TourScene;
  target?: string;
  title: string;
  body: string;
  missing?: string; // shown if the target never appears (for example, data still loading)
}

const STEPS: Step[] = [
  {
    scene: "intro",
    title: "Welcome to ORYZON",
    body: "This quick tour points out where everything is on the screen. If you haven’t added a farm yet, we’ll show a sample one. It disappears when the tour ends.",
  },
  {
    scene: "search",
    target: "search",
    title: "Search and location",
    body: "Type a place name here to fly the map there. When a farm is open, this bar shows where it is.",
  },
  {
    scene: "menu-btn",
    target: "menu-btn",
    title: "The menu",
    body: "Tap the three lines to open the menu.",
  },
  {
    scene: "menu",
    target: "menu-items",
    title: "Dashboard, My Farms, Add new map",
    body: "Dashboard takes you back to your readings. My Farms lists every farm you saved. Add new map is how you outline a field: tap its corners on the map, then tap the orange first point. Take the tour plays this guide again.",
  },
  {
    scene: "layers",
    target: "layers",
    title: "Weather & Soil Maps",
    body: "Open this panel and tap a picture to paint temperature, soil moisture or rainfall over the map. Tap it again to turn it off.",
  },
  {
    scene: "timeline",
    target: "timeline",
    title: "Day and colour scale",
    body: "While a map layer is on, this card shows which day you are looking at and what the colours mean. “Past data” lets you look at earlier days.",
    missing: "This card appears once the map data has loaded.",
  },
  {
    scene: "readings",
    target: "readings",
    title: "Your farm’s readings",
    body: "Temperature, soil moisture and rainfall for your farm sit on the map. The mark on each says Good, Watch or Alert. Tap one to see more.",
  },
  {
    scene: "reading",
    target: "reading",
    title: "Details for one reading",
    body: "You get the number, what it means in plain words, and a chart of recent days. Use the tabs to switch between readings.",
  },
  {
    scene: "sheet",
    target: "sheet-head",
    title: "The bottom panel",
    body: "Your dashboard lives in this panel. Tap or drag the handle to make it bigger or smaller, so you can see more of the map or more of the details.",
  },
  {
    scene: "dashboard",
    target: "dash-metrics",
    title: "Dashboard",
    body: "The same three readings, each marked Good, Watch or Alert, with a short explanation just below.",
  },
  {
    scene: "past",
    target: "past",
    title: "View past data",
    body: "Tap here to open a day slider and see how conditions looked on earlier days. Tap “Back to latest data” to return.",
    missing: "This button appears once the farm’s data has loaded.",
  },
  {
    scene: "plan",
    target: "plan",
    title: "Plan next season",
    body: "Choose what you might plant next. ORYZON runs crop simulations for your farm and ranks the top three options. The first run can take a minute.",
  },
  {
    scene: "crops",
    target: "crops",
    title: "Crops for future seasons",
    body: "Open the crop guide to see what you could plant next.",
  },
  {
    scene: "farms",
    target: "farms",
    title: "My Farms",
    body: "Every farm you saved appears here. Tap one to switch to it, or tap “Add a new farm” to outline another field.",
  },
  {
    scene: "edit",
    target: "edit",
    title: "Edit farm details",
    body: "Update your plots, past crops and soil answers any time.",
  },
  {
    scene: "done",
    title: "You’re all set",
    body: "To see this tour again, open the menu and tap “Take the tour”.",
  },
];

// ---------------------------------------------------------------------------------------------
// Finding and following the real element
// ---------------------------------------------------------------------------------------------
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

// The first matching element that is actually on screen (the closed menu, for example, does not count).
function findTarget(name: string): HTMLElement | null {
  const list = document.querySelectorAll<HTMLElement>(`[data-tour="${name}"]`);
  for (const el of Array.from(list)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden") return el;
  }
  return null;
}

// Targets inside the bottom sheet may be scrolled out of view: scroll the sheet (and only the sheet).
function reveal(el: HTMLElement) {
  const body = el.closest<HTMLElement>(".sheet-body");
  if (!body) return;
  const b = body.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const m = 10;
  if (r.height > b.height - 2 * m || r.top < b.top + m) body.scrollTop += r.top - (b.top + m);
  else if (r.bottom > b.bottom - m) body.scrollTop += r.bottom - (b.bottom - m);
}

const PAD = 6; // breathing room around the spotlight
const GAP = 12; // space between the spotlight and the card

function placeCard(box: Box | null, card: { w: number; h: number }, vp: { w: number; h: number }) {
  const edge = 12;
  if (!box) return { left: (vp.w - card.w) / 2, top: Math.max(edge, (vp.h - card.h) / 2) };
  const roomAbove = box.y - PAD - GAP - edge;
  const roomBelow = vp.h - (box.y + box.h + PAD) - GAP - edge;
  const preferAbove = box.y + box.h / 2 > vp.h * 0.55;
  let top: number;
  if (preferAbove && roomAbove >= card.h) top = box.y - PAD - GAP - card.h;
  else if (roomBelow >= card.h) top = box.y + box.h + PAD + GAP;
  else if (roomAbove >= card.h) top = box.y - PAD - GAP - card.h;
  else top = roomBelow >= roomAbove ? vp.h - card.h - edge : edge; // does not fit: use the roomier side
  const left = Math.min(Math.max(edge, box.x + box.w / 2 - card.w / 2), vp.w - card.w - edge);
  return { left, top: Math.min(Math.max(edge, top), Math.max(edge, vp.h - card.h - edge)) };
}

function StatusDot({ s, label }: { s: Ping; label: string }) {
  const word = s === "ok" ? "ready" : s === "slow" ? "slow to respond" : "starting";
  return (
    <span className={`tour-dot ${s}`}>
      <i aria-hidden="true" />
      {label}
      <span className="tour-sr">: {word}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// The running tour
// ---------------------------------------------------------------------------------------------
function TourRun({ api, sim, ctl, onClose }: { api: Ping; sim: Ping; ctl: TourControl; onClose: () => void }) {
  const [i, setI] = useState(0);
  const step = STEPS[i];
  const last = i === STEPS.length - 1;

  const [box, setBox] = useState<Box | null>(null);
  const [waited, setWaited] = useState(false);
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [cardSize, setCardSize] = useState({ w: 340, h: 240 });
  const cardRef = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  // Put the real screen in the state this step needs.
  useEffect(() => {
    ctl.scene(step.scene);
    setWaited(false);
    const t = window.setTimeout(() => setWaited(true), 2500);
    heading.current?.focus({ preventScroll: true });
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i]);

  // Follow the target every frame: it moves while the sheet, the menu and the layers panel animate.
  useEffect(() => {
    let raf = 0;
    const started = performance.now();
    const tick = () => {
      const el = step.target ? findTarget(step.target) : null;
      if (el) {
        if (performance.now() - started < 1500) reveal(el);
        const r = el.getBoundingClientRect();
        setBox((prev) =>
          prev && Math.abs(prev.x - r.left) < 0.5 && Math.abs(prev.y - r.top) < 0.5 && Math.abs(prev.w - r.width) < 0.5 && Math.abs(prev.h - r.height) < 0.5
            ? prev
            : { x: r.left, y: r.top, w: r.width, h: r.height },
        );
      } else {
        setBox((prev) => (prev ? null : prev));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [step.target, i]);

  useEffect(() => {
    const onResize = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") setI((n) => Math.min(STEPS.length - 1, n + 1));
      else if (e.key === "ArrowLeft") setI((n) => Math.max(0, n - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Measure the card so it can be kept on screen and away from the spotlight.
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    setCardSize((p) => (p.w === w && p.h === h ? p : { w, h }));
  });

  const cardW = Math.min(340, vp.w - 24);
  const pos = placeCard(box, { w: cardW, h: cardSize.h }, vp);
  const ready = api === "ok" && sim === "ok";
  const slow = api === "slow" || sim === "slow";
  const showMissing = !!step.target && !box && waited;

  return (
    <div className="tour" role="presentation">
      {box ? (
        <div
          className="tour-hole"
          style={{ left: box.x - PAD, top: box.y - PAD, width: box.w + PAD * 2, height: box.h + PAD * 2 }}
          aria-hidden="true"
        />
      ) : (
        <div className="tour-scrim" aria-hidden="true" />
      )}

      <div
        ref={cardRef}
        className="tour-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        style={{ left: pos.left, top: pos.top, width: cardW }}
      >
        {step.scene === "intro" && <Logo className="tour-logo" fallbackClassName="tour-logo-text" />}
        <div className="tour-meta">
          <span>
            {i + 1} of {STEPS.length}
          </span>
          <button type="button" className="tour-skip" onClick={onClose}>
            Skip tour
          </button>
        </div>
        <div
          className="tour-progress"
          role="progressbar"
          aria-label="Tour progress"
          aria-valuemin={1}
          aria-valuemax={STEPS.length}
          aria-valuenow={i + 1}
        >
          <span style={{ width: `${((i + 1) / STEPS.length) * 100}%` }} />
        </div>

        <h2 id="tour-title" className="tour-title" tabIndex={-1} ref={heading}>
          {step.title}
        </h2>
        <p className="tour-body">{step.body}</p>
        {showMissing && <p className="tour-note">{step.missing ?? "This part isn’t on screen right now."}</p>}

        <div className="tour-status" role="status">
          <StatusDot s={api} label="Weather and soil" />
          <StatusDot s={sim} label="Crop simulations" />
          {slow && !ready && <span className="tour-slow">Slow to wake up. It keeps trying.</span>}
        </div>

        <div className="tour-nav">
          {i > 0 ? (
            <button type="button" className="tour-btn" onClick={() => setI(i - 1)}>
              Back
            </button>
          ) : (
            <span />
          )}
          <button type="button" className="tour-btn tour-btn-primary" onClick={() => (last ? onClose() : setI(i + 1))}>
            {last ? "Finish" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}

// If anything inside the tour throws, close the tour and put the screen back instead of taking the app down.
class TourBoundary extends Component<{ onCrash: (e: Error) => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    console.error("[ORYZON tour] crashed and was closed:", error);
    this.props.onCrash(error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function Tutorial({ ctl }: { ctl: TourControl }) {
  // Warm both services on every visit, even when the tour itself is skipped.
  const api = usePing(apiHealthUrl);
  const sim = usePing(simHealthUrl);
  const [open, setOpen] = useState(() => !wasSeen() || window.location.hash === "#tutorial");
  const [run, setRun] = useState(0); // a new value restarts the tour from step 1

  useEffect(() => {
    const show = () => {
      setRun((n) => n + 1);
      setOpen(true);
    };
    window.addEventListener(TOUR_REPLAY_EVENT, show);
    return () => window.removeEventListener(TOUR_REPLAY_EVENT, show);
  }, []);

  if (!open) return null;
  const close = () => {
    markSeen();
    setOpen(false);
    ctl.end();
    if (window.location.hash === "#tutorial") history.replaceState(null, "", window.location.pathname + window.location.search);
  };
  return (
    <TourBoundary key={run} onCrash={close}>
      <TourRun api={api} sim={sim} ctl={ctl} onClose={close} />
    </TourBoundary>
  );
}