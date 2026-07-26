import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ensureDir, nowIso, readJson, readText, sha256, writeJsonAtomic } from '../fsx.js';
import { PROTECTED_SECRET_KEYS, PROTECTED_SUPABASE_ENV_KEYS } from './supabase-secret-preservation.js';
import { escapeRegExp } from '../text/regex.js';

export interface SecretFingerprint {
  key: string;
  source: string;
  present: boolean;
  redacted_preview: string;
  value_sha256: string | null;
}

export interface SecretPreservationSnapshot {
  schema: 'sks.secret-preservation-snapshot.v1';
  generated_at: string;
  root: string;
  fingerprints: SecretFingerprint[];
}

export interface SecretPreservationGuardReport {
  schema: 'sks.secret-preservation-guard.v1';
  generated_at: string;
  ok: boolean;
  operation: string;
  before_path: string;
  after_path: string | null;
  restored_keys_count: number;
  changed_or_missing: ChangedOrMissingSecret[];
  missing_after: Array<{ key: string; source: string }>;
  rollback_attempted: boolean;
  rollback_ok: boolean;
  restore_mode: 'none' | 'line-level' | 'whole-file' | 'failed';
  unrelated_changes_preserved: boolean;
  nested_operations: string[];
  backup_paths: string[];
  raw_values_recorded: false;
}

export interface ChangedOrMissingSecret {
  key: string;
  source: string;
  before_sha256: string | null;
  after_sha256: string | null;
  reason: 'missing' | 'changed';
}

const activeGuardRoots = new Map<string, { nestedOperations: string[] }>();

export async function captureSecretPreservationSnapshot(input: {
  root: string;
  artifactPath?: string | null;
}): Promise<SecretPreservationSnapshot> {
  const root = path.resolve(input.root);
  const sources = secretSources(root);
  const fingerprints: SecretFingerprint[] = [];
  for (const source of sources) {
    const text = await readText(source, null);
    if (typeof text !== 'string') continue;
    if (source.endsWith('.json')) {
      const json = await readJson<Record<string, unknown>>(source, {}).catch(() => ({}));
      fingerprints.push(...fingerprintsFromObject(json, source));
    } else {
      fingerprints.push(...fingerprintsFromText(text, source));
    }
  }
  const snapshot: SecretPreservationSnapshot = {
    schema: 'sks.secret-preservation-snapshot.v1',
    generated_at: nowIso(),
    root,
    fingerprints: dedupeFingerprints(fingerprints)
  };
  if (input.artifactPath) await writeJsonAtomic(input.artifactPath, snapshot).catch(() => undefined);
  return snapshot;
}

export async function withSecretPreservationGuard<T>(
  root: string,
  operationName: string,
  fn: () => Promise<T>
): Promise<T> {
  const resolvedRoot = path.resolve(root);
  const active = activeGuardRoots.get(resolvedRoot);
  if (active) {
    active.nestedOperations.push(operationName);
    return fn();
  }
  const guardContext = { nestedOperations: [] as string[] };
  activeGuardRoots.set(resolvedRoot, guardContext);
  const reportDir = path.join(resolvedRoot, '.sneakoscope', 'reports');
  await ensureDir(reportDir);
  const beforePath = path.join(reportDir, 'secret-preservation-before.json');
  const afterPath = path.join(reportDir, 'secret-preservation-after.json');
  const guardPath = path.join(reportDir, 'secret-preservation-guard.json');
  const before = await captureSecretPreservationSnapshot({ root: resolvedRoot, artifactPath: beforePath });
  const backup = await backupSecretBearingSources(resolvedRoot, operationName, before);
  let result: T;
  let operationError: unknown = null;
  try {
    result = await fn();
  } catch (err: unknown) {
    operationError = err;
  }
  try {
    const after = await captureSecretPreservationSnapshot({ root: resolvedRoot, artifactPath: afterPath });
    const changedOrMissing = await withoutSecretsPreservedInComments(changedOrMissingProtectedSecrets(before, after));
    let rollbackAttempted = false;
    let rollbackOk = false;
    let restoredKeysCount = 0;
    let restoreMode: SecretPreservationGuardReport['restore_mode'] = 'none';
    let unrelatedChangesPreserved = true;
    if (changedOrMissing.length) {
      rollbackAttempted = true;
      const restore = await restoreChangedSecretSources(changedOrMissing, backup.bySource);
      restoreMode = restore.mode;
      unrelatedChangesPreserved = restore.unrelated_changes_preserved;
      const restored = await captureSecretPreservationSnapshot({
        root: resolvedRoot,
        artifactPath: path.join(reportDir, 'secret-preservation-after-restore.json')
      });
      const remaining = changedOrMissingProtectedSecrets(before, restored);
      rollbackOk = remaining.length === 0;
      restoredKeysCount = rollbackOk ? changedOrMissing.length : 0;
      if (!rollbackOk) {
        const failedReport = guardReport(operationName, beforePath, afterPath, changedOrMissing, restoredKeysCount, rollbackAttempted, false, backup.paths, 'failed', false, guardContext.nestedOperations);
        await writeJsonAtomic(guardPath, operationError ? { ...failedReport, ok: false, operation_error: sanitizeErrorMessage(operationError) } : failedReport).catch(() => undefined);
        throw new Error(`secret_preservation_rollback_failed:${changedOrMissing.map((item) => `${safeSourceForError(resolvedRoot, item.source)}:${item.key}:${item.reason}`).join(',')}`);
      }
    }
    const report: SecretPreservationGuardReport & { operation_error?: string } = guardReport(operationName, beforePath, afterPath, changedOrMissing, restoredKeysCount, rollbackAttempted, rollbackAttempted ? rollbackOk : true, backup.paths, restoreMode, unrelatedChangesPreserved, guardContext.nestedOperations);
    if (operationError) {
      report.ok = false;
      report.operation_error = sanitizeErrorMessage(operationError);
    }
    await writeJsonAtomic(guardPath, report).catch(() => undefined);
    if (operationError) throw operationError;
    if (rollbackAttempted) {
      throw new Error(`secret_preservation_restored:${changedOrMissing.map((item) => `${safeSourceForError(resolvedRoot, item.source)}:${item.key}:${item.reason}`).join(',')}`);
    }
    return result!;
  } finally {
    activeGuardRoots.delete(resolvedRoot);
  }
}

export function missingProtectedSecrets(before: SecretPreservationSnapshot, after: SecretPreservationSnapshot): Array<{ key: string; source: string }> {
  return changedOrMissingProtectedSecrets(before, after)
    .filter((item) => item.reason === 'missing')
    .map((item) => ({ key: item.key, source: item.source }));
}

export function changedOrMissingProtectedSecrets(before: SecretPreservationSnapshot, after: SecretPreservationSnapshot): ChangedOrMissingSecret[] {
  const afterMap = new Map(after.fingerprints.filter((fp) => fp.present).map((fp) => [`${fp.source}\0${fp.key}`, fp]));
  return before.fingerprints
    .filter((fp) => fp.present && fp.value_sha256)
    .map((fp): ChangedOrMissingSecret | null => {
      const afterFp = afterMap.get(`${fp.source}\0${fp.key}`);
      if (!afterFp) {
        return { key: fp.key, source: fp.source, before_sha256: fp.value_sha256, after_sha256: null, reason: 'missing' };
      }
      if (afterFp.value_sha256 !== fp.value_sha256) {
        return { key: fp.key, source: fp.source, before_sha256: fp.value_sha256, after_sha256: afterFp.value_sha256, reason: 'changed' };
      }
      return null;
    })
    .filter((item): item is ChangedOrMissingSecret => Boolean(item));
}

// A repair that intentionally deactivates a config block (e.g. commenting out
// a colliding stdio MCP server) makes the secret disappear from the *live*
// scan even though its value is still sitting right there in a comment, fully
// recoverable. Without this check the guard treats that as an accidental loss,
// rolls the whole file back (undoing the repair), and still throws — so the
// repair can never stick. Only 'missing' entries are reconsidered here: a
// 'changed' entry means a live value actually differs and must still trip the
// guard. Never reads the pre-image value itself — only re-hashes whatever text
// is currently on disk, so raw_values_recorded stays false throughout.
async function withoutSecretsPreservedInComments(entries: ChangedOrMissingSecret[]): Promise<ChangedOrMissingSecret[]> {
  const textBySource = new Map<string, string>();
  const kept: ChangedOrMissingSecret[] = [];
  for (const entry of entries) {
    if (entry.reason !== 'missing' || !entry.before_sha256) {
      kept.push(entry);
      continue;
    }
    let text = textBySource.get(entry.source);
    if (text === undefined) {
      text = await fs.readFile(entry.source, 'utf8').catch(() => '');
      textBySource.set(entry.source, text);
    }
    const preserved = readAllAssignmentValues(text, entry.key).some((value) => sha256(value) === entry.before_sha256);
    if (!preserved) kept.push(entry);
  }
  return kept;
}

/** Like readAssignment, but also matches the same key commented out (`# KEY = ...`)
 * and returns every candidate value found, not just the first. */
function readAllAssignmentValues(text: string, key: string): string[] {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\./g, '\\s*\\.\\s*');
  const re = new RegExp(`^\\s*#?\\s*(?:export\\s+)?${escaped}\\s*=\\s*(.+?)\\s*$`, 'gm');
  const values: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const raw = match[1]?.trim();
    if (raw) values.push(unquote(raw));
  }
  return values;
}

function secretSources(root: string): string[] {
  const home = process.env.HOME || os.homedir();
  return [
    '.env',
    '.env.local',
    '.env.development',
    '.env.production',
    '.sneakoscope/config.json',
    '.codex/config.toml',
    '.cursor/mcp.json',
    'mcp.json'
  ].map((rel) => path.join(root, rel)).concat(
    path.join(home, '.codex', 'config.toml'),
    path.join(home, '.config', 'sks', 'config.json')
  );
}

function fingerprintsFromText(text: string, source: string): SecretFingerprint[] {
  const rows: SecretFingerprint[] = [];
  for (const key of PROTECTED_SECRET_KEYS) {
    const value = readAssignment(text, key);
    if (!value) continue;
    rows.push(fingerprint(String(key), source, value));
  }
  rows.push(...fingerprintsFromTomlSections(text, source));
  for (const envKey of PROTECTED_SUPABASE_ENV_KEYS) {
    const value = readAssignment(text, envKey);
    if (value) rows.push(fingerprint(envKey, source, value));
  }
  return rows;
}

function fingerprintsFromObject(value: unknown, source: string): SecretFingerprint[] {
  const flat = flattenObject(value);
  const rows: SecretFingerprint[] = [];
  for (const [key, raw] of Object.entries(flat)) {
    if (!PROTECTED_SECRET_KEYS.includes(key as never)) continue;
    rows.push(fingerprint(key, source, String(raw)));
  }
  return rows;
}

function fingerprintsFromTomlSections(text: string, source: string): SecretFingerprint[] {
  const rows: SecretFingerprint[] = [];
  let section = '';
  for (const line of String(text || '').split(/\r?\n/)) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      section = String(sectionMatch[1] || '').trim();
      continue;
    }
    const kv = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.+?)\s*$/);
    if (!kv || !section) continue;
    const key = `${section}.${kv[1]}`;
    if (!PROTECTED_SECRET_KEYS.includes(key as never)) continue;
    rows.push(fingerprint(key, source, unquote(String(kv[2] || ''))));
  }
  return rows;
}

function fingerprint(key: string, source: string, value: string): SecretFingerprint {
  return {
    key,
    source,
    present: Boolean(value),
    redacted_preview: redactPreview(value),
    value_sha256: value ? sha256(value) : null
  };
}

function readAssignment(text: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s*(?:export\\s+)?${escaped.replace(/\\\./g, '\\s*\\.\\s*')}\\s*=\\s*(.+?)\\s*$`, 'm');
  const raw = String(text || '').match(re)?.[1]?.trim() || '';
  return unquote(raw);
}

function unquote(value: string): string {
  const trimmed = String(value || '').trim().replace(/\s+#.*$/, '');
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return trimmed;
}

function redactPreview(value: string): string {
  const text = String(value || '');
  if (!text) return '';
  return `sha256:${sha256(text).slice(0, 12)}(${text.length})`;
}

function flattenObject(value: unknown, prefix = ''): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, child] of Object.entries(value)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) Object.assign(out, flattenObject(child, nextKey));
    else if (child != null) out[nextKey] = String(child);
  }
  return out;
}

function dedupeFingerprints(fingerprints: SecretFingerprint[]): SecretFingerprint[] {
  const byKey = new Map<string, SecretFingerprint>();
  for (const fp of fingerprints) byKey.set(`${fp.source}\0${fp.key}`, fp);
  return [...byKey.values()].sort((a, b) => a.source.localeCompare(b.source) || a.key.localeCompare(b.key));
}

function guardReport(
  operation: string,
  beforePath: string,
  afterPath: string,
  changedOrMissing: ChangedOrMissingSecret[],
  restoredKeysCount: number,
  rollbackAttempted: boolean,
  rollbackOk: boolean,
  backupPaths: string[],
  restoreMode: SecretPreservationGuardReport['restore_mode'],
  unrelatedChangesPreserved: boolean,
  nestedOperations: string[]
): SecretPreservationGuardReport {
  return {
    schema: 'sks.secret-preservation-guard.v1',
    generated_at: nowIso(),
    ok: changedOrMissing.length === 0 || rollbackOk,
    operation,
    before_path: beforePath,
    after_path: afterPath,
    restored_keys_count: restoredKeysCount,
    changed_or_missing: changedOrMissing,
    missing_after: changedOrMissing.filter((item) => item.reason === 'missing').map((item) => ({ key: item.key, source: item.source })),
    rollback_attempted: rollbackAttempted,
    rollback_ok: rollbackOk,
    restore_mode: restoreMode,
    unrelated_changes_preserved: unrelatedChangesPreserved,
    nested_operations: nestedOperations,
    backup_paths: backupPaths,
    raw_values_recorded: false
  };
}

async function backupSecretBearingSources(root: string, operationName: string, snapshot: SecretPreservationSnapshot): Promise<{ bySource: Map<string, string>; paths: string[] }> {
  const bySource = new Map<string, string>();
  const sources = [...new Set(snapshot.fingerprints.filter((fp) => fp.present).map((fp) => fp.source))];
  if (!sources.length) return { bySource, paths: [] };
  const backupRoot = path.join(root, '.sneakoscope', 'backups', 'secrets', sanitizeSegment(operationName), new Date().toISOString().replace(/[:.]/g, '-'));
  for (const source of sources) {
    const backupPath = path.join(backupRoot, sanitizeSourcePath(root, source));
    await ensureDir(path.dirname(backupPath));
    await fs.copyFile(source, backupPath);
    bySource.set(source, backupPath);
  }
  return { bySource, paths: [...bySource.values()] };
}

async function restoreChangedSecretSources(changedOrMissing: ChangedOrMissingSecret[], backups: Map<string, string>): Promise<{ mode: SecretPreservationGuardReport['restore_mode']; unrelated_changes_preserved: boolean }> {
  let wholeFileFallback = false;
  for (const source of [...new Set(changedOrMissing.map((item) => item.source))]) {
    const backup = backups.get(source);
    if (!backup) {
      wholeFileFallback = true;
      continue;
    }
    const sourceChanges = changedOrMissing.filter((item) => item.source === source);
    const restoredLineLevel = await restoreSecretLines(source, backup, sourceChanges);
    if (!restoredLineLevel) {
      wholeFileFallback = true;
      await ensureDir(path.dirname(source));
      await fs.copyFile(backup, source);
    }
  }
  return { mode: wholeFileFallback ? 'whole-file' : 'line-level', unrelated_changes_preserved: !wholeFileFallback };
}

async function restoreSecretLines(source: string, backup: string, changes: ChangedOrMissingSecret[]): Promise<boolean> {
  if (source.endsWith('.json')) return false;
  const current = await fs.readFile(source, 'utf8').catch(() => null);
  const before = await fs.readFile(backup, 'utf8').catch(() => null);
  if (current == null || before == null) return false;
  let lines = current.split(/\r?\n/);
  const beforeLines = before.split(/\r?\n/);
  let changed = false;
  for (const item of changes) {
    const beforeLine = findAssignmentLine(beforeLines, item.key);
    if (!beforeLine) return false;
    const currentLine = findAssignmentLine(lines, item.key);
    if (currentLine) {
      lines[currentLine.index] = beforeLine.line;
    } else {
      const insertAt = insertionIndexForKey(lines, item.key);
      lines.splice(insertAt, 0, beforeLine.line);
    }
    changed = true;
  }
  if (changed) await fs.writeFile(source, lines.join('\n'), 'utf8');
  return true;
}

function findAssignmentLine(lines: string[], key: string): { index: number; line: string } | null {
  const sectionKey = sectionKeyFor(key);
  if (sectionKey) {
    const range = sectionRange(lines, sectionKey.section);
    if (!range) return null;
    const re = new RegExp(`^\\s*${escapeRegExp(sectionKey.key)}\\s*=`);
    for (let index = range.start + 1; index < range.end; index += 1) {
      if (re.test(lines[index] || '')) return { index, line: lines[index] || '' };
    }
    return null;
  }
  const re = new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(key)}\\s*=`);
  const index = lines.findIndex((line) => re.test(line));
  return index >= 0 ? { index, line: lines[index] || '' } : null;
}

function insertionIndexForKey(lines: string[], key: string): number {
  const sectionKey = sectionKeyFor(key);
  if (!sectionKey) return Math.max(0, lines.length - (lines[lines.length - 1] === '' ? 1 : 0));
  const range = sectionRange(lines, sectionKey.section);
  return range ? range.end : Math.max(0, lines.length - (lines[lines.length - 1] === '' ? 1 : 0));
}

function sectionKeyFor(key: string): { section: string; key: string } | null {
  if (!key.includes('.')) return null;
  const parts = key.split('.');
  const leaf = parts.pop();
  const section = parts.join('.');
  return leaf && section ? { section, key: leaf } : null;
}

function sectionRange(lines: string[], section: string): { start: number; end: number } | null {
  const header = new RegExp(`^\\s*\\[${escapeRegExp(section)}\\]\\s*(?:#.*)?$`);
  const start = lines.findIndex((line) => header.test(line));
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[[^\]]+\]\s*(?:#.*)?$/.test(lines[index] || '')) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function sanitizeSegment(value: string): string {
  return String(value || 'operation').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'operation';
}

function sanitizeSourcePath(root: string, source: string): string {
  return safeSourceForError(root, source).replace(/[^A-Za-z0-9._/-]+/g, '_').replace(/^\/+/, '');
}

function safeSourceForError(root: string, source: string): string {
  const rel = path.relative(root, source);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  const home = process.env.HOME || os.homedir();
  const homeRel = path.relative(home, source);
  if (homeRel && !homeRel.startsWith('..') && !path.isAbsolute(homeRel)) return `~/${homeRel}`;
  return path.basename(source);
}

function sanitizeErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/([A-Za-z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD)[A-Za-z0-9_]*=)[^\s,;]+/gi, '$1<redacted>');
}
