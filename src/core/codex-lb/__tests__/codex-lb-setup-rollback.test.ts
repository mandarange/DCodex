import '../../__tests__/helpers/isolated-test-home.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { configureCodexLb } from '../../../cli/install-helpers.js'
import {
  captureCodexLbSetupWriteState,
  sha256Text
} from '../../../cli/install-helpers-codex-lb-config.js'

async function compatibleFetch() {
  return new Response('{}', {
    status: 200,
    headers: { 'x-app-version': '1.21.0-beta.3' }
  })
}

async function readState(file: string) {
  try {
    const [bytes, stat] = await Promise.all([fsp.readFile(file), fsp.stat(file)])
    return { exists: true, bytes, mode: stat.mode & 0o777 }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      return { exists: false, bytes: Buffer.alloc(0), mode: null }
    }
    throw error
  }
}

async function verifiedMissingKeychainState() {
  return { state: 'missing' as const }
}

async function keychainStoreSucceeded() {
  return {
    ok: true,
    status: 'stored',
    keychain_state_verified: true,
    keychain_state_status: 'replacement_verified_by_helper'
  }
}

async function keychainStoreFailedVerified() {
  return {
    ok: false,
    status: 'keychain_store_failed_prior_state_verified',
    keychain_state_verified: true,
    keychain_state_status: 'prior_state_restored',
    error: 'fixture keychain store failed'
  }
}

async function keychainStoreFailedIndeterminate() {
  return {
    ok: false,
    status: 'keychain_state_indeterminate',
    keychain_state_verified: false,
    keychain_state_status: 'indeterminate',
    error: 'fixture keychain state indeterminate'
  }
}

async function recoveryFilesContaining(paths: unknown, needle: string): Promise<string[]> {
  const matches: string[] = []
  for (const file of Array.isArray(paths) ? paths : []) {
    const text = await fsp.readFile(String(file), 'utf8').catch(() => '')
    if (text.includes(needle)) matches.push(String(file))
  }
  return matches
}

test('setup drift hashes come from the exact captured file snapshot without following unsafe paths', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-lb-setup-snapshot-'))
  t.after(() => fsp.rm(home, { recursive: true, force: true }))
  const configPath = path.join(home, 'config.toml')
  const envPath = path.join(home, 'env-link')
  const metadataPath = path.join(home, 'missing-metadata.json')
  const profilePath = path.join(home, '.zshrc')
  const linkedSecretPath = path.join(home, 'linked-secret')
  await fsp.writeFile(configPath, 'model = "fixture"\n')
  await fsp.writeFile(profilePath, '# fixture profile\n')
  await fsp.writeFile(linkedSecretPath, 'must-not-be-followed\n')
  await fsp.symlink(linkedSecretPath, envPath)

  const state = await captureCodexLbSetupWriteState({
    home,
    configPath,
    envPath,
    metadataPath,
    shellProfile: 'zsh'
  })

  assert.equal(state.configHash, await sha256Text('model = "fixture"\n'))
  assert.equal(state.envHash, 'missing')
  assert.equal(state.metadataHash, 'missing')
  assert.equal(state.profileHash, await sha256Text('# fixture profile\n'))
  assert.equal(state.files.find((file: any) => file.path === envPath)?.kind, 'symlink')
  assert.equal(state.stateHash, await sha256Text(JSON.stringify(state.files)))
})

test('mandatory Keychain failure restores every setup file and ambient variable byte-for-byte', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-lb-setup-rollback-'))
  t.after(() => fsp.rm(home, { recursive: true, force: true }))
  const codexHome = path.join(home, '.codex')
  const configPath = path.join(codexHome, 'config.toml')
  const envPath = path.join(codexHome, 'sks-codex-lb.env')
  const metadataPath = path.join(codexHome, 'sks-codex-lb.json')
  const authPath = path.join(codexHome, 'auth.json')
  const zshPath = path.join(home, '.zshrc')
  const bashPath = path.join(home, '.bashrc')
  const fishPath = path.join(home, '.config', 'fish', 'config.fish')
  await fsp.mkdir(path.dirname(fishPath), { recursive: true })
  await fsp.mkdir(codexHome, { recursive: true })
  await fsp.writeFile(configPath, 'service_tier = "fast"\n', { mode: 0o640 })
  await fsp.writeFile(envPath, 'export PREVIOUS_ENV=1\n', { mode: 0o600 })
  await fsp.writeFile(metadataPath, '{"previous":true}\n', { mode: 0o644 })
  await fsp.writeFile(authPath, '{"auth_mode":"chatgpt","tokens":{"access_token":"untouched"}}\n', { mode: 0o600 })
  await fsp.writeFile(zshPath, '# user zsh\n', { mode: 0o644 })
  await fsp.writeFile(fishPath, '# user fish\n', { mode: 0o640 })
  const targets = [configPath, envPath, metadataPath, authPath, zshPath, bashPath, fishPath]
  const before = new Map(await Promise.all(targets.map(async (file) => [file, await readState(file)] as const)))
  const priorBase = process.env.CODEX_LB_BASE_URL
  const priorKey = process.env.CODEX_LB_API_KEY
  process.env.CODEX_LB_BASE_URL = 'https://before.example/backend-api/codex'
  process.env.CODEX_LB_API_KEY = 'before-key'
  t.after(() => {
    if (priorBase === undefined) delete process.env.CODEX_LB_BASE_URL
    else process.env.CODEX_LB_BASE_URL = priorBase
    if (priorKey === undefined) delete process.env.CODEX_LB_API_KEY
    else process.env.CODEX_LB_API_KEY = priorKey
  })

  const result = await configureCodexLb({
    home,
    configPath,
    envPath,
    metadataPath,
    authPath,
    host: 'https://lb.fixture.internal',
    apiKey: 'replacement-key',
    writeEnvFile: true,
    storeKeychain: true,
    shellProfile: 'all',
    forceMacos: true,
    keychainStoreImpl: keychainStoreFailedVerified,
    toolOutputRecoveryFetch: compatibleFetch,
    testHooks: {
      readKeychainState: verifiedMissingKeychainState
    }
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'keychain_store_failed_rolled_back')
  assert.equal(result.rollback?.byte_and_mode_verified, true)
  assert.deepEqual(result.rollback?.blockers, [])
  for (const file of targets) {
    assert.deepEqual(await readState(file), before.get(file), file)
  }
  assert.equal(process.env.CODEX_LB_BASE_URL, 'https://before.example/backend-api/codex')
  assert.equal(process.env.CODEX_LB_API_KEY, 'before-key')
  assert.deepEqual(await recoveryFilesContaining(result.rollback?.recovery_paths, 'replacement-key'), [])
  if (result.rollback?.config_backup_path) {
    assert.equal(result.rollback.config_backup_status, 'retained_for_recovery')
    assert.ok(result.rollback.recovery_paths.includes(result.rollback.config_backup_path))
    assert.equal(await fsp.access(result.rollback.config_backup_path).then(() => true, () => false), true)
  }
})

test('filesystem rollback cannot claim completion when Keychain failure state is indeterminate', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-lb-setup-keychain-indeterminate-'))
  t.after(() => fsp.rm(home, { recursive: true, force: true }))
  const codexHome = path.join(home, '.codex')
  const configPath = path.join(codexHome, 'config.toml')
  const envPath = path.join(codexHome, 'sks-codex-lb.env')
  const metadataPath = path.join(codexHome, 'sks-codex-lb.json')
  const initialConfig = 'service_tier = "fast"\n'
  await fsp.mkdir(codexHome, { recursive: true })
  await fsp.writeFile(configPath, initialConfig, { mode: 0o600 })

  const result = await configureCodexLb({
    home,
    configPath,
    envPath,
    metadataPath,
    host: 'https://lb.fixture.internal',
    apiKey: 'replacement-key',
    writeEnvFile: true,
    storeKeychain: true,
    shellProfile: 'skip',
    forceMacos: true,
    keychainStoreImpl: keychainStoreFailedIndeterminate,
    toolOutputRecoveryFetch: compatibleFetch
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'keychain_state_indeterminate')
  assert.equal(result.keychain?.keychain_state_verified, false)
  assert.equal(result.rollback?.ok, false)
  assert.ok(result.rollback?.blockers.includes('setup_rollback_keychain_state_indeterminate'))
  assert.equal(await fsp.readFile(configPath, 'utf8'), initialConfig)
  assert.equal(await fsp.access(envPath).then(() => true, () => false), false)
  assert.deepEqual(await recoveryFilesContaining(result.rollback?.recovery_paths, 'replacement-key'), [])
})

test('metadata failure after the config commit restores the pre-setup filesystem state', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-lb-setup-metadata-failure-'))
  t.after(() => fsp.rm(home, { recursive: true, force: true }))
  const codexHome = path.join(home, '.codex')
  const configPath = path.join(codexHome, 'config.toml')
  const envPath = path.join(codexHome, 'sks-codex-lb.env')
  const metadataPath = path.join(codexHome, 'sks-codex-lb.json')
  const initialConfig = 'service_tier = "fast"\n'
  await fsp.mkdir(codexHome, { recursive: true })
  await fsp.writeFile(configPath, initialConfig, { mode: 0o640 })

  const result = await configureCodexLb({
    home,
    configPath,
    envPath,
    metadataPath,
    host: 'https://lb.fixture.internal',
    apiKey: 'replacement-key',
    writeEnvFile: true,
    storeKeychain: false,
    shellProfile: 'skip',
    toolOutputRecoveryFetch: compatibleFetch,
    testHooks: {
      beforeMetadataWrite: () => {
        throw new Error('fixture metadata failure')
      }
    }
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'setup_failed_rolled_back')
  assert.equal(result.rollback?.ok, true)
  assert.equal(result.rollback?.keychain_retained, false)
  assert.equal(await fsp.readFile(configPath, 'utf8'), initialConfig)
  assert.equal((await fsp.stat(configPath)).mode & 0o777, 0o640)
  assert.equal(await fsp.access(envPath).then(() => true, () => false), false)
  assert.equal(await fsp.access(metadataPath).then(() => true, () => false), false)
})

test('post-Keychain env failure restores files but reports the retained replacement credential', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-lb-setup-post-keychain-env-'))
  t.after(() => fsp.rm(home, { recursive: true, force: true }))
  const codexHome = path.join(home, '.codex')
  const configPath = path.join(codexHome, 'config.toml')
  const envPath = path.join(codexHome, 'sks-codex-lb.env')
  const metadataPath = path.join(codexHome, 'sks-codex-lb.json')
  const securityBin = path.join(home, 'security')
  const initialConfig = 'service_tier = "fast"\n'
  const priorBase = process.env.CODEX_LB_BASE_URL
  const priorKey = process.env.CODEX_LB_API_KEY
  process.env.CODEX_LB_BASE_URL = 'https://before.example/backend-api/codex'
  process.env.CODEX_LB_API_KEY = 'before-key'
  t.after(() => {
    if (priorBase === undefined) delete process.env.CODEX_LB_BASE_URL
    else process.env.CODEX_LB_BASE_URL = priorBase
    if (priorKey === undefined) delete process.env.CODEX_LB_API_KEY
    else process.env.CODEX_LB_API_KEY = priorKey
  })
  await fsp.mkdir(codexHome, { recursive: true })
  await fsp.writeFile(configPath, initialConfig, { mode: 0o600 })
  await fsp.writeFile(securityBin, '#!/bin/sh\nprintf "%s\\n" "replacement-key"\n', { mode: 0o755 })

  const result = await configureCodexLb({
    home,
    configPath,
    envPath,
    metadataPath,
    host: 'https://lb.fixture.internal',
    apiKey: 'replacement-key',
    writeEnvFile: true,
    storeKeychain: true,
    shellProfile: 'skip',
    forceMacos: true,
    keychainStoreImpl: keychainStoreSucceeded,
    securityBin,
    platform: 'linux',
    syncLaunchEnv: false,
    toolOutputRecoveryFetch: compatibleFetch,
    testHooks: {
      readKeychainState: verifiedMissingKeychainState,
      beforeEnvWrite: () => {
        throw new Error('fixture env failure')
      }
    }
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'partial_configuration_keychain_retained')
  assert.equal(result.keychain?.ok, true)
  assert.equal(result.rollback?.ok, true)
  assert.equal(result.rollback?.keychain_retained, true)
  assert.equal((result as any).partial_configuration?.keychain_state, 'replacement_retained')
  assert.equal((result as any).partial_configuration?.process_environment_state, 'restored')
  assert.equal(process.env.CODEX_LB_BASE_URL, 'https://before.example/backend-api/codex')
  assert.equal(process.env.CODEX_LB_API_KEY, 'before-key')
  assert.equal(await fsp.readFile(configPath, 'utf8'), initialConfig)
  assert.equal(await fsp.access(envPath).then(() => true, () => false), false)
  assert.equal(await fsp.access(metadataPath).then(() => true, () => false), false)
  assert.deepEqual(await recoveryFilesContaining(result.rollback?.recovery_paths, 'replacement-key'), [])
})

test('a post-write env failure marks and hardens any secret-bearing recovery artifact', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-lb-setup-secret-recovery-'))
  t.after(() => fsp.rm(home, { recursive: true, force: true }))
  const codexHome = path.join(home, '.codex')
  const configPath = path.join(codexHome, 'config.toml')
  const envPath = path.join(codexHome, 'sks-codex-lb.env')
  const metadataPath = path.join(codexHome, 'sks-codex-lb.json')
  const securityBin = path.join(home, 'security')
  await fsp.mkdir(codexHome, { recursive: true })
  await fsp.writeFile(configPath, 'service_tier = "fast"\n', { mode: 0o600 })
  await fsp.writeFile(securityBin, '#!/bin/sh\nprintf "%s\\n" "replacement-key"\n', { mode: 0o755 })

  const result = await configureCodexLb({
    home,
    configPath,
    envPath,
    metadataPath,
    host: 'https://lb.fixture.internal',
    apiKey: 'replacement-key',
    writeEnvFile: true,
    storeKeychain: true,
    shellProfile: 'skip',
    forceMacos: true,
    keychainStoreImpl: keychainStoreSucceeded,
    securityBin,
    platform: 'linux',
    syncLaunchEnv: false,
    toolOutputRecoveryFetch: compatibleFetch,
    testHooks: {
      readKeychainState: verifiedMissingKeychainState,
      afterEnvWrite: () => {
        throw new Error('fixture post-write env failure')
      }
    }
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'partial_configuration_keychain_retained')
  assert.equal(result.rollback?.ok, false)
  assert.ok(result.rollback?.blockers.includes('setup_secret_recovery_retained'))
  assert.equal(result.rollback?.secret_recovery_paths.length, 1)
  const secretRecoveryPath = result.rollback?.secret_recovery_paths[0]
  assert.ok(secretRecoveryPath.startsWith(`${envPath}.sks-rollback-claimed-`))
  assert.equal((await fsp.stat(secretRecoveryPath)).mode & 0o777, 0o600)
  assert.equal((await fsp.readFile(secretRecoveryPath, 'utf8')).includes('replacement-key'), true)
  assert.equal((result as any).partial_configuration?.secret_recovery_paths[0], secretRecoveryPath)
  assert.equal(await fsp.access(envPath).then(() => true, () => false), false)
})

test('launch environment failure restores process credentials and never exposes them to the injected tool', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-lb-setup-launch-failure-'))
  t.after(() => fsp.rm(home, { recursive: true, force: true }))
  const codexHome = path.join(home, '.codex')
  const configPath = path.join(codexHome, 'config.toml')
  const envPath = path.join(codexHome, 'sks-codex-lb.env')
  const metadataPath = path.join(codexHome, 'sks-codex-lb.json')
  const launchctlBin = path.join(home, 'launchctl')
  const leakMarker = path.join(home, 'secret-leaked')
  await fsp.mkdir(codexHome, { recursive: true })
  await fsp.writeFile(configPath, 'service_tier = "fast"\n', { mode: 0o600 })
  await fsp.writeFile(
    launchctlBin,
    `#!/bin/sh\nif [ -n "$CODEX_LB_API_KEY" ] || [ -n "$OPENROUTER_API_KEY" ]; then : > ${JSON.stringify(leakMarker)}; fi\nexit 7\n`,
    { mode: 0o755 }
  )
  const priorBase = process.env.CODEX_LB_BASE_URL
  const priorKey = process.env.CODEX_LB_API_KEY
  process.env.CODEX_LB_BASE_URL = 'https://before.example/backend-api/codex'
  process.env.CODEX_LB_API_KEY = 'before-key'
  t.after(() => {
    if (priorBase === undefined) delete process.env.CODEX_LB_BASE_URL
    else process.env.CODEX_LB_BASE_URL = priorBase
    if (priorKey === undefined) delete process.env.CODEX_LB_API_KEY
    else process.env.CODEX_LB_API_KEY = priorKey
  })

  const result = await configureCodexLb({
    home,
    configPath,
    envPath,
    metadataPath,
    host: 'https://lb.fixture.internal',
    apiKey: 'replacement-key',
    writeEnvFile: true,
    storeKeychain: false,
    syncLaunchctl: true,
    shellProfile: 'skip',
    platform: 'linux',
    forceLaunchEnv: true,
    launchctlBin,
    toolOutputRecoveryFetch: compatibleFetch
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'partial_configuration_external_state_unknown')
  assert.equal((result as any).partial_configuration?.process_environment_state, 'restored')
  assert.equal(process.env.CODEX_LB_BASE_URL, 'https://before.example/backend-api/codex')
  assert.equal(process.env.CODEX_LB_API_KEY, 'before-key')
  assert.equal(await fsp.access(leakMarker).then(() => true, () => false), false)
})

test('a concurrent edit after the owned writes is preserved instead of becoming the rollback CAS baseline', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-lb-setup-phase-cas-'))
  t.after(() => fsp.rm(home, { recursive: true, force: true }))
  const codexHome = path.join(home, '.codex')
  const configPath = path.join(codexHome, 'config.toml')
  const envPath = path.join(codexHome, 'sks-codex-lb.env')
  const metadataPath = path.join(codexHome, 'sks-codex-lb.json')
  const concurrentConfig = '# concurrent edit after setup writes\nservice_tier = "priority"\n'
  await fsp.mkdir(codexHome, { recursive: true })
  await fsp.writeFile(configPath, 'service_tier = "fast"\n', { mode: 0o600 })

  const result = await configureCodexLb({
    home,
    configPath,
    envPath,
    metadataPath,
    host: 'https://lb.fixture.internal',
    apiKey: 'replacement-key',
    writeEnvFile: true,
    storeKeychain: false,
    shellProfile: 'skip',
    syncLaunchEnv: false,
    toolOutputRecoveryFetch: compatibleFetch,
    testHooks: {
      beforeCenterSync: async () => {
        await fsp.writeFile(configPath, concurrentConfig, { mode: 0o640 })
        await fsp.chmod(configPath, 0o640)
        throw new Error('fixture failure after concurrent edit')
      }
    }
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'setup_failed_rollback_incomplete')
  assert.ok(result.rollback?.blockers.includes(`setup_rollback_conflict:${configPath}`))
  assert.equal(await fsp.readFile(configPath, 'utf8'), concurrentConfig)
  assert.equal((await fsp.stat(configPath)).mode & 0o777, 0o640)
})

test('post-Keychain Center failure restores files and process env with an explicit partial receipt', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-lb-setup-post-keychain-center-'))
  t.after(() => fsp.rm(home, { recursive: true, force: true }))
  const codexHome = path.join(home, '.codex')
  const configPath = path.join(codexHome, 'config.toml')
  const envPath = path.join(codexHome, 'sks-codex-lb.env')
  const metadataPath = path.join(codexHome, 'sks-codex-lb.json')
  const initialConfig = 'service_tier = "fast"\n'
  await fsp.mkdir(codexHome, { recursive: true })
  await fsp.writeFile(configPath, initialConfig, { mode: 0o600 })
  const priorBase = process.env.CODEX_LB_BASE_URL
  const priorKey = process.env.CODEX_LB_API_KEY
  process.env.CODEX_LB_BASE_URL = 'https://before.example/backend-api/codex'
  process.env.CODEX_LB_API_KEY = 'before-key'
  t.after(() => {
    if (priorBase === undefined) delete process.env.CODEX_LB_BASE_URL
    else process.env.CODEX_LB_BASE_URL = priorBase
    if (priorKey === undefined) delete process.env.CODEX_LB_API_KEY
    else process.env.CODEX_LB_API_KEY = priorKey
  })

  const result = await configureCodexLb({
    home,
    configPath,
    envPath,
    metadataPath,
    host: 'https://lb.fixture.internal',
    apiKey: 'replacement-key',
    writeEnvFile: true,
    storeKeychain: true,
    shellProfile: 'skip',
    forceMacos: true,
    keychainStoreImpl: keychainStoreSucceeded,
    toolOutputRecoveryFetch: compatibleFetch,
    testHooks: {
      readKeychainState: verifiedMissingKeychainState,
      beforeCenterSync: () => {
        throw new Error('fixture Center sync failure')
      }
    }
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'partial_configuration_keychain_retained')
  assert.equal(result.rollback?.ok, true)
  assert.equal(result.rollback?.keychain_retained, true)
  assert.equal((result as any).partial_configuration?.failure_stage, 'sync_center_desktop_credentials')
  assert.ok((result as any).partial_configuration?.recovery_actions.length > 0)
  assert.equal(await fsp.readFile(configPath, 'utf8'), initialConfig)
  assert.equal(await fsp.access(envPath).then(() => true, () => false), false)
  assert.equal(await fsp.access(metadataPath).then(() => true, () => false), false)
  assert.equal(process.env.CODEX_LB_BASE_URL, 'https://before.example/backend-api/codex')
  assert.equal(process.env.CODEX_LB_API_KEY, 'before-key')
  assert.deepEqual(await recoveryFilesContaining(result.rollback?.recovery_paths, 'replacement-key'), [])
})

test('rollback retains edits written through a descriptor opened before the guarded config rename', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-lb-setup-open-inode-'))
  t.after(() => fsp.rm(home, { recursive: true, force: true }))
  const codexHome = path.join(home, '.codex')
  const configPath = path.join(codexHome, 'config.toml')
  const envPath = path.join(codexHome, 'sks-codex-lb.env')
  const metadataPath = path.join(codexHome, 'sks-codex-lb.json')
  const initialConfig = 'service_tier = "fast"\n'
  const concurrentConfig = '# edit through pre-rename descriptor\nservice_tier = "priority"\n'
  await fsp.mkdir(codexHome, { recursive: true })
  await fsp.writeFile(configPath, initialConfig, { mode: 0o600 })
  const originalHandle = await fsp.open(configPath, 'r+')
  t.after(() => originalHandle.close().catch(() => {}))
  let injected = false

  const result = await configureCodexLb({
    home,
    configPath,
    envPath,
    metadataPath,
    host: 'https://lb.fixture.internal',
    apiKey: 'replacement-key',
    writeEnvFile: true,
    storeKeychain: true,
    shellProfile: 'skip',
    forceMacos: true,
    keychainStoreImpl: keychainStoreFailedVerified,
    toolOutputRecoveryFetch: compatibleFetch,
    testHooks: {
      readKeychainState: verifiedMissingKeychainState,
      beforeRollbackFileReplacement: async ({ path: target }: { path: string }) => {
        if (target !== configPath || injected) return
        injected = true
        await originalHandle.truncate(0)
        await originalHandle.writeFile(concurrentConfig)
        await originalHandle.sync()
      }
    }
  })

  assert.equal(injected, true)
  assert.equal(result.ok, false)
  assert.equal(result.status, 'keychain_store_failed_rolled_back')
  assert.equal(await fsp.readFile(configPath, 'utf8'), initialConfig)
  assert.equal(result.rollback?.config_backup_status, 'retained_for_recovery')
  assert.ok(result.rollback?.recovery_paths.includes(result.rollback.config_backup_path))
  assert.equal(
    await fsp.readFile(result.rollback?.config_backup_path, 'utf8'),
    concurrentConfig
  )
})

test('rollback retains edits through a descriptor opened on the committed config before rollback claims it', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-lb-setup-rollback-inode-'))
  t.after(() => fsp.rm(home, { recursive: true, force: true }))
  const codexHome = path.join(home, '.codex')
  const configPath = path.join(codexHome, 'config.toml')
  const envPath = path.join(codexHome, 'sks-codex-lb.env')
  const metadataPath = path.join(codexHome, 'sks-codex-lb.json')
  const initialConfig = 'service_tier = "fast"\n'
  const concurrentConfig = '# edit through rollback-claimed inode\nservice_tier = "priority"\n'
  await fsp.mkdir(codexHome, { recursive: true })
  await fsp.writeFile(configPath, initialConfig, { mode: 0o600 })
  let committedHandle: Awaited<ReturnType<typeof fsp.open>> | null = null
  let injected = false
  t.after(async () => committedHandle?.close().catch(() => {}))

  const result = await configureCodexLb({
    home,
    configPath,
    envPath,
    metadataPath,
    host: 'https://lb.fixture.internal',
    apiKey: 'replacement-key',
    writeEnvFile: true,
    storeKeychain: true,
    shellProfile: 'skip',
    forceMacos: true,
    keychainStoreImpl: keychainStoreFailedVerified,
    toolOutputRecoveryFetch: compatibleFetch,
    testHooks: {
      readKeychainState: verifiedMissingKeychainState,
      beforeRollbackStart: async () => {
        committedHandle = await fsp.open(configPath, 'r+')
      },
      beforeRollbackFileReplacement: async ({ path: target }: { path: string }) => {
        if (target !== configPath || !committedHandle || injected) return
        injected = true
        await committedHandle.truncate(0)
        await committedHandle.writeFile(concurrentConfig)
        await committedHandle.sync()
      }
    }
  })

  assert.equal(injected, true)
  assert.equal(result.ok, false)
  assert.equal(result.status, 'keychain_store_failed_rolled_back')
  assert.equal(await fsp.readFile(configPath, 'utf8'), initialConfig)
  const claimedRecoveryPath = result.rollback?.recovery_paths.find(
    (candidate: string) => candidate.startsWith(`${configPath}.sks-rollback-claimed-`)
  )
  assert.ok(claimedRecoveryPath)
  assert.equal(await fsp.readFile(claimedRecoveryPath, 'utf8'), concurrentConfig)
})

test('Keychain failure rollback preserves concurrent file and mode changes and retains recovery backup', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-lb-setup-rollback-conflict-'))
  t.after(() => fsp.rm(home, { recursive: true, force: true }))
  const codexHome = path.join(home, '.codex')
  const configPath = path.join(codexHome, 'config.toml')
  const envPath = path.join(codexHome, 'sks-codex-lb.env')
  const metadataPath = path.join(codexHome, 'sks-codex-lb.json')
  await fsp.mkdir(codexHome, { recursive: true })
  await fsp.writeFile(configPath, 'service_tier = "fast"\n', { mode: 0o600 })
  await fsp.writeFile(envPath, 'export PREVIOUS_ENV=1\n', { mode: 0o600 })
  await fsp.writeFile(metadataPath, '{"previous":true}\n', { mode: 0o600 })
  const concurrentConfig = '# concurrent user edit\nservice_tier = "fast"\n'

  const result = await configureCodexLb({
    home,
    configPath,
    envPath,
    metadataPath,
    host: 'https://lb.fixture.internal',
    apiKey: 'replacement-key',
    writeEnvFile: true,
    storeKeychain: true,
    shellProfile: 'skip',
    forceMacos: true,
    keychainStoreImpl: async () => {
      await fsp.writeFile(configPath, concurrentConfig)
      await fsp.chmod(envPath, 0o644)
      return keychainStoreFailedVerified()
    },
    toolOutputRecoveryFetch: compatibleFetch,
    testHooks: {
      readKeychainState: verifiedMissingKeychainState
    }
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'keychain_store_failed_rollback_incomplete')
  assert.ok(result.rollback?.blockers.includes(`setup_rollback_conflict:${configPath}`))
  assert.ok(result.rollback?.blockers.includes('setup_rollback_state_verification_failed'))
  assert.equal(await fsp.readFile(configPath, 'utf8'), concurrentConfig)
  assert.equal((await fsp.stat(envPath)).mode & 0o777, 0o644)
  assert.equal(result.rollback?.config_backup_status, 'retained_for_recovery')
  assert.equal(await fsp.access(result.rollback?.config_backup_path).then(() => true, () => false), true)
})

test('initial config commit fails closed when the user edits after setup reads the file', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-lb-setup-initial-cas-'))
  t.after(() => fsp.rm(home, { recursive: true, force: true }))
  const codexHome = path.join(home, '.codex')
  const configPath = path.join(codexHome, 'config.toml')
  const envPath = path.join(codexHome, 'sks-codex-lb.env')
  const metadataPath = path.join(codexHome, 'sks-codex-lb.json')
  await fsp.mkdir(codexHome, { recursive: true })
  await fsp.writeFile(configPath, 'service_tier = "fast"\n', { mode: 0o600 })
  const concurrentConfig = '# concurrent initial edit\nservice_tier = "priority"\n'

  const result = await configureCodexLb({
    home,
    configPath,
    envPath,
    metadataPath,
    host: 'https://lb.fixture.internal',
    apiKey: 'replacement-key',
    writeEnvFile: true,
    storeKeychain: false,
    shellProfile: 'skip',
    toolOutputRecoveryFetch: compatibleFetch,
    testHooks: {
      beforeInitialConfigWrite: async () => {
        await fsp.writeFile(configPath, concurrentConfig, { mode: 0o640 })
        await fsp.chmod(configPath, 0o640)
      }
    }
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'concurrent_change_detected')
  assert.equal(await fsp.readFile(configPath, 'utf8'), concurrentConfig)
  assert.equal((await fsp.stat(configPath)).mode & 0o777, 0o640)
  assert.equal(await fsp.access(envPath).then(() => true, () => false), false)
  assert.equal(await fsp.access(metadataPath).then(() => true, () => false), false)
})

test('setup binds mutation and rollback to the same captured config bytes', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-lb-setup-snapshot-bytes-'))
  t.after(() => fsp.rm(home, { recursive: true, force: true }))
  const codexHome = path.join(home, '.codex')
  const configPath = path.join(codexHome, 'config.toml')
  const envPath = path.join(codexHome, 'sks-codex-lb.env')
  const metadataPath = path.join(codexHome, 'sks-codex-lb.json')
  const initialConfig = 'service_tier = "fast"\n'
  const concurrentConfig = '# edit after setup snapshot\nservice_tier = "priority"\n'
  await fsp.mkdir(codexHome, { recursive: true })
  await fsp.writeFile(configPath, initialConfig, { mode: 0o600 })

  const result = await configureCodexLb({
    home,
    configPath,
    envPath,
    metadataPath,
    host: 'https://lb.fixture.internal',
    apiKey: 'replacement-key',
    writeEnvFile: true,
    storeKeychain: false,
    shellProfile: 'skip',
    toolOutputRecoveryFetch: compatibleFetch,
    testHooks: {
      afterBeforeStateCapture: async () => {
        await fsp.writeFile(configPath, concurrentConfig, { mode: 0o640 })
        await fsp.chmod(configPath, 0o640)
      }
    }
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'concurrent_change_detected')
  assert.equal(await fsp.readFile(configPath, 'utf8'), concurrentConfig)
  assert.equal((await fsp.stat(configPath)).mode & 0o777, 0o640)
  assert.equal(await fsp.access(envPath).then(() => true, () => false), false)
  assert.equal(await fsp.access(metadataPath).then(() => true, () => false), false)
})

test('setup CAS rejects a mode-only change after its authoritative snapshot', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-lb-setup-snapshot-mode-'))
  t.after(() => fsp.rm(home, { recursive: true, force: true }))
  const codexHome = path.join(home, '.codex')
  const configPath = path.join(codexHome, 'config.toml')
  const envPath = path.join(codexHome, 'sks-codex-lb.env')
  const metadataPath = path.join(codexHome, 'sks-codex-lb.json')
  const initialConfig = 'service_tier = "fast"\n'
  await fsp.mkdir(codexHome, { recursive: true })
  await fsp.writeFile(configPath, initialConfig, { mode: 0o600 })

  const result = await configureCodexLb({
    home,
    configPath,
    envPath,
    metadataPath,
    host: 'https://lb.fixture.internal',
    apiKey: 'replacement-key',
    writeEnvFile: true,
    storeKeychain: false,
    shellProfile: 'skip',
    toolOutputRecoveryFetch: compatibleFetch,
    testHooks: {
      afterBeforeStateCapture: async () => {
        await fsp.chmod(configPath, 0o640)
      }
    }
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'concurrent_change_detected')
  assert.equal(await fsp.readFile(configPath, 'utf8'), initialConfig)
  assert.equal((await fsp.stat(configPath)).mode & 0o777, 0o640)
  assert.equal(await fsp.access(envPath).then(() => true, () => false), false)
  assert.equal(await fsp.access(metadataPath).then(() => true, () => false), false)
})

test('rollback no-replace boundary preserves a concurrent config replacement and its mode', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-lb-setup-final-cas-'))
  t.after(() => fsp.rm(home, { recursive: true, force: true }))
  const codexHome = path.join(home, '.codex')
  const configPath = path.join(codexHome, 'config.toml')
  const envPath = path.join(codexHome, 'sks-codex-lb.env')
  const metadataPath = path.join(codexHome, 'sks-codex-lb.json')
  await fsp.mkdir(codexHome, { recursive: true })
  await fsp.writeFile(configPath, 'service_tier = "fast"\n', { mode: 0o600 })
  const concurrentConfig = '# concurrent final-boundary edit\nservice_tier = "priority"\n'
  let injected = false

  const result = await configureCodexLb({
    home,
    configPath,
    envPath,
    metadataPath,
    host: 'https://lb.fixture.internal',
    apiKey: 'replacement-key',
    writeEnvFile: true,
    storeKeychain: true,
    shellProfile: 'skip',
    forceMacos: true,
    keychainStoreImpl: keychainStoreFailedVerified,
    toolOutputRecoveryFetch: compatibleFetch,
    testHooks: {
      readKeychainState: verifiedMissingKeychainState,
      beforeRollbackFileReplacement: async ({ path: target }: { path: string }) => {
        if (target !== configPath || injected) return
        injected = true
        await fsp.writeFile(configPath, concurrentConfig, { mode: 0o640 })
      }
    }
  })

  assert.equal(injected, true)
  assert.equal(result.ok, false)
  assert.equal(result.status, 'keychain_store_failed_rollback_incomplete')
  assert.ok(result.rollback?.blockers.includes(`setup_rollback_conflict:${configPath}`))
  assert.equal(await fsp.readFile(configPath, 'utf8'), concurrentConfig)
  assert.equal((await fsp.stat(configPath)).mode & 0o777, 0o640)
  assert.equal(result.rollback?.config_backup_status, 'retained_for_recovery')
  assert.ok(result.rollback?.recovery_paths.includes(result.rollback.config_backup_path))
  assert.equal(await fsp.access(result.rollback?.config_backup_path).then(() => true, () => false), true)
})

test('Keychain failure leaves process environment untouched and no plaintext replacement-key recovery file', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-lb-setup-env-cas-'))
  t.after(() => fsp.rm(home, { recursive: true, force: true }))
  const codexHome = path.join(home, '.codex')
  const configPath = path.join(codexHome, 'config.toml')
  const envPath = path.join(codexHome, 'sks-codex-lb.env')
  const metadataPath = path.join(codexHome, 'sks-codex-lb.json')
  await fsp.mkdir(codexHome, { recursive: true })
  await fsp.writeFile(configPath, 'service_tier = "fast"\n', { mode: 0o600 })
  const priorBase = process.env.CODEX_LB_BASE_URL
  const priorKey = process.env.CODEX_LB_API_KEY
  process.env.CODEX_LB_BASE_URL = 'https://before.example/backend-api/codex'
  process.env.CODEX_LB_API_KEY = 'before-key'
  t.after(() => {
    if (priorBase === undefined) delete process.env.CODEX_LB_BASE_URL
    else process.env.CODEX_LB_BASE_URL = priorBase
    if (priorKey === undefined) delete process.env.CODEX_LB_API_KEY
    else process.env.CODEX_LB_API_KEY = priorKey
  })

  const result = await configureCodexLb({
    home,
    configPath,
    envPath,
    metadataPath,
    host: 'https://lb.fixture.internal',
    apiKey: 'replacement-key',
    writeEnvFile: true,
    storeKeychain: true,
    shellProfile: 'skip',
    forceMacos: true,
    keychainStoreImpl: keychainStoreFailedVerified,
    toolOutputRecoveryFetch: compatibleFetch,
    testHooks: {
      readKeychainState: verifiedMissingKeychainState
    }
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'keychain_store_failed_rolled_back')
  assert.deepEqual(result.rollback?.blockers, [])
  assert.equal(process.env.CODEX_LB_BASE_URL, 'https://before.example/backend-api/codex')
  assert.equal(process.env.CODEX_LB_API_KEY, 'before-key')
  assert.equal(await fsp.access(envPath).then(() => true, () => false), false)
  assert.deepEqual(await recoveryFilesContaining(result.rollback?.recovery_paths, 'replacement-key'), [])
  assert.equal(result.rollback?.config_backup_status, 'retained_for_recovery')
  assert.ok(result.rollback?.recovery_paths.includes(result.rollback.config_backup_path))
  assert.equal(await fsp.access(result.rollback?.config_backup_path).then(() => true, () => false), true)
})

test('setup refuses symlink mutation targets before changing config or the symlink target', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-lb-setup-symlink-'))
  t.after(() => fsp.rm(home, { recursive: true, force: true }))
  const codexHome = path.join(home, '.codex')
  const configPath = path.join(codexHome, 'config.toml')
  const envPath = path.join(codexHome, 'sks-codex-lb.env')
  const metadataPath = path.join(codexHome, 'sks-codex-lb.json')
  const userTarget = path.join(home, 'user-env')
  const initialConfig = 'service_tier = "fast"\n'
  const initialTarget = 'user-owned\n'
  await fsp.mkdir(codexHome, { recursive: true })
  await fsp.writeFile(configPath, initialConfig, { mode: 0o600 })
  await fsp.writeFile(userTarget, initialTarget, { mode: 0o640 })
  await fsp.symlink(userTarget, envPath)

  const result = await configureCodexLb({
    home,
    configPath,
    envPath,
    metadataPath,
    host: 'https://lb.fixture.internal',
    apiKey: 'replacement-key',
    writeEnvFile: true,
    storeKeychain: false,
    shellProfile: 'skip',
    toolOutputRecoveryFetch: compatibleFetch
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'unsafe_setup_write_target')
  assert.ok(result.drift?.includes(`unsafe_setup_write_target:${envPath}:symlink`))
  assert.equal(await fsp.readFile(configPath, 'utf8'), initialConfig)
  assert.equal(await fsp.readlink(envPath), userTarget)
  assert.equal(await fsp.readFile(userTarget, 'utf8'), initialTarget)
  assert.equal(await fsp.access(metadataPath).then(() => true, () => false), false)
})

test('metadata write CAS preserves a concurrent edit made after the setup snapshot', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-lb-setup-metadata-cas-'))
  t.after(() => fsp.rm(home, { recursive: true, force: true }))
  const codexHome = path.join(home, '.codex')
  const configPath = path.join(codexHome, 'config.toml')
  const envPath = path.join(codexHome, 'sks-codex-lb.env')
  const metadataPath = path.join(codexHome, 'sks-codex-lb.json')
  const initialConfig = 'service_tier = "fast"\n'
  const concurrentMetadata = '{"concurrent":"metadata edit"}\n'
  await fsp.mkdir(codexHome, { recursive: true })
  await fsp.writeFile(configPath, initialConfig, { mode: 0o600 })
  await fsp.writeFile(metadataPath, '{"previous":true}\n', { mode: 0o600 })

  const result = await configureCodexLb({
    home,
    configPath,
    envPath,
    metadataPath,
    host: 'https://lb.fixture.internal',
    apiKey: 'replacement-key',
    writeEnvFile: false,
    storeKeychain: false,
    shellProfile: 'skip',
    syncLaunchEnv: false,
    toolOutputRecoveryFetch: compatibleFetch,
    testHooks: {
      beforeMetadataWrite: async () => {
        await fsp.writeFile(metadataPath, concurrentMetadata, { mode: 0o640 })
        await fsp.chmod(metadataPath, 0o640)
      }
    }
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'setup_failed_rollback_incomplete')
  assert.match(String(result.error), /concurrent_change_detected/)
  assert.equal(await fsp.readFile(configPath, 'utf8'), initialConfig)
  assert.equal(await fsp.readFile(metadataPath, 'utf8'), concurrentMetadata)
  assert.equal((await fsp.stat(metadataPath)).mode & 0o777, 0o640)
  assert.equal(await fsp.access(envPath).then(() => true, () => false), false)
})

test('metadata write no-replace boundary preserves a concurrent replacement after the claim', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-lb-setup-metadata-final-cas-'))
  t.after(() => fsp.rm(home, { recursive: true, force: true }))
  const codexHome = path.join(home, '.codex')
  const configPath = path.join(codexHome, 'config.toml')
  const envPath = path.join(codexHome, 'sks-codex-lb.env')
  const metadataPath = path.join(codexHome, 'sks-codex-lb.json')
  const initialConfig = 'service_tier = "fast"\n'
  const initialMetadata = '{"previous":true}\n'
  const concurrentMetadata = '{"concurrent":"final boundary"}\n'
  await fsp.mkdir(codexHome, { recursive: true })
  await fsp.writeFile(configPath, initialConfig, { mode: 0o600 })
  await fsp.writeFile(metadataPath, initialMetadata, { mode: 0o644 })

  const result = await configureCodexLb({
    home,
    configPath,
    envPath,
    metadataPath,
    host: 'https://lb.fixture.internal',
    apiKey: 'replacement-key',
    writeEnvFile: false,
    storeKeychain: false,
    shellProfile: 'skip',
    syncLaunchEnv: false,
    toolOutputRecoveryFetch: compatibleFetch,
    testHooks: {
      beforeSetupFileReplacement: async ({ path: target }: { path: string }) => {
        if (target !== metadataPath) return
        await fsp.writeFile(metadataPath, concurrentMetadata, { mode: 0o640 })
        await fsp.chmod(metadataPath, 0o640)
      }
    }
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'setup_failed_rollback_incomplete')
  assert.match(String(result.error), /concurrent_change_detected/)
  assert.equal(await fsp.readFile(configPath, 'utf8'), initialConfig)
  assert.equal(await fsp.readFile(metadataPath, 'utf8'), concurrentMetadata)
  assert.equal((await fsp.stat(metadataPath)).mode & 0o777, 0o640)
  const claimedRecovery = result.rollback?.recovery_paths.find(
    (candidate: string) => candidate.startsWith(`${metadataPath}.sks-setup-claimed-`)
  )
  assert.ok(claimedRecovery)
  assert.equal(await fsp.readFile(claimedRecovery, 'utf8'), initialMetadata)
  assert.equal((await fsp.stat(claimedRecovery)).mode & 0o777, 0o600)
})

test('env-file write CAS preserves a concurrent edit made after the setup snapshot', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-lb-setup-env-write-cas-'))
  t.after(() => fsp.rm(home, { recursive: true, force: true }))
  const codexHome = path.join(home, '.codex')
  const configPath = path.join(codexHome, 'config.toml')
  const envPath = path.join(codexHome, 'sks-codex-lb.env')
  const metadataPath = path.join(codexHome, 'sks-codex-lb.json')
  const initialConfig = 'service_tier = "fast"\n'
  const initialMetadata = '{"previous":true}\n'
  const concurrentEnv = 'export USER_CONCURRENT_VALUE=1\n'
  await fsp.mkdir(codexHome, { recursive: true })
  await fsp.writeFile(configPath, initialConfig, { mode: 0o600 })
  await fsp.writeFile(metadataPath, initialMetadata, { mode: 0o600 })
  await fsp.writeFile(envPath, 'export PREVIOUS_ENV=1\n', { mode: 0o600 })

  const result = await configureCodexLb({
    home,
    configPath,
    envPath,
    metadataPath,
    host: 'https://lb.fixture.internal',
    apiKey: 'replacement-key',
    writeEnvFile: true,
    storeKeychain: false,
    shellProfile: 'skip',
    syncLaunchEnv: false,
    toolOutputRecoveryFetch: compatibleFetch,
    testHooks: {
      beforeEnvWrite: async () => {
        await fsp.writeFile(envPath, concurrentEnv, { mode: 0o640 })
        await fsp.chmod(envPath, 0o640)
      }
    }
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'setup_failed_rollback_incomplete')
  assert.match(String(result.error), /concurrent_change_detected/)
  assert.equal(await fsp.readFile(configPath, 'utf8'), initialConfig)
  assert.equal(await fsp.readFile(metadataPath, 'utf8'), initialMetadata)
  assert.equal(await fsp.readFile(envPath, 'utf8'), concurrentEnv)
  assert.equal((await fsp.stat(envPath)).mode & 0o777, 0o640)
})

test('explicit setup commits the owner-only replacement before removing and verifying the legacy Keychain item', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-lb-setup-legacy-keychain-migration-'))
  t.after(() => fsp.rm(home, { recursive: true, force: true }))
  const codexHome = path.join(home, '.codex')
  const configPath = path.join(codexHome, 'config.toml')
  const envPath = path.join(codexHome, 'sks-codex-lb.env')
  const metadataPath = path.join(codexHome, 'sks-codex-lb.json')
  const calls: string[][] = []
  await fsp.mkdir(codexHome, { recursive: true })
  await fsp.writeFile(configPath, 'service_tier = "fast"\n', { mode: 0o600 })
  const priorBase = process.env.CODEX_LB_BASE_URL
  const priorKey = process.env.CODEX_LB_API_KEY
  t.after(() => {
    if (priorBase === undefined) delete process.env.CODEX_LB_BASE_URL
    else process.env.CODEX_LB_BASE_URL = priorBase
    if (priorKey === undefined) delete process.env.CODEX_LB_API_KEY
    else process.env.CODEX_LB_API_KEY = priorKey
  })

  const result = await configureCodexLb({
    home,
    configPath,
    envPath,
    metadataPath,
    host: 'https://lb.fixture.internal',
    apiKey: 'replacement-key',
    writeEnvFile: true,
    storeKeychain: false,
    shellProfile: 'skip',
    platform: 'darwin',
    securityBin: '/fixture/security',
    syncLaunchEnv: false,
    toolOutputRecoveryFetch: compatibleFetch,
    runProcessImpl: async (_bin: string, args: string[]) => {
      calls.push([...args])
      if (args[0] === 'delete-generic-password') {
        assert.equal((await fsp.stat(envPath)).mode & 0o777, 0o600)
        assert.match(await fsp.readFile(envPath, 'utf8'), /replacement-key/)
        return { code: 0, stdout: '', stderr: '' } as any
      }
      if (args[0] === 'find-generic-password') {
        return {
          code: 44,
          stdout: '',
          stderr: 'The specified item could not be found in the keychain.'
        } as any
      }
      return { code: 0, stdout: '', stderr: '' } as any
    }
  })

  assert.equal(result.ok, true)
  assert.equal((result as any).legacy_keychain_cleanup?.status, 'legacy_keychain_removed')
  assert.deepEqual((result as any).legacy_keychain_cleanup?.keychain_cleared, ['sks-codex-lb'])
  assert.deepEqual(calls.map((args) => args[0]), [
    'delete-generic-password',
    'find-generic-password'
  ])
})

test('explicit setup does not claim success when the replacement store changes before legacy Keychain cleanup', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-lb-setup-legacy-keychain-replacement-drift-'))
  t.after(() => fsp.rm(home, { recursive: true, force: true }))
  const codexHome = path.join(home, '.codex')
  const configPath = path.join(codexHome, 'config.toml')
  const envPath = path.join(codexHome, 'sks-codex-lb.env')
  const metadataPath = path.join(codexHome, 'sks-codex-lb.json')
  const calls: string[][] = []
  await fsp.mkdir(codexHome, { recursive: true })
  await fsp.writeFile(configPath, 'service_tier = "fast"\n', { mode: 0o600 })
  const priorBase = process.env.CODEX_LB_BASE_URL
  const priorKey = process.env.CODEX_LB_API_KEY
  t.after(() => {
    if (priorBase === undefined) delete process.env.CODEX_LB_BASE_URL
    else process.env.CODEX_LB_BASE_URL = priorBase
    if (priorKey === undefined) delete process.env.CODEX_LB_API_KEY
    else process.env.CODEX_LB_API_KEY = priorKey
  })

  const result = await configureCodexLb({
    home,
    configPath,
    envPath,
    metadataPath,
    host: 'https://lb.fixture.internal',
    apiKey: 'replacement-key',
    writeEnvFile: true,
    storeKeychain: false,
    shellProfile: 'skip',
    platform: 'darwin',
    securityBin: '/fixture/security',
    syncLaunchEnv: false,
    toolOutputRecoveryFetch: compatibleFetch,
    testHooks: {
      beforeLegacyKeychainCleanup: async () => {
        await fsp.writeFile(
          envPath,
          "export CODEX_LB_BASE_URL='https://lb.fixture.internal/backend-api/codex'\nexport CODEX_LB_API_KEY='concurrent-replacement-key'\n",
          { mode: 0o600 }
        )
      }
    },
    runProcessImpl: async (_bin: string, args: string[]) => {
      calls.push([...args])
      return {
        code: 44,
        stdout: '',
        stderr: 'The specified item could not be found in the keychain.'
      } as any
    }
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'legacy_keychain_cleanup_failed_secure_store_retained')
  assert.equal(
    (result as any).legacy_keychain_cleanup?.status,
    'legacy_keychain_cleanup_blocked_replacement_store_unverified'
  )
  assert.equal((result as any).legacy_keychain_cleanup?.replacement_store_verified, false)
  assert.ok((result.warnings || []).includes('legacy_keychain_cleanup_indeterminate_rotate_provider_key'))
  assert.equal((await fsp.stat(envPath)).mode & 0o777, 0o600)
  assert.match(await fsp.readFile(envPath, 'utf8'), /concurrent-replacement-key/)
  assert.ok(calls.some((args) => args[0] === 'find-generic-password'))
  assert.ok(!calls.some((args) => args[0] === 'delete-generic-password'))
})

test('shell-profile write CAS preserves a concurrent edit made after the setup snapshot', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-lb-setup-profile-cas-'))
  t.after(() => fsp.rm(home, { recursive: true, force: true }))
  const codexHome = path.join(home, '.codex')
  const configPath = path.join(codexHome, 'config.toml')
  const envPath = path.join(codexHome, 'sks-codex-lb.env')
  const metadataPath = path.join(codexHome, 'sks-codex-lb.json')
  const zshPath = path.join(home, '.zshrc')
  const initialConfig = 'service_tier = "fast"\n'
  const concurrentProfile = '# concurrent shell profile edit\nexport USER_FLAG=1\n'
  await fsp.mkdir(codexHome, { recursive: true })
  await fsp.writeFile(configPath, initialConfig, { mode: 0o600 })
  await fsp.writeFile(zshPath, '# initial shell profile\n', { mode: 0o644 })
  const priorBase = process.env.CODEX_LB_BASE_URL
  const priorKey = process.env.CODEX_LB_API_KEY
  t.after(() => {
    if (priorBase === undefined) delete process.env.CODEX_LB_BASE_URL
    else process.env.CODEX_LB_BASE_URL = priorBase
    if (priorKey === undefined) delete process.env.CODEX_LB_API_KEY
    else process.env.CODEX_LB_API_KEY = priorKey
  })

  const result = await configureCodexLb({
    home,
    configPath,
    envPath,
    metadataPath,
    host: 'https://lb.fixture.internal',
    apiKey: 'replacement-key',
    writeEnvFile: true,
    storeKeychain: false,
    shellProfile: 'zsh',
    syncLaunchEnv: false,
    toolOutputRecoveryFetch: compatibleFetch,
    testHooks: {
      beforeShellProfileWrite: async ({ file }: { file: string }) => {
        assert.equal(file, zshPath)
        await fsp.writeFile(zshPath, concurrentProfile, { mode: 0o640 })
        await fsp.chmod(zshPath, 0o640)
      }
    }
  })

  assert.equal(result.ok, false)
  assert.equal(result.status, 'partial_configuration_external_state_unknown')
  assert.match(String(result.error), /concurrent_change_detected/)
  assert.equal(await fsp.readFile(configPath, 'utf8'), initialConfig)
  assert.equal(await fsp.readFile(zshPath, 'utf8'), concurrentProfile)
  assert.equal((await fsp.stat(zshPath)).mode & 0o777, 0o640)
  assert.equal(await fsp.access(envPath).then(() => true, () => false), false)
  assert.equal(await fsp.access(metadataPath).then(() => true, () => false), false)
})
