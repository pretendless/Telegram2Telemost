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
) -> bool:
    """Vertical bars: X = category, Y = mean rating; color blue→green→red."""
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
        return False

    # Highest average on the left (descending).
    usable.sort(key=lambda r: (-r[1], -(r[2] or 0), r[0]))
    if limit and len(usable) > limit:
        usable = usable[:limit]
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
    sm = plt.cm.ScalarMappable(cmap=rating_colormap(), norm=rating_norm())
    sm.set_array([])
    cbar = fig.colorbar(sm, ax=ax, fraction=0.025, pad=0.02)
    cbar.set_label(RATING_COLORBAR_LABEL, color=FG, fontsize=8)
    cbar.ax.yaxis.set_tick_params(color=FG)
    plt.setp(plt.getp(cbar.ax.axes, "yticklabels"), color=FG)
    if footer:
        fig.text(0.01, 0.01, footer, fontsize=7, color=FG)
        fig.tight_layout(rect=[0, 0.03, 1, 1])
    else:
        fig.tight_layout()
    save_dark_figure(fig, path, dpi=160)
    plt.close(fig)
    return True


# Back-compat alias for older call sites / tests.
chart_rating_hbar = chart_rating_vbar


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
    rows: list[dict], path: Path, limit: int = TOP_N_DEFAULT
) -> bool:
    """«Годы выхода — выше оценка» as vertical blue→green→red bars."""
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
    return chart_rating_vbar(
        normalized,
        path,
        title="Годы выхода — выше оценка (больше 3 оценённых фильмов)",
        limit=limit,
    )


def color_bars_by_rating(avgs: list[float]) -> list[tuple]:
    """Public helper for existing chart call sites (decade / genre avg)."""
    return rating_colors(avgs)


def single_rating_bar_color(avg: float) -> tuple:
    return rating_color(avg)


def add_rating_colorbar(fig, ax) -> None:
    """Shared colorbar for avg-rating charts (blue→green→red, 0.5–5)."""
    sm = plt.cm.ScalarMappable(cmap=rating_colormap(), norm=rating_norm())
    sm.set_array([])
    cbar = fig.colorbar(sm, ax=ax, fraction=0.025, pad=0.02)
    cbar.set_label(RATING_COLORBAR_LABEL, color=FG, fontsize=8)
    cbar.ax.yaxis.set_tick_params(color=FG)
    plt.setp(plt.getp(cbar.ax.axes, "yticklabels"), color=FG)
