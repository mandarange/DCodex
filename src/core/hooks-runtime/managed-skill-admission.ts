import {
  resolveAuthoritativeSksSkillSources,
  type ManagedSkillDigestRecoveryReport,
  type SksSkillSourceResolution
} from '../codex-native/sks-skill-paths.js';
import {
  healAuthoritativeManagedSkillDigestMismatches,
  managedSkillResolutionIsHealable
} from './managed-skill-generation-heal.js';

export type ManagedSkillAdmissionRepairMode =
  | 'none'
  | 'stale-generation';

export interface ManagedSkillAdmissionDependencies {
  resolveSources: typeof resolveAuthoritativeSksSkillSources;
  repairGeneration: typeof healAuthoritativeManagedSkillDigestMismatches;
}

const DEFAULT_DEPENDENCIES: ManagedSkillAdmissionDependencies = {
  resolveSources: resolveAuthoritativeSksSkillSources,
  repairGeneration: healAuthoritativeManagedSkillDigestMismatches
};

const VERIFIED_GENERATION_RECOVERY_REASONS = new Set([
  'version_mismatch',
  'manifest_missing',
  'manifest_digest_mismatch',
  'installed_content_mismatch'
]);

/**
 * Admission is the only ordinary hook boundary allowed to repair a managed
 * skill. The lower-level Codex-native resolver intentionally remains
 * read-only so diagnostics and feature probes cannot mutate global state.
 */
export async function resolveManagedSkillSourcesForAdmission(input: {
  root: string;
  skillNames: readonly unknown[];
  home?: string;
  codexHome?: string;
  repairMode?: ManagedSkillAdmissionRepairMode;
}, dependencies: ManagedSkillAdmissionDependencies = DEFAULT_DEPENDENCIES): Promise<SksSkillSourceResolution> {
  const resolution = await dependencies.resolveSources(input);
  const repairMode = input.repairMode || 'stale-generation';
  if (repairMode === 'none' || !managedSkillResolutionIsHealable(resolution)) {
    return resolution;
  }

  const recovery = await dependencies.repairGeneration({
    root: input.root,
    ...(input.home !== undefined ? { home: input.home } : {}),
    resolution,
    generationOnly: true
  });
  const rechecked = await dependencies.resolveSources(input);
  if (!recoveryVerifiesWholeGeneration(resolution, recovery)) {
    return { ...resolution, recovery };
  }
  return { ...rechecked, recovery };
}

function recoveryVerifiesWholeGeneration(
  resolution: SksSkillSourceResolution,
  recovery: ManagedSkillDigestRecoveryReport
): boolean {
  if (recovery?.attempted !== true
    || !Number.isSafeInteger(recovery.healed_count)
    || !Array.isArray(recovery.attempts)) {
    return false;
  }

  const unresolved = new Set(resolution.unresolved);
  const blockers = new Set(resolution.blockers);
  const expectedAttempts = new Set(resolution.issues
    .filter((issue) => (
      issue.reason === 'content_digest_mismatch'
      && issue.scope === 'global'
      && unresolved.has(issue.canonical_name)
      && blockers.has(`content_digest_mismatch:${issue.canonical_name}:global`)
    ))
    .map((issue) => `${issue.canonical_name}\0${issue.path}`));
  if (!expectedAttempts.size
    || recovery.healed_count !== expectedAttempts.size
    || recovery.attempts.length !== expectedAttempts.size) {
    return false;
  }

  const verifiedAttempts = new Set<string>();
  for (const attempt of recovery.attempts) {
    const reason = String(attempt?.reason || '');
    const reasonPrefix = 'stale_global_generation_reconciled:';
    const generationReason = reason.startsWith(reasonPrefix)
      ? reason.slice(reasonPrefix.length)
      : '';
    const key = `${String(attempt?.canonical_skill || '')}\0${String(attempt?.original_path || '')}`;
    if (attempt?.status !== 'healed'
      || !VERIFIED_GENERATION_RECOVERY_REASONS.has(generationReason)
      || !expectedAttempts.has(key)
      || verifiedAttempts.has(key)) {
      return false;
    }
    verifiedAttempts.add(key);
  }
  return verifiedAttempts.size === expectedAttempts.size;
}
