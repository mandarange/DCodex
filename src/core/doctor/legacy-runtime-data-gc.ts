import path from 'node:path';
import fsp from 'node:fs/promises';
import { readJson } from '../fsx.js';
import { hasExplicitSksManagedCodexConfigMarker } from '../codex/codex-config-guard.js';
import {
  inspectConfinedPath,
  publicPathError,
  removeManagedPathVerified,
  type ConfinedPathInspection
} from '../managed-path-safety.js';

export const LEGACY_RUNTIME_DATA_GC_SCHEMA = 'sks.legacy-runtime-data-gc.v1' as const;

/**
 * SKS-authored `config.toml` backup names. Every SKS backup writer suffixes
 * the live file name (`config.toml.backup-<ts>`, `config.toml.bak[-tag]`,
 * `config.toml.<cause>.bak`, `config.toml.pre-session-restore-<ts>.bak`), so
 * the pattern is anchored to `config.toml.` plus a known backup shape and can
 * never match the live config. Content ownership is checked separately.
 */
const CONFIG_BACKUP_NAME = /^config\.toml\.(?:backup-[A-Za-z0-9_.:-]+|bak(?:[-.][A-Za-z0-9_.-]+)?|[A-Za-z0-9_.-]+\.bak)$/;
const BRIDGE_GENERATION_DIR = /^[0-9a-f]{64}\.[0-9a-f]{64}\.[0-9a-f]{64}$/;
/** Version-pinned capability/doctor caches (`codex-0138-capability.json`) whose
 *  readers were retired when the `codex-current-*` caches replaced them. */
const RETIRED_VERSION_CACHE = /^codex-0\d{2,3}-(?:capability|doctor)\.json$/;
const RETIRED_CHROME_HOSTS_V1 = 'chrome-native-hosts.json';
const CHROME_HOSTS_V2 = 'chrome-native-hosts-v2.json';

/** Newest config backups kept as restore points; everything older is residue. */
export const LEGACY_CONFIG_BACKUP_KEEP_COUNT = 3;
/** Inactive bridge generation bundles kept besides the active one. */
export const LEGACY_BRIDGE_GENERATION_KEEP_COUNT = 1;

export interface LegacyRuntimeDataCategoryReport {
  detected: number;
  removed: number;
  kept: number;
  remaining: number;
  errors: string[];
}

export interface LegacyRuntimeDataGcReport {
  schema: typeof LEGACY_RUNTIME_DATA_GC_SCHEMA;
  ok: boolean;
  fix: boolean;
  config_backups: LegacyRuntimeDataCategoryReport;
  bridge_generations: LegacyRuntimeDataCategoryReport;
  retired_version_caches: LegacyRuntimeDataCategoryReport;
  retired_singletons: LegacyRuntimeDataCategoryReport;
  remaining_count: number;
  error_count: number;
}

/**
 * Removes machine-local runtime data SKS itself accumulated and no current
 * code reads: aged `config.toml` backups beyond the newest
 * LEGACY_CONFIG_BACKUP_KEEP_COUNT, staged bridge catalog generation bundles
 * that are neither active nor the newest inactive one, retired version-pinned
 * capability caches, and the v1 chrome native-hosts record once the v2 record
 * exists. Deletion authority stays narrow: exact SKS name shapes, regular
 * files (or generation directories) owned by the current uid, config backups
 * with an explicit SKS managed marker, confined to the
 * codex home / state roots they live under, and the bridge category only acts
 * when the active-generation pointer proves which bundle is live.
 */
export async function reconcileLegacyRuntimeData(input: {
  codexHome: string;
  stateRoots: readonly string[];
  fix: boolean;
}): Promise<LegacyRuntimeDataGcReport> {
  const codexHome = path.resolve(input.codexHome);
  const configBackups = await reconcileConfigBackups(codexHome, input.fix);
  const bridgeGenerations = await reconcileBridgeGenerations(codexHome, input.fix);
  const retiredVersionCaches = await reconcileRetiredVersionCaches(input.stateRoots, input.fix);
  const retiredSingletons = await reconcileRetiredSingletons(codexHome, input.fix);
  const categories = [configBackups, bridgeGenerations, retiredVersionCaches, retiredSingletons];
  const remainingCount = categories.reduce((total, category) => total + category.remaining, 0);
  const errorCount = categories.reduce((total, category) => total + category.errors.length, 0);
  return {
    schema: LEGACY_RUNTIME_DATA_GC_SCHEMA,
    ok: remainingCount === 0 && errorCount === 0,
    fix: input.fix,
    config_backups: configBackups,
    bridge_generations: bridgeGenerations,
    retired_version_caches: retiredVersionCaches,
    retired_singletons: retiredSingletons,
    remaining_count: remainingCount,
    error_count: errorCount
  };
}

function emptyCategory(): LegacyRuntimeDataCategoryReport {
  return { detected: 0, removed: 0, kept: 0, remaining: 0, errors: [] };
}

async function reconcileConfigBackups(codexHome: string, fix: boolean): Promise<LegacyRuntimeDataCategoryReport> {
  const report = emptyCategory();
  const names = await readdirOrNull(codexHome);
  if (!names) return report;
  const candidates: Array<{ file: string; mtimeMs: number }> = [];
  for (const name of names) {
    if (!CONFIG_BACKUP_NAME.test(name)) continue;
    const inspected = await inspectOwnedRegularFile(codexHome, path.join(codexHome, name), report);
    if (!inspected) continue;
    // Backup names are also used by users and other tools. UID and filename
    // prove location, not SKS authorship; preserve unmarked restore points.
    const content = await fsp.readFile(inspected.path, 'utf8').catch(() => '');
    if (!hasExplicitSksManagedCodexConfigMarker(content)) continue;
    report.detected += 1;
    candidates.push({ file: inspected.path, mtimeMs: inspected.stat?.mtimeMs || 0 });
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  report.kept = Math.min(candidates.length, LEGACY_CONFIG_BACKUP_KEEP_COUNT);
  for (const candidate of candidates.slice(LEGACY_CONFIG_BACKUP_KEEP_COUNT)) {
    await removeOrCount(codexHome, candidate.file, fix, report);
  }
  return report;
}

async function reconcileBridgeGenerations(codexHome: string, fix: boolean): Promise<LegacyRuntimeDataCategoryReport> {
  const report = emptyCategory();
  const runtimeRoot = path.join(codexHome, 'sks');
  const generationsRoot = path.join(runtimeRoot, '.sks-bridge-generations');
  const names = await readdirOrNull(generationsRoot);
  if (!names) return report;
  const pointer: any = await readJson(path.join(runtimeRoot, 'sks-bridge-active-generation.json'), null);
  const activeName = typeof pointer?.bundle_directory === 'string'
    ? path.basename(pointer.bundle_directory)
    : null;
  const candidates: Array<{ file: string; name: string; mtimeMs: number }> = [];
  for (const name of names) {
    if (!BRIDGE_GENERATION_DIR.test(name)) continue;
    const target = path.join(generationsRoot, name);
    let inspected: ConfinedPathInspection;
    try {
      inspected = await inspectConfinedPath(generationsRoot, target);
    } catch (error: unknown) {
      report.errors.push(publicPathError(error, target));
      continue;
    }
    if (!inspected.exists || inspected.leafSymlink || !inspected.stat?.isDirectory() || !ownedByCurrentUid(inspected)) continue;
    report.detected += 1;
    if (name === activeName) {
      report.kept += 1;
      continue;
    }
    candidates.push({ file: target, name, mtimeMs: inspected.stat.mtimeMs });
  }
  // Without a readable active pointer there is no proof which bundle is live,
  // so nothing may be deleted — keeping everything is the only safe answer.
  if (!activeName || !BRIDGE_GENERATION_DIR.test(activeName)) {
    report.kept += candidates.length;
    return report;
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  report.kept += Math.min(candidates.length, LEGACY_BRIDGE_GENERATION_KEEP_COUNT);
  for (const candidate of candidates.slice(LEGACY_BRIDGE_GENERATION_KEEP_COUNT)) {
    await removeOrCount(generationsRoot, candidate.file, fix, report);
  }
  return report;
}

async function reconcileRetiredVersionCaches(
  stateRoots: readonly string[],
  fix: boolean
): Promise<LegacyRuntimeDataCategoryReport> {
  const report = emptyCategory();
  for (const root of [...new Set(stateRoots.map((value) => path.resolve(value)))]) {
    const names = await readdirOrNull(root);
    if (!names) continue;
    for (const name of names) {
      if (!RETIRED_VERSION_CACHE.test(name)) continue;
      const inspected = await inspectOwnedRegularFile(root, path.join(root, name), report);
      if (!inspected) continue;
      report.detected += 1;
      await removeOrCount(root, inspected.path, fix, report);
    }
  }
  return report;
}

async function reconcileRetiredSingletons(codexHome: string, fix: boolean): Promise<LegacyRuntimeDataCategoryReport> {
  const report = emptyCategory();
  const v1 = path.join(codexHome, RETIRED_CHROME_HOSTS_V1);
  const v2 = path.join(codexHome, CHROME_HOSTS_V2);
  const v1Inspected = await inspectOwnedRegularFile(codexHome, v1, report, { quiet: true });
  if (!v1Inspected) return report;
  const v2Inspected = await inspectOwnedRegularFile(codexHome, v2, report, { quiet: true });
  report.detected += 1;
  if (!v2Inspected) {
    // The v2 record has not replaced it yet; the v1 record is still the only
    // copy of that state, so it is not residue.
    report.kept += 1;
    return report;
  }
  await removeOrCount(codexHome, v1, fix, report);
  return report;
}

async function removeOrCount(
  boundary: string,
  file: string,
  fix: boolean,
  report: LegacyRuntimeDataCategoryReport
): Promise<void> {
  if (!fix) {
    report.remaining += 1;
    return;
  }
  try {
    await removeManagedPathVerified(boundary, file);
    report.removed += 1;
  } catch (error: unknown) {
    report.errors.push(publicPathError(error, file));
    report.remaining += 1;
  }
}

async function inspectOwnedRegularFile(
  boundary: string,
  file: string,
  report: LegacyRuntimeDataCategoryReport,
  options: { quiet?: boolean } = {}
): Promise<ConfinedPathInspection | null> {
  let inspected: ConfinedPathInspection;
  try {
    inspected = await inspectConfinedPath(boundary, file);
  } catch (error: unknown) {
    if (!options.quiet) report.errors.push(publicPathError(error, file));
    return null;
  }
  if (!inspected.exists || inspected.leafSymlink || !inspected.stat?.isFile() || !ownedByCurrentUid(inspected)) return null;
  return inspected;
}

function ownedByCurrentUid(inspected: ConfinedPathInspection): boolean {
  if (typeof process.getuid !== 'function') return true;
  return inspected.stat?.uid === process.getuid();
}

async function readdirOrNull(directory: string): Promise<string[] | null> {
  try {
    const stat = await fsp.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
  } catch {
    return null;
  }
  try {
    return (await fsp.readdir(directory)).sort();
  } catch {
    return null;
  }
}
