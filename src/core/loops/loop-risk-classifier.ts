import type { SksLoopNode, SksLoopRisk } from './loop-schema.js';

export function classifyLoopRisk(node: Pick<SksLoopNode, 'loop_id' | 'owner_scope' | 'level'>): SksLoopRisk {
  const scope = [
    ...node.owner_scope.files,
    ...node.owner_scope.directories,
    ...node.owner_scope.package_scripts,
    ...node.owner_scope.release_gate_ids
  ].join(' ').toLowerCase();
  const reasons: string[] = [];
  let level: SksLoopRisk['level'] = 'low';
  if (/(db|mad-sks.*sql-plane|mcp|token|auth|postinstall|publish|global config)/.test(scope)) {
    level = 'critical';
    reasons.push('critical_scope');
  } else if (/(release-gates|worktree|scheduler|codex-control|agent|worker-runtime)/.test(scope)) {
    level = 'high';
    reasons.push('runtime_or_scheduler_scope');
  } else if (/(qa-loop|research|image|docs)/.test(scope)) {
    level = 'medium';
    reasons.push('domain_scope');
  } else {
    reasons.push('bounded_scope');
  }
  const requiresHuman = level === 'critical';
  return {
    level,
    reasons,
    requires_worktree: level === 'medium' || level === 'high' || level === 'critical',
    requires_gpt_final: level !== 'low',
    requires_human_handoff: requiresHuman
  };
}

export function loopLevelAllowedUnattended(node: SksLoopNode): boolean {
  return node.level === 'L3-unattended'
    && (node.risk.level === 'low' || node.risk.level === 'medium')
    && node.owner_scope.exclusive
    && node.budget.max_changed_files <= 8
    && node.gates.local.length > 0
    && !node.risk.requires_human_handoff;
}
