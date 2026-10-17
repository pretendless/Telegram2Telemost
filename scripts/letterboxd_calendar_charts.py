#!/usr/bin/env python3
"""Extra Letterboxd diary charts (no TMDB).

Usage:
  python letterboxd_calendar_charts.py path/to/letterboxd-export.zip

Writes into the current working directory:
  views_by_weekday_month.png
  views_by_year.png
  extra_stats_decade_rating.png
"""

from __future__ import annotations

import sys
import zipfile
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]
MONTHS = ["Янв", "Фев", "Мар", "Апр", "Май", "Июн", "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек"]
RATING_BINS = [round(x * 0.5, 1) for x in range(1, 11)]  # 0.5 … 5.0


def load_diary(zip_path: Path) -> pd.DataFrame:
    if not zip_path.is_file():
        raise RuntimeError("ZIP-файл не найден.")
    try:
        with zipfile.ZipFile(zip_path) as zf:
            names = zf.namelist()
            diary_name = next((n for n in names if n.lower().endswith("diary.csv")), None)
            if not diary_name:
                raise RuntimeError("В ZIP не найден diary.csv")
            with zf.open(diary_name) as f:
                df = pd.read_csv(f)
    except zipfile.BadZipFile as err:
        raise RuntimeError("Файл не похож на ZIP Letterboxd.") from err
    if "Watched Date" not in df.columns:
        raise RuntimeError("В diary.csv нет колонки Watched Date")
    df["Watched Date"] = pd.to_datetime(df["Watched Date"], errors="coerce")
    df = df[df["Watched Date"].notna()].copy()
    if df.empty:
        raise RuntimeError("diary.csv не содержит дат просмотра.")
    if "Year" in df.columns:
        df["Year"] = pd.to_numeric(df["Year"], errors="coerce")
    else:
        df["Year"] = np.nan
    if "Rating" in df.columns:
        df["Rating"] = pd.to_numeric(df["Rating"], errors="coerce")
    else:
        df["Rating"] = np.nan
    return df


def year_colors(years: list[int]):
    if not years:
        return {}
    cmap = plt.cm.turbo
    if len(years) == 1:
        return {years[0]: cmap(0.55)}
    return {y: cmap(i / (len(years) - 1)) for i, y in enumerate(years)}


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
    ax.yaxis.grid(True, color="#dddddd", linewidth=0.8)
    ax.set_axisbelow(True)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)


def add_watch_year_legend(fig, years: list[int], colors: dict, title: str = "Год"):
    handles = [plt.Rectangle((0, 0), 1, 1, color=colors[y]) for y in years]
    fig.legend(
        handles,
        [str(y) for y in years],
        title=title,
        loc="center left",
        bbox_to_anchor=(0.92, 0.5),
        frameon=False,
        fontsize=8,
        title_fontsize=9,
    )


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
    fig.savefig(path, bbox_inches="tight", dpi=160)
    plt.close(fig)


def chart_views_by_year(df: pd.DataFrame, path: Path) -> None:
    years = df["Watched Date"].dt.year.dropna().astype(int)
    counts = years.value_counts().sort_index()
    labels = counts.index.tolist()
    values = counts.values.astype(int)

    fig, ax = plt.subplots(figsize=(12, 6))
    x = np.arange(len(labels))
    bars = ax.bar(x, values, color="#4C78A8", width=0.8)
    ax.set_title("Количество просмотров фильмов по годам")
    ax.set_xlabel("Год просмотра")
    ax.set_ylabel("Количество записей о просмотрах")
    ax.set_xticks(x)
    ax.set_xticklabels([str(y) for y in labels], rotation=45, ha="right")
    ax.yaxis.grid(True, color="#dddddd", linewidth=0.8)
    ax.set_axisbelow(True)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ymax = max(values) if len(values) else 1
    ax.set_ylim(0, ymax * 1.12)
    for bar, value in zip(bars, values):
        ax.text(
            bar.get_x() + bar.get_width() / 2,
            bar.get_height() + ymax * 0.015,
            str(int(value)),
            ha="center",
            va="bottom",
            fontsize=8,
        )
    fig.tight_layout()
    fig.savefig(path, bbox_inches="tight", dpi=160)
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
    fig.savefig(path, bbox_inches="tight", dpi=160)
    plt.close(fig)


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) < 1:
        print("Usage: python letterboxd_calendar_charts.py path/to/letterboxd-export.zip")
        return 2
    zip_path = Path(args[0])
    try:
        diary = load_diary(zip_path)
        chart_weekday_month(diary, Path("views_by_weekday_month.png"))
        chart_views_by_year(diary, Path("views_by_year.png"))
        chart_decade_rating(diary, Path("extra_stats_decade_rating.png"))
    except RuntimeError as err:
        print(str(err), file=sys.stderr)
        return 2
    print(
        "Готово: views_by_weekday_month.png, views_by_year.png, extra_stats_decade_rating.png"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
