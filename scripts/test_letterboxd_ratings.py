#!/usr/bin/env python3
"""Unique-film rating dedupe + «выше оценка» threshold helper."""

from __future__ import annotations

import pandas as pd

from letterboxd_calendar_charts import build_diary_summary
from letterboxd_genre_charts import _rank_named
from letterboxd_ratings import (
    MIN_RATED_FOR_TOP,
    film_identity_series,
    latest_rated_per_film,
    passes_rated_threshold,
)


def _diary_five_plus_one() -> pd.DataFrame:
    """Film A rated on 5 diary rows (distinct entry URIs) + film B once → 2 unique."""
    rows = []
    for i in range(5):
        rows.append(
            {
                "Name": "Film A",
                "Year": 2020,
                "Letterboxd URI": f"https://boxd.it/entry-a-{i}",
                "Rating": 3.0 + (i * 0.5) % 2,  # vary a bit; latest wins
                "Watched Date": f"2024-0{i + 1}-01",
            }
        )
    rows.append(
        {
            "Name": "Film B",
            "Year": 2021,
            "Letterboxd URI": "https://boxd.it/entry-b",
            "Rating": 5.0,
            "Watched Date": "2024-06-01",
        }
    )
    df = pd.DataFrame(rows)
    df["Watched Date"] = pd.to_datetime(df["Watched Date"])
    return df


def test_passes_rated_threshold_helper() -> None:
    assert MIN_RATED_FOR_TOP == 3
    assert passes_rated_threshold(0) is False
    assert passes_rated_threshold(3) is False  # need strictly > 3
    assert passes_rated_threshold(4) is True
    assert passes_rated_threshold(2, min_rated=3) is False
    assert passes_rated_threshold(4, min_rated=3) is True


def test_five_plus_one_rewatches_are_two_unique_films() -> None:
    diary = _diary_five_plus_one()
    # Distinct entry URIs must NOT inflate identity.
    assert film_identity_series(diary).nunique() == 2
    latest = latest_rated_per_film(diary)
    assert len(latest) == 2, f"expected 2 unique rated films, got {len(latest)}"
    assert set(latest["Name"]) == {"Film A", "Film B"}
    # Latest watch of A is 2024-05-01 (i=4) → rating 3.0 + (4*0.5)%2 = 3.0
    a = latest[latest["Name"] == "Film A"].iloc[0]
    assert float(a["Rating"]) == 3.0
    assert not passes_rated_threshold(len(latest))


def test_threshold_blocks_rating_top_for_five_plus_one() -> None:
    """Entity with rated=2 (unique) must not appear in «выше оценка»."""
    diary = _diary_five_plus_one()
    latest = latest_rated_per_film(diary)
    rated_n = int(len(latest))
    assert rated_n == 2
    assert not passes_rated_threshold(rated_n)

    # Simulate a genre/director bucket fed only these two unique ratings.
    stats = {
        "Drama": {
            "count": 6,  # watch hits may still count every diary row
            "rating_sum": float(latest["Rating"].sum()),
            "rated": rated_n,
        }
    }
    by_rating = _rank_named(stats, by_avg=True, min_rated=MIN_RATED_FOR_TOP, limit=8)
    assert by_rating == [], by_rating

    # Same bucket with 4 unique rated films would pass.
    stats4 = {
        "Drama": {"count": 4, "rating_sum": 16.0, "rated": 4},
    }
    by_rating4 = _rank_named(stats4, by_avg=True, min_rated=MIN_RATED_FOR_TOP, limit=8)
    assert len(by_rating4) == 1
    assert by_rating4[0]["rated"] == 4


def test_release_year_top_uses_unique_rated() -> None:
    """build_diary_summary must not show release-year rating top for 5+1 same year."""
    diary = _diary_five_plus_one()
    # Put both films in the same release year so one bucket has rated=2.
    diary = diary.copy()
    diary["Year"] = 2020
    summary = build_diary_summary(diary, catalog=diary, watched_only=diary.iloc[0:0].copy())
    assert summary["rated_count"] == 2
    assert summary["top_rated_release_years"] == []


def main() -> int:
    test_passes_rated_threshold_helper()
    test_five_plus_one_rewatches_are_two_unique_films()
    test_threshold_blocks_rating_top_for_five_plus_one()
    test_release_year_top_uses_unique_rated()
    print("test_letterboxd_ratings: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
