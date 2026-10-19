#!/usr/bin/env python3
"""Smoke tests for diary ∪ watched catalog + ratings.csv merge."""

from __future__ import annotations

import json
import os
import tempfile
import zipfile
from pathlib import Path

import pandas as pd

from letterboxd_calendar_charts import (
    build_diary_summary,
    format_ru_calendar_date,
    main as cal_main,
)
from letterboxd_export import latest_rated_union, load_export, load_ratings, merged_film_ratings


def _write_zip(
    path: Path,
    diary: str,
    watched: str | None = None,
    ratings: str | None = None,
) -> None:
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("diary.csv", diary)
        if watched is not None:
            zf.writestr("watched.csv", watched)
        if ratings is not None:
            zf.writestr("ratings.csv", ratings)


def test_union_and_diary_wins(tmp: Path) -> None:
    diary_csv = """Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date
2024-01-02,Diary Only,2020,https://boxd.it/aaa,4.0,,,2024-01-01
2024-01-03,Shared Film,2019,https://boxd.it/shared,3.0,,,2024-01-02
2024-06-01,Shared Film,2019,https://boxd.it/shared,4.5,Yes,,2024-06-01
"""
    watched_csv = """Date,Name,Year,Letterboxd URI
2020-01-01,Watched Only,2018,https://boxd.it/film1
2020-01-01,Shared Film,2019,https://boxd.it/film2
2020-01-01,Watched Unrated,2017,https://boxd.it/film3
"""
    # ratings.csv must NOT override diary latest for Shared Film (4.5).
    ratings_csv = """Date,Name,Year,Letterboxd URI,Rating
2020-01-01,Watched Only,2018,https://boxd.it/film1,5.0
2020-01-01,Shared Film,2019,https://boxd.it/film2,1.0
2020-01-01,Diary Only,2020,https://boxd.it/aaa,4.0
"""
    zip_path = tmp / "export.zip"
    _write_zip(zip_path, diary_csv, watched_csv, ratings_csv)

    diary, catalog, only, film_ratings = load_export(zip_path)
    assert len(diary) == 3, len(diary)
    assert set(only["Name"]) == {"Watched Only", "Watched Unrated"}
    assert len(catalog) == 5, len(catalog)

    rated = film_ratings
    by_name = {r["Name"]: (float(r["Rating"]), r.get("source")) for _, r in rated.iterrows()}
    assert by_name["Shared Film"][0] == 4.5, by_name  # diary latest, not ratings 1.0
    assert by_name["Shared Film"][1] == "diary"
    assert by_name["Watched Only"] == (5.0, "ratings")  # no diary rating → ratings.csv
    assert by_name["Diary Only"][0] == 4.0
    assert "Watched Unrated" not in by_name

    summary = build_diary_summary(
        diary, catalog=catalog, watched_only=only, film_ratings=film_ratings
    )
    assert summary["unique_films"] == 4
    assert summary["watched_only_films"] == 2
    assert summary["rated_count"] == 3
    assert summary["peak_year"] == 2024
    assert summary["peak_day_count"] == 1
    assert summary["peak_day_label"]  # Russian calendar date present

    os.chdir(tmp)
    rc = cal_main([str(zip_path)])
    assert rc == 0, rc
    data = json.loads((tmp / "diary_summary.json").read_text(encoding="utf-8"))
    assert data["unique_films"] == 4
    assert data["rated_count"] == 3


def test_peak_viewing_day_from_diary() -> None:
    """Peak day = calendar date with most diary Watched Date rows (Russian label)."""
    diary = pd.DataFrame(
        [
            {"Name": "A", "Year": 2020, "Rating": 4.0, "Watched Date": "2021-03-15"},
            {"Name": "B", "Year": 2019, "Rating": 3.0, "Watched Date": "2021-03-15"},
            {"Name": "C", "Year": 2018, "Rating": 5.0, "Watched Date": "2021-03-15"},
            {"Name": "D", "Year": 2017, "Rating": 2.0, "Watched Date": "2021-01-01"},
        ]
    )
    diary["Watched Date"] = pd.to_datetime(diary["Watched Date"])
    summary = build_diary_summary(diary, catalog=diary, watched_only=diary.iloc[0:0].copy())
    assert summary["peak_day"] == "2021-03-15"
    assert summary["peak_day_count"] == 3
    assert summary["peak_day_label"] == "15 марта 2021"
    assert format_ru_calendar_date(pd.Timestamp("2021-03-15")) == "15 марта 2021"


def test_diary_latest_beats_older_diary_and_ratings_csv() -> None:
    """Ocean's-style: diary 4.5 then 3.0 + ratings.csv 4.5 → effective 3.0."""
    diary = pd.DataFrame(
        [
            {
                "Name": "Ocean's Eleven",
                "Year": 2001,
                "Rating": 4.5,
                "Watched Date": pd.Timestamp("2013-02-12"),
            },
            {
                "Name": "Ocean's Eleven",
                "Year": 2001,
                "Rating": 3.0,
                "Watched Date": pd.Timestamp("2016-02-12"),
            },
        ]
    )
    ratings = pd.DataFrame(
        [{"Name": "Ocean's Eleven", "Year": 2001, "Rating": 4.5, "source": "ratings"}]
    )
    merged = merged_film_ratings(ratings, diary)
    assert len(merged) == 1
    assert float(merged.iloc[0]["Rating"]) == 3.0
    assert merged.iloc[0]["source"] == "diary"
    assert float(latest_rated_union(diary, None, ratings=ratings).iloc[0]["Rating"]) == 3.0


def test_diary_wins_over_ratings_csv() -> None:
    diary = pd.DataFrame(
        [
            {
                "Name": "X",
                "Year": 2000,
                "Rating": 5.0,
                "Watched Date": pd.Timestamp("2024-01-01"),
            }
        ]
    )
    ratings = pd.DataFrame([{"Name": "X", "Year": 2000, "Rating": 2.0, "source": "ratings"}])
    merged = merged_film_ratings(ratings, diary)
    assert len(merged) == 1
    assert float(merged.iloc[0]["Rating"]) == 5.0
    assert merged.iloc[0]["source"] == "diary"


def test_diary_fallback_when_no_ratings_csv(tmp: Path) -> None:
    diary_csv = """Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date
2024-01-02,A,2020,https://boxd.it/a,4.0,,,2024-01-01
2024-02-01,A,2020,https://boxd.it/a2,5.0,Yes,,2024-02-01
"""
    zip_path = tmp / "diary-only.zip"
    _write_zip(zip_path, diary_csv, None, None)
    diary, catalog, only, film_ratings = load_export(zip_path)
    assert len(only) == 0
    assert len(load_ratings(zip_path)) == 0
    assert len(film_ratings) == 1
    assert float(film_ratings.iloc[0]["Rating"]) == 5.0
    assert (
        build_diary_summary(
            diary, catalog=catalog, watched_only=only, film_ratings=film_ratings
        )["unique_films"]
        == 1
    )


def main() -> int:
    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        os.chdir(tmp)
        test_union_and_diary_wins(tmp)
        test_peak_viewing_day_from_diary()
        test_diary_latest_beats_older_diary_and_ratings_csv()
        test_diary_wins_over_ratings_csv()
        test_diary_fallback_when_no_ratings_csv(tmp)
    print("test_letterboxd_export: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
