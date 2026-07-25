import test from 'node:test';
import assert from 'node:assert/strict';
import { assessTestVolume, isMoneySensitivePath, isTestPath } from '../lean-engineering-policy.js';

test('test files are recognised by directory and by suffix', () => {
  assert.equal(isTestPath('src/core/__tests__/thing.test.ts'), true);
  assert.equal(isTestPath('test/unit/thing.test.mjs'), true);
  assert.equal(isTestPath('src/core/thing.spec.tsx'), true);
  assert.equal(isTestPath('src/core/thing.ts'), false);
  // A source file that merely mentions testing is not a test file.
  assert.equal(isTestPath('src/core/testable-runner.ts'), false);
});

test('money-handling paths are recognised so their tests stay exempt', () => {
  for (const path of [
    'src/core/payment/charge.ts',
    'src/billing/invoice-runner.ts',
    'src/core/ledger.ts',
    'src/core/refunds.ts',
    'src/core/checkout/session.ts'
  ]) {
    assert.equal(isMoneySensitivePath(path), true, path);
  }
  // Displaying a price is not moving money; the exemption stays narrow so it
  // cannot switch the budget off for ordinary code.
  for (const path of ['src/core/routes.ts', 'src/cli/help.ts', 'src/core/pricing-page-copy.ts']) {
    assert.equal(isMoneySensitivePath(path), false, path);
  }
});

test('a focused regression test for a small fix is never over budget', () => {
  const assessment = assessTestVolume([
    { path: 'src/core/code-structure.ts', lines_added: 2 },
    { path: 'test/unit/code-structure-lean.test.mjs', lines_added: 30 }
  ]);
  assert.equal(assessment.over_budget, false);
  assert.equal(assessment.added_test_lines, 30);
  assert.equal(assessment.added_source_lines, 2);
});

test('a large test body dwarfing the code it covers is flagged', () => {
  const assessment = assessTestVolume([
    { path: 'src/core/thing.ts', lines_added: 40 },
    { path: 'src/core/__tests__/thing.test.ts', lines_added: 800 }
  ]);
  assert.equal(assessment.over_budget, true);
  assert.equal(assessment.ratio, 20);
});

test('the same volume on a money-handling path is exempt', () => {
  const assessment = assessTestVolume([
    { path: 'src/core/payment/charge.ts', lines_added: 40 },
    { path: 'src/core/payment/__tests__/charge.test.ts', lines_added: 800 }
  ]);
  assert.equal(assessment.money_sensitive, true);
  assert.equal(assessment.over_budget, false);
});
