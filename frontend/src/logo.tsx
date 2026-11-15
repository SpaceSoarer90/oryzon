import { useState } from "react";

// One place that finds the logo, so the splash and the side menu always agree.
// Looks for src/assets/logo.(png|jpg|jpeg|webp|svg). File names are case-sensitive in a production build,
// so Logo.png and LOGO.png are matched too.
const logoFiles = import.meta.glob(["./assets/logo.*", "./assets/Logo.*", "./assets/LOGO.*"], {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

export const logoUrl = Object.values(logoFiles)[0] ?? "";
if (!logoUrl) console.error("Missing image: src/assets/logo.(png|jpg|jpeg|webp|svg)");

interface LogoProps {
  className?: string;         // applied to the <img>
  fallbackClassName?: string; // applied (with className) to the text shown when there is no usable image
}

// Shows the logo image; if the file is missing or fails to load, shows the name instead of a broken image.
export function Logo({ className = "", fallbackClassName = "" }: LogoProps) {
  const [broken, setBroken] = useState(false);

  if (!logoUrl || broken) {
    return <div className={`${className} ${fallbackClassName}`.trim()}>ORYZON</div>;
  }
  return (
    <img
      className={className}
      src={logoUrl}
      alt="Oryzon"
      draggable={false}
      onError={() => setBroken(true)}
    />
  );
}