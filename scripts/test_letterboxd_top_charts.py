"""Smoke tests for count / rating top chart helpers."""

from __future__ import annotations

from pathlib import Path

import pandas as pd

import numpy as np

from letterboxd_palette import (
    FG,
    RATING_VMAX,
    RATING_VMIN,
    rating_color,
    rating_colormap,
    watch_year_palette,
)
from PIL import Image

from letterboxd_options import TOP_N_MAX, TOP_N_MIN, clamp_top_n
from letterboxd_top_charts import (
    TOP_N_DEFAULT,
    chart_rating_hbar,
    chart_rating_vbar,
    chart_release_years_by_count,
    chart_release_years_by_rating,
    chart_stacked_count_hbar,
    count_avg_text_style,
    display_lang,
)


def test_display_lang():
    assert display_lang("en") == "английский"
    assert display_lang("XX") == "xx"


def test_top_n_default_about_20():
    assert TOP_N_DEFAULT == 20
    assert TOP_N_MIN == 1
    assert TOP_N_MAX == 100
    assert clamp_top_n("100") == 100
    assert clamp_top_n("9999") == 100
    assert clamp_top_n("0") == 1


def test_ranked_hbar_grows_taller_with_n(tmp_path: Path | None = None) -> None:
    """100 rows keep the same pitch as 20: the PNG gets taller, type is not crammed."""
    out = Path(tmp_path) if tmp_path is not None else Path("/tmp/lb-top-charts-test")
    out.mkdir(parents=True, exist_ok=True)
    palette = {2020: "#4C78A8"}

    def stacked(n: int, path: Path) -> None:
        labels = [f"Film {i}" for i in range(n)]
        matrix = np.ones((1, n))
        assert chart_stacked_count_hbar(labels, [2020], matrix, palette, path, title="Топ") is True

    p20 = out / "count-20.png"
    p100 = out / "count-100.png"
    stacked(20, p20)
    stacked(100, p100)
    h20 = Image.open(p20).height
    h100 = Image.open(p100).height
    assert h100 > h20 * 3.5

    def rated(n: int, path: Path) -> None:
        rows = [{"name": f"Name {i}", "avg": 3.5, "rated": 4} for i in range(n)]
        assert chart_rating_hbar(rows, path, title="Средние", limit=n) is True

    r20 = out / "rating-20.png"
    r100 = out / "rating-100.png"
    rated(20, r20)
    rated(100, r100)
    assert Image.open(r100).height > Image.open(r20).height * 3.5


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


def _rgba(color):
    import matplotlib.colors as mcolors

    return mcolors.to_rgba(color)


def test_count_avg_text_style_colors_mean_only():
    low = count_avg_text_style("1.94")
    high = count_avg_text_style("4.80")
    dash = count_avg_text_style("—")
    assert low["fontweight"] == "bold"
    assert high["fontweight"] == "bold"
    assert dash["fontweight"] == "normal"
    assert _rgba(low["color"]) == _rgba(rating_color(1.94))
    assert _rgba(high["color"]) == _rgba(rating_color(4.80))
    assert _rgba(dash["color"]) == _rgba(FG)
    assert low["path_effects"] and high["path_effects"]
    assert dash["path_effects"] is None
    # Same ends as the rating charts: low is bluer, high is redder.
    assert low["color"][2] > low["color"][0]
    assert high["color"][0] > high["color"][2]
    assert high["color"][0] > low["color"][0]


def test_count_bars_drop_n_and_style_mean(tmp_path: Path | None = None):
    """Count stays regular white; mean is bold and rating-colored; no n=."""
    import letterboxd_top_charts as charts

    out = Path(tmp_path) if tmp_path is not None else Path("/tmp/lb-count-avg-label")
    out.mkdir(parents=True, exist_ok=True)
    path = out / "watches_by_release_year.png"
    labels = ["1978", "1994", "2005", "2019"]
    years = [2022, 2023, 2024]
    palette = watch_year_palette(years)
    # Column totals: 3, 21, 9, 8
    matrix = np.array(
        [
            [1, 8, 3, 2],
            [1, 7, 4, 3],
            [1, 6, 2, 3],
        ],
        dtype=float,
    )
    avg_labels = ["—", "1.94", "3.40", "4.80"]
    captured: dict = {}
    real_save = charts.save_dark_figure

    def grab(fig, dest, **kwargs):
        captured["texts"] = [t for ax in fig.axes for t in ax.texts]
        real_save(fig, dest, **kwargs)

    charts.save_dark_figure = grab
    try:
        assert (
            chart_stacked_count_hbar(
                labels,
                years,
                matrix,
                palette,
                path,
                title="Годы выхода — больше просмотров (цвет = год просмотра)",
                avg_labels=avg_labels,
            )
            is True
        )
    finally:
        charts.save_dark_figure = real_save
    assert path.is_file() and path.stat().st_size > 0
    grouped: dict[str, list] = {}
    for text in captured["texts"]:
        grouped.setdefault(text.get_text(), []).append(text)
    assert all("n=" not in key for key in grouped)
    assert set(grouped) >= {"3", "21", "9", "8", "—", "1.94", "3.40", "4.80"}
    for count in ("3", "21", "9", "8"):
        for text in grouped[count]:
            assert text.get_fontweight() == "normal"
            assert _rgba(text.get_color()) == _rgba(FG)
    for mean, value in (("1.94", 1.94), ("3.40", 3.40), ("4.80", 4.80)):
        text = grouped[mean][0]
        assert text.get_fontweight() == "bold"
        assert _rgba(text.get_color()) == _rgba(rating_color(value))
        assert text.get_path_effects()
    dash = grouped["—"][0]
    assert dash.get_fontweight() == "normal"
    assert _rgba(dash.get_color()) == _rgba(FG)
    assert not dash.get_path_effects()


def test_release_year_count_label_omits_n(tmp_path: Path | None = None):
    import letterboxd_top_charts as charts

    out = Path(tmp_path) if tmp_path is not None else Path("/tmp/lb-count-avg-label")
    out.mkdir(parents=True, exist_ok=True)
    path = out / "release_years_avg.png"
    diary = pd.DataFrame(
        {
            "Name": ["A", "B", "C", "D", "E"],
            "Year": [1994, 1994, 1994, 2010, 2010],
            "Watched Date": pd.to_datetime(
                ["2022-01-01", "2023-01-01", "2024-06-01", "2023-03-01", "2024-03-01"]
            ),
        }
    )
    captured: dict = {}
    real_save = charts.save_dark_figure

    def grab(fig, dest, **kwargs):
        captured["texts"] = [t.get_text() for ax in fig.axes for t in ax.texts]
        real_save(fig, dest, **kwargs)

    charts.save_dark_figure = grab
    try:
        assert (
            chart_release_years_by_count(
                diary,
                path,
                top_n=5,
                avg_by_name={"1994": (1.94, 17), "2010": (4.1, 2)},
                min_rated=3,
            )
            is True
        )
    finally:
        charts.save_dark_figure = real_save
    joined = " ".join(captured["texts"])
    assert "n=" not in joined
    assert "1.94" in captured["texts"]
    assert "—" in captured["texts"]


def _texts_on_save(fn):
    import letterboxd_calendar_charts as cal

    captured: dict = {}
    real_save = cal.save_dark_figure

    def grab(fig, dest, **kwargs):
        captured["texts"] = [t for ax in fig.axes for t in ax.texts]
        real_save(fig, dest, **kwargs)

    cal.save_dark_figure = grab
    try:
        fn(cal)
    finally:
        cal.save_dark_figure = real_save
    return captured.get("texts") or []


def test_watch_time_charts_label_every_position(tmp_path: Path | None = None):
    """22 watch years: every bar has its count, every point its bold colored mean."""
    out = Path(tmp_path) if tmp_path is not None else Path("/tmp/lb-watch-time-labels")
    out.mkdir(parents=True, exist_ok=True)
    rows = []
    for i, year in enumerate(range(2005, 2027)):
        for k in range(i + 1):
            rows.append(
                {
                    "Name": f"F{year}-{k}",
                    "Year": 2000,
                    "Rating": 0.5 + ((i + k) % 10) * 0.5,
                    "Watched Date": f"{year}-03-{(k % 27) + 1:02d}",
                }
            )
    diary = pd.DataFrame(rows)
    diary["Watched Date"] = pd.to_datetime(diary["Watched Date"])

    counts = _texts_on_save(
        lambda cal: cal.chart_views_by_year(diary, out / "views_by_year.png")
    )
    assert [t.get_text() for t in counts] == [str(i + 1) for i in range(22)]
    for text in counts:
        assert _rgba(text.get_color()) == _rgba(FG)
        assert text.get_fontweight() == "normal"

    means = _texts_on_save(
        lambda cal: cal.chart_average_rating_by_year(diary, out / "average_rating_by_year.png")
    )
    assert len(means) == 22
    for text in means:
        value = float(text.get_text())
        assert "n=" not in text.get_text()
        assert text.get_fontweight() == "bold"
        assert _rgba(text.get_color()) == _rgba(rating_color(value))
        assert text.get_path_effects()


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
    test_ranked_hbar_grows_taller_with_n()
    test_rating_colormap_is_blue_green_red()
    test_rating_color_fixed_scale_separates_high_band()
    test_release_year_charts()
    test_rating_vbar_skips_bad_avg()
    test_rating_hbar_with_in_bar_labels()
    test_rating_hbar_worst_ascending()
    test_rating_hbar_long_names_no_overlap()
    test_rating_hbar_worst_skips_short_slate()
    test_watches_by_genre_stacked_count()
    test_count_avg_text_style_colors_mean_only()
    test_count_bars_drop_n_and_style_mean()
    test_release_year_count_label_omits_n()
    test_watch_time_charts_label_every_position()
    test_stacked_count_hbar_long_names()
    print("ok")