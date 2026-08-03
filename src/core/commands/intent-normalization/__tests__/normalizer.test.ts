import assert from 'node:assert/strict';
import test from 'node:test';
import { DOLLAR_COMMAND_ALIASES_LITE } from '../../../routes/dollar-manifest-lite.js';
import { allIntentNormalizationForms, normalizeIntentCommand } from '../normalizer.js';

const base = {
  naturalLanguageEffect: 'Read the current status without changing state.', effect: 'read' as const,
  targetHashes: ['a'.repeat(64)], policyVersion: 'policy-v1', modeSnapshot: 'codex-lb' as const,
  evidenceState: 'valid' as const
};

test('the full manifest and alias table normalize to canonical CLI commands', () => {
  for (const rawCommand of allIntentNormalizationForms()) {
    assert.match(normalizeIntentCommand({ ...base, rawCommand }).canonical_command, /^sks(?: |$)/);
  }
});

test('every dollar alias produces the same contract hash as its canonical command', () => {
  for (const alias of DOLLAR_COMMAND_ALIASES_LITE) {
    const canonical = normalizeIntentCommand({ ...base, rawCommand: alias.canonical });
    const normalizedAlias = normalizeIntentCommand({ ...base, rawCommand: alias.app_skill });
    assert.equal(normalizedAlias.contract.contract_hash, canonical.contract.contract_hash, `${alias.app_skill} -> ${alias.canonical}`);
  }
});

test('natural-language effect outranks a low-risk explicit command and force cannot bypass HEAVY', () => {
  const normalized = normalizeIntentCommand({ ...base, rawCommand: 'sks help --force', naturalLanguageEffect: 'Delete deployed credentials.', effect: 'delete', force: true });
  assert.equal(normalized.contract.risk, 'HEAVY');
  assert.equal(normalized.contract.force, true);
});

test('deprecated options warn or fail instead of being silently accepted', () => {
  assert.equal(normalizeIntentCommand({ ...base, rawCommand: 'sks help --mad' }).deprecations[0]?.severity, 'warning');
  assert.throws(() => normalizeIntentCommand({ ...base, rawCommand: 'sks help --skip-evidence' }), /legacy_option_unsupported/);
});
