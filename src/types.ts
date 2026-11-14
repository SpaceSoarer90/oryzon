export type LatLng = [number, number];

export interface MonthData {
  month: string;
  ndvi: number;
  soilMoisture: number;
  rainfall: number;
  temperature: number;
}

export type MetricKey = Exclude<keyof MonthData, "month">;

export interface Advice {
  level: "ok" | "warn";
  text: string;
}
