import { PACKAGE_VERSION } from '../core/version.js';

export function sksTextLogo() {
  return `SKS\nSNEAKOSCOPE CODEX v${PACKAGE_VERSION}`;
}

export function printJson(value: unknown, options: { failureExitCode?: boolean } = {}): void {
  if (options.failureExitCode !== false && value && typeof value === 'object' && (value as { ok?: unknown }).ok === false) {
    const current = Number(process.exitCode || 0);
    if (!Number.isFinite(current) || current === 0) process.exitCode = 1;
  }
  console.log(JSON.stringify(value, null, 2));
}
