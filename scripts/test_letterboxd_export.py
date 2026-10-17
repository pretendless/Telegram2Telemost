#!/usr/bin/env python3
"""Smoke tests for diary ∪ watched catalog loading."""

from __future__ import annotations

import json
import tempfile
import zipfile
from pathlib import Path

from letterboxd_calendar_charts import build_diary_summary, main as cal_main
from letterboxd_export import latest_rated_union, load_export


def _write_zip(path: Path, diary: str, watched: str | None = None) -> None:
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("diary.csv", diary)
        if watched is not None:
            zf.writestr("watched.csv", watched)


def test_union_and_ratings(tmp: Path) -> None:
    diary_csv = """Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date
2024-01-02,Diary Only,2020,https://boxd.it/aaa,4.0,,,2024-01-01
2024-01-03,Shared Film,2019,https://boxd.it/shared,3.0,,,2024-01-02
2024-06-01,Shared Film,2019,https://boxd.it/shared,4.5,Yes,,2024-06-01
"""
    watched_csv = """Date,Name,Year,Letterboxd URI,Rating
2020-01-01,Watched Only,2018,https://boxd.it/film1,5.0
2020-01-01,Shared Film,2019,https://boxd.it/film2,1.0
2020-01-01,Watched Unrated,2017,https://boxd.it/film3,
"""
    zip_path = tmp / "export.zip"
    _write_zip(zip_path, diary_csv, watched_csv)

    diary, catalog, only = load_export(zip_path)
    assert len(diary) == 3
    assert set(only["Name"]) == {"Watched Only", "Watched Unrated"}
    assert len(catalog) == 5

    rated = latest_rated_union(diary, only)
    assert set(rated["Name"]) == {"Shared Film", "Watched Only", "Diary Only"}
    assert float(rated[rated["Name"] == "Shared Film"].iloc[0]["Rating"]) == 4.5
    assert float(rated[rated["Name"] == "Watched Only"].iloc[0]["Rating"]) == 5.0

    summary = build_diary_summary(diary, catalog=catalog, watched_only=only)
    assert summary["unique_films"] == 4
    assert summary["watched_only_films"] == 2
    assert summary["rated_count"] == 3
    assert summary["peak_year"] == 2024

    # Charts should not invent watch dates for watched-only.
    rc = cal_main([str(zip_path)])
    assert rc == 0
    data = json.loads((tmp / "diary_summary.json").read_text(encoding="utf-8"))
    assert data["unique_films"] == 4
    assert data["watched_only_films"] == 2


def test_diary_only_zip(tmp: Path) -> None:
    diary_csv = """Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date
2024-01-02,A,2020,https://boxd.it/a,4.0,,,2024-01-01
"""
    zip_path = tmp / "diary-only.zip"
    _write_zip(zip_path, diary_csv, None)
    diary, catalog, only = load_export(zip_path)
    assert len(only) == 0
    assert len(catalog) == 1
    assert build_diary_summary(diary, catalog=catalog, watched_only=only)["unique_films"] == 1


def main() -> int:
    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        # Chart scripts write into cwd.
        import os

        os.chdir(tmp)
        test_union_and_ratings(tmp)
        test_diary_only_zip(tmp)
    print("test_letterboxd_export: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
