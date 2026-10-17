#!/usr/bin/env python3
"""Smoke tests for diary ∪ watched catalog + ratings.csv merge."""

from __future__ import annotations

import json
import os
import tempfile
import zipfile
from pathlib import Path

from letterboxd_calendar_charts import build_diary_summary, main as cal_main
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


def test_union_and_ratings_csv(tmp: Path) -> None:
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
    # ratings.csv wins over diary for Shared Film (1.0 vs diary latest 4.5).
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

    # ratings.csv primary: Shared Film = 1.0 (not diary 4.5); Watched Only from ratings.
    rated = film_ratings
    by_name = {r["Name"]: float(r["Rating"]) for _, r in rated.iterrows()}
    assert by_name["Shared Film"] == 1.0, by_name
    assert by_name["Watched Only"] == 5.0
    assert by_name["Diary Only"] == 4.0
    assert "Watched Unrated" not in by_name

    summary = build_diary_summary(
        diary, catalog=catalog, watched_only=only, film_ratings=film_ratings
    )
    assert summary["unique_films"] == 4
    assert summary["watched_only_films"] == 2
    assert summary["rated_count"] == 3  # all three have ratings.csv entries in catalog
    assert summary["peak_year"] == 2024

    os.chdir(tmp)
    rc = cal_main([str(zip_path)])
    assert rc == 0, rc
    data = json.loads((tmp / "diary_summary.json").read_text(encoding="utf-8"))
    assert data["unique_films"] == 4
    assert data["rated_count"] == 3


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
    # Diary latest 5.0 as fallback.
    assert len(film_ratings) == 1
    assert float(film_ratings.iloc[0]["Rating"]) == 5.0
    assert build_diary_summary(
        diary, catalog=catalog, watched_only=only, film_ratings=film_ratings
    )["unique_films"] == 1


def test_ratings_csv_wins_over_diary() -> None:
    diary = __import__("pandas").DataFrame(
        [
            {
                "Name": "X",
                "Year": 2000,
                "Rating": 5.0,
                "Watched Date": __import__("pandas").Timestamp("2024-01-01"),
            }
        ]
    )
    ratings = __import__("pandas").DataFrame(
        [{"Name": "X", "Year": 2000, "Rating": 2.0, "source": "ratings"}]
    )
    merged = merged_film_ratings(ratings, diary)
    assert len(merged) == 1
    assert float(merged.iloc[0]["Rating"]) == 2.0
    # Compatibility wrapper.
    assert float(latest_rated_union(diary, None, ratings=ratings).iloc[0]["Rating"]) == 2.0


def main() -> int:
    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        os.chdir(tmp)
        test_union_and_ratings_csv(tmp)
        test_diary_fallback_when_no_ratings_csv(tmp)
        test_ratings_csv_wins_over_diary()
    print("test_letterboxd_export: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
