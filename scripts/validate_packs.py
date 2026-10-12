"""Check packs/<NN>-<slug>/pack.json against the folder layout."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKS = ROOT / "packs"
REQUIRED = ("title", "slug", "order", "sourceMessage", "stickerLinks", "telemost")
STATUSES = {"pending", "uploading", "done", "error"}


def main() -> int:
    errors: list[str] = []
    folders = sorted(p for p in PACKS.iterdir() if p.is_dir())
    if not folders:
        print("no packs/", file=sys.stderr)
        return 1

    orders: list[int] = []
    for folder in folders:
        path = folder / "pack.json"
        if not path.is_file():
            errors.append(f"{folder.name}: missing pack.json")
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        for key in REQUIRED:
            if key not in data:
                errors.append(f"{folder.name}: missing {key}")
        slug = data.get("slug")
        order = data.get("order")
        if slug != folder.name:
            errors.append(f"{folder.name}: slug is {slug!r}")
        if not isinstance(order, int) or f"{order:02d}-" != folder.name[:3]:
            errors.append(f"{folder.name}: order {order!r} does not match folder prefix")
        else:
            orders.append(order)
        links = data.get("stickerLinks") or []
        if not links or not all(isinstance(x, str) and x.startswith("https://t.me/addstickers/") for x in links):
            errors.append(f"{folder.name}: stickerLinks must be t.me/addstickers URLs")
        source = data.get("sourceMessage") or ""
        if not source.startswith("https://t.me/tg2tm/"):
            errors.append(f"{folder.name}: sourceMessage must point at t.me/tg2tm")
        status = (data.get("telemost") or {}).get("status")
        if status not in STATUSES:
            errors.append(f"{folder.name}: telemost.status {status!r}")
        for name in data.get("images") or []:
            if not (folder / name).is_file():
                errors.append(f"{folder.name}: listed image missing: {name}")

    if orders != list(range(1, len(orders) + 1)):
        errors.append(f"pack order is {orders}, expected 1..{len(orders)}")

    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print(f"ok: {len(folders)} packs")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
