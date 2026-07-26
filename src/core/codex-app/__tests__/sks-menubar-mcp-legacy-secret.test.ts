import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePackagedMenuBarSourceRoot } from '../menubar/index.js';

test('MCP native UI exposes a guarded value-free legacy secret migration choice', () => {
  const swift = fs.readFileSync(
    path.join(resolvePackagedMenuBarSourceRoot(), 'Sources', 'MCPServersViewController.swift'),
    'utf8'
  );

  assert.match(swift, /Legacy inline secret \(values hidden\)/);
  assert.match(swift, /alert\.addButton\(withTitle: "Move to secure reference…"\)/);
  assert.match(swift, /alert\.addButton\(withTitle: "Leave unchanged"\)/);
  assert.match(swift, /Legacy inline secret left unchanged\. No configuration was written\./);
  assert.match(swift, /Review secure-reference migration/);
  assert.match(swift, /"legacy_inline_secret_action": "move_to_secure_reference"/);
  assert.match(swift, /"reviewed_legacy_env_keys": names/);
  assert.match(swift, /legacySecretButton\.isEnabled = !mutating && writable && row\?\.legacyInlineSecret == true/);
  assert.match(swift, /json\["legacy_env_keys"\] as\? \[String\] \?\? \[\]/);
  assert.doesNotMatch(swift, /"legacy_inline_secret_value"|"raw_secret"/);
});
