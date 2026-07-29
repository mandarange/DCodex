#!/usr/bin/env node
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { configureCodexLbDesktopRouting } from '../cli/install-helpers.js'
import {
  assertDesktopAuthUnchangedBySks,
  captureCodexAuthSnapshot
} from '../core/codex-lb/desktop-auth-invariant.js'
import { safeWriteCodexConfigToml } from '../core/codex-runtime/codex-desktop-config-policy.js'
import { assertGate, emitGate } from './gate-lib.js'

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-codex-lb-desktop-auth-gate-'))

let report: Awaited<ReturnType<typeof runCheck>>
try {
  report = await runCheck(temporaryRoot)
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true })
}

assertGate(report.ok, 'codex-lb Desktop auth invariant gate failed', report)
emitGate('codex-lb:desktop-auth-invariant', {
  auth_byte_invariant: report.auth_byte_invariant,
  auth_invariant_rollback: report.auth_invariant_rollback,
  conflict_rejected_without_mutation: report.conflict_rejected_without_mutation,
  rollback_conflict_preserved: report.rollback_conflict_preserved
})

async function runCheck(root: string) {
  const home = path.join(root, 'home')
  const codexHome = path.join(home, '.codex')
  const configPath = path.join(codexHome, 'config.toml')
  const authPath = path.join(codexHome, 'auth.json')
  await fs.mkdir(codexHome, { recursive: true })

  const initialConfig = [
    'model = "user-owned-model"',
    'model_reasoning_effort = "high"',
    'service_tier = "standard"',
    '',
    '[features]',
    'fast_mode = false',
    ''
  ].join('\n')
  const authBytes = Buffer.from([
    '{',
    '  "auth_mode": "chatgpt",',
    '  "account_id": "acct-auth-gate",',
    '  "tokens": {',
    '    "access_token": "desktop-oauth-access",',
    '    "refresh_token": "desktop-oauth-refresh"',
    '  }',
    '}',
    ''
  ].join('\n'))
  await fs.writeFile(configPath, initialConfig, { mode: 0o600 })
  await fs.writeFile(authPath, authBytes, { mode: 0o600 })

  const before = await captureCodexAuthSnapshot({ home })
  const configured = await configureCodexLbDesktopRouting({
    mode: 'desktop-native-bridge',
    home,
    bridgeBaseUrl: 'http://127.0.0.1:52145/backend-api/codex',
    remoteBaseUrl: 'https://lb.example.test/backend-api/codex',
    gatewayAuthTransport: 'x-codex-lb-api-key'
  })
  const after = await captureCodexAuthSnapshot({ home })
  await assertDesktopAuthUnchangedBySks(before, after)
  const authAfterBytes = await fs.readFile(authPath)
  const configuredText = await fs.readFile(configPath, 'utf8')

  const conflictConfigPath = path.join(codexHome, 'conflict-config.toml')
  const conflictConfig = [
    'model_provider = "user-provider"',
    '',
    '[model_providers.user-provider]',
    'name = "user-provider"',
    'base_url = "https://user.example.test/v1"',
    'wire_api = "responses"',
    ''
  ].join('\n')
  await fs.writeFile(conflictConfigPath, conflictConfig, { mode: 0o600 })
  const conflictBeforeAuth = await fs.readFile(authPath)
  const conflict = await configureCodexLbDesktopRouting({
    mode: 'desktop-native-bridge',
    home,
    configPath: conflictConfigPath,
    authPath,
    bridgeBaseUrl: 'http://127.0.0.1:52145/backend-api/codex',
    remoteBaseUrl: 'https://lb.example.test/backend-api/codex',
    gatewayAuthTransport: 'x-codex-lb-api-key'
  })
  const conflictAfterAuth = await fs.readFile(authPath)
  const conflictAfterConfig = await fs.readFile(conflictConfigPath, 'utf8')

  const rollbackHome = path.join(root, 'rollback-home')
  const rollbackCodexHome = path.join(rollbackHome, '.codex')
  const rollbackConfigPath = path.join(rollbackCodexHome, 'config.toml')
  const rollbackAuthPath = path.join(rollbackCodexHome, 'auth.json')
  const rollbackInitialConfig = 'service_tier = "standard"\n'
  const rollbackInitialAuth = '{"auth_mode":"chatgpt","account_id":"acct-rollback","tokens":{"access_token":"before"}}\n'
  const rollbackRotatedAuth = '{"auth_mode":"chatgpt","account_id":"acct-rollback","tokens":{"access_token":"after"}}\n'
  await fs.mkdir(rollbackCodexHome, { recursive: true })
  await fs.writeFile(rollbackConfigPath, rollbackInitialConfig, { mode: 0o600 })
  await fs.writeFile(rollbackAuthPath, rollbackInitialAuth, { mode: 0o600 })
  const originalReadFile = fs.readFile.bind(fs) as (...args: any[]) => Promise<any>
  const originalWriteFile = fs.writeFile.bind(fs) as (...args: any[]) => Promise<any>
  let rollbackAuthReads = 0
  ;(fs as any).readFile = async (file: unknown, ...args: unknown[]) => {
    if (path.resolve(String(file)) === path.resolve(rollbackAuthPath)) {
      rollbackAuthReads += 1
      if (rollbackAuthReads === 2) {
        await originalWriteFile(rollbackAuthPath, rollbackRotatedAuth, { mode: 0o600 })
      }
    }
    return originalReadFile(file, ...args)
  }
  let invariantRollback: Awaited<ReturnType<typeof configureCodexLbDesktopRouting>>
  try {
    invariantRollback = await configureCodexLbDesktopRouting({
      mode: 'desktop-native-bridge',
      home: rollbackHome,
      bridgeBaseUrl: 'http://127.0.0.1:52146/backend-api/codex',
      remoteBaseUrl: 'https://lb.example.test/backend-api/codex',
      gatewayAuthTransport: 'x-codex-lb-api-key'
    })
  } finally {
    ;(fs as any).readFile = originalReadFile
    ;(fs as any).writeFile = originalWriteFile
  }
  const invariantRollbackConfig = await fs.readFile(rollbackConfigPath, 'utf8')
  const invariantRollbackAuth = await fs.readFile(rollbackAuthPath, 'utf8')

  const concurrentUserEdit = `${configuredText.trimEnd()}\n# concurrent user edit retained\n`
  await fs.writeFile(configPath, concurrentUserEdit, { mode: 0o600 })
  const rollback = await safeWriteCodexConfigToml(
    configPath,
    configuredText,
    initialConfig,
    'codex-lb-desktop-routing-auth-invariant-rollback-gate',
    { verifyUnchangedBeforeWrite: true }
  )
  const afterRollbackAttempt = await fs.readFile(configPath, 'utf8')

  const authByteInvariant = configured.ok === true
    && configured.oauth_preserved === true
    && configured.auth_mutated === false
    && before.sha256 !== null
    && before.sha256 === after.sha256
    && authAfterBytes.equals(authBytes)
  const conflictRejectedWithoutMutation = conflict.ok === false
    && conflict.status === 'failed'
    && conflict.blockers.includes('desktop_config_conflict')
    && conflictAfterConfig === conflictConfig
    && conflictAfterAuth.equals(conflictBeforeAuth)
  const authInvariantRollback = invariantRollback.ok === false
    && invariantRollback.blockers.includes('desktop_auth_byte_invariant_failed')
    && invariantRollback.rollback?.config_restored === true
    && invariantRollbackConfig === rollbackInitialConfig
    && invariantRollbackAuth === rollbackRotatedAuth
  const rollbackConflictPreserved = rollback.ok === false
    && rollback.status === 'concurrent_change_detected'
    && afterRollbackAttempt === concurrentUserEdit

  return {
    schema: 'sks.codex-lb-desktop-auth-invariant-check.v1',
    ok: authByteInvariant
      && authInvariantRollback
      && conflictRejectedWithoutMutation
      && rollbackConflictPreserved,
    auth_byte_invariant: authByteInvariant,
    auth_invariant_rollback: authInvariantRollback,
    conflict_rejected_without_mutation: conflictRejectedWithoutMutation,
    rollback_conflict_preserved: rollbackConflictPreserved,
    routing_status: configured.status,
    conflict_status: conflict.status,
    rollback_status: rollback.status,
    blockers: [
      ...(authByteInvariant ? [] : ['desktop_auth_bytes_changed']),
      ...(authInvariantRollback ? [] : ['desktop_auth_invariant_rollback_failed']),
      ...(conflictRejectedWithoutMutation ? [] : ['desktop_config_conflict_mutated_state']),
      ...(rollbackConflictPreserved ? [] : ['desktop_rollback_overwrote_concurrent_edit'])
    ]
  }
}
