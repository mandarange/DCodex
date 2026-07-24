import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  cleanupRemovedSksSkillResidue,
  LEGACY_UNPREFIXED_SKS_SKILL_NAMES,
  loadSkillsManifest,
  reconcileSkills,
  REMOVED_SKS_SKILL_NAMES
} from '../../dist/core/init/skills.js';
import { initProject } from '../../dist/core/init.js';
import { runDoctorCommandAliasCleanup } from '../../dist/core/doctor/command-alias-cleanup.js';

const PRIMARY_REMOVED = ['team', 'mad-db', 'tmux', 'xai', 'swarm', 'shadow-clone', 'kage-bunshin', 'ralph'];

test('packaged skill manifest excludes retired skills and aliases', async () => {
  const manifest = await loadSkillsManifest();
  const names = new Set(manifest.skills.map((skill) => skill.canonical_name));
  const aliases = new Set(manifest.skills.flatMap((skill) => skill.deprecated_aliases || []));
  assert.equal(aliases.size, 0, 'latest-only skill manifest must not publish deprecated aliases');
  assert.equal(Object.hasOwn(manifest, 'removed_skills'), false, 'latest-only manifest must not publish retired names');
  for (const name of REMOVED_SKS_SKILL_NAMES) {
    assert.equal(names.has(name), false, name);
    assert.equal(aliases.has(name), false, name);
  }
  for (const name of LEGACY_UNPREFIXED_SKS_SKILL_NAMES) {
    assert.equal(names.has(name), false, `legacy unprefixed skill published: ${name}`);
    assert.equal(aliases.has(name), false, `legacy unprefixed alias published: ${name}`);
  }
});

test('removed SKS skill cleanup covers global, project, and codex mirrors while preserving user content', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-removed-skill-cleanup-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  try {
    await writeManagedSkill(path.join(home, '.agents', 'skills', 'team'), 'team');
    await writeManagedSkill(path.join(home, '.codex', 'skills', 'mad-db'), 'mad-db');
    await writeManagedSkill(path.join(home, '.agents', 'skills', 'tmux'), 'tmux');
    await writeManagedSkill(path.join(home, '.agents', 'skills', 'ralph'), 'ralph');
    await writeManagedSkill(path.join(home, '.agents', 'skills', 'sks-research-discovery'), 'sks-research-discovery');
    await writeManagedSkill(path.join(root, '.agents', 'skills', 'swarm'), 'swarm');
    await writeManagedSkill(path.join(root, '.codex', 'skills', 'shadow-clone'), 'shadow-clone');
    await writeManagedSkill(path.join(root, '.codex', 'skills', 'xai'), 'xai');
    await writeUserSkill(path.join(root, '.agents', 'skills', 'kage-bunshin'), 'kage-bunshin', 'user-owned legacy-name content');
    await writeUserSkill(path.join(home, '.agents', 'skills', 'my-skill'), 'my-skill', 'keep global user skill');
    await writeUserSkill(path.join(root, '.agents', 'skills', 'project-helper'), 'project-helper', 'keep project user skill');
    await writeUserSkill(path.join(root, '.codex', 'skills', 'codex-helper'), 'codex-helper', 'keep codex user skill');

    const first = await cleanupRemovedSksSkillResidue({ root, home, fix: true });
    assert.equal(first.ok, true);
    assert.equal(first.removed.length, 8);
    assert.equal(first.quarantined_user_collisions.length, 1);
    assert.deepEqual(first.remaining, []);
    for (const rel of [
      path.join(home, '.agents', 'skills', 'team'),
      path.join(home, '.codex', 'skills', 'mad-db'),
      path.join(home, '.agents', 'skills', 'tmux'),
      path.join(home, '.agents', 'skills', 'ralph'),
      path.join(home, '.agents', 'skills', 'sks-research-discovery'),
      path.join(root, '.agents', 'skills', 'swarm'),
      path.join(root, '.codex', 'skills', 'shadow-clone'),
      path.join(root, '.codex', 'skills', 'xai'),
      path.join(root, '.agents', 'skills', 'kage-bunshin')
    ]) await assertMissing(rel);
    assert.equal(await readSkill(path.join(home, '.agents', 'skills', 'my-skill')), 'keep global user skill');
    assert.equal(await readSkill(path.join(root, '.agents', 'skills', 'project-helper')), 'keep project user skill');
    assert.equal(await readSkill(path.join(root, '.codex', 'skills', 'codex-helper')), 'keep codex user skill');
    const quarantineFiles = await findFiles(path.join(root, '.sneakoscope', 'quarantine', 'skills'), 'SKILL.md');
    assert.equal(quarantineFiles.length, 1);
    assert.match(await fs.readFile(quarantineFiles[0], 'utf8'), /user-owned legacy-name content/);

    const second = await cleanupRemovedSksSkillResidue({ root, home, fix: true });
    assert.equal(second.ok, true);
    assert.deepEqual(second.detected, []);
    assert.deepEqual(second.removed, []);
    assert.deepEqual(second.quarantined_user_collisions, []);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('removed skill cleanup quarantines markerless user prose that resembles historical generated content', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-markerless-removed-skill-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  const projectDir = path.join(root, '.agents', 'skills', 'research');
  const globalDir = path.join(home, '.codex', 'skills', 'research-discovery');
  const projectBytes = markerlessHistoricalSkillBytes(
    'research',
    'Sneakoscope generated is discussed here as user-authored prose.'
  );
  const globalBytes = markerlessHistoricalSkillBytes(
    'research-discovery',
    'Codex App pipeline activation: this sentence is user-authored documentation.'
  );
  try {
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(globalDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, 'SKILL.md'), projectBytes);
    await fs.writeFile(path.join(globalDir, 'SKILL.md'), globalBytes);

    const report = await cleanupRemovedSksSkillResidue({ root, home, fix: true });

    assert.equal(report.ok, true, JSON.stringify(report.errors));
    assert.equal(report.removed.length, 0);
    assert.equal(report.quarantined_user_collisions.length, 2);
    await assertMissing(projectDir);
    await assertMissing(globalDir);
    const quarantined = [
      ...await findFiles(path.join(root, '.sneakoscope', 'quarantine', 'skills'), 'SKILL.md'),
      ...await findFiles(path.join(home, '.sneakoscope', 'quarantine', 'skills'), 'SKILL.md')
    ];
    assert.equal(quarantined.length, 2);
    const preserved = await Promise.all(quarantined.map((file) => fs.readFile(file)));
    assert.ok(preserved.some((bytes) => bytes.equals(projectBytes)));
    assert.ok(preserved.some((bytes) => bytes.equals(globalBytes)));
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('removed skill cleanup canonicalizes managed variants across nested mirrors', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-removed-skill-variants-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  const nested = path.join(root, 'packages', 'app');
  try {
    await writeManagedSkill(path.join(home, '.agents', 'skills', 'Team'), 'Team');
    await writeManagedSkill(path.join(nested, '.agents', 'skills', 'MAD-DB'), 'MAD-DB');
    await writeManagedSkill(path.join(nested, '.codex', 'skills', 'mad_db'), 'mad_db');
    await writeManagedSkill(path.join(nested, '.agents', 'skills', 'MAD-SKS'), 'MAD-SKS');
    await writeUserSkill(path.join(root, 'services', 'api', '.agents', 'skills', 'TEAM'), 'TEAM', 'keep me in quarantine');

    const report = await cleanupRemovedSksSkillResidue({ root, home, fix: true });
    assert.equal(report.ok, true, JSON.stringify(report.errors));
    assert.equal(report.removed.length, 4);
    assert.equal(report.quarantined_user_collisions.length, 1);
    await assertMissing(path.join(home, '.agents', 'skills', 'Team'));
    await assertMissing(path.join(nested, '.agents', 'skills', 'MAD-DB'));
    await assertMissing(path.join(nested, '.codex', 'skills', 'mad_db'));
    await assertMissing(path.join(nested, '.agents', 'skills', 'MAD-SKS'));
    await assertMissing(path.join(root, 'services', 'api', '.agents', 'skills', 'TEAM'));
    const quarantined = await findFiles(path.join(root, '.sneakoscope', 'quarantine', 'skills'), 'SKILL.md');
    assert.equal(quarantined.length, 1);
    assert.match(await fs.readFile(quarantined[0], 'utf8'), /keep me in quarantine/);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('removed skill cleanup quarantines link objects without reading or mutating external targets', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-removed-skill-symlinks-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  const globalRuntimeRoot = path.join(fixture, 'global-runtime');
  const outsideRoot = path.join(fixture, 'outside-root');
  const outsideSkill = path.join(fixture, 'outside-skill');
  const outsideManifest = path.join(fixture, 'outside-skills-manifest.json');
  try {
    await fs.mkdir(path.join(home, '.agents'), { recursive: true });
    await fs.mkdir(path.join(root, '.agents', 'skills'), { recursive: true });
    await writeManagedSkill(path.join(outsideRoot, 'team'), 'team');
    await fs.writeFile(path.join(outsideRoot, 'root-proof.bin'), Buffer.from([0, 1, 2, 3, 255]));
    await writeManagedSkill(outsideSkill, 'mad-db');
    await fs.writeFile(path.join(outsideSkill, 'skill-proof.bin'), Buffer.from([255, 3, 2, 1, 0]));
    await fs.writeFile(outsideManifest, '{"schema":"sks.skills-manifest.v1","skills":[{"canonical_name":"team"}]}\n');
    await fs.symlink(outsideRoot, path.join(home, '.agents', 'skills'));
    await fs.symlink(outsideSkill, path.join(root, '.agents', 'skills', 'mad-db'));
    await fs.symlink(outsideManifest, path.join(root, '.agents', 'skills', 'skills-manifest.json'));

    const rootProof = await fs.readFile(path.join(outsideRoot, 'root-proof.bin'));
    const skillProof = await fs.readFile(path.join(outsideSkill, 'skill-proof.bin'));
    const rootSkillProof = await fs.readFile(path.join(outsideRoot, 'team', 'SKILL.md'));
    const linkedSkillProof = await fs.readFile(path.join(outsideSkill, 'SKILL.md'));
    const manifestProof = await fs.readFile(outsideManifest);

    const report = await cleanupRemovedSksSkillResidue({ root, home, globalRuntimeRoot, fix: true });
    assert.equal(report.ok, true, JSON.stringify(report.errors));
    assert.equal(report.quarantined_user_collisions.length, 2);
    assert.equal(report.quarantined_manifest_collisions?.length, 1);
    assert.deepEqual(report.remaining, []);
    await assertMissing(path.join(home, '.agents', 'skills'));
    await assertMissing(path.join(root, '.agents', 'skills', 'mad-db'));
    await assertMissing(path.join(root, '.agents', 'skills', 'skills-manifest.json'));

    assert.deepEqual(await fs.readFile(path.join(outsideRoot, 'root-proof.bin')), rootProof);
    assert.deepEqual(await fs.readFile(path.join(outsideSkill, 'skill-proof.bin')), skillProof);
    assert.deepEqual(await fs.readFile(path.join(outsideRoot, 'team', 'SKILL.md')), rootSkillProof);
    assert.deepEqual(await fs.readFile(path.join(outsideSkill, 'SKILL.md')), linkedSkillProof);
    assert.deepEqual(await fs.readFile(outsideManifest), manifestProof);

    const homeRecords = await findFiles(path.join(home, '.sneakoscope', 'quarantine', 'skills'), 'quarantine-record.json');
    const projectRecords = await findFiles(path.join(root, '.sneakoscope', 'quarantine', 'skills'), 'quarantine-record.json');
    assert.equal(homeRecords.length, 1);
    assert.equal(projectRecords.length, 2);
    for (const recordPath of [...homeRecords, ...projectRecords]) {
      const record = JSON.parse(await fs.readFile(recordPath, 'utf8'));
      assert.equal(path.dirname(record.quarantine_path), path.dirname(recordPath));
      assert.notEqual(record.quarantine_path, path.dirname(recordPath), 'record must be a sibling of the moved link');
      assert.equal((await fs.lstat(record.quarantine_path)).isSymbolicLink(), true);
    }
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('removed skill cleanup scrubs HOME and SKS_GLOBAL_ROOT generated manifests idempotently', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-removed-skill-manifests-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  const globalRuntimeRoot = path.join(fixture, 'global-runtime');
  const targets = [
    path.join(home, '.agents', 'skills'),
    path.join(globalRuntimeRoot, '.agents', 'skills')
  ];
  try {
    await fs.mkdir(root, { recursive: true });
    for (const target of targets) {
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, '.sks-generated.json'), JSON.stringify({
        schema_version: 1,
        generated_by: 'sneakoscope',
        version: '6.2.0',
        prune_policy: 'remove_previous_sks_generated_paths_absent_from_current_manifest',
        skills: ['team', 'naruto', 'mad-db', 'answer'],
        files: [
          '.agents/skills/team/SKILL.md',
          '.agents/skills/naruto/SKILL.md',
          '.agents/skills/mad-db/agents/openai.yaml',
          '.agents/skills/answer/SKILL.md'
        ]
      }, null, 2));
      await fs.writeFile(path.join(target, 'skills-manifest.json'), JSON.stringify({
        schema: 'sks.skills-manifest.v1',
        package_version: '6.2.0',
        removed_skills: ['team', 'mad-db'],
        skills: [
          { canonical_name: 'team', type: 'official', content_sha256: 'team', hash_history: [], deprecated_aliases: [] },
          { canonical_name: 'naruto', type: 'official', content_sha256: 'naruto', hash_history: [], deprecated_aliases: ['mad-db'] },
          { canonical_name: 'answer', type: 'official', content_sha256: 'answer', hash_history: [], deprecated_aliases: [] }
        ]
      }, null, 2));
    }

    const first = await cleanupRemovedSksSkillResidue({ root, home, globalRuntimeRoot, fix: true });
    assert.equal(first.ok, true, JSON.stringify(first.errors));
    assert.equal(first.rewritten_manifests?.length, 4);
    assert.deepEqual(first.remaining, []);
    for (const target of targets) {
      const generated = JSON.parse(await fs.readFile(path.join(target, '.sks-generated.json'), 'utf8'));
      assert.deepEqual(generated.skills, []);
      assert.deepEqual(generated.files, []);
      const packaged = JSON.parse(await fs.readFile(path.join(target, 'skills-manifest.json'), 'utf8'));
      assert.equal(Object.hasOwn(packaged, 'removed_skills'), false);
      assert.deepEqual(packaged.skills, []);
      assert.doesNotMatch(JSON.stringify({ generated, packaged }), /"(?:team|mad-db|tmux|xai|swarm|shadow-clone|kage-bunshin|ralph|naruto|answer)"/i);
    }

    const second = await cleanupRemovedSksSkillResidue({ root, home, globalRuntimeRoot, fix: true });
    assert.equal(second.ok, true, JSON.stringify(second.errors));
    assert.deepEqual(second.rewritten_manifests, []);
    assert.deepEqual(second.quarantined_manifest_collisions, []);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('skill reconcile replaces managed prefixless dollar commands with one sks-prefixed picker surface', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-prefixed-dollar-reconcile-'));
  const home = path.join(fixture, 'home');
  try {
    for (const name of ['naruto', 'dfix', 'qa-loop']) {
      await writeManagedSkill(path.join(home, '.agents', 'skills', name), name);
    }
    await writeManagedSkill(path.join(home, '.codex', 'skills', 'work'), 'work');
    await writeUserSkill(path.join(home, '.agents', 'skills', 'customer-helper'), 'customer-helper', 'keep customer helper');

    const report = await reconcileSkills({
      targetDir: path.join(home, '.agents', 'skills'),
      scope: 'global',
      fix: true
    });

    assert.equal(report.ok, true, report.warnings.join('\n'));
    assert.ok((report.retired_residue?.removed_count || 0) >= 4);
    for (const name of ['naruto', 'dfix', 'qa-loop', 'work']) {
      await assertMissing(path.join(home, '.agents', 'skills', name));
      await assertMissing(path.join(home, '.codex', 'skills', name));
      assert.equal((await fs.stat(path.join(home, '.agents', 'skills', `sks-${name}`, 'SKILL.md'))).isFile(), true);
    }
    assert.equal(await readSkill(path.join(home, '.agents', 'skills', 'customer-helper')), 'keep customer helper');
    assert.ok(report.installed_skills.every((name) => name === 'sks' || !LEGACY_UNPREFIXED_SKS_SKILL_NAMES.includes(name)));
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('global reconcile includes the configured SKS_GLOBAL_ROOT cleanup surface', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-global-runtime-reconcile-'));
  const home = path.join(fixture, 'home');
  const globalRuntimeRoot = path.join(fixture, 'global-runtime');
  const previousGlobalRoot = process.env.SKS_GLOBAL_ROOT;
  try {
    process.env.SKS_GLOBAL_ROOT = globalRuntimeRoot;
    await fs.mkdir(home, { recursive: true });
    await writeManagedSkill(path.join(globalRuntimeRoot, '.agents', 'skills', 'team'), 'team');
    await fs.writeFile(path.join(globalRuntimeRoot, '.agents', 'skills', '.sks-generated.json'), JSON.stringify({
      schema_version: 1,
      generated_by: 'sneakoscope',
      version: '6.2.0',
      prune_policy: 'remove_previous_sks_generated_paths_absent_from_current_manifest',
      skills: ['team', 'naruto'],
      files: ['.agents/skills/team/SKILL.md', '.agents/skills/naruto/SKILL.md']
    }, null, 2));

    const report = await reconcileSkills({
      targetDir: path.join(home, '.agents', 'skills'),
      scope: 'global',
      fix: true
    });
    assert.equal(report.ok, true, report.warnings.join('\n'));
    assert.ok((report.retired_residue?.removed_count || 0) >= 1);
    assert.equal(report.retired_residue?.rewritten_manifest_count, 1);
    await assertMissing(path.join(globalRuntimeRoot, '.agents', 'skills', 'team'));
    const generated = JSON.parse(await fs.readFile(path.join(globalRuntimeRoot, '.agents', 'skills', '.sks-generated.json'), 'utf8'));
    assert.deepEqual(generated.skills, []);
    assert.deepEqual(generated.files, []);
  } finally {
    if (previousGlobalRoot === undefined) delete process.env.SKS_GLOBAL_ROOT;
    else process.env.SKS_GLOBAL_ROOT = previousGlobalRoot;
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('reconcileSkills refuses an ancestor symlink and propagates cleanup failure without external writes', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-skill-ancestor-symlink-'));
  const root = path.join(fixture, 'project');
  const outsideAgents = path.join(fixture, 'outside-agents');
  try {
    await fs.mkdir(root, { recursive: true });
    await writeManagedSkill(path.join(outsideAgents, 'skills', 'team'), 'team');
    const before = await fs.readFile(path.join(outsideAgents, 'skills', 'team', 'SKILL.md'));
    await fs.symlink(outsideAgents, path.join(root, '.agents'));

    const report = await reconcileSkills({
      targetDir: path.join(root, '.agents', 'skills'),
      scope: 'project',
      fix: true
    });
    assert.equal(report.ok, false);
    assert.ok((report.retired_residue?.error_count || 0) > 0);
    assert.ok((report.retired_residue?.remaining_count || 0) > 0);
    assert.match(report.warnings.join('\n'), /retired_skill_cleanup_failed/);
    assert.deepEqual(await fs.readFile(path.join(outsideAgents, 'skills', 'team', 'SKILL.md')), before);
    await assertMissing(path.join(outsideAgents, 'skills', 'naruto'));
    assert.equal(await fs.readlink(path.join(root, '.agents')), outsideAgents);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('global reconcile quarantines a core-skill directory symlink without mutating its external target', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-core-skill-symlink-collision-'));
  const home = path.join(fixture, 'home');
  const outsideSkill = path.join(fixture, 'outside', 'sks-naruto');
  const outsideFile = path.join(outsideSkill, 'SKILL.md');
  try {
    await fs.mkdir(outsideSkill, { recursive: true });
    const externalText = [
      '---',
      'name: sks-naruto',
      'description: external managed-looking fixture',
      '---',
      '',
      '<!-- BEGIN SKS IMMUTABLE CORE SKILL -->',
      'external content must stay byte-identical',
      ''
    ].join('\n');
    await fs.writeFile(outsideFile, externalText);
    const skillsRoot = path.join(home, '.agents', 'skills');
    await fs.mkdir(skillsRoot, { recursive: true });
    await fs.symlink(outsideSkill, path.join(skillsRoot, 'sks-naruto'));

    const report = await reconcileSkills({ targetDir: skillsRoot, scope: 'global', fix: true });

    assert.equal(report.ok, true, report.warnings.join('\n'));
    assert.ok(report.quarantined_user_collisions.includes('sks-naruto'));
    assert.equal(await fs.readFile(outsideFile, 'utf8'), externalText);
    const installed = await fs.lstat(path.join(skillsRoot, 'sks-naruto'));
    assert.equal(installed.isDirectory(), true);
    assert.equal(installed.isSymbolicLink(), false);
    assert.match(await fs.readFile(path.join(skillsRoot, 'sks-naruto', 'SKILL.md'), 'utf8'), /BEGIN SKS IMMUTABLE CORE SKILL/);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('global reconcile quarantines an occupied official-name directory with no SKILL.md before installing metadata', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-official-missing-skill-collision-'));
  const home = path.join(fixture, 'home');
  const skillDir = path.join(home, '.agents', 'skills', 'sks-answer');
  const userMetadata = 'user-owned: keep-me\n';
  const userNotes = 'private user notes must survive\n';
  try {
    await fs.mkdir(path.join(skillDir, 'agents'), { recursive: true });
    await fs.writeFile(path.join(skillDir, 'agents', 'openai.yaml'), userMetadata);
    await fs.writeFile(path.join(skillDir, 'USER-NOTES.md'), userNotes);

    const report = await reconcileSkills({
      targetDir: path.join(home, '.agents', 'skills'),
      scope: 'global',
      fix: true
    });

    assert.equal(report.ok, true, report.warnings.join('\n'));
    assert.ok(report.quarantined_user_collisions.includes('sks-answer'));
    assert.match(await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8'), /BEGIN SKS MANAGED SKILL/);
    assert.notEqual(await fs.readFile(path.join(skillDir, 'agents', 'openai.yaml'), 'utf8'), userMetadata);

    const quarantinedMetadata = await findFiles(
      path.join(home, '.sneakoscope', 'quarantine', 'skills'),
      'openai.yaml'
    );
    const quarantinedNotes = await findFiles(
      path.join(home, '.sneakoscope', 'quarantine', 'skills'),
      'USER-NOTES.md'
    );
    assert.equal(quarantinedMetadata.length, 1);
    assert.equal(quarantinedNotes.length, 1);
    assert.equal(await fs.readFile(quarantinedMetadata[0], 'utf8'), userMetadata);
    assert.equal(await fs.readFile(quarantinedNotes[0], 'utf8'), userNotes);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('global reconcile quarantines stale generated skills that contain unexpected user files', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-stale-generated-user-content-'));
  const home = path.join(fixture, 'home');
  const skillsRoot = path.join(home, '.agents', 'skills');
  const staleName = 'sks-retired-helper';
  const safeStaleName = 'sks-retired-generated-only';
  const staleDir = path.join(skillsRoot, staleName);
  const safeStaleDir = path.join(skillsRoot, safeStaleName);
  const userNotes = Buffer.from('user notes inside a formerly generated skill\n');
  try {
    await writeManagedSkill(staleDir, staleName);
    await writeManagedSkill(safeStaleDir, safeStaleName);
    await fs.writeFile(path.join(staleDir, 'USER-NOTES.md'), userNotes);
    await fs.writeFile(path.join(skillsRoot, '.sks-generated.json'), JSON.stringify({
      schema_version: 1,
      generated_by: 'sneakoscope',
      version: '6.2.0',
      prune_policy: 'remove_previous_sks_generated_paths_absent_from_current_manifest',
      skills: [staleName, safeStaleName],
      files: [
        `.agents/skills/${staleName}/SKILL.md`,
        `.agents/skills/${staleName}/agents/openai.yaml`,
        `.agents/skills/${safeStaleName}/SKILL.md`,
        `.agents/skills/${safeStaleName}/agents/openai.yaml`
      ]
    }, null, 2));

    const report = await reconcileSkills({ targetDir: skillsRoot, scope: 'global', fix: true });

    assert.equal(report.ok, true, report.warnings.join('\n'));
    assert.ok(report.quarantined_user_collisions.includes(staleName));
    assert.equal(report.removed_stale_generated_skills.includes(`.agents/skills/${staleName}`), false);
    assert.ok(report.removed_stale_generated_skills.includes(`.agents/skills/${safeStaleName}`));
    await assertMissing(staleDir);
    await assertMissing(safeStaleDir);
    const quarantinedNotes = await findFiles(path.join(home, '.sneakoscope', 'quarantine', 'skills'), 'USER-NOTES.md');
    assert.equal(quarantinedNotes.length, 1);
    assert.deepEqual(await fs.readFile(quarantinedNotes[0]), userNotes);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('global reconcile quarantines generated plugin and codex-mirror residue with unexpected user files', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-generated-residue-user-content-'));
  const home = path.join(fixture, 'home');
  const skillsRoot = path.join(home, '.agents', 'skills');
  const pluginDir = path.join(skillsRoot, 'browser-use');
  const codexMirrorDir = path.join(home, '.codex', 'skills', 'sks-answer');
  const pluginNotes = Buffer.from('user notes in generated plugin collision\n');
  const mirrorNotes = Buffer.from('user notes in generated codex mirror\n');
  try {
    await writeManagedSkill(pluginDir, 'browser-use');
    await writeManagedSkill(codexMirrorDir, 'sks-answer');
    await fs.writeFile(path.join(pluginDir, 'USER-NOTES.md'), pluginNotes);
    await fs.writeFile(path.join(codexMirrorDir, 'USER-NOTES.md'), mirrorNotes);

    const report = await reconcileSkills({ targetDir: skillsRoot, scope: 'global', fix: true });

    assert.equal(report.ok, true, report.warnings.join('\n'));
    assert.ok(report.quarantined_user_collisions.includes('browser-use'));
    assert.ok(report.quarantined_user_collisions.includes('sks-answer'));
    await assertMissing(pluginDir);
    await assertMissing(codexMirrorDir);
    const quarantinedNotes = await findFiles(path.join(home, '.sneakoscope', 'quarantine', 'skills'), 'USER-NOTES.md');
    assert.equal(quarantinedNotes.length, 2);
    const preserved = await Promise.all(quarantinedNotes.map((file) => fs.readFile(file)));
    assert.ok(preserved.some((bytes) => bytes.equals(pluginNotes)));
    assert.ok(preserved.some((bytes) => bytes.equals(mirrorNotes)));
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('global reconcile quarantines markerless plugin and codex-mirror prose instead of deleting it', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-markerless-generated-residue-'));
  const home = path.join(fixture, 'home');
  const skillsRoot = path.join(home, '.agents', 'skills');
  const pluginDir = path.join(skillsRoot, 'browser-use');
  const codexMirrorDir = path.join(home, '.codex', 'skills', 'sks-answer');
  const pluginBytes = markerlessHistoricalSkillBytes(
    'browser-use',
    'Sneakoscope generated is discussed here as ordinary user-authored prose.'
  );
  const mirrorBytes = markerlessHistoricalSkillBytes(
    'sks-answer',
    'Codex App pipeline activation: this sentence is ordinary user-authored prose.'
  );
  try {
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.mkdir(codexMirrorDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, 'SKILL.md'), pluginBytes);
    await fs.writeFile(path.join(codexMirrorDir, 'SKILL.md'), mirrorBytes);

    const report = await reconcileSkills({ targetDir: skillsRoot, scope: 'global', fix: true });

    assert.equal(report.ok, true, report.warnings.join('\n'));
    assert.equal(report.removed_stale_generated_skills.includes('.agents/skills/browser-use'), false);
    assert.equal(report.removed_agent_skill_aliases.includes('sks-answer'), false);
    assert.ok(report.quarantined_user_collisions.includes('browser-use'));
    assert.ok(report.quarantined_user_collisions.includes('sks-answer'));
    await assertMissing(pluginDir);
    await assertMissing(codexMirrorDir);
    const quarantined = await findFiles(
      path.join(home, '.sneakoscope', 'quarantine', 'skills'),
      'SKILL.md'
    );
    assert.equal(quarantined.length, 2);
    const preserved = await Promise.all(quarantined.map((file) => fs.readFile(file)));
    assert.ok(preserved.some((bytes) => bytes.equals(pluginBytes)));
    assert.ok(preserved.some((bytes) => bytes.equals(mirrorBytes)));
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('global reconcile quarantines user-owned reserved skill manifests before replacing them', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-reserved-manifest-collision-'));
  const home = path.join(fixture, 'home');
  const skillsRoot = path.join(home, '.agents', 'skills');
  const generatedBytes = Buffer.from('{"schema_version":1,"generated_by":"sneakoscope","prune_policy":"customer-policy","skills":["private-helper"],"files":[]}\n');
  const packagedBytes = Buffer.from('{"schema":"sks.skills-manifest.v1","package_version":"customer","skills":[{"canonical_name":"private-helper"}],"notes":"preserve exactly"}\n');
  try {
    await fs.mkdir(skillsRoot, { recursive: true });
    await fs.writeFile(path.join(skillsRoot, '.sks-generated.json'), generatedBytes);
    await fs.writeFile(path.join(skillsRoot, 'skills-manifest.json'), packagedBytes);

    const report = await reconcileSkills({ targetDir: skillsRoot, scope: 'global', fix: true });

    assert.equal(report.ok, true, report.warnings.join('\n'));
    assert.deepEqual(report.quarantined_manifest_collisions, ['.sks-generated.json', 'skills-manifest.json']);
    const generated = JSON.parse(await fs.readFile(path.join(skillsRoot, '.sks-generated.json'), 'utf8'));
    const packaged = JSON.parse(await fs.readFile(path.join(skillsRoot, 'skills-manifest.json'), 'utf8'));
    assert.equal(generated.generated_by, 'sneakoscope');
    assert.equal(packaged.schema, 'sks.skills-manifest.v1');

    const quarantinedGenerated = await findFiles(
      path.join(home, '.sneakoscope', 'quarantine', 'skills'),
      '.sks-generated.json'
    );
    const quarantinedPackaged = await findFiles(
      path.join(home, '.sneakoscope', 'quarantine', 'skills'),
      'skills-manifest.json'
    );
    assert.equal(quarantinedGenerated.length, 1);
    assert.equal(quarantinedPackaged.length, 1);
    assert.deepEqual(await fs.readFile(quarantinedGenerated[0]), generatedBytes);
    assert.deepEqual(await fs.readFile(quarantinedPackaged[0]), packagedBytes);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('reconcileSkills reports unreadable retired skill residue instead of claiming cleanup', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-unreadable-retired-skill-'));
  const skillDir = path.join(root, '.agents', 'skills', 'team');
  try {
    await writeManagedSkill(skillDir, 'team');
    await fs.chmod(skillDir, 0o000);
    const inaccessible = await fs.readFile(path.join(skillDir, 'SKILL.md')).then(() => false, () => true);
    if (!inaccessible) {
      t.skip('filesystem permissions do not make the fixture unreadable for this runtime');
      return;
    }

    const report = await reconcileSkills({
      targetDir: path.join(root, '.agents', 'skills'),
      scope: 'project',
      fix: true
    });
    assert.equal(report.ok, false);
    assert.ok((report.retired_residue?.error_count || 0) > 0);
    assert.ok((report.retired_residue?.remaining_count || 0) > 0);
    assert.match(report.warnings.join('\n'), /retired_skill_cleanup_failed/);
  } finally {
    await fs.chmod(skillDir, 0o700).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('project skill reconciliation deletes generated retired entries without touching unrelated skills', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-project-skill-reconcile-'));
  try {
    await writeManagedSkill(path.join(root, '.agents', 'skills', 'team'), 'team');
    await writeManagedSkill(path.join(root, '.codex', 'skills', 'mad-db'), 'mad-db');
    await writeUserSkill(path.join(root, '.agents', 'skills', 'customer-workflow'), 'customer-workflow', 'customer content');

    const report = await reconcileSkills({
      targetDir: path.join(root, '.agents', 'skills'),
      scope: 'project',
      fix: true
    });
    assert.equal(report.retired_residue?.remaining_count, 0);
    assert.equal(report.retired_residue?.removed_count, 2);
    assert.equal(Object.hasOwn(report, 'legacy_skill_residue_remaining'), false);
    assert.equal(Object.hasOwn(report, 'removed_legacy_skill_dirs'), false);
    assert.doesNotMatch(JSON.stringify(report), /(?:team|mad-db|tmux|xai|swarm|shadow-clone|kage-bunshin|ralph)/i);
    await assertMissing(path.join(root, '.agents', 'skills', 'team'));
    await assertMissing(path.join(root, '.codex', 'skills', 'mad-db'));
    assert.equal(await readSkill(path.join(root, '.agents', 'skills', 'customer-workflow')), 'customer content');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('project skill reconciliation quarantines managed-looking retired residue with USER-NOTES.md intact', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-project-skill-user-notes-'));
  const skillDir = path.join(root, '.agents', 'skills', 'team');
  const userNotes = Buffer.from('user-authored notes inside managed-looking residue\n');
  try {
    await writeManagedSkill(skillDir, 'team');
    await fs.writeFile(path.join(skillDir, 'USER-NOTES.md'), userNotes);

    const report = await reconcileSkills({
      targetDir: path.join(root, '.agents', 'skills'),
      scope: 'project',
      fix: true
    });

    assert.equal(report.ok, true, report.warnings.join('\n'));
    assert.equal(report.retired_residue?.removed_count, 0);
    assert.equal(report.retired_residue?.quarantined_user_collision_count, 1);
    await assertMissing(skillDir);
    const quarantinedSkills = await findFiles(path.join(root, '.sneakoscope', 'quarantine', 'skills'), 'SKILL.md');
    const quarantinedNotes = await findFiles(path.join(root, '.sneakoscope', 'quarantine', 'skills'), 'USER-NOTES.md');
    assert.equal(quarantinedSkills.length, 1);
    assert.equal(quarantinedNotes.length, 1);
    assert.deepEqual(await fs.readFile(quarantinedNotes[0]), userNotes);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('generated project guidance advertises Naruto and no retired compatibility surfaces', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-current-guidance-'));
  const home = path.join(root, 'home');
  try {
    await initProject(root, { installScope: 'project', localOnly: true, home });
    const agents = await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8');
    const quickReference = await fs.readFile(path.join(root, '.codex', 'SNEAKOSCOPE.md'), 'utf8');
    assert.equal(agents.match(/Core Engineering Directive/g)?.length, 1);
    assert.match(agents, /do not manufacture low-value test matrices/);
    assert.equal(quickReference.match(/Core Engineering Directive/g)?.length, 1);
    assert.match(quickReference, /from AGENTS\.md exactly/);
    for (const text of [agents, quickReference]) {
      assert.match(text, /\$sks-naruto|naruto run/);
      assert.doesNotMatch(text, /\$(?:Naruto|Work|DFix|QA-LOOP)\b/);
      assert.doesNotMatch(text, /\$Agent|\$Team|sks team|\$MAD-DB|sks mad-db|\$Swarm|\$ShadowClone|\$Kagebunshin|\$Ralph|sks ralph/i);
      assert.doesNotMatch(text, /Lean Engineering Policy|safe single expression|release gates <= 200/i);
    }
    for (const name of PRIMARY_REMOVED) {
      await assertMissing(path.join(root, '.agents', 'skills', name));
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('doctor fix rewrites only SKS-managed guidance to the current public surface', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-doctor-current-guidance-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  try {
    await fs.mkdir(path.join(root, '.codex'), { recursive: true });
    await fs.writeFile(path.join(root, 'AGENTS.md'), [
      'customer-authored-prefix',
      '<!-- BEGIN Sneakoscope Codex GX MANAGED BLOCK -->',
      '# Retired SKS guidance',
      '- Use `$Agent`, `$Team`, and `$MAD-DB`.',
      '<!-- END Sneakoscope Codex GX MANAGED BLOCK -->',
      ''
    ].join('\n'));
    await fs.writeFile(path.join(root, '.codex', 'SNEAKOSCOPE.md'), [
      '# ㅅㅋㅅ',
      'Install scope: `project`',
      'Command: `node ./node_modules/sneakoscope/dist/bin/sks.js <command>`',
      'Files: AGENTS.md, .codex/hooks.json, .codex/config.toml, .codex/SNEAKOSCOPE.md, .agents/skills, .codex/agents, .sneakoscope/missions.',
      'Use `$Agent`, `sks team`, and `sks mad-db`.',
      ''
    ].join('\n'));

    const first = await runDoctorCommandAliasCleanup({ root, home, fix: true });
    assert.equal(first.ok, true);
    assert.equal(first.cleanup.project_guidance.reconciled_count, 2);
    assert.equal(first.cleanup.project_guidance.remaining_count, 0);
    const agents = await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8');
    const quickReference = await fs.readFile(path.join(root, '.codex', 'SNEAKOSCOPE.md'), 'utf8');
    assert.match(agents, /customer-authored-prefix/);
    for (const text of [agents, quickReference]) {
      assert.match(text, /\$sks-naruto|naruto run/);
      assert.doesNotMatch(text, /\$(?:Naruto|Work|DFix|QA-LOOP)\b/);
      assert.doesNotMatch(text, /\$Agent|\$Team|sks team|\$MAD-DB|sks mad-db/i);
    }

    const second = await runDoctorCommandAliasCleanup({ root, home, fix: true });
    assert.equal(second.ok, true);
    assert.equal(second.cleanup.project_guidance.reconciled_count, 0);
    assert.equal(second.cleanup.project_guidance.remaining_count, 0);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('doctor fix quarantines user-authored guidance collisions before installing current guidance', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-doctor-user-guidance-collision-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  try {
    await fs.mkdir(path.join(root, '.codex'), { recursive: true });
    await fs.writeFile(path.join(root, 'AGENTS.md'), 'customer project instructions\nUse `$ShadowClone` for implementation.\n');
    await fs.writeFile(path.join(root, '.codex', 'SNEAKOSCOPE.md'), 'customer quick reference\nRun `sks xai status`.\n');

    const first = await runDoctorCommandAliasCleanup({ root, home, fix: true });
    assert.equal(first.ok, true);
    assert.equal(first.cleanup.project_guidance.reconciled_count, 2);
    assert.equal(first.cleanup.project_guidance.preserved_user_file_count, 2);

    const agents = await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8');
    const quickReference = await fs.readFile(path.join(root, '.codex', 'SNEAKOSCOPE.md'), 'utf8');
    for (const text of [agents, quickReference]) {
      assert.match(text, /\$sks-naruto|naruto run/);
      assert.doesNotMatch(text, /\$(?:Naruto|Work|DFix|QA-LOOP)\b/);
      assert.doesNotMatch(text, /\$ShadowClone|sks xai/i);
    }

    const quarantineRoot = path.join(root, '.sneakoscope', 'quarantine', 'current-project-guidance');
    const quarantinedAgents = await findFiles(quarantineRoot, 'AGENTS.md');
    const quarantinedQuickReference = await findFiles(quarantineRoot, 'SNEAKOSCOPE.md');
    assert.equal(quarantinedAgents.length, 1);
    assert.equal(quarantinedQuickReference.length, 1);
    assert.match(await fs.readFile(quarantinedAgents[0], 'utf8'), /customer project instructions/);
    assert.match(await fs.readFile(quarantinedQuickReference[0], 'utf8'), /customer quick reference/);

    const second = await runDoctorCommandAliasCleanup({ root, home, fix: true });
    assert.equal(second.ok, true);
    assert.equal(second.cleanup.project_guidance.reconciled_count, 0);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

async function writeManagedSkill(dir, name) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Sneakoscope generated legacy skill\n---\n\n<!-- BEGIN SKS MANAGED SKILL v6.2.0 name=${name} -->\n`, 'utf8');
}

async function writeUserSkill(dir, name, body) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: User-authored skill\n---\n\n${body}\n`, 'utf8');
}

function markerlessHistoricalSkillBytes(name, body) {
  return Buffer.from(`---\nname: ${name}\ndescription: User-authored skill notes\n---\n\n${body}\nKeep this content byte-for-byte.\n`);
}

async function readSkill(dir) {
  const text = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8');
  return text.trim().split('\n').at(-1);
}

async function assertMissing(target) {
  await assert.rejects(fs.access(target), `${target} should be absent`);
}

async function findFiles(root, fileName) {
  const rows = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const row of rows) {
    const target = path.join(root, row.name);
    if (row.isDirectory()) files.push(...await findFiles(target, fileName));
    else if (row.name === fileName) files.push(target);
  }
  return files;
}
