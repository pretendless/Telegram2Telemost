"""Shared watch-year color scale for non-genre Letterboxd charts.

Uses matplotlib turbo, keyed by sorted unique viewing years so weekday/month,
decade, country, rewatch, and related charts stay visually consistent.
"""

from __future__ import annotations


def watch_year_palette(all_watch_years) -> dict[int, tuple]:
    """Map each watch year to a turbo color on the full diary year span."""
    years = sorted({int(y) for y in (all_watch_years or []) if y is not None})
    if not years:
        return {}
    # Import lazily so callers without a display still work under Agg.
    import matplotlib.pyplot as plt

    cmap = plt.cm.turbo
    if len(years) == 1:
        return {years[0]: cmap(0.55)}
    last = len(years) - 1
    return {y: cmap(i / last) for i, y in enumerate(years)}


def color_for_year(palette: dict[int, tuple], year: int, fallback=(0.3, 0.47, 0.66, 1.0)):
    return palette.get(int(year), fallback)
