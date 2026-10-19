"""Shared Letterboxd top charts: watch-year stacked counts + rating bars.

Count tops → horizontal bars stacked/colored by viewing-year turbo palette
(same spirit as watches_by_country.png).

Rating tops («выше оценка») → horizontal bars where length = mean rating,
colored cool→warm (higher = warmer).
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

from letterboxd_palette import (
    FG,
    GRID,
    RATING_COLORBAR_LABEL,
    rating_color,
    rating_colormap,
    rating_colors,
    rating_norm,
    save_dark_figure,
    style_axes,
    watch_year_palette,
)

# Default size for ranking charts (count + avg-rating tops).
TOP_N_DEFAULT = 20

LANG_LABELS = {
    "en": "английский",
    "ru": "русский",
    "fr": "французский",
    "de": "немецкий",
    "it": "итальянский",
    "es": "испанский",
    "ja": "японский",
    "ko": "корейский",
    "zh": "китайский",
    "sv": "шведский",
    "pl": "польский",
    "pt": "португальский",
    "hi": "хинди",
    "tr": "турецкий",
    "uk": "украинский",
    "da": "датский",
    "no": "норвежский",
    "nl": "нидерландский",
    "cs": "чешский",
    "hu": "венгерский",
}


def display_lang(code) -> str:
    key = str(code or "").strip().lower()
    return LANG_LABELS.get(key) or key or "?"


def _short_label(text: str, limit: int = 36) -> str:
    s = str(text or "?").strip() or "?"
    if len(s) > limit:
        return s[: limit - 1] + "…"
    return s


def _fit_text_to_data_width(
    ax,
    renderer,
    text: str,
    *,
    x0: float,
    x1: float,
    y: float,
    fontsize: float,
    fontweight: str = "bold",
    path_effects=None,
) -> str:
    """Truncate ``text`` with … so its rendered width fits in data x ∈ [x0, x1].

    When ``path_effects`` (stroke) is used on the final label, pass the same
    effects here so the measured bbox includes the outline.
    """
    max_px = abs(
        ax.transData.transform((x1, y))[0] - ax.transData.transform((x0, y))[0]
    )
    if max_px < 10:
        # Tiny bar — keep rank digits only when possible.
        head = text.split(".", 1)[0].strip()
        return head or "…"

    def width_px(candidate: str) -> float:
        artist = ax.text(
            0,
            0,
            candidate,
            fontsize=fontsize,
            fontweight=fontweight,
            alpha=0,
            path_effects=path_effects,
        )
        try:
            return float(artist.get_window_extent(renderer=renderer).width)
        finally:
            artist.remove()

    if width_px(text) <= max_px:
        return text
    # Binary search longest prefix that fits with ellipsis.
    lo, hi = 0, len(text)
    best = "…"
    while lo <= hi:
        mid = (lo + hi) // 2
        if mid <= 0:
            candidate = "…"
        else:
            candidate = text[:mid].rstrip() + "…"
        if width_px(candidate) <= max_px:
            best = candidate
            lo = mid + 1
        else:
            hi = mid - 1
    return best


def add_watch_year_legend(fig, years: list[int], colors: dict, title: str = "Год просмотра"):
    handles = [plt.Rectangle((0, 0), 1, 1, color=colors[y]) for y in years]
    leg = fig.legend(
        handles,
        [str(y) for y in years],
        title=title,
        loc="center left",
        bbox_to_anchor=(0.92, 0.5),
        frameon=False,
        fontsize=8,
        title_fontsize=9,
        labelcolor=FG,
    )
    if leg is not None and leg.get_title() is not None:
        leg.get_title().set_color(FG)


def chart_stacked_count_hbar(
    labels: list[str],
    years: list[int],
    matrix: np.ndarray,
    palette: dict[int, tuple],
    path: Path,
    *,
    title: str,
    xlabel: str = "Просмотры",
    footer: str | None = None,
) -> bool:
    """matrix shape (len(years), len(labels)); labels ordered bottom→top."""
    if not labels or not years or matrix.size == 0:
        return False
    fig, ax = plt.subplots(figsize=(10, max(4.0, len(labels) * 0.42)))
    y = np.arange(len(labels))
    left = np.zeros(len(labels))
    for yi, year in enumerate(years):
        vals = matrix[yi]
        ax.barh(y, vals, left=left, color=palette[year], height=0.72, edgecolor="none")
        left += vals
    ax.set_yticks(y)
    ax.set_yticklabels(labels)
    ax.set_xlabel(xlabel)
    ax.set_title(title)
    ax.xaxis.grid(True, color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    style_axes(ax)
    xmax = float(left.max()) if len(left) else 1.0
    ax.set_xlim(0, xmax * 1.18)
    for yi, total in enumerate(left):
        ax.text(total + xmax * 0.02, yi, str(int(total)), va="center", fontsize=9, color=FG)
    add_watch_year_legend(fig, years, palette)
    if footer:
        fig.text(0.01, 0.01, footer, fontsize=7, color=FG)
        fig.tight_layout(rect=[0, 0.03, 0.88, 1])
    else:
        fig.tight_layout(rect=[0, 0, 0.88, 1])
    save_dark_figure(fig, path, dpi=160)
    plt.close(fig)
    return True


def _prepare_rating_rows(
    rows: list[dict],
    *,
    label_key: str = "name",
    avg_key: str = "avg",
    rated_key: str = "rated",
    label_fn: Callable[[object], str] | None = None,
    limit: int = TOP_N_DEFAULT,
    ascending: bool = False,
) -> list[tuple[str, float, int | None]]:
    usable = []
    for row in rows or []:
        avg = row.get(avg_key)
        try:
            avg_f = float(avg)
        except (TypeError, ValueError):
            continue
        if not (avg_f > 0):
            continue
        raw = row.get(label_key)
        label = label_fn(raw) if label_fn else str(raw if raw is not None else "?")
        rated = row.get(rated_key)
        try:
            rated_n = int(rated) if rated is not None else None
        except (TypeError, ValueError):
            rated_n = None
        usable.append((label, avg_f, rated_n))
    if not usable:
        return []
    if ascending:
        usable.sort(key=lambda r: (r[1], -(r[2] or 0), r[0]))
        # Anti-rating charts need a full top-M slate — skip short lists.
        if limit and len(usable) < limit:
            return []
    else:
        usable.sort(key=lambda r: (-r[1], -(r[2] or 0), r[0]))
    if limit and len(usable) > limit:
        usable = usable[:limit]
    return usable


def _rating_colorbar(fig, ax, *, location: str = "right", size: str = "compact") -> None:
    """Rating colorbar; «оценка» title sits above (not a sideways label).

    size='compact' — calendar line charts (year/decade).
    size='large' — TMDB horizontal avg tops (roomier, pre-compact scale).
    """
    sm = plt.cm.ScalarMappable(cmap=rating_colormap(), norm=rating_norm())
    sm.set_array([])
    if size == "large":
        # Restore larger colorbar for TMDB deep avg charts (still left + title above).
        cbar = fig.colorbar(
            sm,
            ax=ax,
            location=location,
            fraction=0.04,
            pad=0.05,
            aspect=18,
            shrink=0.88,
        )
        title_size = 9
        tick_size = 8
    else:
        cbar = fig.colorbar(
            sm,
            ax=ax,
            location=location,
            fraction=0.018,
            pad=0.03,
            aspect=28,
            shrink=0.55,
        )
        title_size = 8
        tick_size = 7
    cbar.set_label("")
    cbar.ax.set_title(RATING_COLORBAR_LABEL, color=FG, fontsize=title_size, pad=6)
    cbar.ax.tick_params(labelsize=tick_size, colors=FG, length=2.5, width=0.6)
    plt.setp(plt.getp(cbar.ax.axes, "yticklabels"), color=FG)


def chart_rating_vbar(
    rows: list[dict],
    path: Path,
    *,
    title: str,
    label_key: str = "name",
    avg_key: str = "avg",
    rated_key: str = "rated",
    label_fn: Callable[[object], str] | None = None,
    footer: str | None = None,
    ylabel: str = "Средняя оценка (из 5)",
    limit: int = TOP_N_DEFAULT,
    ascending: bool = False,
) -> bool:
    """Vertical bars: X = category, Y = mean rating; color blue→green→red.

    Used for calendar release-year avg tops. ascending=True → worst first.
    """
    usable = _prepare_rating_rows(
        rows,
        label_key=label_key,
        avg_key=avg_key,
        rated_key=rated_key,
        label_fn=label_fn,
        limit=limit,
        ascending=ascending,
    )
    if not usable:
        return False
    labels = [_short_label(lab, limit=18) for lab, _, _ in usable]
    avgs = [a for _, a, _ in usable]
    colors = rating_colors(avgs)

    fig, ax = plt.subplots(figsize=(max(10.0, len(labels) * 0.55), 6.5))
    x = np.arange(len(labels))
    bars = ax.bar(x, avgs, color=colors, width=0.78, edgecolor="none")
    ax.set_xticks(x)
    ax.set_xticklabels(labels, rotation=45, ha="right")
    ax.set_ylim(0, 5.2)
    ax.set_ylabel(ylabel)
    ax.set_title(title)
    ax.yaxis.grid(True, color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    style_axes(ax)
    for bar, avg, rated in zip(bars, avgs, [n for _, _, n in usable]):
        suffix = f"\nn={rated}" if rated is not None else ""
        ax.text(
            bar.get_x() + bar.get_width() / 2,
            avg + 0.08,
            f"{avg:.2f}{suffix}",
            ha="center",
            va="bottom",
            fontsize=7,
            color=FG,
        )
    _rating_colorbar(fig, ax)
    if footer:
        fig.text(0.01, 0.01, footer, fontsize=7, color=FG)
        fig.tight_layout(rect=[0, 0.03, 1, 1])
    else:
        fig.tight_layout()
    save_dark_figure(fig, path, dpi=160)
    plt.close(fig)
    return True


def chart_rating_hbar(
    rows: list[dict],
    path: Path,
    *,
    title: str,
    label_key: str = "name",
    avg_key: str = "avg",
    rated_key: str = "rated",
    label_fn: Callable[[object], str] | None = None,
    footer: str | None = None,
    xlabel: str = "Средняя оценка (из 5)",
    limit: int = TOP_N_DEFAULT,
    ascending: bool = False,
) -> bool:
    """Horizontal bars for TMDB avg tops: rank+name inside bar (white + black stroke).

    ascending=False → best at top; True → worst at top («ниже оценка»).
    Mean/n always sits to the right of the bar; in-bar names are ellipsized to
    the bar width so they never collide with the trailing stats.
    """
    import matplotlib.patheffects as path_effects

    usable = _prepare_rating_rows(
        rows,
        label_key=label_key,
        avg_key=avg_key,
        rated_key=rated_key,
        label_fn=label_fn,
        limit=limit,
        ascending=ascending,
    )
    if not usable:
        return False

    # barh draws first row at bottom — reverse so rank 1 sits at top.
    display = list(reversed(list(enumerate(usable, start=1))))
    ranks = [rank for rank, _ in display]
    labels = [_short_label(lab, limit=40) for _, (lab, _, _) in display]
    avgs = [avg for _, (_, avg, _) in display]
    rateds = [rated for _, (_, _, rated) in display]
    colors = rating_colors(avgs)

    fig, ax = plt.subplots(figsize=(11, max(4.5, len(labels) * 0.48)))
    y = np.arange(len(labels))
    bars = ax.barh(y, avgs, color=colors, height=0.72, edgecolor="none")
    ax.set_yticks([])
    # Extra room on the right for mean/n outside the bar.
    ax.set_xlim(0, 5.65)
    ax.set_xlabel(xlabel)
    ax.set_title(title)
    ax.xaxis.grid(True, color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    style_axes(ax)

    # Layout must be finalized before measuring text against data coordinates.
    _rating_colorbar(fig, ax, location="left", size="large")
    if footer:
        fig.text(0.01, 0.01, footer, fontsize=7, color=FG)
        fig.tight_layout(rect=[0.02, 0.03, 1, 1])
    else:
        fig.tight_layout()
    fig.canvas.draw()
    renderer = fig.canvas.get_renderer()

    # White fill + black outline so labels pop on blue→green→red fills.
    stroke = [
        path_effects.Stroke(linewidth=3.2, foreground="#000000"),
        path_effects.Normal(),
    ]
    name_fs = 11
    pad_left = 0.08
    # Keep a generous empty tip so stroked names never crowd mean/n outside.
    tip_gap = 0.4
    for yi, bar, rank, label, avg, rated in zip(y, bars, ranks, labels, avgs, rateds):
        raw = f"{rank}. {label}"
        fitted = _fit_text_to_data_width(
            ax,
            renderer,
            raw,
            x0=pad_left,
            x1=max(pad_left, float(avg) - tip_gap),
            y=float(yi),
            fontsize=name_fs,
            fontweight="bold",
            path_effects=stroke,
        )
        txt = ax.text(
            pad_left,
            yi,
            fitted,
            ha="left",
            va="center",
            fontsize=name_fs,
            fontweight="bold",
            color="#FFFFFF",
            path_effects=stroke,
            clip_on=True,
        )
        # Hard clip to the bar rectangle — name cannot draw past the tip.
        txt.set_clip_path(bar)
        # Mean / n always outside the bar to the right — no overlap with name.
        mean_txt = f"{avg:.2f}" + (f"  n={rated}" if rated is not None else "")
        ax.text(
            float(avg) + 0.14,
            yi,
            mean_txt,
            ha="left",
            va="center",
            fontsize=9,
            color=FG,
            clip_on=False,
        )
    save_dark_figure(fig, path, dpi=160)
    plt.close(fig)
    return True


def chart_diary_entity_stacked(
    diary: pd.DataFrame,
    path: Path,
    *,
    names_for_row: Callable[[pd.Series], list[str]],
    title: str,
    top_n: int = TOP_N_DEFAULT,
    min_count: int = 1,
    label_fn: Callable[[str], str] | None = None,
    footer: str | None = None,
) -> bool:
    """Top entities by diary watch hits; stack segments by watch year."""
    work = diary.copy()
    if "Watched Date" not in work.columns:
        return False
    work["watch_year"] = work["Watched Date"].dt.year
    work = work[work["watch_year"].notna()].copy()
    if work.empty:
        return False
    work["watch_year"] = work["watch_year"].astype(int)

    totals: Counter[str] = Counter()
    pairs: list[tuple[int, list[str]]] = []
    for _, row in work.iterrows():
        names = [n for n in (names_for_row(row) or []) if n]
        if not names:
            continue
        wy = int(row["watch_year"])
        pairs.append((wy, names))
        for n in names:
            totals[n] += 1

    candidates = [(n, c) for n, c in totals.most_common() if c >= min_count]
    if not candidates:
        return False
    top = [n for n, _ in candidates[:top_n]]
    # Bottom-to-top: least among top-N at bottom.
    top = list(reversed(top))
    all_years = sorted(work["watch_year"].unique().tolist())
    palette = watch_year_palette(all_years)
    year_index = {y: i for i, y in enumerate(all_years)}
    name_index = {n: i for i, n in enumerate(top)}
    matrix = np.zeros((len(all_years), len(top)), dtype=float)
    for wy, names in pairs:
        for n in names:
            if n not in name_index:
                continue
            matrix[year_index[wy], name_index[n]] += 1

    labels = []
    for n in top:
        raw = label_fn(n) if label_fn else n
        labels.append(_short_label(raw))
    return chart_stacked_count_hbar(
        labels,
        all_years,
        matrix,
        palette,
        path,
        title=title,
        footer=footer,
    )


def chart_release_years_by_count(
    diary: pd.DataFrame, path: Path, top_n: int = TOP_N_DEFAULT
) -> bool:
    """Release-year count top stacked by watch year (diary only)."""

    def names_for_row(row):
        year = row.get("Year")
        if pd.isna(year):
            return []
        try:
            return [str(int(year))]
        except (TypeError, ValueError):
            return []

    return chart_diary_entity_stacked(
        diary,
        path,
        names_for_row=names_for_row,
        title="Годы выхода — больше просмотров (цвет = год просмотра)",
        top_n=top_n,
        min_count=1,
    )


def chart_release_years_by_rating(
    rows: list[dict],
    path: Path,
    limit: int = TOP_N_DEFAULT,
    *,
    ascending: bool = False,
    title: str | None = None,
) -> bool:
    """«Годы выхода — выше/ниже оценка» as TMDB-style horizontal avg bars.

    Same layout as deep-stats hbars: left «оценка» colorbar, in-bar ``N. Year``
    (white + black stroke), ``mean n=`` to the right of the bar. Not the
    watch-year / release-decade line charts.
    """
    normalized = []
    for row in rows or []:
        year = row.get("year")
        if year is None:
            continue
        normalized.append(
            {
                "name": str(int(year)),
                "avg": row.get("avg"),
                "rated": row.get("rated"),
            }
        )
    if title is None:
        title = (
            "Годы выхода — ниже оценка (больше 3 оценённых фильмов)"
            if ascending
            else "Годы выхода — выше оценка (больше 3 оценённых фильмов)"
        )
    return chart_rating_hbar(
        normalized,
        path,
        title=title,
        limit=limit,
        ascending=ascending,
    )


def color_bars_by_rating(avgs: list[float]) -> list[tuple]:
    """Public helper for existing chart call sites (decade / genre avg)."""
    return rating_colors(avgs)


def single_rating_bar_color(avg: float) -> tuple:
    return rating_color(avg)


def add_rating_colorbar(fig, ax, *, location: str = "right", size: str = "compact") -> None:
    """Shared colorbar for avg-rating charts (blue→green→red, 0.5–5).

    Calendar year/decade line charts use size='compact' (default).
    """
    _rating_colorbar(fig, ax, location=location, size=size)
