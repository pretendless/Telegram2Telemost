"""Latest Letterboxd Rating per unique film (rewatch-safe averages).

Identity: Letterboxd URI when present, else Name + Year.
Among diary rows for a film, keep the latest Watched Date that has a
non-empty Rating («последняя оценка»). Watch-count metrics should still
use the full diary; only mean ratings and rating tops use this frame.
"""

from __future__ import annotations

import pandas as pd


def film_identity_series(df: pd.DataFrame) -> pd.Series:
    """Stable per-row film key: uri:… or name|||year."""
    names = (
        df["Name"].fillna("").astype(str).str.strip()
        if "Name" in df.columns
        else pd.Series([""] * len(df), index=df.index)
    )
    years = df["Year"] if "Year" in df.columns else pd.Series([pd.NA] * len(df), index=df.index)
    year_part = years.map(lambda y: str(int(y)) if pd.notna(y) else "")
    name_key = names + "|||" + year_part

    uri_col = next(
        (c for c in ("Letterboxd URI", "URI", "Letterboxd uri") if c in df.columns),
        None,
    )
    if uri_col is None:
        return name_key

    uris = df[uri_col].fillna("").astype(str).str.strip()
    return uris.map(lambda u: f"uri:{u}" if u else None).fillna(name_key)


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
        # Should not happen for diary.csv; keep first occurrence.
        work["_film_key"] = film_identity_series(work)
        return work.groupby("_film_key", dropna=False, as_index=False).head(1).drop(columns=["_film_key"])

    work = work[work["Watched Date"].notna()].copy()
    if work.empty:
        return work
    work["_film_key"] = film_identity_series(work)
    work = work.sort_values("Watched Date", kind="mergesort")
    out = work.groupby("_film_key", dropna=False, as_index=False).tail(1)
    return out.drop(columns=["_film_key"])
