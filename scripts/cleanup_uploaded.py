"""Delete local sticker images and download cache for packs already in Telemost.

A pack is cleaned only when telemost.status == "done" and telemost.packUrl is set.
Images can be rebuilt any time with scripts/fetch_and_convert.py.
Tokens, config/tg2tmbot-subscribers.json and .cache/tg2tmbot-state.json are never touched.

  python scripts/cleanup_uploaded.py          # clean finished packs
  python scripts/cleanup_uploaded.py --dry    # only list what would go
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKS = ROOT / "packs"
ORIGINALS = ROOT / ".cache" / "originals"
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".webm", ".tgs", ".gif", ".lottie", ".zip"}


def main(dry: bool) -> int:
    freed = 0
    for meta_path in sorted(PACKS.glob("*/pack.json")):
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        tm = meta.get("telemost") or {}
        if tm.get("status") != "done" or not tm.get("packUrl"):
            continue
        targets = [p for p in meta_path.parent.iterdir() if p.suffix.lower() in IMAGE_SUFFIXES]
        targets += [ORIGINALS / s["name"] for s in meta.get("stickerSets", []) if (ORIGINALS / s["name"]).exists()]
        for path in targets:
            size = sum(f.stat().st_size for f in path.rglob("*")) if path.is_dir() else path.stat().st_size
            freed += size
            if not dry:
                shutil.rmtree(path) if path.is_dir() else path.unlink()
        if targets:
            print(f"{meta_path.parent.name}: {'would remove' if dry else 'removed'} {len(targets)} items")
    print(f"{'would free' if dry else 'freed'} {freed / 1048576:.1f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main("--dry" in sys.argv))
