import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCodexLbSetupPlan, type CodexLbSetupAnswers } from '../codex-lb-setup.js';

function answers(selected: boolean): CodexLbSetupAnswers {
  return {
    host_or_base_url: 'https://lb.example.test',
    api_key_source: 'stdin',
    desktop_mode: 'cli-provider',
    use_as_default_provider: selected,
    write_env_file: true,
    store_keychain: false,
    sync_launchctl: true,
    install_shell_profile: 'skip',
    run_health_check: false,
    allow_insecure_localhost: false
  };
}

test('launchctl plan sets the canonical key only for selected CLI-provider mode', () => {
  const selected = buildCodexLbSetupPlan(answers(true), { home: '/fixture/home' });
  const selectedAction = selected.actions.find((entry) => entry.type === 'sync_launchctl');
  assert.match(selectedAction?.effect || '', /canonical owner-only env file/);
  assert.match(selectedAction?.command || '', /(?:^|\s)setenv CODEX_LB_API_KEY/);

  const unselected = buildCodexLbSetupPlan(answers(false), { home: '/fixture/home' });
  const unselectedAction = unselected.actions.find((entry) => entry.type === 'sync_launchctl');
  assert.match(unselectedAction?.effect || '', /outside selected CLI-provider mode/);
  assert.match(unselectedAction?.command || '', /unsetenv CODEX_LB_API_KEY/);
  assert.doesNotMatch(unselectedAction?.command || '', /(?:^|\s)setenv CODEX_LB_API_KEY/);
});
