import os from 'node:os';
import path from 'node:path';
import { writeCodexConfigGuarded } from '../../codex/codex-config-guard.js';
import { readText } from '../../fsx.js';
import { escapeRegExp } from '../../text/regex.js';
import type { UpdateMigrationStageRun } from '../update-migration-state.js';

type StageOutcome = Omit<UpdateMigrationStageRun, 'schema' | 'id' | 'min_from_version' | 'from_version'>;

export async function runConfigFastModeNormalizeStage(): Promise<StageOutcome> {
  const { reconcileRetiredSksConfigText } = await import('../../auto-review.js');
  const configPath = path.join(os.homedir(), '.codex', 'config.toml');
  const text = await readText(configPath, null);
  if (typeof text !== 'string') {
    return { ok: true, status: 'ok', actions: ['codex_config_absent'], blockers: [], warnings: [] };
  }
  const normalized = normalizeLegacyFastModeConfigForUpdate(text);
  const retired = reconcileRetiredSksConfigText(normalized.text);
  const nextText = ensureTrailingNewline(retired.text);
  const actions = [
    ...normalized.actions,
    ...(retired.detected_count > 0 ? ['stripped_retired_sks_config_profiles_and_policies'] : [])
  ];
  if (nextText === ensureTrailingNewline(text)) {
    return {
      ok: true,
      status: 'ok',
      actions: actions.length ? actions : ['fastmode_config_current'],
      blockers: [],
      warnings: [],
      detail: {
        config_path: configPath,
        default_profile: normalized.defaultProfile,
        retired_config_detected_count: retired.detected_count
      }
    };
  }
  const guardResult = await writeCodexConfigGuarded({
    configPath,
    before: text,
    mutate: () => nextText,
    cause: 'project-update-fastmode-normalize',
    backupTag: 'project-update-fastmode-normalize',
    preserveFastUiKeys: true
  });
  if (!guardResult.ok) {
    return {
      ok: false,
      status: 'failed',
      actions: ['normalize_fastmode_config_blocked'],
      blockers: [`codex_config_guard:${guardResult.status}`],
      warnings: [],
      detail: {
        config_path: configPath,
        default_profile: normalized.defaultProfile,
        retired_config_detected_count: retired.detected_count,
        guard: guardResult
      }
    };
  }
  return {
    ok: true,
    status: 'ok',
    actions: actions.length ? actions : ['fastmode_config_current'],
    blockers: [],
    warnings: [],
    detail: {
      config_path: configPath,
      default_profile: normalized.defaultProfile,
      retired_config_detected_count: retired.detected_count,
      guard: guardResult
    }
  };
}

function insertTopLevelTomlKey(text: string, line: string): string {
  const raw = String(text || '').trimEnd();
  const firstTable = raw.search(/^\s*\[/m);
  if (firstTable < 0) return `${line}\n${raw}`.trim() + '\n';
  return `${raw.slice(0, firstTable).trimEnd()}\n${line}\n\n${raw.slice(firstTable).trimStart()}`.trim() + '\n';
}

function normalizeLegacyFastModeConfigForUpdate(
  text: string
): { text: string; actions: string[]; defaultProfile: string | null } {
  // 2026-07 ChatGPT desktop merge: default_profile, [user.fast_mode], and
  // [profiles.<name>] tables left the Codex config schema. Strip the stamps
  // older SKS versions wrote while preserving the fast default semantically.
  let next = String(text || '');
  const actions: string[] = [];
  const misplaced = tomlTableString(next, 'user.fast_mode', 'default_profile');
  const topLevel = topLevelTomlString(next, 'default_profile');
  const legacyFastDefault = misplaced === 'sks-fast-high' || topLevel === 'sks-fast-high';
  const before = next;
  next = removeTopLevelTomlKeyLocal(next, 'default_profile');
  next = removeTomlTableLocal(next, 'user.fast_mode');
  next = removeTomlTableLocal(next, 'profiles.sks-fast-high');
  next = removeTomlTableKeyLocal(next, 'notice', 'fast_default_opt_out');
  if (next !== before) actions.push('stripped_removed_fastmode_config_schema_keys');
  if (legacyFastDefault && !topLevelTomlString(next, 'service_tier')) {
    next = insertTopLevelTomlKey(next, 'service_tier = "fast"');
    actions.push('migrated_legacy_fast_default_to_service_tier');
  }
  return { text: ensureTrailingNewline(next), actions, defaultProfile: misplaced || topLevel };
}

function removeTopLevelTomlKeyLocal(text: string, key: string): string {
  const lines = String(text || '').split('\n');
  const firstTable = lines.findIndex((line) => /^\s*\[.+\]\s*$/.test(line));
  const end = firstTable === -1 ? lines.length : firstTable;
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  return lines
    .filter((line, index) => index >= end || !keyPattern.test(line))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n{3,}/g, '\n\n');
}

function removeTomlTableLocal(text: string, table: string): string {
  const lines = String(text || '').trimEnd().split('\n');
  const header = `[${table}]`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) return String(text || '');
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line !== undefined && /^\s*\[.+\]\s*$/.test(line)) {
      end = index;
      break;
    }
  }
  return lines
    .filter((_, index) => index < start || index >= end)
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n{3,}/g, '\n\n');
}

function tomlTableString(text: string, table: string, key: string): string | null {
  const block = tomlTableBlock(text, table);
  const match = block?.match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*"([^"]*)"\\s*$`, 'm'));
  return match?.[1] || null;
}

function topLevelTomlString(text: string, key: string): string | null {
  const source = String(text || '');
  const firstTable = source.search(/^\s*\[/m);
  const top = firstTable < 0 ? source : source.slice(0, firstTable);
  const match = top.match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*"([^"]*)"\\s*$`, 'm'));
  return match?.[1] || null;
}

function tomlTableBlock(text: string, table: string): string | null {
  const lines = String(text || '').split(/\r?\n/);
  const start = lines.findIndex((line) => tableHeaderMatches(line, table));
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[index] || '')) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function removeTomlTableKeyLocal(text: string, table: string, key: string): string {
  const lines = String(text || '').split(/\r?\n/);
  let inTable = false;
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*\[[^\]]+\]\s*$/.test(line)) inTable = tableHeaderMatches(line, table);
    if (inTable && new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`).test(line)) continue;
    out.push(line);
  }
  return out.join('\n');
}

function tableHeaderMatches(line: string, table: string): boolean {
  return new RegExp(`^\\s*\\[${escapeRegExp(table)}\\]\\s*$`).test(line || '');
}

function ensureTrailingNewline(text: string): string {
  return `${String(text || '').trim()}\n`;
}
