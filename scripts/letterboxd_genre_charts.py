#!/usr/bin/env python3
"""
Letterboxd genre charts via TMDB.

Usage:
  1) Install: pip install pandas matplotlib
  2) Set TMDB_BEARER_TOKEN in your environment (TMDB Settings -> API).
  3) Run: python letterboxd_genre_charts.py path/to/letterboxd-export.zip

Optional Telegram progress (Actions /letterboxd): TG2TMBOT_TOKEN + CHAT_ID.
Edits one message «Подгружаю подробности из TMDB: N/total…» during enrichment; does not print tokens.

Creates:
  genre_counts_by_viewing_year.png
  average_rating_by_genre.png
  genre_by_release_decade.png
  genre_share_by_viewing_year.png
  watches_by_country.png
  watches_by_director.png
  watches_by_actor.png
  watches_by_language.png
  watches_by_studio.png
  average_rating_by_country.png
  average_rating_by_director.png
  average_rating_by_actor.png
  average_rating_by_language.png
  average_rating_by_studio.png
  letterboxd_with_genres.csv
  tmdb_unmatched.csv
  genre_summary.json

TMDB attribution is included in chart footers. Use of TMDB data is subject to its terms.
"""
import os, sys, json, time, urllib.parse, urllib.request, urllib.error
from pathlib import Path
from collections import Counter, defaultdict

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

import pandas as pd
import matplotlib.pyplot as plt
import numpy as np

from letterboxd_export import (  # noqa: E402
    load_export,
    ratings_for_catalog,
)
from letterboxd_palette import (  # noqa: E402
    FG,
    apply_dark_chart_theme,
    save_dark_figure,
    style_axes,
)
from letterboxd_ratings import (  # noqa: E402
    MIN_RATED_FOR_TOP,
    passes_rated_threshold,
)
from letterboxd_top_charts import (  # noqa: E402
    TOP_N_DEFAULT,
    add_rating_colorbar,
    chart_diary_entity_stacked,
    chart_rating_vbar,
    color_bars_by_rating,
    display_lang,
)

apply_dark_chart_theme()

BASE = "https://api.themoviedb.org/3"
CACHE_PATH = Path("tmdb_genre_cache.json")
TOKEN = os.getenv("TMDB_BEARER_TOKEN", "").strip()
# Optional Telegram progress (Actions /letterboxd). Never log token values.
TG_TOKEN = (os.getenv("TG2TMBOT_TOKEN") or os.getenv("TELEGRAM_BOT_TOKEN") or "").strip()
TG_CHAT = (os.getenv("CHAT_ID") or os.getenv("LETTERBOXD_CHAT_ID") or "").strip()
PROGRESS_EVERY = max(1, int(os.getenv("LETTERBOXD_PROGRESS_EVERY", "25") or "25"))
PROGRESS_MIN_SEC = max(5.0, float(os.getenv("LETTERBOXD_PROGRESS_MIN_SEC", "45") or "45"))
# Min diary hits before a person/company appears in ranked HTML count lists.
MIN_PERSON_COUNT = max(2, int(os.getenv("LETTERBOXD_MIN_PERSON_COUNT", "3") or "3"))
MIN_COMPANY_COUNT = max(2, int(os.getenv("LETTERBOXD_MIN_COMPANY_COUNT", "3") or "3"))
CAST_TOP_BILLED = max(1, int(os.getenv("LETTERBOXD_CAST_TOP", "5") or "5"))


def format_genre_progress(done, total):
    """User-facing progress: unique titles enriched so far / total (genres, countries, people…)."""
    d = max(0, int(done))
    t = max(0, int(total))
    return f"Подгружаю подробности из TMDB: {d}/{t}…"


class TelegramProgress:
    """One progress message in the requesting chat; prefer editMessageText."""

    def __init__(self, token, chat_id):
        self.token = (token or "").strip()
        self.chat_id = str(chat_id or "").strip()
        self.message_id = None
        self.last_sent_at = 0.0
        self.last_text = ""
        self.enabled = bool(self.token and self.chat_id)

    def _call(self, method, payload):
        if not self.enabled:
            return None
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"https://api.telegram.org/bot{self.token}/{method}",
            data=body,
            headers={
                "content-type": "application/json",
                "User-Agent": "LetterboxdGenreCharts/1.0",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            return None

    def update(self, done, total, force=False):
        if not self.enabled:
            return
        text = format_genre_progress(done, total)
        now = time.time()
        if not force and text == self.last_text:
            return
        if not force and self.message_id is not None:
            elapsed = now - self.last_sent_at
            on_step = (int(done) % PROGRESS_EVERY == 0) or (int(total) > 0 and int(done) >= int(total))
            on_timer = elapsed >= PROGRESS_MIN_SEC
            if not on_step and not on_timer:
                return
            # Debounce rapid cache-only steps that still hit PROGRESS_EVERY.
            if on_step and not on_timer and elapsed < 5:
                return
        if self.message_id is None:
            data = self._call(
                "sendMessage",
                {
                    "chat_id": self.chat_id,
                    "text": text,
                    "link_preview_options": {"is_disabled": True},
                },
            )
            if data and data.get("ok") and data.get("result"):
                self.message_id = data["result"].get("message_id")
                self.last_sent_at = now
                self.last_text = text
            return
        data = self._call(
            "editMessageText",
            {
                "chat_id": self.chat_id,
                "message_id": self.message_id,
                "text": text,
                "link_preview_options": {"is_disabled": True},
            },
        )
        if data and data.get("ok"):
            self.last_sent_at = now
            self.last_text = text
        elif data and not data.get("ok"):
            # Message unchanged / flood — ignore; fall back to a new message only if edit is gone.
            desc = str((data or {}).get("description") or "")
            if "message is not modified" in desc.lower():
                self.last_text = text
                self.last_sent_at = now

    def finish(self, text):
        if not self.enabled:
            return
        final = str(text or "").strip()
        if not final:
            return
        if self.message_id is None:
            self._call(
                "sendMessage",
                {
                    "chat_id": self.chat_id,
                    "text": final,
                    "link_preview_options": {"is_disabled": True},
                },
            )
            return
        data = self._call(
            "editMessageText",
            {
                "chat_id": self.chat_id,
                "message_id": self.message_id,
                "text": final,
                "link_preview_options": {"is_disabled": True},
            },
        )
        if not (data and data.get("ok")):
            self._call(
                "sendMessage",
                {
                    "chat_id": self.chat_id,
                    "text": final,
                    "link_preview_options": {"is_disabled": True},
                },
            )


def request_json(url):
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {TOKEN}",
        "accept": "application/json",
        "User-Agent": "LetterboxdGenreCharts/1.0"
    })
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 429 or 500 <= e.code < 600:
                time.sleep(2 + attempt * 2)
                continue
            raise
        except (urllib.error.URLError, TimeoutError):
            time.sleep(2 + attempt * 2)
    raise RuntimeError("TMDB request failed after retries: " + url)

def year_of_release(result):
    date = result.get("release_date", "")
    try:
        return int(date[:4])
    except (ValueError, TypeError):
        return None


def empty_tmdb_entry():
    return {
        "tmdb_id": None,
        "genres": [],
        "countries": [],
        "companies": [],
        "original_language": "",
        "directors": [],
        "cast": [],
        "deep": True,
    }


def extract_deep_fields(details):
    """Pull countries/companies/language + credits from movie details (+ append credits)."""
    countries = [
        c.get("name") for c in (details.get("production_countries") or []) if c.get("name")
    ]
    companies = [
        c.get("name") for c in (details.get("production_companies") or []) if c.get("name")
    ]
    original_language = str(details.get("original_language") or "").strip()
    credits = details.get("credits") or {}
    directors = [
        p.get("name")
        for p in (credits.get("crew") or [])
        if p.get("job") == "Director" and p.get("name")
    ]
    # Dedupe directors while preserving order.
    seen_dir = set()
    directors_unique = []
    for name in directors:
        if name in seen_dir:
            continue
        seen_dir.add(name)
        directors_unique.append(name)
    cast = [
        p.get("name")
        for p in (credits.get("cast") or [])[:CAST_TOP_BILLED]
        if p.get("name")
    ]
    return {
        "genres": [g["name"] for g in (details.get("genres") or []) if g.get("name")],
        "tmdb_title": details.get("title") or "",
        "tmdb_release_year": year_of_release(details),
        "countries": countries,
        "companies": companies,
        "original_language": original_language,
        "directors": directors_unique,
        "cast": cast,
        "deep": True,
    }


def cache_needs_deep(entry):
    """True when cache hit lacks deep TMDB fields (or credits never fetched)."""
    if not entry or not isinstance(entry, dict):
        return True
    if not entry.get("tmdb_id"):
        # Negative/empty cache — treat as complete enough.
        return False
    if entry.get("deep"):
        return False
    # Legacy genre-only entries need one details+credits refresh.
    return True


def fetch_movie_deep(tmdb_id):
    """One TMDB call: movie details with credits appended."""
    url = f"{BASE}/movie/{int(tmdb_id)}?{urllib.parse.urlencode({'append_to_response': 'credits'})}"
    return request_json(url)


def find_tmdb(name, year, cache):
    key = f"{name}|||{int(year) if pd.notna(year) else ''}"
    existing = cache.get(key)
    if existing is not None and not cache_needs_deep(existing):
        return existing

    # Upgrade legacy cache: same tmdb_id, fetch deep fields only.
    if existing and existing.get("tmdb_id") and cache_needs_deep(existing):
        try:
            details = fetch_movie_deep(existing["tmdb_id"])
            deep = extract_deep_fields(details)
            out = {**existing, **deep, "tmdb_id": existing["tmdb_id"]}
            if not out.get("genres"):
                out["genres"] = existing.get("genres") or deep.get("genres") or []
            cache[key] = out
            time.sleep(0.12)
            return out
        except Exception as e:
            print(f"Deep-enrich ошибка для {name} ({year}): {e}")
            existing = {**existing, "deep": True}
            existing.setdefault("countries", [])
            existing.setdefault("companies", [])
            existing.setdefault("original_language", "")
            existing.setdefault("directors", [])
            existing.setdefault("cast", [])
            cache[key] = existing
            return existing

    params = {"query": name, "include_adult": "true"}
    if pd.notna(year):
        params["year"] = int(year)
    url = BASE + "/search/movie?" + urllib.parse.urlencode(params)
    data = request_json(url)
    results = data.get("results", [])
    if not results:
        cache[key] = empty_tmdb_entry()
        return cache[key]

    target_year = int(year) if pd.notna(year) else None
    # Prefer exact year; then closest year; then most popular result.
    def score(r):
        ry = year_of_release(r)
        exact = 1 if target_year is not None and ry == target_year else 0
        distance = abs(ry - target_year) if target_year is not None and ry is not None else 9999
        return (exact, -distance, r.get("popularity", 0))

    best = max(results, key=score)
    details = fetch_movie_deep(best["id"])
    deep = extract_deep_fields(details)
    out = {
        "tmdb_id": best["id"],
        **deep,
        "tmdb_title": deep.get("tmdb_title") or best.get("title", ""),
    }
    cache[key] = out
    time.sleep(0.12)
    return out


def save_cache(cache):
    CACHE_PATH.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")


def _rank_named(stats, min_count=1, limit=8, by_avg=False, min_rated=None):
    """stats: name -> {count, rating_sum, rated}.

    Count tops use min_count on watch hits.
    Rating tops require unique rated films > min_rated (strict); omit failures.
    `rated` must be unique-film count after latest_rated_* dedupe, not diary rows.
    """
    rows = []
    for name, st in stats.items():
        count = int(st.get("count") or 0)
        rated = int(st.get("rated") or 0)
        if by_avg:
            if not passes_rated_threshold(rated, min_rated=min_rated):
                continue
        elif count < min_count:
            continue
        avg = round(st["rating_sum"] / rated, 2) if rated else None
        rows.append({"name": name, "count": count, "avg": avg, "rated": rated})
    if by_avg:
        rows.sort(
            key=lambda r: (-(r["avg"] if r["avg"] is not None else -1), -r["rated"], r["name"])
        )
    else:
        rows.sort(
            key=lambda r: (-r["count"], -(r["avg"] if r["avg"] is not None else -1), r["name"])
        )
    return rows[:limit]


def _paired_ranks(stats, min_count, limit_count=TOP_N_DEFAULT, limit_rating=TOP_N_DEFAULT):
    """Count top + rating top (unique rated films > MIN_RATED_FOR_TOP only)."""
    by_count = _rank_named(stats, min_count=min_count, limit=limit_count, by_avg=False)
    by_rating = _rank_named(
        stats,
        min_count=1,
        limit=limit_rating,
        by_avg=True,
        min_rated=MIN_RATED_FOR_TOP,
    )
    return by_count, by_rating


def _cache_key(row):
    return f"{row['Name']}|||{int(row['Year']) if pd.notna(row['Year']) else ''}"


def aggregate_person_stats(catalog, cache, film_ratings=None, diary=None, watched_only=None):
    """Catalog counts (diary∪watched); avgs from ratings.csv ∪ diary joined to catalog."""
    countries = defaultdict(lambda: {"count": 0, "rating_sum": 0.0, "rated": 0})
    directors = defaultdict(lambda: {"count": 0, "rating_sum": 0.0, "rated": 0})
    actors = defaultdict(lambda: {"count": 0, "rating_sum": 0.0, "rated": 0})
    languages = defaultdict(lambda: {"count": 0, "rating_sum": 0.0, "rated": 0})
    companies = defaultdict(lambda: {"count": 0, "rating_sum": 0.0, "rated": 0})

    def bump_count(bucket, name):
        if not name:
            return
        bucket[name]["count"] += 1

    def bump_rating(bucket, name, rating):
        if not name:
            return
        if rating is None or (isinstance(rating, float) and np.isnan(rating)):
            return
        try:
            r = float(rating)
        except (TypeError, ValueError):
            return
        if r <= 0:
            return
        st = bucket[name]
        st["rating_sum"] += r
        st["rated"] += 1

    def apply_meta(buckets_fn, row, meta):
        for c in meta.get("countries") or []:
            buckets_fn(countries, c, row)
        for d in meta.get("directors") or []:
            buckets_fn(directors, d, row)
        for a in meta.get("cast") or []:
            buckets_fn(actors, a, row)
        for co in meta.get("companies") or []:
            buckets_fn(companies, co, row)
        lang = (meta.get("original_language") or "").strip()
        if lang:
            buckets_fn(languages, lang, row)

    # Counts: diary viewings + watched-only films (catalog).
    for _, row in catalog.iterrows():
        meta = cache.get(_cache_key(row)) or {}

        def count_only(bucket, name, _row):
            bump_count(bucket, name)

        apply_meta(count_only, row, meta)

    if film_ratings is None:
        from letterboxd_export import merged_film_ratings

        film_ratings = merged_film_ratings(None, diary if diary is not None else catalog)
    rated_rows = ratings_for_catalog(catalog, film_ratings)
    for _, row in rated_rows.iterrows():
        meta = cache.get(_cache_key(row)) or {}
        rating = row.get("Rating")

        def rating_only(bucket, name, _row):
            bump_rating(bucket, name, rating)

        apply_meta(rating_only, row, meta)

    countries_c, countries_r = _paired_ranks(
        countries, min_count=1, limit_count=TOP_N_DEFAULT, limit_rating=TOP_N_DEFAULT
    )
    directors_c, directors_r = _paired_ranks(
        directors,
        min_count=MIN_PERSON_COUNT,
        limit_count=TOP_N_DEFAULT,
        limit_rating=TOP_N_DEFAULT,
    )
    actors_c, actors_r = _paired_ranks(
        actors,
        min_count=MIN_PERSON_COUNT,
        limit_count=TOP_N_DEFAULT,
        limit_rating=TOP_N_DEFAULT,
    )
    languages_c, languages_r = _paired_ranks(
        languages, min_count=1, limit_count=TOP_N_DEFAULT, limit_rating=TOP_N_DEFAULT
    )
    companies_c, companies_r = _paired_ranks(
        companies,
        min_count=MIN_COMPANY_COUNT,
        limit_count=TOP_N_DEFAULT,
        limit_rating=TOP_N_DEFAULT,
    )
    return {
        "countries": countries_c,
        "countries_by_rating": countries_r,
        "directors": directors_c,
        "directors_by_rating": directors_r,
        "actors": actors_c,
        "actors_by_rating": actors_r,
        "languages": languages_c,
        "languages_by_rating": languages_r,
        "companies": companies_c,
        "companies_by_rating": companies_r,
    }


def rank_genres(
    catalog,
    film_ratings=None,
    diary=None,
    watched_only=None,
    limit_count=TOP_N_DEFAULT,
    limit_rating=TOP_N_DEFAULT,
):
    """Genre tops: catalog hits; avg from ratings.csv ∪ diary joined to catalog."""
    stats = defaultdict(lambda: {"count": 0, "rating_sum": 0.0, "rated": 0})
    for _, row in catalog.iterrows():
        for g in row.get("Genre list") or []:
            if g:
                stats[g]["count"] += 1
    if film_ratings is None:
        from letterboxd_export import merged_film_ratings

        film_ratings = merged_film_ratings(None, diary if diary is not None else catalog)
    rated_rows = ratings_for_catalog(catalog, film_ratings)
    # Map Name+Year → Genre list from catalog (already TMDB-enriched).
    genre_by_key = {}
    if "Genre list" in catalog.columns:
        for _, crow in catalog.drop_duplicates(subset=["Name", "Year"]).iterrows():
            genre_by_key[_cache_key(crow)] = crow.get("Genre list") or []
    for _, row in rated_rows.iterrows():
        rating = row.get("Rating")
        try:
            r = float(rating)
        except (TypeError, ValueError):
            continue
        if not (r > 0):
            continue
        genres = row.get("Genre list") or genre_by_key.get(_cache_key(row)) or []
        for g in genres:
            if not g:
                continue
            st = stats[g]
            st["rating_sum"] += r
            st["rated"] += 1
    by_count, by_rating = _paired_ranks(
        stats, min_count=1, limit_count=limit_count, limit_rating=limit_rating
    )
    total_hits = sum(int(st["count"]) for st in stats.values()) or 1
    for row in by_count:
        row["pct"] = round(100.0 * row["count"] / total_hits, 1)
    return by_count, by_rating


def _cache_meta_for_row(row, cache):
    key = f"{row['Name']}|||{int(row['Year']) if pd.notna(row['Year']) else ''}"
    return cache.get(key) or {}


def chart_watches_by_country(diary, cache, path: Path, top_n: int = TOP_N_DEFAULT) -> bool:
    """Stacked horizontal bars: top countries by watches, color = watch year."""
    footer = "Source: Letterboxd diary + TMDB metadata"

    def names_for_row(row):
        return list(_cache_meta_for_row(row, cache).get("countries") or [])

    return chart_diary_entity_stacked(
        diary,
        path,
        names_for_row=names_for_row,
        title="Страны производства — цвет = год просмотра",
        top_n=top_n,
        min_count=1,
        footer=footer,
    )


def chart_deep_count_tops(diary, cache, paths: dict) -> dict:
    """Watch-year stacked count charts for TMDB deep entities."""
    footer = "Source: Letterboxd diary + TMDB metadata"
    made = {}

    def names(field):
        def _fn(row):
            meta = _cache_meta_for_row(row, cache)
            if field == "languages":
                lang = (meta.get("original_language") or "").strip()
                return [lang] if lang else []
            if field == "cast":
                return list(meta.get("cast") or [])
            return list(meta.get(field) or [])

        return _fn

    specs = [
        (
            "watches_by_country",
            "countries",
            "Страны производства — цвет = год просмотра",
            TOP_N_DEFAULT,
            1,
            None,
        ),
        (
            "watches_by_director",
            "directors",
            "Режиссёры — цвет = год просмотра",
            TOP_N_DEFAULT,
            MIN_PERSON_COUNT,
            None,
        ),
        (
            "watches_by_actor",
            "cast",
            "Актёры (top-billed) — цвет = год просмотра",
            TOP_N_DEFAULT,
            MIN_PERSON_COUNT,
            None,
        ),
        (
            "watches_by_language",
            "languages",
            "Язык оригинала — цвет = год просмотра",
            TOP_N_DEFAULT,
            1,
            display_lang,
        ),
        (
            "watches_by_studio",
            "companies",
            "Студии — цвет = год просмотра",
            TOP_N_DEFAULT,
            MIN_COMPANY_COUNT,
            None,
        ),
    ]
    for key, field, title, top_n, min_count, label_fn in specs:
        path = paths.get(key)
        if not path:
            continue
        # Country also exposed via chart_watches_by_country for back-compat.
        made[key] = chart_diary_entity_stacked(
            diary,
            Path(path),
            names_for_row=names(field),
            title=title,
            top_n=top_n,
            min_count=min_count,
            label_fn=label_fn,
            footer=footer,
        )
    return made


def chart_deep_rating_tops(deep: dict, paths: dict) -> dict:
    """Blue→green→red vertical avg-rating charts for TMDB «выше оценка» tops."""
    footer = "Source: Letterboxd diary/watched + TMDB metadata"
    made = {}
    specs = [
        ("average_rating_by_country", "countries_by_rating", "Страны — выше оценка", None),
        ("average_rating_by_director", "directors_by_rating", "Режиссёры — выше оценка", None),
        ("average_rating_by_actor", "actors_by_rating", "Актёры — выше оценка", None),
        (
            "average_rating_by_language",
            "languages_by_rating",
            "Язык оригинала — выше оценка",
            display_lang,
        ),
        ("average_rating_by_studio", "companies_by_rating", "Студии — выше оценка", None),
    ]
    for key, src, title, label_fn in specs:
        path = paths.get(key)
        if not path:
            continue
        made[key] = chart_rating_vbar(
            deep.get(src) or [],
            Path(path),
            title=f"{title} (больше 3 оценённых фильмов)",
            label_fn=label_fn,
            footer=footer,
            limit=TOP_N_DEFAULT,
        )
    return made

def _attach_tmdb_columns(frame, cache):
    """Add Genre list / countries / directors from TMDB cache onto a frame."""
    out = frame.copy()

    def get_meta(row):
        key = f"{row['Name']}|||{int(row['Year']) if pd.notna(row['Year']) else ''}"
        return cache.get(key, empty_tmdb_entry())

    metadata = out.apply(get_meta, axis=1)
    out["TMDB ID"] = metadata.apply(lambda x: x.get("tmdb_id"))
    out["TMDB genres"] = metadata.apply(lambda x: ", ".join(x.get("genres", [])))
    out["Genre list"] = metadata.apply(lambda x: x.get("genres", []))
    out["Countries"] = metadata.apply(lambda x: x.get("countries", []))
    out["Directors"] = metadata.apply(lambda x: x.get("directors", []))
    return out


def main():
    if len(sys.argv) < 2:
        print("Usage: python letterboxd_genre_charts.py path/to/letterboxd-export.zip")
        sys.exit(2)
    if not TOKEN:
        print("Не задан TMDB_BEARER_TOKEN. Получите Read Access Token в Settings → API на TMDB и задайте переменную окружения.")
        sys.exit(2)

    diary, catalog, watched_only, film_ratings = load_export(sys.argv[1])
    cache = json.loads(CACHE_PATH.read_text(encoding="utf-8")) if CACHE_PATH.exists() else {}
    # Enrich unique titles across diary ∪ watched.
    films = catalog[["Name", "Year"]].drop_duplicates().reset_index(drop=True)
    total = len(films)
    progress = TelegramProgress(TG_TOKEN, TG_CHAT)
    print(
        f"Обогащаю TMDB {total} уникальных сочетаний «название + год»…"
        f" (watched-only: {len(watched_only)}, rated films: {len(film_ratings)})"
    )
    progress.update(0, total, force=True)
    done = 0
    resolved = 0
    for i, row in films.iterrows():
        name, year = row["Name"], row["Year"]
        if not name:
            continue
        key = f"{name}|||{int(year) if pd.notna(year) else ''}"
        try:
            # Always call: fills new titles and upgrades legacy genre-only cache.
            find_tmdb(name, year, cache)
        except Exception as e:
            print(f"Ошибка для {name} ({year}): {e}")
            if key not in cache:
                cache[key] = empty_tmdb_entry()
        done += 1
        entry = cache.get(key) or {}
        if entry.get("genres"):
            resolved += 1
        # Progress: unique titles looked up so far / total (Telegram edits one message).
        progress.update(done, total, force=(done >= total))
        if done % 25 == 0:
            save_cache(cache)
            print(f"  {done}/{total} (с жанрами {resolved})")
    save_cache(cache)
    progress.update(done, total, force=True)

    diary = _attach_tmdb_columns(diary, cache)
    catalog = _attach_tmdb_columns(catalog, cache)
    watched_only = _attach_tmdb_columns(watched_only, cache) if len(watched_only) else watched_only
    catalog.to_csv("letterboxd_with_genres.csv", index=False)

    unmatched = catalog[catalog["Genre list"].apply(len) == 0][["Name", "Year"]].drop_duplicates()
    unmatched.to_csv("tmdb_unmatched.csv", index=False)

    progress.finish(f"TMDB: {resolved}/{total}. Строю графики…")

    # Dark theme already applied via apply_dark_chart_theme().
    footer = "Source: Letterboxd diary/watched + TMDB metadata"
    years = sorted(diary["Watched Date"].dt.year.dropna().astype(int).unique())

    # 1) Stacked yearly counts — diary only (need watch year).
    all_genres_diary = [g for genres in diary["Genre list"] for g in genres]
    top_genres = [g for g, _ in Counter(all_genres_diary).most_common(12)]
    yearly = {}
    for y in years:
        subset = diary[diary["Watched Date"].dt.year == y]
        yearly[y] = {g: int(subset["Genre list"].apply(lambda gs: g in gs).sum()) for g in top_genres}
    fig, ax = plt.subplots(figsize=(15, 7))
    bottom = np.zeros(len(years))
    colors = plt.cm.turbo(np.linspace(0.03, 0.97, max(1, len(top_genres))))
    for idx, genre in enumerate(top_genres):
        vals = np.array([yearly[y][genre] for y in years])
        ax.bar(years, vals, bottom=bottom, label=genre, color=colors[idx], width=0.82)
        bottom += vals
    ax.set_title("Количество просмотров по жанрам и годам")
    ax.set_xlabel("Год просмотра"); ax.set_ylabel("Просмотры (жанры суммируются)")
    ax.set_xticks(years); ax.tick_params(axis="x", rotation=45)
    leg = ax.legend(
        title="12 самых частых жанров",
        bbox_to_anchor=(1.02, 1),
        loc="upper left",
        labelcolor=FG,
    )
    if leg is not None and leg.get_title() is not None:
        leg.get_title().set_color(FG)
    style_axes(ax)
    fig.text(0.01, 0.01, footer, fontsize=7, color=FG)
    fig.tight_layout(rect=[0, 0.03, 0.84, 1])
    save_dark_figure(fig, "genre_counts_by_viewing_year.png")
    plt.close(fig)

    # 2) Mean personal rating per genre — ratings.csv ∪ diary joined to catalog.
    rated = ratings_for_catalog(catalog, film_ratings)
    if not rated.empty:
        rated = _attach_tmdb_columns(rated, cache)
    all_genres_catalog = [g for genres in catalog["Genre list"] for g in genres]
    rows = []
    for genre in sorted(set(all_genres_catalog)):
        if rated.empty:
            break
        vals = rated[rated["Genre list"].apply(lambda gs: genre in (gs or []))]["Rating"]
        if len(vals) >= 5:
            rows.append((genre, float(vals.mean()), int(len(vals))))
    avg = pd.DataFrame(rows, columns=["Genre", "Average rating", "Rated films"])
    # Highest first (left → right); cap near TOP_N_DEFAULT.
    avg = avg.sort_values("Average rating", ascending=False).head(TOP_N_DEFAULT)
    fig, ax = plt.subplots(figsize=(max(10.0, len(avg) * 0.55), 6.5))
    if len(avg):
        values = avg["Average rating"].astype(float).tolist()
        bar_colors = color_bars_by_rating(values)
        x = np.arange(len(avg))
        bars = ax.bar(x, values, color=bar_colors, width=0.78, edgecolor="none")
        ax.set_xticks(x)
        ax.set_xticklabels(avg["Genre"].tolist(), rotation=45, ha="right")
        ax.set_ylim(0, 5.2)
        ax.set_ylabel("Средняя личная оценка (из 5)")
        ax.set_title("Средняя оценка по жанрам (минимум 5 оценённых фильмов)")
        ax.yaxis.grid(True, color="#2A2A2A", linewidth=0.8)
        ax.set_axisbelow(True)
        for bar, (_, r) in zip(bars, avg.iterrows()):
            ax.text(
                bar.get_x() + bar.get_width() / 2,
                r["Average rating"] + 0.08,
                f'{r["Average rating"]:.2f}\nn={int(r["Rated films"])}',
                ha="center",
                va="bottom",
                fontsize=7,
                color=FG,
            )
        add_rating_colorbar(fig, ax)
    style_axes(ax)
    fig.text(0.01, 0.01, footer, fontsize=7, color=FG)
    fig.tight_layout(rect=[0, 0.03, 1, 1])
    save_dark_figure(fig, "average_rating_by_genre.png")
    plt.close(fig)

    # 3) Counts by release decade — catalog (no watch-year stack).
    release_decades = {}
    for _, row in catalog.iterrows():
        meta = cache.get(f"{row['Name']}|||{int(row['Year']) if pd.notna(row['Year']) else ''}", {})
        ry = meta.get("tmdb_release_year")
        if ry and meta.get("genres"):
            decade = (int(ry) // 10) * 10
            for genre in meta["genres"]:
                release_decades[(decade, genre)] = release_decades.get((decade, genre), 0) + 1
    decade_df = pd.DataFrame(
        [{"Decade": d, "Genre": g, "Views": n} for (d, g), n in release_decades.items()]
    )
    if not decade_df.empty:
        common = decade_df.groupby("Genre")["Views"].sum().nlargest(10).index
        p = decade_df[decade_df["Genre"].isin(common)].pivot_table(index="Decade", columns="Genre", values="Views", aggfunc="sum", fill_value=0).sort_index()
        fig, ax = plt.subplots(figsize=(13, 6))
        p.plot(kind="bar", stacked=True, ax=ax, colormap="turbo", width=0.82)
        ax.set_title("Просмотры по десятилетию выхода фильма и жанру")
        ax.set_xlabel("Десятилетие выхода"); ax.set_ylabel("Количество просмотров")
        leg = ax.legend(
            title="10 самых частых жанров",
            bbox_to_anchor=(1.02, 1),
            loc="upper left",
            labelcolor=FG,
        )
        if leg is not None and leg.get_title() is not None:
            leg.get_title().set_color(FG)
        style_axes(ax)
        fig.text(0.01, 0.01, footer, fontsize=7, color=FG)
        fig.tight_layout(rect=[0, 0.03, 0.83, 1])
        save_dark_figure(fig, "genre_by_release_decade.png")
        plt.close(fig)

    # 4) Genre share within each viewing year — diary only.
    top10 = [g for g, _ in Counter(all_genres_diary).most_common(10)]
    matrix = []
    for y in years:
        subset = diary[diary["Watched Date"].dt.year == y]
        n = len(subset)
        matrix.append([100 * subset["Genre list"].apply(lambda gs: g in gs).sum() / n if n else 0 for g in top10])
    if years and top10:
        fig, ax = plt.subplots(figsize=(13, 6))
        im = ax.imshow(np.array(matrix).T, aspect="auto", cmap="turbo", interpolation="nearest")
        ax.set_yticks(range(len(top10))); ax.set_yticklabels(top10)
        ax.set_xticks(range(len(years))); ax.set_xticklabels(years, rotation=45)
        ax.set_title("Доля просмотров каждого жанра по годам (%)")
        ax.set_xlabel("Год просмотра")
        cb = fig.colorbar(im, ax=ax)
        cb.set_label("% просмотров за год с этим жанром", color=FG)
        cb.ax.yaxis.set_tick_params(color=FG)
        plt.setp(plt.getp(cb.ax.axes, "yticklabels"), color=FG)
        style_axes(ax)
        fig.text(0.01, 0.01, footer, fontsize=7, color=FG)
        fig.tight_layout(rect=[0, 0.03, 1, 1])
        save_dark_figure(fig, "genre_share_by_viewing_year.png")
        plt.close(fig)

    # HTML tops: catalog counts + ratings.csv ∪ diary.
    top_for_report, genres_by_rating = rank_genres(
        catalog,
        film_ratings=film_ratings,
        diary=diary,
        watched_only=watched_only,
        limit_count=TOP_N_DEFAULT,
        limit_rating=TOP_N_DEFAULT,
    )

    deep = aggregate_person_stats(
        catalog, cache, film_ratings=film_ratings, diary=diary, watched_only=watched_only
    )
    # Count tops: diary watches stacked by watch year (same spirit as countries).
    count_paths = {
        "watches_by_country": "watches_by_country.png",
        "watches_by_director": "watches_by_director.png",
        "watches_by_actor": "watches_by_actor.png",
        "watches_by_language": "watches_by_language.png",
        "watches_by_studio": "watches_by_studio.png",
    }
    made_counts = chart_deep_count_tops(diary, cache, count_paths)
    rating_paths = {
        "average_rating_by_country": "average_rating_by_country.png",
        "average_rating_by_director": "average_rating_by_director.png",
        "average_rating_by_actor": "average_rating_by_actor.png",
        "average_rating_by_language": "average_rating_by_language.png",
        "average_rating_by_studio": "average_rating_by_studio.png",
    }
    made_ratings = chart_deep_rating_tops(deep, rating_paths)

    genre_summary = {
        "unique_titles": int(total),
        "watched_only_films": int(len(watched_only)),
        "resolved": int(resolved),
        "unmatched": int(len(unmatched)),
        "top_genres": top_for_report,
        "top_genres_by_rating": genres_by_rating,
        "genre_hits": int(len(all_genres_catalog)),
        "countries": deep.get("countries") or [],
        "countries_by_rating": deep.get("countries_by_rating") or [],
        "directors": deep.get("directors") or [],
        "directors_by_rating": deep.get("directors_by_rating") or [],
        "actors": deep.get("actors") or [],
        "actors_by_rating": deep.get("actors_by_rating") or [],
        "languages": deep.get("languages") or [],
        "languages_by_rating": deep.get("languages_by_rating") or [],
        "companies": deep.get("companies") or [],
        "companies_by_rating": deep.get("companies_by_rating") or [],
        "min_person_count": int(MIN_PERSON_COUNT),
        "min_rated_for_top": int(MIN_RATED_FOR_TOP),
        "charts": {**{k: bool(v) for k, v in made_counts.items()}, **{k: bool(v) for k, v in made_ratings.items()}},
    }
    Path("genre_summary.json").write_text(
        json.dumps(genre_summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print("\nГотово. Созданы файлы:")
    for f in [
        "genre_counts_by_viewing_year.png",
        "average_rating_by_genre.png",
        "genre_by_release_decade.png",
        "genre_share_by_viewing_year.png",
        *count_paths.values(),
        *rating_paths.values(),
        "letterboxd_with_genres.csv",
        "tmdb_unmatched.csv",
        "genre_summary.json",
    ]:
        if Path(f).exists():
            print(" -", f)
    print(f"Фильмов/сочетаний без найденных жанров: {len(unmatched)}")
    print(f"Watched-only (не в diary): {len(watched_only)}")
    print("TMDB data attribution: https://www.themoviedb.org/")
    progress.finish("Готово, шлю графики.")

if __name__ == "__main__":
    main()
