import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIntentContract, decideIntentReplay, terminalStateForVerification } from '../intent-contract.js';

function build(overrides: Partial<Parameters<typeof buildIntentContract>[0]> = {}) {
  return buildIntentContract({
    naturalLanguageEffect: 'Inspect security and delete policy without changing files.',
    effect: 'read', canonicalCommand: 'sks review', targetHashes: ['a'.repeat(64)],
    policyVersion: 'policy-v1', modeSnapshot: 'codex-lb', evidenceState: 'valid', ...overrides
  });
}

test('actual effect outranks risky nouns, light commands, and force', () => {
  assert.equal(build().risk, 'FAST');
  assert.equal(build({ effect: 'delete', canonicalCommand: 'sks check', force: true }).risk, 'HEAVY');
  assert.equal(build({ effect: 'auth', requestedRisk: 'FAST' }).risk, 'HEAVY');
  assert.equal(build({ requestedRisk: 'HEAVY' }).risk, 'HEAVY');
  assert.throws(() => build({ requestedRisk: 'ULTRA' }), /explicit_opt_in/);
  assert.equal(build({ requestedRisk: 'ULTRA', explicitUltraOptIn: true }).risk, 'ULTRA');
});

test('contracts are deeply immutable, normalized and stable across replay', () => {
  const first = build({ observedChangedPaths: ['./src/b.ts', 'src/a.ts'] });
  const second = build({ observedChangedPaths: ['src/a.ts', 'src/b.ts'] });
  assert.equal(first.contract_hash, second.contract_hash);
  assert.equal(Object.isFrozen(first.observed_changed_paths), true);
  assert.throws(() => (first.observed_changed_paths as string[]).push('src/c.ts'));
});

test('replay detects target, policy and mode drift and gates expired evidence by risk', () => {
  assert.equal(decideIntentReplay(build(), build()).action, 'reuse');
  assert.equal(decideIntentReplay(build(), build({ targetHashes: ['b'.repeat(64)] })).action, 'replan');
  assert.equal(decideIntentReplay(build(), build({ policyVersion: 'policy-v2' })).action, 'replan');
  assert.equal(decideIntentReplay(build(), build({ modeSnapshot: 'openrouter' })).action, 'replan');
  assert.equal(decideIntentReplay(build(), build({ evidenceState: 'expired' })).action, 'refresh_direct_evidence');
  assert.equal(decideIntentReplay(build(), build({ effect: 'security', evidenceState: 'expired' })).action, 'replan');
  const heavyExpired = build({ effect: 'security', evidenceState: 'expired' });
  assert.equal(decideIntentReplay(heavyExpired, heavyExpired).action, 'blocked');
});

test('terminal state keeps unverified, paused, failed and completed distinct', () => {
  assert.equal(terminalStateForVerification({ executionOk: true, verificationOk: null, paused: false }), 'unverified');
  assert.equal(terminalStateForVerification({ executionOk: true, verificationOk: true, paused: true }), 'paused');
  assert.equal(terminalStateForVerification({ executionOk: false, verificationOk: false, paused: false }), 'failed');
  assert.equal(terminalStateForVerification({ executionOk: true, verificationOk: true, paused: false }), 'completed');
});
