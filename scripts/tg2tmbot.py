"""@tg2tmbot: pack format help, pack checks, and Telemost transfer notifications.

One message = one Telemost pack: first line is the title, then t.me/addstickers links, at most 150 stickers in total.

While running, the bot also watches packs/*/pack.json (written by scripts/telemost_upload.mjs):
- everyone who sent /start gets progress messages (pack started, every 25 %, errors, done + Telemost link);
- when a pack is done, it posts an announcement with the Telemost link to the channel @tg2tm.
Announcements contain no t.me/addstickers links, so they are never mistaken for pack submissions.

Token: config/tg2tmbot.token (git-ignored) or TG2TMBOT_TOKEN.
  python scripts/tg2tmbot.py --setup   # set description, about text and command list
  python scripts/tg2tmbot.py           # long-poll, answer messages, send notifications
"""

from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKS = ROOT / "packs"
TOKEN_FILE = ROOT / "config" / "tg2tmbot.token"
SUBSCRIBERS_FILE = ROOT / "config" / "tg2tmbot-subscribers.json"
STATE_FILE = ROOT / ".cache" / "tg2tmbot-state.json"
MAX_STICKERS = 150
CHANNEL = "https://t.me/tg2tm"
CHANNEL_CHAT = "@tg2tm"
WATCH_EVERY_S = 30
STEPS = (25, 50, 75)
LINK_RE = re.compile(r"(?:https?://)?t\.me/addstickers/([A-Za-z0-9_]+)")

EXAMPLE = (
    "Минто\n"
    "\n"
    "https://t.me/addstickers/minty_vk\n"
    "https://t.me/addstickers/minty2_vk"
)

FORMAT = (
    "Одно сообщение — один пак Телемоста.\n"
    "\n"
    "1. Первая строка — название пака.\n"
    "2. Дальше ссылки t.me/addstickers/…, по одной в строке. Порядок ссылок = порядок стикеров.\n"
    f"3. Всего не больше {MAX_STICKERS} стикеров: это лимит Телемоста на пак.\n"
    "\n"
    f"Готовые образцы — в канале {CHANNEL}"
)

START = (
    "Бот принимает паки стикеров для переноса из Telegram в Телемост.\n"
    "\n"
    + FORMAT
    + "\n\nПример (из канала):\n\n"
    + EXAMPLE
    + "\n\nПришлите сообщение в таком виде — бот проверит название, ссылки и число стикеров."
    "\n\nВы подписаны на ход переноса: бот напишет, когда пак начнёт загружаться, как идёт загрузка и пришлёт ссылку на готовый пак в Телемосте. /status — текущее состояние, /stop — отписаться."
)

DESCRIPTION = (
    "Перенос стикеров из Telegram в Яндекс Телемост.\n\n"
    "Одно сообщение — один пак: первая строка — название, дальше ссылки t.me/addstickers/… по порядку, "
    f"всего до {MAX_STICKERS} стикеров.\n\n"
    "Пример:\n" + EXAMPLE + "\n\n"
    "Бот сообщает о ходе загрузки и присылает ссылку на готовый пак.\n\n"
    f"Образцы и готовые паки: {CHANNEL}"
)
ABOUT = f"Пак = сообщение: название + ссылки t.me/addstickers, до {MAX_STICKERS} стикеров. Образцы: t.me/tg2tm"
COMMANDS = [
    {"command": "start", "description": "Как оформить пак и пример; подписка на прогресс"},
    {"command": "status", "description": "Ход переноса паков в Телемост"},
    {"command": "format", "description": "Формат сообщения: название + ссылки"},
    {"command": "example", "description": "Пример из канала t.me/tg2tm"},
    {"command": "stop", "description": "Отписаться от уведомлений"},
]


def token() -> str:
    value = os.environ.get("TG2TMBOT_TOKEN") or (TOKEN_FILE.read_text().strip() if TOKEN_FILE.exists() else "")
    if not value:
        sys.exit(f"no token: set TG2TMBOT_TOKEN or create {TOKEN_FILE.relative_to(ROOT)}")
    return value


TOKEN = token()
LOCK = threading.Lock()


def api(method: str, http_timeout: int = 60, **params):
    data = urllib.parse.urlencode({k: json.dumps(v) if isinstance(v, (list, dict)) else v for k, v in params.items()}).encode()
    req = urllib.request.Request(f"https://api.telegram.org/bot{TOKEN}/{method}", data=data)
    with urllib.request.urlopen(req, timeout=http_timeout) as r:
        body = json.load(r)
    if not body.get("ok"):
        raise RuntimeError(body)
    return body["result"]


def send(chat_id, text: str) -> None:
    api("sendMessage", chat_id=chat_id, text=text, link_preview_options={"is_disabled": True})


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def subscribers() -> list[int]:
    return load_json(SUBSCRIBERS_FILE, [])


def set_subscribed(chat_id: int, on: bool) -> None:
    with LOCK:
        subs = [s for s in subscribers() if s != chat_id]
        if on:
            subs.append(chat_id)
        save_json(SUBSCRIBERS_FILE, subs)


def notify(text: str) -> None:
    for chat_id in subscribers():
        try:
            send(chat_id, text)
        except Exception as exc:
            print("notify failed:", chat_id, repr(exc), file=sys.stderr, flush=True)


def setup() -> None:
    api("setMyDescription", description=DESCRIPTION)
    api("setMyShortDescription", short_description=ABOUT)
    api("setMyCommands", commands=COMMANDS)
    print("description, about text and commands set")


def check_pack(text: str) -> str:
    lines = [ln.strip() for ln in text.strip().splitlines()]
    title = next((ln for ln in lines if ln), "")
    names = []
    for ln in lines:
        for name in LINK_RE.findall(ln):
            if name not in names:
                names.append(name)
    if not names or LINK_RE.search(title):
        return "Не похоже на пак. Нужно: первая строка — название, дальше ссылки t.me/addstickers/….\n\nПример:\n\n" + EXAMPLE

    total = 0
    rows = []
    for name in names:
        try:
            count = len(api("getStickerSet", name=name)["stickers"])
            total += count
            rows.append(f"• {name} — {count}")
        except Exception:
            rows.append(f"• {name} — набор не найден")
    verdict = (
        f"Всего {total} стикеров — укладывается в лимит {MAX_STICKERS}."
        if total <= MAX_STICKERS
        else f"Всего {total} стикеров — больше лимита {MAX_STICKERS}. Разбейте на два сообщения."
    )
    return f"Пак «{title}»\n\n" + "\n".join(rows) + "\n\n" + verdict


def read_packs() -> list[dict]:
    out = []
    for path in sorted(PACKS.glob("*/pack.json")):
        meta = load_json(path, None)
        if not meta:
            continue
        tm = meta.get("telemost") or {}
        total = len(meta.get("images") or []) or meta.get("stickerCount") or 0
        out.append({
            "slug": meta.get("slug") or path.parent.name,
            "title": meta.get("title", path.parent.name),
            "source": meta.get("sourceMessage"),
            "status": tm.get("status", "pending"),
            "uploaded": tm.get("uploaded", 0) or 0,
            "total": total,
            "url": tm.get("packUrl"),
            "error": tm.get("error"),
        })
    return out


STATUS_RU = {"pending": "ждёт", "uploading": "загружается", "done": "готов", "error": "ошибка"}


def status_text() -> str:
    rows = []
    for p in read_packs():
        line = f"{STATUS_RU.get(p['status'], p['status'])}: «{p['title']}» — {p['uploaded']}/{p['total']}"
        if p["url"]:
            line += f"\n   {p['url']}"
        rows.append(line)
    done = sum(1 for p in read_packs() if p["status"] == "done")
    return f"Перенос в Телемост: готово {done} из {len(rows)}\n\n" + "\n".join(rows)


def channel_post(p: dict) -> str:
    text = f"Новый пак в Телемосте: «{p['title']}»\n\n{p['total']} стикеров\n{p['url']}"
    if p["source"]:
        text += f"\n\nСписок стикеров: {p['source']}"
    return text


def watch_once(state: dict) -> None:
    for p in read_packs():
        s = state.setdefault(p["slug"], {"started": False, "step": 0, "done": False, "posted": False, "error": None})
        pct = int(100 * p["uploaded"] / p["total"]) if p["total"] else 0

        if p["status"] in ("uploading", "done") and not s["started"]:
            s["started"] = True
            notify(f"Начата загрузка пака «{p['title']}» в Телемост: {p['uploaded']}/{p['total']}.")

        if p["status"] == "uploading":
            reached = max([step for step in STEPS if pct >= step], default=0)
            if reached > s["step"]:
                s["step"] = reached
                notify(f"«{p['title']}»: {p['uploaded']}/{p['total']} ({reached} %).")

        if p["status"] == "error" and p["error"] != s["error"]:
            s["error"] = p["error"]
            notify(f"Ошибка в паке «{p['title']}»: {p['error']}. Загрузка остановлена на {p['uploaded']}/{p['total']}; перезапуск продолжит с этого места.")

        if p["status"] == "done" and not s["done"]:
            s["done"] = True
            link = p["url"] or "ссылка не пришла от бота Телемоста, ищите пак в чате «Стикеры»"
            notify(f"Готово: пак «{p['title']}» в Телемосте, {p['total']} стикеров.\n{link}")

        if p["status"] == "done" and p["url"] and not s["posted"]:
            try:
                api("sendMessage", chat_id=CHANNEL_CHAT, text=channel_post(p))
                s["posted"] = True
            except Exception as exc:
                print("channel post failed:", p["slug"], repr(exc), file=sys.stderr, flush=True)


def watch_forever() -> None:
    while True:
        try:
            with LOCK:
                state = load_json(STATE_FILE, {})
            watch_once(state)
            with LOCK:
                save_json(STATE_FILE, state)
        except Exception as exc:
            print("watch failed:", repr(exc), file=sys.stderr, flush=True)
        time.sleep(WATCH_EVERY_S)


def reply(update: dict) -> None:
    msg = update.get("message")
    if not msg or "text" not in msg:
        return
    chat_id = msg["chat"]["id"]
    text = msg["text"]
    cmd = text.split()[0].split("@")[0].lower() if text.startswith("/") else ""
    if cmd in ("/start", "/help"):
        set_subscribed(chat_id, True)
        out = START
    elif cmd == "/stop":
        set_subscribed(chat_id, False)
        out = "Уведомления выключены. /start — включить снова."
    elif cmd == "/status":
        out = status_text()
    elif cmd == "/format":
        out = FORMAT
    elif cmd == "/example":
        out = "Пример из канала:\n\n" + EXAMPLE
    else:
        out = check_pack(text)
    send(chat_id, out)


def run() -> None:
    threading.Thread(target=watch_forever, daemon=True).start()
    offset = 0
    while True:
        try:
            for upd in api("getUpdates", http_timeout=70, offset=offset, timeout=50, allowed_updates=["message"]):
                offset = upd["update_id"] + 1
                try:
                    reply(upd)
                except Exception as exc:
                    print("reply failed:", repr(exc), file=sys.stderr, flush=True)
        except Exception as exc:
            print("poll failed:", repr(exc), file=sys.stderr, flush=True)
            time.sleep(5)


if __name__ == "__main__":
    if "--setup" in sys.argv:
        setup()
    else:
        run()
