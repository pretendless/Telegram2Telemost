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
    chart_viewing_pace,
    diary_rating_means_by_watch_year,
    format_ru_calendar_date,
    resolve_watch_bounds,
    viewing_pace_stats,
    watch_time_grain,
    main as cal_main,
)
from letterboxd_export import (
    latest_rated_union,
    load_export,
    load_ratings,
    merged_film_ratings,
    scope_letterboxd_frames,
)
from letterboxd_genre_charts import _filter_entity_names
from letterboxd_options import format_count_avg_label, is_english_language, is_usa_country


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


def test_watch_year_avg_uses_each_diary_rating() -> None:
    """average_rating_by_year: rewatches contribute to their Watched Date years."""
    diary = pd.DataFrame(
        [
            {
                "Name": "Ocean's Eleven",
                "Year": 2001,
                "Rating": 5.0,
                "Watched Date": pd.Timestamp("2013-02-12"),
            },
            {
                "Name": "Ocean's Eleven",
                "Year": 2001,
                "Rating": 3.0,
                "Watched Date": pd.Timestamp("2016-02-12"),
            },
            {
                "Name": "Other",
                "Year": 1999,
                "Rating": 4.0,
                "Watched Date": pd.Timestamp("2013-06-01"),
            },
        ]
    )
    means = diary_rating_means_by_watch_year(diary)
    assert list(means.index) == [2013, 2016]
    assert means.loc[2013, "count"] == 2  # 5.0 + 4.0, not collapsed
    assert abs(float(means.loc[2013, "mean"]) - 4.5) < 1e-9
    assert means.loc[2016, "count"] == 1
    assert float(means.loc[2016, "mean"]) == 3.0
    # Latest-per-film would put only 2016 (or overwrite); this keeps both years.


def test_viewing_pace_is_monthly_not_yearly() -> None:
    """Pace chart: films/month across calendar months (distinct from views_by_year)."""
    diary = pd.DataFrame(
        [
            {"Name": "A", "Year": 2020, "Rating": 4.0, "Watched Date": "2021-01-05"},
            {"Name": "B", "Year": 2019, "Rating": 3.0, "Watched Date": "2021-01-20"},
            {"Name": "C", "Year": 2018, "Rating": 5.0, "Watched Date": "2021-03-01"},
            {"Name": "D", "Year": 2017, "Rating": 2.0, "Watched Date": "2021-03-15"},
            {"Name": "E", "Year": 2016, "Rating": 4.0, "Watched Date": "2021-03-20"},
        ]
    )
    diary["Watched Date"] = pd.to_datetime(diary["Watched Date"])
    stats = viewing_pace_stats(diary)
    # Jan + Feb(0) + Mar = 3 months span, 5 watches → ~1.7/mo
    assert stats["span_months"] == 3
    assert stats["counts"] == [2, 0, 3]
    assert stats["films_per_month"] == round(5 / 3, 1)
    summary = build_diary_summary(diary, catalog=diary, watched_only=diary.iloc[0:0].copy())
    assert summary["films_per_month"] == stats["films_per_month"]
    path = Path("/tmp/lb-viewing-pace-test.png")
    assert chart_viewing_pace(diary, path) is True
    assert path.is_file() and path.stat().st_size > 0


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


def test_watch_window_keeps_undated_out_unless_asked() -> None:
    """Custom range: in-window diary only. Undated flag adds films with no diary date."""
    diary = pd.DataFrame(
        [
            {"Name": "In Range", "Year": 2010, "Rating": 4.0, "Watched Date": "2024-06-15", "source": "diary"},
            {"Name": "Outside", "Year": 2011, "Rating": 2.0, "Watched Date": "2020-01-01", "source": "diary"},
        ]
    )
    diary["Watched Date"] = pd.to_datetime(diary["Watched Date"])
    watched = pd.DataFrame(
        [
            {"Name": "Watched Only", "Year": 2012, "Rating": pd.NA, "Watched Date": pd.NaT, "source": "watched"},
            {"Name": "In Range", "Year": 2010, "Rating": pd.NA, "Watched Date": pd.NaT, "source": "watched"},
        ]
    )
    ratings = pd.DataFrame(
        [
            {"Name": "Ratings Only", "Year": 2013, "Rating": 5.0, "Watched Date": pd.NaT, "source": "ratings"},
            {"Name": "Outside", "Year": 2011, "Rating": 3.5, "Watched Date": pd.NaT, "source": "ratings"},
        ]
    )
    _diary, catalog, _only, film_ratings = scope_letterboxd_frames(
        diary, watched, ratings, date_from="2024-06-01", date_to="2024-06-30", include_undated=False
    )
    assert set(catalog["Name"]) == {"In Range"}
    assert set(film_ratings["Name"]) == {"In Range"}

    _diary, catalog, only, film_ratings = scope_letterboxd_frames(
        diary, watched, ratings, date_from="2024-06-01", date_to="2024-06-30", include_undated=True
    )
    assert set(catalog["Name"]) == {"In Range", "Watched Only", "Ratings Only"}
    assert set(only["Name"]) == {"Watched Only", "Ratings Only"}
    undated = catalog[catalog["Name"] != "In Range"]
    assert undated["Watched Date"].isna().all()
    assert "Outside" not in set(catalog["Name"])
    assert set(film_ratings["Name"]) == {"In Range", "Ratings Only"}


def test_watch_time_grain_cutoffs() -> None:
    assert watch_time_grain("2024-01-01", "2024-02-14") == "day"  # 45 inclusive days
    assert watch_time_grain("2024-01-01", "2024-02-15") == "month"  # 46 days, 2 months
    assert watch_time_grain("2024-01-01", "2025-06-01") == "month"  # 18 inclusive months
    assert watch_time_grain("2024-01-01", "2025-07-01") == "year"
    short = pd.DataFrame(
        [
            {"Name": "A", "Year": 2020, "Rating": 4.0, "Watched Date": "2024-03-01"},
            {"Name": "B", "Year": 2019, "Rating": 3.0, "Watched Date": "2024-03-10"},
        ]
    )
    short["Watched Date"] = pd.to_datetime(short["Watched Date"])
    start, end = resolve_watch_bounds(short)
    assert watch_time_grain(start, end) == "day"
    win_start, win_end = resolve_watch_bounds(short, "2010-01-01", "2020-12-31")
    assert watch_time_grain(win_start, win_end) == "year"

    stats = viewing_pace_stats(
        short, grain="day", span_start="2024-03-01", span_end="2024-03-05"
    )
    assert stats["counts"][:5] == [1, 0, 0, 0, 0]
    assert stats["span_days"] == 5
    means = diary_rating_means_by_watch_year(short, grain="day")
    assert len(means) == 2  # rated buckets only, no zero days


def test_count_avg_label_and_usa_english_filter() -> None:
    assert format_count_avg_label(4.25, 3, 3) == "4.25"
    assert "n=" not in format_count_avg_label(4.25, 17, 3)
    assert format_count_avg_label(1.94, 17, 3) == "1.94"
    assert format_count_avg_label(4.25, 2, 3) == "—"
    assert format_count_avg_label(None, 5, 3) == "—"
    assert is_usa_country("U.S.A.")
    assert is_usa_country("United States")
    assert not is_usa_country("France")
    assert is_english_language("en")
    assert is_english_language("английский")
    assert not is_english_language("fr")
    assert _filter_entity_names("countries", ["France", "USA"], include_usa=False) == ["France"]
    assert _filter_entity_names("languages", ["en", "ja"], include_english=False) == ["ja"]


def main() -> int:
    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        os.chdir(tmp)
        test_union_and_diary_wins(tmp)
        test_watch_year_avg_uses_each_diary_rating()
        test_viewing_pace_is_monthly_not_yearly()
        test_peak_viewing_day_from_diary()
        test_diary_latest_beats_older_diary_and_ratings_csv()
        test_diary_wins_over_ratings_csv()
        test_diary_fallback_when_no_ratings_csv(tmp)
        test_watch_window_keeps_undated_out_unless_asked()
        test_watch_time_grain_cutoffs()
        test_count_avg_label_and_usa_english_filter()
    print("test_letterboxd_export: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
