import '../../__tests__/helpers/isolated-test-home.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ManagedSkillDigestRecoveryReport,
  SksSkillSourceResolution
} from '../../codex-native/sks-skill-paths.js';
import {
  resolveManagedSkillSourcesForAdmission,
  type ManagedSkillAdmissionDependencies
} from '../managed-skill-admission.js';

const SKILL = 'sks-naruto';
const SKILL_PATH = '/test-home/.agents/skills/sks-naruto/SKILL.md';

function blockedResolution(): SksSkillSourceResolution {
  return {
    schema: 'sks.authoritative-skill-sources.v1',
    sources: [],
    unresolved: [SKILL],
    blockers: [`content_digest_mismatch:${SKILL}:global`],
    issues: [{
      requested_name: 'naruto',
      canonical_name: SKILL,
      scope: 'global',
      root: '/test-home/.agents/skills',
      path: SKILL_PATH,
      reason: 'content_digest_mismatch',
      content_sha256: 'a'.repeat(64)
    }]
  };
}

function cleanResolution(): SksSkillSourceResolution {
  return {
    schema: 'sks.authoritative-skill-sources.v1',
    sources: [{
      requested_name: 'naruto',
      canonical_name: SKILL,
      scope: 'global',
      root: '/test-home/.agents/skills',
      path: SKILL_PATH
    }],
    unresolved: [],
    blockers: [],
    issues: []
  };
}

function recoveryAttempt(
  status: 'healed' | 'blocked' | 'failed',
  reason: string
): ManagedSkillDigestRecoveryReport {
  return {
    attempted: true,
    healed_count: status === 'healed' ? 1 : 0,
    attempts: [{
      canonical_skill: SKILL,
      original_path: SKILL_PATH,
      old_digest: 'a'.repeat(64),
      new_digest: 'b'.repeat(64),
      status,
      reason,
      backup_path: null,
      rollback_path: null,
      journal_path: null
    }]
  };
}

function injectedDependencies(
  recovery: ManagedSkillDigestRecoveryReport
): ManagedSkillAdmissionDependencies & { resolveCalls: () => number; repairCalls: () => number } {
  let resolveCalls = 0;
  let repairCalls = 0;
  return {
    resolveSources: async () => {
      resolveCalls += 1;
      return resolveCalls === 1 ? blockedResolution() : cleanResolution();
    },
    repairGeneration: async () => {
      repairCalls += 1;
      return recovery;
    },
    resolveCalls: () => resolveCalls,
    repairCalls: () => repairCalls
  };
}

test('admission preserves the blocker when requested skills re-resolve cleanly after failed repair', async () => {
  const dependencies = injectedDependencies(recoveryAttempt(
    'failed',
    'stale_global_generation_reconcile_failed'
  ));

  const result = await resolveManagedSkillSourcesForAdmission({
    root: '/project',
    skillNames: ['naruto']
  }, dependencies);

  assert.deepEqual(result.unresolved, [SKILL]);
  assert.deepEqual(result.blockers, [`content_digest_mismatch:${SKILL}:global`]);
  assert.equal(result.sources.length, 0);
  assert.equal(result.recovery?.attempts[0]?.status, 'failed');
  assert.equal(dependencies.resolveCalls(), 2);
  assert.equal(dependencies.repairCalls(), 1);
});

test('admission rejects incomplete or malformed recovery proof after a clean re-resolution', async (t) => {
  const cases: Array<[string, ManagedSkillDigestRecoveryReport]> = [
    ['not attempted', { attempted: false, healed_count: 0, attempts: [] }],
    ['missing attempt', { attempted: true, healed_count: 0, attempts: [] }],
    ['inconsistent healed count', {
      ...recoveryAttempt('healed', 'stale_global_generation_reconciled:version_mismatch'),
      healed_count: 0
    }],
    ['non-generation heal', recoveryAttempt('healed', 'content_digest_mismatch_replaced')]
  ];

  for (const [name, recovery] of cases) {
    await t.test(name, async () => {
      const result = await resolveManagedSkillSourcesForAdmission({
        root: '/project',
        skillNames: ['naruto']
      }, injectedDependencies(recovery));
      assert.deepEqual(result.unresolved, [SKILL]);
      assert.deepEqual(result.blockers, [`content_digest_mismatch:${SKILL}:global`]);
    });
  }
});

test('admission accepts a clean re-resolution only after verified whole-generation recovery', async () => {
  const recovery = recoveryAttempt(
    'healed',
    'stale_global_generation_reconciled:version_mismatch'
  );
  const result = await resolveManagedSkillSourcesForAdmission({
    root: '/project',
    skillNames: ['naruto']
  }, injectedDependencies(recovery));

  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.sources[0]?.canonical_name, SKILL);
  assert.equal(result.recovery, recovery);
});

test('admission propagates repair failures without retrying or rechecking', async () => {
  let resolveCalls = 0;
  let repairCalls = 0;
  const dependencies: ManagedSkillAdmissionDependencies = {
    resolveSources: async () => {
      resolveCalls += 1;
      return blockedResolution();
    },
    repairGeneration: async () => {
      repairCalls += 1;
      throw new Error('injected_generation_repair_failure');
    }
  };

  await assert.rejects(
    resolveManagedSkillSourcesForAdmission({
      root: '/project',
      skillNames: ['naruto']
    }, dependencies),
    /injected_generation_repair_failure/
  );
  assert.equal(resolveCalls, 1);
  assert.equal(repairCalls, 1);
});
