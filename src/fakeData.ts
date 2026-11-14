// Placeholder data so the UI works before the real ML/NASA pipeline exists.
// Replace getRegionData() with a call to your Python API (e.g. fetch("/api/region?...")).
import type { Advice, MonthData } from "./types";

export const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"] as const;

function seeded(seed: number): () => number {
  let s = Math.abs(Math.floor(seed * 1e4)) % 2147483647 || 1;
  return () => (s = (s * 48271) % 2147483647) / 2147483647;
}

export function getRegionData(lat: number, lng: number): MonthData[] {
  const rand = seeded(lat * 31 + lng * 17);
  const wave = (i: number, phase: number) => 0.5 + 0.5 * Math.sin(((i + phase) / 12) * Math.PI * 2);
  const phase = rand() * 12;
  return MONTHS.map((month, i) => ({
    month,
    ndvi: +(0.25 + 0.55 * wave(i, phase) + rand() * 0.05).toFixed(2),
    soilMoisture: +(0.15 + 0.25 * wave(i, phase + 3) + rand() * 0.03).toFixed(2),
    rainfall: Math.round(20 + 220 * wave(i, phase + 5) + rand() * 15),
    temperature: +(18 + 12 * wave(i, phase + 2) + rand() * 1.5).toFixed(1),
  }));
}

export function getAdvice(d: MonthData): Advice {
  if (d.soilMoisture < 0.22) return { level: "warn", text: "Soil is dry. Consider irrigating." };
  if (d.ndvi < 0.4) return { level: "warn", text: "Low vegetation health. Check for stress or pests." };
  return { level: "ok", text: "Conditions look healthy." };
}
