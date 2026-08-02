import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CODEX_APP_PLUGINS } from '../routes.js';
import { ensureDir, PACKAGE_VERSION, readText, writeTextAtomic } from '../fsx.js';
import { removeLegacyTopLevelCodexModeLocks, writeCodexConfigGuarded } from '../codex/codex-config-guard.js';
import { cleanupCodexConfigBackups, validateCodexConfigRoundTrip } from '../codex/codex-config-toml.js';
import { escapeRegExp } from '../text/regex.js';

export async function ensureGlobalCodexFastModeDuringInstall(opts: any = {}) {
  if (process.env.SKS_SKIP_CODEX_FAST_MODE_REPAIR === '1') return { status: 'skipped', reason: 'SKS_SKIP_CODEX_FAST_MODE_REPAIR=1' };
  const home = opts.home || process.env.HOME || os.homedir();
  const configPath = opts.configPath || path.join(home, '.codex', 'config.toml');
  try {
    await ensureDir(path.dirname(configPath));
    const current = await readText(configPath, '');
    if (current.trim()) {
      const currentSmoke = codexConfigParseSmoke(current);
      if (!currentSmoke.ok) {
        const backupPath = await backupCodexConfig(configPath, current, 'unparseable');
        return { status: 'unparseable_config_preserved', config_path: configPath, backup_path: backupPath, parse_smoke: currentSmoke };
      }
    }
    const next = normalizeCodexFastModeUiConfig(current, {
      forceFastMode: opts.forceFastMode === true,
      forceFastModeOff: opts.forceFastModeOff === true
    });
    if (next === ensureTrailingNewline(current)) {
      const guarded = await safeWriteCodexConfigToml(configPath, current, next, 'codex-fast-mode-install-present', {
        preserveFastUiKeys: opts.forceFastModeOff !== true
      });
      return {
        status: guarded.status,
        config_path: configPath,
        backup_path: guarded.backup_path,
        parse_smoke: guarded.ok ? undefined : guarded
      };
    }
    const safeWrite = await safeWriteCodexConfigToml(configPath, current, next, 'codex-fast-mode-install', {
      preserveFastUiKeys: opts.forceFastModeOff !== true
    });
    return {
      status: safeWrite.status === 'written' ? 'updated' : safeWrite.status,
      config_path: configPath,
      backup_path: safeWrite.backup_path,
      parse_smoke: safeWrite.ok ? undefined : safeWrite
    };
  } catch (err: any) {
    return { status: 'failed', config_path: configPath, error: err.message };
  }
}

export function normalizeCodexFastModeUiConfig(text: any = '', opts: any = {}) {
  return normalizeCodexFastModeUiConfigOnce(normalizeCodexFastModeUiConfigOnce(text, opts), opts);
}

function normalizeCodexFastModeUiConfigOnce(text: any = '', opts: any = {}) {
  let next = String(text || '');
  next = removeLegacyTopLevelCodexModeLocks(next);
  next = removeTopLevelTomlKeyIfValue(next, 'default_profile', 'sks-fast-high');
  next = removeTomlTable(next, 'user.fast_mode');
  next = removeTomlTable(next, 'profiles.sks-fast-high');
  next = removeTomlTableKey(next, 'notice', 'fast_default_opt_out');
  for (const legacyFlag of ['codex_hooks', 'remote_control', 'fast_mode_ui', 'codex_git_commit']) {
    next = removeTomlTableKey(next, 'features', legacyFlag, 'true');
  }
  // Bare features.multi_agent is pre-V2; MA v2 lives in [features.multi_agent_v2].
  next = removeTomlTableKey(next, 'features', 'multi_agent');
  if (opts.forceFastMode === true) {
    next = upsertTopLevelTomlString(next, 'service_tier', 'fast');
  } else if (opts.forceFastModeOff === true) {
    next = removeTopLevelTomlKey(next, 'service_tier');
  }
  next = upsertTopLevelTomlBooleanIfAbsent(next, 'suppress_unstable_features_warning', true);
  for (const featureLine of [
    'hooks = true',
    'fast_mode = true',
    'apps = true',
    'computer_use = true',
    'browser_use = true',
    'browser_use_external = true',
    'image_generation = true',
    'in_app_browser = true',
    'guardian_approval = true',
    'tool_suggest = true',
    'plugins = true'
  ]) {
    next = upsertTomlTableKeyIfAbsent(next, 'features', featureLine);
  }
  // Global postinstall enables stable opt-in MA v2 without imposing project
  // concurrency numbers. Project setup owns max_concurrent_threads_per_session.
  if (!hasTomlTable(next, 'features.multi_agent_v2') && !hasTomlTableKey(next, 'features', 'multi_agent_v2')) {
    next = upsertTomlTable(next, 'features.multi_agent_v2', '[features.multi_agent_v2]\nenabled = true\nexpose_spawn_agent_model_overrides = true');
  }
  if (process.env.SKS_MANAGE_CODEX_APP_PLUGINS === '1') {
    for (const [name, marketplace] of DEFAULT_CODEX_APP_PLUGINS as any) {
      const table = `plugins."${name}@${marketplace}"`;
      if (!hasTomlTable(next, table)) next = upsertTomlTable(next, table, `[${table}]\nenabled = true`);
    }
  }
  return ensureTrailingNewline(next);
}

function removeTopLevelTomlKey(text: any = '', key: any = '') {
  const lines = String(text || '').split('\n');
  const firstTable = lines.findIndex((line: any) => /^\s*\[.+\]\s*$/.test(line));
  const end = firstTable === -1 ? lines.length : firstTable;
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  return lines.filter((line: any, index: any) => index >= end || !keyPattern.test(line)).join('\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n');
}

function removeTomlTable(text: any, table: any) {
  const lines = String(text || '').trimEnd().split('\n');
  const header = `[${table}]`;
  const start = lines.findIndex((line: any) => line.trim() === header);
  if (start === -1) return String(text || '');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[.+\]\s*$/.test(lines[i] || '')) { end = i; break; }
  }
  return lines.filter((_, index) => index < start || index >= end).join('\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n');
}

export function removeTopLevelTomlKeyIfValue(text: any = '', key: any = '', value: any = '') {
  const lines = String(text || '').split('\n');
  const firstTable = lines.findIndex((line: any) => /^\s*\[.+\]\s*$/.test(line));
  const end = firstTable === -1 ? lines.length : firstTable;
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*"${escapeRegExp(value)}"\\s*(?:#.*)?$`);
  return lines.filter((line: any, index: any) => index >= end || !keyPattern.test(line)).join('\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n');
}

function removeTomlTableKey(text: any, table: any, key: any, expectedValue: any = null) {
  const lines = String(text || '').trimEnd().split('\n');
  if (lines.length === 1 && lines[0] === '') return '';
  const start = lines.findIndex((line: any) => line.trim() === `[${table}]`);
  if (start === -1) return String(text || '');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[.+\]\s*$/.test(lines[i] || '')) { end = i; break; }
  }
  const valuePattern = expectedValue === null ? '' : `\\s*${escapeRegExp(String(expectedValue))}\\s*(?:#.*)?$`;
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=${valuePattern}`);
  return lines.filter((line: any, index: any) => index <= start || index >= end || !keyPattern.test(line)).join('\n').replace(/\n{3,}/g, '\n\n');
}

function upsertTomlTableKey(text: any, table: any, line: any) {
  const key = String(line).split('=')[0]?.trim() ?? '';
  const lines = String(text || '').trimEnd().split('\n');
  if (lines.length === 1 && lines[0] === '') lines.length = 0;
  const start = lines.findIndex((entry: any) => entry.trim() === `[${table}]`);
  if (start === -1) return [...lines, ...(lines.length ? [''] : []), `[${table}]`, line].join('\n').replace(/\n{3,}/g, '\n\n');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[.+\]\s*$/.test(lines[i] || '')) { end = i; break; }
  }
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  for (let i = start + 1; i < end; i += 1) {
    if (keyPattern.test(lines[i] || '')) {
      lines[i] = line;
      return lines.join('\n').replace(/\n{3,}/g, '\n\n');
    }
  }
  lines.splice(end, 0, line);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

function hasTomlTableKey(text: any, table: any, key: any) {
  const lines = String(text || '').split('\n');
  const start = lines.findIndex((line) => line.trim() === `[${table}]`);
  if (start === -1) return false;
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[.+\]\s*$/.test(lines[i] || '')) break;
    if (keyPattern.test(lines[i] || '')) return true;
  }
  return false;
}

function upsertTomlTableKeyIfAbsent(text: any, table: any, line: any) {
  const key = String(line).split('=')[0]?.trim() ?? '';
  return hasTomlTableKey(text, table, key) ? String(text || '') : upsertTomlTableKey(text, table, line);
}

function upsertTopLevelTomlBooleanIfAbsent(text: any, key: any, value: any) {
  return hasTopLevelTomlKey(text, key) ? String(text || '') : upsertTopLevelTomlBoolean(text, key, value);
}

export function ensureTrailingNewline(text: any = '') {
  const value = String(text || '').trimEnd();
  return value ? `${value}\n` : '';
}

export function upsertTopLevelTomlString(text: any, key: any, value: any) {
  const line = `${key} = "${value}"`;
  const lines = String(text || '').split('\n');
  const firstTable = lines.findIndex((entry: any) => /^\s*\[.+\]\s*$/.test(entry));
  const end = firstTable === -1 ? lines.length : firstTable;
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  for (let i = 0; i < end; i += 1) {
    if (keyPattern.test(lines[i] || '')) {
      lines[i] = line;
      return lines.join('\n').replace(/\n{3,}/g, '\n\n');
    }
  }
  lines.splice(end, 0, line);
  return lines.join('\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n');
}

function hasTopLevelTomlKey(text: any, key: any) {
  const lines = String(text || '').split('\n');
  const firstTable = lines.findIndex((entry: any) => /^\s*\[.+\]\s*$/.test(entry));
  const end = firstTable === -1 ? lines.length : firstTable;
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  return lines.slice(0, end).some((line) => pattern.test(line));
}

function codexConfigParseSmoke(text: any = '') {
  const value = String(text || '');
  const unterminatedTriple = (value.match(/"""|'''/g) || []).length % 2 !== 0;
  const invalidHeader = value.split('\n').find((line) => /^\s*\[/.test(line) && !/^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/.test(line)) || null;
  return { ok: !unterminatedTriple && !invalidHeader, unterminated_multiline_string: unterminatedTriple, invalid_table_header: invalidHeader };
}

async function backupCodexConfig(configPath: string, text: string, tag: string) {
  try {
    const backupPath = `${configPath}.sks-${tag}-${PACKAGE_VERSION}-${Date.now().toString(36)}.bak`;
    await writeTextAtomic(backupPath, text, { mode: 0o600 });
    await cleanupCodexConfigBackups(configPath, { keepPerTag: 3, maxAgeMs: 30 * 24 * 60 * 60 * 1000 }).catch(() => undefined);
    return backupPath;
  } catch {
    return null;
  }
}

export async function safeWriteCodexConfigToml(
  configPath: string,
  current: string,
  next: string,
  tag = 'codex-lb',
  opts: {
    preserveFastUiKeys?: boolean
    verifyUnchangedBeforeWrite?: boolean
    expectedBeforeExists?: boolean
    expectedBeforeMode?: number
  } = {}
) {
  return writeCodexConfigGuarded({
    configPath,
    before: String(current || ''),
    cause: tag,
    removeTopLevelModeLocks: true,
    ...(opts.preserveFastUiKeys === undefined ? {} : { preserveFastUiKeys: opts.preserveFastUiKeys }),
    ...(opts.verifyUnchangedBeforeWrite === undefined ? {} : { verifyUnchangedBeforeWrite: opts.verifyUnchangedBeforeWrite }),
    ...(opts.expectedBeforeExists === undefined ? {} : { expectedBeforeExists: opts.expectedBeforeExists }),
    ...(opts.expectedBeforeMode === undefined ? {} : { expectedBeforeMode: opts.expectedBeforeMode }),
    mutate: () => String(next || '')
  });
}

export function codexFastModeDesktopStatus(text: any = '') {
  const validation = validateCodexConfigRoundTrip(String(text || ''));
  const normalizedServiceTier = String(validation.service_tier || '').toLowerCase();
  const globalOn = validation.ok && (normalizedServiceTier === 'fast' || normalizedServiceTier === 'priority');
  return {
    schema: 'sks.codex-fast-mode-desktop-status.v2',
    ok: validation.ok,
    on: Boolean(globalOn),
    service_tier: validation.service_tier ?? null,
    model: validation.model ?? null,
    legacy_keys: validation.legacy_keys,
    validation: {
      ok: validation.ok,
      blockers: validation.blockers,
      parse_error: validation.parse_error || null,
      service_tier: validation.service_tier ?? null,
      model: validation.model ?? null,
      model_reasoning_effort: validation.model_reasoning_effort ?? null,
      legacy_keys: validation.legacy_keys
    }
  };
}

function upsertTopLevelTomlBoolean(text: any, key: any, value: any) {
  const line = `${key} = ${value ? 'true' : 'false'}`;
  const lines = String(text || '').split('\n');
  const firstTable = lines.findIndex((entry: any) => /^\s*\[.+\]\s*$/.test(entry));
  const end = firstTable === -1 ? lines.length : firstTable;
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  for (let i = 0; i < end; i += 1) {
    if (pattern.test(lines[i] || '')) {
      lines[i] = line;
      return lines.join('\n').replace(/\n{3,}/g, '\n\n');
    }
  }
  lines.splice(end, 0, line);
  return lines.join('\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n');
}

function hasTomlTable(text: any, table: any) {
  return String(text || '').split('\n').some((line) => String(line).trim() === `[${table}]`);
}

export function upsertTomlTable(text: any, table: any, block: any) {
  let lines = String(text || '').trimEnd().split('\n');
  if (lines.length === 1 && lines[0] === '') lines = [];
  const start = lines.findIndex((entry: any) => entry.trim() === `[${table}]`);
  const blockLines = String(block || '').trim().split('\n');
  if (start === -1) return [...lines, ...(lines.length ? [''] : []), ...blockLines].join('\n').replace(/\n{3,}/g, '\n\n');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[.+\]\s*$/.test(lines[i] || '')) { end = i; break; }
  }
  lines.splice(start, end - start, ...blockLines);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}
