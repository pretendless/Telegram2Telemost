"""Smoke tests for count / rating top chart helpers."""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from letterboxd_palette import rating_color
from letterboxd_top_charts import (
    chart_rating_hbar,
    chart_release_years_by_count,
    chart_release_years_by_rating,
    display_lang,
)


def test_display_lang():
    assert display_lang("en") == "английский"
    assert display_lang("XX") == "xx"


def test_rating_color_warmer_is_higher_end():
    cool = rating_color(2.0)
    warm = rating_color(5.0)
    # coolwarm: low → blue-ish (higher B), high → red-ish (higher R)
    assert cool[2] > cool[0]
    assert warm[0] > warm[2]


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
    rows = [
        {"year": 1999, "avg": 4.5, "rated": 8},
        {"year": 2010, "avg": 3.2, "rated": 5},
    ]
    assert chart_release_years_by_rating(rows, rating_path) is True
    assert rating_path.is_file() and rating_path.stat().st_size > 0

    # Gate: empty after threshold → no chart
    empty = out / "empty_rating.png"
    assert chart_release_years_by_rating([], empty) is False
    assert not empty.exists()


def test_rating_hbar_skips_bad_avg(tmp_path: Path | None = None):
    out = Path(tmp_path) if tmp_path is not None else Path("/tmp/lb-top-charts-test")
    out.mkdir(parents=True, exist_ok=True)
    path = out / "directors_rating.png"
    assert (
        chart_rating_hbar(
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


if __name__ == "__main__":
    test_display_lang()
    test_rating_color_warmer_is_higher_end()
    test_release_year_charts()
    test_rating_hbar_skips_bad_avg()
    print("ok")
