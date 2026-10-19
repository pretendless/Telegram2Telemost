"""Unique-film Letterboxd ratings helpers.

Identity: **Name + Year** (not diary Letterboxd URI — those point at diary
entries, so each rewatch has a distinct URI and would inflate rated counts).

For averages / «выше оценка» (via letterboxd_export.merged_film_ratings):
diary latest-rated wins; **ratings.csv** fills films with no diary Rating.

Watch-count metrics still use the full diary / catalog rows.

«Выше оценка» tops require at least MIN_RATED_FOR_TOP **unique**
rated films (rated ≥ 3 after merge + Name+Year dedupe), never raw diary rows.
"""

from __future__ import annotations

import pandas as pd

# Rating tops («выше оценка»): entity needs rated unique films ≥ this value.
MIN_RATED_FOR_TOP = 3


def film_identity_series(df: pd.DataFrame) -> pd.Series:
    """Stable per-row film key: Name|||Year.

    Diary export URIs are per-entry and must not be used for unique-film
    identity (5 rated rewatches of one title would become 5 «films»).
    """
    names = (
        df["Name"].fillna("").astype(str).str.strip()
        if "Name" in df.columns
        else pd.Series([""] * len(df), index=df.index)
    )
    years = df["Year"] if "Year" in df.columns else pd.Series([pd.NA] * len(df), index=df.index)
    year_part = years.map(lambda y: str(int(y)) if pd.notna(y) else "")
    return names + "|||" + year_part


def passes_rated_threshold(rated_count: int, min_rated: int | None = None) -> bool:
    """True when unique rated films meet the «выше оценка» gate (inclusive).

    min_rated defaults to MIN_RATED_FOR_TOP (need rated ≥ 3 unique films).
    """
    threshold = MIN_RATED_FOR_TOP if min_rated is None else int(min_rated)
    try:
        n = int(rated_count)
    except (TypeError, ValueError):
        return False
    return n >= threshold


def latest_rated_per_film(df: pd.DataFrame) -> pd.DataFrame:
    """One row per film: latest Watched Date among rows with a non-empty Rating.

    Rows without Rating are ignored. If a film was only watched without ratings,
    it does not appear. Prefer the most recent rated entry even if a later watch
    has no rating.
    """
    if df is None or df.empty or "Rating" not in df.columns:
        return df.iloc[0:0].copy() if df is not None else pd.DataFrame()

    work = df[df["Rating"].notna()].copy()
    if work.empty:
        return work
    if "Watched Date" not in work.columns:
        work["_film_key"] = film_identity_series(work)
        return work.groupby("_film_key", dropna=False, as_index=False).head(1).drop(columns=["_film_key"])

    # Diary path: only rows with a real Watched Date (no fake dates from watched.csv).
    work = work[work["Watched Date"].notna()].copy()
    if work.empty:
        return work
    work["_film_key"] = film_identity_series(work)
    work = work.sort_values("Watched Date", kind="mergesort")
    out = work.groupby("_film_key", dropna=False, as_index=False).tail(1)
    return out.drop(columns=["_film_key"])
