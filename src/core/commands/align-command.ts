import path from 'node:path';
import { printJson } from '../../cli/output.js';
import { executeCodeNavigationAlign } from '../align/code-navigation-align.js';
import {
  ALIGN_GATE_ARTIFACT,
  ALIGN_LEDGER_ARTIFACT,
  ALIGN_PLAN_ARTIFACT,
  alignNextActionText,
  refreshAlignGate
} from '../align/align-route.js';
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
import { flag, positionalArgs, promptOf, warnOnMultipleActiveSessions } from './command-utils.js';

const ACTIONS = new Set(['prepare', 'run', 'status', 'proof', 'fixture', 'help', '--help', '-h']);

export async function alignCommand(sub: any = 'prepare', args: any[] = []) {
  const action = String(sub || 'prepare').toLowerCase();
  if (action === 'help' || action === '--help' || action === '-h') return printHelp();
  if (action === 'prepare') return alignPrepare(args);
  if (action === 'run') return alignRun(args);
  if (action === 'status') return alignStatus(args);
  if (action === 'proof') return alignProof(args);
  if (action === 'fixture') return alignFixture(args);
  if (!ACTIONS.has(action) && !String(sub || '').startsWith('-')) return alignPrepare([String(sub), ...args]);
  console.error(usage());
  process.exitCode = 1;
}

async function prepareAlignMission(root: string, args: any[]) {
  const task = promptOf(args) || 'Rebuild TriWiki as a code-only repository navigation index';
  const prepared: any = await prepareRoute(root, `$sks-align ${task}`, {});
  return { prepared, missionId: String(prepared?.mission_id || '').trim(), task };
}

function commandResult(prepared: any, missionId: string, action: 'prepare' | 'run') {
  return {
    schema: 'sks.align-command.v3',
    schema_version: 3,
    ok: Boolean(missionId),
    action,
    mission_id: missionId || null,
    route: prepared?.route?.command ? sksPrefixedDollarCommand(prepared.route.command) : '$sks-align',
    stop_gate: prepared?.route?.stopGate || ALIGN_GATE_ARTIFACT,
    artifacts: missionId ? {
      plan: `.sneakoscope/missions/${missionId}/${ALIGN_PLAN_ARTIFACT}`,
      ledger: `.sneakoscope/missions/${missionId}/${ALIGN_LEDGER_ARTIFACT}`,
      gate: `.sneakoscope/missions/${missionId}/${ALIGN_GATE_ARTIFACT}`,
      work_order_ledger: `.sneakoscope/missions/${missionId}/work-order-ledger.json`
    } : null,
    next_action: missionId ? alignNextActionText(missionId) : 'prepare_failed',
    additional_context: prepared?.additionalContext || null
  };
}

async function alignPrepare(args: any[]) {
  const root = await projectRoot();
  const { prepared, missionId } = await prepareAlignMission(root, args);
  const result = commandResult(prepared, missionId, 'prepare');
  if (!result.ok) process.exitCode = 1;
  if (flag(args, '--json')) printJson(result);
  else {
    console.log(`SKS align prepare: ${result.ok ? 'ready' : 'blocked'}${missionId ? ` ${missionId}` : ''}`);
    if (missionId) console.log(`Next: ${result.next_action}`);
  }
  return result;
}

async function alignRun(args: any[]) {
  const root = await projectRoot();
  const requested = positionalArgs(args)[0] || '';
  let missionId = requested.startsWith('M-') ? await resolveAlignMissionId(root, [requested]) : null;
  let prepared: any = null;
  if (!missionId) {
    const created = await prepareAlignMission(root, args);
    prepared = created.prepared;
    missionId = created.missionId || null;
  }
  if (!missionId) return missing(args);
  const execution = await executeCodeNavigationAlign({ root, missionDir: missionDir(root, missionId), missionId });
  const result = {
    ...commandResult(prepared, missionId, 'run'),
    ok: execution.ok,
    status: execution.gate.status,
    gate: execution.gate,
    ledger: execution.ledger
  };
  if (!result.ok) process.exitCode = 1;
  if (flag(args, '--json')) printJson(result);
  else {
    console.log(`SKS align run: ${result.ok ? 'pass' : 'blocked'} ${missionId}`);
    if (result.ok) console.log(`Indexed ${execution.ledger.scan.source_file_count} source files into ${execution.ledger.graph.snapshot_hash}`);
    for (const blocker of execution.gate.blockers) console.log(`- ${blocker}`);
  }
  return result;
}

async function alignStatus(args: any[]) {
  const root = await projectRoot();
  const missionId = await resolveAlignMissionId(root, args);
  if (!missionId) return missing(args);
  const refreshed = await refreshAlignGate(missionDir(root, missionId), missionId, root);
  const result = { schema: 'sks.align-status.v3', schema_version: 3, ok: true, mission_id: missionId, ...refreshed };
  if (flag(args, '--json')) printJson(result);
  else {
    console.log(`Align status: ${refreshed.gate.status} ${missionId}`);
    for (const blocker of refreshed.gate.blockers) console.log(`- ${blocker}`);
  }
  return result;
}

async function alignProof(args: any[]) {
  const root = await projectRoot();
  const missionId = await resolveAlignMissionId(root, args);
  if (!missionId) return missing(args);
  const dir = missionDir(root, missionId);
  const refreshed = await refreshAlignGate(dir, missionId, root);
  const proof = await finalizeAlignRoute(root, missionId, refreshed.gate);
  const ok = alignCompletionVerified(refreshed.gate, proof);
  const result = {
    schema: 'sks.align-proof.v3',
    schema_version: 3,
    ok,
    mission_id: missionId,
    gate: refreshed.gate,
    plan_path: path.join(dir, ALIGN_PLAN_ARTIFACT),
    ledger_path: path.join(dir, ALIGN_LEDGER_ARTIFACT),
    gate_path: path.join(dir, ALIGN_GATE_ARTIFACT),
    completion_proof_path: path.join(dir, 'completion-proof.json'),
    proof: proof.validation || proof
  };
  if (!ok) process.exitCode = 1;
  if (flag(args, '--json')) printJson(result);
  else console.log(`Align proof: ${ok ? 'pass' : 'blocked'} ${missionId}`);
  return result;
}

async function alignFixture(args: any[]) {
  const root = await projectRoot();
  const { missionId } = await prepareAlignMission(root, ['fixture code-navigation contract']);
  if (!missionId) return missing(args);
  const refreshed = await refreshAlignGate(missionDir(root, missionId), missionId, root);
  const result = {
    schema: 'sks.align-fixture.v3',
    schema_version: 3,
    ok: false,
    status: 'blocked',
    execution_class: 'contract_fixture',
    mission_id: missionId,
    gate: refreshed.gate,
    blockers: refreshed.gate.blockers
  };
  process.exitCode = 1;
  if (flag(args, '--json')) printJson(result);
  else console.log(`Align fixture: blocked ${missionId}`);
  return result;
}

async function finalizeAlignRoute(root: string, missionId: string, gate: any) {
  const proof: any = await maybeFinalizeRoute(root, {
    missionId,
    route: '$Align',
    gateFile: ALIGN_GATE_ARTIFACT,
    gate,
    artifacts: [ALIGN_PLAN_ARTIFACT, ALIGN_LEDGER_ARTIFACT, ALIGN_GATE_ARTIFACT, 'work-order-ledger.json', 'completion-proof.json'],
    claims: [
      { id: 'align-absent-or-existing-input', status: gate.absent_or_existing_input_supported && gate.prior_state_ignored_as_input ? 'supported' : 'blocked', evidence: ALIGN_LEDGER_ARTIFACT },
      { id: 'align-exhaustive-code-navigation-index', status: gate.exact_source_file_coverage && gate.code_extractor_only ? 'supported' : 'blocked', evidence: ALIGN_LEDGER_ARTIFACT },
      { id: 'align-source-cas-and-transactional-publication', status: gate.source_cas_verified && gate.staged_transactional_publication && gate.active_artifacts_verified && gate.previous_generation_not_retained ? 'supported' : 'blocked', evidence: ALIGN_LEDGER_ARTIFACT }
    ],
    blockers: gate.blockers || [],
    statusHint: gate.passed === true ? 'verified' : 'blocked',
    command: { cmd: `sks align proof ${missionId}`, status: gate.passed === true ? 0 : 1 },
    lightweightEvidence: gate.passed !== true
  });
  const ok = alignCompletionVerified(gate, proof);
  await closeWorkOrderLedgerForRouteResult(missionDir(root, missionId), {
    ok,
    blockers: gate.blockers?.length ? gate.blockers : ok ? [] : [`align_completion_proof_${proof?.proof?.status || 'invalid'}`]
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

async function resolveAlignMissionId(root: string, args: any[]): Promise<string | null> {
  const requested = positionalArgs(args)[0] || 'latest';
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
    readJson<any>(path.join(dir, 'mission.json'), null),
    readJson<any>(path.join(dir, ALIGN_PLAN_ARTIFACT), null),
    readJson<any>(path.join(dir, 'route-context.json'), null)
  ]);
  return mission?.mode === 'align'
    && plan?.schema === 'sks.align-plan.v3'
    && plan?.schema_version === 3
    && plan?.mission_id === missionId
    && routeContext?.route === 'Align'
    && routeContext?.command === '$Align'
    && routeContext?.mission_id === missionId
    ? missionId
    : null;
}

async function missing(args: any[]) {
  const result = { schema: 'sks.align-status.v3', schema_version: 3, ok: false, mission_id: null, error: 'align_mission_missing', hint: 'Run sks align prepare first' };
  process.exitCode = 1;
  if (flag(args, '--json')) printJson(result);
  else console.error('No current Align v3 mission found. Run: sks align prepare');
  return result;
}

function printHelp() {
  console.log(`SKS Align — rebuild TriWiki as a repository code-navigation index

Usage:
  sks align prepare ["scope"] [--json]
  sks align run [mission|"scope"] [--json]
  sks align status [mission|latest] [--json]
  sks align proof [mission|latest] [--json]

Align accepts either no TriWiki or an existing/wrong TriWiki; Cleanup is not a
prerequisite. It rereads accepted repository source bytes with no incremental
cache or prior-memory input, records extractor-supported file/symbol locations
and directed code relations, validates the full generation in staging, then
transactionally replaces the active generation. The temporary prior-state handle
is deleted immediately after a successful swap, so no previous generation is
retained. The exhaustive authority is context-graph.json; context-pack.json is
only a bounded attention projection for fast LLM lookup.`);
}

export function usage() {
  return 'Usage: sks align prepare|run|status|proof|fixture [task|mission] [--json]';
}
