import type { SksLoopGatePlan, SksLoopNode, SksLoopRisk } from './loop-schema.js';

export function selectLoopGates(input: {
  node: SksLoopNode;
  changedFiles: string[];
  risk: SksLoopRisk;
  packageScriptsChanged?: string[];
  releaseGateIdsChanged?: string[];
}): SksLoopGatePlan {
  const files = input.changedFiles.join(' ');
  const triage = ['loop:state-valid', 'loop:budget-valid'];
  const local = new Set<string>();
  if (input.node.level === 'L0-report') return { triage, local: [], checker: [], integration: [], final: [] };
  if (isDocsOnly(input.changedFiles, input.node)) add(local, ['docs:loop-runtime', 'changelog:check']);
  else if (/release/.test(files) || input.node.loop_id.includes('release')) add(local, ['release:affected-selector', 'release:dynamic-presets']);
  else if (/research/.test(files) || input.node.loop_id.includes('research')) add(local, ['research:quality-contract']);
  else if (/qa-loop/.test(files) || input.node.loop_id.includes('qa-loop')) add(local, ['qa-loop:app-handoff-gate-lifecycle']);
  else if (/codex/.test(files) || input.node.loop_id.includes('codex')) add(local, ['codex:current-core-capability', 'codex-sdk:version-compat']);
  else if (/mad-sks.*sql-plane|db-safety/.test(files) || input.node.loop_id.includes('mad-sks-sql-plane')) add(local, ['mad-sks:sql-plane-capability', 'mad-sks:sql-plane-operation-lifecycle']);
  else if (/agent|scheduler|worker-runtime/.test(files) || input.node.loop_id.includes('naruto')) add(local, ['parallel:runtime-real-blackbox', 'scheduler:utilization-proof']);
  else add(local, ['loop:affected']);
  const integration = new Set<string>();
  if ((input.packageScriptsChanged || []).length || (input.releaseGateIdsChanged || []).length || files.includes('package.json') || files.includes('release-gates.v2.json')) {
    integration.add('release:dag-full-coverage');
  }
  if (input.risk.level === 'high') integration.add('loop:integration-required');
  const final = new Set<string>();
  if (input.changedFiles.length || input.risk.requires_gpt_final) final.add('gpt:final-arbiter');
  if (input.risk.level === 'critical') final.add('human:handoff-required');
  return {
    triage,
    local: [...local],
    checker: input.node.level === 'L2-action' ? ['loop:checker-fresh-session'] : [],
    integration: [...integration],
    final: [...final]
  };
}

function isDocsOnly(files: string[], node: SksLoopNode): boolean {
  const scoped = [...files, ...node.owner_scope.files, ...node.owner_scope.directories];
  return scoped.length > 0 && scoped.every((file) => file === 'README.md' || file === 'CHANGELOG.md' || file.startsWith('docs'));
}

function add(target: Set<string>, values: string[]): void {
  for (const value of values) target.add(value);
}
