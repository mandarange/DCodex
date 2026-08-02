import '../../__tests__/helpers/isolated-test-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { reconcileSkills } from '../skills.js';

const SKILL_NAME = 'sks-honest-mode';

async function reconcileGlobalSkills(home: string) {
  return reconcileSkills({
    targetDir: path.join(home, '.agents', 'skills'),
    scope: 'global',
    fix: true,
    globalRuntimeRoot: path.join(home, '.sneakoscope-global')
  });
}

async function findNamedFiles(directory: string, fileName: string): Promise<string[]> {
  const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await findNamedFiles(candidate, fileName));
    else if (entry.isFile() && entry.name === fileName) found.push(candidate);
  }
  return found;
}

test('differing managed skill metadata is quarantined before trusted generation is installed', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-hostile-skill-metadata-'));
  const metadataPath = path.join(home, '.agents', 'skills', SKILL_NAME, 'agents', 'openai.yaml');
  const hostileMetadata = 'interface:\n  display_name: "Hostile override"\n';
  try {
    const initial = await reconcileGlobalSkills(home);
    assert.equal(initial.ok, true, JSON.stringify(initial));
    const trustedMetadata = await fsp.readFile(metadataPath, 'utf8');
    await fsp.writeFile(metadataPath, hostileMetadata, 'utf8');

    const reconciled = await reconcileGlobalSkills(home);

    assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
    assert.ok(reconciled.quarantined_user_collisions.includes(SKILL_NAME));
    assert.equal(await fsp.readFile(metadataPath, 'utf8'), trustedMetadata);
    const quarantinedMetadata = await findNamedFiles(
      path.join(home, '.sneakoscope', 'quarantine', 'skills', SKILL_NAME),
      'openai.yaml'
    );
    assert.equal(quarantinedMetadata.length, 1);
    assert.equal(await fsp.readFile(quarantinedMetadata[0]!, 'utf8'), hostileMetadata);
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test('trusted managed skill metadata remains owned without quarantine', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-trusted-skill-metadata-'));
  const metadataPath = path.join(home, '.agents', 'skills', SKILL_NAME, 'agents', 'openai.yaml');
  try {
    const initial = await reconcileGlobalSkills(home);
    assert.equal(initial.ok, true, JSON.stringify(initial));
    const trustedMetadata = await fsp.readFile(metadataPath, 'utf8');

    const reconciled = await reconcileGlobalSkills(home);

    assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
    assert.equal(reconciled.quarantined_user_collisions.includes(SKILL_NAME), false);
    assert.equal(await fsp.readFile(metadataPath, 'utf8'), trustedMetadata);
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test('missing managed skill metadata is regenerated without quarantining the skill', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-missing-skill-metadata-'));
  const metadataPath = path.join(home, '.agents', 'skills', SKILL_NAME, 'agents', 'openai.yaml');
  try {
    const initial = await reconcileGlobalSkills(home);
    assert.equal(initial.ok, true, JSON.stringify(initial));
    const trustedMetadata = await fsp.readFile(metadataPath, 'utf8');
    await fsp.rm(metadataPath);

    const reconciled = await reconcileGlobalSkills(home);

    assert.equal(reconciled.ok, true, JSON.stringify(reconciled));
    assert.equal(reconciled.quarantined_user_collisions.includes(SKILL_NAME), false);
    assert.equal(await fsp.readFile(metadataPath, 'utf8'), trustedMetadata);
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});
