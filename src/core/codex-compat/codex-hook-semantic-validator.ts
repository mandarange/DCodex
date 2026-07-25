import { type CodexHookEventName, codexHookEventName } from './codex-schema-snapshot.js';
import {
  codexHookIssuesByCategory,
  dedupeCodexHookIssues,
  makeCodexHookIssue,
  type CodexHookIssue,
  type CodexHookIssueCategory
} from './codex-hook-issues.js';
import { asRecordOrNull as asRecord } from '../json/records.js';

export type { CodexHookIssue, CodexHookIssueCategory } from './codex-hook-issues.js';

export type CodexHookSemanticValidation = {
  schema: 'sks.codex-hook-semantic-validation.v2';
  ok: boolean;
  event: CodexHookEventName;
  issues: CodexHookIssue[];
  issues_by_category: Record<CodexHookIssueCategory, number>;
  warnings: string[];
  unsupported: string[];
  fatal: string[];
  reason: string | null;
};

const LEGACY_TOP_LEVEL_KEYS = new Set([
  'permissionDecision',
  'permissionDecisionReason',
  'updatedInput',
  'updatedMCPToolOutput',
  'updatedPermissions',
  'additionalContext',
  'hookEventName'
]);

export function validateCodexHookSemanticOutput(eventLike: unknown, output: any): CodexHookSemanticValidation {
  const event = codexHookEventName(eventLike) || 'UserPromptSubmit';
  const issues: CodexHookIssue[] = [];

  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    pushIssue(issues, 'schema_violation', 'output_not_object', 'Codex hook output must be a JSON object.', '$', { upstream_supported: false });
    return result(event, issues);
  }

  issues.push(...snakeCaseKeyIssues(output));
  for (const key of Object.keys(output)) {
    if (LEGACY_TOP_LEVEL_KEYS.has(key)) pushIssue(issues, 'legacy_shape', `legacy_top_level_${key}`, `Legacy top-level hook field is not accepted by SKS: ${key}.`, `$.${key}`, { upstream_supported: false });
  }

  const actualEvent = output.hookSpecificOutput?.hookEventName;
  if (actualEvent && actualEvent !== event) pushIssue(issues, 'upstream_semantic_unsupported', 'hook_event_mismatch', `Hook output event mismatch: expected ${event} but saw ${actualEvent}.`, '$.hookSpecificOutput.hookEventName', { upstream_supported: false });

  switch (event) {
    case 'PreToolUse':
      validatePreToolUse(output, issues);
      break;
    case 'PermissionRequest':
      validatePermissionRequest(output, issues);
      break;
    case 'PostToolUse':
      validatePostToolUse(output, issues);
      break;
    case 'UserPromptSubmit':
      validateUserPromptSubmit(output, issues);
      break;
    case 'Stop':
      validateStop(output, issues);
      break;
    case 'SubagentStop':
      validateStopLike('SubagentStop', output, issues);
      break;
    case 'PreCompact':
    case 'PostCompact':
      validateCompact(event, output, issues);
      break;
    case 'SessionStart':
      validateSessionStartLike('SessionStart', output, issues);
      break;
    case 'SubagentStart':
      validateSessionStartLike('SubagentStart', output, issues);
      break;
  }

  return result(event, issues);
}

export function validatePreToolUseSemanticOutput(output: any): CodexHookSemanticValidation {
  return validateCodexHookSemanticOutput('PreToolUse', output);
}

export function validatePermissionRequestSemanticOutput(output: any): CodexHookSemanticValidation {
  return validateCodexHookSemanticOutput('PermissionRequest', output);
}

export function validatePostToolUseSemanticOutput(output: any): CodexHookSemanticValidation {
  return validateCodexHookSemanticOutput('PostToolUse', output);
}

export function validateUserPromptSubmitSemanticOutput(output: any): CodexHookSemanticValidation {
  return validateCodexHookSemanticOutput('UserPromptSubmit', output);
}

export function validateStopSemanticOutput(output: any): CodexHookSemanticValidation {
  return validateCodexHookSemanticOutput('Stop', output);
}

export function validateCompactSemanticOutput(event: Extract<CodexHookEventName, 'PreCompact' | 'PostCompact'>, output: any): CodexHookSemanticValidation {
  return validateCodexHookSemanticOutput(event, output);
}

export function validateSessionStartSemanticOutput(output: any): CodexHookSemanticValidation {
  return validateCodexHookSemanticOutput('SessionStart', output);
}

export function validateSubagentStartSemanticOutput(output: any): CodexHookSemanticValidation {
  return validateCodexHookSemanticOutput('SubagentStart', output);
}

export function validateSubagentStopSemanticOutput(output: any): CodexHookSemanticValidation {
  return validateCodexHookSemanticOutput('SubagentStop', output);
}

function validatePreToolUse(output: any, issues: CodexHookIssue[]) {
  rejectUniversal(output, 'PreToolUse', issues, { continueFalse: true, stopReason: true, suppressOutput: true });
  if (output.decision !== undefined) {
    if (output.decision === 'approve') pushUpstreamUnsupported(issues, 'pretooluse_decision_approve', 'PreToolUse hook returned unsupported decision:approve', '$.decision');
    else if (output.decision === 'block') pushIssue(issues, 'legacy_shape', 'pre_tool_use_legacy_decision_block', 'PreToolUse hook returned legacy top-level decision:block.', '$.decision', { upstream_supported: false });
    else pushIssue(issues, 'legacy_shape', 'pre_tool_use_legacy_decision', `PreToolUse hook returned legacy top-level decision:${String(output.decision)}.`, '$.decision', { upstream_supported: false });
  }
  if (output.reason !== undefined) pushIssue(issues, 'legacy_shape', 'pre_tool_use_legacy_reason', 'PreToolUse hook returned legacy top-level reason.', '$.reason', { upstream_supported: false });

  const specific = asRecord(output.hookSpecificOutput);
  if (!specific) return;
  if (specific.additionalContext !== undefined && typeof specific.additionalContext !== 'string') {
    pushIssue(issues, 'schema_violation', 'pretooluse_additional_context_type', 'PreToolUse additionalContext must be a string.', '$.hookSpecificOutput.additionalContext', { upstream_supported: false });
  }
  const decision = specific.permissionDecision;
  const hasUpdatedInput = Object.prototype.hasOwnProperty.call(specific, 'updatedInput');
  const hasReason = Object.prototype.hasOwnProperty.call(specific, 'permissionDecisionReason');

  if (decision === 'ask') pushUpstreamUnsupported(issues, 'pretooluse_permission_decision_ask', 'PreToolUse hook returned unsupported permissionDecision:ask', '$.hookSpecificOutput.permissionDecision');
  if (decision === 'allow' && !hasUpdatedInput) pushUpstreamUnsupported(issues, 'pretooluse_allow_without_updated_input', 'PreToolUse hook returned unsupported permissionDecision:allow', '$.hookSpecificOutput.permissionDecision');
  if (hasUpdatedInput && decision !== 'allow') pushUpstreamUnsupported(issues, 'pretooluse_updated_input_without_allow', 'PreToolUse hook returned updatedInput without permissionDecision:allow', '$.hookSpecificOutput.updatedInput');
  if (decision === 'deny' && !nonEmpty(specific.permissionDecisionReason)) pushUpstreamUnsupported(issues, 'pretooluse_deny_without_reason', 'PreToolUse hook returned permissionDecision:deny without a non-empty permissionDecisionReason', '$.hookSpecificOutput.permissionDecisionReason');
  if (!decision && hasReason) pushUpstreamUnsupported(issues, 'pretooluse_reason_without_decision', 'PreToolUse hook returned permissionDecisionReason without permissionDecision', '$.hookSpecificOutput.permissionDecisionReason');
}

function validatePermissionRequest(output: any, issues: CodexHookIssue[]) {
  rejectUniversal(output, 'PermissionRequest', issues, { continueFalse: true, stopReason: true, suppressOutput: true });
  const decision = asRecord(output.hookSpecificOutput?.decision);
  if (!decision) return;
  if (decision.updatedInput !== undefined) pushUpstreamUnsupported(issues, 'permission_request_reserved_updatedInput', 'PermissionRequest hook returned unsupported updatedInput', '$.hookSpecificOutput.decision.updatedInput');
  if (decision.updatedPermissions !== undefined) pushUpstreamUnsupported(issues, 'permission_request_reserved_updatedPermissions', 'PermissionRequest hook returned unsupported updatedPermissions', '$.hookSpecificOutput.decision.updatedPermissions');
  if (decision.interrupt === true) pushUpstreamUnsupported(issues, 'permission_request_reserved_interrupt', 'PermissionRequest hook returned unsupported interrupt:true', '$.hookSpecificOutput.decision.interrupt');
  if (decision.behavior === 'deny' && !nonEmpty(decision.message)) pushUpstreamUnsupported(issues, 'permission_request_deny_without_message', 'PermissionRequest hook returned deny without a non-empty message', '$.hookSpecificOutput.decision.message');
  if (decision.behavior === 'allow' && decision.message !== undefined) pushStrictSubset(issues, 'permission_request_allow_message', 'PermissionRequest allow message is schema-compatible but disallowed by the SKS zero-warning strict subset.', '$.hookSpecificOutput.decision.message');
}

function validatePostToolUse(output: any, issues: CodexHookIssue[]) {
  rejectUniversal(output, 'PostToolUse', issues, { suppressOutput: true });
  const block = output.decision === 'block';
  if (block && !nonEmpty(output.reason)) pushUpstreamUnsupported(issues, 'posttooluse_block_without_reason', 'PostToolUse hook returned decision:block without a non-empty reason', '$.reason');
  if (!block && output.reason !== undefined) pushUpstreamUnsupported(issues, 'posttooluse_reason_without_decision', 'PostToolUse hook returned reason without decision', '$.reason');
  if (output.hookSpecificOutput?.updatedMCPToolOutput !== undefined) {
    pushUpstreamUnsupported(issues, 'posttooluse_updated_mcp_tool_output', 'PostToolUse hook returned unsupported updatedMCPToolOutput', '$.hookSpecificOutput.updatedMCPToolOutput');
  }
}

function validateUserPromptSubmit(output: any, issues: CodexHookIssue[]) {
  const block = output.decision === 'block';
  if (block && !nonEmpty(output.reason)) pushUpstreamUnsupported(issues, 'userpromptsubmit_block_without_reason', 'UserPromptSubmit hook returned decision:block without a non-empty reason', '$.reason');
  if (!block && output.reason !== undefined) pushUpstreamUnsupported(issues, 'userpromptsubmit_reason_without_decision', 'UserPromptSubmit hook returned reason without decision', '$.reason');
}

function validateStop(output: any, issues: CodexHookIssue[]) {
  validateStopLike('Stop', output, issues);
}

function validateStopLike(event: Extract<CodexHookEventName, 'Stop' | 'SubagentStop'>, output: any, issues: CodexHookIssue[]) {
  rejectUniversal(output, event, issues, { continueFalse: true, stopReason: true, suppressOutput: true });
  const block = output.decision === 'block';
  const stem = event.toLowerCase();
  if (block && !nonEmpty(output.reason)) pushUpstreamUnsupported(issues, `${stem}_block_without_reason`, `${event} hook returned decision:block without a non-empty reason`, '$.reason');
  if (!block && output.reason !== undefined) pushUpstreamUnsupported(issues, `${stem}_reason_without_decision`, `${event} hook returned reason without decision`, '$.reason');
}

function validateCompact(event: CodexHookEventName, output: any, issues: CodexHookIssue[]) {
  rejectUniversal(output, event, issues, { continueFalse: true, stopReason: true, suppressOutput: true });
  for (const key of ['decision', 'reason', 'hookSpecificOutput']) {
    if (output[key] !== undefined) pushUpstreamUnsupported(issues, `${event}_${key}_unsupported`, `${event} hook returned unsupported ${key}`, `$.${key}`);
  }
}

function validateSessionStartLike(event: Extract<CodexHookEventName, 'SessionStart' | 'SubagentStart'>, output: any, issues: CodexHookIssue[]) {
  const stem = event.toLowerCase();
  if (output.reason !== undefined) pushUpstreamUnsupported(issues, `${stem}_reason`, `${event} hook returned reason`, '$.reason');
  if (output.decision !== undefined) pushUpstreamUnsupported(issues, `${stem}_decision`, `${event} hook returned decision`, '$.decision');
}

function rejectUniversal(output: any, event: string, issues: CodexHookIssue[], rules: { continueFalse?: boolean; stopReason?: boolean; suppressOutput?: boolean }) {
  const stem = event.toLowerCase();
  if (rules.continueFalse && output.continue === false) pushUpstreamUnsupported(issues, `${stem}_continue_false`, `${event} hook returned unsupported continue:false`, '$.continue');
  if (rules.stopReason && output.stopReason !== undefined) pushUpstreamUnsupported(issues, `${stem}_stop_reason`, `${event} hook returned unsupported stopReason`, '$.stopReason');
  if (rules.suppressOutput && output.suppressOutput === true) pushUpstreamUnsupported(issues, `${stem}_suppress_output`, `${event} hook returned unsupported suppressOutput`, '$.suppressOutput');
}

function pushUpstreamUnsupported(issues: CodexHookIssue[], code: string, message: string, path?: string) {
  pushIssue(issues, 'upstream_semantic_unsupported', code, message, path, { upstream_supported: false });
}

function pushStrictSubset(issues: CodexHookIssue[], code: string, message: string, path?: string) {
  pushIssue(issues, 'sks_zero_warning_disallowed', code, message, path, { upstream_supported: true, sks_disallowed: true });
}

function pushIssue(issues: CodexHookIssue[], category: CodexHookIssueCategory, code: string, message: string, path?: string, flags: { upstream_supported?: boolean; sks_disallowed?: boolean } = {}) {
  issues.push(makeCodexHookIssue(category, code, message, {
    ...(path ? { path } : {}),
    ...flags,
    sks_disallowed: flags.sks_disallowed ?? true
  }));
}

function result(event: CodexHookEventName, issues: CodexHookIssue[]): CodexHookSemanticValidation {
  const uniqueIssues = dedupeCodexHookIssues(issues);
  const uniqueUnsupported = uniqueIssues
    .filter((issue) => issue.category === 'upstream_semantic_unsupported')
    .map((issue) => issue.message);
  const uniqueFatal = uniqueIssues.map((issue) => issue.message);
  return {
    schema: 'sks.codex-hook-semantic-validation.v2',
    ok: uniqueIssues.length === 0,
    event,
    issues: uniqueIssues,
    issues_by_category: codexHookIssuesByCategory(uniqueIssues),
    warnings: [],
    unsupported: uniqueUnsupported,
    fatal: uniqueFatal,
    reason: uniqueFatal[0] || null
  };
}

function nonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function snakeCaseKeyIssues(value: unknown, pointer = '$'): CodexHookIssue[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => snakeCaseKeyIssues(item, `${pointer}[${index}]`));
  const issues: CodexHookIssue[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (key === 'updatedInput' || key === 'updatedMCPToolOutput') continue;
    if (/_/.test(key)) issues.push(makeCodexHookIssue('legacy_shape', 'snake_case', `Snake_case hook key is not accepted by SKS: ${pointer}.${key}.`, { path: `${pointer}.${key}`, upstream_supported: false, sks_disallowed: true }));
    issues.push(...snakeCaseKeyIssues(child, `${pointer}.${key}`));
  }
  return issues;
}
