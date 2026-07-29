import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { syncCoreSkillsIntegrity } from '../core-skill-integrity.js';
import {
  CORE_SKILL_TEMPLATE_VERSION,
  buildSksCoreSkillManifest,
  renderCoreSkillTemplate
} from '../core-skill-manifest.js';
import { SKILL_DISCOVERY_DESCRIPTION_MAX_CHARS } from '../../skills/skill-agent-metadata.js';

const SECRET_MARKER = 'SKS_CORE_PATH_SECRET';

test('core skills use the focused v2 progressive-disclosure template', () => {
  assert.equal(CORE_SKILL_TEMPLATE_VERSION, 'sks-core-skill-template.v2');
  const manifest = buildSksCoreSkillManifest('1970-01-01T00:00:00.000Z');
  assert.ok(manifest.skills.length > 0);

  for (const skill of manifest.skills) {
    const body = renderCoreSkillTemplate(skill.canonical_name);
    const headings = [
      '## Outcome',
      '## Activation',
      '## Workflow',
      '## Runtime contract',
      '## Safety',
      '## Evidence',
      '## Failure recovery'
    ];
    let previous = -1;
    for (const heading of headings) {
      const index = body.indexOf(heading);
      assert.ok(index > previous, `${skill.canonical_name} must contain ordered heading ${heading}`);
      previous = index;
    }

    const descriptionLine = body.split('\n').find((line) => line.startsWith('description: '));
    assert.ok(descriptionLine, `${skill.canonical_name} must have a frontmatter description`);
    const description = JSON.parse(String(descriptionLine).slice('description: '.length));
    assert.ok(
      description.length > 20 && Array.from(description).length <= SKILL_DISCOVERY_DESCRIPTION_MAX_CHARS
    );
    assert.doesNotMatch(description, /Immutable SKS core Codex App route bridge/);
    assert.match(body, /\nPurpose: /);
    assert.match(body, /\nUse when: /);
    assert.doesNotMatch(body, /\nUse when: Use\b/i);
    assert.match(body, /\nSafety: /);
    assert.match(body, /\nEvidence\/artifacts: /);
    assert.match(body, /\nFailure\/recovery: /);
  }
});

test('core skill integrity blockers do not expose an adversarial ancestor symlink path', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), `sks-core-integrity-${SECRET_MARKER}\n\\-`));
  const root = path.join(fixture, 'project');
  const outsideAgents = path.join(fixture, 'outside-agents');
  try {
    await fsp.mkdir(root, { recursive: true });
    await fsp.mkdir(path.join(outsideAgents, 'skills'), { recursive: true });
    await fsp.symlink(outsideAgents, path.join(root, '.agents'));

    const report = await syncCoreSkillsIntegrity({
      root,
      apply: false,
      skillsRoot: path.join(root, '.agents', 'skills'),
      reportPath: null
    });

    assert.equal(report.ok, false);
    assert.ok(report.blockers.length > 0);
    assertBlockersAreClosed(report.blockers, 'ancestor_symlink');
  } finally {
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('core skill integrity blockers do not expose an adversarial symlink boundary root', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), `sks-core-boundary-${SECRET_MARKER}\n\\-`));
  const actualRoot = path.join(fixture, 'actual-project');
  const linkedRoot = path.join(fixture, 'linked-project');
  try {
    await fsp.mkdir(actualRoot, { recursive: true });
    await fsp.symlink(actualRoot, linkedRoot);

    const report = await syncCoreSkillsIntegrity({
      root: linkedRoot,
      apply: false,
      skillsRoot: path.join(linkedRoot, '.agents', 'skills'),
      reportPath: null
    });

    assert.equal(report.ok, false);
    assert.ok(report.blockers.length > 0);
    assertBlockersAreClosed(report.blockers, 'boundary_symlink');
  } finally {
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('core skill integrity refuses unsafe artifact ancestry without external report or backup writes', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), `sks-core-artifact-${SECRET_MARKER}\n\\-`));
  const root = path.join(fixture, 'home');
  const external = path.join(fixture, 'external-artifacts');
  const skillFile = path.join(root, '.agents', 'skills', 'sks-research', 'SKILL.md');
  const driftedSkill = `${renderCoreSkillTemplate('sks-research')}mutated\n`;
  try {
    await fsp.mkdir(path.dirname(skillFile), { recursive: true });
    await fsp.writeFile(skillFile, driftedSkill, 'utf8');
    await fsp.mkdir(external, { recursive: true });
    await fsp.writeFile(path.join(external, 'sentinel.txt'), 'preserve-me\n', 'utf8');
    await fsp.symlink(external, path.join(root, '.sneakoscope'));
    const beforeExternal = await snapshotTree(external);

    const report = await syncCoreSkillsIntegrity({
      root,
      apply: true,
      skillsRoot: path.join(root, '.agents', 'skills')
    });

    assert.equal(report.ok, false);
    assert.equal(report.installed.length, 0);
    assert.equal(report.restored.length, 0);
    assert.deepEqual(report.blockers, [
      'core_skill_artifact_path_unsafe:report:ancestor_symlink',
      'core_skill_artifact_path_unsafe:backup:ancestor_symlink'
    ]);
    assertBlockersContainNoPathMaterial(report.blockers);
    assert.equal(await fsp.readFile(skillFile, 'utf8'), driftedSkill);
    assert.equal(report.rows.find((row) => row.canonical_name === 'sks-research')?.backup_path, null);
    assert.equal(await pathExists(path.join(external, 'reports', 'core-skill-integrity.json')), false);
    assert.equal(await pathExists(path.join(external, 'backups')), false);
    assert.deepEqual(await snapshotTree(external), beforeExternal);
  } finally {
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('core skill integrity preserves confined report and backup behavior', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-core-artifact-safe-'));
  const root = path.join(fixture, 'home');
  const skillFile = path.join(root, '.agents', 'skills', 'sks-research', 'SKILL.md');
  const driftedSkill = `${renderCoreSkillTemplate('sks-research')}mutated\n`;
  try {
    await fsp.mkdir(path.dirname(skillFile), { recursive: true });
    await fsp.writeFile(skillFile, driftedSkill, 'utf8');

    const report = await syncCoreSkillsIntegrity({
      root,
      apply: true,
      skillsRoot: path.join(root, '.agents', 'skills')
    });

    const restoredRow = report.rows.find((row) => row.canonical_name === 'sks-research');
    assert.equal(report.ok, true);
    assert.equal(report.restored.length, 1);
    assert.ok(restoredRow?.backup_path);
    assert.equal(isPathInside(root, String(restoredRow?.backup_path)), true);
    assert.equal(await fsp.readFile(String(restoredRow?.backup_path), 'utf8'), driftedSkill);
    assert.equal(await fsp.readFile(skillFile, 'utf8'), renderCoreSkillTemplate('sks-research'));
    assert.equal(await pathExists(path.join(root, '.sneakoscope', 'reports', 'core-skill-integrity.json')), true);
  } finally {
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

function assertBlockersAreClosed(blockers: string[], reason: string): void {
  for (const blocker of blockers) {
    assert.match(blocker, new RegExp(`^core_skill_path_unsafe:sks-[a-z0-9-]+:${reason}$`));
  }
  assertBlockersContainNoPathMaterial(blockers);
}

function assertBlockersContainNoPathMaterial(blockers: string[]): void {
  for (const blocker of blockers) {
    assert.equal(blocker.includes(SECRET_MARKER), false);
    assert.equal(blocker.includes('\n'), false);
    assert.equal(blocker.includes('\r'), false);
    assert.equal(blocker.includes('/'), false);
    assert.equal(blocker.includes('\\'), false);
    assert.equal(path.isAbsolute(blocker), false);
  }
}

async function snapshotTree(root: string, current: string = root): Promise<string[]> {
  const entries = await fsp.readdir(current, { withFileTypes: true });
  const snapshot: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute);
    if (entry.isDirectory()) {
      snapshot.push(`directory:${relative}`);
      snapshot.push(...await snapshotTree(root, absolute));
    } else if (entry.isSymbolicLink()) {
      snapshot.push(`symlink:${relative}:${await fsp.readlink(absolute)}`);
    } else {
      snapshot.push(`file:${relative}:${await fsp.readFile(absolute, 'utf8')}`);
    }
  }
  return snapshot;
}

async function pathExists(target: string): Promise<boolean> {
  return fsp.lstat(target).then(() => true, () => false);
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
