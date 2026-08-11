import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exists, projectRoot, runProcess, writeJsonAtomic, type RunProcessResult } from '../fsx.js';
import { createMission, missionDir, setCurrent } from '../mission.js';
import { createAndWriteWorkOrderLedgerForPrompt, closeWorkOrderLedgerForRouteResult } from '../work-order-ledger.js';
import { maybeFinalizeRoute } from '../proof/auto-finalize.js';
import { routePrompt } from '../routes.js';
import { latestTrustReport } from '../trust-kernel/trust-report.js';
import { normalizeTrustStatus, TRUST_REPORT_SCHEMA, trustKernelMetadata } from '../trust-kernel/trust-kernel-schema.js';
import { flag, positionalArgs } from './command-utils.js';
import { prepareRoute } from '../pipeline-internals/runtime-core.js';

export type RunMode = 'prepare' | 'mock' | 'execute' | 'auto';
export type RouteExecutionStatus = 'completed' | 'blocked' | 'verified_partial' | 'prepared';
export type RouteExecutionKind = 'safe_deterministic' | 'mock_safe' | 'live_route' | 'blocked';

export interface RunClassification {
  schema: 'sks.run-classification.v1';
  mission_id: string;
  prompt: string;
  route: string;
  reason: string;
  mock: boolean;
  execute: boolean;
  auto: boolean;
  next_action: string;
}

export interface RunRouteStep {
  label: string;
  command: string;
  exit_code: number | null;
  stdout_tail: string;
  stderr_tail: string;
}

export interface RunRouteExecution {
  schema: 'sks.run-route-execution.v1';
  ok: boolean;
  status: RouteExecutionStatus;
  execution_kind: RouteExecutionKind;
  execution_class?: 'real' | 'mock_fixture';
  completion_evidence?: boolean;
  route: string;
  command: string | null;
  exit_code: number | null;
  nested_mission_id: string | null;
  stdout_tail?: string;
  stderr_tail?: string;
  steps?: RunRouteStep[];
  trust_status?: string;
  prompt_delivered?: boolean;
  blockers: string[];
  unverified: string[];
  next_action: string;
}

export interface RunAutoVerification {
  schema: 'sks.run-auto-verification.v1';
  ok: boolean;
  trust_validate: CommandTail;
  status: CommandTail;
}

export interface CommandTail {
  command: string;
  exit_code: number | null;
  stdout_tail: string;
  stderr_tail: string;
}

export interface RunResult {
  schema: 'sks.run.v2';
  ok: boolean;
  mission_id: string;
  route: string;
  mode: RunMode;
  route_execution?: RouteExecutionStatus;
  status: string;
  trust_status?: string;
  classification: RunClassification;
  execution?: RunRouteExecution;
  auto_verification?: RunAutoVerification | null;
  completion_proof?: string | { ok: boolean; validation?: unknown };
  trust_report?: string | TrustReportLike;
  next_action?: string;
}

interface RouteSelection {
  id: string;
  command: string;
  description?: string;
}

interface ExecuteRunContext {
  id: string;
  dir: string;
  route: RouteSelection;
  prompt: string;
  args: readonly string[];
  classification: RunClassification;
  auto: boolean;
}

interface PreparedRouteOptions {
  prepare: readonly string[];
  run: (missionId: string) => readonly string[];
  trustStatus: string;
  executionKind: RouteExecutionKind;
  mockOnly?: boolean;
}

interface RouteExecutionOptions {
  nestedMissionId?: string | null;
  steps?: RunRouteStep[];
  okStatus?: RouteExecutionStatus;
  trustStatus?: string;
  unverified?: string[];
  executionKind?: RouteExecutionKind;
  promptDelivered?: boolean;
  mockOnly?: boolean;
}

interface FinalizeResult {
  ok: boolean;
  proof?: {
    status?: string;
  };
  validation?: unknown;
}

interface TrustReportLike {
  status: string;
  ok?: boolean;
  issues?: string[];
  [key: string]: unknown;
}

export async function runCommand(args: readonly string[] = []): Promise<RunResult | void> {
  const root = await projectRoot();
  const prompt = positionalArgs(args).join(' ').trim();
  if (!prompt) {
    console.error('Usage: sks run "task" [--visual|--research|--db] [--mock] [--json]');
    process.exitCode = 2;
    return;
  }
  const route = classifyRunRoute(prompt, args);
  const { id, dir } = await createMission(root, { mode: 'run', prompt });
  await setCurrent(root, {
    mission_id: id,
    mode: 'RUN',
    route: route.id,
    route_command: route.command,
    phase: flag(args, '--mock') ? 'RUN_MOCK_FINALIZE' : 'RUN_ROUTE_SELECTED',
    implementation_allowed: true,
  });
  const execute = flag(args, '--execute') || flag(args, '--auto');
  const auto = flag(args, '--auto');
  const mode = runMode(args);
  const classification: RunClassification = {
    schema: 'sks.run-classification.v1',
    mission_id: id,
    prompt,
    route: route.command,
    reason: route.description || 'route classifier selected this SKS route',
    mock: flag(args, '--mock'),
    execute,
    auto,
    next_action: runNextAction(route, id, args),
  };
  await writeJsonAtomic(path.join(dir, 'run-classification.json'), classification);
  if (!flag(args, '--mock') && !execute) {
    const result: RunResult = {
      schema: 'sks.run.v2',
      ok: true,
      mission_id: id,
      route: route.command,
      mode,
      classification,
      status: 'prepared',
    };
    if (flag(args, '--json')) {
      console.log(JSON.stringify(result, null, 2));
      return result;
    }
    console.log(`SKS run prepared ${route.command} mission ${id}`);
    console.log(`Next: ${classification.next_action}`);
    return result;
  }
  await createAndWriteWorkOrderLedgerForPrompt(dir, { missionId: id, route: route.command, prompt });
  if (execute) return executeRunRoute(root, { id, dir, route, prompt, args, classification, auto });
  return finalizeMockRun(root, { id, route, prompt, args, classification, mode });
}

async function finalizeMockRun(
  root: string,
  {
    id,
    route,
    prompt,
    args,
    classification,
    mode,
  }: Pick<ExecuteRunContext, 'id' | 'route' | 'prompt' | 'args' | 'classification'> & { mode: RunMode }
): Promise<RunResult> {
  const gate = {
    schema: 'sks.run-gate.v1',
    ok: false,
    passed: false,
    route: route.command,
    mock: true,
    execution_class: 'mock_fixture',
    blockers: ['run_mock_fixture_cannot_claim_real_completion']
  };
  await writeJsonAtomic(path.join(missionDir(root, id), 'run-gate.json'), gate);
  const proof = await finalizeRoute(root, {
    missionId: id,
    route: route.command,
    gateFile: 'run-gate.json',
    gate,
    artifacts: ['run-classification.json', 'run-gate.json', 'completion-proof.json'],
    mock: true,
    visual: flag(args, '--visual'),
    statusHint: 'verified_partial',
    command: { cmd: `sks run "${prompt}" --mock`, status: 0 },
  });
  const trust = await loadTrustReport(root, id);
  const completionOk = proof.ok && proof.proof?.status !== 'mock_only' && gate.passed === true;
  await closeWorkOrderLedgerForRouteResult(missionDir(root, id), { ok: completionOk, blockers: gate.blockers });
  await setCurrent(root, {
    mission_id: id,
    mode: 'RUN',
    route: route.id,
    route_command: route.command,
    phase: completionOk ? 'RUN_MOCK_FINALIZED' : 'RUN_MOCK_BLOCKED',
    implementation_allowed: true,
    completion_proof: 'completion-proof.json',
    trust_report: 'trust-report.json',
  });
  const result: RunResult = {
    schema: 'sks.run.v2',
    ok: completionOk,
    mission_id: id,
    route: route.command,
    mode,
    status: proof.proof?.status || 'not_verified',
    trust_status: trust.status,
    classification,
    completion_proof: { ok: proof.ok, validation: proof.validation },
    trust_report: trust,
  };
  if (!result.ok) process.exitCode = 1;
  if (flag(args, '--json')) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  console.log(`SKS run: ${result.status} (${route.command})`);
  console.log(`Mission: ${id}`);
  console.log(`Trust: ${trust.status}`);
  return result;
}

async function executeRunRoute(root: string, context: ExecuteRunContext): Promise<RunResult> {
  const { id, dir, route, prompt, args, classification, auto } = context;
  const execution = await executeRouteCommand(root, route, prompt, { auto, parentMissionId: id });
  await writeJsonAtomic(path.join(dir, 'run-route-execution.json'), execution);
  const mockOnly = execution.execution_class === 'mock_fixture';
  const completionBlockers = [
    ...execution.blockers,
    ...(mockOnly ? ['run_execute_mock_only_not_real_completion'] : [])
  ];
  const gate = {
    schema: 'sks.run-gate.v1',
    ok: execution.ok,
    passed: execution.ok && !mockOnly,
    route: route.command,
    execute: true,
    auto,
    execution_class: mockOnly ? 'mock_fixture' : 'real',
    route_execution: execution.status,
    execution_kind: execution.execution_kind,
    executed_command: execution.command,
    nested_mission_id: execution.nested_mission_id,
    blockers: completionBlockers,
  };
  await writeJsonAtomic(path.join(dir, 'run-gate.json'), gate);
  const statusHint = mockOnly ? 'mock_only' : execution.ok ? execution.trust_status || 'verified_partial' : 'blocked';
  const proof = await finalizeRoute(root, {
    missionId: id,
    route: route.command,
    gateFile: 'run-gate.json',
    gate,
    artifacts: ['run-classification.json', 'run-route-execution.json', 'run-gate.json', 'completion-proof.json'],
    statusHint,
    blockers: gate.passed ? [] : completionBlockers,
    unverified: execution.unverified,
    mock: mockOnly,
    command: { cmd: execution.command || `sks run "${prompt}" --execute`, status: execution.exit_code ?? (execution.ok ? 0 : 2) },
    lightweightEvidence: execution.execution_kind === 'safe_deterministic',
  });
  const trust = execution.execution_kind === 'safe_deterministic'
    ? await writeLightweightTrustReport(root, id, route.command, statusHint, proof.ok)
    : await loadTrustReport(root, id);
  const autoVerification = auto ? await runAutoVerification(root, id) : null;
  const autoOk = autoVerification?.ok ?? true;
  const executeOk = execution.ok && !mockOnly && proof.ok && autoOk;
  await closeWorkOrderLedgerForRouteResult(dir, { ok: executeOk, blockers: completionBlockers });
  await setCurrent(root, {
    mission_id: id,
    mode: 'RUN',
    route: route.id,
    route_command: route.command,
    phase: executeOk ? 'RUN_EXECUTE_DONE' : 'RUN_EXECUTE_BLOCKED',
    implementation_allowed: executeOk,
    nested_mission_id: execution.nested_mission_id,
    completion_proof: 'completion-proof.json',
    trust_report: 'trust-report.json',
  });
  const result: RunResult = {
    schema: 'sks.run.v2',
    ok: executeOk,
    mission_id: id,
    route: route.command,
    mode: auto ? 'auto' : 'execute',
    route_execution: execution.status,
    status: proof.proof?.status || statusHint,
    trust_status: trust.status,
    classification,
    execution,
    auto_verification: autoVerification,
    completion_proof: `.sneakoscope/missions/${id}/completion-proof.json`,
    trust_report: `.sneakoscope/missions/${id}/trust-report.json`,
    next_action: executeOk ? 'inspect status or continue with route-specific follow-up' : execution.next_action,
  };
  if (!result.ok) process.exitCode = 1;
  if (flag(args, '--json')) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  console.log(`SKS run execute: ${result.route_execution} (${route.command})`);
  console.log(`Mission: ${id}`);
  console.log(`Trust: ${trust.status}`);
  if (!result.ok) console.log(`Next: ${result.next_action}`);
  return result;
}

async function executeRouteCommand(
  root: string,
  route: RouteSelection,
  prompt: string,
  { auto = false, parentMissionId = null }: { auto?: boolean; parentMissionId?: string | null } = {}
): Promise<RunRouteExecution> {
  if (route.command === '$Image-UX-Review') {
    return {
      schema: 'sks.run-route-execution.v1',
      ok: false,
      status: 'blocked',
      execution_kind: 'blocked',
      route: route.command,
      command: null,
      exit_code: 2,
      nested_mission_id: null,
      blockers: ['visual_source_or_official_capture_evidence_missing'],
      unverified: ['Visual routes require real source images plus official capture evidence when live capture is required: Codex Chrome Extension for web/browser/webapp, native Computer Use for Mac/non-web surfaces. sks run --execute will not fabricate it.'],
      next_action: 'provide the source screenshot/image evidence or complete the required official capture setup, then run the selected visual route directly',
    };
  }
  if (route.command === '$DB' && destructiveDbPrompt(prompt)) {
    return {
      schema: 'sks.run-route-execution.v1',
      ok: false,
      status: 'blocked',
      execution_kind: 'blocked',
      route: route.command,
      command: null,
      exit_code: 2,
      nested_mission_id: null,
      blockers: ['destructive_db_auto_execute_blocked'],
      unverified: ['DB destructive or broad mutation prompts cannot auto-execute.'],
      next_action: 'use the $DB Codex App route for read-only safety analysis; use sks mad-sks plan or apply-migration only after an explicit scoped permission mission',
    };
  }
  if (route.command === '$Research') {
    return executePreparedRoute(root, route, prompt, {
      prepare: ['research', 'prepare', prompt, '--json'],
      run: (missionId: string) => ['research', 'run', missionId, '--mock', '--json'],
      trustStatus: 'verified_partial',
      executionKind: 'mock_safe',
      mockOnly: true,
    }, parentMissionId);
  }
  if (route.command === '$QA-LOOP') {
    return executePreparedRoute(root, route, prompt, {
      prepare: ['qa-loop', 'prepare', prompt, '--json'],
      run: (missionId: string) => ['qa-loop', 'run', missionId, '--mock', '--json'],
      trustStatus: 'verified_partial',
      executionKind: 'mock_safe',
      mockOnly: true,
    }, parentMissionId);
  }
  if (route.command === '$DB') return executeInternalDbRoute(root, route, prompt);
  const commandArgs = safeRouteExecutionArgs(route, prompt, { auto });
  if (!commandArgs) {
    return {
      schema: 'sks.run-route-execution.v1',
      ok: false,
      status: 'blocked',
      execution_kind: 'blocked',
      route: route.command,
      command: '',
      exit_code: null,
      nested_mission_id: null,
      blockers: [`route_not_executable:${route.command}`],
      unverified: [],
      next_action: `${route.command} has no dedicated run --execute branch; run it directly via its own sks command instead.`,
    };
  }
  const isMockFallback = commandArgs.includes('--mock');
  const promptDelivered = Boolean(prompt) && commandArgs.includes(prompt);
  const deterministicRoute = isSafeDeterministicRoute(route.command);
  const result = await runSks(root, commandArgs);
  return routeExecutionResult(route, ['sks', ...commandArgs].join(' '), result, {
    okStatus: isMockFallback ? 'verified_partial' : 'completed',
    trustStatus: isMockFallback ? 'mock_only' : 'verified_partial',
    executionKind: isMockFallback ? 'mock_safe' : deterministicRoute ? 'safe_deterministic' : 'live_route',
    promptDelivered,
  });
}

async function executeInternalDbRoute(root: string, route: RouteSelection, prompt: string): Promise<RunRouteExecution> {
  try {
    const prepared = await prepareRoute(root, `$DB ${prompt}`, {});
    const missionId = String(prepared?.mission_id || '').trim();
    const dir = missionId ? missionDir(root, missionId) : null;
    const scanReady = Boolean(dir && await exists(path.join(dir, 'db-safety-scan.json')));
    const reviewReady = Boolean(dir && await exists(path.join(dir, 'db-review.json')));
    if (!missionId || !scanReady || !reviewReady) {
      return {
        schema: 'sks.run-route-execution.v1',
        ok: false,
        status: 'blocked',
        execution_kind: 'blocked',
        route: route.command,
        command: 'internal:$DB prepare',
        exit_code: 2,
        nested_mission_id: missionId || null,
        blockers: ['db_route_materialization_incomplete'],
        unverified: [],
        next_action: 'inspect the internal $DB preparation artifacts and retry after fixing the materialization error',
      };
    }
    return {
      schema: 'sks.run-route-execution.v1',
      ok: true,
      status: 'prepared',
      execution_kind: 'safe_deterministic',
      route: route.command,
      command: 'internal:$DB prepare',
      exit_code: 0,
      nested_mission_id: missionId,
      prompt_delivered: true,
      trust_status: 'verified_partial',
      blockers: [],
      unverified: ['The internal $DB route materialized read-only safety evidence; db-review.json remains the authoritative review gate and no database mutation was attempted.'],
      next_action: `inspect .sneakoscope/missions/${missionId}/db-safety-scan.json and complete db-review.json`,
    };
  } catch (error: any) {
    return {
      schema: 'sks.run-route-execution.v1',
      ok: false,
      status: 'blocked',
      execution_kind: 'blocked',
      route: route.command,
      command: 'internal:$DB prepare',
      exit_code: 2,
      nested_mission_id: null,
      blockers: [`db_route_materialization_failed:${error?.message || String(error)}`],
      unverified: [],
      next_action: 'inspect the internal $DB preparation failure and resolve it within the current route surface',
    };
  }
}

function isSafeDeterministicRoute(command: string): boolean {
  return new Set(['$DB', '$Wiki', '$Fast-Mode', '$Commit', '$Commit-And-Push']).has(command);
}

async function runAutoVerification(root: string, missionId: string): Promise<RunAutoVerification> {
  const trust = await runSks(root, ['trust', 'validate', missionId, '--json']);
  const status = await runSks(root, ['status', '--json']);
  return {
    schema: 'sks.run-auto-verification.v1',
    ok: trust.code === 0 && status.code === 0,
    trust_validate: commandTail(`sks trust validate ${missionId} --json`, trust),
    status: commandTail('sks status --json', status),
  };
}

async function executePreparedRoute(
  root: string,
  route: RouteSelection,
  prompt: string,
  { prepare, run, trustStatus, executionKind, mockOnly = false }: PreparedRouteOptions,
  parentMissionId: string | null
): Promise<RunRouteExecution> {
  const prepareResult = await runSks(root, prepare, { parentMissionId });
  const prepareCommand = ['sks', ...prepare].join(' ');
  const missionId = parseMissionId(prepareResult.stdout);
  const steps: RunRouteStep[] = [commandStep('prepare', prepareCommand, prepareResult)];
  if (prepareResult.code !== 0 || !missionId) {
    return {
      schema: 'sks.run-route-execution.v1',
      ok: false,
      status: 'blocked',
      execution_kind: 'blocked',
      route: route.command,
      command: prepareCommand,
      exit_code: prepareResult.code,
      stdout_tail: prepareResult.stdout.slice(-1200),
      stderr_tail: prepareResult.stderr.slice(-1200),
      nested_mission_id: missionId,
      steps,
      blockers: [missionId ? 'route_prepare_failed' : 'route_prepare_mission_id_missing'],
      unverified: [],
      next_action: 'inspect run-route-execution.json prepare stdout_tail/stderr_tail',
    };
  }
  const runArgs = run(missionId);
  const runResult = await runSks(root, runArgs);
  const runCommand = ['sks', ...runArgs].join(' ');
  steps.push(commandStep('run', runCommand, runResult));
  return routeExecutionResult(route, `${prepareCommand} && ${runCommand}`, runResult, {
    nestedMissionId: missionId,
    steps,
    okStatus: mockOnly ? 'verified_partial' : 'completed',
    trustStatus: mockOnly ? 'mock_only' : trustStatus,
    executionKind,
    mockOnly,
    unverified: [
      'sks run --execute prepared and ran the selected route through its CLI; mock-safe fixtures do not claim live external source or UI coverage.',
    ],
  });
}

async function runSks(
  root: string,
  commandArgs: readonly string[],
  { parentMissionId = null }: { parentMissionId?: string | null } = {}
): Promise<RunProcessResult> {
  const { packedBin, sourceBin } = runSksEntrypointCandidates();
  const entrypoint = (await exists(packedBin)) ? packedBin : sourceBin;
  return runProcess(process.execPath, [entrypoint, ...commandArgs], {
    cwd: root,
    timeoutMs: 180_000,
    maxOutputBytes: 512 * 1024,
    env: {
      SKS_SKIP_NPM_FRESHNESS_CHECK: '1',
      CI: 'true',
      ...(parentMissionId ? { SKS_RUN_PARENT_MISSION_ID: parentMissionId } : {})
    },
  });
}

export function runSksEntrypointCandidates(moduleUrl: string | URL = import.meta.url): {
  packedBin: string;
  sourceBin: string;
} {
  return {
    packedBin: fileURLToPath(new URL('../../bin/sks.js', moduleUrl)),
    sourceBin: fileURLToPath(new URL('../../../bin/sks.js', moduleUrl)),
  };
}

function routeExecutionResult(
  route: RouteSelection,
  command: string,
  result: RunProcessResult,
  options: RouteExecutionOptions = {}
): RunRouteExecution {
  const nestedMissionId = parseMissionId(result.stdout);
  const ok = result.code === 0;
  const mockOnly = options.mockOnly === true || options.executionKind === 'mock_safe';
  const execution: RunRouteExecution = {
    schema: 'sks.run-route-execution.v1',
    ok,
    status: ok ? (options.okStatus || 'completed') : 'blocked',
    execution_kind: ok ? (options.executionKind || 'live_route') : 'blocked',
    execution_class: mockOnly ? 'mock_fixture' : 'real',
    completion_evidence: ok && !mockOnly,
    route: route.command,
    command,
    exit_code: result.code,
    stdout_tail: result.stdout.slice(-1200),
    stderr_tail: result.stderr.slice(-1200),
    nested_mission_id: options.nestedMissionId || nestedMissionId,
    trust_status: ok ? options.trustStatus || 'verified_partial' : 'blocked',
    blockers: ok ? [] : ['route_command_failed'],
    unverified: ok
      ? options.unverified || ['sks run --execute ran the selected route command; route-specific gates remain authoritative for final trust.']
      : [],
    next_action: ok
      ? mockOnly
        ? 'mock-only route execution completed; run the route directly without --mock for real completion evidence'
        : 'review completion proof and trust report'
      : 'inspect run-route-execution.json stderr_tail',
  };
  if (options.steps) execution.steps = options.steps;
  if (options.promptDelivered !== undefined) execution.prompt_delivered = options.promptDelivered;
  return execution;
}

function classifyRunRoute(prompt: string, args: readonly string[]): RouteSelection {
  if (flag(args, '--visual')) return requireRoute(routePrompt('$Image-UX-Review'));
  if (flag(args, '--research')) return requireRoute(routePrompt('$Research'));
  if (flag(args, '--db')) return requireRoute(routePrompt('$DB'));
  const route = requireRoute(routePrompt(prompt));
  return route.command === '$SKS' ? requireRoute(routePrompt('$Naruto')) : route;
}

function runNextAction(route: RouteSelection, id: string, args: readonly string[]): string {
  if (flag(args, '--mock')) return 'mock run finalizes immediately for release fixture evidence';
  if (flag(args, '--execute') || flag(args, '--auto')) return 'execute selected safe route command and write completion proof/trust report';
  if (route.command === '$Research') return `sks research run ${id} --json`;
  if (route.command === '$QA-LOOP') return `sks qa-loop run ${id} --json`;
  return `continue ${route.command} mission ${id} through the selected SKS route`;
}

function safeRouteExecutionArgs(route: RouteSelection, prompt: string, { auto = false }: { auto?: boolean } = {}): string[] | null {
  if (route.command === '$Super-Search') return superSearchExecutionArgs(prompt);
  if (route.command === '$SEO-GEO-OPTIMIZER') return ['seo-geo-optimizer', searchVisibilityActionFromPrompt(prompt), '--mode', searchVisibilityModeFromPrompt(prompt), '--target', searchVisibilityTargetFromPrompt(prompt), '--offline', '--json'];
  if (route.command === '$Wiki') return ['wiki', 'refresh', '--json'];
  if (route.command === '$Fast-Mode') return ['fast-mode', fastModeActionFromPrompt(prompt), '--json'];
  if (route.command === '$Commit') return ['commit', '--json'];
  if (route.command === '$Commit-And-Push') return ['commit-and-push', '--json'];
  return null;
}

function superSearchExecutionArgs(prompt = ''): string[] {
  const stripped = stripSuperSearchPrompt(prompt);
  const lower = stripped.toLowerCase();
  if (!stripped || /^(?:doctor|check|status)\b/.test(lower)) return ['super-search', 'doctor', '--json'];
  if (/^(?:x|x-search|x_search)\b/.test(lower)) {
    const query = stripped.replace(/^(?:x|x-search|x_search)\b[:\s-]*/i, '').trim() || 'source intelligence fixture';
    return ['super-search', 'x', query, '--json'];
  }
  const url = stripped.match(/\bhttps?:\/\/\S+/)?.[0];
  if (/^(?:fetch|url)\b/.test(lower) || url) {
    const fetchTarget = url || stripped.replace(/^(?:fetch|url)\b[:\s-]*/i, '').trim();
    return fetchTarget ? ['super-search', 'fetch', fetchTarget, '--json'] : ['super-search', 'fetch', '--json'];
  }
  const query = stripped.replace(/^run\b[:\s-]*/i, '').trim() || 'source intelligence fixture';
  return ['super-search', 'run', query, '--mode', 'balanced', '--json'];
}

function stripSuperSearchPrompt(prompt = ''): string {
  return String(prompt || '')
    .trim()
    .replace(/^(?:\[\$Super-Search\]\([^)]+\)(?:\s|:)?\s*)+/i, '')
    .replace(/^(?:\$Super-Search(?:\s|:)?\s*)+/i, '')
    .trim();
}

function searchVisibilityActionFromPrompt(prompt = ''): string {
  const text = String(prompt || '').toLowerCase();
  if (/\bdoctor\b|진단/.test(text)) return 'doctor';
  if (/\bverify\b|검증/.test(text)) return 'fixture';
  if (/\bplan\b|계획/.test(text)) return 'audit';
  if (/\bapply\b|--apply\b|적용/.test(text)) return 'audit';
  return 'audit';
}

function searchVisibilityTargetFromPrompt(prompt = ''): string {
  const text = String(prompt || '').toLowerCase();
  if (/\bpackage\b|npm|readme|github/.test(text)) return 'package';
  if (/\bdocs?\b|documentation/.test(text)) return 'docs';
  if (/\bwebsite\b|site\b|페이지|사이트/.test(text)) return 'website';
  return 'auto';
}

function searchVisibilityModeFromPrompt(prompt = ''): 'seo' | 'geo' {
  const text = String(prompt || '');
  if (/generative\s+engine\s+optimization|AI\s+(?:answer|search)\s+(?:visibility|discoverability)|LLM\s+(?:citation|answer|visibility|discoverability)|answerability|entity\s+(?:facts?|clarity)|claim\s+evidence|crawler\s+policy|OAI-SearchBot|GPTBot|ChatGPT-User|Claude-SearchBot|ClaudeBot|Claude-User|llms\.txt|AI\s*검색\s*가시성|AI\s*답변\s*가시성|생성형\s*엔진\s*최적화/i.test(text)) return 'geo';
  return 'seo';
}

function fastModeActionFromPrompt(prompt = ''): string {
  const text = String(prompt || '');
  const lower = text.toLowerCase();
  if (/\$fast-off\b/.test(lower)) return 'off';
  if (/\$fast-on\b/.test(lower)) return 'on';
  const routeMatch = /\$fast-mode\b/i.exec(text);
  if (!routeMatch) return 'status';
  const afterRoute = text
    .slice(routeMatch.index + routeMatch[0].length)
    .replace(/^[\s:=\-]+/, '')
    .trimStart()
    .toLowerCase();
  const token = afterRoute.match(/^[^\s?!.,;:()"'`]+/)?.[0] || '';
  if (['off', 'disable', 'disabled', 'standard', 'default', 'slow', '끄기', '꺼', '꺼줘'].includes(token) || token.startsWith('끄') || token.startsWith('꺼')) return 'off';
  if (['on', 'enable', 'enabled', 'fast', 'priority', '켜기', '켜', '켜줘'].includes(token) || token.startsWith('켜')) return 'on';
  if (['clear', 'reset', '초기화', '기본'].includes(token) || token.startsWith('초기화')) return 'clear';
  return 'status';
}

function destructiveDbPrompt(prompt = ''): boolean {
  return /\b(drop|truncate|delete\s+from|update\s+\w+\s+set|reset|db\s+push|disable\s+rls)\b/i.test(prompt);
}

function parseMissionId(text = ''): string | null {
  try {
    const parsed = JSON.parse(text) as { mission_id?: unknown; proof?: { proof?: { mission_id?: unknown } } };
    const nested = parsed.proof?.proof?.mission_id;
    const value = parsed.mission_id || nested;
    return typeof value === 'string' ? value : null;
  } catch {
    return text.match(/\bM-\d{8}-\d{6}-[a-f0-9]{4}\b/)?.[0] || null;
  }
}

function requireRoute(value: unknown): RouteSelection {
  if (!value || typeof value !== 'object') throw new Error('SKS route classifier returned no route');
  const route = value as { id?: unknown; command?: unknown; description?: unknown };
  if (typeof route.id !== 'string' || typeof route.command !== 'string') {
    throw new Error('SKS route classifier returned an invalid route');
  }
  const selection: RouteSelection = {
    id: route.id,
    command: route.command,
  };
  if (typeof route.description === 'string') selection.description = route.description;
  return selection;
}

function runMode(args: readonly string[]): RunMode {
  if (flag(args, '--auto')) return 'auto';
  if (flag(args, '--execute')) return 'execute';
  if (flag(args, '--mock')) return 'mock';
  return 'prepare';
}

function commandStep(label: string, command: string, result: RunProcessResult): RunRouteStep {
  return {
    label,
    command,
    exit_code: result.code,
    stdout_tail: result.stdout.slice(-1200),
    stderr_tail: result.stderr.slice(-1200),
  };
}

function commandTail(command: string, result: RunProcessResult): CommandTail {
  return {
    command,
    exit_code: result.code,
    stdout_tail: result.stdout.slice(-1200),
    stderr_tail: result.stderr.slice(-1200),
  };
}

async function finalizeRoute(root: string, options: Record<string, unknown>): Promise<FinalizeResult> {
  return maybeFinalizeRoute(root, options) as Promise<FinalizeResult>;
}

async function loadTrustReport(root: string, missionId: string): Promise<TrustReportLike> {
  const report = await latestTrustReport(root, missionId);
  if (report && typeof report === 'object' && 'status' in report) return report as TrustReportLike;
  return { status: 'not_verified', ok: false, issues: ['trust_report_invalid'] };
}

async function writeLightweightTrustReport(
  root: string,
  missionId: string,
  route: string,
  statusHint: unknown,
  proofOk: boolean
): Promise<TrustReportLike> {
  const status = normalizeTrustStatus(statusHint);
  const issues = proofOk ? [] : ['completion_proof_not_ok'];
  const report: TrustReportLike = {
    schema: TRUST_REPORT_SCHEMA,
    ...trustKernelMetadata(),
    ok: proofOk && !['blocked', 'failed', 'not_verified', 'mock_only'].includes(status),
    mission_id: missionId,
    route,
    status,
    proof_status: status,
    evidence_status: 'verified_partial',
    route_contract_status: 'verified_partial',
    issues,
    route_state_machine: {
      state: 'trust_report',
      lightweight: true,
      reason: 'safe_deterministic_run_wrapper'
    },
    trust_basis: 'lightweight',
    evidence: {
      completion_proof: `.sneakoscope/missions/${missionId}/completion-proof.json`,
      route_contract: null,
      evidence_index: null,
      evidence_records: 0,
      lightweight: true
    }
  };
  await writeJsonAtomic(path.join(missionDir(root, missionId), 'trust-report.json'), report);
  return report;
}
