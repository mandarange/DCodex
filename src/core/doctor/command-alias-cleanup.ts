import os from 'node:os';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { COMMAND_CATALOG } from '../routes.js';
import { nowIso, writeJsonAtomic } from '../fsx.js';
import { cleanupRemovedSksSkillResidue, type RemovedSksSkillResidueReport } from '../init/skills.js';
import { COMMANDS, LEGACY_COMMAND_ALIASES, commandNames } from '../../cli/command-registry.js';
import { REMOVED_PUBLIC_COMMANDS } from './retired-managed-residue-private.js';
import { reconcileRetiredManagedResidue, RETIRED_MANAGED_RESIDUE_SCHEMA, type RetiredManagedResidueReport } from './retired-managed-residue.js';
import { CURRENT_PROJECT_GUIDANCE_SCHEMA, reconcileCurrentProjectGuidance, type CurrentProjectGuidanceReport } from './current-project-guidance.js';
import {
  reconcileSkillLegacySurface,
  SKILL_LEGACY_SURFACE_SCHEMA,
  type SkillLegacySurfaceReport
} from './skill-legacy-surface.js';

export const COMMAND_ALIAS_CLEANUP_SCHEMA = 'sks.command-alias-cleanup.v1';

export interface DoctorCommandAliasCleanupOptions {
  root: string;
  home?: string;
  globalRuntimeRoot?: string;
  env?: NodeJS.ProcessEnv;
  fix?: boolean;
}

export async function runDoctorCommandAliasCleanup(opts: DoctorCommandAliasCleanupOptions) {
  const home = path.resolve(opts.home || opts.env?.HOME || process.env.HOME || os.homedir());
  const globalRuntimeRoot = path.resolve(
    opts.globalRuntimeRoot
      || opts.env?.SKS_GLOBAL_ROOT
      || (opts.home || opts.env ? '' : process.env.SKS_GLOBAL_ROOT || '')
      || path.join(home, '.sneakoscope-global')
  );
  const skillResidue = await cleanupRemovedSksSkillResidue({
    root: opts.root,
    home,
    globalRuntimeRoot,
    fix: opts.fix === true
  });
  const skillLegacySurface = await reconcileSkillLegacySurface({
    root: opts.root,
    home,
    globalRuntimeRoot,
    fix: opts.fix === true
  });
  const [managedResidue, projectGuidance] = await Promise.all([
    reconcileManagedRuntimeScopes({
      projectRoot: opts.root,
      home,
      globalRuntimeRoot,
      fix: opts.fix === true
    }),
    reconcileCurrentProjectGuidance({
      root: opts.root,
      home,
      globalRuntimeRoot,
      fix: opts.fix === true
    })
  ]);
  const report = commandAliasCleanupReport(opts, skillResidue, managedResidue, projectGuidance, skillLegacySurface);
  if (opts.fix) await writeJsonAtomic(report.report_path, report);
  return report;
}

async function reconcileManagedRuntimeScopes(input: {
  projectRoot: string;
  home: string;
  globalRuntimeRoot: string;
  fix: boolean;
}): Promise<RetiredManagedResidueReport> {
  const roots = [...new Set([
    input.projectRoot,
    input.home,
    input.globalRuntimeRoot
  ].map((root) => path.resolve(root)))];
  const reports = await Promise.all(roots.map((root) => reconcileManagedRuntimeScope(root, input.fix)));
  return {
    schema: RETIRED_MANAGED_RESIDUE_SCHEMA,
    ok: reports.every((report) => report.ok),
    fix: input.fix,
    detected_managed_artifact_count: sumManagedResidue(reports, 'detected_managed_artifact_count'),
    removed_managed_artifact_count: sumManagedResidue(reports, 'removed_managed_artifact_count'),
    rewritten_state_file_count: sumManagedResidue(reports, 'rewritten_state_file_count'),
    agent_bridge_manifest: aggregateAgentBridgeManifest(reports),
    preserved_user_file_count: sumManagedResidue(reports, 'preserved_user_file_count'),
    remaining_managed_artifact_count: sumManagedResidue(reports, 'remaining_managed_artifact_count'),
    error_count: sumManagedResidue(reports, 'error_count')
  };
}

async function reconcileManagedRuntimeScope(root: string, fix: boolean): Promise<RetiredManagedResidueReport> {
  try {
    await fsp.lstat(root);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return emptyManagedResidue(fix);
  }
  return reconcileRetiredManagedResidue({ root, fix });
}

function sumManagedResidue(
  reports: RetiredManagedResidueReport[],
  key: 'detected_managed_artifact_count'
    | 'removed_managed_artifact_count'
    | 'rewritten_state_file_count'
    | 'preserved_user_file_count'
    | 'remaining_managed_artifact_count'
    | 'error_count'
): number {
  return reports.reduce((sum, report) => sum + report[key], 0);
}

function aggregateAgentBridgeManifest(
  reports: RetiredManagedResidueReport[]
): RetiredManagedResidueReport['agent_bridge_manifest'] {
  const statuses = reports.map((report) => report.agent_bridge_manifest);
  for (const status of [
    'user_collision_preserved',
    'user_collision_quarantined',
    'would_reconcile',
    'reconciled',
    'current'
  ] as const) {
    if (statuses.includes(status)) return status;
  }
  return 'absent';
}

export function commandAliasCleanupReport(
  opts: DoctorCommandAliasCleanupOptions,
  skillResidue: RemovedSksSkillResidueReport = emptySkillResidue(Boolean(opts.fix)),
  managedResidue: RetiredManagedResidueReport = emptyManagedResidue(Boolean(opts.fix)),
  projectGuidance: CurrentProjectGuidanceReport = emptyProjectGuidance(Boolean(opts.fix)),
  skillLegacySurface: SkillLegacySurfaceReport = emptySkillLegacySurface(Boolean(opts.fix))
) {
  const root = opts.root;
  const legacyAliases = Object.entries(LEGACY_COMMAND_ALIASES).map(([alias, canonical]) => ({ alias, canonical }));
  const registeredRemovedCommands = REMOVED_PUBLIC_COMMANDS
    .filter((name) => Object.prototype.hasOwnProperty.call(COMMANDS, name));
  const catalogRemovedCommands = REMOVED_PUBLIC_COMMANDS
    .filter((name) => COMMAND_CATALOG.some((row: any) => row.name === name));
  const redirectingRemovedCommands = REMOVED_PUBLIC_COMMANDS
    .filter((name) => Object.prototype.hasOwnProperty.call(LEGACY_COMMAND_ALIASES, name));
  const canonical = commandNames();
  const missingCanonicalTargets = legacyAliases
    .filter((entry) => !canonical.includes(entry.canonical as any))
    .map((entry) => `${entry.alias}->${entry.canonical}`);
  const blockers = [
    ...(registeredRemovedCommands.length ? [`retired_registry_entries_present:${registeredRemovedCommands.length}`] : []),
    ...(catalogRemovedCommands.length ? [`retired_catalog_entries_present:${catalogRemovedCommands.length}`] : []),
    ...(redirectingRemovedCommands.length ? [`retired_redirect_entries_present:${redirectingRemovedCommands.length}`] : []),
    ...(missingCanonicalTargets.length ? [`current_alias_targets_missing:${missingCanonicalTargets.length}`] : []),
    ...(skillResidue.remaining.length ? [`retired_managed_skill_residue_remaining:${skillResidue.remaining.length}`] : []),
    ...(skillResidue.errors.length ? [`retired_managed_skill_cleanup_failed:${skillResidue.errors.length}`] : []),
    ...(skillLegacySurface.remaining_count ? [`skill_legacy_surface_remaining:${skillLegacySurface.remaining_count}`] : []),
    ...(skillLegacySurface.error_count ? [`skill_legacy_surface_rewrite_failed:${skillLegacySurface.error_count}`] : []),
    ...(managedResidue.remaining_managed_artifact_count ? [`retired_managed_runtime_residue_remaining:${managedResidue.remaining_managed_artifact_count}`] : []),
    ...(managedResidue.error_count ? [`retired_managed_runtime_cleanup_failed:${managedResidue.error_count}`] : []),
    ...(projectGuidance.remaining_count ? [`current_project_guidance_residue_remaining:${projectGuidance.remaining_count}`] : []),
    ...(projectGuidance.error_count ? [`current_project_guidance_reconcile_failed:${projectGuidance.error_count}`] : [])
  ];
  const ok = blockers.length === 0;
  const warnings = projectGuidance.warnings.map((warning) =>
    `${warning.code}:${warning.cutoff_path}:${warning.exceeded_directory_count}`
  );
  return {
    schema: COMMAND_ALIAS_CLEANUP_SCHEMA,
    ok,
    status: ok ? 'clean' : 'blocked',
    generated_at: nowIso(),
    root,
    fix: Boolean(opts.fix),
    report_path: path.join(root, '.sneakoscope', 'reports', 'command-alias-cleanup.json'),
    canonical_command_count: canonical.length,
    current_alias_count: legacyAliases.length,
    aliases: legacyAliases,
    detected: {
      retired_registry_entry_count: registeredRemovedCommands.length,
      retired_catalog_entry_count: catalogRemovedCommands.length,
      retired_redirect_entry_count: redirectingRemovedCommands.length,
      missing_current_alias_target_count: missingCanonicalTargets.length,
      retired_managed_skill_residue_count: skillResidue.detected.length,
      skill_legacy_surface_scanned_count: skillLegacySurface.scanned_count
    },
    cleanup: {
      schema: skillResidue.schema,
      ok: skillResidue.ok && skillLegacySurface.ok,
      fix: skillResidue.fix,
      detected_count: skillResidue.detected.length,
      removed_count: skillResidue.removed.length,
      preserved_user_collision_count: skillResidue.quarantined_user_collisions.length,
      remaining_count: skillResidue.remaining.length + skillLegacySurface.remaining_count,
      error_count: skillResidue.errors.length + skillLegacySurface.error_count,
      managed_runtime: managedResidue,
      project_guidance: projectGuidance,
      skill_legacy_surface: skillLegacySurface
    },
    actions: ok
      ? [{
          action: opts.fix ? 'doctor_fix_reconciled_current_public_surface' : 'verify_current_public_surface',
          ok: true,
          detail: `Current commands are the only public surface; rewritten ${skillLegacySurface.rewritten_count} skill bodies, removed ${skillLegacySurface.removed_other_harness_skill_count} OMX/DCodex skill dirs plus ${skillResidue.removed.length + managedResidue.removed_managed_artifact_count} SKS-managed retired items, reconciled ${projectGuidance.reconciled_count} guidance files, and quarantined ${skillResidue.quarantined_user_collisions.length} user-authored retired-name collisions.`
        }]
      : [{
          action: 'current_public_surface_reconciliation_required',
          ok: false,
          detail: 'Rewrite legacy commands inside skills, remove OMX/DCodex from the live surface, and reconcile retired SKS-managed residue.'
        }],
    warnings,
    blockers
  };
}

function emptyProjectGuidance(fix: boolean): CurrentProjectGuidanceReport {
  return {
    schema: CURRENT_PROJECT_GUIDANCE_SCHEMA,
    ok: true,
    fix,
    detected_count: 0,
    reconciled_count: 0,
    remaining_count: 0,
    preserved_user_file_count: 0,
    error_count: 0,
    warnings: []
  };
}

function emptyManagedResidue(fix: boolean): RetiredManagedResidueReport {
  return {
    schema: RETIRED_MANAGED_RESIDUE_SCHEMA,
    ok: true,
    fix,
    detected_managed_artifact_count: 0,
    removed_managed_artifact_count: 0,
    rewritten_state_file_count: 0,
    agent_bridge_manifest: 'absent',
    preserved_user_file_count: 0,
    remaining_managed_artifact_count: 0,
    error_count: 0
  };
}

function emptySkillResidue(fix: boolean): RemovedSksSkillResidueReport {
  return {
    schema: 'sks.removed-skill-residue.v1',
    ok: true,
    fix,
    detected: [],
    removed: [],
    quarantined_user_collisions: [],
    remaining: [],
    errors: []
  };
}

function emptySkillLegacySurface(fix: boolean): SkillLegacySurfaceReport {
  return {
    schema: SKILL_LEGACY_SURFACE_SCHEMA,
    ok: true,
    fix,
    scanned_count: 0,
    rewritten_count: 0,
    removed_other_harness_skill_count: 0,
    remaining_count: 0,
    preserved_clean_count: 0,
    error_count: 0,
    rewritten: [],
    removed_other_harness_skills: [],
    remaining: [],
    errors: []
  };
}
