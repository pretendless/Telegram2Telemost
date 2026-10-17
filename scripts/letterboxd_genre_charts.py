#!/usr/bin/env python3
"""
Letterboxd genre charts via TMDB.

Usage:
  1) Install: pip install pandas matplotlib
  2) Set TMDB_BEARER_TOKEN in your environment (TMDB Settings -> API).
  3) Run: python letterboxd_genre_charts.py path/to/letterboxd-export.zip

Optional Telegram progress (Actions /letterboxd): TG2TMBOT_TOKEN + CHAT_ID.
Edits one message «Жанры: N/total…» during enrichment; does not print tokens.

Creates:
  genre_counts_by_viewing_year.png
  average_rating_by_genre.png
  genre_by_release_decade.png
  genre_share_by_viewing_year.png
  watches_by_country.png
  letterboxd_with_genres.csv
  tmdb_unmatched.csv
  genre_summary.json

TMDB attribution is included in chart footers. Use of TMDB data is subject to its terms.
"""
import os, sys, json, time, zipfile, urllib.parse, urllib.request, urllib.error
from pathlib import Path
from collections import Counter, defaultdict
import pandas as pd
import matplotlib.pyplot as plt
import numpy as np

BASE = "https://api.themoviedb.org/3"
CACHE_PATH = Path("tmdb_genre_cache.json")
TOKEN = os.getenv("TMDB_BEARER_TOKEN", "").strip()
# Optional Telegram progress (Actions /letterboxd). Never log token values.
TG_TOKEN = (os.getenv("TG2TMBOT_TOKEN") or os.getenv("TELEGRAM_BOT_TOKEN") or "").strip()
TG_CHAT = (os.getenv("CHAT_ID") or os.getenv("LETTERBOXD_CHAT_ID") or "").strip()
PROGRESS_EVERY = max(1, int(os.getenv("LETTERBOXD_PROGRESS_EVERY", "25") or "25"))
PROGRESS_MIN_SEC = max(5.0, float(os.getenv("LETTERBOXD_PROGRESS_MIN_SEC", "45") or "45"))
# Min diary hits before a person/company appears in ranked HTML lists.
MIN_PERSON_COUNT = max(2, int(os.getenv("LETTERBOXD_MIN_PERSON_COUNT", "3") or "3"))
MIN_COMPANY_COUNT = max(2, int(os.getenv("LETTERBOXD_MIN_COMPANY_COUNT", "3") or "3"))
CAST_TOP_BILLED = max(1, int(os.getenv("LETTERBOXD_CAST_TOP", "5") or "5"))


def format_genre_progress(done, total):
    """User-facing progress: unique titles processed so far / total unique titles."""
    d = max(0, int(done))
    t = max(0, int(total))
    return f"Жанры: {d}/{t}…"


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

def load_diary(zip_path):
    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()
        diary_name = next((n for n in names if n.lower().endswith("diary.csv")), None)
        if not diary_name:
            raise RuntimeError("В ZIP не найден diary.csv")
        with zf.open(diary_name) as f:
            df = pd.read_csv(f)
    required = {"Name", "Year", "Watched Date"}
    if not required.issubset(df.columns):
        raise RuntimeError(f"В diary.csv не хватает колонок: {required - set(df.columns)}")
    df["Name"] = df["Name"].fillna("").astype(str).str.strip()
    df["Year"] = pd.to_numeric(df["Year"], errors="coerce")
    df["Watched Date"] = pd.to_datetime(df["Watched Date"], errors="coerce")
    if "Rating" in df.columns:
        df["Rating"] = pd.to_numeric(df["Rating"], errors="coerce")
    else:
        df["Rating"] = np.nan
    return df

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


def _rank_named(stats, min_count, limit=8, by_avg=False):
    """stats: name -> {count, rating_sum, rated}. Return sorted list of dicts."""
    rows = []
    for name, st in stats.items():
        count = int(st.get("count") or 0)
        if count < min_count:
            continue
        rated = int(st.get("rated") or 0)
        avg = round(st["rating_sum"] / rated, 2) if rated else None
        rows.append({"name": name, "count": count, "avg": avg, "rated": rated})
    if by_avg:
        rows.sort(key=lambda r: (-(r["avg"] if r["avg"] is not None else -1), -r["count"], r["name"]))
    else:
        rows.sort(key=lambda r: (-r["count"], -(r["avg"] if r["avg"] is not None else -1), r["name"]))
    return rows[:limit]


def aggregate_person_stats(diary, cache):
    """Watch-count / avg-rating aggregates for countries, directors, cast, langs, companies."""
    countries = defaultdict(lambda: {"count": 0, "rating_sum": 0.0, "rated": 0})
    directors = defaultdict(lambda: {"count": 0, "rating_sum": 0.0, "rated": 0})
    actors = defaultdict(lambda: {"count": 0, "rating_sum": 0.0, "rated": 0})
    languages = defaultdict(lambda: {"count": 0, "rating_sum": 0.0, "rated": 0})
    companies = defaultdict(lambda: {"count": 0, "rating_sum": 0.0, "rated": 0})

    def bump(bucket, name, rating):
        if not name:
            return
        st = bucket[name]
        st["count"] += 1
        if rating is not None and not (isinstance(rating, float) and np.isnan(rating)):
            try:
                r = float(rating)
            except (TypeError, ValueError):
                return
            if r > 0:
                st["rating_sum"] += r
                st["rated"] += 1

    for _, row in diary.iterrows():
        key = f"{row['Name']}|||{int(row['Year']) if pd.notna(row['Year']) else ''}"
        meta = cache.get(key) or {}
        rating = row.get("Rating")
        for c in meta.get("countries") or []:
            bump(countries, c, rating)
        for d in meta.get("directors") or []:
            bump(directors, d, rating)
        for a in meta.get("cast") or []:
            bump(actors, a, rating)
        for co in meta.get("companies") or []:
            bump(companies, co, rating)
        lang = (meta.get("original_language") or "").strip()
        if lang:
            bump(languages, lang, rating)

    return {
        "countries": _rank_named(countries, min_count=1, limit=10),
        "directors": _rank_named(directors, min_count=MIN_PERSON_COUNT, limit=8),
        "directors_by_rating": _rank_named(
            directors, min_count=MIN_PERSON_COUNT, limit=5, by_avg=True
        ),
        "actors": _rank_named(actors, min_count=MIN_PERSON_COUNT, limit=8),
        "languages": _rank_named(languages, min_count=1, limit=8),
        "companies": _rank_named(companies, min_count=MIN_COMPANY_COUNT, limit=6),
    }


def chart_watches_by_country(country_rows, path: Path) -> bool:
    """Horizontal bar of top production countries by diary watches."""
    rows = [r for r in (country_rows or []) if r.get("count")]
    if not rows:
        return False
    rows = list(reversed(rows[:12]))
    labels = [str(r["name"]) for r in rows]
    values = [int(r["count"]) for r in rows]
    fig, ax = plt.subplots(figsize=(10, max(4, len(labels) * 0.4)))
    y = np.arange(len(labels))
    ax.barh(y, values, color="#4C78A8", height=0.72)
    ax.set_yticks(y)
    ax.set_yticklabels(labels)
    ax.set_xlabel("Просмотры")
    ax.set_title("Страны производства (TMDB)")
    ax.xaxis.grid(True, color="#dddddd", linewidth=0.8)
    ax.set_axisbelow(True)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    xmax = max(values) if values else 1
    ax.set_xlim(0, xmax * 1.15)
    for yi, value in zip(y, values):
        ax.text(value + xmax * 0.02, yi, str(value), va="center", fontsize=9)
    fig.text(0.01, 0.01, "Source: Letterboxd diary + TMDB metadata", fontsize=7)
    fig.tight_layout(rect=[0, 0.03, 1, 1])
    fig.savefig(path, bbox_inches="tight")
    plt.close(fig)
    return True

def main():
    if len(sys.argv) < 2:
        print("Usage: python letterboxd_genre_charts.py path/to/letterboxd-export.zip")
        sys.exit(2)
    if not TOKEN:
        print("Не задан TMDB_BEARER_TOKEN. Получите Read Access Token в Settings → API на TMDB и задайте переменную окружения.")
        sys.exit(2)

    diary = load_diary(sys.argv[1])
    cache = json.loads(CACHE_PATH.read_text(encoding="utf-8")) if CACHE_PATH.exists() else {}
    films = diary[["Name", "Year"]].drop_duplicates().reset_index(drop=True)
    total = len(films)
    progress = TelegramProgress(TG_TOKEN, TG_CHAT)
    print(f"Обогащаю TMDB {total} уникальных сочетаний «название + год»…")
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

    def get_meta(row):
        key = f"{row['Name']}|||{int(row['Year']) if pd.notna(row['Year']) else ''}"
        return cache.get(key, empty_tmdb_entry())
    metadata = diary.apply(get_meta, axis=1)
    diary["TMDB ID"] = metadata.apply(lambda x: x.get("tmdb_id"))
    diary["TMDB genres"] = metadata.apply(lambda x: ", ".join(x.get("genres", [])))
    diary["Genre list"] = metadata.apply(lambda x: x.get("genres", []))
    diary["Countries"] = metadata.apply(lambda x: x.get("countries", []))
    diary["Directors"] = metadata.apply(lambda x: x.get("directors", []))
    diary.to_csv("letterboxd_with_genres.csv", index=False)

    unmatched = diary[diary["Genre list"].apply(len) == 0][["Name", "Year"]].drop_duplicates()
    unmatched.to_csv("tmdb_unmatched.csv", index=False)

    progress.finish(f"Жанры: {resolved}/{total}. Строю графики…")

    # Plot defaults
    plt.rcParams.update({"figure.dpi": 150, "savefig.dpi": 180, "font.size": 9})
    footer = "Source: Letterboxd diary + TMDB metadata"
    years = sorted(diary["Watched Date"].dt.year.dropna().astype(int).unique())

    # 1) Stacked yearly counts for the 12 most common genres
    all_genres = [g for genres in diary["Genre list"] for g in genres]
    top_genres = [g for g, _ in Counter(all_genres).most_common(12)]
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
    ax.legend(title="12 самых частых жанров", bbox_to_anchor=(1.02, 1), loc="upper left")
    fig.text(0.01, 0.01, footer, fontsize=7)
    fig.tight_layout(rect=[0, 0.03, 0.84, 1])
    fig.savefig("genre_counts_by_viewing_year.png", bbox_inches="tight"); plt.close(fig)

    # 2) Mean personal rating per genre (rating is counted once per diary viewing)
    rated = diary[diary["Rating"].notna()]
    rows = []
    for genre in sorted(set(g for gs in diary["Genre list"] for g in gs)):
        vals = rated[rated["Genre list"].apply(lambda gs: genre in gs)]["Rating"]
        if len(vals) >= 5:
            rows.append((genre, float(vals.mean()), int(len(vals))))
    avg = pd.DataFrame(rows, columns=["Genre", "Average rating", "Rated viewings"])
    avg = avg.sort_values("Average rating")
    fig, ax = plt.subplots(figsize=(10, max(5, len(avg) * 0.32)))
    if len(avg):
        bars = ax.barh(avg["Genre"], avg["Average rating"], color=plt.cm.turbo(np.linspace(0.05, 0.95, len(avg))))
        ax.set_xlim(0, 5); ax.set_xlabel("Средняя личная оценка (из 5)")
        ax.set_title("Средняя оценка по жанрам (минимум 5 оценённых просмотров)")
        for bar, (_, r) in zip(bars, avg.iterrows()):
            ax.text(r["Average rating"] + 0.04, bar.get_y() + bar.get_height()/2,
                    f'{r["Average rating"]:.2f}  (n={int(r["Rated viewings"])})', va="center", fontsize=8)
    fig.text(0.01, 0.01, footer, fontsize=7)
    fig.tight_layout(rect=[0, 0.03, 1, 1])
    fig.savefig("average_rating_by_genre.png", bbox_inches="tight"); plt.close(fig)

    # 3) Counts by release decade
    release_decades = {}
    for _, row in diary.iterrows():
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
        ax.legend(title="10 самых частых жанров", bbox_to_anchor=(1.02, 1), loc="upper left")
        fig.text(0.01, 0.01, footer, fontsize=7)
        fig.tight_layout(rect=[0, 0.03, 0.83, 1])
        fig.savefig("genre_by_release_decade.png", bbox_inches="tight"); plt.close(fig)

    # 4) Genre share within each viewing year (top 10 genres)
    top10 = [g for g, _ in Counter(all_genres).most_common(10)]
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
        cb = fig.colorbar(im, ax=ax); cb.set_label("% просмотров за год с этим жанром")
        fig.text(0.01, 0.01, footer, fontsize=7)
        fig.tight_layout(rect=[0, 0.03, 1, 1])
        fig.savefig("genre_share_by_viewing_year.png", bbox_inches="tight"); plt.close(fig)

    # Compact genre + people/country stats for the Telegram HTML report.
    genre_total_hits = len(all_genres)
    top_for_report = []
    for g, c in Counter(all_genres).most_common(8):
        pct = round(100.0 * c / genre_total_hits, 1) if genre_total_hits else 0.0
        top_for_report.append({"name": g, "count": int(c), "pct": pct})

    deep = aggregate_person_stats(diary, cache)
    made_country = chart_watches_by_country(deep.get("countries"), Path("watches_by_country.png"))

    genre_summary = {
        "unique_titles": int(total),
        "resolved": int(resolved),
        "unmatched": int(len(unmatched)),
        "top_genres": top_for_report,
        "genre_hits": int(genre_total_hits),
        "countries": deep.get("countries") or [],
        "directors": deep.get("directors") or [],
        "directors_by_rating": deep.get("directors_by_rating") or [],
        "actors": deep.get("actors") or [],
        "languages": deep.get("languages") or [],
        "companies": deep.get("companies") or [],
        "min_person_count": int(MIN_PERSON_COUNT),
        "charts": {"watches_by_country": bool(made_country)},
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
        "watches_by_country.png",
        "letterboxd_with_genres.csv",
        "tmdb_unmatched.csv",
        "genre_summary.json",
    ]:
        if Path(f).exists():
            print(" -", f)
    print(f"Фильмов/сочетаний без найденных жанров: {len(unmatched)}")
    print("TMDB data attribution: https://www.themoviedb.org/")
    progress.finish("Готово, шлю графики.")

if __name__ == "__main__":
    main()
