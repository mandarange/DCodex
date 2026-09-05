import { createHash } from 'node:crypto';

export const LEAN_ENGINEERING_POLICY_ID = 'sks.lean-engineering-policy.v1';
export const LEAN_DECISION_SCHEMA = 'sks.lean-decision.v1';
export const LEAN_CHANGE_EVIDENCE_SCHEMA = 'sks.lean-change-evidence.v1';
export const ENGINEERING_SANITY_POLICY_ID = 'sks.engineering-sanity-policy.v1';

export const LEAN_SOLUTION_RUNGS = Object.freeze([
  'skip',
  'reuse-existing',
  'stdlib',
  'native-platform',
  'installed-dependency',
  'single-expression',
  'minimal-custom'
] as const);

export type LeanSolutionRung = typeof LEAN_SOLUTION_RUNGS[number];
export type LeanFallbackKind = 'none' | 'capability' | 'compatibility' | 'fail-closed';
export type LeanFindingTag =
  | 'delete'
  | 'reuse'
  | 'stdlib'
  | 'platform'
  | 'yagni'
  | 'shrink'
  | 'fallback'
  | 'root-cause'
  | 'verify'
  | 'solid'
  | 'n-plus-one'
  | 'unbounded-loop'
  | 'verification-bypass'
  | 'db-pool'
  | 'transaction';

export interface LeanFallbackPlan {
  kind: LeanFallbackKind;
  authority: string | null;
  justification: string | null;
}

export interface LeanDecision {
  schema: typeof LEAN_DECISION_SCHEMA;
  policy_id: typeof LEAN_ENGINEERING_POLICY_ID;
  policy_hash: string;
  selected_rung: LeanSolutionRung;
  task_requires_change: boolean;
  root_cause_target: string | null;
  reused_paths: string[];
  stdlib_or_native_choice: string | null;
  new_dependency_requested: boolean;
  new_dependency_justification: string | null;
  new_abstraction_requested: boolean;
  new_abstraction_justification: string | null;
  fallback_plan: LeanFallbackPlan;
  expected_changed_paths: string[];
  verification_minimum: string[];
}

export interface LeanSimplificationMarker {
  file: string;
  line: number;
  ceiling: string | null;
  revisit_when: string | null;
  upgrade: string | null;
  status: 'complete' | 'missing-trigger' | 'missing-upgrade';
}

export interface LeanFinding {
  id?: string;
  tag: LeanFindingTag;
  severity: 'info' | 'review' | 'blocker';
  summary: string;
  file?: string;
  line?: number;
  source_scope?: string;
  added_hunk_line_ranges?: Array<{ start: number; end: number }>;
}

const CORE_ENGINEERING_DIRECTIVE_LINES = Object.freeze([
  'Build for the stated goal. Make the smallest sufficient change. Test the main path, meaningful boundaries, and credible failures; do not manufacture low-value test matrices.',
  'Follow reality. Trace actual callers, inputs, data, and control flow; do not add defenses for unreachable or speculative conditions.',
  'Use the real project mechanism. Follow current code and specifications and use authoritative tools or data; never substitute invented mocks, guessed heuristics, remembered architectures, or unsupported fallbacks.',
  'Preserve security, permissions, data integrity, rollback, accessibility, and explicit user requirements. If the real path is unavailable, stop and report evidence.'
]);

const ENGINEERING_SANITY_POLICY_LINES = Object.freeze([
  'Continuously review changed code and its real callers for basic SOLID boundaries, N+1 or repeated I/O, unbounded render/recursion/event/retry/polling loops, and disabled checks, swallowed failures, or other verification bypasses.',
  'For database work, inspect the existing canonical data-access path first. Preserve one owned connection/pool lifecycle with bounded acquire, release, shutdown, and reconnect behavior; require atomic transactions, rollback and error propagation, idempotency, and post-commit invariant checks for sensitive, payment, ledger, or multi-step mutations.'
]);

const LEAN_ENGINEERING_POLICY_CANONICAL = CORE_ENGINEERING_DIRECTIVE_LINES.join('\n');

export const LEAN_ENGINEERING_POLICY_HASH = createHash('sha256')
  .update(LEAN_ENGINEERING_POLICY_CANONICAL)
  .digest('hex')
  .slice(0, 16);

// Keep the legacy policy identifiers stable for persisted evidence while the
// user-facing directive stays concise and authoritative.
export const CORE_ENGINEERING_DIRECTIVE_ID = 'sks.core-engineering-directive.v1';
export const CORE_ENGINEERING_DIRECTIVE_HASH = LEAN_ENGINEERING_POLICY_HASH;
export const ENGINEERING_SANITY_POLICY_HASH = createHash('sha256')
  .update(ENGINEERING_SANITY_POLICY_LINES.join('\n'))
  .digest('hex')
  .slice(0, 16);

export function leanPolicyReference() {
  return {
    policy_id: LEAN_ENGINEERING_POLICY_ID,
    policy_hash: LEAN_ENGINEERING_POLICY_HASH
  };
}

export function coreEngineeringDirectiveReference() {
  return {
    directive_id: CORE_ENGINEERING_DIRECTIVE_ID,
    directive_hash: CORE_ENGINEERING_DIRECTIVE_HASH
  };
}

export function coreEngineeringDirectiveText() {
  return ['Core Engineering Directive:', ...CORE_ENGINEERING_DIRECTIVE_LINES].join('\n');
}

export function coreEngineeringDirectiveReferenceText() {
  return `Apply the Core Engineering Directive (${CORE_ENGINEERING_DIRECTIVE_ID}/${CORE_ENGINEERING_DIRECTIVE_HASH}) from AGENTS.md exactly; do not expand it with legacy global rules.`;
}

export function engineeringSanityPolicyText() {
  return [
    `Engineering Sanity Policy (${ENGINEERING_SANITY_POLICY_ID}/${ENGINEERING_SANITY_POLICY_HASH}):`,
    ...ENGINEERING_SANITY_POLICY_LINES
  ].join('\n');
}

/** Execution guidance for capabilities exposed by the current host, never a capability claim. */
export function concurrentToolGuidanceText() {
  return [
    'Tool execution: use the current host\'s exposed capabilities.',
    '- Start slow independent reads early with async tools when available; retain their call/job IDs, continue independent work, and wait only when a dependency is needed. Finish required pending work before claiming completion; never replay a completed side effect.',
    '- Use programmatic tool calling for bounded read/transform batches with known schemas and compact evidence output. Discover deferred tools before starting the program. Keep approvals, adaptive decisions, and native artifact validation direct.',
    '- Async function/custom tools use direct calls, not programmatic callers; multi-agent API mode must not combine async tools with parallel tool calls. Hosted tools and ordinary Promise concurrency do not imply Responses async support.',
    '- Apply new user instructions through native steering while preserving completed work and pending tool results. Do not restart the task or resubmit accepted input just because a continuation is pending.',
    '- Preserve cached request prefixes. Use configuration_update for effort changes only when the host exposes compatible Astra standard single-agent requests, without automatic compaction/truncation; otherwise preserve the selected settings.'
  ].join('\n');
}

export function leanEngineeringCompactText() {
  return coreEngineeringDirectiveText();
}

export function leanEngineeringLongText() {
  return coreEngineeringDirectiveText();
}

export function normalizeLeanDecision(input: unknown = {}, defaults: Partial<LeanDecision> = {}): LeanDecision {
  const value = record(input);
  const defaultFallback = defaults.fallback_plan || { kind: 'none', authority: null, justification: null };
  return {
    schema: LEAN_DECISION_SCHEMA,
    policy_id: LEAN_ENGINEERING_POLICY_ID,
    policy_hash: LEAN_ENGINEERING_POLICY_HASH,
    selected_rung: normalizeRung(value.selected_rung, defaults.selected_rung || 'minimal-custom'),
    task_requires_change: booleanValue(value.task_requires_change, defaults.task_requires_change ?? true),
    root_cause_target: nullableString(value.root_cause_target, defaults.root_cause_target ?? null),
    reused_paths: stringArray(value.reused_paths, defaults.reused_paths),
    stdlib_or_native_choice: nullableString(value.stdlib_or_native_choice, defaults.stdlib_or_native_choice ?? null),
    new_dependency_requested: booleanValue(value.new_dependency_requested, defaults.new_dependency_requested ?? false),
    new_dependency_justification: nullableString(value.new_dependency_justification, defaults.new_dependency_justification ?? null),
    new_abstraction_requested: booleanValue(value.new_abstraction_requested, defaults.new_abstraction_requested ?? false),
    new_abstraction_justification: nullableString(value.new_abstraction_justification, defaults.new_abstraction_justification ?? null),
    fallback_plan: normalizeFallbackPlan(value.fallback_plan, defaultFallback),
    expected_changed_paths: stringArray(value.expected_changed_paths, defaults.expected_changed_paths),
    verification_minimum: stringArray(value.verification_minimum, defaults.verification_minimum)
  };
}

export function validateLeanDecision(input: unknown): { ok: boolean; issues: string[] } {
  const value = record(input);
  const issues: string[] = [];
  if (value.schema !== LEAN_DECISION_SCHEMA) issues.push('schema');
  if (value.policy_id !== LEAN_ENGINEERING_POLICY_ID) issues.push('policy_id');
  if (value.policy_hash !== LEAN_ENGINEERING_POLICY_HASH) issues.push('policy_hash');
  if (!isLeanSolutionRung(value.selected_rung)) issues.push('selected_rung');
  if (typeof value.task_requires_change !== 'boolean') issues.push('task_requires_change');
  if (!Array.isArray(value.reused_paths)) issues.push('reused_paths');
  if (!Array.isArray(value.expected_changed_paths)) issues.push('expected_changed_paths');
  if (!Array.isArray(value.verification_minimum)) issues.push('verification_minimum');
  const fallback = record(value.fallback_plan);
  if (!isFallbackKind(fallback.kind)) issues.push('fallback_plan.kind');
  if (fallback.kind !== 'none' && (!fallback.authority || !fallback.justification)) issues.push('fallback_plan.evidence');
  if (value.new_dependency_requested === true && !value.new_dependency_justification) issues.push('new_dependency_justification');
  if (value.new_abstraction_requested === true && !value.new_abstraction_justification) issues.push('new_abstraction_justification');
  if (value.selected_rung === 'skip' && value.task_requires_change === true) issues.push('skip_requires_no_change');
  if (value.task_requires_change === true && !value.verification_minimum?.length) issues.push('verification_minimum_required');
  return { ok: issues.length === 0, issues };
}

export function parseLeanSimplificationMarkerLine(text: string, file = '', line = 0): LeanSimplificationMarker | null {
  const match = /^\s*(?:(?:\/\/|#)\s*)sks-lean:\s*(.+)$/i.exec(text);
  if (!match) return null;
  const fields = Object.fromEntries((match[1] || '').split(';').map((part) => {
    const [key, ...rest] = part.split('=');
    return [String(key || '').trim(), rest.join('=').trim()];
  }));
  const ceiling = fields.ceiling || null;
  const revisit = fields.revisit_when || null;
  const upgrade = fields.upgrade || null;
  return {
    file,
    line,
    ceiling,
    revisit_when: revisit,
    upgrade,
    status: !revisit ? 'missing-trigger' : !upgrade ? 'missing-upgrade' : 'complete'
  };
}

function normalizeFallbackPlan(input: unknown, defaults: LeanFallbackPlan): LeanFallbackPlan {
  const value = record(input);
  const kind = isFallbackKind(value.kind) ? value.kind : defaults.kind;
  return {
    kind,
    authority: nullableString(value.authority, defaults.authority),
    justification: nullableString(value.justification, defaults.justification)
  };
}

function normalizeRung(value: unknown, fallback: LeanSolutionRung): LeanSolutionRung {
  return isLeanSolutionRung(value) ? value : fallback;
}

function isLeanSolutionRung(value: unknown): value is LeanSolutionRung {
  return typeof value === 'string' && (LEAN_SOLUTION_RUNGS as readonly string[]).includes(value);
}

function isFallbackKind(value: unknown): value is LeanFallbackKind {
  return value === 'none' || value === 'capability' || value === 'compatibility' || value === 'fail-closed';
}

function stringArray(value: unknown, fallback: unknown = []): string[] {
  const source = Array.isArray(value) ? value : Array.isArray(fallback) ? fallback : [];
  return source.map((item) => String(item || '').trim()).filter(Boolean);
}

function nullableString(value: unknown, fallback: string | null = null): string | null {
  const text = String(value ?? '').trim();
  if (text) return text;
  return fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

/**
 * Test volume is the one place where "more" reads as diligence, so it is where
 * over-engineering hides best: hundreds of lines exercising branches the code
 * cannot reach, written because thoroughness feels safe rather than because a
 * failure was plausible.
 *
 * Money is the exception. Where a defect moves funds, exhaustive cases are the
 * correct cost, so paths that handle payments, ledgers, billing or refunds are
 * exempt from this budget entirely.
 */
// Only code that MOVES money is exempt. Displaying a price does not, and a
// too-generous exemption silently switches the budget off where it should hold.
const MONEY_SENSITIVE_PATTERN =
  /(^|[\/_.-])(payment|payout|billing|invoice|charge|refund|ledger|settlement|transaction|subscription|checkout|wallet|balance|payroll)([\/_.-]|s?\.|$)/i;

export function isMoneySensitivePath(file: unknown): boolean {
  return MONEY_SENSITIVE_PATTERN.test(String(file || ''));
}

export function isTestPath(file: unknown): boolean {
  const path = String(file || '');
  return /(^|\/)(__tests__|test|tests)(\/|$)/.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
}

export interface TestVolumeAssessment {
  readonly added_test_lines: number;
  readonly added_source_lines: number;
  readonly ratio: number | null;
  readonly money_sensitive: boolean;
  readonly over_budget: boolean;
}

/**
 * Deliberately conservative: a one-line fix with a focused regression test must
 * never trip this. It fires only when the test volume is large in absolute
 * terms AND dwarfs the code it covers — the "800 lines of tests for a 40-line
 * helper" shape — and never on money-sensitive paths.
 */
export const TEST_VOLUME_ABSOLUTE_FLOOR = 200;
export const TEST_VOLUME_RATIO_LIMIT = 4;

export function assessTestVolume(
  entries: ReadonlyArray<{ path?: unknown; lines_added?: unknown }> = []
): TestVolumeAssessment {
  let addedTestLines = 0;
  let addedSourceLines = 0;
  let moneySensitive = false;
  for (const entry of entries) {
    const added = Number(entry?.lines_added || 0);
    if (!Number.isFinite(added) || added <= 0) continue;
    if (isTestPath(entry?.path)) addedTestLines += added;
    else {
      addedSourceLines += added;
      if (isMoneySensitivePath(entry?.path)) moneySensitive = true;
    }
  }
  const ratio = addedSourceLines > 0 ? addedTestLines / addedSourceLines : null;
  const overBudget = !moneySensitive
    && addedTestLines >= TEST_VOLUME_ABSOLUTE_FLOOR
    && ratio !== null
    && ratio >= TEST_VOLUME_RATIO_LIMIT;
  return {
    added_test_lines: addedTestLines,
    added_source_lines: addedSourceLines,
    ratio,
    money_sensitive: moneySensitive,
    over_budget: overBudget
  };
}
