import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureForFeature } from '../../dist/core/feature-fixtures.js';

test('unknown feature fixtures are missing instead of implicit static pass', () => {
  const missing = fixtureForFeature('unknown-runtime-feature');
  assert.equal(missing.kind, 'not_available');
  assert.equal(missing.status, 'missing');
  assert.equal(missing.fallback_removed, true);
  const skill = fixtureForFeature('skill-example');
  assert.equal(skill.status, 'pass');
  assert.equal(skill.quality, 'static_contract');
  assert.equal(fixtureForFeature('cli-update').status, 'pass');
  assert.equal(fixtureForFeature('cli-with-local-llm').status, 'pass');
  assert.equal(fixtureForFeature('route-with-local-llm-on').status, 'pass');
  assert.equal(fixtureForFeature('route-with-local-llm-off').status, 'pass');
});

test('wrongness release fixture validates without mutating project memory', () => {
  const fixture = fixtureForFeature('cli-wrongness');
  assert.equal(fixture.kind, 'execute');
  assert.equal(fixture.command, 'sks wrongness validate project --json');
  assert.deepEqual(fixture.expected_artifacts, []);
  assert.doesNotMatch(fixture.command, /\bwrongness\s+add\b/);
});
