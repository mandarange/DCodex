import path from 'node:path';
import { projectRoot, readJson } from '../fsx.js';
import { listSessionStates, loadOwnedRouteState, missionDir, setCurrent } from '../mission.js';
import { PIPELINE_PLAN_ARTIFACT, pipelinePlanState, projectGateStatus, writePipelinePlan } from '../pipeline.js';
import { routePrompt } from '../routes.js';
import { positionalArgs } from '../../cli/args.js';
import { flag, readFlagValue, resolveMissionId } from './command-utils.js';

export async function pipelineCommand(args: any = []) {
  const root = await projectRoot();
  const action = args[0] || 'status';
  const sessionKey = process.env.SKS_NARUTO_STANDALONE_CLI === '1' ? '' : process.env.CODEX_THREAD_ID;
  const state = await loadOwnedRouteState(root, sessionKey);
  const sessions = await listSessionStates(root);
  if (action === 'status') {
    const result = { schema: 'sks.pipeline-status.v1', ok: true, state, sessions: sessions.map(sessionStatusRow) };
    if (flag(args, '--json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`Pipeline: ${state.mission_id || 'none'} ${state.route_command || state.mode || ''}`.trim());
    printSessionTable(sessions);
    return;
  }
  if (action === 'plan') {
    if (hasAgentPlanFlags(args)) {
      const positionals = positionalArgs(args.slice(1));
      const missionArg = positionals[0] || state.mission_id || 'latest';
      const id = await resolveMissionId(root, missionArg);
      if (!id) throw new Error('No mission found for pipeline plan.');
      const dir = missionDir(root, id);
      const mission = await readJson(path.join(dir, 'mission.json'), {});
      const routeContext = await readJson(path.join(dir, 'route-context.json'), {});
      const rawRoute = readFlagValue(args, '--route', null) || routeContext.command || state.route_command || routeContext.route || state.route || '$Naruto';
      const route = routePrompt(rawRoute);
      const agentsFlag = readFlagValue(args, '--agents', null);
      const agents = {
        count: agentsFlag ? Number(agentsFlag) : undefined,
        force: flag(args, '--force-agents'),
        noAgents: flag(args, '--no-agents')
      };
      const plan = await writePipelinePlan(dir, {
        missionId: id,
        route,
        task: routeContext.task || mission.prompt || state.prompt || '',
        required: Boolean(routeContext.context7_required || state.context7_required),
        ambiguity: { required: true, auto_sealed: true, status: 'auto_sealed' },
        agents
      });
      // Re-planning the active mission re-seeds engineering-sanity-review.json
      // against a freshly resolved changed-scope base; the route state has to
      // follow the plan or the Stop gate would validate against a stale base.
      if (id === state.mission_id) {
        await setCurrent(root, { mission_id: id, ...pipelinePlanState(plan) }, { sessionKey: state._session_key });
      }
      if (flag(args, '--json')) return console.log(JSON.stringify({ schema: 'sks.pipeline-plan.v1', ok: true, mission_id: id, plan }, null, 2));
      console.log(`Pipeline plan written: .sneakoscope/missions/${id}/${PIPELINE_PLAN_ARTIFACT}`);
      return;
    }
    const result = await projectGateStatus(root, state);
    if (flag(args, '--json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`Pipeline gate: ${result.ok ? 'pass' : 'blocked'}`);
    return;
  }
  console.error('Usage: sks pipeline status|plan [--json]');
  process.exitCode = 1;
}

function sessionStatusRow(row: any) {
  return {
    session_key: row.session_key,
    mission_id: row.mission_id,
    route: row.state?.route_command || row.state?.route || row.state?.mode || null,
    phase: row.phase,
    updated_at: row.updated_at
  };
}

function printSessionTable(sessions: any[] = []) {
  if (!sessions.length) return;
  console.log('Sessions:');
  for (const row of sessions.slice(0, 12).map(sessionStatusRow)) {
    console.log(`  ${row.session_key}  ${row.mission_id || 'none'}  ${row.route || '-'}  ${row.phase || '-'}`);
  }
}

function hasAgentPlanFlags(args: any = []) {
  return flag(args, '--force-agents') || flag(args, '--no-agents') || args.includes('--agents');
}
