import path from 'node:path';
import { projectRoot, readJson } from '../fsx.js';
import {
  findLatestMission,
  missionDir,
  validateExternallyReservedMissionId
} from '../mission.js';
import { prepareRoute } from '../pipeline-internals/runtime-core.js';
import { maybeFinalizeRoute } from '../proof/auto-finalize.js';
import { sksPrefixedDollarCommand } from '../routes/dollar-prefix.js';
import { closeWorkOrderLedgerForRouteResult } from '../work-order-ledger.js';
import {
  ALIGN_GATE_ARTIFACT,
  ALIGN_LEDGER_ARTIFACT,
  ALIGN_PLAN_ARTIFACT,
  alignNextActionText,
  refreshAlignGate
} from '../align/align-route.js';
import { flag, promptOf, warnOnMultipleActiveSessions } from './command-utils.js';
import { printJson } from '../../cli/output.js';

const ACTIONS = new Set(['prepare', 'run', 'status', 'proof', 'fixture', 'help', '--help', '-h']);

export async function alignCommand(sub: any = 'prepare', args: any[] = []) {
  const action = String(sub || 'prepare').toLowerCase();
  if (action === 'help' || action === '--help' || action === '-h') return printHelp();
  if (action === 'prepare' || action === 'run') return alignPrepare(args, action);
  if (action === 'status') return alignStatus(args);
  if (action === 'proof') return alignProof(args);
  if (action === 'fixture') return alignFixture(args);
  if (!ACTIONS.has(action) && !String(sub || '').startsWith('-')) {
    return alignPrepare([String(sub), ...args], 'prepare');
  }
  console.error('Usage: sks align prepare|run|status|proof [task|mission] [--json]');
  process.exitCode = 1;
}

async function alignPrepare(args: any[], action: string) {
  const root = await projectRoot();
  const task = promptOf(args) || 'Align SKS prompts, settings, and skills to the latest GPT-5.6 official guides';
  const prepared: any = await prepareRoute(root, `$sks-align ${task}`, {});
  const missionId = String(prepared?.mission_id || '').trim();
  const result = {
    schema: 'sks.align-command.v2',
    schema_version: 2,
    ok: Boolean(missionId),
    action,
    mission_id: missionId || null,
    route: prepared?.route?.command
      ? sksPrefixedDollarCommand(prepared.route.command)
      : '$sks-align',
    stop_gate: prepared?.route?.stopGate || ALIGN_GATE_ARTIFACT,
    artifacts: missionId
      ? {
          plan: `.sneakoscope/missions/${missionId}/${ALIGN_PLAN_ARTIFACT}`,
          ledger: `.sneakoscope/missions/${missionId}/${ALIGN_LEDGER_ARTIFACT}`,
          gate: `.sneakoscope/missions/${missionId}/${ALIGN_GATE_ARTIFACT}`,
          work_order_ledger: `.sneakoscope/missions/${missionId}/work-order-ledger.json`
        }
      : null,
    next_action: missionId ? alignNextActionText(missionId) : 'prepare_failed',
    additional_context: prepared?.additionalContext || null
  };
  if (!result.ok) process.exitCode = 1;
  if (flag(args, '--json')) {
    printJson(result);
    return result;
  }
  console.log(`SKS align ${action}: ${result.ok ? 'prepared' : 'blocked'}${missionId ? ` ${missionId}` : ''}`);
  if (missionId) {
    console.log(`Plan: ${result.artifacts?.plan}`);
    console.log(`Next: ${result.next_action}`);
  }
  return result;
}

async function alignStatus(args: any[]) {
  const root = await projectRoot();
  const missionId = await resolveAlignMissionId(root, args);
  if (!missionId) return missing(args);
  const dir = missionDir(root, missionId);
  const refreshed = await refreshAlignGate(dir, missionId);
  const result = {
    schema: 'sks.align-status.v2',
    schema_version: 2,
    ok: true,
    mission_id: missionId,
    gate: refreshed.gate,
    plan: refreshed.plan,
    ledger: refreshed.ledger
  };
  if (flag(args, '--json')) {
    printJson(result);
    return result;
  }
  console.log(`Align status: ${refreshed.gate.status} ${missionId}`);
  for (const blocker of refreshed.gate.blockers || []) console.log(`- ${blocker}`);
  return result;
}

async function alignProof(args: any[]) {
  const root = await projectRoot();
  const missionId = await resolveAlignMissionId(root, args);
  if (!missionId) return missing(args);
  const dir = missionDir(root, missionId);
  const refreshed = await refreshAlignGate(dir, missionId);
  const gate = refreshed.gate;
  const proof = await finalizeAlignRoute(root, missionId, gate);
  const completionVerified = alignCompletionVerified(gate, proof);
  const result = {
    schema: 'sks.align-proof.v2',
    schema_version: 2,
    ok: completionVerified,
    mission_id: missionId,
    gate,
    plan_path: path.join(dir, ALIGN_PLAN_ARTIFACT),
    ledger_path: path.join(dir, ALIGN_LEDGER_ARTIFACT),
    gate_path: path.join(dir, ALIGN_GATE_ARTIFACT),
    completion_proof_path: path.join(dir, 'completion-proof.json'),
    proof: proof.validation || proof
  };
  if (!result.ok) process.exitCode = 1;
  if (flag(args, '--json')) {
    printJson(result);
    return result;
  }
  console.log(`Align proof: ${result.ok ? 'pass' : 'blocked'} ${missionId}`);
  return result;
}

async function alignFixture(args: any[]) {
  const root = await projectRoot();
  const prepared: any = await prepareRoute(root, '$sks-align fixture modernization contract', {});
  const missionId = String(prepared?.mission_id || '').trim();
  if (!missionId) return missing(args);
  const dir = missionDir(root, missionId);
  const refreshed = await refreshAlignGate(dir, missionId);
  const proof = await finalizeAlignRoute(root, missionId, refreshed.gate, {
    command: 'sks align fixture --json'
  });
  const result = {
    schema: 'sks.align-fixture.v2',
    schema_version: 2,
    ok: false,
    status: 'blocked',
    execution_class: 'contract_fixture',
    mission_id: missionId,
    gate: refreshed.gate,
    proof: proof.validation || proof,
    artifacts: [
      ALIGN_PLAN_ARTIFACT,
      ALIGN_LEDGER_ARTIFACT,
      ALIGN_GATE_ARTIFACT,
      'work-order-ledger.json',
      'completion-proof.json'
    ],
    blockers: refreshed.gate.blockers
  };
  process.exitCode = 1;
  if (flag(args, '--json')) {
    printJson(result);
    return result;
  }
  console.log(`Align fixture: blocked ${missionId}`);
  return result;
}

async function finalizeAlignRoute(
  root: string,
  missionId: string,
  gate: any,
  opts: { command?: string } = {}
) {
  const proof: any = await maybeFinalizeRoute(root, {
    missionId,
    route: '$Align',
    gateFile: ALIGN_GATE_ARTIFACT,
    gate,
    artifacts: [
      ALIGN_PLAN_ARTIFACT,
      ALIGN_LEDGER_ARTIFACT,
      ALIGN_GATE_ARTIFACT,
      'work-order-ledger.json',
      'completion-proof.json'
    ],
    claims: [{
      id: 'align-modernization-workstreams',
      status: gate.passed === true ? 'supported' : 'blocked',
      evidence: ALIGN_LEDGER_ARTIFACT
    }, {
      id: 'align-official-source-receipts',
      status: gate.official_source_receipts_complete === true ? 'supported' : 'blocked',
      evidence: ALIGN_LEDGER_ARTIFACT
    }, {
      id: 'align-command-skill-surface-coverage',
      status: gate.command_coverage_complete === true && gate.skill_coverage_complete === true
        ? 'supported'
        : 'blocked',
      evidence: ALIGN_LEDGER_ARTIFACT
    }, {
      id: 'align-decisions-evaluation-and-verification',
      status: gate.programmatic_tool_calling_decision_recorded === true
        && gate.agents_sdk_decision_recorded === true
        && gate.prompt_evaluation_passed === true
        && gate.immutable_core_integrity_passed === true
        && gate.verification_receipts_passed === true
        ? 'supported'
        : 'blocked',
      evidence: ALIGN_LEDGER_ARTIFACT
    }, {
      id: 'align-mutation-cleanup-and-deduplication-receipts',
      status: gate.changed_paths_recorded === true
        && gate.latest_only_cleanup_review_complete === true
        && gate.deduplication_review_complete === true
        ? 'supported'
        : 'blocked',
      evidence: ALIGN_LEDGER_ARTIFACT
    }],
    blockers: gate.blockers || [],
    statusHint: gate.passed === true ? 'verified' : 'blocked',
    command: {
      cmd: opts.command || `sks align proof ${missionId}`,
      status: gate.passed === true ? 0 : 1
    },
    lightweightEvidence: gate.passed !== true
  });
  const completionVerified = alignCompletionVerified(gate, proof);
  await closeWorkOrderLedgerForRouteResult(missionDir(root, missionId), {
    ok: completionVerified,
    blockers: gate.blockers?.length
      ? gate.blockers
      : completionVerified
        ? []
        : [`align_completion_proof_${proof?.proof?.status || 'invalid'}`]
  });
  return proof;
}

function alignCompletionVerified(gate: any, proof: any): boolean {
  return gate?.passed === true
    && proof?.ok === true
    && proof?.proof?.status === 'verified'
    && proof?.trust?.report?.ok === true
    && proof?.trust?.report?.status === 'verified';
}

function positionalMission(args: any[]) {
  return args.find((item: any) => !String(item).startsWith('-')) || '';
}

async function resolveAlignMissionId(root: string, args: any[]): Promise<string | null> {
  const requested = positionalMission(args) || 'latest';
  let missionId: string | null;
  if (requested === 'latest') {
    await warnOnMultipleActiveSessions(root);
    missionId = await findLatestMission(root, { mode: 'align' });
  } else {
    const validated = validateExternallyReservedMissionId(requested);
    if (!validated.ok) return null;
    missionId = validated.id;
  }
  if (!missionId) return null;
  const dir = missionDir(root, missionId);
  const [mission, plan, routeContext] = await Promise.all([
    readJson(path.join(dir, 'mission.json'), null),
    readJson(path.join(dir, ALIGN_PLAN_ARTIFACT), null),
    readJson(path.join(dir, 'route-context.json'), null)
  ]);
  return mission?.mode === 'align'
    && plan?.schema === 'sks.align-plan.v2'
    && plan?.schema_version === 2
    && plan?.mission_id === missionId
    && routeContext?.route === 'Align'
    && routeContext?.command === '$Align'
    && routeContext?.mission_id === missionId
    ? missionId
    : null;
}

async function missing(args: any[]) {
  const result = {
    schema: 'sks.align-status.v2',
    schema_version: 2,
    ok: false,
    mission_id: null,
    error: 'align_mission_missing',
    hint: 'Run sks align prepare first'
  };
  process.exitCode = 1;
  if (flag(args, '--json')) {
    printJson(result);
    return result;
  }
  console.error('No align mission found. Run: sks align prepare');
  return result;
}

function printHelp() {
  console.log(`SKS Align — latest GPT-5.6 / OpenAI Plugins modernization route

Usage:
  sks align prepare ["scope"] [--json]
  sks align run ["scope"] [--json]
  sks align status [mission|latest] [--json]
  sks align proof [mission|latest] [--json]
  sks align fixture [--json]

Dollar route: $sks-align
Immutable skill: sks-align (mutable_by_doctor/update/setup=false)

prepare/run creates a skill-first mission with work-order-ledger.json,
align-plan.json, align-ledger.json, and align-gate.json, then returns the agent
briefing for the modernization job.
The v2 gate seals the current command/skill inventories and requires exact
exhaustive-audit receipts for both, plus official source receipts,
PTC and Agents SDK decisions, prompt evaluation, immutable-core integrity,
exactly one passing receipt for typecheck, build, focused tests, the skill-surface
audit, and the affected-release gate, an evidenced changed-or-none-required
review, latest-only cleanup inventory, an explicit deduplication review, mission
consistency, verified trust, and zero blockers.
Prompt evaluation is sealed at a minimum of 12 cases.
openai/skills is accepted only as deprecated migration evidence; openai/plugins
is the active repository. proof always writes completion-proof.json; fixture
writes an honestly blocked hermetic contract proof without claiming execution.
`);
}

export function usage() {
  return 'Usage: sks align prepare|run|status|proof|fixture [task|mission] [--json]';
}
