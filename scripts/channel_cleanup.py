"""Delete pack-request posts from t.me/tg2tm once their pack is in Telemost.

A request post is deleted only when:
- packs/NN/pack.json has telemost.status == "done" and telemost.packUrl;
- sourceMessage points at https://t.me/tg2tm/<id>;
- the live post still shows the pack title and every link in stickerLinks.

The deletion time goes to pack.json (telemost.sourceDeleted) and logs/transfer-log.md.
Announcement posts and the pinned intro are never touched. Uses config/tg2tmbot.token.

  python scripts/channel_cleanup.py          # delete eligible request posts
  python scripts/channel_cleanup.py --dry    # only report
"""

from __future__ import annotations

import html
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKS = ROOT / "packs"
LOG = ROOT / "logs" / "transfer-log.md"
TOKEN_FILE = ROOT / "config" / "tg2tmbot.token"
CHANNEL = "tg2tm"
SOURCE_RE = re.compile(rf"^https://t\.me/{CHANNEL}/(\d+)$")


def api(token: str, method: str, **params) -> dict:
    data = urllib.parse.urlencode(params).encode()
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/{method}", data=data)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode() or "{}")


def live_text(message_id: int) -> str | None:
    url = f"https://t.me/{CHANNEL}/{message_id}?embed=1&mode=tme"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        page = r.read().decode("utf-8", "replace")
    if "tgme_widget_message_error" in page:
        return None
    m = re.search(r"js-message_text[^>]*>(.*?)</div>", page, re.S)
    if not m:
        return ""
    return html.unescape(re.sub(r"<[^>]+>", " ", m.group(1)))


def matches(meta: dict, text: str) -> bool:
    flat = re.sub(r"\s+", " ", text)
    return meta["title"] in flat and all(link in flat for link in meta.get("stickerLinks", []))


def log_row(item: str, status: str, note: str = "") -> None:
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
    with LOG.open("a", encoding="utf-8") as f:
        f.write(f"| {stamp} | {item} | {status} | {note} |\n")


def main(dry: bool) -> int:
    token = TOKEN_FILE.read_text().strip()
    failures = 0
    for path in sorted(PACKS.glob("*/pack.json")):
        meta = json.loads(path.read_text(encoding="utf-8"))
        tm = meta.get("telemost") or {}
        m = SOURCE_RE.match(meta.get("sourceMessage") or "")
        if tm.get("status") != "done" or not tm.get("packUrl") or not m or tm.get("sourceDeleted"):
            continue
        message_id = int(m.group(1))
        text = live_text(message_id)
        if text is None:
            print(f"{path.parent.name}: post {message_id} already gone")
            tm["sourceDeleted"] = tm.get("sourceDeleted") or "already gone"
        elif not matches(meta, text):
            print(f"{path.parent.name}: post {message_id} does not match pack.json, kept", file=sys.stderr)
            failures += 1
            continue
        elif dry:
            print(f"{path.parent.name}: would delete post {message_id}")
            continue
        else:
            res = api(token, "deleteMessage", chat_id=f"@{CHANNEL}", message_id=message_id)
            if not res.get("ok"):
                print(f"{path.parent.name}: delete {message_id} failed: {res.get('description')}", file=sys.stderr)
                failures += 1
                continue
            tm["sourceDeleted"] = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
            log_row(f"канал t.me/{CHANNEL}/{message_id}", "заявка удалена", f"«{meta['title']}» уже в Телемосте: {tm['packUrl']}")
            print(f"{path.parent.name}: deleted post {message_id}")
        meta["telemost"] = tm
        on_disk = json.loads(path.read_text(encoding="utf-8"))
        on_disk["telemost"] = {**(on_disk.get("telemost") or {}), "sourceDeleted": tm["sourceDeleted"]}
        path.write_text(json.dumps(on_disk, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main("--dry" in sys.argv))
