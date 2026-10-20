"""Chart options for /letterboxd: top size, rating gate, USA/English, watch window.

Wizard defaults (also the GitHub Actions defaults):
  top_n=20 (allowed 1–100), min_rated=3 (allowed 1–50),
  include USA, include English, full diary span, undated films only on the full span.

The wizard rejects anything outside 1–100 (a typo like 9999 never dispatches).
This module clamps a manual workflow_dispatch into the same bounds. Chart
height grows with the row count; point sizes stay put.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from letterboxd_ratings import passes_rated_threshold

TOP_N_MIN = 1
TOP_N_MAX = 100
TOP_N_DEFAULT = 20
MIN_RATED_MIN = 1
MIN_RATED_MAX = 50
MIN_RATED_DEFAULT = 3

_USA_NAMES = {
    "united states of america",
    "united states",
    "usa",
    "us",
}

_ENGLISH_NAMES = {
    "en",
    "eng",
    "english",
    "английский",
}


def clamp_top_n(value, default: int = TOP_N_DEFAULT) -> int:
    return _clamp_int(value, TOP_N_MIN, TOP_N_MAX, default)


def clamp_min_rated(value, default: int = MIN_RATED_DEFAULT) -> int:
    return _clamp_int(value, MIN_RATED_MIN, MIN_RATED_MAX, default)


def _clamp_int(value, lo: int, hi: int, default: int) -> int:
    if value is None:
        return default
    text = str(value).strip()
    if not text:
        return default
    try:
        n = int(text)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, n))


def parse_bool_flag(value, default: bool = False) -> bool:
    if value is None:
        return default
    text = str(value).strip().lower()
    if not text:
        return default
    if text in {"1", "true", "yes", "y", "да"}:
        return True
    if text in {"0", "false", "no", "n", "нет"}:
        return False
    return default


def _norm_name(value) -> str:
    text = str(value or "").strip().lower().replace(".", "")
    return " ".join(text.split())


def is_usa_country(name) -> bool:
    return _norm_name(name) in _USA_NAMES


def is_english_language(code) -> bool:
    return _norm_name(code) in _ENGLISH_NAMES


def format_count_avg_label(avg, rated, min_rated: int) -> str:
    """Avg annotation for a quantitative bar: the mean only.

    Same gate as avg charts (unique rated films ≥ min_rated). Below the gate,
    or when there is no mean, show an em dash. The rated-film count is not
    printed — viewers were reading ``n=`` as the watch count.
    """
    try:
        rated_n = int(rated) if rated is not None else 0
    except (TypeError, ValueError):
        rated_n = 0
    if not passes_rated_threshold(rated_n, min_rated=min_rated):
        return "—"
    try:
        avg_f = float(avg)
    except (TypeError, ValueError):
        return "—"
    if not (avg_f > 0):
        return "—"
    return f"{avg_f:.2f}"


def rated_gate_phrase(min_rated: int) -> str:
    return f"не меньше {int(min_rated)} оценённых фильмов"


@dataclass(frozen=True)
class ChartOptions:
    top_n: int = TOP_N_DEFAULT
    min_rated: int = MIN_RATED_DEFAULT
    include_usa: bool = True
    include_english: bool = True
    date_from: str | None = None
    date_to: str | None = None
    include_undated: bool = False

    @property
    def has_window(self) -> bool:
        return bool(self.date_from and self.date_to)


def _day(value: str) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    # YYYY-MM-DD only — do not accept loose timestamps from a manual dispatch.
    if len(text) != 10 or text[4] != "-" or text[7] != "-":
        return None
    year, month, day = text.split("-")
    if not (year.isdigit() and month.isdigit() and day.isdigit()):
        return None
    return text


def read_chart_options(env: dict | None = None) -> ChartOptions:
    src = os.environ if env is None else env
    date_from = _day(src.get("LETTERBOXD_DATE_FROM", ""))
    date_to = _day(src.get("LETTERBOXD_DATE_TO", ""))
    if not date_from or not date_to or date_to < date_from:
        date_from = None
        date_to = None
    include_undated = parse_bool_flag(src.get("LETTERBOXD_INCLUDE_UNDATED"), False) if date_from else False
    return ChartOptions(
        top_n=clamp_top_n(src.get("LETTERBOXD_TOP_N")),
        min_rated=clamp_min_rated(src.get("LETTERBOXD_MIN_RATED")),
        include_usa=parse_bool_flag(src.get("LETTERBOXD_INCLUDE_USA"), True),
        include_english=parse_bool_flag(src.get("LETTERBOXD_INCLUDE_ENGLISH"), True),
        date_from=date_from,
        date_to=date_to,
        include_undated=include_undated,
    )
