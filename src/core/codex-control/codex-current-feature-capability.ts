import path from 'node:path';
import { findCodexBinary } from '../codex-adapter.js';
import { compareSemverLike, parseCodexVersionText } from '../codex-compat/codex-version-policy.js';
import { CURRENT_CODEX_RELEASE_MANIFEST } from '../codex-compat/codex-release-manifest.js';
import { nowIso, runProcess, writeJsonAtomic } from '../fsx.js';
import {
  CODEX_CURRENT_FEATURE_FEATURE_KEYS,
  probeCodexCurrentFeatureFeatureDetails,
  probeCodexCurrentFeatureFeatures,
  type CodexCurrentFeatureFeatureKey,
  type CodexCurrentFeatureFeatureProbeDetails,
  type CodexCurrentFeatureFeatureProbeResults,
  type CodexCurrentFeatureProbeCertainty
} from './codex-current-feature-probes.js';

export type CodexCurrentFeatureFeatureCertainty =
  | 'actual'
  | 'discovered'
  | 'assumed_by_version'
  | 'fixture'
  | 'unverified'
  | 'failed';

export interface CodexCurrentFeatureFeatureState {
  supported: boolean;
  certainty: CodexCurrentFeatureFeatureCertainty;
  evidence: string[];
  blockers: string[];
}

export interface CodexCurrentFeatureCapability {
  schema: 'sks.codex-current-feature-capability.v1';
  generated_at: string;
  ok: boolean;
  codex_version: string | null;
  supports_current_contract: boolean;
  features: {
    usage_views: boolean;
    goal_attachment_preservation: boolean;
    session_delete: boolean;
    import_command: boolean;
    unified_mentions: boolean;
    bedrock_managed_auth: boolean;
    sqlite_auto_recovery: boolean;
    mcp_reliability: boolean;
    non_tty_interrupt: boolean;
    large_repo_responsiveness: boolean;
  };
  feature_states: Record<CodexCurrentFeatureFeatureKey, CodexCurrentFeatureFeatureState>;
  feature_certainty: Record<CodexCurrentFeatureFeatureKey, CodexCurrentFeatureFeatureCertainty>;
  blockers: string[];
  warnings: string[];
  codex_bin?: string | null;
  probe_mode?: 'version-only' | 'feature-probe';
  feature_probe_results?: CodexCurrentFeatureFeatureProbeResults;
  feature_probe_details?: CodexCurrentFeatureFeatureProbeDetails;
}

export async function detectCodexCurrentFeatureCapability(input: { codexBin?: string | null } = {}): Promise<CodexCurrentFeatureCapability> {
  const fake = process.env.SKS_CODEX_CURRENT_FEATURE_FAKE === '1';
  const codexBin = fake ? input.codexBin || process.env.CODEX_BIN || 'codex' : input.codexBin || process.env.CODEX_BIN || await findCodexBinary();
  const versionText = fake ? String(process.env.SKS_CODEX_VERSION_FAKE || `codex-cli ${CURRENT_CODEX_RELEASE_MANIFEST.requiredCliVersion}`) : await readCodexVersionText(codexBin);
  const parsed = parseCodexVersionText(versionText);
  const supportsCurrentContract = Boolean(parsed && compareSemverLike(parsed, CURRENT_CODEX_RELEASE_MANIFEST.requiredCliVersion) >= 0);
  const probeMode = process.env.SKS_CODEX_CURRENT_FEATURE_PROBE === '1' ? 'feature-probe' : 'version-only';
  const probeTimeoutMs = Number(process.env.SKS_CODEX_CURRENT_FEATURE_PROBE_TIMEOUT_MS || 3000);
  const probeDetails = probeMode === 'feature-probe'
    ? await probeCodexCurrentFeatureFeatureDetails(codexBin, { fake, timeoutMs: probeTimeoutMs })
    : null;
  const probeResults = probeDetails
    ? Object.fromEntries(CODEX_CURRENT_FEATURE_FEATURE_KEYS.map((key) => [key, probeDetails[key].status])) as CodexCurrentFeatureFeatureProbeResults
    : Object.fromEntries(CODEX_CURRENT_FEATURE_FEATURE_KEYS.map((key) => [key, 'skipped'])) as CodexCurrentFeatureFeatureProbeResults;
  const featureStates = Object.fromEntries(CODEX_CURRENT_FEATURE_FEATURE_KEYS.map((key) => [key, featureStateFor(key, supportsCurrentContract, probeMode, probeDetails)])) as Record<CodexCurrentFeatureFeatureKey, CodexCurrentFeatureFeatureState>;
  const featureCertainty = Object.fromEntries(CODEX_CURRENT_FEATURE_FEATURE_KEYS.map((key) => [key, featureStates[key].certainty])) as Record<CodexCurrentFeatureFeatureKey, CodexCurrentFeatureFeatureCertainty>;
  const featureOk = (key: keyof CodexCurrentFeatureCapability['features']) => featureStates[key].supported;
  const features = {
    usage_views: featureOk('usage_views'),
    goal_attachment_preservation: featureOk('goal_attachment_preservation'),
    session_delete: featureOk('session_delete'),
    import_command: featureOk('import_command'),
    unified_mentions: featureOk('unified_mentions'),
    bedrock_managed_auth: featureOk('bedrock_managed_auth'),
    sqlite_auto_recovery: featureOk('sqlite_auto_recovery'),
    mcp_reliability: featureOk('mcp_reliability'),
    non_tty_interrupt: featureOk('non_tty_interrupt'),
    large_repo_responsiveness: featureOk('large_repo_responsiveness')
  };
  const failed = Object.entries(featureStates).flatMap(([key, state]) => state.certainty === 'failed' ? [`codex_current_feature_${key}_probe_failed`] : []);
  const assumedWarnings = Object.entries(featureStates)
    .filter(([, state]) => state.certainty === 'assumed_by_version')
    .map(([key]) => `codex_current_feature_${key}_assumed_by_version`);
  const unverifiedWarnings = Object.entries(featureStates)
    .filter(([, state]) => state.certainty === 'unverified')
    .map(([key]) => `codex_current_feature_${key}_unverified`);
  const blockers = [
    ...(!codexBin ? ['codex_cli_missing'] : []),
    ...(supportsCurrentContract ? [] : ['codex_current_release_required_for_features']),
    ...(probeMode === 'feature-probe' ? failed : [])
  ];
  const report: CodexCurrentFeatureCapability = {
    schema: 'sks.codex-current-feature-capability.v1',
    generated_at: nowIso(),
    ok: blockers.length === 0,
    codex_version: parsed,
    supports_current_contract: supportsCurrentContract,
    features,
    feature_states: featureStates,
    feature_certainty: featureCertainty,
    blockers,
    warnings: [...assumedWarnings, ...unverifiedWarnings],
    codex_bin: codexBin || null,
    probe_mode: probeMode,
    feature_probe_results: probeResults
  };
  if (probeDetails) report.feature_probe_details = probeDetails;
  return report;
}

function featureStateFor(
  key: CodexCurrentFeatureFeatureKey,
  supportsCurrentContract: boolean,
  probeMode: 'version-only' | 'feature-probe',
  probeDetails: CodexCurrentFeatureFeatureProbeDetails | null
): CodexCurrentFeatureFeatureState {
  if (!supportsCurrentContract) {
    return {
      supported: false,
      certainty: 'failed',
      evidence: [],
      blockers: ['codex_current_release_required_for_features']
    };
  }
  if (probeMode === 'version-only') {
    return {
      supported: true,
      certainty: 'assumed_by_version',
      evidence: [`codex_version>=${CURRENT_CODEX_RELEASE_MANIFEST.requiredCliVersion}`],
      blockers: []
    };
  }
  const detail = probeDetails?.[key];
  if (!detail) {
    return {
      supported: false,
      certainty: 'unverified',
      evidence: [],
      blockers: [`codex_current_feature_${key}_probe_missing`]
    };
  }
  if (detail.status === 'failed') {
    return {
      supported: false,
      certainty: 'failed',
      evidence: detail.evidence,
      blockers: detail.blockers.length ? detail.blockers : [`codex_current_feature_${key}_probe_failed`]
    };
  }
  const certainty = normalizeCertainty(detail.certainty);
  const supported = detail.status === 'passed' || detail.status === 'discovered';
  return {
    supported,
    certainty: supported ? certainty : 'unverified',
    evidence: detail.evidence,
    blockers: supported ? [] : detail.blockers
  };
}

function normalizeCertainty(certainty: CodexCurrentFeatureProbeCertainty): CodexCurrentFeatureFeatureCertainty {
  if (certainty === 'actual' || certainty === 'discovered' || certainty === 'fixture' || certainty === 'assumed_by_version') return certainty;
  return 'unverified';
}

export async function writeCodexCurrentFeatureCapabilityArtifacts(root: string, input: { missionId?: string | null; codexBin?: string | null } = {}) {
  const report = await detectCodexCurrentFeatureCapability({ codexBin: input.codexBin || null });
  const rootArtifact = path.join(root, '.sneakoscope', 'codex-current-feature-capability.json');
  await writeJsonAtomic(rootArtifact, report);
  let missionArtifact: string | null = null;
  if (input.missionId) {
    missionArtifact = path.join(root, '.sneakoscope', 'missions', input.missionId, 'codex-current-feature-capability.json');
    await writeJsonAtomic(missionArtifact, report);
  }
  return { report, root_artifact: rootArtifact, mission_artifact: missionArtifact };
}

async function readCodexVersionText(codexBin: string | null): Promise<string | null> {
  if (!codexBin) return null;
  const result = await runProcess(codexBin, ['--version'], { timeoutMs: 10_000, maxOutputBytes: 16 * 1024 }).catch((err: any) => ({
    code: 1,
    stdout: '',
    stderr: err?.message || String(err)
  }));
  const text = `${result.stdout || ''}${result.stderr || ''}`.trim();
  return result.code === 0 ? text : text || null;
}
