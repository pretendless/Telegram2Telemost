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
  letterboxd_with_genres.csv
  tmdb_unmatched.csv

TMDB attribution is included in chart footers. Use of TMDB data is subject to its terms.
"""
import os, sys, json, time, zipfile, urllib.parse, urllib.request, urllib.error
from pathlib import Path
from collections import Counter
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

def find_tmdb(name, year, cache):
    key = f"{name}|||{int(year) if pd.notna(year) else ''}"
    if key in cache:
        return cache[key]
    params = {"query": name, "include_adult": "true"}
    if pd.notna(year):
        params["year"] = int(year)
    url = BASE + "/search/movie?" + urllib.parse.urlencode(params)
    data = request_json(url)
    results = data.get("results", [])
    if not results:
        cache[key] = {"tmdb_id": None, "genres": []}
        return cache[key]

    target_year = int(year) if pd.notna(year) else None
    # Prefer exact year; then closest year; then most popular result.
    def score(r):
        ry = year_of_release(r)
        exact = 1 if target_year is not None and ry == target_year else 0
        distance = abs(ry - target_year) if target_year is not None and ry is not None else 9999
        return (exact, -distance, r.get("popularity", 0))
    best = max(results, key=score)
    details = request_json(f"{BASE}/movie/{best['id']}")
    out = {
        "tmdb_id": best["id"],
        "tmdb_title": details.get("title", best.get("title", "")),
        "tmdb_release_year": year_of_release(details),
        "genres": [g["name"] for g in details.get("genres", [])]
    }
    cache[key] = out
    time.sleep(0.12)
    return out

def save_cache(cache):
    CACHE_PATH.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")

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
    print(f"Обогащаю жанрами {total} уникальных сочетаний «название + год»…")
    progress.update(0, total, force=True)
    done = 0
    resolved = 0
    for i, row in films.iterrows():
        name, year = row["Name"], row["Year"]
        if not name:
            continue
        key = f"{name}|||{int(year) if pd.notna(year) else ''}"
        if key not in cache:
            try:
                find_tmdb(name, year, cache)
            except Exception as e:
                print(f"Ошибка для {name} ({year}): {e}")
                if key not in cache:
                    cache[key] = {"tmdb_id": None, "genres": []}
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
        return cache.get(key, {"tmdb_id": None, "genres": []})
    metadata = diary.apply(get_meta, axis=1)
    diary["TMDB ID"] = metadata.apply(lambda x: x.get("tmdb_id"))
    diary["TMDB genres"] = metadata.apply(lambda x: ", ".join(x.get("genres", [])))
    diary["Genre list"] = metadata.apply(lambda x: x.get("genres", []))
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

    # Compact genre stats for the Telegram HTML report.
    genre_total_hits = len(all_genres)
    top_for_report = []
    for g, c in Counter(all_genres).most_common(8):
        pct = round(100.0 * c / genre_total_hits, 1) if genre_total_hits else 0.0
        top_for_report.append({"name": g, "count": int(c), "pct": pct})
    genre_summary = {
        "unique_titles": int(total),
        "resolved": int(resolved),
        "unmatched": int(len(unmatched)),
        "top_genres": top_for_report,
        "genre_hits": int(genre_total_hits),
    }
    Path("genre_summary.json").write_text(
        json.dumps(genre_summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print("\nГотово. Созданы файлы:")
    for f in ["genre_counts_by_viewing_year.png", "average_rating_by_genre.png",
              "genre_by_release_decade.png", "genre_share_by_viewing_year.png",
              "letterboxd_with_genres.csv", "tmdb_unmatched.csv", "genre_summary.json"]:
        if Path(f).exists():
            print(" -", f)
    print(f"Фильмов/сочетаний без найденных жанров: {len(unmatched)}")
    print("TMDB data attribution: https://www.themoviedb.org/")
    progress.finish("Готово, шлю графики.")

if __name__ == "__main__":
    main()
