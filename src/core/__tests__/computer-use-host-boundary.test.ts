import test from 'node:test';
import assert from 'node:assert/strict';
import { MANAGED_OFFICIAL_SUBAGENT_ROLES } from '../managed-assets/managed-assets-manifest.js';
import { CODEX_COMPUTER_USE_ONLY_POLICY } from '../routes/evidence.js';

test('Computer Use policy excludes the hosting Codex app and routes linked QA to the external target', () => {
  assert.match(CODEX_COMPUTER_USE_ONLY_POLICY, /com\.openai\.codex/);
  assert.match(CODEX_COMPUTER_USE_ONLY_POLICY, /must never target the hosting Codex Desktop app/i);
  assert.match(CODEX_COMPUTER_USE_ONLY_POLICY, /structured App Server, process, or NSWorkspace evidence/i);
  assert.match(CODEX_COMPUTER_USE_ONLY_POLICY, /external native target/i);

  const operator = MANAGED_OFFICIAL_SUBAGENT_ROLES.find((role) => role.codex_name === 'computer_use_operator');
  assert.ok(operator);
  assert.match(operator.developer_instructions, /com\.openai\.codex/);
  assert.match(operator.developer_instructions, /Do not target the hosting Codex Desktop app/i);
});
