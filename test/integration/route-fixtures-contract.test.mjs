import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROUTES = [
  ['naruto', false],
  ['qa-loop', true],
  ['research', false],
  ['autoresearch', false],
  ['ppt', true],
  ['image-ux-review', true],
  ['computer-use', true],
  ['from-chat-img', true],
  ['db', false],
  ['wiki', false],
  ['gx', true],
  ['align', false],
  ['goal', false],
  ['mad-sks', false]
];

test('route fixture contracts include required artifacts and visual ledgers', async () => {
  const fixtureRoot = path.join(process.cwd(), 'test/fixtures/routes');
  const fixtureDirectories = (await fs.readdir(fixtureRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(fixtureDirectories, ROUTES.map(([name]) => name).sort());
  for (const [name, visual] of ROUTES) {
    const dir = path.join(fixtureRoot, name);
    for (const file of ['input.json', 'expected-artifacts.json', 'expected-proof.json', 'expected-gate.json']) {
      await assert.doesNotReject(() => fs.access(path.join(dir, file)), `${name}/${file}`);
    }
    if (visual) await assert.doesNotReject(() => fs.access(path.join(dir, 'expected-image-voxel.json')), `${name}/expected-image-voxel.json`);
    const artifacts = JSON.parse(await fs.readFile(path.join(dir, 'expected-artifacts.json'), 'utf8'));
    assert.ok(artifacts.required.some((item) => item.endsWith('completion-proof.json')), name);
    if (visual) assert.ok(artifacts.required.some((item) => item.endsWith('image-voxel-ledger.json')), name);
  }
});
