export type LatLng = [number, number];

export interface MonthData {
  month: string | null;
  ndvi: number | null;
  soilMoisture: number | null;
  rainfall: number | null;
  temperature: number | null;
}

export type MetricKey = Exclude<keyof MonthData, "month">;

export interface Advice {
  level: "ok" | "warn";
  text: string;
}
