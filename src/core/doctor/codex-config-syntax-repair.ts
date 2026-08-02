import path from 'node:path';
import os from 'node:os';
import { constants as fsConstants } from 'node:fs';
import fsp from 'node:fs/promises';
import { nowIso, writeJsonAtomic } from '../fsx.js';
import { validateCodexConfigRoundTrip } from '../codex/codex-config-toml.js';
import { isUnmanagedProjectCodexConfig, writeCodexConfigGuarded } from '../codex/codex-config-guard.js';
import { messageOf } from '../errors/message.js';
import { ALLOWED_REASONING_EFFORTS } from '../routes/constants.js';
import { escapeRegExp } from '../text/regex.js';

export const CODEX_CONFIG_SYNTAX_REPAIR_SCHEMA = 'sks.codex-config-syntax-repair.v1';

// Latest Codex config contract (2026-07 desktop merge): these keys/tables were
// removed from the schema and are silently ignored by Codex. Doctor --fix strips
// them so the file users run with matches current Codex syntax.
const RETIRED_TOP_LEVEL_VALUES = [{ key: 'default_profile', value: 'sks-fast-high' }];
const RETIRED_TABLES = ['user.fast_mode', 'profiles.sks-fast-high'];
const RETIRED_TABLE_KEYS: Array<{ table: string; key: string }> = [
  { table: 'notice', key: 'fast_default_opt_out' },
  { table: 'features', key: 'codex_hooks' },
  { table: 'features', key: 'remote_control' },
  { table: 'features', key: 'fast_mode_ui' },
  { table: 'features', key: 'codex_git_commit' },
  { table: 'features', key: 'multi_agent' }
];
// Current Codex service tiers. `priority` remains accepted for compatibility.
const ALLOWED_SERVICE_TIERS = new Set(['fast', 'priority', 'standard']);

type Scope = 'project' | 'global';

export interface CodexConfigSyntaxRepairConfigEntry {
  scope: Scope;
  path: string;
  present: boolean;
  changed: boolean;
  backup_path: string | null;
  retired_syntax_removed: string[];
  invalid_values_repaired: string[];
  blockers: string[];
  warnings: string[];
}

export interface CodexConfigSyntaxRepairResult {
  schema: typeof CODEX_CONFIG_SYNTAX_REPAIR_SCHEMA;
  ok: boolean;
  generated_at: string;
  fix: boolean;
  configs: CodexConfigSyntaxRepairConfigEntry[];
  actions: string[];
  manual_actions: string[];
  blockers: string[];
  warnings: string[];
  report_path: string;
}

export async function runCodexConfigSyntaxRepair(input: {
  root: string;
  fix: boolean;
  codexHome?: string;
  reportPath?: string | null;
  writeCodexConfigGuardedImpl?: typeof writeCodexConfigGuarded;
}): Promise<CodexConfigSyntaxRepairResult> {
  const root = path.resolve(input.root || process.cwd());
  const codexHome = input.codexHome || process.env.CODEX_HOME || path.join(process.env.HOME || os.homedir(), '.codex');
  const configs: CodexConfigSyntaxRepairConfigEntry[] = [];
  for (const candidate of [
    { scope: 'project' as const, path: path.join(root, '.codex', 'config.toml') },
    { scope: 'global' as const, path: path.join(codexHome, 'config.toml') }
  ]) {
    configs.push(await inspectOrRepairScope(
      root,
      candidate,
      input.fix === true,
      input.writeCodexConfigGuardedImpl || writeCodexConfigGuarded
    ));
  }
  const blockers = configs.flatMap((entry) => entry.blockers.map((item) => `${entry.scope}:${item}`));
  const warnings = configs.flatMap((entry) => entry.warnings.map((item) => `${entry.scope}:${item}`));
  const actions = configs.flatMap((entry) => [
    ...entry.retired_syntax_removed.map((item) => `${entry.scope} retired codex syntax removed: ${item}`),
    ...entry.invalid_values_repaired.map((item) => `${entry.scope} invalid value repaired: ${item}`)
  ]);
  const manualActions = configs.flatMap((entry) => entry.blockers.flatMap((item) => {
    if (item.startsWith('toml_parse_failed')) {
      return [`${entry.scope} config.toml does not parse as TOML; fix the syntax error manually (the file was preserved untouched).`];
    }
    if (item.startsWith('model_provider_auth_env_key_conflict')) {
      return [`${entry.scope} config.toml has a model provider that sets both env_key and auth; keep exactly one authentication method.`];
    }
    return [];
  }));
  const reportPath = input.reportPath === null
    ? ''
    : input.reportPath || path.join(root, '.sneakoscope', 'reports', 'codex-config-syntax-repair.json');
  const report: CodexConfigSyntaxRepairResult = {
    schema: CODEX_CONFIG_SYNTAX_REPAIR_SCHEMA,
    ok: blockers.length === 0,
    generated_at: nowIso(),
    fix: input.fix === true,
    configs,
    actions,
    manual_actions: [...new Set(manualActions)],
    blockers,
    warnings,
    report_path: reportPath
  };
  if (reportPath) await writeJsonAtomic(reportPath, report);
  return report;
}

async function inspectOrRepairScope(
  root: string,
  candidate: { scope: Scope; path: string },
  fix: boolean,
  writeGuarded: typeof writeCodexConfigGuarded
): Promise<CodexConfigSyntaxRepairConfigEntry> {
  const base: CodexConfigSyntaxRepairConfigEntry = {
    scope: candidate.scope,
    path: candidate.path,
    present: false,
    changed: false,
    backup_path: null,
    retired_syntax_removed: [],
    invalid_values_repaired: [],
    blockers: [],
    warnings: []
  };
  let projectParentIdentity: { dev: number; ino: number } | null = null;
  if (candidate.scope === 'project') {
    try {
      projectParentIdentity = await readProjectConfigParentIdentity(root);
    } catch (error) {
      base.present = true;
      base.blockers.push(`config_parent_unsafe:${messageOf(error)}`);
      base.warnings.push('config_preserved:unsafe_project_codex_parent');
      return base;
    }
    if (!projectParentIdentity) return base;
  }
  let snapshot: { text: string; mode: number } | null;
  try {
    snapshot = await readRegularConfigSnapshot(candidate.path);
  } catch (error) {
    base.present = true;
    base.blockers.push(`config_snapshot_failed:${messageOf(error)}`);
    base.warnings.push('config_preserved:unsafe_or_unreadable_path');
    return base;
  }
  if (!snapshot) return base;
  const { text } = snapshot;
  base.present = true;
  const validation = validateCodexConfigRoundTrip(text);
  if (!validation.ok) {
    if (validation.blockers.includes('toml_parse_failed')) {
      base.blockers.push('toml_parse_failed');
      base.warnings.push('config_preserved:unparseable_toml_requires_manual_repair');
      return base;
    }
    for (const blocker of validation.blockers) base.blockers.push(blocker);
  }

  const retired = findRetiredSyntax(text);
  const invalidValues = findInvalidValues(validation.parsed);
  const repairableValues = candidate.scope === 'project'
    ? invalidValues.filter((item) => item.repairable)
    : [];
  const detected = [...retired, ...repairableValues.map((item) => item.id)];
  if (candidate.scope === 'project' && isUnmanagedProjectCodexConfig(root, candidate.path, text)) {
    base.warnings.push('unmanaged_project_config_preserved');
    if (detected.length) base.warnings.push('user_owned_file_without_sks_marker');
    return base;
  }
  if (candidate.scope === 'global' && !hasRetiredSksGlobalProvenance(text)) {
    if (retired.length || invalidValues.length || validation.legacy_keys.length) {
      base.warnings.push('unmanaged_global_config_preserved');
    }
    if (retired.length) base.warnings.push('retired_syntax_without_sks_provenance');
    return base;
  }
  if (!fix) {
    for (const item of detected) base.warnings.push(`codex_syntax_outdated:${item}`);
    return base;
  }
  if (!detected.length) return base;
  base.retired_syntax_removed.push(...retired);
  base.invalid_values_repaired.push(...repairableValues.map((item) => item.id));

  let next = text;
  for (const entry of RETIRED_TOP_LEVEL_VALUES) {
    next = removeTopLevelTomlKeyIfValue(next, entry.key, entry.value);
  }
  for (const table of RETIRED_TABLES) next = removeTomlTable(next, table);
  for (const entry of RETIRED_TABLE_KEYS) next = removeTomlTableKey(next, entry.table, entry.key);
  for (const item of repairableValues) next = removeTopLevelTomlKey(next, item.key);
  next = next.replace(/\n{3,}/g, '\n\n').replace(/\s*$/, next.trim() ? '\n' : '');
  if (next === text) return base;
  let guarded: Awaited<ReturnType<typeof writeCodexConfigGuarded>>;
  try {
    if (projectParentIdentity) {
      const currentParentIdentity = await readProjectConfigParentIdentity(root);
      if (!sameParentIdentity(projectParentIdentity, currentParentIdentity)) {
        throw new Error('project_config_parent_changed');
      }
    }
    guarded = await writeGuarded({
      root,
      configPath: candidate.path,
      before: text,
      cause: 'codex-config-syntax-repair',
      // The repair intentionally drops invalid service_tier / fast-mode lock keys;
      // re-merging them would resurrect the exact syntax this phase removed.
      preserveFastUiKeys: false,
      verifyUnchangedBeforeWrite: true,
      expectedBeforeExists: true,
      expectedBeforeMode: snapshot.mode,
      mutate: () => next
    });
  } catch (error) {
    base.changed = false;
    base.retired_syntax_removed.length = 0;
    base.invalid_values_repaired.length = 0;
    base.blockers.push(`config_write_failed:${messageOf(error)}`);
    return base;
  }
  if (!guarded.ok) {
    base.changed = false;
    base.retired_syntax_removed.length = 0;
    base.invalid_values_repaired.length = 0;
    base.blockers.push(`config_write_refused:${guarded.status}`);
    return base;
  }
  base.changed = guarded.changed;
  base.backup_path = guarded.backup_path;
  return base;
}

async function readProjectConfigParentIdentity(root: string): Promise<{ dev: number; ino: number } | null> {
  const codexDir = path.join(path.resolve(root), '.codex');
  let stat;
  try {
    stat = await fsp.lstat(codexDir);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error('project_codex_parent_symlink_refused');
  if (!stat.isDirectory()) throw new Error('project_codex_parent_not_directory');
  return { dev: Number(stat.dev), ino: Number(stat.ino) };
}

function sameParentIdentity(
  expected: { dev: number; ino: number },
  observed: { dev: number; ino: number } | null
): boolean {
  return observed !== null
    && observed.dev === expected.dev
    && observed.ino === expected.ino;
}

async function readRegularConfigSnapshot(file: string): Promise<{ text: string; mode: number } | null> {
  let handle: Awaited<ReturnType<typeof fsp.open>> | null = null;
  try {
    handle = await fsp.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('config_path_not_regular_file');
    return {
      text: (await handle.readFile()).toString('utf8'),
      mode: stat.mode & 0o777
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

interface InvalidValueFinding {
  id: string;
  key: string;
  repairable: boolean;
}

function findRetiredSyntax(text: string): string[] {
  const found: string[] = [];
  for (const entry of RETIRED_TOP_LEVEL_VALUES) {
    if (topLevelTomlString(text, entry.key) === entry.value) found.push(`${entry.key}=${entry.value}`);
  }
  for (const table of RETIRED_TABLES) {
    if (hasTomlTable(text, table)) found.push(`[${table}]`);
  }
  for (const entry of RETIRED_TABLE_KEYS) {
    if (hasTomlTableKey(text, entry.table, entry.key)) found.push(`${entry.table}.${entry.key}`);
  }
  return found;
}

function hasRetiredSksGlobalProvenance(text: string): boolean {
  return RETIRED_TOP_LEVEL_VALUES.some((entry) => topLevelTomlString(text, entry.key) === entry.value)
    || RETIRED_TABLES.some((table) => hasTomlTable(text, table));
}

function findInvalidValues(parsed: Record<string, any> | null | undefined): InvalidValueFinding[] {
  const findings: InvalidValueFinding[] = [];
  if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'service_tier')) {
    const serviceTier = parsed.service_tier;
    if (typeof serviceTier !== 'string') {
      findings.push({ id: 'service_tier_non_string', key: 'service_tier', repairable: true });
    } else {
      const value = serviceTier.toLowerCase();
      if (!ALLOWED_SERVICE_TIERS.has(value)) {
        findings.push({ id: `service_tier_unknown:${value}`, key: 'service_tier', repairable: true });
      }
    }
  }
  if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'model_reasoning_effort')) {
    const effort = parsed.model_reasoning_effort;
    if (typeof effort !== 'string') {
      findings.push({ id: 'model_reasoning_effort_non_string', key: 'model_reasoning_effort', repairable: true });
    } else {
      const value = effort.toLowerCase();
      if (!ALLOWED_REASONING_EFFORTS.has(value)) {
        findings.push({ id: `model_reasoning_effort_unknown:${value}`, key: 'model_reasoning_effort', repairable: true });
      }
    }
  }
  return findings;
}

function topLevelTomlValue(text: string, key: string): string | null {
  const lines = String(text || '').split('\n');
  const firstTable = lines.findIndex((line) => /^\s*\[.+\]\s*(?:#.*)?$/.test(line));
  const end = firstTable === -1 ? lines.length : firstTable;
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(.+?)\\s*(?:#.*)?$`);
  for (let index = 0; index < end; index += 1) {
    const match = pattern.exec(lines[index] || '');
    if (match) return String(match[1] || '');
  }
  return null;
}

function topLevelTomlString(text: string, key: string): string | null {
  const value = topLevelTomlValue(text, key);
  if (!value || value.length < 2) return null;
  const quote = value[0];
  if ((quote !== '"' && quote !== "'") || value[value.length - 1] !== quote) return null;
  return value.slice(1, -1);
}

function removeTopLevelTomlKey(text: string, key: string): string {
  const lines = String(text || '').split('\n');
  const firstTable = lines.findIndex((line) => /^\s*\[.+\]\s*(?:#.*)?$/.test(line));
  const end = firstTable === -1 ? lines.length : firstTable;
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  return lines.filter((line, index) => index >= end || !pattern.test(line)).join('\n').replace(/^\n+/, '');
}

function removeTopLevelTomlKeyIfValue(text: string, key: string, value: string): string {
  return topLevelTomlString(text, key) === value
    ? removeTopLevelTomlKey(text, key)
    : text;
}

function hasTomlTable(text: string, table: string): boolean {
  const header = new RegExp(`^\\s*\\[${escapeRegExp(table)}\\]\\s*(?:#.*)?$`, 'm');
  return header.test(String(text || ''));
}

function removeTomlTable(text: string, table: string): string {
  const lines = String(text || '').split('\n');
  const header = new RegExp(`^\\s*\\[${escapeRegExp(table)}\\]\\s*(?:#.*)?$`);
  const anyHeader = /^\s*\[.+\]\s*(?:#.*)?$/;
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (anyHeader.test(line)) skipping = header.test(line);
    if (!skipping) out.push(line);
  }
  return out.join('\n').replace(/^\n+/, '');
}

function hasTomlTableKey(text: string, table: string, key: string): boolean {
  const lines = String(text || '').split('\n');
  const header = new RegExp(`^\\s*\\[${escapeRegExp(table)}\\]\\s*(?:#.*)?$`);
  const anyHeader = /^\s*\[.+\]\s*(?:#.*)?$/;
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  let inside = false;
  for (const line of lines) {
    if (anyHeader.test(line)) inside = header.test(line);
    else if (inside && pattern.test(line)) return true;
  }
  return false;
}

function removeTomlTableKey(text: string, table: string, key: string): string {
  const lines = String(text || '').split('\n');
  const header = new RegExp(`^\\s*\\[${escapeRegExp(table)}\\]\\s*(?:#.*)?$`);
  const anyHeader = /^\s*\[.+\]\s*(?:#.*)?$/;
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  let inside = false;
  const out: string[] = [];
  for (const line of lines) {
    if (anyHeader.test(line)) inside = header.test(line);
    if (inside && pattern.test(line)) continue;
    out.push(line);
  }
  return out.join('\n');
}
