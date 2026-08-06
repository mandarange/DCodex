import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGateProcessOutput, parseGateResultFromStdout } from '../gate-result-contract.js';

test('gate result contract fails exit 0 with ok false', () => {
  const evaluation = evaluateGateProcessOutput({
    status: 0,
    stdout: [
      'human readable gate output',
      JSON.stringify({ schema: 'sks.gate-result.v2', contract_mode: 'strict', ok: false, blockers: ['fixture_blocker'] })
    ].join('\n')
  });

  assert.equal(evaluation.ok, false);
  assert.equal(evaluation.contract, 'sks.gate-result.v2');
  assert.equal(evaluation.reason, 'gate_result_not_ok');
  assert.deepEqual(evaluation.gate_result?.blockers, ['fixture_blocker']);
});

test('required gate result contract rejects invalid final JSON', () => {
  const evaluation = evaluateGateProcessOutput({
    status: 0,
    stdout: 'not json',
  });

  assert.equal(evaluation.ok, false);
  assert.equal(evaluation.contract, 'sks.gate-result.v2');
  assert.equal(evaluation.reason, 'gate_output_contract_violation');
  assert.equal(evaluation.gate_result, null);
});

test('uncontracted success output is rejected', () => {
  const evaluation = evaluateGateProcessOutput({
    status: 0,
    stdout: 'uncontracted success'
  });

  assert.equal(evaluation.ok, false);
  assert.equal(evaluation.contract, 'sks.gate-result.v2');
  assert.equal(evaluation.reason, 'gate_output_contract_violation');
});

test('gate result parser reads the last stdout line only', () => {
  const parsed = parseGateResultFromStdout([
    JSON.stringify({ schema: 'sks.gate-result.v2', contract_mode: 'strict', ok: true, blockers: [] }),
    JSON.stringify({ schema: 'sks.gate-result.v2', contract_mode: 'strict', ok: false, blockers: ['last_line_wins'] })
  ].join('\n'));

  assert.equal(parsed?.ok, false);
  assert.deepEqual(parsed?.blockers, ['last_line_wins']);
});

test('gate result parser rejects the retired contract revision and missing strict mode', () => {
  assert.equal(parseGateResultFromStdout(JSON.stringify({ schema: 'sks.gate-result.v2', ok: true, blockers: [] })), null);
  assert.equal(parseGateResultFromStdout(JSON.stringify({ schema: 'sks.gate-result.v0', contract_mode: 'strict', ok: true, blockers: [] })), null);
});
