"""Download every sticker for packs/*/pack.json via the Bot API and write Telemost-ready PNGs.

Needs TELEGRAM_BOT_TOKEN in the environment (any bot works; getStickerSet is public).
Originals are cached under .cache/originals/ (git-ignored).
"""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
PACKS = ROOT / "packs"
CACHE = ROOT / ".cache" / "originals"
SETTINGS = json.loads((ROOT / "config" / "settings.json").read_text(encoding="utf-8"))["telemost"]
SIDE = SETTINGS["minWidth"]
MAX_BYTES = SETTINGS["maxBytes"]
MAX_PER_PACK = SETTINGS["maxStickersPerPack"]

TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
if not TOKEN:
    sys.exit("TELEGRAM_BOT_TOKEN is not set")


def api(method: str, **params) -> dict:
    url = f"https://api.telegram.org/bot{TOKEN}/{method}?{urllib.parse.urlencode(params)}"
    for attempt in range(5):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                data = json.load(r)
            if data.get("ok"):
                return data["result"]
            raise RuntimeError(data)
        except Exception:
            if attempt == 4:
                raise
            time.sleep(2 ** attempt)
    raise AssertionError


def download(file_id: str, dest: Path) -> Path:
    if dest.exists() and dest.stat().st_size:
        return dest
    info = api("getFile", file_id=file_id)
    url = f"https://api.telegram.org/file/bot{TOKEN}/{info['file_path']}"
    dest.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(5):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                dest.write_bytes(r.read())
            return dest
        except Exception:
            if attempt == 4:
                raise
            time.sleep(2 ** attempt)
    return dest


def is_promo(set_name: str, pos: int, total: int, sticker: dict) -> bool:
    """TgEmojiBot re-uploads end with a ©️ advert for the uploader's channel, not a character sticker."""
    return set_name.endswith("_by_TgEmojiBot") and pos == total and sticker.get("emoji") in ("©️", "©")


def frame_from_webm(path: Path) -> Image.Image:
    """Middle frame of a VP9 video sticker, alpha kept (libvpx decoder)."""
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True,
    )
    try:
        mid = max(0.0, float(probe.stdout.strip()) / 2)
    except ValueError:
        mid = 0.0
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "f.png"
        for seek in (mid, 0.0):
            subprocess.run(
                ["ffmpeg", "-v", "error", "-y", "-c:v", "libvpx-vp9", "-ss", f"{seek:.2f}", "-i", str(path),
                 "-frames:v", "1", "-pix_fmt", "rgba", str(out)],
                check=False,
            )
            if out.exists() and out.stat().st_size:
                return Image.open(out).convert("RGBA").copy()
    raise RuntimeError(f"no frame from {path.name}")


def frame_from_tgs(path: Path) -> Image.Image:
    from rlottie_python import LottieAnimation

    anim = LottieAnimation.from_tgs(str(path))
    total = anim.lottie_animation_get_totalframe()
    return anim.render_pillow_frame(frame_num=total // 2, width=SIDE, height=SIDE).convert("RGBA")


def to_telemost_png(img: Image.Image) -> bytes:
    """Fit inside SIDE x SIDE, centre on a transparent square canvas, keep under MAX_BYTES."""
    img = img.convert("RGBA")
    img.thumbnail((SIDE, SIDE), Image.LANCZOS)
    canvas = Image.new("RGBA", (SIDE, SIDE), (0, 0, 0, 0))
    canvas.paste(img, ((SIDE - img.width) // 2, (SIDE - img.height) // 2), img)
    buf = io.BytesIO()
    canvas.save(buf, "PNG", optimize=True)
    if buf.tell() <= MAX_BYTES:
        return buf.getvalue()
    for colors in (256, 128, 64):
        buf = io.BytesIO()
        canvas.quantize(colors=colors, method=Image.FASTOCTREE).save(buf, "PNG", optimize=True)
        if buf.tell() <= MAX_BYTES:
            return buf.getvalue()
    raise RuntimeError("cannot fit under size limit")


def process_pack(folder: Path) -> None:
    meta_path = folder / "pack.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    for old in folder.glob("*.png"):
        old.unlink()

    images: list[dict] = []
    index = 0
    for entry in meta["stickerSets"]:
        result = api("getStickerSet", name=entry["name"])
        stickers = result["stickers"]
        entry["telegramTitle"] = result["title"]
        entry["stickerCount"] = len(stickers)
        kinds = {"static": 0, "animated": 0, "video": 0}
        skipped = []
        for pos, st in enumerate(stickers, 1):
            if is_promo(entry["name"], pos, len(stickers), st):
                skipped.append({"position": pos, "emoji": st.get("emoji"), "reason": "promo sticker for the pack author's channel"})
                continue
            index += 1
            kind = "video" if st.get("is_video") else "animated" if st.get("is_animated") else "static"
            kinds[kind] += 1
            ext = {"video": "webm", "animated": "tgs", "static": "webp"}[kind]
            src = download(st["file_id"], CACHE / entry["name"] / f"{pos:03d}.{ext}")
            if kind == "video":
                img = frame_from_webm(src)
            elif kind == "animated":
                img = frame_from_tgs(src)
            else:
                img = Image.open(src)
            data = to_telemost_png(img)
            name = f"{index:03d}.png"
            (folder / name).write_bytes(data)
            images.append({
                "file": name,
                "emoji": st.get("emoji") or "🙂",
                "set": entry["name"],
                "position": pos,
                "kind": kind,
                "bytes": len(data),
            })
        entry["kinds"] = kinds
        entry["skipped"] = skipped

    if len(images) > MAX_PER_PACK:
        raise RuntimeError(f"{folder.name}: {len(images)} stickers > {MAX_PER_PACK}")
    meta["stickerCount"] = len(images)
    meta["images"] = images
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{folder.name}: {len(images)} images")


def main(argv: list[str]) -> int:
    if argv[:1] == ["--dir"]:
        folders = [Path(argv[1])]
    else:
        folders = sorted(p for p in PACKS.iterdir() if p.is_dir() and p.name[2:3] == "-")
        if argv:
            folders = [f for f in folders if f.name in argv or f.name[:2] in argv]
    for folder in folders:
        process_pack(folder)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
