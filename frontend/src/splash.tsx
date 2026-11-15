import { useEffect, useState } from "react";
import "./splash.css";

// Finds each image by its file name (landing_page_background, logo) in src/assets,
// whatever the extension is (.png, .jpg, .webp, .svg...).
const found = import.meta.glob("./assets/{landing_page_background,logo}.*", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

function asset(name: string): string {
  const path = Object.keys(found).find((p) => p.startsWith(`./assets/${name}.`));
  if (!path) console.error(`Missing image: src/assets/${name}.(png|jpg|webp|svg)`);
  return path ? found[path] : "";
}

const background = asset("landing_page_background");
const logo = asset("logo");

const SHOW_MS = 2600; // how long the opening animation plays before it starts to fade
const FADE_MS = 600; // fade-out time (keep in sync with the transition in splash.css)

// Opening animation: the logo rises in over the rice field, then the whole screen fades to the map.
// Tap anywhere to skip it.
export function Splash() {
  const [phase, setPhase] = useState<"show" | "leaving" | "done">("show");

  useEffect(() => {
    if (phase === "show") {
      const t = window.setTimeout(() => setPhase("leaving"), SHOW_MS);
      return () => window.clearTimeout(t);
    }
    if (phase === "leaving") {
      const t = window.setTimeout(() => setPhase("done"), FADE_MS);
      return () => window.clearTimeout(t);
    }
  }, [phase]);

  if (phase === "done") return null;

  return (
    <div
      className={`splash ${phase === "leaving" ? "leaving" : ""}`}
      style={{ "--splash-bg": `url(${background})` } as React.CSSProperties}
      aria-hidden="true"
      onClick={() => setPhase("leaving")}
    >
      <img className="splash-logo" src={logo} alt="" draggable={false} />
    </div>
  );
}