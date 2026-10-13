// Copy the pack.json this run actually chose into logs/pack-record/.
// A restart uses the open dialog or the next stored request. An upload uses
// the pack numbers it was given. No pack number is fixed here.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function chosenPackDirs({ packs = '', restartDir = '', catalogDirs = [] } = {}) {
  const picked = String(restartDir || '').trim();
  if (/^[A-Za-z0-9_-]+$/.test(picked)) return [picked];
  const numbers = String(packs || '').trim().split(/\s+/).filter((part) => /^[0-9]{2}$/.test(part));
  if (!numbers.length) return [];
  return catalogDirs.filter((name) => /^[0-9]{2}-/.test(name) && numbers.includes(name.slice(0, 2)));
}

function readRestartDir(root) {
  try {
    const data = JSON.parse(readFileSync(join(root, 'logs', 'restart-pack.json'), 'utf8'));
    return data && data.dir ? String(data.dir) : '';
  } catch {
    return '';
  }
}

export function copyChosenPacks({ root = ROOT, packs = process.env.PACKS || '' } = {}) {
  const packsDir = join(root, 'packs');
  let catalogDirs = [];
  try {
    catalogDirs = readdirSync(packsDir);
  } catch {
    catalogDirs = [];
  }
  const dirs = chosenPackDirs({ packs, restartDir: readRestartDir(root), catalogDirs });
  const destRoot = join(root, 'logs', 'pack-record');
  rmSync(destRoot, { recursive: true, force: true });
  const copied = [];
  for (const dir of dirs) {
    const source = join(packsDir, dir, 'pack.json');
    if (!existsSync(source)) continue;
    const destDir = join(destRoot, dir);
    mkdirSync(destDir, { recursive: true });
    cpSync(source, join(destDir, 'pack.json'));
    copied.push(dir);
  }
  return copied;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const copied = copyChosenPacks();
  console.log(copied.length ? `pack-record ${copied.join(' ')}` : 'pack-record none');
}
