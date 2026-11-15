import { Component, type ReactNode } from "react";
import { FarmMap } from "./map";
import { Splash } from "./splash";

// Last line of defence: if anything in the app throws while rendering, show what happened instead of a blank
// screen. The same message is in the browser console (F12).
class AppBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error("[ORYZON] the app crashed:", error, info.componentStack);
  }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div style={{ position: "fixed", inset: 0, zIndex: 99999, overflow: "auto", padding: 24, background: "#ecf3dc", color: "#2b1a0c", fontFamily: "system-ui, sans-serif" }}>
        <h2 style={{ margin: "0 0 8px" }}>Something went wrong</h2>
        <p style={{ margin: "0 0 12px" }}>Your farms are saved. Reload to continue.</p>
        <button
          onClick={() => window.location.reload()}
          style={{ height: 44, padding: "0 22px", border: 0, borderRadius: 22, background: "#2e9e5b", color: "#fff", font: "inherit", fontWeight: 700, cursor: "pointer" }}
        >
          Reload
        </button>
        <pre style={{ marginTop: 16, whiteSpace: "pre-wrap", fontSize: 13 }}>{String(error.stack || error.message)}</pre>
      </div>
    );
  }
}

// The map is the whole app. The guided tour is rendered inside FarmMap (it spotlights the real controls),
// and the splash is an opening animation that plays over everything, then fades away and removes itself.
export default function App() {
  return (
    <>
      <AppBoundary>
        <FarmMap />
      </AppBoundary>
      <Splash />
    </>
  );
}