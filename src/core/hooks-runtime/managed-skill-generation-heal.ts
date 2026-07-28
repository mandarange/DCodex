import os from 'node:os';
import path from 'node:path';
import { PACKAGE_VERSION, readJson } from '../fsx.js';
import type { SksSkillSourceResolution } from '../codex-native/sks-skill-paths.js';

// Statuses that a global skill reconcile can actually repair. Anything else
// (unsafe symlinks, non-regular files, missing packaged digests) stays fail
// closed instead of being written over by an automatic repair.
const HEALABLE_BLOCKER_STATUSES = new Set([
  'content_digest_mismatch',
  'canonical_name_mismatch',
  'not_sks_managed'
]);

export interface StaleGlobalManagedSkillGeneration {
  home: string;
  installed_version: string;
  runtime_version: string;
}

const healedGenerations = new Map<string, Promise<StaleGlobalManagedSkillGeneration | null>>();

export function managedSkillResolutionIsHealable(resolution: SksSkillSourceResolution | null): boolean {
  if (!resolution) return false;
  const blockers = resolution.blockers || [];
  if (blockers.some((blocker) => !HEALABLE_BLOCKER_STATUSES.has(String(blocker).split(':')[0] || ''))) return false;
  return Boolean(resolution.unresolved.length || blockers.length);
}

export async function staleGlobalManagedSkillGeneration(
  home?: string
): Promise<StaleGlobalManagedSkillGeneration | null> {
  const resolvedHome = path.resolve(home || process.env.HOME || os.homedir());
  const marker: any = await readJson(
    path.join(resolvedHome, '.agents', 'skills', '.sks-generated.json'),
    null
  );
  if (String(marker?.generated_by || '') !== 'sneakoscope') return null;
  const installedVersion = String(marker?.version || '').trim();
  if (!installedVersion || installedVersion === PACKAGE_VERSION) return null;
  return { home: resolvedHome, installed_version: installedVersion, runtime_version: PACKAGE_VERSION };
}

export async function healStaleGlobalManagedSkillGeneration(
  home?: string
): Promise<StaleGlobalManagedSkillGeneration | null> {
  const stale = await staleGlobalManagedSkillGeneration(home);
  if (!stale) return null;
  const cached = healedGenerations.get(stale.home);
  if (cached) return cached;
  const work = (async () => {
    const { reconcileSkills } = await import('../init/skills.js');
    const report: any = await reconcileSkills({
      targetDir: path.join(stale.home, '.agents', 'skills'),
      scope: 'global',
      fix: true
    }).catch(() => null);
    return report?.ok === true ? stale : null;
  })();
  healedGenerations.set(stale.home, work);
  return work;
}
