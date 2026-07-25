import test from 'node:test';
import assert from 'node:assert/strict';
import { menuBarInstallIsTerminalUncertain } from '../update-check.js';
import type { SksMenuBarInstallResult } from '../codex-app/menubar/index.js';

test('update outcome treats Menu Bar launch or rollback read-back uncertainty as terminal_uncertain', () => {
  assert.equal(menuBarInstallIsTerminalUncertain(null), false);
  assert.equal(menuBarInstallIsTerminalUncertain(installResult()), false);
  assert.equal(menuBarInstallIsTerminalUncertain(installResult({ status: 'terminal_uncertain' })), true);
  assert.equal(menuBarInstallIsTerminalUncertain(installResult({
    launch: { requested: true, method: 'launchctl', ok: false, terminal_uncertain: true }
  })), true);
  assert.equal(menuBarInstallIsTerminalUncertain(installResult({
    rollback: {
      schema: 'sks.menubar-rollback.v1',
      ok: false,
      platform: process.platform,
      status: 'terminal_uncertain',
      paths: {} as any,
      previous_version: '6.2.0',
      replaced_version: '6.3.0',
      verification_before: null,
      verification_after: null,
      launch: { requested: true, method: 'launchctl', ok: false, terminal_uncertain: true },
      actions: [],
      warnings: [],
      blockers: ['menubar_rollback_launch_terminal_uncertain']
    }
  })), true);
});

function installResult(overrides: Partial<SksMenuBarInstallResult> = {}): SksMenuBarInstallResult {
  return {
    schema: 'sks.codex-app-sks-menubar.v1',
    ok: true,
    apply: true,
    status: 'installed',
    platform: process.platform,
    app_path: null,
    executable_path: null,
    launch_agent_path: null,
    action_script_path: null,
    build_stamp_path: null,
    report_path: null,
    menu_items: [],
    actions: [],
    next_actions: [],
    blockers: [],
    warnings: [],
    ...overrides
  };
}
