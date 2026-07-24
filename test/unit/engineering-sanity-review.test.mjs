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
  createEngineeringSanityReviewSeed,
  engineeringScopeHash,
  validateEngineeringSanityReviewArtifact
} from '../../dist/core/engineering-sanity-review.js';

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
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

async function changedRepo(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-engineering-sanity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, '.gitignore'), '.sneakoscope/\n');
  await fs.writeFile(path.join(root, 'package.json'), `${JSON.stringify({ name: 'engineering-sanity-fixture', version: '1.0.0' })}\n`);
  await fs.writeFile(path.join(root, 'src/service.ts'), [
    'export function legacyWorker() {',
    '  while (true) {',
    '    break;',
    '  }',
    '}',
    ''
  ].join('\n'));
  git(root, 'init', '--quiet');
  git(root, 'config', 'user.name', 'Sneakoscope Test');
  git(root, 'config', 'user.email', 'sneakoscope-test@example.test');
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'baseline');
  await fs.appendFile(path.join(root, 'src/service.ts'), [
    'export async function loadAccounts(ids, db) {',
    '  for (const id of ids) {',
    "    await db.query('SELECT * FROM accounts WHERE id = $1', [id]);",
    '  }',
    '}',
    '',
    'export function newlyUnboundedWorker() {',
    '  for (;;) {',
    '    break;',
    '  }',
    '}',
    ''
  ].join('\n'));
  return root;
}

function engineeringCandidates(report) {
  return report.semantic_review.findings
    .filter((finding) => ENGINEERING_CANDIDATE_TAGS.has(finding.tag))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function sourceBinding(candidate) {
  return {
    source_file: candidate.file,
    source_scope: candidate.source_scope,
    added_hunk_line_ranges: candidate.added_hunk_line_ranges
  };
}

function completedReview(report, reportText) {
  const seed = createEngineeringSanityReviewSeed('$DB');
  const candidates = engineeringCandidates(report);
  return {
    ...seed,
    passed: true,
    changed_files: [...report.changed_scope.source_files],
    added_hunks_reviewed: true,
    real_callers_traced: true,
    code_structure_report_sha256: `sha256:${sha256(reportText)}`,
    changed_scope_sha256: engineeringScopeHash(report),
    reviewed_candidate_ids: candidates.map((candidate) => candidate.id),
    candidate_findings: candidates,
    candidate_dispositions: candidates.map((candidate) => ({
      candidate_id: candidate.id,
      ...sourceBinding(candidate),
      status: 'resolved',
      reason: 'The fixture candidate was manually reviewed in its added-hunk source scope.',
      evidence: [`candidate:${candidate.id}`, `source_scope:${sourceBinding(candidate).source_scope}`]
    })),
    checks: Object.fromEntries(ENGINEERING_SANITY_CHECK_IDS.map((id) => [id, {
      status: 'passed',
      reason: null,
      evidence: [`reviewed:${id}`]
    }])),
    resolved_findings: candidates.map((candidate) => candidate.id),
    unresolved_findings: [],
    blockers: []
  };
}

test('engineering sanity scan ignores a legacy while(true) outside added hunks and detects new N+1 and unbounded-loop candidates', async (t) => {
  const root = await changedRepo(t);

  const report = await scanCodeStructure(root, { changed: true, includeOk: true });
  const entry = report.files.find((candidate) => candidate.path === 'src/service.ts');
  const sanity = entry?.lean_signals?.engineering_sanity;
  const candidateTags = engineeringCandidates(report).map((candidate) => candidate.tag);

  assert.equal(sanity?.source_scope, 'added_hunks');
  assert.equal(sanity?.n_plus_one_candidates, 1);
  assert.equal(sanity?.unbounded_loop_candidates, 1);
  assert.deepEqual(sanity?.added_hunk_line_ranges, [{ start: 6, end: 16 }]);
  assert.equal(candidateTags.filter((tag) => tag === 'n-plus-one').length, 1);
  assert.equal(candidateTags.filter((tag) => tag === 'unbounded-loop').length, 1);
});

test('engineering review dispositions bind to fresh candidate IDs and their source scope', async (t) => {
  const root = await changedRepo(t);
  const missionId = 'M-engineering-review';
  const report = await scanCodeStructure(root, { changed: true, includeOk: true });
  const candidates = engineeringCandidates(report);
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every((candidate) => candidate.source_scope === 'added_hunks'));
  assert.ok(candidates.every((candidate) => (
    JSON.stringify(candidate.added_hunk_line_ranges) === JSON.stringify([{ start: 6, end: 16 }])
  )));

  const reportText = `${JSON.stringify(report, null, 2)}\n`;
  const reportFile = path.join(root, '.sneakoscope', 'missions', missionId, 'code-structure-report.json');
  await fs.mkdir(path.dirname(reportFile), { recursive: true });
  await fs.writeFile(reportFile, reportText);
  const review = completedReview(report, reportText);

  const valid = await validateEngineeringSanityReviewArtifact(root, missionId, review);
  assert.equal(valid.ok, true);

  const wrongCandidate = structuredClone(review);
  wrongCandidate.candidate_dispositions[0].candidate_id = 'eng-not-in-fresh-scan';
  const candidateMismatch = await validateEngineeringSanityReviewArtifact(root, missionId, wrongCandidate);
  assert.equal(candidateMismatch.ok, false);
  assert.ok(candidateMismatch.blockers.includes('candidate_dispositions'));

  const wrongScope = structuredClone(review);
  wrongScope.candidate_dispositions[0].source_scope = 'full_file_advisory';
  const scopeMismatch = await validateEngineeringSanityReviewArtifact(root, missionId, wrongScope);
  assert.equal(scopeMismatch.ok, false);
});
