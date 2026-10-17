"""Shared Letterboxd chart styling: watch-year colors + dark theme.

Uses matplotlib turbo for viewing years. Dark theme: black figure/axes,
light text/ticks/grid, DejaVu Sans (bundled with matplotlib / common on
Ubuntu Actions).
"""

from __future__ import annotations

# Dark chart surface
BG = "#000000"
FG = "#F2F2F2"
MUTED = "#B0B0B0"
GRID = "#2A2A2A"
SPINE = "#666666"
LEGEND_BG = "#0A0A0A"
LEGEND_EDGE = "#3A3A3A"


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


def apply_dark_chart_theme() -> None:
    """Apply black-background rcParams once for all Letterboxd PNGs."""
    import matplotlib as mpl
    import matplotlib.pyplot as plt
    from matplotlib import font_manager

    # Prefer DejaVu Sans (ships with matplotlib; also fonts-dejavu on Ubuntu).
    available = {f.name for f in font_manager.fontManager.ttflist}
    family = "DejaVu Sans" if "DejaVu Sans" in available else "sans-serif"

    plt.rcParams.update(
        {
            "figure.facecolor": BG,
            "figure.edgecolor": BG,
            "axes.facecolor": BG,
            "axes.edgecolor": SPINE,
            "axes.labelcolor": FG,
            "axes.titlecolor": FG,
            "text.color": FG,
            "xtick.color": MUTED,
            "ytick.color": MUTED,
            "grid.color": GRID,
            "grid.linewidth": 0.8,
            "legend.facecolor": LEGEND_BG,
            "legend.edgecolor": LEGEND_EDGE,
            "legend.labelcolor": FG,
            "savefig.facecolor": BG,
            "savefig.edgecolor": BG,
            "font.family": family,
            "font.size": 9,
            "axes.titlesize": 12,
            "axes.labelsize": 10,
            "figure.dpi": 150,
            "savefig.dpi": 180,
        }
    )
    # Older matplotlib may not honor legend.labelcolor via rc alone.
    mpl.rcParams["axes.prop_cycle"] = mpl.cycler(
        color=["#4C78A8", "#F58518", "#54A24B", "#E45756", "#72B7B2", "#B279A2"]
    )


def style_axes(ax) -> None:
    """Ensure one axes matches the dark theme (after custom spine tweaks)."""
    ax.set_facecolor(BG)
    ax.tick_params(colors=MUTED)
    ax.xaxis.label.set_color(FG)
    ax.yaxis.label.set_color(FG)
    if ax.title.get_text():
        ax.title.set_color(FG)
    for spine in ax.spines.values():
        spine.set_color(SPINE)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)


def style_figure(fig) -> None:
    fig.patch.set_facecolor(BG)
    for ax in fig.axes:
        style_axes(ax)


def save_dark_figure(fig, path, **kwargs) -> None:
    """savefig with black facecolor so tight bbox stays dark."""
    opts = {"bbox_inches": "tight", "facecolor": BG, "edgecolor": BG}
    opts.update(kwargs)
    fig.savefig(path, **opts)
