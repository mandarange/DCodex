import path from 'node:path';
import { readJson } from '../fsx.js';
import { managedOfficialSubagentRoleByName } from '../managed-assets/managed-assets-manifest.js';
import { ASTRA_SUBAGENT_MODEL } from '../subagents/model-policy.js';

export async function sealedSubagentRoutingContext(artifactDir: string, payload: any = {}) {
  const plan: any = await readJson(path.join(artifactDir, 'subagent-plan.json'), null).catch(() => null);
  if (!plan || plan.workflow !== 'official_codex_subagent') return '';
  const agentName = extractSubagentAgentName(payload);
  const agents = plan.agents && typeof plan.agents === 'object' ? plan.agents : {};
  const planned = agentName && agents[agentName] ? agents[agentName] : null;
  const role = agentName ? managedOfficialSubagentRoleByName(agentName) : null;
  if (!agentName) return '';
  const model = ASTRA_SUBAGENT_MODEL;
  const plannedModel = String(planned?.routed_model || planned?.model || '').trim();
  const effort = String((plannedModel === ASTRA_SUBAGENT_MODEL
    ? planned?.routed_model_reasoning_effort || planned?.model_reasoning_effort
    : null) || role?.model_reasoning_effort || 'medium').trim();
  return [
    'SKS sealed child routing:',
    agentName ? `- custom agent: ${agentName}` : null,
    model ? `- model: ${model}` : null,
    effort ? `- model_reasoning_effort: ${effort}` : null,
    '- keep this sealed profile; do not retarget model/effort or spawn nested agents'
  ].filter(Boolean).join('\n');
}

function extractSubagentAgentName(payload: any = {}) {
  const candidates = [
    payload.agent_type,
    payload.agentType,
    payload.subagent_type,
    payload.subagentType,
    payload.agent_name,
    payload.agentName,
    payload.agent,
    payload.role,
    payload.payload?.agent_type,
    payload.payload?.agentType,
    payload.payload?.subagent_type,
    payload.data?.agent_type,
    payload.input?.agent_type
  ];
  for (const value of candidates) {
    const name = String(value || '').trim();
    if (name) return name;
  }
  return '';
}

export function subagentRouteContext(state: any = {}) {
  if (state?.route_closed === true || (!state?.route && !state?.mode)) return '';
  const route = state.route_command || state.route || state.mode;
  const mission = state.mission_id ? ` for mission ${state.mission_id}` : '';
  const artifacts = state.mission_id
    ? ` Read only the route artifacts relevant to your assigned slice under .sneakoscope/missions/${state.mission_id}/.`
    : '';
  const databaseBoundary = String(state.mode || state.route || '').toUpperCase() === 'DB'
    ? ' Keep database inspection read-only unless the parent supplied a separately sealed mutation contract.'
    : '';
  return `You are a child thread on ${route}${mission}. Execute only the slice assigned by the parent.${artifacts} Do not spawn or delegate other agents, wait for sibling threads, integrate sibling results, close the parent route, or author the sks.subagent-parent-summary.v1 parent result. Return a concise slice result to the parent.${databaseBoundary}`;
}

export function officialSubagentSkillGuardBinding(
  state: any = {},
  options: { allowClosedOfficialChild?: boolean } = {}
) {
  const missionId = String(state?.mission_id || '').trim();
  const workflowRunId = String(state?.official_subagent_run_id || '').trim();
  const routeIdentity = String(
    state?.mode || state?.route || state?.route_command || ''
  ).replace(/^\$/, '').toUpperCase();
  const activeNaruto = routeIdentity === 'NARUTO' || routeIdentity === 'SKS-NARUTO';
  if (state?.route_closed === true) {
    return options.allowClosedOfficialChild && activeNaruto && missionId && workflowRunId
      ? { missionId, workflowRunId }
      : null;
  }
  if (!activeNaruto && (!missionId || !workflowRunId)) return null;
  return { missionId, workflowRunId };
}
