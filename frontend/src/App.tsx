// import { FarmMap } from "./map";
// import { Splash } from "./splash";

// // The map is the whole app. The splash is an opening animation that plays over it when the site loads,
// // then fades away and removes itself.
// export default function App() {
//   return (
//     <>
//       <FarmMap />
//       <Splash />
//     </>
//   );
// }
import { useEffect, useState } from "react";
// import { Landing } from "./landing";
import { FarmMap } from "./map";
import { PlanNext } from "./recommend";
import { Splash } from "./splash";

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

  // if (hash === "#plan") return <PlanNext onBack={() => { window.location.hash = "map"; }} />;

  // if (hash === "#map") return <FarmMap onBack={() => { window.location.hash = ""; }} />;

  return (
    <>
      <FarmMap />
      <Splash />
    </>
  );

  // return <Landing onStart={() => { window.location.hash = "map"; }} />;
}
