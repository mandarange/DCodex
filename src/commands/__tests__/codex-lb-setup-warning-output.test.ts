import assert from 'node:assert/strict';
import test from 'node:test';
import fsp from 'node:fs/promises';
import {
  formatCodexLbSetupWarnings,
  printCodexLbSetupWarnings
} from '../../cli/codex-lb-setup-warning-output.js';

test('non-JSON codex-lb output explains provider-key rotation after legacy Keychain removal', () => {
  const warnings = formatCodexLbSetupWarnings({
    warnings: ['legacy_keychain_removed_rotate_provider_key_if_not_already_rotated']
  });

  assert.deepEqual(warnings, [
    'warning: The retired macOS Keychain item was removed. Rotate the provider API key if it has not already been rotated.'
  ]);
});

test('non-JSON codex-lb output explains rotation when legacy Keychain cleanup is indeterminate', () => {
  const output: string[] = [];
  printCodexLbSetupWarnings({
    warnings: [
      'legacy_keychain_cleanup_indeterminate_rotate_provider_key',
      'legacy_keychain_cleanup_indeterminate_rotate_provider_key'
    ],
    persistence: {
      warning: 'process_only_ephemeral'
    }
  }, (message) => output.push(message));

  assert.deepEqual(output, [
    'warning: Legacy macOS Keychain cleanup could not be proved. Rotate the provider API key before continuing to use it.',
    'warning: process_only_ephemeral'
  ]);
});

test('postinstall and MAD launch setup render warnings from their real configure callers', async () => {
  const source = await fsp.readFile(
    new URL('../../../src/cli/install-helpers.ts', import.meta.url),
    'utf8'
  );
  const postinstallBody = source.slice(
    source.indexOf('async function reportPostinstallCodexLbAuth'),
    source.indexOf('async function postinstallHarnessConflictNotice')
  );
  const launchBody = source.slice(
    source.indexOf('export async function maybePromptCodexLbSetupForLaunch'),
    source.indexOf('function scrubCodexLbToolEnvironment')
  );

  assert.match(postinstallBody, /configureCodexLb\([^]*printCodexLbSetupWarnings\(result\)/);
  assert.match(launchBody, /configureCodexLb\([^]*printCodexLbSetupWarnings\(configured\)/);
});
