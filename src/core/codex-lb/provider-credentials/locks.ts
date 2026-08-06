import os from 'node:os';
import path from 'node:path';
import type { BridgeProviderId } from '../bridge-contracts.js';
import { withFileLock } from '../../locks/file-lock.js';

export function withProviderCredentialLock<T>(
  home: string | undefined,
  providerId: BridgeProviderId,
  action: () => Promise<T>,
): Promise<T> {
  const resolvedHome = path.resolve(home || process.env.HOME || os.homedir());
  return withFileLock({
    lockPath: path.join(resolvedHome, '.codex', 'sks', 'locks', `provider-credential-${providerId}.lock`),
    timeoutMs: 10_000,
    staleMs: 60_000,
  }, action);
}
