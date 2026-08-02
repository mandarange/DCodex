import '../../__tests__/helpers/isolated-test-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCodexLbSetupPlan } from '../codex-lb-setup.js';

test('explicit Keychain persistence stays fail-closed without a verified dedicated helper', () => {
  const plan = buildCodexLbSetupPlan({
    host_or_base_url: 'https://lb.example.test',
    api_key_source: 'stdin',
    write_env_file: true,
    store_keychain: true,
    sync_launchctl: false,
    install_shell_profile: 'skip',
    run_health_check: false,
    allow_insecure_localhost: false
  });

  assert.ok(plan.blockers.includes('keychain_acl_helper_unavailable'));
  assert.ok(plan.actions.some((action) => action.type === 'store_keychain'));
});
