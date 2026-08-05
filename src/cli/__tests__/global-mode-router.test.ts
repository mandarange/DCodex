import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectGlobalMode,
  findRetiredGlobalExecutionArgumentErrors,
  glmWithoutMadResult,
  stripGlobalModeFlags
} from '../global-mode-router.js';

test('detectGlobalMode no longer routes GLM MAD; --glm is retired', () => {
  assert.equal(detectGlobalMode(['--mad', '--glm', '--json']), null);
  assert.equal(detectGlobalMode(['--glm']), null);
  assert.deepEqual(stripGlobalModeFlags(['--mad', '--glm', '--repair']), ['--repair']);
  assert.ok(findRetiredGlobalExecutionArgumentErrors(['--glm']).includes('unsupported_argument:--glm'));
  assert.match(glmWithoutMadResult().hint, /sks bridge provider configure/);
  assert.match(glmWithoutMadResult().hint, /sks bridge route set-default/);
});

test('detectGlobalMode leaves help/version alone', () => {
  assert.equal(detectGlobalMode(['help']), null);
  assert.equal(detectGlobalMode(['--version']), null);
  assert.equal(detectGlobalMode(['naruto', '--json']), null);
});
