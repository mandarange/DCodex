import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  reconcileSkillLegacySurface,
  rewriteSkillLegacySurface,
  skillLegacySurfaceNeedsRewrite
} from '../../dist/core/doctor/skill-legacy-surface.js';
import { runDoctorCommandAliasCleanup } from '../../dist/core/doctor/command-alias-cleanup.js';
import { containsRetiredPublicSurface } from '../../dist/core/doctor/current-project-guidance.js';

test('rewriteSkillLegacySurface maps retired dollar and CLI surfaces to current commands', () => {
  const retiredTerminal = ['zel', 'lij'].join('');
  const input = [
    'Use $Team and $Agent with sks team run, then sks mad-db apply-migration.',
    'Legacy picker: sks codex-app glm-profile install',
    'Flags: sks --naruto --clones 4',
    `Legacy display: sks ${retiredTerminal} dashboard and sks --${retiredTerminal}-dashboard`,
    'Keep sks agent-bridge setup and sks teamcity status unchanged.',
    'Install OMX harness from .omx before continuing.'
  ].join('\n');

  assert.equal(skillLegacySurfaceNeedsRewrite(input), true);
  const result = rewriteSkillLegacySurface(input);
  assert.equal(result.changed, true);
  assert.match(result.text, /\$sks-naruto/);
  assert.match(result.text, /sks naruto/);
  assert.match(result.text, /sks mad-sks/);
  assert.match(result.text, /sks mad-sks status/);
  assert.match(result.text, /sks codex-app use-openrouter/);
  assert.match(result.text, /--agents 4/);
  assert.match(result.text, /sks agent-bridge setup/);
  assert.match(result.text, /sks teamcity status/);
  assert.match(result.text, /sks conflicts cleanup --yes/);
  assert.doesNotMatch(result.text, /\$Team\b|\$Agent\b|sks team\b|sks mad-db\b|glm-profile|\.omx/i);
  assert.equal(containsRetiredPublicSurface(result.text), false);
  assert.equal(skillLegacySurfaceNeedsRewrite(result.text), false);
});

test('official Codex App $imagegen references are current and never rewritten', () => {
  const input = 'Use $imagegen for the official Codex App image generation tool.';
  assert.equal(skillLegacySurfaceNeedsRewrite(input), false);
  assert.deepEqual(rewriteSkillLegacySurface(input), {
    text: input,
    changed: false,
    hits: []
  });
});

test('doctor --fix rewrites customer skills and removes OMX skill directories from the live picker', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-skill-legacy-'));
  const project = path.join(fixture, 'project');
  const home = path.join(fixture, 'home');
  const globalRuntimeRoot = path.join(fixture, 'global-runtime');
  try {
    const customerSkill = path.join(project, '.agents', 'skills', 'customer-workflow');
    const omxSkill = path.join(project, '.agents', 'skills', 'omx');
    await fs.mkdir(customerSkill, { recursive: true });
    await fs.mkdir(path.join(omxSkill, 'agents'), { recursive: true });
    await fs.mkdir(path.join(home, '.agents', 'skills'), { recursive: true });
    await fs.mkdir(path.join(globalRuntimeRoot, '.agents', 'skills'), { recursive: true });
    await fs.writeFile(path.join(customerSkill, 'SKILL.md'), [
      '---',
      'name: customer-workflow',
      'description: Customer skill with legacy SKS commands',
      '---',
      '',
      'Run `$Team` via `sks agent run` then `sks ralph status`.',
      'Provider: `sks codex-app glm-profile install`.',
      ''
    ].join('\n'));
    await fs.writeFile(path.join(omxSkill, 'SKILL.md'), '---\nname: omx\ndescription: foreign harness\n---\n\nOMX skill\n');

    const dry = await reconcileSkillLegacySurface({
      root: project,
      home,
      globalRuntimeRoot,
      fix: false
    });
    assert.equal(dry.ok, false);
    assert.ok(dry.remaining_count >= 2, JSON.stringify(dry));

    const report = await runDoctorCommandAliasCleanup({
      root: project,
      home,
      globalRuntimeRoot,
      fix: true
    });
    assert.equal(report.ok, true, JSON.stringify(report.blockers));
    assert.ok(report.cleanup.skill_legacy_surface.rewritten_count >= 1, JSON.stringify(report.cleanup.skill_legacy_surface));
    assert.ok(report.cleanup.skill_legacy_surface.removed_other_harness_skill_count >= 1, JSON.stringify(report.cleanup.skill_legacy_surface));

    const rewritten = await fs.readFile(path.join(customerSkill, 'SKILL.md'), 'utf8');
    assert.match(rewritten, /\$sks-naruto/);
    assert.match(rewritten, /sks naruto/);
    assert.match(rewritten, /sks loop/);
    assert.match(rewritten, /sks codex-app use-openrouter/);
    assert.doesNotMatch(rewritten, /\$Team\b|sks agent run|sks ralph|glm-profile/i);
    assert.equal(skillLegacySurfaceNeedsRewrite(rewritten), false);

    await assert.rejects(fs.access(omxSkill));
    const quarantined = await findFiles(path.join(project, '.sneakoscope', 'quarantine'), 'SKILL.md');
    assert.ok(quarantined.length >= 1);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

async function findFiles(root, name) {
  const out = [];
  async function walk(dir) {
    let rows;
    try {
      rows = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const row of rows) {
      const full = path.join(dir, row.name);
      if (row.isDirectory()) await walk(full);
      else if (row.name === name) out.push(full);
    }
  }
  await walk(root);
  return out;
}
