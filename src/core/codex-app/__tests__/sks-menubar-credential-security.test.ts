import test from 'node:test'
import assert from 'node:assert/strict'
import { menuBarCredentialEnvironmentBlocker } from '../menubar/installer.js'

test('Menu Bar install blocks when global secret cleanup cannot be verified', () => {
  assert.equal(menuBarCredentialEnvironmentBlocker({
    cleanupOk: false
  }), 'launch_secret_env_cleanup_incomplete')
})

test('Menu Bar install blocks failed dual-auth restoration instead of continuing', () => {
  assert.equal(menuBarCredentialEnvironmentBlocker({
    cleanupOk: true,
    compatibilityConfigured: true,
    compatibilityRestored: false
  }), 'desktop_compat_launch_env_restore_incomplete')
  assert.equal(menuBarCredentialEnvironmentBlocker({
    cleanupOk: true,
    compatibilityConfigured: false
  }), null)
})
