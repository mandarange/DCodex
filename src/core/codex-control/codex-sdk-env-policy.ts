import { constants as fsConstants } from 'node:fs'
import fsp from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type { CodexTaskInput } from './codex-control-plane.js'

const SECRET_RE = /(?:key|token|secret|password|credential|auth|cookie)/i
const BASE_ALLOWED_ENV = new Set([
  'PATH',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'SHELL',
  'USER',
  'LOGNAME',
  'CI',
  'NODE_ENV',
  'SKS_CODEX_BIN',
  'CODEX_BIN'
])

export function buildCodexSdkEnv(input: CodexTaskInput): { env: Record<string, string>; proof: Record<string, unknown> } {
  const env: Record<string, string> = {}
  env.SKS_CODEX_CONTROL_PLANE = '1'
  env.SKS_PARENT_MISSION_ID = input.missionId
  env.SKS_ROUTE = input.route
  if (input.workItemId) env.SKS_WORK_ITEM_ID = input.workItemId
  if (input.slotId) env.SKS_AGENT_SLOT_ID = input.slotId
  if (input.sessionId) env.SKS_AGENT_SESSION_ID = input.sessionId
  if (input.generationIndex !== undefined) env.SKS_AGENT_GENERATION_INDEX = String(input.generationIndex)
  env.SKS_SERVICE_TIER = String(input.serviceTier || 'fast')
  const isolatedRoot = path.resolve(input.mutationLedgerRoot, 'codex-sdk-home')
  env.HOME = path.join(isolatedRoot, 'home')
  env.CODEX_HOME = path.join(isolatedRoot, 'codex')
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key in env) continue
    if (BASE_ALLOWED_ENV.has(key) || key.startsWith('LC_')) env[key] = String(value)
  }
  env.SKS_CODEX_CONTROL_PLANE_NATIVE = '1'
  const inheritedKeys = Object.keys(env).filter((key) => !key.startsWith('SKS_') && key !== 'HOME' && key !== 'CODEX_HOME').sort()
  const blockedHostKeys = Object.keys(process.env).filter((key) => !(key in env)).sort()
  return {
    env,
    proof: {
      injected_keys: Object.keys(env).filter((key) => key.startsWith('SKS_')).sort(),
      inherited_allowed_keys: inheritedKeys,
      inherited_key_count: inheritedKeys.length,
      blocked_host_env_key_count: blockedHostKeys.length,
      blocked_sensitive_host_env_key_count: blockedHostKeys.filter((key) => SECRET_RE.test(key)).length,
      redacted_sensitive_keys: Object.keys(env).filter((key) => SECRET_RE.test(key)).sort(),
      native_codex_only: true,
      model_provider: 'openai',
      codex_lb_env_injected: false,
      codex_lb_env_source: null,
      codex_lb_api_key_redacted: false,
      codex_home_isolated: true,
      home_isolated: true,
      native_codex_auth_bridge_required: true,
      native_codex_auth_source: 'host_codex_home/auth.json',
      codex_home: env.CODEX_HOME,
      home: env.HOME
    }
  }
}

export function redactCodexSdkEnv(env: Record<string, string>) {
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, SECRET_RE.test(key) ? '<redacted>' : value]))
}

export async function prepareNativeCodexAuthBridge(
  env: Record<string, string>,
  opts: { required?: boolean } = {}
) {
  const required = opts.required !== false
  if (!required) {
    return {
      ok: true,
      blockers: [] as string[],
      proof: {
        schema: 'sks.codex-native-auth-bridge.v1',
        ok: true,
        status: 'skipped_fixture_adapter',
        method: null,
        cleanup_required: false
      },
      cleanup: async () => ({ ok: true, status: 'cleaned', outcome: 'not_required', cleanup_required: false, blockers: [] as string[] })
    }
  }

  const nativeHome = String(process.env.HOME || os.homedir())
  const sourceHome = path.resolve(String(process.env.CODEX_HOME || path.join(nativeHome, '.codex')))
  const primaryAuthCandidate = path.join(sourceHome, 'auth.json')
  const backupAuthCandidate = path.join(sourceHome, 'auth.chatgpt-backup.json')
  let sourceAuthCandidate = primaryAuthCandidate
  let sourceAuthProof = 'host_codex_home/auth.json'
  let oauthBackupUsed = false
  let primaryAuthStatus: 'chatgpt_oauth' | 'api_key' | 'missing' = 'chatgpt_oauth'
  const originalHome = String(env.HOME || '')
  const originalCodexHome = String(env.CODEX_HOME || '')
  let tempRoot: string | null = null
  let tempRootIdentity: { dev: number; ino: number } | null = null
  let sourceAuthIdentity: { dev: number; ino: number } | null = null
  let sourceAuthFingerprint = ''
  let originalTokenFingerprint = ''
  let originalApiKeyFields: Record<string, unknown> = {}
  let destinationAuth: string | null = null
  let destinationAuthIdentity: { dev: number; ino: number } | null = null
  let bridgeProof: Record<string, any> | null = null
  let cleanupComplete = false

  const removeOwnedTempRoot = async () => {
    if (!tempRoot || cleanupComplete) return
    let current
    try {
      current = await fsp.lstat(tempRoot)
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        cleanupComplete = true
        return
      }
      throw error
    }
    if (!tempRootIdentity || !current.isDirectory() || current.isSymbolicLink()
      || current.dev !== tempRootIdentity.dev || current.ino !== tempRootIdentity.ino) {
      throw new Error('native_codex_auth_temp_root_identity_changed')
    }
    await fsp.rm(tempRoot, { recursive: true, force: false })
    try {
      await fsp.lstat(tempRoot)
      throw new Error('native_codex_auth_temp_root_cleanup_unverified')
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error
    }
    cleanupComplete = true
  }

  const cleanupOwnedTempRoot = async () => {
    if (!tempRoot || cleanupComplete) {
      return { ok: true, status: 'cleaned', outcome: 'already_cleaned', cleanup_required: false, blockers: [] as string[] }
    }
    try {
      if (!destinationAuth || !destinationAuthIdentity || !sourceAuthIdentity || !sourceAuthFingerprint) {
        throw new Error('native_codex_auth_cleanup_state_incomplete')
      }
      const tempAuthText = await readValidatedAuthFile(destinationAuth, {
        expectedIdentity: destinationAuthIdentity,
        requirePrivateMode: true,
        requireSingleLink: true,
        errorPrefix: 'native_codex_auth_destination'
      })
      const tempAuth = parseStrictChatGptAuth(tempAuthText, { forbidTopLevelApiKeys: true })
      const refreshedTokenFingerprint = fingerprintJson(tempAuth.tokens)
      if (refreshedTokenFingerprint === originalTokenFingerprint) {
        await removeOwnedTempRoot()
        const result = { ok: true, status: 'cleaned', outcome: 'unchanged', cleanup_required: false, blockers: [] as string[] }
        applyCleanupProof(bridgeProof, result)
        return result
      }

      try {
        await assertSourceAuthUnchanged(sourceAuthCandidate, sourceAuthIdentity, sourceAuthFingerprint)
        const hostAuth = { ...tempAuth, ...originalApiKeyFields }
        const hostAuthText = `${JSON.stringify(hostAuth, null, 2)}\n`
        await writeAuthFileAtomic(sourceAuthCandidate, hostAuthText, async () => {
          await assertSourceAuthUnchanged(sourceAuthCandidate, sourceAuthIdentity!, sourceAuthFingerprint)
        })
        await removeOwnedTempRoot()
        const result = { ok: true, status: 'cleaned', outcome: 'refreshed_persisted', cleanup_required: false, blockers: [] as string[] }
        applyCleanupProof(bridgeProof, result)
        return result
      } catch (error: any) {
        if (String(error?.message || error) !== 'native_codex_auth_source_conflict') throw error
        // The host auth.json moved while the subagent ran — almost always
        // another client's own token refresh. Refresh tokens ROTATE: exactly
        // one of the two rotations is still alive, and the old behavior
        // (discard ours unconditionally) stranded the host on a dead refresh
        // token whenever ours was the newer rotation — the "refresh token was
        // already used" forced re-login. Keep whichever rotation is newest,
        // for the same account only.
        const currentText = await readValidatedAuthFile(sourceAuthCandidate, {
          requirePrivateMode: true,
          requireSingleLink: true,
          errorPrefix: 'native_codex_auth_source'
        })
        const currentAuth = parseStrictChatGptAuth(currentText)
        const sameAccount = String(currentAuth.tokens?.account_id || '') === String(tempAuth.tokens?.account_id || '')
        const hostRefreshedAt = Date.parse(String(currentAuth.last_refresh || ''))
        const oursRefreshedAt = Date.parse(String(tempAuth.last_refresh || ''))
        const hostWins = !sameAccount
          || !Number.isFinite(oursRefreshedAt)
          || (Number.isFinite(hostRefreshedAt) && hostRefreshedAt >= oursRefreshedAt)
        if (hostWins) {
          await removeOwnedTempRoot()
          const result = { ok: true, status: 'cleaned', outcome: 'host_newer_kept', cleanup_required: false, blockers: [] as string[] }
          applyCleanupProof(bridgeProof, result)
          return result
        }
        // Ours is the newer rotation of the same account: retry the CAS once
        // against the host state just read, carrying the host's own non-token
        // fields forward so nothing the host wrote meanwhile is lost.
        const currentStat = await fsp.lstat(sourceAuthCandidate)
        const retryIdentity = { dev: currentStat.dev, ino: currentStat.ino }
        const retryFingerprint = fingerprintText(currentText)
        const mergedAuth = { ...currentAuth, tokens: tempAuth.tokens, last_refresh: tempAuth.last_refresh }
        await writeAuthFileAtomic(sourceAuthCandidate, `${JSON.stringify(mergedAuth, null, 2)}\n`, async () => {
          await assertSourceAuthUnchanged(sourceAuthCandidate, retryIdentity, retryFingerprint)
        })
        await removeOwnedTempRoot()
        const result = { ok: true, status: 'cleaned', outcome: 'refreshed_persisted_after_conflict', cleanup_required: false, blockers: [] as string[] }
        applyCleanupProof(bridgeProof, result)
        return result
      }
    } catch (error: any) {
      const reason = String(error?.message || error || 'native_codex_auth_cleanup_failed')
      const outcome = reason === 'native_codex_auth_source_conflict' ? 'source_conflict' : 'failed'
      const blocker = `native_codex_auth_cleanup_failed:${reason}`
      const result = { ok: false, status: 'blocked', outcome, cleanup_required: true, blockers: [blocker] }
      applyCleanupProof(bridgeProof, result, tempRoot)
      return result
    }
  }

  try {
    let source: Awaited<ReturnType<typeof readNativeCodexOAuthSource>>
    try {
      source = await readNativeCodexOAuthSource(primaryAuthCandidate, 'native_codex_auth_source')
    } catch (error: any) {
      const reason = String(error?.message || error)
      if (reason === 'native_codex_auth_api_key_forbidden') primaryAuthStatus = 'api_key'
      else if (reason === 'native_codex_auth_source_missing') primaryAuthStatus = 'missing'
      else throw error
      try {
        source = await readNativeCodexOAuthSource(backupAuthCandidate, 'native_codex_auth_backup')
        sourceAuthCandidate = backupAuthCandidate
        sourceAuthProof = 'host_codex_home/auth.chatgpt-backup.json'
        oauthBackupUsed = true
      } catch {
        throw error
      }
    }
    const { pathStat: sourcePathStat, text: sourceText, auth: sourceAuth } = source
    const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW
    sourceAuthIdentity = { dev: sourcePathStat.dev, ino: sourcePathStat.ino }
    sourceAuthFingerprint = fingerprintText(sourceText)
    originalTokenFingerprint = fingerprintJson(sourceAuth.tokens)
    originalApiKeyFields = Object.fromEntries(Object.entries(sourceAuth).filter(([key]) => isTopLevelApiKeyField(key)))
    const sanitizedAuthText = `${JSON.stringify(removeTopLevelApiKeyFields(sourceAuth), null, 2)}\n`

    const tempBase = await fsp.realpath(os.tmpdir())
    tempRoot = await fsp.mkdtemp(path.join(tempBase, 'sks-native-codex-'))
    const rootStat = await fsp.lstat(tempRoot)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error('native_codex_auth_temp_root_invalid')
    }
    tempRootIdentity = { dev: rootStat.dev, ino: rootStat.ino }
    await fsp.chmod(tempRoot, 0o700)
    const securedRootStat = await fsp.lstat(tempRoot)
    if (securedRootStat.dev !== tempRootIdentity.dev || securedRootStat.ino !== tempRootIdentity.ino
      || (process.platform !== 'win32' && (securedRootStat.mode & 0o777) !== 0o700)) {
      throw new Error('native_codex_auth_temp_root_permissions_invalid')
    }
    if (isPathInside(process.cwd(), tempRoot) || isPathInside(path.dirname(originalCodexHome), tempRoot)) {
      throw new Error('native_codex_auth_temp_root_inside_workspace')
    }

    const destinationHome = path.join(tempRoot, 'home')
    const destinationCodexHome = path.join(tempRoot, 'codex')
    destinationAuth = path.join(destinationCodexHome, 'auth.json')
    await fsp.mkdir(destinationHome, { mode: 0o700 })
    await fsp.mkdir(destinationCodexHome, { mode: 0o700 })
    await fsp.chmod(destinationHome, 0o700)
    await fsp.chmod(destinationCodexHome, 0o700)
    const destinationHandle = await fsp.open(
      destinationAuth,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      0o600
    )
    let destinationIdentity: { dev: number; ino: number } | null = null
    try {
      await destinationHandle.writeFile(sanitizedAuthText, 'utf8')
      await destinationHandle.chmod(0o600)
      const destinationStat = await destinationHandle.stat()
      if (!destinationStat.isFile() || destinationStat.nlink !== 1
        || (process.platform !== 'win32' && (destinationStat.mode & 0o777) !== 0o600)) {
        throw new Error('native_codex_auth_destination_validation_failed')
      }
      destinationIdentity = { dev: destinationStat.dev, ino: destinationStat.ino }
    } finally {
      await destinationHandle.close()
    }
    const destinationPathStat = await fsp.lstat(destinationAuth)
    if (!destinationIdentity || !destinationPathStat.isFile() || destinationPathStat.isSymbolicLink()
      || destinationPathStat.dev !== destinationIdentity.dev || destinationPathStat.ino !== destinationIdentity.ino) {
      throw new Error('native_codex_auth_destination_not_regular_file')
    }
    destinationAuthIdentity = destinationIdentity

    env.HOME = destinationHome
    env.CODEX_HOME = destinationCodexHome
    bridgeProof = {
      schema: 'sks.codex-native-auth-bridge.v1',
      ok: true,
      status: 'ready',
      method: 'exclusive_copy',
      auth_mode: 'chatgpt_oauth',
      source: sourceAuthProof,
      oauth_backup_used: oauthBackupUsed,
      primary_auth_status: primaryAuthStatus,
      active_api_key_auth_preserved: oauthBackupUsed && primaryAuthStatus === 'api_key',
      destination: 'private_temp_codex_home/auth.json',
      temp_root_location: 'os_tmpdir',
      temp_root_mode: '0700',
      auth_file_mode: '0600',
      source_symlinks_allowed: false,
      source_identity_captured: true,
      source_content_fingerprint_captured: true,
      api_key_fields_removed: true,
      refresh_writeback: 'strict_chatgpt_tokens_compare_and_swap',
      cleanup_required: true
    }
    return {
      ok: true,
      blockers: [] as string[],
      proof: bridgeProof,
      cleanup: cleanupOwnedTempRoot
    }
  } catch (error: any) {
    let cleanupError: unknown = null
    try {
      await removeOwnedTempRoot()
    } catch (cleanupFailure) {
      cleanupError = cleanupFailure
    }
    env.HOME = originalHome
    env.CODEX_HOME = originalCodexHome
    const reason = String(error?.message || error || 'native_codex_auth_bridge_failed')
    const cleanupReason = cleanupError ? `:cleanup_failed:${String((cleanupError as any)?.message || cleanupError)}` : ''
    const blocker = `native_codex_auth_bridge_failed:${reason}${cleanupReason}`
    return {
      ok: false,
      blockers: [blocker],
      proof: {
        schema: 'sks.codex-native-auth-bridge.v1',
        ok: false,
        status: 'blocked',
        method: null,
        source: sourceAuthProof,
        destination: 'private_temp_codex_home/auth.json',
        cleanup_required: Boolean(tempRoot && !cleanupComplete),
        blockers: [blocker]
      },
      cleanup: async () => {
        try {
          await removeOwnedTempRoot()
          return { ok: true, status: 'cleaned', outcome: 'setup_failure_cleaned', cleanup_required: false, blockers: [] as string[] }
        } catch (cleanupFailure: any) {
          const blocker = `native_codex_auth_cleanup_failed:${String(cleanupFailure?.message || cleanupFailure)}`
          return { ok: false, status: 'blocked', outcome: 'failed', cleanup_required: true, blockers: [blocker] }
        }
      }
    }
  }
}

async function readNativeCodexOAuthSource(filePath: string, errorPrefix: string) {
  let pathStat
  try {
    pathStat = await fsp.lstat(filePath)
  } catch (error: any) {
    if (error?.code === 'ENOENT') throw new Error(`${errorPrefix}_missing`)
    throw new Error(`${errorPrefix}_unreadable`)
  }
  if (pathStat.isSymbolicLink()) throw new Error(`${errorPrefix}_symlink_forbidden`)
  if (!pathStat.isFile()) throw new Error(`${errorPrefix}_not_file`)
  const text = await readValidatedAuthFile(filePath, {
    expectedIdentity: { dev: pathStat.dev, ino: pathStat.ino },
    requirePrivateMode: true,
    requireSingleLink: true,
    errorPrefix
  })
  return {
    pathStat,
    text,
    auth: parseStrictChatGptAuth(text)
  }
}

function parseStrictChatGptAuth(sourceText: string, opts: { forbidTopLevelApiKeys?: boolean } = {}) {
  let parsed: any
  try {
    parsed = JSON.parse(sourceText)
  } catch {
    throw new Error('native_codex_auth_source_invalid_json')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('native_codex_auth_source_unknown_shape')
  }
  const authMode = String(parsed.auth_mode || '').trim().toLowerCase()
  if (authMode !== 'chatgpt') {
    throw new Error(authMode.includes('api') ? 'native_codex_auth_api_key_forbidden' : 'native_codex_auth_mode_unsupported')
  }
  const tokens = parsed.tokens
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) {
    throw new Error('native_codex_auth_oauth_tokens_missing')
  }
  const accessToken = typeof tokens?.access_token === 'string' ? tokens.access_token.trim() : ''
  const refreshToken = typeof tokens?.refresh_token === 'string' ? tokens.refresh_token.trim() : ''
  const idToken = typeof tokens?.id_token === 'string' ? tokens.id_token.trim() : ''
  if (!accessToken || (!refreshToken && !idToken)) {
    throw new Error('native_codex_auth_oauth_tokens_missing')
  }
  if (opts.forbidTopLevelApiKeys && Object.keys(parsed).some((key) => isTopLevelApiKeyField(key))) {
    throw new Error('native_codex_auth_destination_api_key_field_forbidden')
  }
  return parsed as Record<string, any> & { auth_mode: string; tokens: Record<string, unknown> }
}

function removeTopLevelApiKeyFields(auth: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(auth).filter(([key]) => !isTopLevelApiKeyField(key)))
}

function isTopLevelApiKeyField(key: string) {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase()
  return normalized === 'key' || normalized === 'apikey' || normalized === 'openaiapikey'
}

async function readValidatedAuthFile(filePath: string, opts: {
  expectedIdentity?: { dev: number; ino: number }
  requirePrivateMode?: boolean
  requireSingleLink?: boolean
  errorPrefix: string
}) {
  const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW
  const pathStat = await fsp.lstat(filePath)
  if (pathStat.isSymbolicLink()) throw new Error(`${opts.errorPrefix}_symlink_forbidden`)
  if (!pathStat.isFile()) throw new Error(`${opts.errorPrefix}_not_file`)
  const handle = await fsp.open(filePath, fsConstants.O_RDONLY | noFollow)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.dev !== pathStat.dev || stat.ino !== pathStat.ino
      || (opts.expectedIdentity && (stat.dev !== opts.expectedIdentity.dev || stat.ino !== opts.expectedIdentity.ino))) {
      throw new Error(`${opts.errorPrefix}_identity_changed`)
    }
    if (opts.requireSingleLink && stat.nlink !== 1) throw new Error(`${opts.errorPrefix}_link_count_invalid`)
    if (opts.requirePrivateMode && process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw new Error(`${opts.errorPrefix}_permissions_too_open`)
    }
    return await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}

async function assertSourceAuthUnchanged(
  sourcePath: string,
  expectedIdentity: { dev: number; ino: number },
  expectedFingerprint: string
) {
  try {
    const currentText = await readValidatedAuthFile(sourcePath, {
      expectedIdentity,
      requirePrivateMode: true,
      errorPrefix: 'native_codex_auth_source'
    })
    if (fingerprintText(currentText) !== expectedFingerprint) throw new Error('native_codex_auth_source_conflict')
  } catch (error: any) {
    if (String(error?.message || error) === 'native_codex_auth_source_conflict') throw error
    throw new Error('native_codex_auth_source_conflict')
  }
}

async function writeAuthFileAtomic(sourcePath: string, contents: string, revalidateSource: () => Promise<void>) {
  const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW
  const temporaryPath = path.join(path.dirname(sourcePath), `.auth.json.sks-refresh-${process.pid}-${randomBytes(8).toString('hex')}`)
  let temporaryCreated = false
  try {
    const handle = await fsp.open(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      0o600
    )
    temporaryCreated = true
    try {
      await handle.writeFile(contents, 'utf8')
      await handle.chmod(0o600)
      await handle.sync()
      const stat = await handle.stat()
      if (!stat.isFile() || stat.nlink !== 1 || (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600)) {
        throw new Error('native_codex_auth_writeback_temp_validation_failed')
      }
    } finally {
      await handle.close()
    }
    await revalidateSource()
    await fsp.rename(temporaryPath, sourcePath)
    temporaryCreated = false
    const persistedText = await readValidatedAuthFile(sourcePath, {
      requirePrivateMode: true,
      requireSingleLink: true,
      errorPrefix: 'native_codex_auth_writeback'
    })
    if (fingerprintText(persistedText) !== fingerprintText(contents)) {
      throw new Error('native_codex_auth_writeback_verification_failed')
    }
  } finally {
    if (temporaryCreated) await fsp.rm(temporaryPath, { force: true })
  }
}

function fingerprintText(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function fingerprintJson(value: unknown) {
  return fingerprintText(stableJson(value))
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function applyCleanupProof(
  proof: Record<string, any> | null,
  result: { ok: boolean; status: string; outcome: string; cleanup_required: boolean; blockers: string[] },
  retainedTempRoot?: string | null
) {
  if (!proof) return
  proof.cleanup_required = result.cleanup_required
  proof.cleanup_status = result.status
  proof.cleanup_outcome = result.outcome
  proof.refreshed_auth_persisted = result.outcome === 'refreshed_persisted'
  proof.recovery_temp_root_retained = result.cleanup_required
  if (retainedTempRoot) proof.recovery_temp_root = retainedTempRoot
  if (result.blockers.length) proof.cleanup_blockers = result.blockers
  else delete proof.cleanup_blockers
}

function isPathInside(parent: string, child: string) {
  if (!parent) return false
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}
