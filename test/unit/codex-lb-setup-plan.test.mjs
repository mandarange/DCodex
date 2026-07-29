import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCodexLbSetupPlan } from '../../dist/core/codex-lb/codex-lb-setup.js';

test('codex-lb setup plan includes only selected actions', () => {
  const plan = buildCodexLbSetupPlan({
    host_or_base_url: 'lb.example.test',
    api_key_source: 'stdin',
    desktop_mode: 'desktop-native-bridge',
    gateway_auth_transport: 'x-codex-lb-api-key',
    write_env_file: false,
    store_keychain: false,
    sync_launchctl: false,
    install_shell_profile: 'skip',
    run_health_check: false,
    allow_insecure_localhost: false
  }, { home: '/tmp/sks-home' });
  const actions = plan.actions.map((action) => action.type);
  assert.deepEqual(actions, [
    'configure_desktop_native_bridge',
    'start_desktop_bridge',
    'verify_oauth_preserved',
    'write_metadata'
  ]);
  const oauthVerification = plan.actions.find((action) => action.type === 'verify_oauth_preserved');
  assert.equal(oauthVerification?.target, '/tmp/sks-home/.codex/auth.json');
  assert.match(oauthVerification?.effect || '', /OAuth identity/i);
  assert.equal(plan.base_url, 'https://lb.example.test/backend-api/codex');
});
