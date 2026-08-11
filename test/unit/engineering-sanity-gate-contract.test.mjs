import '../../dist/core/__tests__/helpers/isolated-test-home.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { scanCodeStructure } from '../../dist/core/code-structure.js';
import {
  ENGINEERING_SANITY_CHECK_IDS,
  ENGINEERING_SANITY_CODE_STRUCTURE_REPORT,
  ENGINEERING_SANITY_REVIEW_ARTIFACT,
  engineeringScopeHash
} from '../../dist/core/engineering-sanity-review.js';
import { loadStateForSession } from '../../dist/core/mission.js';
import { prepareRoute } from '../../dist/core/pipeline-internals/runtime-core.js';
import { evaluateStop } from '../../dist/core/pipeline-internals/runtime-gates.js';

const ENGINEERING_CANDIDATE_TAGS = new Set([
  'solid',
  'n-plus-one',
  'unbounded-loop',
  'verification-bypass',
  'db-pool',
  'transaction'
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function missionDir(root, missionId) {
  return path.join(root, '.sneakoscope', 'missions', missionId);
}

async function gitFixtureRoot(t, name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `sks-${name}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, '.gitignore'), '.sneakoscope/\n');
  await fs.writeFile(path.join(root, 'package.json'), `${JSON.stringify({ name: name, version: '1.0.0' })}\n`);
  await fs.writeFile(path.join(root, 'src/retry.ts'), 'export const RETRY_LIMIT = 3;\n');
  git(root, 'init', '--quiet');
  git(root, 'config', 'user.name', 'Sneakoscope Test');
  git(root, 'config', 'user.email', 'sneakoscope-test@example.test');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'baseline');
  return root;
}

function engineeringCandidates(report) {
  return (report.semantic_review?.findings || [])
    .filter((finding) => ENGINEERING_CANDIDATE_TAGS.has(finding.tag) && finding.id)
    .sort((left, right) => left.id.localeCompare(right.id));
}

// Author the review the way the route agent is expected to: bound to the same
// changed-scope base the pipeline plan recorded when it seeded the artifact.
async function completeEngineeringSanityReview(root, missionId, routeCommand, base) {
  const dir = missionDir(root, missionId);
  const report = await scanCodeStructure(root, { changedSince: base, includeOk: true });
  const reportText = `${JSON.stringify(report, null, 2)}\n`;
  await fs.writeFile(path.join(dir, ENGINEERING_SANITY_CODE_STRUCTURE_REPORT), reportText);
  const candidates = engineeringCandidates(report);
  const review = {
    schema: 'sks.engineering-sanity-review.v1',
    passed: true,
    route: routeCommand,
    changed_files: [...new Set(report.changed_scope.source_files)].sort(),
    added_hunks_reviewed: true,
    real_callers_traced: true,
    static_scan_role: 'candidate_detection_only_not_completion_proof',
    code_structure_report: ENGINEERING_SANITY_CODE_STRUCTURE_REPORT,
    code_structure_report_sha256: `sha256:${sha256(reportText)}`,
    changed_scope_sha256: engineeringScopeHash(report),
    reviewed_candidate_ids: candidates.map((candidate) => candidate.id),
    candidate_findings: candidates,
    candidate_dispositions: candidates.map((candidate) => ({
      candidate_id: candidate.id,
      source_file: candidate.file,
      source_scope: candidate.source_scope,
      added_hunk_line_ranges: candidate.added_hunk_line_ranges,
      status: 'resolved',
      reason: 'Reviewed in its added-hunk source scope for this fixture.',
      evidence: [`candidate:${candidate.id}`]
    })),
    checks: Object.fromEntries(ENGINEERING_SANITY_CHECK_IDS.map((id) => [id, {
      status: 'passed',
      reason: null,
      evidence: [`reviewed:${id}`]
    }])),
    resolved_findings: candidates.map((candidate) => candidate.id),
    unresolved_findings: [],
    blockers: [],
    notes: []
  };
  await fs.writeFile(path.join(dir, ENGINEERING_SANITY_REVIEW_ARTIFACT), `${JSON.stringify(review, null, 2)}\n`);
  return review;
}

// (a) The requirement flag and the seeded artifact are the same decision.
// A lightweight code-changing prompt may leave the gate off, but it may never
// turn the gate on without the artifact the gate asks for.
for (const [name, prompt] of [
  ['english make', '$SKS make the retry loop bounded'],
  ['korean 개발', '$Fast-Mode 로그인 모듈 개발'],
  ['korean 수정', '$Fast-On 재시도 루프 수정'],
  ['english fix', '$SKS fix the unbounded retry loop in src/retry.ts']
]) {
  test(`lightweight code-changing prompt never requires an unseeded engineering sanity review (${name})`, async (t) => {
    const root = await gitFixtureRoot(t, 'sanity-flag');
    const sessionKey = `sanity-flag-${name.replace(/\s+/g, '-')}`;
    await fs.appendFile(path.join(root, 'src/retry.ts'), [
      'export function retryForever(run) {',
      '  while (true) {',
      '    run();',
      '  }',
      '}',
      ''
    ].join('\n'));

    await prepareRoute(root, prompt, {}, { sessionKey });
    const state = await loadStateForSession(root, sessionKey);
    const missionId = String(state.mission_id || '');
    assert.ok(missionId, 'route preparation must persist a mission');

    const seeded = await fs.access(path.join(missionDir(root, missionId), ENGINEERING_SANITY_REVIEW_ARTIFACT))
      .then(() => true, () => false);
    assert.equal(
      state.engineering_sanity_required === true,
      seeded,
      `engineering_sanity_required=${state.engineering_sanity_required} must match seeded=${seeded}`
    );

    if (state.engineering_sanity_required === true) {
      assert.match(String(state.engineering_sanity_scope_base || ''), /^[0-9a-f]{40}$/);
      const decision = await evaluateStop(root, state, { message: 'done' });
      assert.equal(decision?.decision, 'block');
      assert.equal(decision?.gate, ENGINEERING_SANITY_REVIEW_ARTIFACT);

      // The blocker is satisfiable: completing the seeded review clears this
      // gate. Other route gates (subagent evidence, proof) may still apply.
      await completeEngineeringSanityReview(root, missionId, state.route_command, state.engineering_sanity_scope_base);
      const cleared = await evaluateStop(root, state, { message: 'done' });
      assert.notEqual(cleared?.gate, ENGINEERING_SANITY_REVIEW_ARTIFACT, JSON.stringify(cleared));
    } else {
      assert.equal(await evaluateStop(root, state, { message: 'done' }), null);
    }
  });
}

// Routes that always owe the review keep owing it now that the requirement is
// derived from the plan instead of a hardcoded state flag.
for (const [name, prompt, routeId] of [
  ['$DB', '$DB check this migration safely and fix the pool', 'DB'],
  ['$DB korean', '$DB 이 마이그레이션 적용해줘', 'DB'],
  ['$MAD-SKS', '$DB apply this migration $MAD-SKS', 'MadSKS'],
  ['$Naruto', '$Naruto refactor the retry loop across modules in parallel', 'Naruto']
]) {
  test(`${name} still requires and seeds the engineering sanity review`, async (t) => {
    const root = await gitFixtureRoot(t, 'sanity-always');
    const sessionKey = `sanity-always-${routeId}-${name.replace(/[^a-z0-9]+/gi, '-')}`;
    const previousProjectRef = process.env.SKS_MAD_SKS_SQL_PLANE_PROJECT_REF;
    process.env.SKS_MAD_SKS_SQL_PLANE_PROJECT_REF = sessionKey;
    t.after(() => {
      if (previousProjectRef === undefined) delete process.env.SKS_MAD_SKS_SQL_PLANE_PROJECT_REF;
      else process.env.SKS_MAD_SKS_SQL_PLANE_PROJECT_REF = previousProjectRef;
    });

    await prepareRoute(root, prompt, {}, { sessionKey });
    const state = await loadStateForSession(root, sessionKey);
    assert.equal(state.route, routeId);
    assert.equal(state.engineering_sanity_required, true);
    assert.match(String(state.engineering_sanity_scope_base || ''), /^[0-9a-f]{40}$/);
    await fs.access(path.join(missionDir(root, String(state.mission_id)), ENGINEERING_SANITY_REVIEW_ARTIFACT));
  });
}

// (b) The $Commit family can pass Stop after performing its own commit: the
// review scope is bound to the pre-commit base, so committing the reviewed
// hunks does not invalidate the review that covered them.
for (const [routeId, routeCommand, prompt] of [
  ['Commit', '$Commit', '$Commit 수정한 재시도 루프 변경사항 커밋해줘'],
  ['CommitAndPush', '$Commit-And-Push', '$Commit-And-Push 수정한 변경사항 커밋하고 푸쉬해줘']
]) {
  test(`${routeCommand} passes the engineering sanity Stop gate after committing the reviewed changes`, async (t) => {
    const root = await gitFixtureRoot(t, `sanity-${routeId.toLowerCase()}`);
    const sessionKey = `sanity-${routeId.toLowerCase()}`;
    await fs.appendFile(path.join(root, 'src/retry.ts'), [
      'export async function loadAccounts(ids, db) {',
      '  for (const id of ids) {',
      "    await db.query('SELECT * FROM accounts WHERE id = $1', [id]);",
      '  }',
      '}',
      ''
    ].join('\n'));
    // A brand-new untracked file: its diff shape must survive being committed.
    await fs.writeFile(path.join(root, 'src/worker.ts'), [
      'export function spin() {',
      '  while (true) {',
      '    break;',
      '  }',
      '}',
      ''
    ].join('\n'));

    await prepareRoute(root, prompt, {}, { sessionKey });
    const state = await loadStateForSession(root, sessionKey);
    const missionId = String(state.mission_id || '');
    assert.equal(state.route, routeId);
    assert.equal(state.stop_gate, 'none');
    assert.equal(state.engineering_sanity_required, true, 'a code-changing commit prompt seeds and requires the review');
    const base = String(state.engineering_sanity_scope_base || '');
    assert.match(base, /^[0-9a-f]{40}$/);
    assert.equal(base, git(root, 'rev-parse', 'HEAD').trim());

    // Enforcement is live on a stop_gate:'none' route: an unfinished review blocks.
    const pending = await evaluateStop(root, state, { message: 'done' });
    assert.equal(pending?.decision, 'block');
    assert.equal(pending?.gate, ENGINEERING_SANITY_REVIEW_ARTIFACT);

    await completeEngineeringSanityReview(root, missionId, routeCommand, base);
    assert.equal(await evaluateStop(root, state, { message: 'reviewed' }), null);

    // The route now performs its own deliverable.
    git(root, 'add', '-A');
    git(root, 'commit', '--quiet', '-m', 'commit reviewed changes');
    assert.notEqual(git(root, 'rev-parse', 'HEAD').trim(), base);
    assert.equal(git(root, 'status', '--porcelain').trim(), '');

    const afterCommit = await evaluateStop(root, state, { message: 'committed' });
    assert.equal(afterCommit, null, `Stop must not block after the commit: ${JSON.stringify(afterCommit)}`);
  });
}

// Route state persisted before the plan owned this decision can carry the flag
// with nothing seeded. Enforcement must not turn that into an unsatisfiable
// blocker (three repeats of one reason trip the compliance loop guard).
test('pre-migration route state with no seeded review does not block Stop', async (t) => {
  const root = await gitFixtureRoot(t, 'sanity-legacy');
  const missionId = 'M-legacy-engineering-sanity';
  await fs.mkdir(missionDir(root, missionId), { recursive: true });
  const state = {
    mission_id: missionId,
    route: 'SKS',
    route_command: '$SKS',
    mode: 'SKS',
    stop_gate: 'none',
    engineering_sanity_required: true,
    reflection_required: false,
    proof_required: false
  };

  assert.equal(await evaluateStop(root, state, { message: 'done' }), null);
  await assert.rejects(fs.access(path.join(missionDir(root, missionId), 'compliance-loop-guard.json')));
  await assert.rejects(fs.access(path.join(missionDir(root, missionId), 'hard-blocker.json')));
});

test('a deleted review still blocks when the plan declared the binding', async (t) => {
  const root = await gitFixtureRoot(t, 'sanity-deleted');
  const sessionKey = 'sanity-deleted';
  await fs.appendFile(path.join(root, 'src/retry.ts'), 'export const RETRY_BACKOFF_MS = 250;\n');

  await prepareRoute(root, '$Commit 재시도 루프 수정 커밋해줘', {}, { sessionKey });
  const state = await loadStateForSession(root, sessionKey);
  const missionId = String(state.mission_id || '');
  assert.equal(state.engineering_sanity_required, true);

  await fs.rm(path.join(missionDir(root, missionId), ENGINEERING_SANITY_REVIEW_ARTIFACT));
  const decision = await evaluateStop(root, state, { message: 'done' });
  assert.equal(decision?.decision, 'block');
  assert.equal(decision?.gate, ENGINEERING_SANITY_REVIEW_ARTIFACT);
});

test('a scope change after the review still blocks the $Commit Stop gate', async (t) => {
  const root = await gitFixtureRoot(t, 'sanity-commit-drift');
  const sessionKey = 'sanity-commit-drift';
  await fs.appendFile(path.join(root, 'src/retry.ts'), 'export const RETRY_BACKOFF_MS = 250;\n');

  await prepareRoute(root, '$Commit 재시도 루프 수정 커밋해줘', {}, { sessionKey });
  const state = await loadStateForSession(root, sessionKey);
  const missionId = String(state.mission_id || '');
  assert.equal(state.engineering_sanity_required, true);

  await completeEngineeringSanityReview(root, missionId, '$Commit', state.engineering_sanity_scope_base);
  assert.equal(await evaluateStop(root, state, { message: 'reviewed' }), null);

  await fs.writeFile(path.join(root, 'src/unreviewed.ts'), 'export const SNUCK_IN = true;\n');
  const decision = await evaluateStop(root, state, { message: 'done' });
  assert.equal(decision?.decision, 'block');
  assert.equal(decision?.gate, ENGINEERING_SANITY_REVIEW_ARTIFACT);
  assert.ok(decision?.missing?.includes('changed_files'), JSON.stringify(decision?.missing));
});
