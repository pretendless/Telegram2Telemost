"""Load Letterboxd export ZIP: diary.csv + watched.csv + ratings.csv.

Diary drives date-sensitive metrics (needs Watched Date).
Catalog = diary ∪ watched-only films for date-insensitive stats.

Film match across files uses Name + Year — diary Letterboxd URIs point at
diary entries, watched/ratings URIs at film pages, so URI identity does not align.

Ratings for averages / «выше оценка» (one Rating per Name+Year):
  1) If any diary row has a Rating → latest diary Watched Date with a Rating,
  2) Else → ratings.csv (rated without a diary entry).
Never prefer ratings.csv over a diary rating. Never use an older diary rating
when a newer diary rating exists. watched.csv has no Rating column.
"""

from __future__ import annotations

import zipfile
from pathlib import Path

import numpy as np
import pandas as pd

from letterboxd_ratings import film_identity_series, latest_rated_per_film


def film_name_year_key(df: pd.DataFrame) -> pd.Series:
    """Cross-file film key: Name|||Year (not diary entry URI)."""
    return film_identity_series(df)


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


def _empty_ratings_frame() -> pd.DataFrame:
    return pd.DataFrame(columns=["Name", "Year", "Rating", "Watched Date", "source", "_film_key"])


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
    empty_cols = ["Name", "Year", "Rating", "Watched Date", "source"]
    if not path.is_file():
        return pd.DataFrame(columns=empty_cols)
    try:
        with zipfile.ZipFile(path) as zf:
            names = zf.namelist()
            watched_name = _find_member(names, "watched.csv")
            if not watched_name:
                return pd.DataFrame(columns=empty_cols)
            df = _read_csv_member(zf, watched_name)
    except zipfile.BadZipFile:
        return pd.DataFrame(columns=empty_cols)

    if df.empty:
        return pd.DataFrame(columns=empty_cols)

    df = _normalize_common(df)
    # Never invent a diary Watched Date from watched.csv Date.
    df["Watched Date"] = pd.NaT
    df["source"] = "watched"
    df = df[df["Name"].astype(str).str.strip() != ""].copy()
    return df


def load_ratings(zip_path: Path | str) -> pd.DataFrame:
    """Parse ratings.csv if present. Empty frame when missing (not an error).

    Letterboxd ratings.csv is the authoritative star list (usually one row per film).
    """
    path = Path(zip_path)
    empty_cols = ["Name", "Year", "Rating", "Watched Date", "source"]
    if not path.is_file():
        return pd.DataFrame(columns=empty_cols)
    try:
        with zipfile.ZipFile(path) as zf:
            names = zf.namelist()
            # Prefer top-level ratings.csv (skip likes/, deleted/, orphaned/).
            candidates = [n for n in names if n.lower().endswith("ratings.csv")]
            ratings_name = next((n for n in candidates if n.lower() == "ratings.csv"), None)
            if ratings_name is None:
                ratings_name = next(
                    (
                        n
                        for n in candidates
                        if not any(p in n.lower() for p in ("likes/", "deleted/", "orphaned/"))
                    ),
                    None,
                )
            if not ratings_name:
                return pd.DataFrame(columns=empty_cols)
            df = _read_csv_member(zf, ratings_name)
    except zipfile.BadZipFile:
        return pd.DataFrame(columns=empty_cols)

    if df.empty:
        return pd.DataFrame(columns=empty_cols)

    df = _normalize_common(df)
    df["Watched Date"] = pd.NaT
    df["source"] = "ratings"
    df = df[df["Name"].astype(str).str.strip() != ""].copy()
    df = df[df["Rating"].notna()].copy()
    if df.empty:
        return pd.DataFrame(columns=empty_cols)
    # One row per film (ratings.csv should already be unique; keep first if not).
    df = df.copy()
    df["_film_key"] = film_name_year_key(df)
    df = df.groupby("_film_key", dropna=False, as_index=False).head(1)
    return df.drop(columns=["_film_key"], errors="ignore")


def watched_only_films(diary: pd.DataFrame, watched: pd.DataFrame) -> pd.DataFrame:
    """Films in watched.csv whose Name+Year never appears in diary."""
    if watched is None or watched.empty:
        return watched.iloc[0:0].copy() if watched is not None else pd.DataFrame()
    if diary is None or diary.empty:
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


def merged_film_ratings(ratings: pd.DataFrame | None, diary: pd.DataFrame) -> pd.DataFrame:
    """One row per Name+Year with Rating.

    Precedence: diary latest-rated wins; ratings.csv fills films with no diary Rating.
    """
    parts: list[pd.DataFrame] = []
    diary_keys: set[str] = set()

    diary_latest = latest_rated_per_film(diary)
    if diary_latest is not None and not diary_latest.empty:
        d = diary_latest.copy()
        d["_film_key"] = film_name_year_key(d)
        d["source"] = "diary"
        diary_keys = set(d["_film_key"].tolist())
        parts.append(d)

    if ratings is not None and not ratings.empty and "Rating" in ratings.columns:
        r = ratings[ratings["Rating"].notna()].copy()
        if not r.empty:
            r["_film_key"] = film_name_year_key(r)
            r = r.groupby("_film_key", dropna=False, as_index=False).head(1)
            if diary_keys:
                r = r[~r["_film_key"].isin(diary_keys)].copy()
            if not r.empty:
                r["source"] = "ratings"
                parts.append(r)

    if not parts:
        return _empty_ratings_frame()

    out = pd.concat(parts, ignore_index=True, sort=False)
    if "_film_key" not in out.columns:
        out["_film_key"] = film_name_year_key(out)
    # Keep helper key for joins; callers may drop.
    return out


def ratings_for_catalog(catalog: pd.DataFrame, film_ratings: pd.DataFrame) -> pd.DataFrame:
    """Film ratings restricted to unique Name+Year keys present in catalog."""
    if film_ratings is None or film_ratings.empty:
        return _empty_ratings_frame()
    if catalog is None or catalog.empty:
        return film_ratings.copy()

    cat_keys = set(film_name_year_key(catalog).tolist())
    work = film_ratings.copy()
    if "_film_key" not in work.columns:
        work["_film_key"] = film_name_year_key(work)
    return work[work["_film_key"].isin(cat_keys)].copy()


def latest_rated_union(
    diary: pd.DataFrame,
    watched_only: pd.DataFrame | None = None,
    ratings: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """Unique-film ratings: diary latest wins; ratings.csv fills non-diary gaps.

    `watched_only` is accepted for call-site compatibility; watched.csv has no
    ratings in Letterboxd exports. Prefer passing `ratings` from load_ratings.
    """
    if ratings is None:
        ratings = _empty_ratings_frame()
    return merged_film_ratings(ratings, diary)


def load_export(
    zip_path: Path | str,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Return (diary, catalog, watched_only, film_ratings).

    film_ratings = diary latest-rated ∪ ratings.csv gaps (diary wins).
    """
    diary = load_diary(zip_path, require_dates=True)
    watched = load_watched(zip_path)
    ratings = load_ratings(zip_path)
    catalog, only = union_catalog(diary, watched)
    film_ratings = merged_film_ratings(ratings, diary)
    return diary, catalog, only, film_ratings
