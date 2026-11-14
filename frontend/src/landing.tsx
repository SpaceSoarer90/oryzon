import "./landing.css";

// Finds each image by its file name (get_started, landing_page_background, logo) in src/assets,
// whatever the extension is (.png, .jpg, .webp, .svg...).
const found = import.meta.glob("./assets/{get_started,landing_page_background,logo}.*", {
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
const getStarted = asset("get_started");

export function Landing({ onStart }: { onStart: () => void }) {
  return (
    <main className="landing" style={{ backgroundImage: `url(${background})` }}>
      <div className="landing-content">
        <img className="landing-logo" src={logo} alt="Oryzon" draggable={false} />
        <button className="landing-start" onClick={onStart} aria-label="Get started">
          <img src={getStarted} alt="" draggable={false} />
        </button>
      </div>
    </main>
  );
}