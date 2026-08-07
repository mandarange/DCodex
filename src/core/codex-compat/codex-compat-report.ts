import { projectRoot } from '../fsx.js';
import { detectCodexCurrentCapability } from '../codex-control/codex-current-capability.js';
import { codexVersionReport } from './codex-version.js';
import {
  CODEX_COMPAT_SCHEMA,
  CODEX_HOOK_SCHEMA_BASELINE_TAG,
  CODEX_REQUIRED_BASELINE_TAG
} from './codex-version-policy.js';
import { CURRENT_CODEX_RUNTIME_CONTRACT } from './codex-runtime-contract.js';
import { codexSchemaSnapshotReport } from './codex-schema-snapshot.js';
import { codexHookWarningCheck } from './codex-hook-warning-detector.js';

/**
 * Current-release compatibility report.
 *
 * SKS intentionally does not aggregate superseded per-version matrices here.
 * Update/doctor converge the project to the package-tracked Codex dependency
 * graph and this report validates that contract against the resolved runtime.
 */
export async function codexCompatibilityReport(opts: any = {}) {
  const root = opts.root || await projectRoot();
  const requiredBaseline = opts.requiredBaseline || opts.require || CODEX_REQUIRED_BASELINE_TAG;
  const version = await codexVersionReport({ ...opts, requiredBaseline });
  const releaseContract = {
    ok: true,
    dependency_source: CURRENT_CODEX_RUNTIME_CONTRACT.dependencySource,
    contract: CURRENT_CODEX_RUNTIME_CONTRACT
  };
  const snapshot = await codexSchemaSnapshotReport();
  const hooks = await codexHookWarningCheck(root, { recordWrongness: false });
  const current = await detectCodexCurrentCapability({
    root,
    codexBin: opts.codexBin || null,
    requireReal: opts.requireReal === true
  });
  const ok = Boolean(version.policy.ok && snapshot.ok && hooks.ok && current.ok);

  return {
    schema: CODEX_COMPAT_SCHEMA,
    required_baseline: requiredBaseline,
    release_contract: releaseContract,
    detected: version.detected,
    current_capability: current,
    capabilities: current.feature_states,
    hooks_schema: {
      snapshot: CODEX_HOOK_SCHEMA_BASELINE_TAG,
      ok: snapshot.ok,
      files: snapshot.files.length,
      metadata: {
        upstream: snapshot.metadata?.upstream || null,
        tag: snapshot.metadata?.tag || null,
        commit: snapshot.metadata?.commit || null,
        captured_at: snapshot.metadata?.captured_at || null
      }
    },
    hooks_semantic: {
      ok: hooks.ok,
      warnings_count: hooks.warnings_count,
      issues_by_category: hooks.issues_by_category,
      events: hooks.events
    },
    ok,
    status: ok ? version.policy.status : 'blocked',
    warnings: [
      ...version.policy.warnings,
      ...current.warnings,
      ...(hooks.ok ? [] : hooks.warnings)
    ],
    blockers: [
      ...(version.policy.ok ? [] : ['codex_version_policy_failed']),
      ...(snapshot.ok ? [] : ['codex_hook_schema_snapshot_invalid']),
      ...(hooks.ok ? [] : ['codex_hook_semantic_warning']),
      ...current.blockers
    ],
    root
  };
}

export async function codexDoctorReport(opts: any = {}) {
  const root = opts.root || await projectRoot();
  const compatibility = await codexCompatibilityReport({ ...opts, root });
  const hooks = await codexHookWarningCheck(root, { recordWrongness: false });
  const ok = compatibility.ok && hooks.ok;
  return {
    schema: 'sks.codex-doctor.v1',
    ok,
    compatibility,
    hooks
  };
}
