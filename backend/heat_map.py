from io import BytesIO

import numpy as np
from PIL import Image, ImageColor


class GridHeatmap:
    """
    Reusable bilinear rasterizer for a regular geographic grid.

    Initialize once, then call render() for each frame.
    """

    def __init__(
        self,
        lats: np.ndarray,
        lons: np.ndarray,
        scale: int = 8,
    ):
        lats = np.asarray(lats, dtype=np.float64)
        lons = np.asarray(lons, dtype=np.float64)

        if len(lats) < 2 or len(lons) < 2:
            raise ValueError("Grid requires at least 2x2 points")

        if scale < 1:
            raise ValueError("Scale must be positive")

        # Ensure ascending coordinate axes.
        self.flip_lat = lats[0] > lats[-1]
        self.flip_lon = lons[0] > lons[-1]

        self.lats = lats[::-1] if self.flip_lat else lats
        self.lons = lons[::-1] if self.flip_lon else lons

        if not np.all(np.diff(self.lats) > 0):
            raise ValueError("Latitude coordinates must be unique")

        if not np.all(np.diff(self.lons) > 0):
            raise ValueError("Longitude coordinates must be unique")

        self.scale = scale

        self.height = (len(self.lats) - 1) * scale + 1
        self.width = (len(self.lons) - 1) * scale + 1

        # Geographic bounds.
        self.bounds = [
            [float(self.lats[0]), float(self.lons[0])],
            [float(self.lats[-1]), float(self.lons[-1])],
        ]

        # Generate output pixel coordinates in Web Mercator space.
        # Leaflet ImageOverlay stretches images in projected map space,
        # so uniform Mercator Y coordinates avoid vertical distortion.

        north = np.clip(self.lats[-1], -85.05112878, 85.05112878)
        south = np.clip(self.lats[0], -85.05112878, 85.05112878)

        def mercator_y(lat):
            lat = np.radians(lat)
            return np.log(np.tan(np.pi / 4 + lat / 2))

        def inverse_mercator_y(y):
            return np.degrees(2 * np.arctan(np.exp(y)) - np.pi / 2)

        y_coords = np.linspace(
            mercator_y(north),
            mercator_y(south),
            self.height,
        )

        self.sample_lats = inverse_mercator_y(y_coords)
        self.sample_lons = np.linspace(
            self.lons[0],
            self.lons[-1],
            self.width,
        )

        # Find the surrounding grid-cell indices.
        self.i0 = np.searchsorted(
            self.lats, self.sample_lats, side="right"
        ) - 1

        self.j0 = np.searchsorted(
            self.lons, self.sample_lons, side="right"
        ) - 1

        self.i0 = np.clip(self.i0, 0, len(self.lats) - 2)
        self.j0 = np.clip(self.j0, 0, len(self.lons) - 2)

        self.i1 = self.i0 + 1
        self.j1 = self.j0 + 1

        # Precompute normalized interpolation coordinates.
        self.y = (
            (self.sample_lats - self.lats[self.i0])
            / (self.lats[self.i1] - self.lats[self.i0])
        )

        self.x = (
            (self.sample_lons - self.lons[self.j0])
            / (self.lons[self.j1] - self.lons[self.j0])
        )

        # Precompute bilinear weights.
        self.w00 = (1 - self.y[:, None]) * (1 - self.x[None, :])
        self.w10 = (1 - self.y[:, None]) * self.x[None, :]
        self.w01 = self.y[:, None] * (1 - self.x[None, :])
        self.w11 = self.y[:, None] * self.x[None, :]

    def render(
        self,
        values: np.ndarray,
        *,
        color: str = "#ff0000",
        low_color: str | None = None,
        fade_until: float = 0.0,
        min_value: float,
        max_value: float,
        opacity: float = 0.8,
    ) -> bytes:
        """
        Render one frame as a PNG.

        min_value and max_value should remain FIXED across frames
        to ensure consistent opacity throughout the timeline.

        Two looks:
          * low_color=None (default): one colour, and the VALUE controls the opacity
            (low = see-through, high = solid).
          * low_color="#7dbbff": a colour ramp. The VALUE controls the colour, from low_color
            (at min_value) to color (at max_value). Missing pixels stay fully transparent.
            fade_until controls how the opacity behaves:
              0.0  -> every valid pixel has the same opacity (low values are drawn solid).
              0.35 -> the lowest values are fully transparent and fade in until 35% of the range,
                      so "almost nothing" shows the map instead of a pale haze.
              1.0  -> opacity grows across the whole range.
        """

        values = np.asarray(values, dtype=np.float64)

        if values.shape != (
            len(self.lats), len(self.lons)
        ):
            raise ValueError("Values shape doesn't match grid")

        if self.flip_lat:
            values = values[::-1, :]

        if self.flip_lon:
            values = values[:, ::-1]

        if max_value < min_value:
            raise ValueError("Invalid value range")

        if not 0 <= opacity <= 1:
            raise ValueError("Opacity must be between 0 and 1")

        # Get the four corners for every output pixel.
        v00 = values[self.i0[:, None], self.j0[None, :]]
        v10 = values[self.i0[:, None], self.j1[None, :]]
        v01 = values[self.i1[:, None], self.j0[None, :]]
        v11 = values[self.i1[:, None], self.j1[None, :]]

        # Ignore missing measurements and normalize the remaining weights.
        numerator = np.zeros(
            (self.height, self.width), dtype=np.float64
        )
        denominator = np.zeros_like(numerator)

        for v, w in (
            (v00, self.w00),
            (v10, self.w10),
            (v01, self.w01),
            (v11, self.w11),
        ):
            valid = np.isfinite(v)

            numerator += np.where(valid, v * w, 0)
            denominator += np.where(valid, w, 0)

        interpolated = np.full_like(numerator, np.nan)

        np.divide(
            numerator,
            denominator,
            out=interpolated,
            where=denominator > 1e-12,
        )

        # Normalize against a fixed range.
        if max_value == min_value:
            normalized = np.ones_like(interpolated)
        else:
            normalized = (
                (interpolated - min_value)
                / (max_value - min_value)
            )

        normalized = np.clip(normalized, 0, 1)

        rgb = ImageColor.getrgb(color)

        rgba = np.empty(
            (self.height, self.width, 4), dtype=np.uint8
        )

        if low_color is None:
            # Map values to opacity.
            alpha = normalized * opacity * 255
            alpha = np.nan_to_num(alpha, nan=0)

            rgba[..., 0] = rgb[0]
            rgba[..., 1] = rgb[1]
            rgba[..., 2] = rgb[2]
            rgba[..., 3] = alpha.astype(np.uint8)
        else:
            # Colour ramp: blend from low_color to color by value; opacity is constant where there is data.
            low = np.array(ImageColor.getrgb(low_color), dtype=np.float64)
            high = np.array(rgb, dtype=np.float64)
            t = np.nan_to_num(normalized, nan=0.0)
            rgba[..., :3] = (low + (high - low) * t[..., None]).astype(np.uint8)

            # Opacity: 0 at the bottom of the range, rising to full at `fade_until` (or flat if fade_until is 0).
            strength = np.clip(t / fade_until, 0, 1.0) if fade_until > 0 else 1.0
            alpha = np.where(np.isfinite(interpolated), opacity * 255 * strength, 0)
            rgba[..., 3] = alpha.astype(np.uint8)

        # Output is already north-to-south because of the
        # Mercator coordinate construction above.

        image = Image.fromarray(rgba)

        buffer = BytesIO()
        image.save(buffer, format="PNG")

        return buffer.getvalue()
