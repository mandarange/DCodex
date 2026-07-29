import fs from 'node:fs/promises'
import path from 'node:path'
import { assertTestHomeWriteAllowed, ensureDir, nowIso, readText, sha256, writeJsonAtomic, writeTextAtomic } from '../fsx.js'
import {
  codexHome,
  isSksOwnedGlobalUiLock,
  scanProjectLocalForbiddenKeys,
  snapshotCodexAppUiState
} from './codex-app-ui-state-snapshot.js'
import { assertCodexAppUiMutationAllowed } from './codex-app-ui-clobber-guard.js'
import { codexProviderModelUiStatus } from '../codex-app.js'
import { cleanupCodexConfigBackups } from '../codex/codex-config-toml.js'

export const CODEX_APP_FAST_UI_REPAIR_SCHEMA = 'sks.codex-app-fast-ui-repair.v1'

// `service_tier = "fast"` and `[features].fast_mode = true` are capability
// signals. Removing either would turn Fast off rather than restore native UI.
// Only provenance-backed SKS global provider/model/reasoning locks are removed.
const FAST_UI_TOP_LEVEL_RE = /^\s*(?:model_provider|model|model_reasoning_effort)\s*=/
const FAST_UI_LEGACY_TABLES = new Set(['user.fast_mode', 'profiles.sks-fast-high'])

export async function repairCodexAppFastUi(root: string = process.cwd(), input: {
  codexHome?: string | null
  apply?: boolean
  force?: boolean
  reportPath?: string | null
  env?: NodeJS.ProcessEnv
  codexLbModelCatalog?: any
} = {}) {
  const resolvedRoot = path.resolve(root)
  const home = codexHome(input.codexHome === undefined ? {} : { codexHome: input.codexHome })
  if (input.apply === true) assertTestHomeWriteAllowed(path.join(home, 'config.toml'))
  const before = await snapshotCodexAppUiState(resolvedRoot, { codexHome: home })
  const candidates = [
    { scope: 'project', file: path.join(resolvedRoot, '.codex', 'config.toml'), mode: 'project_forbidden_keys' },
    { scope: 'codex_home', file: path.join(home, 'config.toml'), mode: 'sks_caused_host_owned_keys' }
  ]
  const actions = []
  const detectedProjectLocalForbiddenKeys: string[] = []
  const unsafeReasons: string[] = []
  let permissionsHardened = 0
  let detectedSksCausedMutation = false
  for (const candidate of candidates) {
    const text = await readText(candidate.file, null)
    if (text == null) {
      actions.push({ scope: candidate.scope, file: displayPath(candidate.file), status: 'missing', changed: false })
      continue
    }
    if (input.apply === true) permissionsHardened += await hardenCodexConfigPermissions(candidate.file)
    const repaired = candidate.mode === 'project_forbidden_keys'
      ? stripProjectLocalForbiddenKeys(text)
      : stripSksCausedHostOwnedLines(text)
    const candidateUnsafeReasons = detectUnsafeFastUiRepair(text)
    unsafeReasons.push(...candidateUnsafeReasons)
    if (candidate.mode === 'project_forbidden_keys') detectedProjectLocalForbiddenKeys.push(...repaired.removedKeys)
    if (candidate.mode === 'sks_caused_host_owned_keys') {
      if (repaired.text !== text) detectedSksCausedMutation = true
    }
    if (repaired.text === text) {
      actions.push({ scope: candidate.scope, file: displayPath(candidate.file), status: candidateUnsafeReasons.length ? 'requires_confirmation' : 'ok', changed: false, removed_keys: repaired.removedKeys })
      continue
    }
    const backupPath = `${candidate.file}.codex-app-ui-repair-${Date.now().toString(36)}.bak`
    const applyAllowed = input.apply === true && (candidateUnsafeReasons.length === 0 || input.force === true)
    if (applyAllowed) {
      await ensureDir(path.dirname(candidate.file))
      await fs.writeFile(backupPath, text, { encoding: 'utf8', mode: 0o600 })
      await fs.chmod(backupPath, 0o600)
      assertCodexAppUiMutationAllowed({ kind: 'codex_app_ui_state', scope: 'codex-app-ui-repair', backupPath })
      await writeTextAtomic(candidate.file, repaired.text, { mode: 0o600 })
      await cleanupCodexConfigBackups(candidate.file, { keepPerTag: 3, maxAgeMs: 30 * 24 * 60 * 60 * 1000 }).catch(() => undefined)
    }
    actions.push({
      scope: candidate.scope,
      file: displayPath(candidate.file),
      status: applyAllowed ? 'repaired' : input.apply ? 'requires_confirmation' : 'planned',
      changed: true,
      backup_path: applyAllowed ? displayPath(backupPath) : null,
      before_hash: sha256(text),
      after_hash: sha256(repaired.text),
      removed_keys: repaired.removedKeys
    })
  }
  const after = await snapshotCodexAppUiState(resolvedRoot, { codexHome: home })
  const providerModelUi = await codexProviderModelUiStatus({
    cwd: resolvedRoot,
    env: input.env,
    home: path.dirname(home),
    configPath: path.join(home, 'config.toml'),
    codexLbEnvPath: path.join(home, 'sks-codex-lb.env'),
    ...(input.codexLbModelCatalog ? { codexLbModelCatalog: input.codexLbModelCatalog } : {})
  })
  const changed = actions.some((action) => action.changed)
  const applied = actions.some((action) => action.status === 'repaired')
  const pending = actions.some((action) => action.changed && action.status !== 'repaired')
  const requiresConfirmation = unsafeReasons.length > 0 && input.force !== true
  const chatgptOauthInactive = after.indicators.chat_surface === 'chatgpt_oauth_inactive'
  const selectedProviderBlockers = Array.isArray(providerModelUi.selected_provider_blockers)
    ? providerModelUi.selected_provider_blockers
    : []
  const safeAutoApply = changed && !requiresConfirmation
  const manual = changed && !input.apply
  const blockers = [
    ...(requiresConfirmation ? ['codex_app_fast_ui_repair_requires_confirmation'] : []),
    ...(manual && !safeAutoApply ? ['codex_app_fast_ui_repair_requires_explicit_apply'] : []),
    ...selectedProviderBlockers.map((blocker: string) => `selected_provider:${blocker}`),
    ...(after.indicators.secret_leak_suspected ? ['codex_app_ui_repair_secret_leak_suspected'] : [])
  ]
  const report = {
    schema: CODEX_APP_FAST_UI_REPAIR_SCHEMA,
    generated_at: nowIso(),
    ok: blockers.length === 0,
    apply: input.apply === true,
    safe_auto_apply: safeAutoApply,
    requires_confirmation: requiresConfirmation,
    detected_sks_caused_mutation: detectedSksCausedMutation,
    detected_project_local_forbidden_keys: [...new Set(detectedProjectLocalForbiddenKeys)],
    unsafe_repair_reasons: [...new Set(unsafeReasons)],
    permissions_hardened: permissionsHardened,
    fast_selector: pending ? 'manual_action_required' : applied ? 'repaired' : before.indicators.fast_selector === 'maybe_hidden_or_locked' ? 'manual_action_required' : 'ok',
    provider_selector: selectedProviderBlockers.length ? 'manual_action_required' : 'selected_provider_ready',
    provider_model_ui: providerModelUi,
    provider_actions: providerModelUi.ui_actions || [],
    provider_blockers: providerModelUi.blockers || [],
    selected_provider_blockers: selectedProviderBlockers,
    optional_provider_blockers: providerModelUi.optional_provider_blockers || [],
    host_owned_config: applied && !pending ? 'repaired_with_backup' : changed ? 'preserved_until_explicit_apply' : 'preserved',
    actions,
    before_fast_selector: before.indicators.fast_selector,
    after_fast_selector: after.indicators.fast_selector,
    auth_mode: after.indicators.auth_mode,
    chat_surface: after.indicators.chat_surface,
    chatgpt_oauth_backup_available: after.indicators.chatgpt_oauth_backup_available,
    next_action: requiresConfirmation ? 'Run `sks doctor --fix --repair-codex-app-ui` after reviewing the repair plan.' : manual && safeAutoApply ? 'Run `sks doctor --fix` to apply the safe Codex App UI repair.' : manual ? 'Run `sks doctor --fix --repair-codex-app-ui` after reviewing the repair plan.' : chatgptOauthInactive ? 'Run `sks codex-lb migrate-legacy-desktop --restart-app`; if no valid OAuth backup exists, run `codex login` first. Ordinary codex-lb routing commands never replace ChatGPT OAuth.' : changed ? 'Restart Codex App if the selector was already hidden.' : 'No Codex App UI repair needed.',
    blockers
  }
  if (input.reportPath) await writeJsonAtomic(input.reportPath, report)
  return report
}

async function hardenCodexConfigPermissions(configFile: string) {
  const dir = path.dirname(configFile)
  const base = path.basename(configFile)
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const targets = [configFile, ...entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(`${base}.`) && entry.name.endsWith('.bak'))
    .map((entry) => path.join(dir, entry.name))]
  let hardened = 0
  for (const target of targets) {
    const stat = await fs.lstat(target).catch(() => null)
    if (!stat?.isFile() || stat.isSymbolicLink()) continue
    if ((stat.mode & 0o777) !== 0o600) {
      await fs.chmod(target, 0o600)
      hardened += 1
    }
  }
  return hardened
}

function detectUnsafeFastUiRepair(text: string) {
  const reasons: string[] = []
  if (hasOddUnescapedQuotes(text)) reasons.push('unparseable_config_requires_manual_review')
  return [...new Set(reasons)]
}

function hasOddUnescapedQuotes(text: string) {
  return text.split(/\r?\n/).some((line) => {
    const stripped = line.replace(/\\"/g, '')
    return (stripped.match(/"/g) || []).length % 2 === 1
  })
}

function stripProjectLocalForbiddenKeys(text: string) {
  const forbidden = scanProjectLocalForbiddenKeys(text)
  if (!forbidden.length) return { text, removedKeys: [] as string[] }
  return stripMatchingLines(text, (line, table) => {
    if (table && forbidden.some((key) => key === table || key.startsWith(`${table}.`))) return true
    const key = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/)?.[1]
    return Boolean(key && forbidden.includes(key))
  })
}

function stripSksCausedHostOwnedLines(text: string) {
  const sourceLines = String(text || '').split(/\r?\n/)
  // An active, contract-shaped codex-lb or OpenRouter selection is a runtime
  // provider choice, not a Fast UI lock. Preserve it so Desktop keeps the
  // selected provider after project→global config migration markers are
  // present (the "SKS moved machine-local Codex config" note above the key
  // otherwise makes the selection look like a lock leftover).
  const preserveCodexLbSelection = hasActiveCodexLbProviderSelection(text)
  const preserveOpenRouterSelection = hasActiveOpenRouterProviderSelection(text)
  const stripped = stripMatchingLines(text, (line, table, _previous, _next, index) => {
    const isLegacyFastTable = table ? FAST_UI_LEGACY_TABLES.has(table) : false
    if (isLegacyFastTable) return true
    if (!table && preserveCodexLbSelection && /^\s*model_provider\s*=\s*"codex-lb"\s*(?:#.*)?$/.test(line)) return false
    if (!table && preserveOpenRouterSelection && /^\s*(?:model_provider\s*=\s*"openrouter"|model\s*=)/.test(line)) return false
    return !table && FAST_UI_TOP_LEVEL_RE.test(line) && isSksOwnedGlobalUiLock(sourceLines, index)
  })
  return stripped
}

function hasActiveOpenRouterProviderSelection(text: string) {
  const source = String(text || '')
  if (!/(?:^|\n)\s*model_provider\s*=\s*"openrouter"\s*(?:#.*)?(?=\n|$)/.test(source)) return false
  const body = source.match(/(?:^|\n)\[model_providers\.openrouter\]([^\n]*(?:\n(?!\s*\[)[^\n]*)*)/)?.[1] || ''
  return /(?:^|\n)\s*base_url\s*=\s*"https:\/\/openrouter\.ai\/api\/v1"\s*(?:#.*)?(?=\n|$)/.test(body)
    && /(?:^|\n)\s*wire_api\s*=\s*"responses"\s*(?:#.*)?(?=\n|$)/.test(body)
}

function hasActiveCodexLbProviderSelection(text: string) {
  const source = String(text || '')
  if (!/(?:^|\n)\s*model_provider\s*=\s*"codex-lb"\s*(?:#.*)?(?=\n|$)/.test(source)) return false
  const body = source.match(/(?:^|\n)\[model_providers\.codex-lb\]([^\n]*(?:\n(?!\s*\[)[^\n]*)*)/)?.[1] || ''
  const providerIdentity = /(?:^|\n)\s*name\s*=\s*"(?:openai|codex-lb)"\s*(?:#.*)?(?=\n|$)/i.test(body)
  const baseUrl = /(?:^|\n)\s*base_url\s*=\s*"https?:\/\/[^"]+"\s*(?:#.*)?(?=\n|$)/.test(body)
  const responsesWire = /(?:^|\n)\s*wire_api\s*=\s*"responses"\s*(?:#.*)?(?=\n|$)/.test(body)
  const cliProviderAuth = /(?:^|\n)\s*env_key\s*=\s*"CODEX_LB_API_KEY"\s*(?:#.*)?(?=\n|$)/.test(body)
    && /(?:^|\n)\s*requires_openai_auth\s*=\s*false\s*(?:#.*)?(?=\n|$)/.test(body)
  const desktopCompatAuth = /(?:^|\n)\s*env_http_headers\s*=\s*\{[^}\n]*"X-Codex-LB-API-Key"\s*=\s*"CODEX_LB_API_KEY"[^}\n]*\}\s*(?:#.*)?(?=\n|$)/.test(body)
    && /(?:^|\n)\s*requires_openai_auth\s*=\s*true\s*(?:#.*)?(?=\n|$)/.test(body)
  return providerIdentity && baseUrl && responsesWire && (cliProviderAuth || desktopCompatAuth)
}

function stripMatchingLines(text: string, shouldRemove: (line: string, table: string | null, previous: string, next: string, index: number) => boolean) {
  const lines = text.split(/\r?\n/)
  let table: string | null = null
  let removingTable: string | null = null
  const removedKeys: string[] = []
  const kept: string[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] || ''
    const tableMatch = line.match(/^\s*\[([^\]]+)\]\s*$/)
    if (tableMatch?.[1]) removingTable = null
    if (removingTable) {
      removedKeys.push(removingTable)
      continue
    }
    const currentTable = tableMatch?.[1] || table
    const remove = shouldRemove(line, currentTable, lines[i - 1] || '', lines[i + 1] || '', i)
    if (remove) {
      removedKeys.push(tableMatch?.[1] || line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/)?.[1] || '<table-body>')
      if (tableMatch?.[1]) {
        table = null
        removingTable = tableMatch[1]
      }
      continue
    }
    kept.push(line)
    if (tableMatch?.[1]) table = tableMatch[1]
  }
  return { text: kept.join('\n'), removedKeys: [...new Set(removedKeys)] }
}

function displayPath(file: string) {
  return file.replace(process.env.HOME || '', '~')
}
