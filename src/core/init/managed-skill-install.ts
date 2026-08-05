import path from 'node:path';
import os from 'node:os';
import { ensureDir } from '../fsx.js';
import { AUTHORITATIVE_SKS_SKILL_ROOT_REFERENCE } from '../codex-native/sks-skill-paths.js';
import type { SkillReconcileReport } from './skills.js';
import {
  reconcileLegacyManagedGeneration,
  type LegacyGenerationConvergenceReport
} from './legacy-generation-convergence.js';

export type ManagedSkillInstallReport = SkillReconcileReport & {
  project_residue_reconcile?: SkillReconcileReport;
  legacy_generation_convergence?: LegacyGenerationConvergenceReport;
};

function mergedStrings(left: unknown, right: unknown): string[] {
  return [...new Set([
    ...(Array.isArray(left) ? left.map(String) : []),
    ...(Array.isArray(right) ? right.map(String) : [])
  ])];
}

export async function reconcileManagedSkillInstallation(root: string, home?: string): Promise<{
  skillInstall: ManagedSkillInstallReport;
  created: string[];
}> {
  const globalSkillHome = path.resolve(home || process.env.HOME || os.homedir());
  await ensureDir(globalSkillHome);

  const convergence = await reconcileLegacyManagedGeneration({
    root,
    home: globalSkillHome,
    fix: true
  });
  if (!('schema' in convergence.global_skills)) {
    throw new Error(`authoritative_global_skill_reconcile_failed:${convergence.global_skills.error}`);
  }
  // Keep the convergence report and the public skill-install result as
  // separate objects. `convergence.global_skills` is already owned by the
  // convergence report; attaching the report back onto that same object would
  // create `global_skills -> legacy_generation_convergence -> global_skills`
  // and make bootstrap/setup JSON output impossible to serialize.
  const skillInstall: ManagedSkillInstallReport = { ...convergence.global_skills };
  const projectSkillCleanup = convergence.project_skills.find((report): report is SkillReconcileReport => (
    'schema' in report && path.resolve(report.target_dir) === path.resolve(root, '.agents', 'skills')
  )) || null;
  skillInstall.legacy_generation_convergence = convergence;
  const created: string[] = [];

  if (projectSkillCleanup) {
    skillInstall.ok = skillInstall.ok && projectSkillCleanup.ok;
    skillInstall.warnings = mergedStrings(skillInstall.warnings, projectSkillCleanup.warnings);
    skillInstall.removed = mergedStrings(skillInstall.removed, projectSkillCleanup.removed);
    skillInstall.quarantined_user_collisions = mergedStrings(
      skillInstall.quarantined_user_collisions,
      projectSkillCleanup.quarantined_user_collisions
    );
    skillInstall.removed_stale_generated_skills = mergedStrings(
      skillInstall.removed_stale_generated_skills,
      projectSkillCleanup.removed_stale_generated_skills
    );
    skillInstall.project_residue_reconcile = projectSkillCleanup;
    created.push('.agents/skills official residue reconciled');
  }

  created.push(`${AUTHORITATIVE_SKS_SKILL_ROOT_REFERENCE}/sks-*`);
  const removedStaleGeneratedSkills = skillInstall.removed_stale_generated_skills || skillInstall.removed || [];
  const removedAgentSkillAliases = skillInstall.removed_agent_skill_aliases || [];
  const removedCodexSkillMirrors = skillInstall.removed_codex_skill_mirrors || [];
  if (removedStaleGeneratedSkills.length) created.push(`stale generated skills removed (${removedStaleGeneratedSkills.length})`);
  if (removedAgentSkillAliases.length) created.push(`deprecated generated skill aliases removed (${removedAgentSkillAliases.length})`);
  if (removedCodexSkillMirrors.length) created.push(`.codex/skills generated mirrors removed (${removedCodexSkillMirrors.length})`);
  if (convergence.retired_agent_roles.removed_count) created.push(`retired SKS-owned agent roles removed (${convergence.retired_agent_roles.removed_count})`);
  if (convergence.managed_configs.rewritten_count) created.push(`retired SKS-owned config/MCP entries reconciled (${convergence.managed_configs.detected_count})`);
  const removedRuntimeAssets = convergence.retired_runtime_scopes.reduce(
    (sum, report) => sum + report.removed_managed_artifact_count,
    0
  );
  if (removedRuntimeAssets) created.push(`retired SKS-owned runtime assets removed (${removedRuntimeAssets})`);
  return { skillInstall, created };
}
