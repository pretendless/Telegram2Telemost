import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function chooseCache(candidates) {
  const result = spawnSync('python3', ['-c', `
import json, sys
sys.path.insert(0, "scripts")
from fetch_and_convert import choose_cache_dir
from pathlib import Path
chosen = choose_cache_dir([Path(item) for item in json.loads(sys.argv[1])])
print(chosen)
`, JSON.stringify(candidates)], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'choose_cache_dir failed');
  }
  return result.stdout.trim();
}

test('sticker cache falls back when the image directory is not writable', () => {
  const root = mkdtempSync(join(tmpdir(), 'tg2tm-cache-'));
  const blocked = join(root, 'blocked');
  const fallback = join(root, 'fallback');
  try {
    mkdirSync(blocked);
    chmodSync(blocked, 0o555);
    const chosen = chooseCache([blocked, fallback]);
    assert.equal(chosen, join(fallback, 'originals'));
    const preferred = join(root, 'preferred');
    const again = chooseCache([preferred, fallback]);
    assert.equal(again, join(preferred, 'originals'));
  } finally {
    try {
      chmodSync(blocked, 0o755);
    } catch {
      // The directory was never created.
    }
    rmSync(root, { recursive: true, force: true });
  }
});
