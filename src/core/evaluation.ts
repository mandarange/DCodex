import path from 'node:path';
import { nowIso, sha256, writeJsonAtomic } from './fsx.js';
import {
  DEFAULT_OFFICIAL_SUBAGENT_JOB_MAX_RUNTIME_SECONDS,
  DEFAULT_OFFICIAL_SUBAGENT_MAX_DEPTH,
  DEFAULT_OFFICIAL_SUBAGENT_MAX_THREADS
} from './subagents/official-subagent-config.js';
import { contextCapsule } from './triwiki-attention.js';
import { validateWikiCoordinateIndex } from './wiki-coordinate.js';

export const DEFAULT_EVAL_THRESHOLDS = Object.freeze({
  min_token_savings_pct: 0.1,
  min_accuracy_delta: 0.03,
  min_required_recall: 0.95,
  max_unsupported_critical_selected: 0,
  max_candidate_build_ms_per_run: 25
});

export const HARNESS_GROWTH_REPORT = 'harness-growth-report.json';

export const MEMORY_LIFECYCLE_STATES = Object.freeze([
  'ACTIVE',
  'PINNED',
  'DORMANT',
  'STALE',
  'DUPLICATE',
  'CONFLICTED',
  'QUARANTINED',
  'ARCHIVED',
  'DISABLED',
  'DELETE_CANDIDATE',
  'DELETED'
]);

export const FORGETTING_ACTIONS = Object.freeze([
  'KEEP_ACTIVE',
  'PIN',
  'UNPIN',
  'UPDATE',
  'CONSOLIDATE',
  'DEMOTE',
  'DISABLE',
  'ARCHIVE',
  'QUARANTINE',
  'HARD_DELETE',
  'NOOP',
  'PROMOTE_SKILL',
  'PROMOTE_RULE',
  'PROMOTE_TEST'
]);

export const TOOL_ERROR_TAXONOMY = Object.freeze([
  'InvalidArguments',
  'UnexpectedEnvironment',
  'ProviderError',
  'UserAborted',
  'Timeout',
  'PermissionDenied',
  'NetworkDenied',
  'ResourceExhausted',
  'Conflict',
  'Unknown'
]);

export const DEFAULT_FORGETTING_THRESHOLDS = Object.freeze({
  wiki_claim: { stale_after_days: 60, dormant_after_days_without_use: 90, archive_after_days_without_use: 150, hard_delete_after_days_without_use: 240 },
  wiki_page: { stale_after_days: 90, archive_after_days_without_use: 180, hard_delete_after_days_without_use: 365 },
  codex_memory: { stale_after_days: 60, hard_delete_after_days_without_use: 180 },
  skill: { stale_after_days_without_use: 45, disable_after_days_without_use: 90, archive_after_days_without_use: 180, hard_delete_after_days_without_use: 270 },
  mistake_fingerprint: { stale_after_days_without_recurrence: 180, archive_after_days_without_recurrence: 365, hard_delete_after_days_without_recurrence: 540 },
  temporary_artifact: { archive_after_days: 14, hard_delete_after_days: 45 }
});

export const PERMISSION_PROFILES = Object.freeze({
  read_only_explorer: { filesystem: 'read-only', network: 'disabled_or_limited', purpose: 'Map code, collect evidence, no writes.' },
  workspace_worker: { filesystem: 'workspace-write', network: 'disabled_by_default', purpose: 'Implement local code changes safely.' },
  dogfood_browser: { filesystem: 'workspace-write', network: 'localhost_and_required_docs', purpose: 'Run app/browser dogfood and collect evidence.' },
  harness_research: { filesystem: 'workspace-write', network: 'limited_allowlist', purpose: 'Fetch official docs/research for harness improvements.' },
  dangerous_full_access: { filesystem: 'full-access', network: 'controlled', purpose: 'Never default. Requires explicit reason and review.' }
});

export const DEFAULT_MULTIAGENT_V2 = Object.freeze({
  enabled: true,
  max_threads: DEFAULT_OFFICIAL_SUBAGENT_MAX_THREADS,
  max_concurrent_threads_per_session: DEFAULT_OFFICIAL_SUBAGENT_MAX_THREADS,
  max_depth: DEFAULT_OFFICIAL_SUBAGENT_MAX_DEPTH,
  /** Removed from Codex 0.145 AgentsToml; retained as SKS-internal wait budget metadata only. */
  job_max_runtime_seconds: DEFAULT_OFFICIAL_SUBAGENT_JOB_MAX_RUNTIME_SECONDS,
  expose_spawn_agent_model_overrides: true,
  wait_control: 'bounded_wait_then_structured_summary',
  subagent_output: 'structured_summary_only'
});

export function serializedSizeBytes(value: any) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

export function classifyToolError(input: any = {}) {
  const text = `${input.code || ''} ${input.name || ''} ${input.message || ''} ${input.stderr || ''}`.toLowerCase();
  if (/invalid|required|schema|argument|parameter|json/.test(text)) return 'InvalidArguments';
  if (/enoent|not found|cwd|path|missing file|environment|not installed/.test(text)) return 'UnexpectedEnvironment';
  if (/provider|upstream|api error|5\d\d|service unavailable/.test(text)) return 'ProviderError';
  if (/abort|cancel|interrupted|user stopped/.test(text)) return 'UserAborted';
  if (/timeout|timed out|deadline/.test(text)) return 'Timeout';
  if (/permission|denied|not allowed|approval|sandbox/.test(text)) return 'PermissionDenied';
  if (/network|dns|eai_again|enotfound|offline/.test(text)) return 'NetworkDenied';
  if (/rate limit|quota|memory|resource|emfile|enospc|token limit|too large/.test(text)) return 'ResourceExhausted';
  if (/conflict|merge|lock|concurrent|dirty/.test(text)) return 'Conflict';
  return 'Unknown';
}

export function utilityScore(object: any = {}) {
  const evidence = Math.min(20, Number(object.evidence_count || 0) * 4);
  const successfulUse = Math.min(16, Number(object.success_count || object.use_count || 0) * 3);
  const recency = daysSince(object.updated_at || object.last_used_at || object.created_at) <= 30 ? 14 : 4;
  const uniqueness = object.duplicate_of ? -18 : 10;
  const trust = Math.round(Number(object.trust_score ?? 0.5) * 18);
  const riskPrevention = object.regression_prevention ? 12 : 0;
  const penalties = [
    object.stale ? 14 : 0,
    object.conflicted ? 28 : 0,
    object.failed_use ? 10 : 0,
    object.prompt_bloat ? 8 : 0,
    object.security_risk ? 80 : 0,
    object.maintenance_cost ? 8 : 0
  ].reduce((a: any, b: any) => a + b, 0);
  return clamp(0, 100, recency + evidence + successfulUse + uniqueness + trust + riskPrevention - penalties);
}

export function forgettingDecision(object: any = {}, opts: any = {}) {
  const state = String(object.lifecycle_state || object.status || '').toUpperCase();
  const score = utilityScore(object);
  if (isPinned(object)) return decision('KEEP_ACTIVE', 'PINNED', score, ['retention_exempt']);
  if (containsSecret(object)) return decision('HARD_DELETE', 'DELETED', score, ['secret_or_sensitive_content'], true);
  if (object.poisoned || object.unsafe_instruction) return decision('HARD_DELETE', 'DELETED', score, ['poisoned_or_unsafe'], true);
  if (object.known_false) return decision('QUARANTINE', 'QUARANTINED', score, ['known_false']);
  if (object.duplicate_of) return decision('CONSOLIDATE', 'DUPLICATE', score, ['duplicate']);
  if (object.conflicted || state === 'CONFLICTED') return decision('QUARANTINE', 'CONFLICTED', score, ['conflict_requires_resolution']);
  if (object.repeated_success && Number(object.success_count || 0) >= 3) return decision('PROMOTE_SKILL', 'ACTIVE', score, ['verified_repetition']);
  if (object.repeated_mistake && !object.regression_test) return decision('PROMOTE_TEST', 'ACTIVE', score, ['mistake_without_test']);
  if (object.stale && Number(object.evidence_count || 0) >= 3 && Number(object.trust_score || 0) >= 0.65) return decision('DEMOTE', 'STALE', score, ['stale_but_useful_verify_before_use']);
  if (score < 20 && graceChecksPass(object, opts)) return decision('HARD_DELETE', 'DELETED', score, ['old_unused_low_utility'], false, tombstone(object, opts));
  if (score < 40) return decision('ARCHIVE', 'ARCHIVED', score, ['low_utility']);
  if (score < 60 || object.stale) return decision(object.type === 'skill' ? 'DISABLE' : 'DEMOTE', object.type === 'skill' ? 'DISABLED' : 'STALE', score, ['stale_or_watch']);
  return decision('KEEP_ACTIVE', 'ACTIVE', score, ['useful_current']);
}

export function createSkillCard(input: any = {}) {
  return {
    skill_id: input.skill_id || input.id || `skill.${safeId(input.name || 'candidate')}`,
    name: input.name || input.skill_id || 'Candidate Skill',
    version: input.version || '1.0.0',
    status: input.status || 'active',
    created_at: input.created_at || nowIso(),
    updated_at: input.updated_at || nowIso(),
    last_used_at: input.last_used_at || null,
    use_count: Number(input.use_count || 0),
    success_count: Number(input.success_count || 0),
    failure_count: Number(input.failure_count || 0),
    false_trigger_count: Number(input.false_trigger_count || 0),
    owner: input.owner || 'harness',
    trigger_summary: input.trigger_summary || '',
    anti_triggers: input.anti_triggers || [],
    inputs: input.inputs || [],
    outputs: input.outputs || [],
    validation: input.validation || { commands: [], manual_checks: [], schemas: [] },
    risk_notes: input.risk_notes || [],
    retirement_conditions: input.retirement_conditions || ['stale without use', 'repeated false trigger', 'validation no longer runs'],
    related_mistake_fingerprints: input.related_mistake_fingerprints || [],
    related_wiki_entries: input.related_wiki_entries || [],
    plugin_distribution: input.plugin_distribution || 'none',
    implicit_invocation_allowed: input.implicit_invocation_allowed !== false
  };
}

export function createHarnessExperiment(input: any = {}) {
  return {
    experiment_id: input.experiment_id || `exp.${safeId(input.title || 'harness')}.${sha256(JSON.stringify(input)).slice(0, 8)}`,
    title: input.title || 'Harness experiment',
    owner: 'harness_growth',
    created_at: input.created_at || nowIso(),
    status: input.status || 'draft',
    vision_alignment: input.vision_alignment || 'Improve verified task outcomes while reducing context bloat.',
    hypothesis: input.hypothesis || '',
    change_surface: input.change_surface || ['eval'],
    variant_a: input.variant_a || 'baseline',
    variant_b: input.variant_b || 'candidate',
    risk_level: input.risk_level || 'low',
    rollback_plan: input.rollback_plan || 'revert candidate surface and re-run smoke shard',
    offline_eval_suite: input.offline_eval_suite || ['sneakoscopebench:smoke'],
    online_metrics: input.online_metrics || ['latency_p95_ms', 'token_input', 'tool_error_rate', 'keep_rate', 'context_bloat_score'],
    launch_gate: input.launch_gate || {
      min_quality_delta: '>= 0',
      max_latency_regression: '<= 10%',
      max_cost_regression: '<= 10%',
      max_error_regression: '<= 0',
      required_evidence: 'offline eval plus rollback plan'
    },
    post_launch_monitoring: input.post_launch_monitoring || { duration_days: 7, alert_thresholds: { unknown_error_rate: 0, repeated_mistake_rate: 0 } }
  };
}

export function buildHarnessGrowthFixture() {
  const old = isoDaysAgo(400);
  const recent = isoDaysAgo(2);
  return [
    { id: 'pinned-user-rule', type: 'wiki_claim', lifecycle_state: 'PINNED', pinned: true, trust_score: 0.95, updated_at: old },
    { id: 'old-unused-wiki', type: 'wiki_page', trust_score: 0.2, updated_at: old, use_count: 0, stale: true },
    { id: 'duplicate-claim', type: 'wiki_claim', duplicate_of: 'better-claim', trust_score: 0.5, updated_at: old },
    { id: 'stale-useful-architecture', type: 'wiki_claim', trust_score: 0.7, evidence_count: 3, stale: true, updated_at: isoDaysAgo(95) },
    { id: 'poisoned-memory', type: 'memory', poisoned: true, trust_score: 0.1, updated_at: recent },
    { id: 'old-unused-skill', type: 'skill', trust_score: 0.2, updated_at: old, false_trigger_count: 2, use_count: 0 },
    { id: 'recent-successful-skill', type: 'skill', trust_score: 0.9, updated_at: recent, success_count: 4, repeated_success: true },
    { id: 'secret-memory', type: 'memory', text: 'token=sk-live-secret-value', updated_at: recent },
    { id: 'mistake-no-test', type: 'mistake_fingerprint', trust_score: 0.9, regression_prevention: true, repeated_mistake: true, regression_test: null, updated_at: recent }
  ];
}

export function runHarnessGrowthFixture() {
  const objects = buildHarnessGrowthFixture();
  const decisions = objects.map((object: any) => ({ id: object.id, ...forgettingDecision(object, { now: new Date() }) }));
  const byId = Object.fromEntries(decisions.map((item: any) => [item.id, item]));
  const checks = {
    pinned_rule_remains: byId['pinned-user-rule'].action === 'KEEP_ACTIVE',
    old_wiki_leaves_active: ['ARCHIVE', 'HARD_DELETE'].includes(byId['old-unused-wiki'].action),
    duplicate_consolidates: byId['duplicate-claim'].action === 'CONSOLIDATE',
    stale_useful_stays_hydratable: ['DEMOTE', 'KEEP_ACTIVE'].includes(byId['stale-useful-architecture'].action),
    poisoned_removed: ['HARD_DELETE', 'QUARANTINE'].includes(byId['poisoned-memory'].action),
    old_skill_disabled_or_removed: ['DISABLE', 'ARCHIVE', 'HARD_DELETE'].includes(byId['old-unused-skill'].action),
    recent_skill_active_or_promoted: ['KEEP_ACTIVE', 'PROMOTE_SKILL'].includes(byId['recent-successful-skill'].action),
    secret_hard_deleted: byId['secret-memory'].action === 'HARD_DELETE',
    uncovered_mistake_kept_for_test: byId['mistake-no-test'].action === 'PROMOTE_TEST'
  };
  return {
    schema_version: 1,
    fixture: 'memory_sweep_fixture',
    created_at: nowIso(),
    decisions,
    checks,
    passed: Object.values(checks).every(Boolean)
  };
}

export function harnessGrowthReport(input: any = {}) {
  const fixture = runHarnessGrowthFixture();
  const toolErrors = (input.tool_errors || [
    { message: 'operation timed out after 30s' },
    { message: 'unexpected provider 500' },
    { message: 'unmatched example for taxonomy coverage' }
  ]).map((error: any) => ({ ...error, classification: classifyToolError(error), unknown_is_bug: classifyToolError(error) === 'Unknown' }));
  return {
    schema_version: 1,
    generated_at: nowIso(),
    forgetting: {
      lifecycle_states: MEMORY_LIFECYCLE_STATES,
      actions: FORGETTING_ACTIONS,
      thresholds: DEFAULT_FORGETTING_THRESHOLDS,
      fixture
    },
    skills: {
      card_schema_example: createSkillCard({
        skill_id: 'skill.harness.weekly-review',
        name: 'Weekly Harness Review',
        trigger_summary: 'Run on weekly harness review automation or explicit harness growth request.',
        validation: { commands: ['sks harness fixture --json'], manual_checks: ['review proposed deletions before live hard-delete'], schemas: ['harness-growth-report.json'] }
      })
    },
    experiments: {
      registry_schema_example: createHarnessExperiment({
        title: 'Visible ambiguity question delivery',
        hypothesis: 'Stop gates that require visible question blocks reduce hidden clarification failures.',
        change_surface: ['prompt', 'tool', 'eval'],
        offline_eval_suite: ['selftest:route-visible-questions']
      })
    },
    codex_native: {
      permission_profiles: PERMISSION_PROFILES,
      multiagent_v2: DEFAULT_MULTIAGENT_V2,
      goal_checkpoint_required_fields: ['goal_id', 'phase', 'summary', 'completed_checkboxes', 'open_checkboxes', 'blockers', 'evidence'],
      external_session_import: 'structured_summary_only_with_utility_score_and_forgetting_metadata'
    },
    reliability: {
      tool_error_taxonomy: TOOL_ERROR_TAXONOMY,
      classified_errors: toolErrors,
      unknown_errors_are_bugs: true
    },
    validation: {
      fixture_passed: fixture.passed,
      unknown_errors_recorded: toolErrors.filter((e: any) => e.classification === 'Unknown').length
    }
  };
}

export async function writeHarnessGrowthReport(root: any, dir: any, input: any = {}) {
  const report = harnessGrowthReport(input);
  await writeJsonAtomic(path.join(dir || path.join(root, '.sneakoscope', 'reports'), HARNESS_GROWTH_REPORT), report);
  return report;
}

function clamp01(x: any) {
  return Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
}

function decision(action: any, lifecycle_state: any, utility_score: any, reason_codes: any, immediate: any = false, tombstoneMeta: any = null) {
  return { action, lifecycle_state, utility_score, reason_codes, immediate, tombstone: tombstoneMeta };
}

function isPinned(object: any = {}) {
  return object.pinned === true || String(object.lifecycle_state || '').toUpperCase() === 'PINNED';
}

function containsSecret(object: any = {}) {
  const text = JSON.stringify(object);
  return /(sk-|ghp_|glpat-|xox[baprs]-|AKIA[0-9A-Z]{16}|secret|private[_-]?key|token=|password=)/i.test(text);
}

function graceChecksPass(object: any = {}, opts: any = {}) {
  if (isPinned(object)) return false;
  if (object.active_work_order || object.required_by_skill_validation || object.only_source_for_user_preference) return false;
  if (object.only_source_for_mistake_prevention && !object.regression_test) return false;
  if (daysSince(object.last_used_at || object.updated_at || object.created_at, opts.now) < 90) return false;
  return true;
}

function tombstone(object: any = {}, opts: any = {}) {
  return {
    deleted_object_id: safeId(object.id || sha256(JSON.stringify(object)).slice(0, 16)),
    object_type: object.type || 'memory',
    deleted_at: nowIso(),
    reason: opts.reason || 'old-unused-low-utility',
    replacement_id: object.replacement_id || object.duplicate_of || null,
    deleted_by: opts.deleted_by || 'automation',
    content_hash: object.sensitive ? null : sha256(JSON.stringify(object)).slice(0, 24)
  };
}

function daysSince(value: any, now: any = new Date()) {
  const t = Date.parse(value || '');
  if (!Number.isFinite(t)) return 9999;
  return Math.floor((Number(now) - t) / 86400000);
}

function isoDaysAgo(days: any) {
  return new Date(Date.now() - Number(days) * 86400000).toISOString();
}

function safeId(value: any) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'object';
}

function clamp(min: any, max: any, value: any) {
  return Math.max(min, Math.min(max, Math.round(Number(value) || 0)));
}

function timed(fn: any, iterations: any) {
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
    ['req-contract', 'decision-contract.json must be sealed before ambiguity-gated execution can proceed.', 'contract', 'critical', 1.2],
    ['req-db-block', 'destructive database operations such as DROP, TRUNCATE, db reset, and live execute_sql writes are blocked.', 'code', 'critical', 1.4],
    ['req-hook', '.codex/hooks.json routes PreToolUse, PostToolUse, PermissionRequest, UserPromptSubmit, and Stop to sks hook handlers.', 'code', 'high', 1],
    ['req-gx-hash', 'GX render output embeds the normalized vgraph.json source hash so drift can be detected deterministically.', 'test', 'medium', 0.9],
    ['req-wiki-rgba', 'TriWiki stores RGBA-derived trigonometric wiki anchors so compressed context remains hydratable by id, hash, source, and coordinate.', 'code', 'high', 1.2],
    ['req-retention', 'runtime logs and mission artifacts are bounded through retention policy and sks gc.', 'code', 'medium', 0.85],
    ['req-selftest', 'selftest covers contract sealing, DB guard blocking, done-gate evaluation, GX render/validate/drift, snapshot, and retention report.', 'test', 'high', 1.1],
    ['req-skill', 'sks init installs one canonical repo-local Codex App skill set under .agents/skills so project workflows can trigger domain-specific guidance without duplicate commands.', 'code', 'medium', 0.9],
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
    q3: ['sks', 'goal', 'db-safety', 'gx', 'skills', 'design'],
    claims: [
      ...required.map(([id, text, authority, risk, weight]: any, i: any) => ({
        id, text, authority, risk, status: 'supported', freshness: 'fresh', required_weight: weight,
        coord: { domainAngle: coord.domainAngle + i * 0.025, layerRadius: coord.layerRadius, phase: coord.phase + i * 0.02 },
        source: authority,
        evidence_count: 2 + (i % 3)
      })),
      ...optional.map(([id, text, authority, risk]: any, i: any) => ({
        id, text, authority, risk, status: 'supported', freshness: 'fresh', required_weight: 0,
        coord: { domainAngle: coord.domainAngle + 0.18 + i * 0.04, layerRadius: coord.layerRadius + 0.05, phase: coord.phase + 0.12 + i * 0.03 },
        source: authority,
        evidence_count: 1 + (i % 2)
      })),
      ...noise.map(([id, text, status, authority, risk]: any, i: any) => ({
        id, text, authority, risk, status, freshness: i % 2 ? 'unknown' : 'stale', required_weight: 0,
        coord: { domainAngle: 2.4 + i * 0.31, layerRadius: 1.1 + i * 0.05, phase: 2.8 + i * 0.2 },
        source: authority,
        tokenCost: 35 + i * 6,
        evidence_count: i % 2
      }))
    ]
  };
}

function naiveContext(scenario: any) {
  return {
    mission: scenario.mission.id,
    role: 'baseline-uncompressed',
    token_policy: 'ALL_CLAIMS_RAW',
    q4: scenario.q4,
    q3: scenario.q3,
    claims: scenario.claims.map((claim: any) => ({
      id: claim.id,
      text: claim.text,
      status: claim.status,
      risk: claim.risk,
      source: claim.source
    }))
  };
}

function requiredWeight(claim: any) {
  return Math.max(0, Number(claim.required_weight) || 0);
}

function scoreSelection(allClaims: any, selectedIds: any) {
  const selected = new Set(selectedIds);
  const selectedClaims = allClaims.filter((claim: any) => selected.has(claim.id));
  const requiredTotal = allClaims.reduce((sum: any, claim: any) => sum + requiredWeight(claim), 0);
  const requiredSelected = selectedClaims.reduce((sum: any, claim: any) => sum + requiredWeight(claim), 0);
  const relevantSelectedCount = selectedClaims.filter((claim: any) => requiredWeight(claim) > 0).length;
  const supportedSelectedCount = selectedClaims.filter((claim: any) => ['supported', 'weak'].includes(claim.status)).length;
  const unsupportedCriticalSelected = selectedClaims.filter((claim: any) => ['unsupported', 'conflicted'].includes(claim.status) && ['high', 'critical'].includes(claim.risk)).length;
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

function tokenMeasurementFromEvidence(evidence: any, label: 'baseline' | 'candidate') {
  const rawCount = evidence?.[`${label}_tokens`];
  const source = String(evidence?.source || '').trim();
  if (rawCount === null || rawCount === undefined || !source) {
    return { token_count: null, token_evidence: null };
  }
  const count = Number(rawCount);
  if (!Number.isInteger(count) || count < 0) {
    return { token_count: null, token_evidence: null };
  }
  return { token_count: count, token_evidence: { source } };
}

function metricBlock({ label, context, scenario, msPerRun, tokenMeasurement }: any) {
  const selectedIds = (context.claims || []).map((claim: any) => claim.id);
  const wikiValidation: any = context.wiki ? validateWikiCoordinateIndex(context.wiki) : { ok: false };
  const voxel = context.wiki?.vx || context.wiki?.voxel_overlay || null;
  const voxelRows = Array.isArray(voxel?.v) ? voxel.v.length : (Array.isArray(voxel?.rows) ? voxel.rows.length : 0);
  return {
    label,
    context_hash: sha256(JSON.stringify(context)),
    serialized_size_bytes: serializedSizeBytes(context),
    size_metric: {
      name: 'serialized_json_bytes',
      unit: 'bytes',
      proxy_for_tokens: false
    },
    token_count: tokenMeasurement?.token_count ?? null,
    token_evidence: tokenMeasurement?.token_evidence ?? null,
    context_build_ms_per_run: Number(msPerRun.toFixed(4)),
    wiki: context.wiki ? {
      schema: context.wiki.schema,
      anchors: (context.wiki.anchors || context.wiki.a || []).length,
      overflow_count: context.wiki.overflow_count ?? context.wiki.o ?? 0,
      voxel_schema: voxel?.s || voxel?.schema || null,
      voxel_rows: voxelRows,
      valid: wikiValidation.ok
    } : null,
    quality: scoreSelection(scenario.claims, selectedIds)
  };
}

function measuredTokenEvidence(metric: any) {
  const count = metric?.token_count;
  const identity = String(metric?.token_evidence?.source || '').trim();
  return Number.isInteger(count) && count >= 0 && identity ? { count, identity } : null;
}

function serializedSize(metric: any) {
  const size = metric?.serialized_size_bytes;
  return Number.isFinite(size) && size >= 0 ? Number(size) : null;
}

export function compareMetricBlocks(baseline: any, candidate: any, thresholds: any = DEFAULT_EVAL_THRESHOLDS) {
  const baselineTokenEvidence = measuredTokenEvidence(baseline);
  const candidateTokenEvidence = measuredTokenEvidence(candidate);
  const comparableTokenEvidence = baselineTokenEvidence !== null
    && baselineTokenEvidence.count > 0
    && candidateTokenEvidence !== null
    && baselineTokenEvidence.identity === candidateTokenEvidence.identity
    ? { baseline: baselineTokenEvidence.count, candidate: candidateTokenEvidence.count, identity: baselineTokenEvidence.identity }
    : null;
  const tokenEvidenceAvailable = comparableTokenEvidence !== null;
  const tokenSavingsPct = comparableTokenEvidence
    ? (comparableTokenEvidence.baseline - comparableTokenEvidence.candidate) / comparableTokenEvidence.baseline
    : null;
  const baselineSize = serializedSize(baseline);
  const candidateSize = serializedSize(candidate);
  const serializedSizeSavingsPct = baselineSize !== null && baselineSize > 0 && candidateSize !== null
    ? (baselineSize - candidateSize) / baselineSize
    : null;
  const accuracyDelta = candidate.quality.accuracy_proxy - baseline.quality.accuracy_proxy;
  const precisionDelta = candidate.quality.relevance_precision - baseline.quality.relevance_precision;
  const supportDelta = candidate.quality.support_ratio - baseline.quality.support_ratio;
  const buildRuntimeDeltaMs = candidate.context_build_ms_per_run - baseline.context_build_ms_per_run;
  const checks: Record<string, boolean | null> = {
    token_evidence: tokenEvidenceAvailable,
    token_savings: tokenSavingsPct === null ? null : tokenSavingsPct >= thresholds.min_token_savings_pct,
    accuracy_delta: accuracyDelta >= thresholds.min_accuracy_delta,
    required_recall: candidate.quality.required_recall >= thresholds.min_required_recall,
    unsupported_critical: candidate.quality.unsupported_critical_selected <= thresholds.max_unsupported_critical_selected,
    candidate_build_time: candidate.context_build_ms_per_run <= thresholds.max_candidate_build_ms_per_run
  };
  if (candidate.wiki) checks.wiki_index = candidate.wiki.valid === true;
  return {
    token_savings_pct: tokenSavingsPct === null ? null : Number(tokenSavingsPct.toFixed(4)),
    serialized_size_savings_pct: serializedSizeSavingsPct === null ? null : Number(serializedSizeSavingsPct.toFixed(4)),
    token_measurement: {
      available: tokenEvidenceAvailable,
      evidence_identity: comparableTokenEvidence?.identity ?? null,
      reason: tokenEvidenceAvailable
        ? null
        : baselineTokenEvidence && candidateTokenEvidence && baselineTokenEvidence.identity !== candidateTokenEvidence.identity
          ? 'matching_token_evidence_identity_required'
          : 'actual_token_counts_with_evidence_required'
    },
    accuracy_delta: Number(accuracyDelta.toFixed(4)),
    precision_delta: Number(precisionDelta.toFixed(4)),
    support_ratio_delta: Number(supportDelta.toFixed(4)),
    build_runtime_delta_ms: Number(buildRuntimeDeltaMs.toFixed(4)),
    checks,
    meaningful_improvement: Object.values(checks).every((value) => value === true)
  };
}

export function runEvaluationBenchmark(opts: any = {}) {
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
    msPerRun: baselineTiming.ms_per_run,
    tokenMeasurement: tokenMeasurementFromEvidence(opts.tokenEvidence, 'baseline')
  });
  const candidate = metricBlock({
    label: 'triwiki-compressed-capsule',
    context: candidateTiming.result,
    scenario,
    msPerRun: candidateTiming.ms_per_run,
    tokenMeasurement: tokenMeasurementFromEvidence(opts.tokenEvidence, 'candidate')
  });
  const comparison = compareMetricBlocks(baseline, candidate, opts.thresholds || DEFAULT_EVAL_THRESHOLDS);
  return {
    schema_version: 2,
    generated_at: nowIso(),
    scenario: {
      id: scenario.id,
      description: scenario.description,
      claims: scenario.claims.length,
      required_claims: scenario.claims.filter((claim: any) => requiredWeight(claim) > 0).length
    },
    thresholds: opts.thresholds || DEFAULT_EVAL_THRESHOLDS,
    iterations,
    baseline,
    candidate,
    comparison,
    notes: [
      'serialized_size_bytes is a deterministic UTF-8 JSON byte-size metric, not a token estimate.',
      'Token savings are unavailable unless actual baseline and candidate token counts share the same nonempty token_evidence.source identity.',
      'accuracy_proxy scores evidence-weighted context selection quality; it is not a live model task accuracy measurement.'
    ]
  };
}

function reportMetric(report: any) {
  if (report?.candidate?.quality && hasSizeOrTokenMetric(report.candidate)) return report.candidate;
  if (report?.metrics?.quality && hasSizeOrTokenMetric(report.metrics)) return report.metrics;
  if (report?.quality && hasSizeOrTokenMetric(report)) return report;
  throw new Error('Unsupported eval report shape.');
}

function hasSizeOrTokenMetric(metric: any) {
  return metric?.serialized_size_bytes !== undefined
    || metric?.token_count !== undefined
    || metric?.estimated_tokens !== undefined;
}

export function compareEvaluationReports(baselineReport: any, candidateReport: any, thresholds: any = DEFAULT_EVAL_THRESHOLDS) {
  const baseline = reportMetric(baselineReport);
  const candidate = reportMetric(candidateReport);
  return {
    schema_version: 2,
    generated_at: nowIso(),
    baseline_label: baseline.label || baselineReport?.scenario?.id || 'baseline',
    candidate_label: candidate.label || candidateReport?.scenario?.id || 'candidate',
    thresholds,
    comparison: compareMetricBlocks(baseline, candidate, thresholds),
    baseline,
    candidate
  };
}
