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


def categorical_positions(n: int) -> list[float]:
    """Midpoint of each equal bin on a normalized colormap.

    N categories never sample the endpoints: N=1 → 0.5, N=2 → 0.25 and 0.75.
    """
    count = int(n)
    if count <= 0:
        return []
    return [(i + 0.5) / count for i in range(count)]


def categorical_colors(n: int, cmap=None) -> list[tuple]:
    """Turbo colors for N discrete ordered categories (years, ranked genres).

    Continuous rating colors do not use this — they map the numeric rating.
    """
    import matplotlib.pyplot as plt

    gradient = plt.cm.turbo if cmap is None else cmap
    return [tuple(float(c) for c in gradient(t)) for t in categorical_positions(n)]


def watch_year_palette(all_watch_years) -> dict[int, tuple]:
    """Map each watch year to a turbo color, one bin midpoint per year."""
    years = sorted({int(y) for y in (all_watch_years or []) if y is not None})
    if not years:
        return {}
    colors = categorical_colors(len(years))
    return {year: colors[i] for i, year in enumerate(years)}


def color_for_year(palette: dict[int, tuple], year: int, fallback=(0.3, 0.47, 0.66, 1.0)):
    return palette.get(int(year), fallback)


# Fixed Letterboxd rating scale for colormap norm (half-stars … 5).
# Avoid data-relative norms that squash 3.6–4.5 into a peach mid-band.
RATING_VMIN = 0.5
RATING_VMAX = 5.0
RATING_COLORBAR_LABEL = "оценка"

# Explicit blue (low) → green (mid) → red (high). No coolwarm/RdBu peach.
_RATING_BGR_STOPS = (
    (0.15, 0.35, 0.85, 1.0),  # blue — low
    (0.12, 0.62, 0.42, 1.0),  # teal-green
    (0.20, 0.75, 0.25, 1.0),  # green — mid
    (0.85, 0.75, 0.12, 1.0),  # yellow-green transition (kept vivid, not cream)
    (0.90, 0.35, 0.12, 1.0),  # orange-red
    (0.85, 0.12, 0.12, 1.0),  # red — high
)


def rating_colormap():
    """ListedColormap: cold blue → mid green → warm red."""
    from matplotlib.colors import LinearSegmentedColormap

    return LinearSegmentedColormap.from_list(
        "letterboxd_rating_bgr",
        list(_RATING_BGR_STOPS),
        N=256,
    )


def rating_norm(vmin: float = RATING_VMIN, vmax: float = RATING_VMAX):
    import matplotlib.pyplot as plt

    return plt.Normalize(vmin=float(vmin), vmax=float(vmax))


def rating_color(
    avg: float,
    vmin: float = RATING_VMIN,
    vmax: float = RATING_VMAX,
) -> tuple:
    """Map mean Letterboxd rating to blue→green→red on a fixed 0.5–5 scale.

    Used for «выше оценка» charts — not the watch-year turbo palette.
    """
    try:
        value = float(avg)
    except (TypeError, ValueError):
        value = vmin
    span = max(1e-6, float(vmax) - float(vmin))
    t = (value - float(vmin)) / span
    if t < 0:
        t = 0.0
    elif t > 1:
        t = 1.0
    return rating_colormap()(t)


def rating_colors(
    avgs,
    vmin: float | None = None,
    vmax: float | None = None,
) -> list[tuple]:
    """Colors for a list of averages on the fixed Letterboxd rating scale."""
    lo = float(vmin) if vmin is not None else RATING_VMIN
    hi = float(vmax) if vmax is not None else RATING_VMAX
    if hi <= lo:
        hi = lo + 0.01
    out = []
    for a in avgs or []:
        out.append(rating_color(a, vmin=lo, vmax=hi))
    return out


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


# sendPhoto rejects width+height above 10000 px. Leave a margin for the tight bbox.
_TG_PHOTO_PX_BUDGET = 9600


def save_dark_figure(fig, path, **kwargs) -> None:
    """savefig with black facecolor so tight bbox stays dark.

    A long top is a tall figure at the caller's point size. If that raster
    would exceed Telegram's photo dimension budget, dpi drops and the layout
    in inches stays the same.
    """
    opts = {"bbox_inches": "tight", "facecolor": BG, "edgecolor": BG}
    opts.update(kwargs)
    w_in, h_in = fig.get_size_inches()
    dpi = float(opts.get("dpi") or getattr(fig, "dpi", None) or 100)
    if w_in > 0 and h_in > 0 and (w_in + h_in) * dpi > _TG_PHOTO_PX_BUDGET:
        opts["dpi"] = _TG_PHOTO_PX_BUDGET / (w_in + h_in)
    fig.savefig(path, **opts)
