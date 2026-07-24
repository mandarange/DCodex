// First import: executed fixtures reach the global skills reconciler, which
// installs $HOME/.agents/skills when the default home leaks through.
import '../../dist/core/__tests__/helpers/isolated-test-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runFeatureFixture } from '../../dist/core/feature-fixture-runner.js';

test('feature fixture runner uses hermetic temp roots for executable fixtures', () => {
  const result = runFeatureFixture({
    id: 'fixture-hermetic',
    fixture: {
      kind: 'execute',
      quality: 'execute',
      root_mode: 'hermetic_temp_project',
      command: 'sks root --json',
      expected_artifacts: [],
      status: 'pass'
    }
  }, {
    root: process.cwd(),
    execute: true,
    commandArgs: ['root', '--json']
  });
  assert.equal(result.root_mode, 'hermetic_temp_project');
  assert.notEqual(result.temp_root, process.cwd());
  assert.equal(result.execution.ok, true);
});
