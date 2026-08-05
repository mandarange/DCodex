import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { MANAGED_SKILLS } from '../../managed-assets/managed-assets-manifest.js';
import { buildCodexNativeFeatureMatrix } from '../codex-native-feature-broker.js';
import { currentSksSkillName } from '../sks-skill-paths.js';
import { installGlobalSkills } from '../../init/skills.js';
import {
  createCodexNativeRuntimeFixture,
  withFixtureEnv
} from '../../../scripts/codex-native-runtime-e2e-fixture.js';

async function writeRequiredManagedSkills(root: string) {
  for (const skill of MANAGED_SKILLS) {
    const name = currentSksSkillName(skill.id);
    const file = path.join(root, name, 'SKILL.md');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, [
      '---',
      `name: ${name}`,
      'description: fixture',
      '---',
      '',
      `<!-- BEGIN SKS MANAGED SKILL v-test name=${name} -->`,
      ''
    ].join('\n'));
  }
}

test('feature broker requires authoritative HOME skills and rejects project-only residue', async () => {
  assert.equal(MANAGED_SKILLS.some((skill) => currentSksSkillName(skill.id) === 'sks-loop'), false);
  const fixture = await createCodexNativeRuntimeFixture({
    hook: 'approved',
    agentType: 'supported',
    appHandoff: true,
    imagePathExposure: true,
    mcpCandidates: true,
    codeModeWebSearch: true
  });
  try {
    await withFixtureEnv(fixture, async () => {
      await writeRequiredManagedSkills(path.join(fixture.root, '.agents', 'skills'));
      const projectOnly = await buildCodexNativeFeatureMatrix({ root: fixture.root, mode: 'read-only' });
      const projectOnlyProbe = projectOnly.probes.skill_sync as {
        ok?: boolean;
        managed_count?: number;
        missing_required?: string[];
      };
      assert.equal(projectOnlyProbe.ok, false);
      assert.equal(projectOnlyProbe.managed_count, 0);
      assert.deepEqual(projectOnlyProbe.missing_required, MANAGED_SKILLS.map((skill) => currentSksSkillName(skill.id)));

      const install = await installGlobalSkills(fixture.env.HOME || '');
      assert.equal(install.ok, true);
      const global = await buildCodexNativeFeatureMatrix({ root: fixture.root, mode: 'read-only' });
      const globalProbe = global.probes.skill_sync as {
        ok?: boolean;
        managed_count?: number;
        missing_required?: string[];
      };
      assert.equal(globalProbe.ok, true);
      assert.equal(globalProbe.managed_count, MANAGED_SKILLS.length);
      assert.deepEqual(globalProbe.missing_required, []);

      const naruto = path.join(fixture.env.HOME || '', '.agents', 'skills', 'sks-naruto', 'SKILL.md');
      await fsp.appendFile(naruto, '\nTampered after install.\n');
      const tampered = await buildCodexNativeFeatureMatrix({ root: fixture.root, mode: 'read-only' });
      const tamperedProbe = tampered.probes.skill_sync as {
        ok?: boolean;
        managed_count?: number;
        missing_required?: string[];
        blockers?: string[];
      };
      assert.equal(tamperedProbe.ok, false);
      assert.equal(tamperedProbe.managed_count, MANAGED_SKILLS.length - 1);
      assert.ok(tamperedProbe.missing_required?.includes('sks-naruto'));
      assert.ok(tamperedProbe.blockers?.includes('managed_skill_content_digest_mismatch:sks-naruto:global'));
    });
  } finally {
    await fsp.rm(fixture.root, { recursive: true, force: true });
  }
});

test('feature broker rejects valid managed skills reached through a HOME ancestor symlink', async () => {
  const fixture = await createCodexNativeRuntimeFixture({
    hook: 'approved',
    agentType: 'supported',
    appHandoff: true,
    imagePathExposure: true,
    mcpCandidates: true,
    codeModeWebSearch: true
  });
  try {
    await withFixtureEnv(fixture, async () => {
      const home = fixture.env.HOME || '';
      const install = await installGlobalSkills(home);
      assert.equal(install.ok, true);
      const outsideAgents = path.join(fixture.root, 'outside-agents');
      await fsp.rename(path.join(home, '.agents'), outsideAgents);
      await fsp.symlink(outsideAgents, path.join(home, '.agents'));

      const matrix = await buildCodexNativeFeatureMatrix({ root: fixture.root, mode: 'read-only' });
      const probe = matrix.probes.skill_sync as {
        ok?: boolean;
        managed_count?: number;
        blockers?: string[];
      };
      assert.equal(probe.ok, false);
      assert.equal(probe.managed_count, 0);
      assert.ok(probe.blockers?.some((blocker) => blocker.startsWith('managed_skill_unsafe_symlink:')));
    });
  } finally {
    await fsp.rm(fixture.root, { recursive: true, force: true });
  }
});
