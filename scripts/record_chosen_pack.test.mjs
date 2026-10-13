import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chosenPackDirs, copyChosenPacks } from './record_chosen_pack.mjs';

test('the chosen pack is the open dialog, the request, or the numbers given to this run', () => {
  const catalog = ['01-sever', '02-yug', '03-vostok'];
  assert.deepEqual(chosenPackDirs({ restartDir: '02-yug', packs: '01', catalogDirs: catalog }), ['02-yug']);
  assert.deepEqual(chosenPackDirs({ restartDir: 'request-abc', packs: '', catalogDirs: catalog }), ['request-abc']);
  assert.deepEqual(chosenPackDirs({ packs: '01 03', catalogDirs: catalog }), ['01-sever', '03-vostok']);
  assert.deepEqual(chosenPackDirs({ packs: '', catalogDirs: catalog }), []);
  assert.deepEqual(chosenPackDirs({ restartDir: '../packs', catalogDirs: catalog }), []);
});

test('the record is a copy of that pack file and nothing else', () => {
  const root = mkdtempSync(join(tmpdir(), 'pack-record-'));
  mkdirSync(join(root, 'packs', '02-yug'), { recursive: true });
  mkdirSync(join(root, 'packs', 'request-next'), { recursive: true });
  writeFileSync(join(root, 'packs', '02-yug', 'pack.json'), '{"title":"Юг"}\n');
  writeFileSync(join(root, 'packs', 'request-next', 'pack.json'), '{"title":"Запад"}\n');
  mkdirSync(join(root, 'logs'), { recursive: true });
  writeFileSync(join(root, 'logs', 'restart-pack.json'), JSON.stringify({ dir: 'request-next', title: 'Запад' }));
  assert.deepEqual(copyChosenPacks({ root, packs: '02' }), ['request-next']);
  assert.equal(readFileSync(join(root, 'logs', 'pack-record', 'request-next', 'pack.json'), 'utf8'), '{"title":"Запад"}\n');
  rmSync(root, { recursive: true });
});
