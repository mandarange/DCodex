import test from 'node:test';
import assert from 'node:assert/strict';
import {
  doctorPhaseIdsForProfile,
  doctorProfileRequiresDesktopBridgeReadiness
} from '../doctor-profile.js';

test('codex_config_syntax_repair runs in every doctor profile that repairs', () => {
  for (const profile of ['migration', 'fix', 'full', 'capabilities', 'fast'] as const) {
    const phases = doctorPhaseIdsForProfile(profile);
    assert.ok(
      phases.includes('codex_config_syntax_repair'),
      `profile ${profile} must include codex_config_syntax_repair so update finalization validates config.toml`
    );
  }
});

test('migration profile keeps the existing required phase order around the syntax repair', () => {
  const phases = doctorPhaseIdsForProfile('migration');
  assert.deepEqual(phases, [
    'codex_startup_repair',
    'startup_config_repair',
    'codex_config_syntax_repair',
    'context7_repair',
    'context7_mcp_repair',
    'hook_trust_repair',
    'command_alias_cleanup'
  ]);
});

test('migration profile does not turn optional live Desktop Bridge readiness into an update blocker', () => {
  assert.equal(doctorProfileRequiresDesktopBridgeReadiness('migration'), false);
  for (const profile of ['fast', 'fix', 'full', 'capabilities'] as const) {
    assert.equal(doctorProfileRequiresDesktopBridgeReadiness(profile), true, profile);
  }
});
