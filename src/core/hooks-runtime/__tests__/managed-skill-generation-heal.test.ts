import '../../__tests__/helpers/isolated-test-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { PACKAGE_VERSION, sha256 } from '../../fsx.js';
import { installGlobalSkills, reconcileSkills } from '../../init/skills.js';
import { authoritativeSksSkillAdmission } from '../hook-context.js';
import { resolveAuthoritativeSksSkillSources } from '../../codex-native/sks-skill-paths.js';
import { healAuthoritativeManagedSkillDigestMismatches } from '../managed-skill-generation-heal.js';

const SKILL_NAME = 'sks-honest-mode';
const NARUTO_8_0_1 = [
  '---',
  'name: sks-naruto',
  'description: "Run a Codex official subagent workflow with official agent…"',
  '---',
  '',
  '<!-- BEGIN SKS IMMUTABLE CORE SKILL -->',
  'id: sks-core-naruto',
  'canonical_name: sks-naruto',
  'route: $sks-naruto',
  'template_version: sks-core-skill-template.v2',
  'mutable_by_doctor: false',
  'mutable_by_update: false',
  'mutable_by_setup: false',
  '<!-- END SKS IMMUTABLE CORE SKILL -->',
  '',
  '# $sks-naruto',
  '',
  '## Outcome',
  '',
  'Purpose: run a Codex official subagent workflow with official agent threads while parent integration remains owner.',
  '',
  '## Activation',
  '',
  'Route: $sks-naruto',
  'Command: $sks-naruto',
  'Use when: the user explicitly invokes $sks-naruto or the selected route requires bounded parallel delegation.',
  '',
  '## Workflow',
  '',
  'Workflow: Run sks naruto run "<task>" [--agents N] [--max-threads N] [--json] with Codex official subagent threads only. The parent owns decomposition, per-wave capacity, later root-owned waves, integration, and final verification. Automatic targets begin at 4/6/8 by task size and may expand to 12 when independent useful slices and healthy host capacity remain positive; max_threads is a cap, never a target, and max_depth=1 blocks nested delegation. Route each slice to the narrowest matching Codex role and wait for every planned thread before final. In an active Codex App Naruto mission, commit the strict parent evidence with sks naruto parent-summary --mission <id> --stdin, then return localized Markdown without exposing the JSON.',
  '',
  '## Runtime contract',
  '',
  'CLI entrypoint: sks naruto run "<task>" [--agents N] [--max-threads N] [--json]; sks naruto status|subagents|proof [--mission <id>] [--json]; sks naruto parent-summary --mission <id> --stdin [--json]',
  'Core directive: sks.core-engineering-directive.v1/83a59fec2975649a',
  '',
  '## Safety',
  '',
  'Safety: Preserve user-authored content, inherit the parent permission mode, do not spawn nested subagents, do not inject the full pack or the full TriWiki context into every child, and do not fall back to another model, process runtime, custom scheduler, or worker pool. The historical Naruto process runtime is removed; stop with explicit blocker evidence when the official path is unavailable.',
  '',
  '## Evidence',
  '',
  'Evidence/artifacts: subagent-plan.json, subagent-events.jsonl, subagent-parent-summary.json, subagent-evidence.json, naruto-summary.json, and naruto-gate.json.',
  '',
  '## Failure recovery',
  '',
  'Failure/recovery: Return explicit official-subagent availability blockers and continue parent-owned only when the sealed task still has meaningful in-scope work; never fabricate process, PID, or subagent evidence.',
  ''
].join('\n');

function staleManagedSkillText(name: string, marker: string) {
  return [
    '---',
    `name: ${name}`,
    'description: stale managed skill body from an older sneakoscope install',
    '---',
    '',
    'Stale managed body that no longer matches the packaged digest.',
    '',
    marker,
    ''
  ].join('\n');
}

async function seedGlobalSkills(home: string) {
  await fsp.mkdir(home, { recursive: true });
  const install = await installGlobalSkills(home);
  assert.equal(install.ok, true, JSON.stringify(install));
  return {
    skill: path.join(home, '.agents', 'skills', SKILL_NAME, 'SKILL.md')
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

async function readOnlyMismatchResolution(root: string, home: string) {
  const resolution = await resolveAuthoritativeSksSkillSources({
    root,
    home,
    skillNames: ['honest-mode']
  });
  assert.deepEqual(
    resolution.blockers,
    [`content_digest_mismatch:${SKILL_NAME}:global`]
  );
  return resolution;
}

test('admission refuses unknown managed bytes even when their marker claims an old version', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-managed-skill-generation-heal-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  try {
    await fsp.mkdir(root, { recursive: true });
    const { skill } = await seedGlobalSkills(home);
    const unknown = staleManagedSkillText(
      SKILL_NAME,
      `<!-- BEGIN SKS MANAGED SKILL legacy-version??? name=${SKILL_NAME} -->`
    );
    await fsp.writeFile(skill, unknown);

    const admission = await withHome(home, () => authoritativeSksSkillAdmission(root, ['honest-mode']));
    assert.equal(admission.blocked?.decision, 'block');
    assert.match(
      String(admission.blocked?.reason || ''),
      /stale_generation_contains_unknown_managed_content|content_digest_mismatch/
    );
    assert.equal(await fsp.readFile(skill, 'utf8'), unknown);
  } finally {
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('admission reconciles a trusted 8.0.1 skill generation from immutable hash history', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-managed-skill-trusted-prior-generation-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  try {
    await fsp.mkdir(root, { recursive: true });
    await seedGlobalSkills(home);
    const skillsRoot = path.join(home, '.agents', 'skills');
    const skill = path.join(skillsRoot, 'sks-naruto', 'SKILL.md');
    const packaged = await fsp.readFile(skill, 'utf8');
    assert.equal(
      sha256(NARUTO_8_0_1),
      '49b5e3dcc1b537b49c2cf09e5b875cb16acb05c622b22798e265e64dacd8ac90'
    );
    await fsp.writeFile(skill, NARUTO_8_0_1);
    const markerPath = path.join(skillsRoot, '.sks-generated.json');
    const marker = JSON.parse(await fsp.readFile(markerPath, 'utf8'));
    marker.version = '8.0.1';
    await fsp.writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`);

    const admission = await withHome(home, () => authoritativeSksSkillAdmission(root, ['naruto']));
    assert.equal(admission.blocked, null, JSON.stringify(admission.blocked));
    assert.deepEqual(admission.resolution?.blockers, []);
    assert.equal(admission.resolution?.recovery?.healed_count, 1);
    assert.equal(
      admission.resolution?.recovery?.attempts[0]?.reason,
      'stale_global_generation_reconciled:version_mismatch'
    );
    assert.equal(await fsp.readFile(skill, 'utf8'), packaged);
    const healedMarker = JSON.parse(await fsp.readFile(markerPath, 'utf8'));
    assert.equal(healedMarker.version, PACKAGE_VERSION);

    const repeated = await withHome(home, () => authoritativeSksSkillAdmission(root, ['naruto']));
    assert.equal(repeated.blocked, null);
    assert.equal(repeated.resolution?.recovery, undefined);
    assert.equal(await fsp.readFile(skill, 'utf8'), packaged);
  } finally {
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('markerless user files remain byte-identical and blocked with exact file diagnostics', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-managed-skill-markerless-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  try {
    await fsp.mkdir(root, { recursive: true });
    const { skill } = await seedGlobalSkills(home);
    const markerless = Buffer.from([
      '---',
      `name: ${SKILL_NAME}`,
      'description: user-authored collision',
      '---',
      '',
      'Preserve these exact user bytes.',
      ''
    ].join('\n'));
    await fsp.writeFile(skill, markerless);

    const admission: any = await withHome(home, () => authoritativeSksSkillAdmission(root, ['honest-mode']));
    assert.equal(admission.blocked?.decision, 'block');
    assert.match(String(admission.blocked?.reason || ''), /rejected=not_sks_managed:sks-honest-mode:global/);
    assert.match(String(admission.blocked?.reason || ''), new RegExp(skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(String(admission.blocked?.reason || ''), /sks doctor --fix/);
    assert.deepEqual(await fsp.readFile(skill), markerless);
    await assert.rejects(fsp.access(path.join(root, '.sneakoscope', 'reports', 'migration-journal.jsonl')));
  } finally {
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('declared-name mismatches remain byte-identical and blocked', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-managed-skill-name-mismatch-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  try {
    await fsp.mkdir(root, { recursive: true });
    const { skill } = await seedGlobalSkills(home);
    const mismatched = staleManagedSkillText(
      'sks-answer',
      '<!-- BEGIN SKS MANAGED SKILL v99 name=sks-answer -->'
    );
    await fsp.writeFile(skill, mismatched);

    const resolution = await resolveAuthoritativeSksSkillSources({
      root,
      home,
      skillNames: ['honest-mode']
    });
    assert.deepEqual(resolution.blockers, ['canonical_name_mismatch:sks-honest-mode:global']);
    assert.deepEqual(resolution.unresolved, ['sks-honest-mode']);
    assert.equal(await fsp.readFile(skill, 'utf8'), mismatched);
    assert.equal(resolution.recovery, undefined);
  } finally {
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('digest healing refuses a crafted path escape without touching the outside file', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-managed-skill-path-escape-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  const outside = path.join(fixture, 'outside', 'SKILL.md');
  try {
    await Promise.all([
      fsp.mkdir(home, { recursive: true }),
      fsp.mkdir(root, { recursive: true }),
      fsp.mkdir(path.dirname(outside), { recursive: true })
    ]);
    const escaped = staleManagedSkillText(
      SKILL_NAME,
      `<!-- BEGIN SKS MANAGED SKILL v99 name=${SKILL_NAME} -->`
    );
    await fsp.writeFile(outside, escaped);
    const oldDigest = sha256(escaped);
    const report = await healAuthoritativeManagedSkillDigestMismatches({
      root,
      home,
      testHooks: {},
      resolution: {
        schema: 'sks.authoritative-skill-sources.v1',
        sources: [],
        unresolved: [SKILL_NAME],
        blockers: [`content_digest_mismatch:${SKILL_NAME}:global`],
        issues: [{
          requested_name: 'honest-mode',
          canonical_name: SKILL_NAME,
          scope: 'global',
          root: path.join(home, '.agents', 'skills'),
          path: outside,
          reason: 'content_digest_mismatch',
          content_sha256: oldDigest
        }]
      }
    });
    assert.equal(report.healed_count, 0);
    assert.equal(report.attempts[0]?.status, 'blocked');
    assert.equal(report.attempts[0]?.reason, 'authoritative_skill_path_confinement_failed');
    assert.equal(await fsp.readFile(outside, 'utf8'), escaped);
  } finally {
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('digest healing detects a concurrent content edit before atomic replacement and preserves its backup', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-managed-skill-content-race-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  try {
    await fsp.mkdir(root, { recursive: true });
    const { skill } = await seedGlobalSkills(home);
    const drifted = staleManagedSkillText(
      SKILL_NAME,
      `<!-- BEGIN SKS MANAGED SKILL v99 name=${SKILL_NAME} -->`
    );
    const concurrent = `${drifted}\nconcurrent third-party content edit\n`;
    await fsp.writeFile(skill, drifted);
    const resolution = await readOnlyMismatchResolution(root, home);

    const report = await healAuthoritativeManagedSkillDigestMismatches({
      root,
      home,
      resolution,
      testHooks: {
        beforeAtomicReplace: async () => {
          await fsp.writeFile(skill, concurrent);
        }
      }
    });

    const attempt = report.attempts[0];
    assert.equal(report.healed_count, 0);
    assert.equal(attempt?.status, 'blocked');
    assert.match(String(attempt?.reason), /^managed_skill_changed_before_atomic_replace/);
    assert.ok(attempt?.backup_path);
    assert.equal(await fsp.readFile(attempt!.backup_path!, 'utf8'), drifted);
    assert.equal(await fsp.readFile(skill, 'utf8'), concurrent);
    assert.ok(attempt?.journal_path);
    const rows = (await fsp.readFile(attempt!.journal_path!, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].step, 'self_heal_content_digest_mismatch_backup_ready');
    assert.equal(rows[0].changed, false);
  } finally {
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('final no-overwrite promotion preserves an edit made after the last bound-path check', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-managed-skill-final-promotion-race-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  try {
    await fsp.mkdir(root, { recursive: true });
    const { skill } = await seedGlobalSkills(home);
    const drifted = staleManagedSkillText(
      SKILL_NAME,
      `<!-- BEGIN SKS MANAGED SKILL v99 name=${SKILL_NAME} -->`
    );
    const concurrent = `${drifted}\nedit during final promotion\n`;
    await fsp.writeFile(skill, drifted);
    const resolution = await readOnlyMismatchResolution(root, home);

    const report = await healAuthoritativeManagedSkillDigestMismatches({
      root,
      home,
      resolution,
      testHooks: {
        beforeFinalPromotion: async () => {
          await fsp.writeFile(skill, concurrent);
        }
      }
    });

    const attempt = report.attempts[0];
    assert.equal(report.healed_count, 0);
    assert.equal(attempt?.status, 'blocked');
    assert.equal(attempt?.reason, 'managed_skill_changed_during_final_promotion');
    assert.equal(await fsp.readFile(skill, 'utf8'), concurrent);
    assert.equal(
      (await fsp.readdir(path.dirname(skill))).some((name) => name.endsWith('.sks-heal.claim')),
      false
    );
  } finally {
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('digest healing detects a concurrent symlink swap before atomic replacement without touching its target', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-managed-skill-symlink-race-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  const outside = path.join(fixture, 'outside-skill.md');
  const displaced = path.join(fixture, 'displaced-skill.md');
  try {
    await fsp.mkdir(root, { recursive: true });
    const { skill } = await seedGlobalSkills(home);
    const drifted = staleManagedSkillText(
      SKILL_NAME,
      `<!-- BEGIN SKS MANAGED SKILL v99 name=${SKILL_NAME} -->`
    );
    const outsideBytes = 'outside bytes must remain unchanged\n';
    await Promise.all([
      fsp.writeFile(skill, drifted),
      fsp.writeFile(outside, outsideBytes)
    ]);
    const resolution = await readOnlyMismatchResolution(root, home);

    const report = await healAuthoritativeManagedSkillDigestMismatches({
      root,
      home,
      resolution,
      testHooks: {
        beforeAtomicReplace: async () => {
          await fsp.rename(skill, displaced);
          await fsp.symlink(outside, skill);
        }
      }
    });

    const attempt = report.attempts[0];
    assert.equal(report.healed_count, 0);
    assert.equal(attempt?.status, 'blocked');
    assert.match(String(attempt?.reason), /^managed_skill_changed_before_atomic_replace/);
    assert.ok(attempt?.backup_path);
    assert.equal(await fsp.readFile(attempt!.backup_path!, 'utf8'), drifted);
    assert.equal((await fsp.lstat(skill)).isSymbolicLink(), true);
    assert.equal(await fsp.readFile(outside, 'utf8'), outsideBytes);
    assert.equal(await fsp.readFile(displaced, 'utf8'), drifted);
    const rows = (await fsp.readFile(attempt!.journal_path!, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].changed, false);
  } finally {
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('post-replacement verification never rolls back over a concurrent third-party edit', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-managed-skill-rollback-race-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  try {
    await fsp.mkdir(root, { recursive: true });
    const { skill } = await seedGlobalSkills(home);
    const drifted = staleManagedSkillText(
      SKILL_NAME,
      `<!-- BEGIN SKS MANAGED SKILL v99 name=${SKILL_NAME} -->`
    );
    const thirdParty = `${drifted}\nthird-party edit after replacement\n`;
    await fsp.writeFile(skill, drifted);
    const resolution = await readOnlyMismatchResolution(root, home);

    const report = await healAuthoritativeManagedSkillDigestMismatches({
      root,
      home,
      resolution,
      testHooks: {
        afterAtomicReplace: async () => {
          await fsp.writeFile(skill, thirdParty);
        }
      }
    });

    const attempt = report.attempts[0];
    assert.equal(report.healed_count, 0);
    assert.equal(attempt?.status, 'failed');
    assert.match(
      String(attempt?.reason),
      /rollback_managed_skill_rollback_concurrent_change_refused/
    );
    assert.ok(attempt?.backup_path);
    assert.equal(await fsp.readFile(attempt!.backup_path!, 'utf8'), drifted);
    assert.equal(await fsp.readFile(skill, 'utf8'), thirdParty);
    const rows = (await fsp.readFile(attempt!.journal_path!, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].changed, false);
  } finally {
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('commit-journal failure rolls the packaged replacement back to the preserved original', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-managed-skill-commit-journal-failure-'));
  const home = path.join(fixture, 'home');
  const root = path.join(fixture, 'project');
  const journalPath = path.join(root, '.sneakoscope', 'reports', 'migration-journal.jsonl');
  const displacedJournal = path.join(fixture, 'backup-ready-journal.jsonl');
  const outsideJournal = path.join(fixture, 'outside-journal.jsonl');
  try {
    await fsp.mkdir(root, { recursive: true });
    const { skill } = await seedGlobalSkills(home);
    const drifted = staleManagedSkillText(
      SKILL_NAME,
      `<!-- BEGIN SKS MANAGED SKILL v99 name=${SKILL_NAME} -->`
    );
    await Promise.all([
      fsp.writeFile(skill, drifted),
      fsp.writeFile(outsideJournal, 'outside journal bytes\n')
    ]);
    const resolution = await readOnlyMismatchResolution(root, home);

    const report = await healAuthoritativeManagedSkillDigestMismatches({
      root,
      home,
      resolution,
      testHooks: {
        afterAtomicReplace: async () => {
          await fsp.rename(journalPath, displacedJournal);
          await fsp.symlink(outsideJournal, journalPath);
        }
      }
    });

    const attempt = report.attempts[0];
    assert.equal(report.healed_count, 0);
    assert.equal(attempt?.status, 'failed');
    assert.match(String(attempt?.reason), /migration_journal_not_safe_regular_file/);
    assert.equal(await fsp.readFile(skill, 'utf8'), drifted);
    assert.equal(await fsp.readFile(outsideJournal, 'utf8'), 'outside journal bytes\n');
    const rows = (await fsp.readFile(displacedJournal, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].changed, false);
    assert.ok(attempt?.backup_path);
    assert.equal(await fsp.readFile(attempt!.backup_path!, 'utf8'), drifted);
  } finally {
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('nonregular and symlink skill leaves are never healed or journaled', async () => {
  for (const kind of ['directory', 'symlink'] as const) {
    const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), `sks-managed-skill-${kind}-leaf-`));
    const home = path.join(fixture, 'home');
    const root = path.join(fixture, 'project');
    const outside = path.join(fixture, 'outside.md');
    try {
      await fsp.mkdir(root, { recursive: true });
      const { skill } = await seedGlobalSkills(home);
      await fsp.unlink(skill);
      if (kind === 'directory') {
        await fsp.mkdir(skill);
        await fsp.writeFile(path.join(skill, 'sentinel.txt'), 'preserve directory\n');
      } else {
        await fsp.writeFile(outside, 'preserve symlink target\n');
        await fsp.symlink(outside, skill);
      }

      const resolution = await resolveAuthoritativeSksSkillSources({
        root,
        home,
        skillNames: ['honest-mode']
      });
      assert.deepEqual(
        resolution.blockers,
        [`${kind === 'directory' ? 'not_regular_file' : 'unsafe_symlink'}:${SKILL_NAME}:global`]
      );
      assert.equal(resolution.recovery, undefined);
      if (kind === 'directory') {
        assert.equal(await fsp.readFile(path.join(skill, 'sentinel.txt'), 'utf8'), 'preserve directory\n');
      } else {
        assert.equal(await fsp.readFile(outside, 'utf8'), 'preserve symlink target\n');
        assert.equal((await fsp.lstat(skill)).isSymbolicLink(), true);
      }
      await assert.rejects(
        fsp.access(path.join(root, '.sneakoscope', 'reports', 'migration-journal.jsonl'))
      );
    } finally {
      await fsp.rm(fixture, { recursive: true, force: true });
    }
  }
});

test('reconcileSkills accepts an explicit global runtime root without mutating process environment', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-reconcile-explicit-runtime-root-'));
  const home = path.join(fixture, 'home');
  const targetDir = path.join(home, '.agents', 'skills');
  const explicitRuntimeRoot = path.join(fixture, 'explicit-runtime');
  const environmentRuntimeRoot = path.join(fixture, 'environment-runtime');
  const explicitRetired = path.join(
    explicitRuntimeRoot,
    '.agents',
    'skills',
    'old-workflow',
    'SKILL.md'
  );
  const environmentRetired = path.join(
    environmentRuntimeRoot,
    '.agents',
    'skills',
    'old-workflow',
    'SKILL.md'
  );
  const previousGlobalRoot = process.env.SKS_GLOBAL_ROOT;
  const managedRetired = [
    '---',
    'name: old-workflow',
    'description: retired managed fixture',
    '---',
    '',
    '<!-- BEGIN SKS MANAGED SKILL v-test name=old-workflow -->',
    ''
  ].join('\n');
  try {
    await Promise.all([
      fsp.mkdir(home, { recursive: true }),
      fsp.mkdir(path.dirname(explicitRetired), { recursive: true }),
      fsp.mkdir(path.dirname(environmentRetired), { recursive: true })
    ]);
    await Promise.all([
      fsp.writeFile(explicitRetired, managedRetired),
      fsp.writeFile(environmentRetired, managedRetired)
    ]);
    process.env.SKS_GLOBAL_ROOT = environmentRuntimeRoot;

    const report = await reconcileSkills({
      targetDir,
      scope: 'global',
      fix: true,
      globalRuntimeRoot: explicitRuntimeRoot
    });

    assert.equal(report.ok, true, JSON.stringify(report));
    await assert.rejects(fsp.access(explicitRetired));
    assert.equal(await fsp.readFile(environmentRetired, 'utf8'), managedRetired);
    assert.equal(process.env.SKS_GLOBAL_ROOT, environmentRuntimeRoot);
  } finally {
    if (previousGlobalRoot === undefined) delete process.env.SKS_GLOBAL_ROOT;
    else process.env.SKS_GLOBAL_ROOT = previousGlobalRoot;
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

test('manual global reconcile quarantines unknown managed bytes before reinstalling trusted content', async () => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-reconcile-unknown-managed-'));
  const home = path.join(fixture, 'home');
  const targetDir = path.join(home, '.agents', 'skills');
  const skill = path.join(targetDir, SKILL_NAME, 'SKILL.md');
  const unknown = staleManagedSkillText(
    SKILL_NAME,
    `<!-- BEGIN SKS MANAGED SKILL v-unknown name=${SKILL_NAME} -->`
  );
  try {
    const installed = await installGlobalSkills(home);
    assert.equal(installed.ok, true, JSON.stringify(installed));
    await fsp.writeFile(skill, unknown);

    const report = await reconcileSkills({
      targetDir,
      scope: 'global',
      fix: true,
      globalRuntimeRoot: path.join(home, '.sneakoscope-global')
    });

    assert.equal(report.ok, true, JSON.stringify(report));
    assert.ok(report.quarantined_user_collisions.includes(SKILL_NAME));
    assert.notEqual(await fsp.readFile(skill, 'utf8'), unknown);
    const quarantineRoot = path.join(
      home,
      '.sneakoscope',
      'quarantine',
      'skills',
      SKILL_NAME
    );
    const preserved = await findNamedFiles(quarantineRoot, 'SKILL.md');
    assert.equal(preserved.length, 1);
    assert.equal(await fsp.readFile(preserved[0]!, 'utf8'), unknown);
  } finally {
    await fsp.rm(fixture, { recursive: true, force: true });
  }
});

async function findNamedFiles(directory: string, fileName: string): Promise<string[]> {
  const rows = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const row of rows) {
    const candidate = path.join(directory, row.name);
    if (row.isDirectory()) found.push(...await findNamedFiles(candidate, fileName));
    else if (row.isFile() && row.name === fileName) found.push(candidate);
  }
  return found;
}
