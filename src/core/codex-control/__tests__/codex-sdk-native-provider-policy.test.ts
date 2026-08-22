import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildCodexSdkConfig } from '../codex-sdk-config-policy.js'
import { buildCodexSdkEnv, prepareNativeCodexAuthBridge } from '../codex-sdk-env-policy.js'
import type { CodexTaskInput } from '../codex-control-plane.js'

test('Codex SDK bridges native auth without inheriting ambient codex-lb or user config', async () => {
  const previous = new Map([
    ['CODEX_HOME', process.env.CODEX_HOME],
    ['CODEX_LB_API_KEY', process.env.CODEX_LB_API_KEY],
    ['CODEX_LB_BASE_URL', process.env.CODEX_LB_BASE_URL]
  ])
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-native-provider-policy-'))
  const nativeCodexHome = path.join(root, 'native-codex-home')
  let bridge: Awaited<ReturnType<typeof prepareNativeCodexAuthBridge>> | null = null
  try {
    await fsp.mkdir(nativeCodexHome, { recursive: true, mode: 0o700 })
    const sourceAuthPath = path.join(nativeCodexHome, 'auth.json')
    await fsp.writeFile(sourceAuthPath, `${JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: 'proxy-key-must-not-cross',
      apiKey: 'legacy-proxy-key-must-not-cross',
      tokens: {
        access_token: 'oauth-access-fixture',
        refresh_token: 'oauth-refresh-fixture',
        id_token: 'oauth-id-fixture'
      }
    })}\n`, { mode: 0o600 })
    await fsp.writeFile(path.join(nativeCodexHome, 'config.toml'), '[mcp_servers.host-only]\ncommand = "forbidden"\n')
    process.env.CODEX_HOME = nativeCodexHome
    process.env.CODEX_LB_API_KEY = 'fixture-secret'
    process.env.CODEX_LB_BASE_URL = 'https://lb.example.test/backend-api/codex'
    const input = taskInput(root)
    const config = buildCodexSdkConfig(input)
    const env = buildCodexSdkEnv(input)
    const workspaceHome = String(env.env.HOME)
    const workspaceCodexHome = String(env.env.CODEX_HOME)
    bridge = await prepareNativeCodexAuthBridge(env.env)
    const isolatedCodexHome = String(env.env.CODEX_HOME)
    const isolatedHome = String(env.env.HOME)
    const tempRoot = path.dirname(isolatedCodexHome)
    const isolatedAuthPath = path.join(isolatedCodexHome, 'auth.json')

    assert.equal(config.model_provider, 'openai')
    assert.equal(config.forced_login_method, 'chatgpt')
    assert.equal('model_providers' in config, false)
    assert.notEqual(isolatedCodexHome, nativeCodexHome)
    assert.notEqual(isolatedCodexHome, workspaceCodexHome)
    assert.notEqual(isolatedHome, workspaceHome)
    assert.notEqual(env.env.HOME, process.env.HOME)
    assert.equal(path.dirname(isolatedHome), tempRoot)
    assert.equal(path.relative(root, tempRoot).startsWith('..'), true)
    assert.equal('CODEX_LB_API_KEY' in env.env, false)
    assert.equal('CODEX_LB_BASE_URL' in env.env, false)
    assert.equal(env.proof.native_codex_only, true)
    assert.equal(env.proof.codex_home_isolated, true)
    assert.equal(env.proof.home_isolated, true)
    assert.equal(bridge.ok, true)
    assert.equal(bridge.proof.status, 'ready')
    assert.equal(bridge.proof.method, 'exclusive_copy')
    const copiedAuth = JSON.parse(await fsp.readFile(isolatedAuthPath, 'utf8'))
    assert.equal(copiedAuth.auth_mode, 'chatgpt')
    assert.equal(copiedAuth.tokens.access_token, 'oauth-access-fixture')
    assert.equal('OPENAI_API_KEY' in copiedAuth, false)
    assert.equal('apiKey' in copiedAuth, false)
    const sourceStat = await fsp.stat(sourceAuthPath)
    const copiedStat = await fsp.lstat(isolatedAuthPath)
    assert.equal(copiedStat.isFile(), true)
    assert.equal(copiedStat.isSymbolicLink(), false)
    assert.equal(copiedStat.nlink, 1)
    assert.notDeepEqual([copiedStat.dev, copiedStat.ino], [sourceStat.dev, sourceStat.ino])
    if (process.platform !== 'win32') {
      assert.equal((await fsp.stat(tempRoot)).mode & 0o777, 0o700)
      assert.equal((await fsp.stat(isolatedHome)).mode & 0o777, 0o700)
      assert.equal((await fsp.stat(isolatedCodexHome)).mode & 0o777, 0o700)
      assert.equal(copiedStat.mode & 0o777, 0o600)
    }
    await fsp.writeFile(sourceAuthPath, '{"auth_mode":"apikey","OPENAI_API_KEY":"changed"}\n', { mode: 0o600 })
    assert.equal(JSON.parse(await fsp.readFile(isolatedAuthPath, 'utf8')).tokens.access_token, 'oauth-access-fixture')
    await assert.rejects(fsp.stat(path.join(isolatedCodexHome, 'config.toml')))
    assert.deepEqual(await fsp.readdir(isolatedCodexHome), ['auth.json'])
    const cleanup = await bridge.cleanup()
    assert.equal(cleanup.ok, true)
    assert.equal(cleanup.outcome, 'unchanged')
    assert.equal(bridge.proof.cleanup_status, 'cleaned')
    assert.equal(bridge.proof.cleanup_outcome, 'unchanged')
    await assert.rejects(fsp.stat(tempRoot))
    await bridge.cleanup()
    bridge = null
    await assert.rejects(fsp.stat(workspaceHome))
    await assert.rejects(fsp.stat(workspaceCodexHome))
  } finally {
    await bridge?.cleanup()
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('Codex SDK uses the preserved ChatGPT OAuth backup while codex-lb API-key auth stays active', async () => {
  const previousCodexHome = process.env.CODEX_HOME
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-native-provider-oauth-backup-'))
  const nativeCodexHome = path.join(root, 'native-codex-home')
  let bridge: Awaited<ReturnType<typeof prepareNativeCodexAuthBridge>> | null = null
  try {
    await fsp.mkdir(nativeCodexHome, { mode: 0o700 })
    const primaryAuthPath = path.join(nativeCodexHome, 'auth.json')
    const backupAuthPath = path.join(nativeCodexHome, 'auth.chatgpt-backup.json')
    await fsp.writeFile(primaryAuthPath, `${JSON.stringify({
      auth_mode: 'apikey',
      OPENAI_API_KEY: 'codex-lb-key-fixture'
    })}\n`, { mode: 0o600 })
    await fsp.writeFile(backupAuthPath, `${JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: 'backup-host-only-key',
      tokens: {
        access_token: 'oauth-access-fixture',
        refresh_token: 'oauth-refresh-fixture',
        id_token: 'oauth-id-fixture'
      }
    })}\n`, { mode: 0o600 })
    process.env.CODEX_HOME = nativeCodexHome
    const env = buildCodexSdkEnv(taskInput(root))
    bridge = await prepareNativeCodexAuthBridge(env.env)

    assert.equal(bridge.ok, true)
    assert.equal(bridge.proof.status, 'ready')
    assert.equal(bridge.proof.source, 'host_codex_home/auth.chatgpt-backup.json')
    assert.equal(bridge.proof.oauth_backup_used, true)
    assert.equal(bridge.proof.primary_auth_status, 'api_key')
    assert.equal(bridge.proof.active_api_key_auth_preserved, true)
    const tempAuthPath = path.join(String(env.env.CODEX_HOME), 'auth.json')
    const tempAuth = JSON.parse(await fsp.readFile(tempAuthPath, 'utf8'))
    assert.equal(tempAuth.auth_mode, 'chatgpt')
    assert.equal(tempAuth.tokens.access_token, 'oauth-access-fixture')
    assert.equal('OPENAI_API_KEY' in tempAuth, false)

    tempAuth.tokens = {
      access_token: 'refreshed-access-fixture',
      refresh_token: 'refreshed-refresh-fixture',
      id_token: 'refreshed-id-fixture'
    }
    await fsp.writeFile(tempAuthPath, `${JSON.stringify(tempAuth, null, 2)}\n`, { mode: 0o600 })
    const cleanup = await bridge.cleanup()
    bridge = null

    assert.equal(cleanup.ok, true)
    assert.equal(cleanup.outcome, 'refreshed_persisted')
    const primaryAfter = JSON.parse(await fsp.readFile(primaryAuthPath, 'utf8'))
    const backupAfter = JSON.parse(await fsp.readFile(backupAuthPath, 'utf8'))
    assert.equal(primaryAfter.auth_mode, 'apikey')
    assert.equal(primaryAfter.OPENAI_API_KEY, 'codex-lb-key-fixture')
    assert.equal('tokens' in primaryAfter, false)
    assert.equal(backupAfter.auth_mode, 'chatgpt')
    assert.equal(backupAfter.tokens.access_token, 'refreshed-access-fixture')
    assert.equal(backupAfter.OPENAI_API_KEY, 'backup-host-only-key')
  } finally {
    await bridge?.cleanup()
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousCodexHome
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('Codex SDK uses the preserved ChatGPT OAuth backup when primary auth is absent', async () => {
  const previousCodexHome = process.env.CODEX_HOME
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-native-provider-oauth-backup-only-'))
  const nativeCodexHome = path.join(root, 'native-codex-home')
  let bridge: Awaited<ReturnType<typeof prepareNativeCodexAuthBridge>> | null = null
  try {
    await fsp.mkdir(nativeCodexHome, { mode: 0o700 })
    const primaryAuthPath = path.join(nativeCodexHome, 'auth.json')
    const backupAuthPath = path.join(nativeCodexHome, 'auth.chatgpt-backup.json')
    await fsp.writeFile(backupAuthPath, `${JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: 'oauth-access-fixture',
        refresh_token: 'oauth-refresh-fixture'
      }
    })}\n`, { mode: 0o600 })
    process.env.CODEX_HOME = nativeCodexHome
    const env = buildCodexSdkEnv(taskInput(root))
    bridge = await prepareNativeCodexAuthBridge(env.env)

    assert.equal(bridge.ok, true)
    assert.equal(bridge.proof.source, 'host_codex_home/auth.chatgpt-backup.json')
    assert.equal(bridge.proof.oauth_backup_used, true)
    assert.equal(bridge.proof.primary_auth_status, 'missing')
    assert.equal(bridge.proof.active_api_key_auth_preserved, false)
    assert.equal(JSON.parse(await fsp.readFile(path.join(String(env.env.CODEX_HOME), 'auth.json'), 'utf8')).auth_mode, 'chatgpt')
    const cleanup = await bridge.cleanup()
    bridge = null

    assert.equal(cleanup.ok, true)
    assert.equal(cleanup.outcome, 'unchanged')
    await assert.rejects(fsp.lstat(primaryAuthPath), { code: 'ENOENT' })
    assert.equal(JSON.parse(await fsp.readFile(backupAuthPath, 'utf8')).auth_mode, 'chatgpt')
  } finally {
    await bridge?.cleanup()
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousCodexHome
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('Codex SDK blocks API-key and tokenless auth in native-only mode', async () => {
  const previousCodexHome = process.env.CODEX_HOME
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-native-provider-apikey-'))
  const nativeCodexHome = path.join(root, 'native-codex-home')
  try {
    await fsp.mkdir(nativeCodexHome, { mode: 0o700 })
    process.env.CODEX_HOME = nativeCodexHome
    const cases = [
      {
        auth: { auth_mode: 'apikey', OPENAI_API_KEY: 'proxy-key-fixture' },
        blocker: /native_codex_auth_api_key_forbidden/
      },
      {
        auth: { auth_mode: 'browser' },
        blocker: /native_codex_auth_mode_unsupported/
      }
    ]
    for (const item of cases) {
      await fsp.writeFile(path.join(nativeCodexHome, 'auth.json'), JSON.stringify(item.auth), { mode: 0o600 })
      const env = buildCodexSdkEnv(taskInput(root))
      const originalHome = env.env.HOME
      const originalCodexHome = env.env.CODEX_HOME
      const bridge = await prepareNativeCodexAuthBridge(env.env)

      assert.equal(bridge.ok, false)
      assert.match(bridge.blockers.join('\n'), item.blocker)
      assert.equal(env.env.HOME, originalHome)
      assert.equal(env.env.CODEX_HOME, originalCodexHome)
      assert.equal(bridge.proof.cleanup_required, false)
      await bridge.cleanup()
    }
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousCodexHome
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('Codex SDK persists refreshed ChatGPT tokens while keeping host-only API-key fields', async () => {
  const previousCodexHome = process.env.CODEX_HOME
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-native-provider-refresh-'))
  const nativeCodexHome = path.join(root, 'native-codex-home')
  try {
    await fsp.mkdir(nativeCodexHome, { mode: 0o700 })
    const sourceAuthPath = path.join(nativeCodexHome, 'auth.json')
    await fsp.writeFile(sourceAuthPath, `${JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: 'host-only-key',
      tokens: { access_token: 'old-access', refresh_token: 'old-refresh', id_token: 'old-id' }
    })}\n`, { mode: 0o600 })
    process.env.CODEX_HOME = nativeCodexHome
    const env = buildCodexSdkEnv(taskInput(root))
    const bridge = await prepareNativeCodexAuthBridge(env.env)
    const tempRoot = path.dirname(String(env.env.CODEX_HOME))
    const tempAuthPath = path.join(String(env.env.CODEX_HOME), 'auth.json')
    const refreshedAuth = JSON.parse(await fsp.readFile(tempAuthPath, 'utf8'))
    refreshedAuth.tokens = { access_token: 'new-access', refresh_token: 'new-refresh', id_token: 'new-id' }
    await fsp.writeFile(tempAuthPath, `${JSON.stringify(refreshedAuth, null, 2)}\n`, { mode: 0o600 })

    const cleanup = await bridge.cleanup()

    assert.equal(cleanup.ok, true)
    assert.equal(cleanup.outcome, 'refreshed_persisted')
    assert.equal(bridge.proof.cleanup_status, 'cleaned')
    assert.equal(bridge.proof.refreshed_auth_persisted, true)
    const persisted = JSON.parse(await fsp.readFile(sourceAuthPath, 'utf8'))
    assert.equal(persisted.auth_mode, 'chatgpt')
    assert.equal(persisted.tokens.access_token, 'new-access')
    assert.equal(persisted.tokens.refresh_token, 'new-refresh')
    assert.equal(persisted.OPENAI_API_KEY, 'host-only-key')
    assert.equal('OPENAI_API_KEY' in JSON.parse(JSON.stringify(refreshedAuth)), false)
    if (process.platform !== 'win32') assert.equal((await fsp.stat(sourceAuthPath)).mode & 0o777, 0o600)
    await assert.rejects(fsp.stat(tempRoot))
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousCodexHome
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('Codex SDK retains refreshed auth when the host source changes concurrently', async () => {
  // Refresh tokens ROTATE: when the host refreshed while the subagent ran and
  // neither side carries a newer last_refresh, the host's rotation is the one
  // an external client is actively using — keeping it is a RESOLVED outcome,
  // not a blocked one. (The old contract kept the host bytes too, but reported
  // a blocker and stranded the temp root.)
  const previousCodexHome = process.env.CODEX_HOME
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-native-provider-refresh-conflict-'))
  const nativeCodexHome = path.join(root, 'native-codex-home')
  try {
    await fsp.mkdir(nativeCodexHome, { mode: 0o700 })
    const sourceAuthPath = path.join(nativeCodexHome, 'auth.json')
    await fsp.writeFile(sourceAuthPath, `${JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'old-access', refresh_token: 'old-refresh' }
    })}\n`, { mode: 0o600 })
    process.env.CODEX_HOME = nativeCodexHome
    const env = buildCodexSdkEnv(taskInput(root))
    const bridge = await prepareNativeCodexAuthBridge(env.env)
    const tempRoot = path.dirname(String(env.env.CODEX_HOME))
    const tempAuthPath = path.join(String(env.env.CODEX_HOME), 'auth.json')
    const refreshedAuth = JSON.parse(await fsp.readFile(tempAuthPath, 'utf8'))
    refreshedAuth.tokens = { access_token: 'new-access', refresh_token: 'new-refresh' }
    await fsp.writeFile(tempAuthPath, `${JSON.stringify(refreshedAuth, null, 2)}\n`, { mode: 0o600 })
    await fsp.writeFile(sourceAuthPath, `${JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'concurrent-access', refresh_token: 'concurrent-refresh' }
    })}\n`, { mode: 0o600 })

    const cleanup = await bridge.cleanup()

    assert.equal(cleanup.ok, true)
    assert.equal(cleanup.outcome, 'host_newer_kept')
    assert.deepEqual(cleanup.blockers, [])
    assert.equal(bridge.proof.cleanup_status, 'cleaned')
    assert.equal(JSON.parse(await fsp.readFile(sourceAuthPath, 'utf8')).tokens.access_token, 'concurrent-access')
    await assert.rejects(fsp.stat(tempRoot))
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousCodexHome
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('Codex SDK persists the newer subagent token rotation over a stale concurrent host write', async () => {
  // The inverse race: the subagent's refresh is the NEWER rotation of the same
  // account. Discarding it (the pre-9.2.0 behavior) stranded the host on a
  // dead refresh token — the "refresh token was already used" forced re-login.
  // The CAS retries once against the freshly read host state and carries the
  // host's own non-token fields forward.
  const previousCodexHome = process.env.CODEX_HOME
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-native-provider-refresh-newer-'))
  const nativeCodexHome = path.join(root, 'native-codex-home')
  try {
    await fsp.mkdir(nativeCodexHome, { mode: 0o700 })
    const sourceAuthPath = path.join(nativeCodexHome, 'auth.json')
    await fsp.writeFile(sourceAuthPath, `${JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'old-access', refresh_token: 'old-refresh', account_id: 'acct-1' },
      last_refresh: '2026-08-20T10:00:00.000Z'
    })}\n`, { mode: 0o600 })
    process.env.CODEX_HOME = nativeCodexHome
    const env = buildCodexSdkEnv(taskInput(root))
    const bridge = await prepareNativeCodexAuthBridge(env.env)
    const tempRoot = path.dirname(String(env.env.CODEX_HOME))
    const tempAuthPath = path.join(String(env.env.CODEX_HOME), 'auth.json')
    const refreshedAuth = JSON.parse(await fsp.readFile(tempAuthPath, 'utf8'))
    refreshedAuth.tokens = { access_token: 'new-access', refresh_token: 'new-refresh', account_id: 'acct-1' }
    refreshedAuth.last_refresh = '2026-08-20T12:00:00.000Z'
    await fsp.writeFile(tempAuthPath, `${JSON.stringify(refreshedAuth, null, 2)}\n`, { mode: 0o600 })
    // Concurrent host write: an OLDER rotation plus a host-owned api-key field.
    await fsp.writeFile(sourceAuthPath, `${JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: 'host-key-written-meanwhile',
      tokens: { access_token: 'concurrent-access', refresh_token: 'concurrent-refresh', account_id: 'acct-1' },
      last_refresh: '2026-08-20T11:00:00.000Z'
    })}\n`, { mode: 0o600 })

    const cleanup = await bridge.cleanup()

    assert.equal(cleanup.ok, true)
    assert.equal(cleanup.outcome, 'refreshed_persisted_after_conflict')
    assert.deepEqual(cleanup.blockers, [])
    const persisted = JSON.parse(await fsp.readFile(sourceAuthPath, 'utf8'))
    assert.equal(persisted.tokens.access_token, 'new-access')
    assert.equal(persisted.tokens.refresh_token, 'new-refresh')
    assert.equal(persisted.last_refresh, '2026-08-20T12:00:00.000Z')
    assert.equal(persisted.OPENAI_API_KEY, 'host-key-written-meanwhile')
    await assert.rejects(fsp.stat(tempRoot))
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousCodexHome
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('Codex SDK rejects a symlinked native auth source', { skip: process.platform === 'win32' }, async () => {
  const previousCodexHome = process.env.CODEX_HOME
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-native-provider-symlink-'))
  const nativeCodexHome = path.join(root, 'native-codex-home')
  try {
    await fsp.mkdir(nativeCodexHome, { mode: 0o700 })
    const realAuth = path.join(root, 'real-auth.json')
    await fsp.writeFile(realAuth, JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'oauth-access-fixture', refresh_token: 'oauth-refresh-fixture' }
    }), { mode: 0o600 })
    await fsp.symlink(realAuth, path.join(nativeCodexHome, 'auth.json'), 'file')
    process.env.CODEX_HOME = nativeCodexHome
    const env = buildCodexSdkEnv(taskInput(root))
    const bridge = await prepareNativeCodexAuthBridge(env.env)

    assert.equal(bridge.ok, false)
    assert.match(bridge.blockers.join('\n'), /native_codex_auth_source_symlink_forbidden/)
    assert.equal(bridge.proof.cleanup_required, false)
    await bridge.cleanup()
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousCodexHome
    await fsp.rm(root, { recursive: true, force: true })
  }
})

function taskInput(root: string): CodexTaskInput {
  return {
    route: '$Naruto',
    tier: 'worker',
    missionId: 'M-native-provider-policy',
    cwd: process.cwd(),
    prompt: 'fixture',
    outputSchemaId: 'fixture',
    outputSchema: {},
    sandboxPolicy: 'read-only',
    requestedScopeContract: { read_only: true },
    mutationLedgerRoot: path.join(root, 'ledger')
  }
}
