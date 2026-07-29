import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS } from '../../../../cli/command-registry.js';
import {
  commandContract,
  commandContracts,
  outputCapFor,
  timeoutFor,
  validateCommandContractRegistry,
  validateJsonSchema
} from '../index.js';

test('command contract registry covers the command registry without regex or compiled-source inference', () => {
  const validation = validateCommandContractRegistry();
  assert.equal(validation.ok, true, validation.issues.join(', '));
  assert.deepEqual(validation.observed_names, Object.keys(COMMANDS).sort());
  assert.equal(commandContracts().size, Object.keys(COMMANDS).length);
  for (const [name, command] of Object.entries(COMMANDS)) {
    assert.equal(typeof command.risk, 'string', name);
    assert.equal(typeof command.latency, 'string', name);
    assert.equal(typeof command.supportsJson, 'boolean', name);
    assert.equal(typeof command.remoteAllowed, 'boolean', name);
    assert.equal(typeof command.inputProfile, 'string', name);
    assert.ok(Array.isArray(command.requiredCapabilities), name);
    if (command.supportsJson) assert.notEqual(command.inputProfile, 'none', name);
  }
});

test('risk and remote policy are explicit and fail closed for R3', () => {
  assert.equal(commandContract('status')?.risk, 'R0');
  assert.equal(commandContract('gates')?.risk, 'R1');
  assert.equal(commandContract('update')?.risk, 'R2');
  assert.equal(commandContract('mad-sks')?.risk, 'R3');
  assert.equal(commandContract('mad-sks')?.remote_allowed, false);
  for (const name of ['mcp', 'remote']) {
    assert.equal(commandContract(name)?.risk, 'R2');
    assert.equal(commandContract(name)?.remote_allowed, false);
  }
});

test('per-tool schema rejects unknown or mistyped arguments', () => {
  const contract = commandContract('stop-gate');
  assert.ok(contract);
  const ok = validateJsonSchema({ route: 'Naruto', json: true }, contract.input_schema);
  assert.equal(ok.ok, true);
  const unknown = validateJsonSchema({ route: 'Naruto', shell: 'rm -rf /' }, contract.input_schema);
  assert.equal(unknown.ok, false);
  assert.ok(unknown.issues.some((entry) => entry.code === 'additionalProperties'));
  const mistyped = validateJsonSchema({ json: 'yes' }, contract.input_schema);
  assert.equal(mistyped.ok, false);
  assert.ok(mistyped.issues.some((entry) => entry.code === 'type'));
});

test('validated argv builders apply typed arguments and never accept arbitrary argv', () => {
  const contract = commandContract('stop-gate');
  assert.ok(contract);
  const validation = validateJsonSchema({ route: 'Naruto', mission: 'M-1', json: true }, contract.input_schema);
  assert.equal(validation.ok, true);
  if (!validation.ok) return;
  assert.deepEqual(contract.argv_builder(validation.value), [
    'stop-gate', 'check', '--route', 'Naruto', '--mission', 'M-1', '--json'
  ]);
});

test('JSON-capable local R2 commands preserve the explicit JSON flag without exposing arbitrary argv', () => {
  for (const name of ['align', 'mcp', 'remote']) {
    const contract = commandContract(name);
    assert.ok(contract, name);
    const validation = validateJsonSchema({ json: true }, contract.input_schema);
    assert.equal(validation.ok, true, name);
    if (!validation.ok) continue;
    assert.deepEqual(contract.argv_builder(validation.value), [name, '--json'], name);
    const arbitrary = validateJsonSchema({ argv: ['--shell', 'rm -rf /'] }, contract.input_schema);
    assert.equal(arbitrary.ok, false, name);
  }
});

test('Naruto contract matches its local-only explicit-opt-in CLI surface', () => {
  const contract = commandContract('naruto');
  assert.ok(contract);
  assert.equal(contract.risk, 'R2');
  assert.equal(contract.latency, 'long');
  assert.equal(contract.supports_json, true);
  assert.equal(contract.remote_allowed, false);
  assert.equal(contract.input_schema.additionalProperties, false);
  assert.deepEqual((contract.input_schema as any).properties.action.enum, ['run', 'status', 'subagents', 'proof', 'parent-summary', 'help']);

  const run = validateJsonSchema({ action: 'run', task: 'bounded task', mission: 'M-1', agents: 2, max_threads: 4, readonly: true, trusted_project: true, json: true }, contract.input_schema);
  assert.equal(run.ok, true);
  if (run.ok) {
    assert.deepEqual(contract.argv_builder(run.value), [
      'naruto', 'run', 'bounded task', '--mission', 'M-1', '--agents', '2', '--max-threads', '4', '--readonly', '--trusted-project', '--json'
    ]);
  }

  const prompt = validateJsonSchema({ action: 'run', prompt: 'prompt alias', json: true }, contract.input_schema);
  assert.equal(prompt.ok, true);
  if (prompt.ok) assert.deepEqual(contract.argv_builder(prompt.value), ['naruto', 'run', 'prompt alias', '--json']);

  const proof = validateJsonSchema({ action: 'proof', mission: 'M-1', json: true }, contract.input_schema);
  assert.equal(proof.ok, true);
  if (proof.ok) assert.deepEqual(contract.argv_builder(proof.value), ['naruto', 'proof', '--mission', 'M-1', '--json']);

  const parentSummary = validateJsonSchema({ action: 'parent-summary', mission: 'M-1', stdin: true, json: true }, contract.input_schema);
  assert.equal(parentSummary.ok, true);
  if (parentSummary.ok) {
    assert.deepEqual(contract.argv_builder(parentSummary.value), [
      'naruto', 'parent-summary', '--mission', 'M-1', '--stdin', '--json'
    ]);
  }

  const misplacedTask = validateJsonSchema({ action: 'status', task: 'must not be silently dropped', json: true }, contract.input_schema);
  assert.equal(misplacedTask.ok, true);
  if (misplacedTask.ok) {
    assert.deepEqual(contract.argv_builder(misplacedTask.value), ['naruto', 'status', 'must not be silently dropped', '--json']);
  }

  const unknownAction = validateJsonSchema({ action: 'dashboard', json: true }, contract.input_schema);
  assert.equal(unknownAction.ok, false);
  const unknownInput = validateJsonSchema({ action: 'run', task: 'x', model: 'gpt-5.6-terra' }, contract.input_schema);
  assert.equal(unknownInput.ok, false);
  assert.ok(!unknownInput.ok && unknownInput.issues.some((entry) => entry.code === 'additionalProperties'));
});

test('latency classes have bounded timeout and output caps', () => {
  assert.deepEqual(
    ['fast', 'normal', 'long'].map((latency) => [timeoutFor(latency as 'fast' | 'normal' | 'long'), outputCapFor(latency as 'fast' | 'normal' | 'long')]),
    [[15_000, 128 * 1024], [60_000, 512 * 1024], [180_000, 1024 * 1024]]
  );
});
