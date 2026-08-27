import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reconcileRetiredAgentRoleResidue } from '../agents/agent-role-config.js';
import {
  hasExplicitSksManagedCodexConfigMarker,
  writeCodexConfigGuarded
} from '../codex/codex-config-guard.js';
import { validateCodexConfigRoundTrip } from '../codex/codex-config-toml.js';
import { collectNestedProjectRoots } from '../doctor/current-project-guidance-nested.js';
import {
  reconcileRetiredManagedResidue,
  type RetiredManagedResidueReport
} from '../doctor/retired-managed-residue.js';
import {
  reconcileLegacyRuntimeData,
  type LegacyRuntimeDataGcReport
} from '../doctor/legacy-runtime-data-gc.js';
import { readJson, readText } from '../fsx.js';
import { removeMcpServerBlock, mcpServerBlockWithChildren } from '../mcp/mcp-config-preservation.js';
import { reconcileRetiredSksConfigText } from '../auto-review.js';
import {
  reconcileSkills,
  type SkillReconcileReport
} from './skills.js';

export const LEGACY_GENERATION_CONVERGENCE_SCHEMA = 'sks.legacy-generation-convergence.v1' as const;

const GENERATED_PRUNE_POLICY = 'remove_previous_sks_generated_paths_absent_from_current_manifest';
const RETIRED_SKS_MCP_SERVERS = ['supabase_mad_db'] as const;

type FailedSkillReconcile = {
  ok: false;
  scope: 'global' | 'project';
  target_dir: string;
  error: string;
};

export type SkillConvergenceResult = SkillReconcileReport | FailedSkillReconcile;

export interface ManagedConfigConvergenceReport {
  ok: boolean;
  fix: boolean;
  scanned_count: number;
  detected_count: number;
  rewritten_count: number;
  retired_mcp_block_count: number;
  retired_config_entry_count: number;
  compacted_marker_line_count: number;
  preserved_user_config_count: number;
  remaining_count: number;
  error_count: number;
  rewritten: string[];
  preserved_user_configs: string[];
  errors: string[];
}

export interface LegacyGenerationConvergenceReport {
  schema: typeof LEGACY_GENERATION_CONVERGENCE_SCHEMA;
  ok: boolean;
  fix: boolean;
  root: string;
  home: string;
  global_runtime_root: string;
  global_skills: SkillConvergenceResult;
  project_skills: SkillConvergenceResult[];
  retired_agent_roles: Awaited<ReturnType<typeof reconcileRetiredAgentRoleResidue>>;
  retired_runtime_scopes: RetiredManagedResidueReport[];
  runtime_data_gc: LegacyRuntimeDataGcReport;
  managed_configs: ManagedConfigConvergenceReport;
  blockers: string[];
  warnings: string[];
}

/**
 * Converges every installed SKS generation reachable from the active project.
 *
 * Deletion authority is intentionally narrow:
 * - skills require an SKS ownership marker and generated-only directory shape;
 * - roles and runtime artifacts use their existing manifest/schema tombstones;
 * - config entries use exact retired SKS signatures, while retired MCP tables
 *   additionally require an explicit managed-config marker or generated-files
 *   manifest ownership proof.
 */
export async function reconcileLegacyManagedGeneration(input: {
  root: string;
  home?: string;
  codexHome?: string;
  globalRuntimeRoot?: string;
  fix: boolean;
}): Promise<LegacyGenerationConvergenceReport> {
  const root = path.resolve(input.root);
  const home = path.resolve(input.home || process.env.HOME || os.homedir());
  const codexHome = path.resolve(input.codexHome || process.env.CODEX_HOME || path.join(home, '.codex'));
  const globalRuntimeRoot = path.resolve(
    input.globalRuntimeRoot
    || process.env.SKS_GLOBAL_ROOT
    || path.join(home, '.sneakoscope-global')
  );
  const warnings: string[] = [];

  const nested = root === home || root === globalRuntimeRoot
    ? { roots: [] as string[], errorCount: 0, warnings: [] as Array<{ code: string; cutoff_path: string }> }
    : await collectNestedProjectRoots(root, new Set([home, globalRuntimeRoot, codexHome]));
  warnings.push(...nested.warnings.map((warning) => `${warning.code}:${warning.cutoff_path}`));
  if (nested.errorCount) warnings.push(`nested_project_generation_scan_failed:${nested.errorCount}`);
  const projectRoots = [...new Set([root, ...nested.roots].map((value) => path.resolve(value)))];
  const blockers: string[] = [];

  const globalTarget = path.resolve(home, '.agents', 'skills');
  const globalSkills = await reconcileSkillTarget(globalTarget, 'global', input.fix, globalRuntimeRoot);
  const realGlobalSkills = await fsp.realpath(globalTarget).catch(() => null);
  const projectSkills: SkillConvergenceResult[] = [];
  for (const projectRoot of projectRoots) {
    const target = path.resolve(projectRoot, '.agents', 'skills');
    if (target === globalTarget) continue;
    // Exact .agents or .agents/skills aliases into the authoritative global
    // skill root are accepted install surfaces — do not project-reconcile them.
    const realTarget = await fsp.realpath(target).catch(() => null);
    if (realGlobalSkills && realTarget && realTarget === realGlobalSkills) continue;
    projectSkills.push(await reconcileSkillTarget(target, 'project', input.fix, globalRuntimeRoot));
  }

  const retiredAgentRoles = await reconcileRetiredAgentRoleResidue({
    root,
    home,
    codexHome,
    globalRuntimeRoot,
    fix: input.fix
  });

  const runtimeRoots = [...new Set([...projectRoots, home, globalRuntimeRoot].map((value) => path.resolve(value)))];
  const retiredRuntimeScopes: RetiredManagedResidueReport[] = [];
  for (const runtimeRoot of runtimeRoots) {
    retiredRuntimeScopes.push(await reconcileRuntimeScope(runtimeRoot, input.fix));
  }

  const runtimeDataGc = await reconcileLegacyRuntimeData({
    codexHome,
    stateRoots: runtimeRoots.map((runtimeRoot) => path.join(runtimeRoot, '.sneakoscope')),
    fix: input.fix
  });

  const managedConfigs = await reconcileManagedConfigs({
    projectRoots,
    home,
    codexHome,
    globalRuntimeRoot,
    fix: input.fix
  });
  const skillsOk = globalSkills.ok && projectSkills.every((report) => report.ok);
  const runtimeOk = retiredRuntimeScopes.every((report) => report.ok);

  return {
    schema: LEGACY_GENERATION_CONVERGENCE_SCHEMA,
    ok: skillsOk
      && retiredAgentRoles.ok
      && runtimeOk
      && runtimeDataGc.ok
      && managedConfigs.ok
      && blockers.length === 0
      && nested.errorCount === 0,
    fix: input.fix,
    root,
    home,
    global_runtime_root: globalRuntimeRoot,
    global_skills: globalSkills,
    project_skills: projectSkills,
    retired_agent_roles: retiredAgentRoles,
    retired_runtime_scopes: retiredRuntimeScopes,
    runtime_data_gc: runtimeDataGc,
    managed_configs: managedConfigs,
    blockers,
    warnings
  };
}

async function reconcileSkillTarget(
  targetDir: string,
  scope: 'global' | 'project',
  fix: boolean,
  globalRuntimeRoot: string
): Promise<SkillConvergenceResult> {
  try {
    return await reconcileSkills({ targetDir, scope, fix, globalRuntimeRoot });
  } catch (error: unknown) {
    return {
      ok: false,
      scope,
      target_dir: targetDir,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function reconcileRuntimeScope(root: string, fix: boolean): Promise<RetiredManagedResidueReport> {
  try {
    const stat = await fsp.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return emptyRuntimeReport(fix, false);
  } catch (error: unknown) {
    if (nodeErrorCode(error) === 'ENOENT') return emptyRuntimeReport(fix, true);
    return emptyRuntimeReport(fix, false);
  }
  return reconcileRetiredManagedResidue({ root, fix });
}

function emptyRuntimeReport(fix: boolean, ok: boolean): RetiredManagedResidueReport {
  return {
    schema: 'sks.retired-managed-residue.v1',
    ok,
    fix,
    detected_managed_artifact_count: 0,
    removed_managed_artifact_count: 0,
    rewritten_state_file_count: 0,
    agent_bridge_manifest: 'absent',
    preserved_user_file_count: 0,
    remaining_managed_artifact_count: ok ? 0 : 1,
    error_count: ok ? 0 : 1
  };
}

async function reconcileManagedConfigs(input: {
  projectRoots: string[];
  home: string;
  codexHome: string;
  globalRuntimeRoot: string;
  fix: boolean;
}): Promise<ManagedConfigConvergenceReport> {
  const report: ManagedConfigConvergenceReport = {
    ok: true,
    fix: input.fix,
    scanned_count: 0,
    detected_count: 0,
    rewritten_count: 0,
    retired_mcp_block_count: 0,
    retired_config_entry_count: 0,
    compacted_marker_line_count: 0,
    preserved_user_config_count: 0,
    remaining_count: 0,
    error_count: 0,
    rewritten: [],
    preserved_user_configs: [],
    errors: []
  };
  const targets = new Map<string, { ownerRoot: string; configPath: string }>();
  for (const projectRoot of input.projectRoots) {
    addConfigTarget(targets, projectRoot, path.join(projectRoot, '.codex', 'config.toml'));
  }
  addConfigTarget(targets, input.codexHome, path.join(input.codexHome, 'config.toml'));
  addConfigTarget(targets, input.globalRuntimeRoot, path.join(input.globalRuntimeRoot, '.codex', 'config.toml'));

  for (const target of targets.values()) await reconcileManagedConfigTarget(target, input.fix, report);
  report.rewritten = [...new Set(report.rewritten)].sort();
  report.preserved_user_configs = [...new Set(report.preserved_user_configs)].sort();
  report.errors = [...new Set(report.errors)].sort();
  report.ok = report.remaining_count === 0 && report.error_count === 0;
  return report;
}

function addConfigTarget(
  targets: Map<string, { ownerRoot: string; configPath: string }>,
  ownerRoot: string,
  configPath: string
): void {
  const key = path.resolve(configPath);
  if (!targets.has(key)) targets.set(key, { ownerRoot: path.resolve(ownerRoot), configPath: key });
}

async function reconcileManagedConfigTarget(
  target: { ownerRoot: string; configPath: string },
  fix: boolean,
  report: ManagedConfigConvergenceReport
): Promise<void> {
  let stat;
  try {
    stat = await fsp.lstat(target.configPath);
  } catch (error: unknown) {
    if (nodeErrorCode(error) === 'ENOENT') return;
    recordConfigError(report, target.configPath, error);
    return;
  }
  report.scanned_count += 1;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    report.preserved_user_config_count += 1;
    report.preserved_user_configs.push(target.configPath);
    return;
  }
  const before = await readText(target.configPath, '');
  const ownership = await managedConfigOwnershipProof(target.ownerRoot, target.configPath, before);
  const retiredConfig = reconcileRetiredSksConfigText(before);
  const retiredApplied = !(retiredConfig.user_authored_conflict && !ownership);
  let next = retiredApplied ? retiredConfig.text : before;
  let retiredMcpCount = 0;
  if (ownership) {
    for (const server of RETIRED_SKS_MCP_SERVERS) {
      if (!mcpServerBlockWithChildren(next, server)) continue;
      next = removeMcpServerBlock(next, server);
      retiredMcpCount += 1;
    }
  }
  // Provenance markers are SKS-authored by exact signature, so compacting the
  // append-per-move pile to the newest line needs no wider ownership proof.
  const compacted = compactSksMovedConfigMarkers(next);
  const markerCount = compacted.removed_count;
  next = compacted.text;
  const retiredConfigCount = retiredApplied && retiredConfig.detected_count > 0 ? retiredConfig.detected_count : 0;
  const detectedCount = retiredConfigCount + retiredMcpCount + markerCount;
  if (retiredConfig.user_authored_conflict && !ownership) {
    report.preserved_user_config_count += 1;
    report.preserved_user_configs.push(target.configPath);
  }
  if (!detectedCount) return;
  report.detected_count += detectedCount;
  report.retired_config_entry_count += retiredConfigCount;
  report.retired_mcp_block_count += retiredMcpCount;
  report.compacted_marker_line_count += markerCount;
  if (!fix) {
    report.remaining_count += detectedCount;
    return;
  }
  if (!validateCodexConfigRoundTrip(next).ok) {
    recordConfigError(report, target.configPath, new Error('legacy_convergence_config_validation_failed'));
    report.remaining_count += detectedCount;
    return;
  }
  try {
    const normalized = normalizeConfigText(next);
    const exactRetiredConfigAuthorized = (retiredConfig.detected_count > 0
      && retiredConfig.user_authored_conflict !== true)
      || markerCount > 0;
    const guarded = await writeCodexConfigGuarded({
      root: target.ownerRoot,
      configPath: target.configPath,
      before,
      cause: 'legacy-generation-convergence',
      ownershipVerified: ownership || exactRetiredConfigAuthorized,
      preserveFastUiKeys: false,
      verifyUnchangedBeforeWrite: true,
      expectedBeforeExists: true,
      expectedBeforeMode: stat.mode & 0o777,
      mutate: () => normalized
    });
    if (!guarded.ok) throw new Error(`legacy_convergence_config_write_refused:${guarded.status}`);
    if (guarded.expected_after?.text !== normalized) {
      throw new Error('legacy_convergence_config_write_verification_failed');
    }
    report.rewritten_count += 1;
    report.rewritten.push(target.configPath);
  } catch (error: unknown) {
    recordConfigError(report, target.configPath, error);
    report.remaining_count += detectedCount;
  }
}

async function managedConfigOwnershipProof(ownerRoot: string, configPath: string, text: string): Promise<boolean> {
  if (hasExplicitSksManagedCodexConfigMarker(text)) return true;
  const relative = path.relative(ownerRoot, configPath).split(path.sep).join('/');
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) return false;
  const manifest: any = await readJson(path.join(ownerRoot, '.sneakoscope', 'manifest.json'), null);
  return manifest?.generated_files?.generated_by === 'sneakoscope'
    && manifest.generated_files.prune_policy === GENERATED_PRUNE_POLICY
    && Array.isArray(manifest.generated_files.files)
    && manifest.generated_files.files.includes(relative);
}

function normalizeConfigText(text: string): string {
  const value = String(text || '').trimEnd().replace(/\n{3,}/g, '\n\n');
  return value ? `${value}\n` : '';
}

const SKS_MOVED_MARKER_LINE = /^\s*#\s*SKS moved machine-local Codex config\b/i;

/**
 * Collapses the append-per-move provenance comments to the newest one. The
 * project-config splitter strips prior markers from the PROJECT file before
 * adding a fresh one, but the machine-local destination accumulated one line
 * per move (60+ on long-lived machines); only the newest carries information.
 */
function compactSksMovedConfigMarkers(text: string): { text: string; removed_count: number } {
  const lines = String(text || '').split('\n');
  const markerIndexes = lines.flatMap((line, index) => (SKS_MOVED_MARKER_LINE.test(line) ? [index] : []));
  if (markerIndexes.length < 2) return { text, removed_count: 0 };
  const keep = markerIndexes[markerIndexes.length - 1];
  const kept = lines.filter((line, index) => !SKS_MOVED_MARKER_LINE.test(line) || index === keep);
  return { text: kept.join('\n'), removed_count: markerIndexes.length - 1 };
}

function recordConfigError(report: ManagedConfigConvergenceReport, file: string, error: unknown): void {
  report.error_count += 1;
  report.errors.push(`${file}:${error instanceof Error ? error.message : String(error)}`);
}

function nodeErrorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
}
