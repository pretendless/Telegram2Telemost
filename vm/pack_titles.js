// Resolve two-digit pack numbers to titles from packs/*/pack.json (Node only).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { oneLineTitle } from "./dispatch_reason.js";

const PACK_DIR_RE = /^\d\d-/;

export function titlesForPackNumbers(packsStr, packsRoot) {
  const nums = String(packsStr || "")
    .trim()
    .split(/\s+/)
    .filter((part) => /^[0-9]{2}$/.test(part));
  if (!nums.length || !packsRoot) return [];
  let dirs = [];
  try {
    dirs = readdirSync(packsRoot).filter((name) => PACK_DIR_RE.test(name)).sort();
  } catch {
    return [];
  }
  const byNum = new Map();
  for (const dir of dirs) {
    const num = dir.slice(0, 2);
    try {
      const meta = JSON.parse(readFileSync(join(packsRoot, dir, "pack.json"), "utf8"));
      const title = oneLineTitle(meta && meta.title);
      if (title) byNum.set(num, title);
    } catch {
      // skip broken pack folder
    }
  }
  return nums.map((num) => byNum.get(num)).filter(Boolean);
}

export function defaultPacksRoot(importMetaUrl) {
  return join(new URL("..", importMetaUrl).pathname, "packs");
}
