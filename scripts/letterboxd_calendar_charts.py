#!/usr/bin/env python3
"""Extra Letterboxd diary charts (no TMDB): weekday/month stacks + views by year.

Usage:
  python letterboxd_calendar_charts.py path/to/letterboxd-export.zip

Writes into the current working directory:
  views_by_weekday_month.png
  views_by_year.png
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
    return df


def year_colors(years: list[int]):
    if not years:
        return {}
    cmap = plt.cm.turbo
    if len(years) == 1:
        return {years[0]: cmap(0.55)}
    return {y: cmap(i / (len(years) - 1)) for i, y in enumerate(years)}


def stacked_counts(ax, categories: list[str], years: list[int], matrix: np.ndarray, colors: dict):
    """matrix shape: (len(years), len(categories))"""
    bottom = np.zeros(len(categories))
    x = np.arange(len(categories))
    for yi, year in enumerate(years):
        vals = matrix[yi]
        ax.bar(x, vals, bottom=bottom, color=colors[year], width=0.82, edgecolor="none")
        bottom += vals
    ax.set_xticks(x)
    ax.set_xticklabels(categories)
    ax.set_ylabel("Количество записей о просмотрах")
    ax.yaxis.grid(True, color="#dddddd", linewidth=0.8)
    ax.set_axisbelow(True)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)


def chart_weekday_month(df: pd.DataFrame, path: Path) -> None:
    df = df.copy()
    df["year"] = df["Watched Date"].dt.year.astype(int)
    # pandas: Monday=0 … Sunday=6 — matches Пн…Вс
    df["weekday"] = df["Watched Date"].dt.weekday
    df["month"] = df["Watched Date"].dt.month  # 1..12

    years = sorted(df["year"].unique().tolist())
    colors = year_colors(years)

    week = np.zeros((len(years), 7), dtype=float)
    month = np.zeros((len(years), 12), dtype=float)
    year_index = {y: i for i, y in enumerate(years)}
    for _, row in df.iterrows():
        yi = year_index[int(row["year"])]
        week[yi, int(row["weekday"])] += 1
        month[yi, int(row["month"]) - 1] += 1

    fig, axes = plt.subplots(2, 1, figsize=(14, 10), sharey=False)
    fig.suptitle(
        "Распределение просмотров по дням недели и месяцам с разбивкой по годам",
        fontsize=14,
        y=0.98,
    )

    stacked_counts(axes[0], WEEKDAYS, years, week, colors)
    axes[0].set_title("Просмотры по дням недели — состав по годам")

    stacked_counts(axes[1], MONTHS, years, month, colors)
    axes[1].set_title("Просмотры по месяцам — состав по годам")

    handles = [
        plt.Rectangle((0, 0), 1, 1, color=colors[y]) for y in years
    ]
    fig.legend(
        handles,
        [str(y) for y in years],
        title="Год",
        loc="center left",
        bbox_to_anchor=(0.92, 0.5),
        frameon=False,
        fontsize=8,
        title_fontsize=9,
    )
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
    except RuntimeError as err:
        print(str(err), file=sys.stderr)
        return 2
    print("Готово: views_by_weekday_month.png, views_by_year.png")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
