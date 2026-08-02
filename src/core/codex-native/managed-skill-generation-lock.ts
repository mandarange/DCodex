import path from 'node:path';
import { withFileLock } from '../locks/file-lock.js';

export function managedSkillGenerationLockPath(
  ownerRoot: string,
  scope: 'global' | 'project'
): string {
  const stateDir = scope === 'global' ? '.sneakoscope-global' : '.sneakoscope';
  return path.join(
    path.resolve(ownerRoot),
    stateDir,
    'locks',
    'managed-skill-generation.lock'
  );
}

export function withManagedSkillGenerationLock<T>(
  ownerRoot: string,
  scope: 'global' | 'project',
  run: () => Promise<T>
): Promise<T> {
  return withFileLock({
    lockPath: managedSkillGenerationLockPath(ownerRoot, scope),
    timeoutMs: 30_000,
    staleMs: 20_000
  }, run);
}
