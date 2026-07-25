import path from 'node:path'
import { nowIso, writeJsonAtomic } from '../fsx.js'
import { readCodexHookActualState } from '../codex-hooks/codex-hook-actual-discovery.js'
import { installManagedCodexHooks } from '../codex-hooks/codex-hook-managed-install.js'
import { probeCodexHookApprovalState } from './codex-hook-approval-probe.js'
import type { CodexHookApprovalProbe, CodexHookApprovalState } from './codex-app-types.js'
import { messageOf } from '../errors/message.js'

interface HookLifecycleEvent {
  event: string
  actions: string[]
  sks_action: string
  installed: boolean
  approval_state: CodexHookApprovalState
  counted_as_evidence: boolean
}

interface CodexHookLifecycleReport {
  schema: 'sks.codex-hook-lifecycle.v1'
  generated_at: string
  ok: boolean
  apply: boolean
  approval_state: CodexHookApprovalState
  approval_state_detectable: boolean
  lifecycle: Record<string, HookLifecycleEvent>
  actual_state: unknown
  install: unknown
  probe: CodexHookApprovalProbe
  blockers: string[]
  warnings: string[]
}

export async function buildCodexHookLifecycle(input: { root?: string; apply?: boolean } = {}): Promise<CodexHookLifecycleReport> {
  const root = path.resolve(input.root || process.cwd())
  const install = input.apply === true
    ? await installManagedCodexHooks(root).catch((err: unknown) => ({ ok: false, blockers: [messageOf(err)] }))
    : null
  const actual = await readCodexHookActualState(root).catch((err: unknown) => ({ ok: false, entries: [], blockers: [messageOf(err)] }))
  const probe = await probeCodexHookApprovalState(root).catch((err: unknown) => ({
    schema: 'sks.codex-hook-approval-probe.v1' as const,
    generated_at: nowIso(),
    ok: false,
    detectable: false,
    approval_state: 'unknown' as const,
    sources_checked: [],
    blockers: [messageOf(err)],
    warnings: ['hook_approval_probe_failed']
  }))
  const events = {
    UserPromptSubmit: ['route_classifier', 'goal_to_loop_compiler', 'permission_profile_badge'],
    PreToolUse: ['requested_scope_guard', 'mad_sks_sql_plane_priority_resolver', 'side_effect_zero_gate'],
    PostToolUse: ['evidence_ledger', 'mutation_ledger', 'side_effect_scanner', 'context7_native_session_updates'],
    Stop: ['continuation_enforcer', 'final_proof_check', 'loop_resume_hint'],
    Notification: ['operator_status', 'zellij_anchor', 'codex_app_status']
  }
  const installedEvents = new Set(Array.isArray(actual.entries) ? actual.entries.map((entry: { event?: unknown }) => String(entry.event || '')) : [])
  const report: CodexHookLifecycleReport = {
    schema: 'sks.codex-hook-lifecycle.v1',
    generated_at: nowIso(),
    ok: actual.ok !== false && probe.approval_state !== 'modified_requires_reapproval',
    apply: input.apply === true,
    approval_state: probe.approval_state,
    approval_state_detectable: probe.detectable,
    lifecycle: Object.fromEntries(Object.entries(events).map(([event, actions]) => [event, {
      event,
      actions,
      sks_action: actions.join(','),
      installed: installedEvents.has(event),
      approval_state: installedEvents.has(event) ? probe.approval_state : 'not_installed',
      counted_as_evidence: installedEvents.has(event) && probe.approval_state === 'approved'
    }])) as Record<string, HookLifecycleEvent>,
    actual_state: actual,
    install,
    probe,
    blockers: [
      ...(Array.isArray(actual.blockers) ? actual.blockers.map(String) : []),
      ...(probe.approval_state === 'modified_requires_reapproval' ? ['hook_modified_requires_reapproval'] : [])
    ],
    warnings: [
      ...probe.warnings,
      ...(probe.approval_state === 'pending_review' ? ['hook_approval_pending_review'] : []),
      ...(probe.approval_state === 'unknown' ? ['hook_approval_state_unknown'] : [])
    ]
  }
  await writeJsonAtomic(path.join(root, '.sneakoscope', 'reports', 'codex-hook-lifecycle.json'), report).catch(() => undefined)
  return report
}
