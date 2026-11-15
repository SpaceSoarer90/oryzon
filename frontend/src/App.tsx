import { FarmMap } from "./map";
import { Splash } from "./splash";

// The map is the whole app. The splash is an opening animation that plays over it when the site loads,
// then fades away and removes itself.
export default function App() {
  return (
    <>
      <FarmMap />
      <Splash />
    </>
  );
}