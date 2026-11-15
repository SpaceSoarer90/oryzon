"""Turns a layer's grid for one day into a transparent PNG that Leaflet lays over the map.

Why PNGs: drawing thousands of dots in the browser is what made the map laggy. Here the browser gets ONE
small image per day, and the smoothing/colouring happens once on the server (and is cached).

This module knows nothing about main.py. main.py hands it the layers it has already loaded
(see build_heatmap), so there is only one place where the data is read.
"""
from functools import lru_cache

import numpy as np

from heat_map import GridHeatmap

# Upscaling smooths coarse grids (e.g. 0.5 degree weather data), but a fine grid (e.g. 0.1 degree soil data)
# is already detailed, and at scale 8 it would need an image and weight arrays that don't fit a small server.
SMOOTH_SCALE = 8       # used when the grid has fewer cells than FINE_GRID_CELLS
FINE_GRID_CELLS = 2000
FINE_SCALE = 2
IMAGE_CACHE = 32       # rendered PNGs remembered per layer


class HeatmapLayer:
    """One layer (precipitation, temperature, ...) ready to render any of its days."""

    def __init__(self, name, by_date, locations, meta, *, color, low_color, fade_until=0.0, scale=None, opacity=0.8):
        self.name = name
        self.by_date = by_date              # date -> table with columns lat, lon, <name>
        self.color = color                  # colour of the HIGH end
        self.low_color = low_color          # colour of the LOW end (None = fade by opacity instead)
        self.fade_until = fade_until        # how much of the low end of the range is see-through (see GridHeatmap.render)
        self.opacity = opacity

        step_lat, step_lon = meta["cellSize"]["lat"], meta["cellSize"]["lon"]
        if step_lat is None or step_lon is None:
            raise ValueError("a heat map needs at least 2 rows and 2 columns of grid points")

        # Rebuild the FULL regular grid from the corner and the spacing. Points that were dropped because they
        # never have data (ocean in a land-only dataset) become empty cells instead of leaving holes in the axes.
        self.lat0, self.lon0 = float(locations["lat"].min()), float(locations["lon"].min())
        self.step_lat, self.step_lon = step_lat, step_lon
        n_lat = int(round((float(locations["lat"].max()) - self.lat0) / step_lat)) + 1
        n_lon = int(round((float(locations["lon"].max()) - self.lon0) / step_lon)) + 1
        self.shape = (n_lat, n_lon)
        lats = self.lat0 + step_lat * np.arange(n_lat)
        lons = self.lon0 + step_lon * np.arange(n_lon)

        if scale is None:
            scale = SMOOTH_SCALE if n_lat * n_lon < FINE_GRID_CELLS else FINE_SCALE

        self.renderer = GridHeatmap(lats, lons, scale=scale)   # built once: the expensive part
        self.bounds = self.renderer.bounds                     # [[south, west], [north, east]] for Leaflet

        # One FIXED colour range for the whole year, so a colour means the same thing on every day.
        # Top of the range is the 95th percentile so a few extreme days don't wash everything else out.
        lo, hi = meta["range"]["min"], meta["range"]["p95"]
        self.vmin, self.vmax = (lo, hi) if hi > lo else (lo, meta["range"]["max"])

        # Remember the last few images per layer: scrubbing back and forth costs nothing.
        self.render = lru_cache(maxsize=IMAGE_CACHE)(self._render)

    def _grid_for(self, date) -> np.ndarray:
        frame = self.by_date[date]                                  # KeyError if we don't have that day
        i = np.rint((frame["lat"].to_numpy() - self.lat0) / self.step_lat).astype(int)
        j = np.rint((frame["lon"].to_numpy() - self.lon0) / self.step_lon).astype(int)
        grid = np.full(self.shape, np.nan)                          # NaN = no measurement -> transparent
        grid[i, j] = frame[self.name].to_numpy(dtype=np.float64)
        return grid

    def _render(self, date) -> bytes:
        return self.renderer.render(
            self._grid_for(date),
            color=self.color,
            low_color=self.low_color,
            fade_until=self.fade_until,
            min_value=self.vmin,
            max_value=self.vmax,
            opacity=self.opacity,
        )


def build_heatmap(name: str, layer, cfg: dict) -> HeatmapLayer:
    """The heat map renderer for ONE loaded layer. Raises if the layer can't be drawn (the caller decides what to do)."""
    return HeatmapLayer(
        name, layer.by_date, layer.locations, layer.meta,
        color=cfg.get("color", "#2f7fd1"),
        low_color=cfg.get("low_color"),
        fade_until=cfg.get("fade", 0.35),
    )
