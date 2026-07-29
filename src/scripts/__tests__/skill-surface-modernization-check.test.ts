import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSkillSurfaceInventory,
  containsActiveOpenaiSkillsReference,
  countActiveOpenaiSkillsReferences
} from '../skill-surface-modernization-check.js';

test('openai/skills is allowed only when the same line marks it deprecated migration evidence', () => {
  assert.equal(
    containsActiveOpenaiSkillsReference('Use https://github.com/openai/skills as the active source.'),
    true
  );
  assert.equal(
    containsActiveOpenaiSkillsReference('Use openai/skills as current guidance.'),
    true
  );
  assert.equal(
    containsActiveOpenaiSkillsReference(
      'Treat openai/skills only as deprecated migration evidence rather than as the active baseline.'
    ),
    false
  );
  assert.equal(
    countActiveOpenaiSkillsReferences(
      'Use openai/skills and https://github.com/openai/skills as active sources.'
    ),
    2
  );
});

test('surface inventory reports missing, unexpected, and duplicate names without hiding them', () => {
  const inventory = buildSkillSurfaceInventory({
    authoritativeCommandNames: ['align', 'align', 'status'],
    auditedCommandNames: ['align', 'extra'],
    authoritativeSkillNames: ['sks-align', 'sks-align', 'sks-status'],
    auditedSkillNames: ['sks-align', 'sks-extra'],
    declaredSkillNames: ['sks-align', 'sks-align']
  });
  assert.deepEqual(inventory.missing_command_names, ['status']);
  assert.deepEqual(inventory.unexpected_command_names, ['extra']);
  assert.deepEqual(inventory.duplicate_command_names, ['align']);
  assert.deepEqual(inventory.missing_skill_names, ['sks-status']);
  assert.deepEqual(inventory.unexpected_skill_names, ['sks-extra']);
  assert.deepEqual(inventory.duplicate_skill_names, ['sks-align']);
});
