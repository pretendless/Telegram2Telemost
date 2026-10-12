"""@tg2tmbot: explains the pack format and checks submitted messages.

One message = one Telemost pack: first line is the title, then t.me/addstickers links, at most 150 stickers in total.
The bot replies with what it parsed and the sticker count per set. It does not upload anything itself.

Token: config/tg2tmbot.token (git-ignored) or TG2TMBOT_TOKEN.
  python scripts/tg2tmbot.py --setup   # set description, about text and command list
  python scripts/tg2tmbot.py           # long-poll and answer messages
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOKEN_FILE = ROOT / "config" / "tg2tmbot.token"
MAX_STICKERS = 150
CHANNEL = "https://t.me/tg2tm"
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
)

DESCRIPTION = (
    "Перенос стикеров из Telegram в Яндекс Телемост.\n\n"
    "Одно сообщение — один пак: первая строка — название, дальше ссылки t.me/addstickers/… по порядку, "
    f"всего до {MAX_STICKERS} стикеров.\n\n"
    "Пример:\n" + EXAMPLE + "\n\n"
    f"Образцы: {CHANNEL}"
)
ABOUT = f"Пак = сообщение: название + ссылки t.me/addstickers, до {MAX_STICKERS} стикеров. Образцы: t.me/tg2tm"
COMMANDS = [
    {"command": "start", "description": "Как оформить пак и пример"},
    {"command": "format", "description": "Формат сообщения: название + ссылки"},
    {"command": "example", "description": "Пример из канала t.me/tg2tm"},
]


def token() -> str:
    value = os.environ.get("TG2TMBOT_TOKEN") or (TOKEN_FILE.read_text().strip() if TOKEN_FILE.exists() else "")
    if not value:
        sys.exit(f"no token: set TG2TMBOT_TOKEN or create {TOKEN_FILE.relative_to(ROOT)}")
    return value


TOKEN = token()


def api(method: str, http_timeout: int = 60, **params):
    data = urllib.parse.urlencode({k: json.dumps(v) if isinstance(v, (list, dict)) else v for k, v in params.items()}).encode()
    req = urllib.request.Request(f"https://api.telegram.org/bot{TOKEN}/{method}", data=data)
    with urllib.request.urlopen(req, timeout=http_timeout) as r:
        body = json.load(r)
    if not body.get("ok"):
        raise RuntimeError(body)
    return body["result"]


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


def reply(update: dict) -> None:
    msg = update.get("message") or update.get("channel_post")
    if not msg or "text" not in msg:
        return
    text = msg["text"]
    cmd = text.split()[0].split("@")[0].lower() if text.startswith("/") else ""
    if cmd in ("/start", "/help"):
        out = START
    elif cmd == "/format":
        out = FORMAT
    elif cmd == "/example":
        out = "Пример из канала:\n\n" + EXAMPLE
    else:
        out = check_pack(text)
    api("sendMessage", chat_id=msg["chat"]["id"], text=out, link_preview_options={"is_disabled": True})


def run() -> None:
    offset = 0
    while True:
        try:
            for upd in api("getUpdates", http_timeout=70, offset=offset, timeout=50):
                offset = upd["update_id"] + 1
                try:
                    reply(upd)
                except Exception as exc:
                    print("reply failed:", repr(exc), file=sys.stderr, flush=True)
        except Exception as exc:
            print("poll failed:", exc, file=sys.stderr)
            time.sleep(5)


if __name__ == "__main__":
    if "--setup" in sys.argv:
        setup()
    else:
        run()
