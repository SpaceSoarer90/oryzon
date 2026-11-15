import { useEffect, useState } from "react";
import { Landing } from "./landing";
import { FarmMap } from "./map";
import { PlanNext } from "./recommend";

//   /#plan    -> the plan-next-season (recommendation) screen
// Refreshing on the map keeps you there, and the browser's back button returns to the landing page.
function useHash(): string {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

export default function App() {
  const hash = useHash();

  if (hash === "#plan") return <PlanNext onBack={() => { window.location.hash = "map"; }} />;

  if (hash === "#map") return <FarmMap onBack={() => { window.location.hash = ""; }} />;

  return <Landing onStart={() => { window.location.hash = "map"; }} />;
}