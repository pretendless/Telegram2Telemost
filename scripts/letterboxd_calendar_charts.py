#!/usr/bin/env python3
"""Extra Letterboxd diary charts (no TMDB).

Usage:
  python letterboxd_calendar_charts.py path/to/letterboxd-export.zip

Writes into the current working directory:
  views_by_weekday_month.png
  views_by_year.png
  extra_stats_decade_rating.png
  average_rating_by_year.png
  average_rating_by_release_decade.png
  viewing_pace.png
  top_rewatches.png
  watches_by_release_year.png
  average_rating_by_release_year.png
  worst_average_rating_by_release_year.png
  diary_summary.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from letterboxd_export import (  # noqa: E402
    film_name_year_key,
    load_export,
    ratings_for_catalog,
)
from letterboxd_options import read_chart_options  # noqa: E402
from letterboxd_palette import (  # noqa: E402
    FG,
    GRID,
    apply_dark_chart_theme,
    save_dark_figure,
    style_axes,
    watch_year_palette,
)
from letterboxd_top_charts import (  # noqa: E402
    TOP_N_DEFAULT,
    add_rating_colorbar,
    chart_release_years_by_count,
    chart_release_years_by_rating,
    color_bars_by_rating,
    count_avg_text_style,
)
from letterboxd_ratings import (  # noqa: E402
    MIN_RATED_FOR_TOP,
    passes_rated_threshold,
)

apply_dark_chart_theme()

WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]
MONTHS = ["Янв", "Фев", "Мар", "Апр", "Май", "Июн", "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек"]
# Genitive month names for calendar dates («15 марта 2021»).
MONTHS_GENITIVE = [
    "января",
    "февраля",
    "марта",
    "апреля",
    "мая",
    "июня",
    "июля",
    "августа",
    "сентября",
    "октября",
    "ноября",
    "декабря",
]
RATING_BINS = [round(x * 0.5, 1) for x in range(1, 11)]  # 0.5 … 5.0


def format_ru_calendar_date(ts) -> str:
    """Format a pandas/py datetime as «15 марта 2021»."""
    day = int(ts.day)
    month = MONTHS_GENITIVE[int(ts.month) - 1]
    year = int(ts.year)
    return f"{day} {month} {year}"


def release_year_avg_lookup(rated_rows: pd.DataFrame | None) -> dict[str, tuple]:
    """Year string → (mean, unique rated films), including years under the gate."""
    if rated_rows is None or rated_rows.empty or "Year" not in rated_rows.columns:
        return {}
    work = rated_rows[rated_rows["Year"].notna() & rated_rows["Rating"].notna()].copy()
    if work.empty:
        return {}
    work["release_year"] = work["Year"].astype(int)
    grouped = work.groupby("release_year")["Rating"].agg(avg="mean", rated="count")
    out: dict[str, tuple] = {}
    for year, row in grouped.iterrows():
        rated_n = int(row["rated"])
        avg = round(float(row["avg"]), 2) if rated_n else None
        out[str(int(year))] = (avg, rated_n)
    return out


def build_diary_summary(
    diary: pd.DataFrame,
    catalog: pd.DataFrame | None = None,
    watched_only: pd.DataFrame | None = None,
    film_ratings: pd.DataFrame | None = None,
    *,
    top_n: int = TOP_N_DEFAULT,
    min_rated: int = MIN_RATED_FOR_TOP,
) -> dict:
    """Compact stats for the Telegram HTML report (no TMDB).

    Date-sensitive fields use diary only. Unique films and release-year count
    tops use diary ∪ watched-only (catalog). Rating avg/mode and rating tops
    use ratings.csv (primary) ∪ diary fallback, joined to catalog.
    """
    df = diary
    cat = catalog if catalog is not None else diary
    only = watched_only if watched_only is not None else df.iloc[0:0].copy()
    if film_ratings is None:
        from letterboxd_export import merged_film_ratings

        film_ratings = merged_film_ratings(None, df)
    catalog_rated = ratings_for_catalog(cat, film_ratings)

    entries = int(len(df))
    names = df["Name"].fillna("").astype(str).str.strip()
    years_release = df["Year"] if "Year" in df.columns else pd.Series(dtype=float)
    unique_key = names + "|||" + years_release.map(lambda y: str(int(y)) if pd.notna(y) else "")

    cat_names = cat["Name"].fillna("").astype(str).str.strip()
    cat_keys = film_name_year_key(cat)
    unique_films = int(cat_keys[cat_names != ""].nunique()) if len(cat) else 0

    watch_years = df["Watched Date"].dt.year.dropna().astype(int)
    year_min = int(watch_years.min()) if len(watch_years) else None
    year_max = int(watch_years.max()) if len(watch_years) else None

    year_counts = watch_years.value_counts()
    peak_year = int(year_counts.index[0]) if len(year_counts) else None
    peak_year_count = int(year_counts.iloc[0]) if len(year_counts) else 0

    # Peak calendar day: most diary rows on a single Watched Date (diary only).
    peak_day = None
    peak_day_count = 0
    peak_day_label = None
    dated = df[df["Watched Date"].notna()]
    if len(dated):
        day_counts = dated["Watched Date"].dt.normalize().value_counts()
        if len(day_counts):
            peak_ts = day_counts.index[0]
            peak_day_count = int(day_counts.iloc[0])
            peak_day = str(pd.Timestamp(peak_ts).date())
            peak_day_label = format_ru_calendar_date(pd.Timestamp(peak_ts))

    weekday_counts = df["Watched Date"].dt.weekday.value_counts()
    fav_wd_i = int(weekday_counts.index[0]) if len(weekday_counts) else None
    favorite_weekday = WEEKDAYS[fav_wd_i] if fav_wd_i is not None else None
    favorite_weekday_count = int(weekday_counts.iloc[0]) if len(weekday_counts) else 0

    month_counts = df["Watched Date"].dt.month.value_counts()
    fav_m_i = int(month_counts.index[0]) if len(month_counts) else None
    favorite_month = MONTHS[fav_m_i - 1] if fav_m_i is not None else None
    favorite_month_count = int(month_counts.iloc[0]) if len(month_counts) else 0

    # Averages / mode: ratings.csv ∪ diary fallback (unique films).
    rated = catalog_rated["Rating"] if not catalog_rated.empty else pd.Series(dtype=float)
    rated_count = int(len(rated))
    rated_share = round(rated_count / unique_films, 4) if unique_films else 0.0
    rating_avg = round(float(rated.mean()), 2) if rated_count else None
    rating_mode = None
    rating_mode_count = 0
    if rated_count:
        bins = rated.map(round_rating).dropna()
        if len(bins):
            mode_counts = bins.value_counts()
            rating_mode = float(mode_counts.index[0])
            rating_mode_count = int(mode_counts.iloc[0])

    # Rewatches stay diary-only (need repeated Watched Dates).
    rewatch_rows = []
    if entries:
        grouped = (
            df[names != ""]
            .assign(_key=unique_key[names != ""])
            .groupby("_key", dropna=False)
            .agg(count=("Name", "size"), Name=("Name", "first"), Year=("Year", "first"))
        )
        multi = grouped[grouped["count"] >= 2].sort_values("count", ascending=False).head(8)
        for _, row in multi.iterrows():
            year_val = row["Year"]
            rewatch_rows.append(
                {
                    "name": str(row["Name"]),
                    "year": int(year_val) if pd.notna(year_val) else None,
                    "count": int(row["count"]),
                }
            )

    # Release-year tops: catalog counts; ratings from ratings.csv join.
    top_rated_release_years: list[dict] = []
    top_release_years_by_count: list[dict] = []
    with_release = cat[cat["Year"].notna()].copy()
    if not with_release.empty:
        with_release["release_year"] = with_release["Year"].astype(int)
        film_counts = (
            with_release[with_release["Name"].fillna("").astype(str).str.strip() != ""]
            .assign(_fk=film_name_year_key(with_release))
            .groupby("release_year")["_fk"]
            .nunique()
        )
        latest_release = catalog_rated
        if not latest_release.empty and "Year" in latest_release.columns:
            latest_release = latest_release[latest_release["Year"].notna()].copy()
            latest_release["release_year"] = latest_release["Year"].astype(int)
            # rated = unique films after ratings.csv merge (Name+Year), not diary rows.
            rated_by_year = latest_release.groupby("release_year")["Rating"].agg(
                avg="mean", rated="count"
            )
            for year, row in rated_by_year.iterrows():
                rated_n = int(row["rated"])
                if not passes_rated_threshold(rated_n, min_rated=min_rated):
                    continue
                top_rated_release_years.append(
                    {
                        "year": int(year),
                        "avg": round(float(row["avg"]), 2),
                        "films": int(film_counts.get(year, 0)),
                        "rated": rated_n,
                    }
                )
            top_rated_release_years.sort(key=lambda r: (-r["avg"], -r["rated"], -r["year"]))
            # Anti-rating only when a full top-M of qualifying years exists.
            if len(top_rated_release_years) >= top_n:
                worst_rated_release_years = sorted(
                    top_rated_release_years,
                    key=lambda r: (r["avg"], -r["rated"], r["year"]),
                )[:top_n]
            else:
                worst_rated_release_years = []
            top_rated_release_years = top_rated_release_years[:top_n]
        else:
            worst_rated_release_years = []

        # Counts: every diary row + one per watched-only film (no fake dates).
        watch_by_release = with_release.groupby("release_year").size().sort_values(ascending=False)
        for year, count in watch_by_release.head(top_n).items():
            top_release_years_by_count.append({"year": int(year), "count": int(count)})
    else:
        worst_rated_release_years = []

    return {
        "entries": entries,
        "unique_films": unique_films,
        "watched_only_films": int(len(only)) if only is not None else 0,
        "year_min": year_min,
        "year_max": year_max,
        "rated_count": rated_count,
        "rated_share": rated_share,
        "peak_year": peak_year,
        "peak_year_count": peak_year_count,
        "peak_day": peak_day,
        "peak_day_label": peak_day_label,
        "peak_day_count": peak_day_count,
        "favorite_weekday": favorite_weekday,
        "favorite_weekday_count": favorite_weekday_count,
        "favorite_month": favorite_month,
        "favorite_month_count": favorite_month_count,
        "films_per_month": viewing_pace_stats(df).get("films_per_month"),
        "rating_avg": rating_avg,
        "rating_mode": rating_mode,
        "rating_mode_count": rating_mode_count,
        "top_rewatches": rewatch_rows,
        "top_rated_release_years": top_rated_release_years,
        "worst_rated_release_years": worst_rated_release_years,
        "top_release_years_by_count": top_release_years_by_count,
        "min_rated_for_top": int(min_rated),
        "top_n": int(top_n),
    }


def year_colors(years: list[int], palette_years: list[int] | None = None):
    """Watch-year colors; palette_years sets the full turbo span when provided."""
    scale = sorted(set(int(y) for y in (palette_years if palette_years is not None else years)))
    full = watch_year_palette(scale)
    return {int(y): full[int(y)] for y in years if int(y) in full}


def stacked_counts(ax, categories: list[str], years: list[int], matrix: np.ndarray, colors: dict, ylabel: str):
    """matrix shape: (len(years), len(categories))"""
    bottom = np.zeros(len(categories))
    x = np.arange(len(categories))
    for yi, year in enumerate(years):
        vals = matrix[yi]
        ax.bar(x, vals, bottom=bottom, color=colors[year], width=0.82, edgecolor="none")
        bottom += vals
    ax.set_xticks(x)
    ax.set_xticklabels(categories, rotation=45 if len(categories) > 8 else 0, ha="right" if len(categories) > 8 else "center")
    ax.set_ylabel(ylabel)
    ax.yaxis.grid(True, color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    style_axes(ax)


def add_watch_year_legend(fig, years: list[int], colors: dict, title: str = "Год"):
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


def chart_weekday_month(df: pd.DataFrame, path: Path) -> None:
    df = df.copy()
    df["watch_year"] = df["Watched Date"].dt.year.astype(int)
    df["weekday"] = df["Watched Date"].dt.weekday
    df["month"] = df["Watched Date"].dt.month

    years = sorted(df["watch_year"].unique().tolist())
    colors = year_colors(years)

    week = np.zeros((len(years), 7), dtype=float)
    month = np.zeros((len(years), 12), dtype=float)
    year_index = {y: i for i, y in enumerate(years)}
    for _, row in df.iterrows():
        yi = year_index[int(row["watch_year"])]
        week[yi, int(row["weekday"])] += 1
        month[yi, int(row["month"]) - 1] += 1

    fig, axes = plt.subplots(2, 1, figsize=(14, 10), sharey=False)
    fig.suptitle(
        "Распределение просмотров по дням недели и месяцам с разбивкой по годам",
        fontsize=14,
        y=0.98,
    )

    stacked_counts(axes[0], WEEKDAYS, years, week, colors, "Количество записей о просмотрах")
    axes[0].set_title("Просмотры по дням недели — состав по годам")

    stacked_counts(axes[1], MONTHS, years, month, colors, "Количество записей о просмотрах")
    axes[1].set_title("Просмотры по месяцам — состав по годам")

    add_watch_year_legend(fig, years, colors, title="Год")
    fig.tight_layout(rect=[0, 0, 0.9, 0.96])
    save_dark_figure(fig, path, dpi=160)
    plt.close(fig)


# Watch-time axis: short spans must not collapse into one or two year bars.
# ≤45 inclusive days → days; ≤18 inclusive calendar months → months; else years.
WATCH_GRAIN_DAY_MAX = 45
WATCH_GRAIN_MONTH_MAX = 18
GRAIN_PHRASE = {"day": "по дням", "month": "по месяцам", "year": "по годам"}
GRAIN_XLABEL = {
    "day": "День просмотра",
    "month": "Месяц просмотра",
    "year": "Год просмотра",
}


def watch_time_grain(start, end) -> str:
    """Grain for charts whose x-axis is watch time."""
    if start is None or end is None or pd.isna(start) or pd.isna(end):
        return "year"
    start_ts = pd.Timestamp(start).normalize()
    end_ts = pd.Timestamp(end).normalize()
    if end_ts < start_ts:
        start_ts, end_ts = end_ts, start_ts
    days = int((end_ts - start_ts).days) + 1
    months = (end_ts.year - start_ts.year) * 12 + (end_ts.month - start_ts.month) + 1
    if days <= WATCH_GRAIN_DAY_MAX:
        return "day"
    if months <= WATCH_GRAIN_MONTH_MAX:
        return "month"
    return "year"


def resolve_watch_bounds(df: pd.DataFrame, date_from: str | None = None, date_to: str | None = None):
    """Custom window if set; otherwise first→last Watched Date in the frame."""
    if date_from and date_to:
        return pd.Timestamp(date_from), pd.Timestamp(date_to)
    if df is None or df.empty or "Watched Date" not in df.columns:
        return None, None
    dates = df["Watched Date"].dropna()
    if dates.empty:
        return None, None
    return pd.Timestamp(dates.min()), pd.Timestamp(dates.max())


def _grain_tick_labels(index, grain: str) -> list[str]:
    labels = []
    multi_year = False
    if grain == "day" and len(index):
        years = {pd.Timestamp(v).year for v in index}
        multi_year = len(years) > 1
    for value in index:
        if grain == "year":
            labels.append(str(int(value)))
        elif grain == "month":
            per = value if isinstance(value, pd.Period) else pd.Period(value, freq="M")
            labels.append(f"{MONTHS[int(per.month) - 1]} {per.year}")
        else:
            ts = pd.Timestamp(value)
            if multi_year:
                labels.append(f"{ts.day:02d}.{ts.month:02d}.{str(ts.year)[2:]}")
            else:
                labels.append(f"{ts.day} {MONTHS[ts.month - 1]}")
    return labels


def _watch_count_series(dates: pd.Series, grain: str, start, end) -> pd.Series:
    if grain == "day":
        idx = pd.date_range(pd.Timestamp(start).normalize(), pd.Timestamp(end).normalize(), freq="D")
        counts = dates.dt.normalize().value_counts()
        return counts.reindex(idx, fill_value=0).astype(int)
    if grain == "month":
        counts = dates.dt.to_period("M").value_counts()
        full = pd.period_range(pd.Timestamp(start).to_period("M"), pd.Timestamp(end).to_period("M"), freq="M")
        return counts.reindex(full, fill_value=0).astype(int)
    years = dates.dt.year.dropna().astype(int)
    return years.value_counts().sort_index()


def _dense_label_layout(n: int) -> tuple[float, int]:
    """Font size and rotation so every bar/point keeps its value label."""
    if n <= 24:
        return 8, 0
    if n <= 32:
        return 7, 0
    return 6.5, 90


def _watch_bucket_key(value, grain: str):
    if grain == "year":
        return int(value)
    if grain == "month":
        return value if isinstance(value, pd.Period) else pd.Period(value, freq="M")
    return pd.Timestamp(value).normalize()


def _avg_labels_for_watch_counts(df: pd.DataFrame, index, grain: str) -> list[str]:
    """Mean beside each watch-count bar. «—» when the bucket has no rating.

    Same diary-row mean as the paired average chart (not unique-film, no n=).
    """
    means = diary_rating_means_by_watch_year(df, grain=grain)
    lookup: dict = {}
    if not means.empty:
        for key, row in means.iterrows():
            lookup[_watch_bucket_key(key, grain)] = float(row["mean"])
    labels = []
    for key in index:
        avg = lookup.get(_watch_bucket_key(key, grain))
        labels.append("—" if avg is None else f"{avg:.2f}")
    return labels


def _place_count_avg_above_bars(fig, ax, bars, values, avg_labels, *, y_pad, fontsize, rotation) -> None:
    """Count in regular white, mean beside it, pair centered on the bar."""
    specs = []
    for bar, value, label in zip(bars, values, avg_labels):
        y = float(bar.get_height()) + y_pad
        x = float(bar.get_x() + bar.get_width() / 2)
        count = ax.text(
            x,
            y,
            str(int(value)),
            ha="left",
            va="bottom",
            fontsize=fontsize,
            rotation=rotation,
            color=FG,
            fontweight="normal",
            clip_on=False,
        )
        style = count_avg_text_style(label)
        avg = ax.text(
            x,
            y,
            label,
            ha="left",
            va="bottom",
            fontsize=fontsize,
            rotation=rotation,
            color=style["color"],
            fontweight=style["fontweight"],
            path_effects=style["path_effects"],
            clip_on=False,
        )
        specs.append((count, avg, y))
    fig.canvas.draw()
    renderer = fig.canvas.get_renderer()
    gap = 4.0
    for count, avg, y in specs:
        cb = count.get_window_extent(renderer=renderer)
        ab = avg.get_window_extent(renderer=renderer)
        total = cb.width + gap + ab.width
        anchor = ax.transData.transform(count.get_position())
        start = anchor[0] - total / 2

        def shift(artist, bbox, target_x0, y_data=y):
            origin = ax.transData.transform(artist.get_position())
            moved = ax.transData.inverted().transform((origin[0] + (target_x0 - bbox.x0), origin[1]))
            artist.set_position((moved[0], y_data))

        shift(count, cb, start)
        shift(avg, ab, start + cb.width + gap)


def chart_views_by_year(
    df: pd.DataFrame,
    path: Path,
    *,
    grain: str = "year",
    span_start=None,
    span_end=None,
) -> None:
    dates = df["Watched Date"].dropna()
    if dates.empty:
        return
    if span_start is None or span_end is None:
        span_start, span_end = dates.min(), dates.max()
    counts = _watch_count_series(dates, grain, span_start, span_end)
    labels = _grain_tick_labels(counts.index, grain)
    values = counts.values.astype(int)
    color_years = []
    for value in counts.index:
        if grain == "year":
            color_years.append(int(value))
        elif grain == "month":
            per = value if isinstance(value, pd.Period) else pd.Period(value, freq="M")
            color_years.append(int(per.year))
        else:
            color_years.append(int(pd.Timestamp(value).year))
    colors = year_colors(sorted(set(color_years)), palette_years=sorted(set(color_years)))
    bar_colors = [colors.get(y, "#4C78A8") for y in color_years]
    phrase = GRAIN_PHRASE.get(grain, "по годам")

    n = len(labels)
    # Wider than the count-only chart: each bar carries a count and a mean.
    fig_w = max(12.0, min(18.0, n * 0.72)) if grain == "year" else max(10.0, min(18.0, n * 0.42))
    fig, ax = plt.subplots(figsize=(fig_w, 6))
    x = np.arange(n)
    bars = ax.bar(x, values, color=bar_colors, width=0.8)
    ax.set_title(f"Количество просмотров фильмов {phrase}")
    ax.set_xlabel(GRAIN_XLABEL.get(grain, "Год просмотра"))
    ax.set_ylabel("Количество записей о просмотрах")
    step = 1 if n <= 16 else max(1, n // 14)
    tick_idx = list(range(0, n, step))
    if tick_idx and tick_idx[-1] != n - 1:
        tick_idx.append(n - 1)
    ax.set_xticks(tick_idx or x)
    ax.set_xticklabels([labels[i] for i in tick_idx] if tick_idx else labels, rotation=45, ha="right")
    ax.yaxis.grid(True, color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    style_axes(ax)
    ymax = max(int(v) for v in values) if len(values) else 1
    fontsize, rotation = _dense_label_layout(n)
    # The mean sits beside the count, so the pair needs a smaller face than a lone number.
    if rotation == 0 and n > 12:
        fontsize = min(fontsize, 7)
    ax.set_ylim(0, ymax * (1.18 if rotation == 0 else 1.28))
    fig.tight_layout()
    _place_count_avg_above_bars(
        fig,
        ax,
        bars,
        values,
        _avg_labels_for_watch_counts(df, counts.index, grain),
        y_pad=ymax * 0.015,
        fontsize=fontsize,
        rotation=rotation,
    )
    save_dark_figure(fig, path, dpi=160)
    plt.close(fig)


def release_decade_label(year) -> str | None:
    if pd.isna(year):
        return None
    try:
        y = int(year)
    except (TypeError, ValueError):
        return None
    if y < 1000 or y > 2100:
        return None
    decade = (y // 10) * 10
    return f"{decade}s"


def round_rating(value) -> float | None:
    if pd.isna(value):
        return None
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    if v <= 0 or v > 5:
        return None
    # Nearest half-star (Letterboxd scale).
    rounded = round(v * 2) / 2
    if rounded < 0.5:
        rounded = 0.5
    if rounded > 5.0:
        rounded = 5.0
    return rounded


def chart_decade_rating(df: pd.DataFrame, path: Path) -> None:
    df = df.copy()
    df["watch_year"] = df["Watched Date"].dt.year.astype(int)
    df["decade"] = df["Year"].map(release_decade_label)
    df["rating_bin"] = df["Rating"].map(round_rating)

    years = sorted(df["watch_year"].unique().tolist())
    colors = year_colors(years)
    year_index = {y: i for i, y in enumerate(years)}

    decades = sorted(
        {d for d in df["decade"].dropna().unique().tolist()},
        key=lambda label: int(str(label).rstrip("s")),
    )
    if not decades:
        # Still emit a chart so the bot always gets this PNG when diary parses.
        decades = ["2020s"]

    decade_matrix = np.zeros((len(years), len(decades)), dtype=float)
    decade_index = {d: i for i, d in enumerate(decades)}
    for _, row in df.iterrows():
        decade = row["decade"]
        if decade not in decade_index:
            continue
        yi = year_index[int(row["watch_year"])]
        decade_matrix[yi, decade_index[decade]] += 1

    rating_matrix = np.zeros((len(years), len(RATING_BINS)), dtype=float)
    rating_index = {r: i for i, r in enumerate(RATING_BINS)}
    for _, row in df.iterrows():
        rating = row["rating_bin"]
        if rating not in rating_index:
            continue
        yi = year_index[int(row["watch_year"])]
        rating_matrix[yi, rating_index[rating]] += 1

    fig, axes = plt.subplots(2, 1, figsize=(14, 10), sharey=False)
    fig.suptitle("Дополнительная статистика Letterboxd", fontsize=14, y=0.98)

    stacked_counts(
        axes[0],
        decades,
        years,
        decade_matrix,
        colors,
        "Количество записей о просмотрах",
    )
    axes[0].set_title("Просмотренные фильмы по десятилетию выхода — цвет обозначает год просмотра")

    rating_labels = [f"{r:g}" for r in RATING_BINS]
    stacked_counts(
        axes[1],
        rating_labels,
        years,
        rating_matrix,
        colors,
        "Количество записей с оценкой",
    )
    axes[1].set_title("Распределение оценок — цвет обозначает год просмотра")
    axes[1].set_xlabel("Оценка Letterboxd")

    add_watch_year_legend(fig, years, colors, title="Год просмотра")
    fig.tight_layout(rect=[0, 0, 0.9, 0.96])
    save_dark_figure(fig, path, dpi=160)
    plt.close(fig)


def _chart_average_rating_line(
    labels: list,
    values: list[float],
    counts: list[int],
    path: Path,
    *,
    title: str,
    xlabel: str,
    ylabel: str = "Средняя оценка (из 5)",
) -> bool:
    """Line + markers: points colored blue→green→red by mean rating."""
    if not labels or not values:
        return False
    point_colors = color_bars_by_rating(values)
    fig, ax = plt.subplots(figsize=(max(10.0, len(labels) * 0.45), 6.5))
    x = np.arange(len(labels))
    # Readable connector on dark theme; markers carry the rating color.
    ax.plot(x, values, color="#9A9A9A", linewidth=1.8, zorder=1, solid_capstyle="round")
    ax.scatter(
        x,
        values,
        c=point_colors,
        s=72,
        zorder=2,
        edgecolors="#111111",
        linewidths=0.7,
    )
    ax.set_ylim(0, 5.2)
    ax.set_title(title)
    ax.set_xlabel(xlabel)
    ax.set_ylabel(ylabel)
    ax.set_xticks(x)
    ax.set_xticklabels([str(lab) for lab in labels], rotation=45, ha="right")
    ax.yaxis.grid(True, color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    style_axes(ax)
    fontsize, rotation = _dense_label_layout(len(labels))
    if rotation:
        ax.set_ylim(0, 5.6)
    for xi, value in zip(x, values):
        text = f"{value:.2f}"
        style = count_avg_text_style(text)
        ax.text(
            xi,
            value + 0.12,
            text,
            ha="center",
            va="bottom",
            fontsize=fontsize,
            rotation=rotation,
            color=style["color"],
            fontweight=style["fontweight"],
            path_effects=style["path_effects"],
        )
    add_rating_colorbar(fig, ax)
    fig.tight_layout()
    save_dark_figure(fig, path, dpi=160)
    plt.close(fig)
    return True


def _pace_bounds(dates: pd.Series, span_start, span_end):
    if span_start is not None and span_end is not None:
        start = pd.Timestamp(span_start).normalize()
        end = pd.Timestamp(span_end).normalize()
        if end < start:
            start, end = end, start
        return start, end
    return dates.min().normalize(), dates.max().normalize()


def viewing_pace_stats(
    df: pd.DataFrame,
    grain: str = "month",
    span_start=None,
    span_end=None,
) -> dict:
    """Diary watch pace from Watched Date.

    Default bounds are first→last watch. A custom window passes span_start/span_end
    so empty days or months inside that window stay on the chart as zeros.
    films_per_month = diary rows / inclusive calendar months of that span.
    """
    out: dict = {
        "films_per_month": None,
        "span_months": 0,
        "periods": [],
        "counts": [],
    }
    if df is None or df.empty or "Watched Date" not in df.columns:
        return out
    dates = df["Watched Date"].dropna()
    if dates.empty:
        return out
    total = int(len(dates))
    start, end = _pace_bounds(dates, span_start, span_end)
    if grain == "day":
        idx = pd.date_range(start, end, freq="D")
        series = dates.dt.normalize().value_counts().reindex(idx, fill_value=0).astype(int)
        span = int(len(series))
        out["span_days"] = span
        out["periods"] = [pd.Timestamp(p).strftime("%Y-%m-%d") for p in series.index]
        out["counts"] = [int(v) for v in series.tolist()]
        out["grain"] = "day"
        if span > 0:
            out["films_per_day"] = round(total / span, 2)
        month_span = int(len(pd.period_range(start.to_period("M"), end.to_period("M"), freq="M")))
        out["span_months"] = month_span
        if month_span > 0:
            out["films_per_month"] = round(total / month_span, 1)
        return out

    periods = dates.dt.to_period("M")
    counts = periods.value_counts().sort_index()
    if counts.empty and span_start is None:
        return out
    full = pd.period_range(start.to_period("M"), end.to_period("M"), freq="M")
    series = counts.reindex(full, fill_value=0).astype(int)
    span = int(len(series))
    out["span_months"] = span
    out["periods"] = [str(p) for p in series.index.tolist()]
    out["counts"] = [int(v) for v in series.tolist()]
    out["grain"] = "month"
    if span > 0:
        out["films_per_month"] = round(total / span, 1)
    return out


def chart_viewing_pace(
    df: pd.DataFrame,
    path: Path,
    *,
    grain: str = "month",
    span_start=None,
    span_end=None,
) -> bool:
    """Line of diary watches. Daily when the watch span is ≤45 days; otherwise months.

    Long diaries stay monthly — this chart was never a yearly bar chart.
    span_start/span_end fill zero buckets across a custom window.
    """
    pace_grain = "day" if grain == "day" else "month"
    stats = viewing_pace_stats(df, grain=pace_grain, span_start=span_start, span_end=span_end)
    periods = stats.get("periods") or []
    counts = stats.get("counts") or []
    avg = stats.get("films_per_day") if pace_grain == "day" else stats.get("films_per_month")
    if len(periods) < 2:
        return False

    # Tick labels: day or short month + year; thin out when many buckets.
    labels = []
    if pace_grain == "day":
        stamps = [pd.Timestamp(p) for p in periods]
        multi_year = len({ts.year for ts in stamps}) > 1
        for ts in stamps:
            if multi_year:
                labels.append(f"{ts.day:02d}.{ts.month:02d}.{str(ts.year)[2:]}")
            else:
                labels.append(f"{ts.day} {MONTHS[ts.month - 1]}")
    else:
        for p in periods:
            per = pd.Period(p, freq="M")
            labels.append(f"{MONTHS[int(per.month) - 1]} {per.year}")
    n = len(labels)
    step = max(1, n // 14)
    tick_idx = list(range(0, n, step))
    if tick_idx[-1] != n - 1:
        tick_idx.append(n - 1)

    fig_w = max(10.0, min(16.0, n * 0.22))
    fig, ax = plt.subplots(figsize=(fig_w, 5.8))
    x = np.arange(n)
    line_color = "#5EB8E0"
    ax.plot(
        x,
        counts,
        color=line_color,
        linewidth=2.0,
        zorder=2,
        solid_capstyle="round",
    )
    ax.fill_between(x, counts, color=line_color, alpha=0.18, zorder=1)
    ax.scatter(
        x,
        counts,
        c=line_color,
        s=28 if n <= 48 else 16,
        zorder=3,
        edgecolors="#111111",
        linewidths=0.5,
    )
    if avg is not None and avg > 0:
        ax.axhline(
            float(avg),
            color="#E0C06A",
            linestyle="--",
            linewidth=1.4,
            zorder=2,
            label=(f"среднее {avg:.1f}/день" if pace_grain == "day" else f"среднее {avg:.1f}/мес"),
        )
        leg = ax.legend(loc="upper right", frameon=False, labelcolor=FG, fontsize=10)
        if leg is not None:
            for text in leg.get_texts():
                text.set_color(FG)
    if pace_grain == "day":
        ax.set_title("Темп просмотров по дням")
        ax.set_xlabel("День просмотра")
        ax.set_ylabel("Фильмов за день")
    else:
        ax.set_title("Темп просмотров по месяцам")
        ax.set_xlabel("Месяц просмотра")
        ax.set_ylabel("Фильмов за месяц")
    ax.set_xticks(tick_idx)
    ax.set_xticklabels([labels[i] for i in tick_idx], rotation=45, ha="right")
    ymax = max(counts) if counts else 1
    ax.set_ylim(0, max(ymax * 1.15, (avg or 0) * 1.3, 1))
    ax.yaxis.grid(True, color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    style_axes(ax)
    fig.tight_layout()
    save_dark_figure(fig, path, dpi=160)
    plt.close(fig)
    return True


def diary_rating_means_by_watch_year(df: pd.DataFrame, grain: str = "year") -> pd.DataFrame:
    """Mean Rating per watch bucket from **each** rated diary row (no film collapse).

    Rewatches with ratings in different buckets contribute to those buckets.
    Does not use ratings.csv / latest-per-film merge. Default grain is year.
    """
    empty = pd.DataFrame(columns=["mean", "count"])
    if df is None or df.empty or "Rating" not in df.columns or "Watched Date" not in df.columns:
        return empty
    work = df[df["Watched Date"].notna() & df["Rating"].notna()].copy()
    if work.empty:
        return empty
    work["Rating"] = pd.to_numeric(work["Rating"], errors="coerce")
    work = work[work["Rating"].notna() & (work["Rating"] > 0)].copy()
    if work.empty:
        return empty
    if grain == "day":
        work["bucket"] = work["Watched Date"].dt.normalize()
    elif grain == "month":
        work["bucket"] = work["Watched Date"].dt.to_period("M")
    else:
        work["bucket"] = work["Watched Date"].dt.year.astype(int)
    grouped = work.groupby("bucket")["Rating"].agg(["mean", "count"]).sort_index()
    return grouped[grouped["count"] >= 1]


def chart_average_rating_by_year(
    df: pd.DataFrame,
    path: Path,
    film_ratings: pd.DataFrame | None = None,
    *,
    grain: str = "year",
) -> bool:
    """Mean diary Rating per watch bucket — each rated diary row in its Watched Date bucket.

    Exception to the usual latest-rating-per-film rule: rewatches contribute to
    the bucket they were watched (not collapsed to one film score). ``film_ratings``
    / ratings.csv are ignored here (kept as a no-op kwarg for call-site compat).
    """
    del film_ratings  # intentional: do not collapse to latest film rating
    grouped = diary_rating_means_by_watch_year(df, grain=grain)
    if grouped.empty:
        return False

    labels = _grain_tick_labels(grouped.index, grain)
    values = grouped["mean"].astype(float).tolist()
    counts = grouped["count"].astype(int).tolist()
    phrase = GRAIN_PHRASE.get(grain, "по годам")
    return _chart_average_rating_line(
        labels,
        values,
        counts,
        path,
        title=f"Средняя оценка {phrase}",
        xlabel=GRAIN_XLABEL.get(grain, "Год просмотра"),
    )


def chart_average_rating_by_release_decade(
    diary: pd.DataFrame,
    path: Path,
    watched_only: pd.DataFrame | None = None,
    film_ratings: pd.DataFrame | None = None,
    catalog: pd.DataFrame | None = None,
) -> bool:
    """Mean Letterboxd Rating per film release decade (ratings.csv ∪ diary).

    Watch-count stacks by decade live in extra_stats_decade_rating.png — do not
    duplicate that metric here. No watch-year stack.
    """
    cat = catalog if catalog is not None else diary
    if film_ratings is None:
        from letterboxd_export import merged_film_ratings

        film_ratings = merged_film_ratings(None, diary)
    work = ratings_for_catalog(cat, film_ratings)
    if work.empty:
        return False
    work = work[work["Year"].notna()].copy()
    if work.empty:
        return False
    work["decade"] = work["Year"].map(release_decade_label)
    work = work[work["decade"].notna()]
    if work.empty:
        return False

    grouped = work.groupby("decade")["Rating"].agg(["mean", "count"])
    grouped = grouped[grouped["count"] >= 1].copy()
    if grouped.empty:
        return False
    grouped["_sort"] = grouped.index.map(lambda label: int(str(label).rstrip("s")))
    grouped = grouped.sort_values("_sort")

    labels = grouped.index.tolist()
    values = grouped["mean"].astype(float).tolist()
    counts = grouped["count"].astype(int).tolist()
    return _chart_average_rating_line(
        labels,
        values,
        counts,
        path,
        title="Средняя оценка по десятилетию выхода",
        xlabel="Десятилетие выхода",
    )


def chart_top_rewatches(df: pd.DataFrame, path: Path, limit: int = 20) -> bool:
    """Horizontal stacked bars of rewatched films, colored by watch year."""
    names = df["Name"].fillna("").astype(str).str.strip()
    years_release = df["Year"] if "Year" in df.columns else pd.Series(dtype=float)
    key = names + "|||" + years_release.map(lambda y: str(int(y)) if pd.notna(y) else "")
    work = df[names != ""].copy()
    if work.empty:
        return False
    work["_key"] = key[names != ""]
    work["watch_year"] = work["Watched Date"].dt.year.astype(int)
    grouped = work.groupby("_key", dropna=False).agg(
        count=("Name", "size"),
        Name=("Name", "first"),
        Year=("Year", "first"),
    )
    multi = grouped[grouped["count"] >= 2].sort_values("count", ascending=True).tail(limit)
    if multi.empty:
        return False

    keys = multi.index.tolist()
    all_years = sorted(df["Watched Date"].dt.year.dropna().astype(int).unique().tolist())
    years = sorted(work.loc[work["_key"].isin(keys), "watch_year"].unique().tolist())
    colors = year_colors(years, palette_years=all_years)

    labels = []
    for key_id in keys:
        row = multi.loc[key_id]
        year_val = row["Year"]
        year_s = f" ({int(year_val)})" if pd.notna(year_val) else ""
        title = str(row["Name"])
        if len(title) > 42:
            title = title[:40] + "…"
        labels.append(f"{title}{year_s}")

    matrix = np.zeros((len(years), len(keys)), dtype=float)
    year_index = {y: i for i, y in enumerate(years)}
    key_index = {k: i for i, k in enumerate(keys)}
    for _, row in work[work["_key"].isin(keys)].iterrows():
        matrix[year_index[int(row["watch_year"])], key_index[row["_key"]]] += 1

    # Row pitch stays ~0.42 in so a longer rewatch list gets a taller figure.
    fig, ax = plt.subplots(figsize=(10, max(4, len(labels) * 0.42)))
    y = np.arange(len(labels))
    left = np.zeros(len(labels))
    for yi, year in enumerate(years):
        vals = matrix[yi]
        ax.barh(y, vals, left=left, color=colors[year], height=0.72, edgecolor="none")
        left += vals
    ax.set_yticks(y)
    ax.set_yticklabels(labels)
    ax.set_xlabel("Записей в дневнике")
    ax.set_title("Чаще всего в дневнике — цвет = год просмотра")
    ax.xaxis.grid(True, color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    style_axes(ax)
    xmax = float(left.max()) if len(left) else 1.0
    ax.set_xlim(0, xmax * 1.15)
    for yi, total in enumerate(left):
        ax.text(total + xmax * 0.02, yi, str(int(total)), va="center", fontsize=9, color=FG)
    add_watch_year_legend(fig, years, colors, title="Год просмотра")
    fig.tight_layout(rect=[0, 0, 0.88, 1])
    save_dark_figure(fig, path, dpi=160)
    plt.close(fig)
    return True


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) < 1:
        print("Usage: python letterboxd_calendar_charts.py path/to/letterboxd-export.zip")
        return 2
    zip_path = Path(args[0])
    opts = read_chart_options()
    try:
        diary, catalog, watched_only, film_ratings = load_export(
            zip_path,
            date_from=opts.date_from,
            date_to=opts.date_to,
            include_undated=opts.include_undated,
        )
        if opts.has_window and diary.empty:
            print(
                "В выбранном диапазоне нет записей дневника с датой просмотра.",
                file=sys.stderr,
            )
            return 2
        # Date-sensitive charts: diary only (need Watched Date).
        span_start, span_end = resolve_watch_bounds(diary, opts.date_from, opts.date_to)
        grain = watch_time_grain(span_start, span_end)
        chart_weekday_month(diary, Path("views_by_weekday_month.png"))
        chart_views_by_year(
            diary,
            Path("views_by_year.png"),
            grain=grain,
            span_start=span_start,
            span_end=span_end,
        )
        chart_decade_rating(diary, Path("extra_stats_decade_rating.png"))
        made_rating = chart_average_rating_by_year(
            diary, Path("average_rating_by_year.png"), film_ratings=film_ratings, grain=grain
        )
        made_decade_avg = chart_average_rating_by_release_decade(
            diary,
            Path("average_rating_by_release_decade.png"),
            watched_only=watched_only,
            film_ratings=film_ratings,
            catalog=catalog,
        )
        # Monthly pace (not a rescaled views_by_year) — dips/gaps between months.
        made_pace = chart_viewing_pace(
            diary,
            Path("viewing_pace.png"),
            grain=grain,
            span_start=span_start,
            span_end=span_end,
        )
        made_rewatch = chart_top_rewatches(diary, Path("top_rewatches.png"), limit=opts.top_n)
        summary = build_diary_summary(
            diary,
            catalog=catalog,
            watched_only=watched_only,
            film_ratings=film_ratings,
            top_n=opts.top_n,
            min_rated=opts.min_rated,
        )
        summary["date_from"] = opts.date_from or ""
        summary["date_to"] = opts.date_to or ""
        summary["include_undated"] = bool(opts.include_undated and opts.has_window)
        summary["watch_time_grain"] = grain
        year_avgs = release_year_avg_lookup(ratings_for_catalog(catalog, film_ratings))
        made_release_count = chart_release_years_by_count(
            diary,
            Path("watches_by_release_year.png"),
            top_n=opts.top_n,
            avg_by_name=year_avgs,
            min_rated=opts.min_rated,
        )
        made_release_rating = chart_release_years_by_rating(
            summary.get("top_rated_release_years") or [],
            Path("average_rating_by_release_year.png"),
            limit=opts.top_n,
            min_rated=opts.min_rated,
        )
        made_release_worst = chart_release_years_by_rating(
            summary.get("worst_rated_release_years") or [],
            Path("worst_average_rating_by_release_year.png"),
            limit=opts.top_n,
            ascending=True,
            min_rated=opts.min_rated,
        )
        summary["charts"] = {
            "average_rating_by_year": bool(made_rating),
            "average_rating_by_release_decade": bool(made_decade_avg),
            "viewing_pace": bool(made_pace),
            "top_rewatches": bool(made_rewatch),
            "watches_by_release_year": bool(made_release_count),
            "average_rating_by_release_year": bool(made_release_rating),
            "worst_average_rating_by_release_year": bool(made_release_worst),
        }
        Path("diary_summary.json").write_text(
            json.dumps(summary, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except RuntimeError as err:
        print(str(err), file=sys.stderr)
        return 2
    extras = []
    for name in (
        "average_rating_by_year.png",
        "average_rating_by_release_decade.png",
        "viewing_pace.png",
        "top_rewatches.png",
        "watches_by_release_year.png",
        "average_rating_by_release_year.png",
        "worst_average_rating_by_release_year.png",
    ):
        if Path(name).is_file():
            extras.append(name)
    extra_s = (", " + ", ".join(extras)) if extras else ""
    only_n = int(summary.get("watched_only_films") or 0)
    print(
        "Готово: views_by_weekday_month.png, views_by_year.png, "
        f"extra_stats_decade_rating.png{extra_s}, diary_summary.json"
        f" (watched-only films: {only_n})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
