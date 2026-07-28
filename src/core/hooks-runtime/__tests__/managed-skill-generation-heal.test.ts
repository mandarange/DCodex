import '../../__tests__/helpers/isolated-test-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { PACKAGE_VERSION } from '../../fsx.js';
import { installGlobalSkills } from '../../init/skills.js';
import { authoritativeSksSkillAdmission } from '../hook-context.js';

const SKILL_NAME = 'sks-honest-mode';

function staleManagedSkillText(name: string) {
  return [
    '---',
    `name: ${name}`,
    'description: stale managed skill body from an older sneakoscope install',
    '---',
    '',
    'Stale managed body that no longer matches the packaged digest.',
    '',
    `<!-- BEGIN SKS MANAGED SKILL v0.0.0-stale name=${name} -->`,
    ''
  ].join('\n');
}

async function seedGlobalSkills(home: string) {
  await fsp.mkdir(home, { recursive: true });
  const install = await installGlobalSkills(home);
  assert.equal(install.ok, true, JSON.stringify(install));
  return {
    skill: path.join(home, '.agents', 'skills', SKILL_NAME, 'SKILL.md'),
    marker: path.join(home, '.agents', 'skills', '.sks-generated.json')
  };
}

async function withHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previousHome = process.env.HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  try {
    process.env.HOME = home;
    process.env.CODEX_HOME = path.join(home, '.codex');
    return await run();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }
}

test('admission self-heals global managed skills installed by a different sneakoscope version', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-managed-skill-generation-heal-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  try {
    const { skill, marker } = await seedGlobalSkills(home);
    const packaged = await fsp.readFile(skill, 'utf8');
    await fsp.writeFile(skill, staleManagedSkillText(SKILL_NAME));
    const generated = JSON.parse(await fsp.readFile(marker, 'utf8'));
    assert.equal(generated.version, PACKAGE_VERSION);
    await fsp.writeFile(marker, JSON.stringify({ ...generated, version: '0.0.0-stale' }));

    const admission = await withHome(home, () => authoritativeSksSkillAdmission(root, ['honest-mode']));
    assert.equal(admission.blocked, null, JSON.stringify(admission.blocked));
    assert.deepEqual(admission.resolution?.blockers, []);
    assert.deepEqual(admission.resolution?.unresolved, []);
    assert.deepEqual(admission.resolution?.sources.map((source) => source.path), [skill]);
    assert.equal(await fsp.readFile(skill, 'utf8'), packaged);
    assert.equal(JSON.parse(await fsp.readFile(marker, 'utf8')).version, PACKAGE_VERSION);
  } finally {
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('admission keeps failing closed on tampered global skills from the current sneakoscope version', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-managed-skill-generation-tamper-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  try {
    const { skill, marker } = await seedGlobalSkills(home);
    await fsp.appendFile(skill, '\nTampered after install.\n');
    const tampered = await fsp.readFile(skill, 'utf8');

    const admission: any = await withHome(home, () => authoritativeSksSkillAdmission(root, ['honest-mode']));
    assert.equal(admission.blocked?.decision, 'block');
    assert.match(String(admission.blocked?.reason || ''), /rejected=content_digest_mismatch:sks-honest-mode:global/);
    assert.match(String(admission.blocked?.reason || ''), /sks doctor --fix/);
    assert.equal(await fsp.readFile(skill, 'utf8'), tampered);
    assert.equal(JSON.parse(await fsp.readFile(marker, 'utf8')).version, PACKAGE_VERSION);
  } finally {
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});
