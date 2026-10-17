"""Load Letterboxd export ZIP: diary.csv + optional watched.csv.

Diary drives date-sensitive metrics (needs Watched Date).
Catalog = diary ∪ watched-only films for date-insensitive stats.

Film match across files uses Name + Year — diary Letterboxd URIs point at
diary entries, watched URIs at film pages, so URI identity does not align.
When a film appears in both, diary rows win (ratings: latest rated diary
entry per letterboxd_ratings.latest_rated_per_film). Watched-only rows keep
Rating/Year from watched.csv and never invent a Watched Date.
"""

from __future__ import annotations

import zipfile
from pathlib import Path

import numpy as np
import pandas as pd

from letterboxd_ratings import latest_rated_per_film


def film_name_year_key(df: pd.DataFrame) -> pd.Series:
    """Cross-file film key: Name|||Year (not diary entry URI)."""
    names = (
        df["Name"].fillna("").astype(str).str.strip()
        if "Name" in df.columns
        else pd.Series([""] * len(df), index=df.index)
    )
    years = df["Year"] if "Year" in df.columns else pd.Series([pd.NA] * len(df), index=df.index)
    year_part = years.map(lambda y: str(int(y)) if pd.notna(y) else "")
    return names + "|||" + year_part


def _find_member(names: list[str], suffix: str) -> str | None:
    needle = suffix.lower()
    return next((n for n in names if n.lower().endswith(needle)), None)


def _read_csv_member(zf: zipfile.ZipFile, member: str) -> pd.DataFrame:
    with zf.open(member) as f:
        return pd.read_csv(f)


def _normalize_common(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    if "Name" in out.columns:
        out["Name"] = out["Name"].fillna("").astype(str).str.strip()
    else:
        out["Name"] = ""
    if "Year" in out.columns:
        out["Year"] = pd.to_numeric(out["Year"], errors="coerce")
    else:
        out["Year"] = np.nan
    if "Rating" in out.columns:
        out["Rating"] = pd.to_numeric(out["Rating"], errors="coerce")
    else:
        out["Rating"] = np.nan
    return out


def load_diary(zip_path: Path | str, *, require_dates: bool = True) -> pd.DataFrame:
    """Parse diary.csv. When require_dates, drop rows without Watched Date."""
    path = Path(zip_path)
    if not path.is_file():
        raise RuntimeError("ZIP-файл не найден.")
    try:
        with zipfile.ZipFile(path) as zf:
            names = zf.namelist()
            diary_name = _find_member(names, "diary.csv")
            if not diary_name:
                raise RuntimeError("В ZIP не найден diary.csv")
            df = _read_csv_member(zf, diary_name)
    except zipfile.BadZipFile as err:
        raise RuntimeError("Файл не похож на ZIP Letterboxd.") from err

    if "Watched Date" not in df.columns:
        raise RuntimeError("В diary.csv нет колонки Watched Date")
    required = {"Name", "Year", "Watched Date"}
    if not required.issubset(df.columns):
        raise RuntimeError(f"В diary.csv не хватает колонок: {required - set(df.columns)}")

    df = _normalize_common(df)
    df["Watched Date"] = pd.to_datetime(df["Watched Date"], errors="coerce")
    if require_dates:
        df = df[df["Watched Date"].notna()].copy()
        if df.empty:
            raise RuntimeError("diary.csv не содержит дат просмотра.")
    df["source"] = "diary"
    return df


def load_watched(zip_path: Path | str) -> pd.DataFrame:
    """Parse watched.csv if present. Empty frame when missing (not an error).

    Does not treat the export Date column as Watched Date — that is only when
    the user marked the title watched, often a bulk import day.
    """
    path = Path(zip_path)
    if not path.is_file():
        return pd.DataFrame(columns=["Name", "Year", "Rating", "Watched Date", "source"])
    try:
        with zipfile.ZipFile(path) as zf:
            names = zf.namelist()
            watched_name = _find_member(names, "watched.csv")
            if not watched_name:
                return pd.DataFrame(columns=["Name", "Year", "Rating", "Watched Date", "source"])
            df = _read_csv_member(zf, watched_name)
    except zipfile.BadZipFile:
        return pd.DataFrame(columns=["Name", "Year", "Rating", "Watched Date", "source"])

    if df.empty:
        return pd.DataFrame(columns=["Name", "Year", "Rating", "Watched Date", "source"])

    df = _normalize_common(df)
    # Never invent a diary Watched Date from watched.csv Date.
    df["Watched Date"] = pd.NaT
    df["source"] = "watched"
    # Drop blank titles.
    df = df[df["Name"].astype(str).str.strip() != ""].copy()
    return df


def watched_only_films(diary: pd.DataFrame, watched: pd.DataFrame) -> pd.DataFrame:
    """Films in watched.csv whose Name+Year never appears in diary."""
    if watched is None or watched.empty:
        return watched.iloc[0:0].copy() if watched is not None else pd.DataFrame()
    if diary is None or diary.empty:
        # One row per Name+Year.
        work = watched.copy()
        work["_k"] = film_name_year_key(work)
        return work.groupby("_k", dropna=False, as_index=False).head(1).drop(columns=["_k"])

    diary_keys = set(film_name_year_key(diary).tolist())
    work = watched.copy()
    work["_k"] = film_name_year_key(work)
    work = work[~work["_k"].isin(diary_keys)].copy()
    if work.empty:
        return work.drop(columns=["_k"])
    return work.groupby("_k", dropna=False, as_index=False).head(1).drop(columns=["_k"])


def union_catalog(diary: pd.DataFrame, watched: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """All diary rows plus one row per watched-only film.

    Returns (catalog, watched_only).
    """
    only = watched_only_films(diary, watched)
    if only is None or only.empty:
        catalog = diary.copy() if diary is not None else pd.DataFrame()
        empty = only if only is not None else pd.DataFrame()
        return catalog, empty
    catalog = pd.concat([diary, only], ignore_index=True, sort=False)
    return catalog, only


def latest_rated_union(diary: pd.DataFrame, watched_only: pd.DataFrame) -> pd.DataFrame:
    """Latest diary rating per film; watched-only Ratings fill films absent from diary.

    Films that appear in the diary (even unrated) do not take a watched Rating —
    diary preference. Within diary, #113 latest-rated-by-Watched-Date still applies.
    """
    from_diary = latest_rated_per_film(diary)

    if watched_only is None or watched_only.empty or "Rating" not in watched_only.columns:
        return from_diary

    diary_keys = set(film_name_year_key(diary).tolist()) if diary is not None and not diary.empty else set()
    wo = watched_only[watched_only["Rating"].notna()].copy()
    if wo.empty:
        return from_diary
    wo["_k"] = film_name_year_key(wo)
    wo = wo[~wo["_k"].isin(diary_keys)].copy()
    if wo.empty:
        return from_diary
    # One rated row per film (watched has no useful watch order).
    wo = wo.groupby("_k", dropna=False, as_index=False).head(1).drop(columns=["_k"])

    if from_diary is None or from_diary.empty:
        return wo.reset_index(drop=True)
    return pd.concat([from_diary, wo], ignore_index=True, sort=False)


def load_export(zip_path: Path | str) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Return (diary, catalog, watched_only)."""
    diary = load_diary(zip_path, require_dates=True)
    watched = load_watched(zip_path)
    catalog, only = union_catalog(diary, watched)
    return diary, catalog, only
