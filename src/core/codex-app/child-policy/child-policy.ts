import {
  stableArchitectureHash,
  type ChildPolicySnapshot,
  type ProviderPolicySnapshot,
  type SessionPin
} from '../../architecture-hardening/contracts/contracts.js';
import { sessionPinHash } from '../session-policy/session-pinning.js';

export interface ChildSelectionDecision {
  readonly schema: 'sks.child-selection-decision.v1';
  readonly ok: boolean;
  readonly owner: ChildPolicySnapshot['owner'];
  readonly model: string | null;
  readonly parent_snapshot_hash: string;
  readonly blockers: readonly string[];
}

export function createChildPolicySnapshot(
  policy: ProviderPolicySnapshot,
  registeredOpenRouterModels: readonly string[] = []
): ChildPolicySnapshot {
  const owner: ChildPolicySnapshot['owner'] = policy.mode === 'chatgpt-oauth' ? 'codex-native' : policy.mode === 'codex-lb' ? 'codex-lb' : 'sks-center';
  const allowed = policy.mode === 'openrouter'
    ? registeredOpenRouterModels.filter((model) => policy.allowed_models.includes(model) && model.includes('/'))
    : policy.mode === 'codex-lb' ? policy.allowed_models.filter((model) => !model.includes('/')) : [];
  const base = { schema: 'sks.child-policy-snapshot.v1' as const, mode: policy.mode, owner, allowed_models: [...new Set(allowed)].sort() };
  return { ...base, policy_hash: stableArchitectureHash(base) };
}

export function decideChildSelection(input: {
  session: SessionPin;
  policy: ChildPolicySnapshot;
  requestedModel?: string | null;
}): ChildSelectionDecision {
  const parentHash = sessionPinHash(input.session);
  const blocked = (code: string): ChildSelectionDecision => ({
    schema: 'sks.child-selection-decision.v1', ok: false, owner: input.policy.owner, model: null,
    parent_snapshot_hash: parentHash, blockers: [code]
  });
  if (input.session.mode !== input.policy.mode) return blocked('child_policy_mode_mismatch');
  if (input.session.child_policy_hash !== input.policy.policy_hash) return blocked('child_policy_snapshot_mismatch');
  const requested = String(input.requestedModel || '').trim();
  if (input.policy.mode === 'chatgpt-oauth') {
    if (requested) return blocked('child_policy_oauth_override_forbidden');
    return { schema: 'sks.child-selection-decision.v1', ok: true, owner: 'codex-native', model: null, parent_snapshot_hash: parentHash, blockers: [] };
  }
  if (input.policy.mode === 'codex-lb' && !requested) {
    return { schema: 'sks.child-selection-decision.v1', ok: true, owner: 'codex-lb', model: null, parent_snapshot_hash: parentHash, blockers: [] };
  }
  if (!input.policy.allowed_models.includes(requested)) return blocked(input.policy.mode === 'openrouter' ? 'child_policy_openrouter_model_unregistered' : 'child_policy_lb_model_outside_family');
  if (!input.session.allowed_models.includes(requested)) return blocked('child_policy_parent_model_mismatch');
  return { schema: 'sks.child-selection-decision.v1', ok: true, owner: input.policy.owner, model: requested, parent_snapshot_hash: parentHash, blockers: [] };
}
