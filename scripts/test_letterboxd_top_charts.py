"""Smoke tests for count / rating top chart helpers."""

from __future__ import annotations

from pathlib import Path

import pandas as pd

import numpy as np

from letterboxd_palette import (
    RATING_VMAX,
    RATING_VMIN,
    rating_color,
    rating_colormap,
    watch_year_palette,
)
from letterboxd_top_charts import (
    TOP_N_DEFAULT,
    chart_rating_hbar,
    chart_rating_vbar,
    chart_release_years_by_count,
    chart_release_years_by_rating,
    chart_stacked_count_hbar,
    display_lang,
)


def test_display_lang():
    assert display_lang("en") == "английский"
    assert display_lang("XX") == "xx"


def test_top_n_default_about_20():
    assert TOP_N_DEFAULT == 20


def test_rating_colormap_is_blue_green_red():
    cmap = rating_colormap()
    low = cmap(0.0)
    mid = cmap(0.5)
    high = cmap(1.0)
    # low: blue dominates red
    assert low[2] > low[0]
    # mid: green dominates
    assert mid[1] > mid[0] and mid[1] > mid[2]
    # high: red dominates blue
    assert high[0] > high[2]
    # not a pale peach mid (coolwarm mid ≈ white/cream)
    assert not (mid[0] > 0.85 and mid[1] > 0.85 and mid[2] > 0.85)


def test_rating_color_fixed_scale_separates_high_band():
    """3.6 vs 4.5 must not collapse into the same flesh band."""
    a = rating_color(3.6, vmin=RATING_VMIN, vmax=RATING_VMAX)
    b = rating_color(4.5, vmin=RATING_VMIN, vmax=RATING_VMAX)
    # Distinct colors
    dist = sum(abs(x - y) for x, y in zip(a[:3], b[:3]))
    assert dist > 0.15
    # Higher rating redder
    assert b[0] >= a[0]


def test_release_year_charts(tmp_path: Path | None = None):
    out = Path(tmp_path) if tmp_path is not None else Path("/tmp/lb-top-charts-test")
    out.mkdir(parents=True, exist_ok=True)
    diary = pd.DataFrame(
        {
            "Name": ["A", "B", "C", "A", "D"],
            "Year": [1999, 1999, 2010, 1999, 2010],
            "Watched Date": pd.to_datetime(
                ["2020-01-01", "2021-01-01", "2021-06-01", "2022-01-01", "2020-03-01"]
            ),
        }
    )
    count_path = out / "watches_by_release_year.png"
    assert chart_release_years_by_count(diary, count_path, top_n=5) is True
    assert count_path.is_file() and count_path.stat().st_size > 0

    rating_path = out / "average_rating_by_release_year.png"
    # Full top-M slate so anti-rating path can also be exercised.
    rows = [
        {"year": 2000 + i, "avg": round(4.5 - i * 0.05, 2), "rated": 5 + (i % 4)}
        for i in range(TOP_N_DEFAULT)
    ]
    assert chart_release_years_by_rating(rows, rating_path) is True
    assert rating_path.is_file() and rating_path.stat().st_size > 0

    worst_path = out / "worst_average_rating_by_release_year.png"
    assert chart_release_years_by_rating(rows, worst_path, ascending=True) is True
    assert worst_path.is_file() and worst_path.stat().st_size > 0

    empty = out / "empty_rating.png"
    assert chart_release_years_by_rating([], empty) is False
    assert not empty.exists()


def test_rating_vbar_skips_bad_avg(tmp_path: Path | None = None):
    out = Path(tmp_path) if tmp_path is not None else Path("/tmp/lb-top-charts-test")
    out.mkdir(parents=True, exist_ok=True)
    path = out / "directors_rating.png"
    assert (
        chart_rating_vbar(
            [
                {"name": "Good", "avg": 4.1, "rated": 6},
                {"name": "Bad", "avg": None, "rated": 4},
            ],
            path,
            title="Режиссёры — выше оценка",
        )
        is True
    )
    assert path.is_file()


def test_rating_hbar_with_in_bar_labels(tmp_path: Path | None = None):
    out = Path(tmp_path) if tmp_path is not None else Path("/tmp/lb-top-charts-test")
    out.mkdir(parents=True, exist_ok=True)
    path = out / "actors_hbar.png"
    assert (
        chart_rating_hbar(
            [
                {"name": "High", "avg": 4.5, "rated": 8},
                {"name": "Low", "avg": 2.1, "rated": 5},
                {"name": "Mid", "avg": 3.0, "rated": 6},
            ],
            path,
            title="Актёры — выше оценка",
            ascending=False,
            limit=20,
        )
        is True
    )
    assert path.is_file() and path.stat().st_size > 0


def test_rating_hbar_worst_ascending(tmp_path: Path | None = None):
    out = Path(tmp_path) if tmp_path is not None else Path("/tmp/lb-top-charts-test")
    out.mkdir(parents=True, exist_ok=True)
    path = out / "actors_worst_hbar.png"
    # Full top-M slate required for anti-rating charts.
    rows = [
        {"name": f"E{i}", "avg": 1.0 + (i % 10) * 0.1, "rated": 4 + (i % 3)}
        for i in range(TOP_N_DEFAULT)
    ]
    assert (
        chart_rating_hbar(
            rows,
            path,
            title="Актёры — ниже оценка",
            ascending=True,
            limit=TOP_N_DEFAULT,
        )
        is True
    )
    assert path.is_file() and path.stat().st_size > 0


def test_rating_hbar_long_names_no_overlap(tmp_path: Path | None = None):
    """Long studio-style names + short bars: chart still builds (stats outside bar)."""
    out = Path(tmp_path) if tmp_path is not None else Path("/tmp/lb-top-charts-test")
    out.mkdir(parents=True, exist_ok=True)
    path = out / "studios_worst_long.png"
    names = [
        "Bazelevs",
        "Columbia Pictures",
        "Robert Simonds Productions",
        "Happy Madison Productions",
        "Sidney Kimmel Entertainment",
        "Gary Sanchez Productions",
        "FilmNation Entertainment",
        "Twentieth Century Fox",
        "Warner Bros. Pictures",
        "Universal Pictures",
        "Paramount Pictures",
        "Lionsgate Films",
        "New Line Cinema",
        "Miramax Films",
        "Focus Features",
        "A24 Films",
        "Blumhouse Productions",
        "Legendary Pictures",
        "Working Title Films",
        "StudioCanal",
    ]
    rows = [
        {"name": names[i], "avg": 1.5 + i * 0.04, "rated": 4 + (i % 5)}
        for i in range(TOP_N_DEFAULT)
    ]
    assert chart_rating_hbar(rows, path, title="Студии — ниже оценка", ascending=True) is True
    assert path.is_file() and path.stat().st_size > 0




def test_watches_by_genre_stacked_count(tmp_path: Path | None = None):
    """Genre count top uses same watch-year stacked helper as countries/actors."""
    from letterboxd_top_charts import chart_diary_entity_stacked

    out = Path(tmp_path) if tmp_path is not None else Path("/tmp/lb-top-charts-test")
    out.mkdir(parents=True, exist_ok=True)
    path = out / "watches_by_genre.png"
    diary = pd.DataFrame(
        [
            {"Name": "A", "Year": 2020, "Watched Date": "2021-01-01", "Genre list": ["Drama", "Crime"]},
            {"Name": "B", "Year": 2019, "Watched Date": "2021-06-01", "Genre list": ["Drama"]},
            {"Name": "C", "Year": 2018, "Watched Date": "2022-01-01", "Genre list": ["Comedy", "Drama"]},
            {"Name": "D", "Year": 2017, "Watched Date": "2022-03-01", "Genre list": ["Action"]},
            {"Name": "E", "Year": 2016, "Watched Date": "2022-06-01", "Genre list": ["Drama", "Action"]},
            {"Name": "F", "Year": 2015, "Watched Date": "2023-01-01", "Genre list": ["Comedy"]},
        ]
    )
    diary["Watched Date"] = pd.to_datetime(diary["Watched Date"])
    assert (
        chart_diary_entity_stacked(
            diary,
            path,
            names_for_row=lambda row: list(row.get("Genre list") or []),
            title="Жанры — цвет = год просмотра",
            top_n=TOP_N_DEFAULT,
            footer="Source: Letterboxd diary + TMDB metadata",
        )
        is True
    )
    assert path.is_file() and path.stat().st_size > 0


def test_stacked_count_hbar_long_names(tmp_path: Path | None = None):
    """Count tops: long y-labels still render on a roomier canvas."""
    out = Path(tmp_path) if tmp_path is not None else Path("/tmp/lb-top-charts-test")
    out.mkdir(parents=True, exist_ok=True)
    path = out / "watches_by_director_long.png"
    labels = [
        "Christopher Nolan",
        "Quentin Tarantino",
        "Wes Anderson",
        "Denis Villeneuve",
        "Guillermo del Toro",
        "Alfonso Cuarón",
        "Alejandro González Iñárritu",
        "Park Chan-wook",
        "Bong Joon-ho",
        "Yorgos Lanthimos",
    ]
    years = [2020, 2021, 2022]
    palette = watch_year_palette(years)
    matrix = np.array(
        [
            [3, 2, 1, 4, 2, 1, 2, 3, 1, 2],
            [1, 3, 2, 1, 3, 2, 1, 1, 2, 1],
            [2, 1, 3, 2, 1, 3, 2, 2, 3, 2],
        ],
        dtype=float,
    )
    assert (
        chart_stacked_count_hbar(
            labels,
            years,
            matrix,
            palette,
            path,
            title="Режиссёры — цвет = год просмотра",
            footer="Source: Letterboxd diary/watched + TMDB metadata",
        )
        is True
    )
    assert path.is_file() and path.stat().st_size > 0

def test_rating_hbar_worst_skips_short_slate(tmp_path: Path | None = None):
    out = Path(tmp_path) if tmp_path is not None else Path("/tmp/lb-top-charts-test")
    out.mkdir(parents=True, exist_ok=True)
    path = out / "actors_worst_short.png"
    assert (
        chart_rating_hbar(
            [
                {"name": "High", "avg": 4.5, "rated": 8},
                {"name": "Low", "avg": 2.1, "rated": 5},
            ],
            path,
            title="Актёры — ниже оценка",
            ascending=True,
            limit=TOP_N_DEFAULT,
        )
        is False
    )
    assert not path.is_file()


if __name__ == "__main__":
    test_display_lang()
    test_top_n_default_about_20()
    test_rating_colormap_is_blue_green_red()
    test_rating_color_fixed_scale_separates_high_band()
    test_release_year_charts()
    test_rating_vbar_skips_bad_avg()
    test_rating_hbar_with_in_bar_labels()
    test_rating_hbar_worst_ascending()
    test_rating_hbar_long_names_no_overlap()
    test_rating_hbar_worst_skips_short_slate()
    test_watches_by_genre_stacked_count()
    test_stacked_count_hbar_long_names()
    print("ok")