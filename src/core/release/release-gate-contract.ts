import crypto from 'node:crypto'

export const RELEASE_GATE_CONTRACT_SCHEMA = 'sks.release-gate-contract.v1'

export const RELEASE_GATE_CONTRACT_IDS: readonly string[] = Object.freeze([
  'architecture:guard',
  'codex:current:app-server-v2',
  'codex:current:binary-identity',
  'codex:current:capability',
  'codex:current:manifest',
  'codex:current:policy',
  'codex:current:thread-store',
  'commands:current-surface-only',
  'config:managed-merge',
  'docs:truthfulness',
  'latest-version:guidance',
  'migration:current-surface-e2e',
  'migration:upgrade-safety',
  'package:published-contract',
  'policy:gate-audit',
  'publish:packlist-performance',
  'publish:runtime-script-closure',
  'release:dag-runner',
  'release:gate-budget',
  'release:latency-slo',
  'release:metadata-current',
  'release:proof-truth',
  'release:provenance',
  'runtime:installed-smoke',
  'safety:mutation-callsite-coverage',
  'schema:check',
  'secret:preservation',
  'side-effect:runtime-report',
  'typecheck'
].sort())

export function releaseGateContractSnapshot() {
  const ids = [...RELEASE_GATE_CONTRACT_IDS]
  const sha256 = crypto
    .createHash('sha256')
    .update(`${RELEASE_GATE_CONTRACT_SCHEMA}\n${ids.join('\n')}\n`)
    .digest('hex')
  return {
    schema: RELEASE_GATE_CONTRACT_SCHEMA,
    ids,
    count: ids.length,
    sha256
  }
}
