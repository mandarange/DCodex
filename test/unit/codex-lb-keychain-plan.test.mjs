import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCodexLbSetupPlan } from '../../dist/core/codex-lb/codex-lb-setup.js';

test('codex-lb setup keychain action follows the keychain answer', () => {
  const plan = buildCodexLbSetupPlan({
    host_or_base_url: 'lb.example.test',
    api_key_source: 'stdin',
    use_as_default_provider: true,
    write_env_file: true,
    store_keychain: true,
    sync_launchctl: false,
    install_shell_profile: 'skip',
    run_health_check: false,
    allow_insecure_localhost: false
  });
  const action = plan.actions.find((entry) => entry.type === 'store_keychain');
  assert.ok(action);
  assert.equal(action.command, undefined);
  assert.doesNotMatch(JSON.stringify(action), /security add-generic-password|-w\b|--api-key\b|--key\b/i);
  assert.match(action.effect, /dedicated signed Keychain helper/i);
  assert.ok(plan.blockers.includes('keychain_acl_helper_unavailable'));
});
