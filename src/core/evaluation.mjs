import { nowIso, sha256 } from './fsx.mjs';
import { contextCapsule } from './triwiki-attention.mjs';
import { validateWikiCoordinateIndex } from './wiki-coordinate.mjs';

export const DEFAULT_EVAL_THRESHOLDS = Object.freeze({
  min_token_savings_pct: 0.25,
  min_accuracy_delta: 0.03,
  min_required_recall: 0.95,
  max_unsupported_critical_selected: 0,
  max_candidate_build_ms_per_run: 25
});

export function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}

function clamp01(x) {
  return Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
}

function timed(fn, iterations) {
  let result;
  const count = Math.max(1, Number(iterations) || 1);
  const start = process.hrtime.bigint();
  for (let i = 0; i < count; i++) result = fn();
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  return { result, ms_per_run: elapsedMs / count, iterations: count };
}

export function defaultEvaluationScenario() {
  const coord = { domainAngle: 0.15, layerRadius: 0.35, phase: 0.1 };
  const required = [
    ['req-contract', 'decision-contract.json must be sealed before Ralph run can execute autonomous work.', 'contract', 'critical', 1.2],
    ['req-db-block', 'destructive database operations such as DROP, TRUNCATE, db reset, and live execute_sql writes are blocked.', 'code', 'critical', 1.4],
    ['req-hook', '.codex/hooks.json routes PreToolUse, PostToolUse, PermissionRequest, UserPromptSubmit, and Stop to sks hook handlers.', 'code', 'high', 1],
    ['req-gx-hash', 'GX render output embeds the normalized vgraph.json source hash so drift can be detected deterministically.', 'test', 'medium', 0.9],
    ['req-wiki-rgba', 'TriWiki stores RGBA-derived trigonometric wiki anchors so compressed context remains hydratable by id, hash, source, and coordinate.', 'code', 'high', 1.2],
    ['req-retention', 'runtime logs and mission artifacts are bounded through retention policy and sks gc.', 'code', 'medium', 0.85],
    ['req-selftest', 'selftest covers contract sealing, DB guard blocking, done-gate evaluation, GX render/validate/drift, snapshot, and retention report.', 'test', 'high', 1.1],
    ['req-skill', 'sks init installs one canonical local skill set under .codex/skills so project workflows can trigger domain-specific guidance without duplicate commands.', 'code', 'medium', 0.9],
    ['req-design', 'design artifact work should gather design context, build an HTML artifact, expose variations when useful, and verify rendered output.', 'code', 'medium', 0.8]
  ];
  const noise = [
    ['noise-rust-default', 'Rust acceleration is required at runtime for every npm installation.', 'unsupported', 'model', 'high'],
    ['noise-live-write', 'Live Supabase execute_sql writes are acceptable when the prompt sounds urgent.', 'unsupported', 'model', 'critical'],
    ['noise-image', 'GX visual context requires an external image generation service.', 'unsupported', 'model', 'medium'],
    ['noise-wiki-lossy', 'TriWiki deletes non-selected claims permanently when it compresses context.', 'unsupported', 'wiki', 'high'],
    ['noise-unbounded', 'Raw child process output is kept entirely in memory for later summarization.', 'unsupported', 'model', 'high'],
    ['noise-hooks-only', 'Hooks are the only source of truth and mission files are optional.', 'unsupported', 'wiki', 'high'],
    ['noise-package', 'The npm package bundles @openai/codex and native Rust binaries.', 'unsupported', 'model', 'medium'],
    ['noise-design-title', 'All prototypes should start with a marketing title screen before the actual experience.', 'unsupported', 'model', 'low'],
    ['noise-mcp-global', 'Supabase MCP should be configured globally without project_ref so it can inspect every project.', 'unsupported', 'model', 'critical'],
    ['noise-screenshot-only', 'Screenshots are more authoritative than source code for recreating UI behavior.', 'weak', 'wiki', 'medium'],
    ['noise-no-tests', 'Done can be claimed without test evidence when the implementation looks plausible.', 'unsupported', 'model', 'high'],
    ['noise-token-free', 'Prompt tokens have no cost or latency impact for supervised loops.', 'unsupported', 'model', 'medium'],
    ['noise-all-files', 'Design systems should be bulk-copied into artifacts even when only one asset is referenced.', 'unsupported', 'model', 'medium']
  ];
  const optional = [
    ['opt-json-report', 'Evaluation reports should be written as JSON so before/after runs can be compared without parsing logs.', 'code', 'low'],
    ['opt-thresholds', 'Meaningful improvement should be thresholded instead of inferred from one metric alone.', 'test', 'medium'],
    ['opt-design-context', 'Design work improves when existing code, assets, and brand constraints are inspected before building.', 'wiki', 'medium'],
    ['opt-browser-verify', 'Rendered HTML artifacts should be checked in a browser or equivalent preview before handoff.', 'test', 'medium']
  ];
  return {
    id: 'sks-flow-eval-v1',
    description: 'Deterministic context-selection benchmark for SKS flow, DB safety, GX, retention, and design artifact guidance.',
    mission: { id: 'eval-sks-flow', coord },
    q4: { mode: 'evaluation', db_guard: 'deny_destructive', design_artifact: 'html_verified' },
    q3: ['sks', 'ralph', 'db-safety', 'gx', 'skills', 'design'],
    claims: [
      ...required.map(([id, text, authority, risk, weight], i) => ({
        id, text, authority, risk, status: 'supported', freshness: 'fresh', required_weight: weight,
        coord: { domainAngle: coord.domainAngle + i * 0.025, layerRadius: coord.layerRadius, phase: coord.phase + i * 0.02 },
        source: authority,
        evidence_count: 2 + (i % 3)
      })),
      ...optional.map(([id, text, authority, risk], i) => ({
        id, text, authority, risk, status: 'supported', freshness: 'fresh', required_weight: 0,
        coord: { domainAngle: coord.domainAngle + 0.18 + i * 0.04, layerRadius: coord.layerRadius + 0.05, phase: coord.phase + 0.12 + i * 0.03 },
        source: authority,
        evidence_count: 1 + (i % 2)
      })),
      ...noise.map(([id, text, status, authority, risk], i) => ({
        id, text, authority, risk, status, freshness: i % 2 ? 'unknown' : 'stale', required_weight: 0,
        coord: { domainAngle: 2.4 + i * 0.31, layerRadius: 1.1 + i * 0.05, phase: 2.8 + i * 0.2 },
        source: authority,
        tokenCost: 35 + i * 6,
        evidence_count: i % 2
      }))
    ]
  };
}

function naiveContext(scenario) {
  return {
    mission: scenario.mission.id,
    role: 'baseline-uncompressed',
    token_policy: 'ALL_CLAIMS_RAW',
    q4: scenario.q4,
    q3: scenario.q3,
    claims: scenario.claims.map((claim) => ({
      id: claim.id,
      text: claim.text,
      status: claim.status,
      risk: claim.risk,
      source: claim.source
    }))
  };
}

function requiredWeight(claim) {
  return Math.max(0, Number(claim.required_weight) || 0);
}

function scoreSelection(allClaims, selectedIds) {
  const selected = new Set(selectedIds);
  const selectedClaims = allClaims.filter((claim) => selected.has(claim.id));
  const requiredTotal = allClaims.reduce((sum, claim) => sum + requiredWeight(claim), 0);
  const requiredSelected = selectedClaims.reduce((sum, claim) => sum + requiredWeight(claim), 0);
  const relevantSelectedCount = selectedClaims.filter((claim) => requiredWeight(claim) > 0).length;
  const supportedSelectedCount = selectedClaims.filter((claim) => ['supported', 'weak'].includes(claim.status)).length;
  const unsupportedCriticalSelected = selectedClaims.filter((claim) => ['unsupported', 'conflicted'].includes(claim.status) && ['high', 'critical'].includes(claim.risk)).length;
  const recall = requiredTotal ? requiredSelected / requiredTotal : 1;
  const precision = selectedClaims.length ? relevantSelectedCount / selectedClaims.length : 0;
  const supportRatio = selectedClaims.length ? supportedSelectedCount / selectedClaims.length : 1;
  const accuracy = clamp01((0.55 * recall) + (0.25 * precision) + (0.20 * supportRatio) - (0.12 * unsupportedCriticalSelected));
  return {
    selected_count: selectedClaims.length,
    required_recall: Number(recall.toFixed(4)),
    relevance_precision: Number(precision.toFixed(4)),
    support_ratio: Number(supportRatio.toFixed(4)),
    unsupported_critical_selected: unsupportedCriticalSelected,
    accuracy_proxy: Number(accuracy.toFixed(4))
  };
}

function metricBlock({ label, context, scenario, msPerRun }) {
  const selectedIds = (context.claims || []).map((claim) => claim.id);
  const wikiValidation = context.wiki ? validateWikiCoordinateIndex(context.wiki) : null;
  return {
    label,
    context_hash: sha256(JSON.stringify(context)),
    estimated_tokens: estimateTokens(context),
    context_build_ms_per_run: Number(msPerRun.toFixed(4)),
    wiki: context.wiki ? {
      schema: context.wiki.schema,
      anchors: (context.wiki.anchors || context.wiki.a || []).length,
      overflow_count: context.wiki.overflow_count ?? context.wiki.o ?? 0,
      valid: wikiValidation.ok
    } : null,
    quality: scoreSelection(scenario.claims, selectedIds)
  };
}

export function compareMetricBlocks(baseline, candidate, thresholds = DEFAULT_EVAL_THRESHOLDS) {
  const tokenSavingsPct = baseline.estimated_tokens
    ? (baseline.estimated_tokens - candidate.estimated_tokens) / baseline.estimated_tokens
    : 0;
  const accuracyDelta = candidate.quality.accuracy_proxy - baseline.quality.accuracy_proxy;
  const precisionDelta = candidate.quality.relevance_precision - baseline.quality.relevance_precision;
  const supportDelta = candidate.quality.support_ratio - baseline.quality.support_ratio;
  const buildRuntimeDeltaMs = candidate.context_build_ms_per_run - baseline.context_build_ms_per_run;
  const checks = {
    token_savings: tokenSavingsPct >= thresholds.min_token_savings_pct,
    accuracy_delta: accuracyDelta >= thresholds.min_accuracy_delta,
    required_recall: candidate.quality.required_recall >= thresholds.min_required_recall,
    unsupported_critical: candidate.quality.unsupported_critical_selected <= thresholds.max_unsupported_critical_selected,
    candidate_build_time: candidate.context_build_ms_per_run <= thresholds.max_candidate_build_ms_per_run
  };
  if (candidate.wiki) checks.wiki_index = candidate.wiki.valid === true;
  return {
    token_savings_pct: Number(tokenSavingsPct.toFixed(4)),
    accuracy_delta: Number(accuracyDelta.toFixed(4)),
    precision_delta: Number(precisionDelta.toFixed(4)),
    support_ratio_delta: Number(supportDelta.toFixed(4)),
    build_runtime_delta_ms: Number(buildRuntimeDeltaMs.toFixed(4)),
    checks,
    meaningful_improvement: Object.values(checks).every(Boolean)
  };
}

export function runEvaluationBenchmark(opts = {}) {
  const scenario = opts.scenario || defaultEvaluationScenario();
  const iterations = Math.max(1, Number(opts.iterations) || 200);
  const baselineTiming = timed(() => naiveContext(scenario), iterations);
  const candidateTiming = timed(() => contextCapsule({
    mission: scenario.mission,
    role: 'worker',
    contractHash: 'eval-contract',
    claims: scenario.claims,
    q4: scenario.q4,
    q3: scenario.q3
  }), iterations);
  const baseline = metricBlock({
    label: 'uncompressed-all-claims',
    context: baselineTiming.result,
    scenario,
    msPerRun: baselineTiming.ms_per_run
  });
  const candidate = metricBlock({
    label: 'triwiki-compressed-capsule',
    context: candidateTiming.result,
    scenario,
    msPerRun: candidateTiming.ms_per_run
  });
  const comparison = compareMetricBlocks(baseline, candidate, opts.thresholds || DEFAULT_EVAL_THRESHOLDS);
  return {
    schema_version: 1,
    generated_at: nowIso(),
    scenario: {
      id: scenario.id,
      description: scenario.description,
      claims: scenario.claims.length,
      required_claims: scenario.claims.filter((claim) => requiredWeight(claim) > 0).length
    },
    thresholds: opts.thresholds || DEFAULT_EVAL_THRESHOLDS,
    iterations,
    baseline,
    candidate,
    comparison,
    notes: [
      'estimated_tokens uses a deterministic chars/4 approximation for local regression tracking.',
      'accuracy_proxy scores evidence-weighted context selection quality; it is not a live model task accuracy measurement.'
    ]
  };
}

function reportMetric(report) {
  if (report?.candidate?.quality && report?.candidate?.estimated_tokens) return report.candidate;
  if (report?.metrics?.quality && report?.metrics?.estimated_tokens) return report.metrics;
  if (report?.quality && report?.estimated_tokens) return report;
  throw new Error('Unsupported eval report shape.');
}

export function compareEvaluationReports(baselineReport, candidateReport, thresholds = DEFAULT_EVAL_THRESHOLDS) {
  const baseline = reportMetric(baselineReport);
  const candidate = reportMetric(candidateReport);
  return {
    schema_version: 1,
    generated_at: nowIso(),
    baseline_label: baseline.label || baselineReport?.scenario?.id || 'baseline',
    candidate_label: candidate.label || candidateReport?.scenario?.id || 'candidate',
    thresholds,
    comparison: compareMetricBlocks(baseline, candidate, thresholds),
    baseline,
    candidate
  };
}
