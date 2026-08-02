import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertCompletionProofInRoot, createHermeticProjectRoot, runSksInRoot } from './route-real-command-helper.mjs';

test('Research route runs in a hermetic temp project root', async () => {
  const root = await createHermeticProjectRoot({ fixtureName: 'research' });
  const prepared = await runSksInRoot(root, ['research', 'prepare', 'fixture topic', '--json']);
  const json = await runSksInRoot(root, ['research', 'run', prepared.mission_id, '--mock', '--json']);
  await assertCompletionProofInRoot(root, json.mission_id, '$Research');
});

test('Research --mock JSON ok:false exits nonzero', async () => {
  const root = await createHermeticProjectRoot({ fixtureName: 'research-json-failure-exit' });
  const prepared = await runSksInRoot(root, ['research', 'prepare', 'fixture failure exit', '--json']);
  const contractPath = path.join(root, '.sneakoscope', 'missions', prepared.mission_id, 'research-quality-contract.json');
  const contract = JSON.parse(await fs.readFile(contractPath, 'utf8'));
  contract.min_report_words = 999_999;
  await fs.writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);

  const result = await runSksInRoot(root, ['research', 'run', prepared.mission_id, '--mock', '--json'], { expectCode: 2 });
  assert.equal(result.ok, false);
  assert.ok(result.gate.reasons.includes('research_report_too_short'));
});
