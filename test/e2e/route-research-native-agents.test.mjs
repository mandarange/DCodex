import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHermeticProjectRoot, runSksInRoot } from './route-real-command-helper.mjs';

const EXPECTED_REVIEWER_COUNT = 3;

test('Research prepare/status expose official subagent adversarial convergence', async () => {
  const root = await createHermeticProjectRoot({ fixtureName: 'research-native-agents' });
  const prepared = await runSksInRoot(root, ['research', 'prepare', 'native research batch fixture', '--json']);
  assert.equal(prepared.official_subagent_plan.workflow, 'official_codex_subagent');
  assert.equal(prepared.official_subagent_plan.reviewer_count, EXPECTED_REVIEWER_COUNT);
  assert.deepEqual(prepared.official_subagent_plan.reviewers.map((reviewer) => reviewer.id), ['evidence', 'method', 'falsification']);

  const run = await runSksInRoot(root, ['research', 'run', prepared.mission_id, '--mock', '--json']);
  assert.equal(run.ok, true);
  assert.equal(run.official_subagent_review.passed, true);
  assert.equal(run.official_subagent_review.reviewer_count_observed, EXPECTED_REVIEWER_COUNT);
  await fs.access(path.join(root, '.sneakoscope', 'missions', prepared.mission_id, 'research-adversarial-review.json'));

  const status = await runSksInRoot(root, ['research', 'status', prepared.mission_id, '--json']);
  assert.equal(status.agent_backend, 'official_codex_subagent');
  assert.equal(status.adversarial_convergence.passed, true);
  assert.equal(status.honest_mode.guarantees.novelty, false);
});

test('AutoResearch prepare and run inherit official adversarial review cycles', async () => {
  const root = await createHermeticProjectRoot({ fixtureName: 'autoresearch-agent-batches' });
  const prepared = await runSksInRoot(root, ['autoresearch', 'prepare', 'agent batch experiment loop', '--json']);
  assert.equal(prepared.schema, 'sks.autoresearch-prepare.v1');
  assert.match(prepared.methodology, /super-search/);
  assert.equal(prepared.official_subagent_plan.reviewer_count, EXPECTED_REVIEWER_COUNT);

  const run = await runSksInRoot(root, ['autoresearch', 'run', prepared.mission_id, '--mock', '--json']);
  assert.equal(run.schema, 'sks.autoresearch-run.v1');
  assert.equal(run.official_subagent_review.passed, true);
  assert.equal(run.honest_mode.guarantees.publication_acceptance, false);
});
