import type { SksLoopNode, SksLoopRole } from '../loops/loop-schema.js';
import type { CodexAppExecutionProfile } from '../codex-app/codex-app-types.js';

export interface NarutoLoopWorkerRoute {
  schema: 'sks.naruto-loop-worker-route.v1';
  loop_id: string;
  maker_role: string;
  checker_role: string;
  prompt: string;
  allowed_files: string[];
  allowed_directories: string[];
  gates: string[];
  agent_role_strategy: CodexAppExecutionProfile['agent_role_strategy'] | 'message-role';
  agent_type: string | null;
  message_role_prefix: string | null;
  execution_profile_artifact: string | null;
  mutation_outside_owner_scope_allowed: false;
}

export function routeNarutoLoopWorker(node: SksLoopNode, role: Extract<SksLoopRole, 'maker' | 'checker'>, profile?: CodexAppExecutionProfile | null): NarutoLoopWorkerRoute {
  const domain = node.loop_id.replace(/^loop-/, '');
  const roles = roleLabels(domain);
  const gates = [...node.gates.triage, ...node.gates.local, ...node.gates.checker, ...node.gates.integration, ...node.gates.final];
  const roleName = role === 'maker' ? roles.maker : roles.checker;
  const strategy = profile?.agent_role_strategy || 'message-role';
  return {
    schema: 'sks.naruto-loop-worker-route.v1',
    loop_id: node.loop_id,
    maker_role: roles.maker,
    checker_role: roles.checker,
    prompt: [
      `loop purpose: ${node.purpose}`,
      `role: ${roleName}`,
      `agent role strategy: ${strategy}`,
      `agent_type: ${strategy === 'agent_type' ? roleName.replace(/\s+/g, '-') : '-'}`,
      `message role prefix: ${strategy === 'message-role' ? `Role: ${roleName}.` : '-'}`,
      `owner files: ${node.owner_scope.files.join(', ') || '-'}`,
      `owner directories: ${node.owner_scope.directories.join(', ') || '-'}`,
      `gates: ${gates.join(', ') || '-'}`,
      `state file: ${node.state_file}`,
      `budget: ${JSON.stringify(node.budget)}`,
      `collision policy: ${node.owner_scope.collision_policy}`,
      'Do not mutate outside owner scope.'
    ].join('\n'),
    allowed_files: node.owner_scope.files,
    allowed_directories: node.owner_scope.directories,
    gates,
    agent_role_strategy: strategy,
    agent_type: strategy === 'agent_type' ? roleName.replace(/\s+/g, '-') : null,
    message_role_prefix: strategy === 'message-role' ? `Role: ${roleName}.` : null,
    execution_profile_artifact: profile?.artifact_path || null,
    mutation_outside_owner_scope_allowed: false
  };
}

function roleLabels(domain: string): { maker: string; checker: string } {
  if (domain.includes('release')) return { maker: 'release optimizer', checker: 'release gate verifier' };
  if (domain.includes('research')) return { maker: 'source shard/synthesis', checker: 'final reviewer' };
  if (domain.includes('codex')) return { maker: 'capability/probe implementer', checker: 'real probe verifier' };
  return { maker: `${domain} implementer`, checker: `${domain} checker` };
}
