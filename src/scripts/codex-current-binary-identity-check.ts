#!/usr/bin/env node
import { assertGate, emitGate } from './gate-lib.js';
import { CURRENT_CODEX_RELEASE_MANIFEST } from '../core/codex-compat/codex-release-manifest.js';
import { compareSemverLike } from '../core/codex-compat/codex-version-policy.js';
import { resolveOfficialCodexPackageRuntime } from '../core/codex-runtime/resolve-codex-runtime.js';

const resolved = await resolveOfficialCodexPackageRuntime({ requestedBy: 'codex-current-binary-identity-check' });
assertGate(resolved.ok && resolved.identity !== null, 'Official Codex runtime identity must resolve', resolved);
const identity = resolved.identity!;
assertGate(
  compareSemverLike(identity.version, CURRENT_CODEX_RELEASE_MANIFEST.requiredCliVersion) >= 0,
  `Codex runtime must satisfy ${CURRENT_CODEX_RELEASE_MANIFEST.requiredCliVersion}`,
  identity
);
assertGate(identity.sha256.length === 64, 'Codex runtime identity must include SHA-256', identity);
assertGate(identity.trusted === true, 'Codex runtime identity must be trusted before execution', identity);
assertGate(
  identity.trust_basis === (process.platform === 'darwin'
    ? 'macos_codesign_openai_team_2DC432GLL2'
    : 'official_package_pin'),
  'Codex runtime identity must record the platform trust basis',
  identity
);
emitGate('codex:current:binary-identity', {
  realpath: identity.realpath,
  version: identity.version,
  sha256: identity.sha256,
  source: identity.source,
  trusted: identity.trusted,
  trust_basis: identity.trust_basis
});
