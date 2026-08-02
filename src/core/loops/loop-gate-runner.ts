import fsp from 'node:fs/promises';
import path from 'node:path';
import { readJson, runProcess, sha256, writeJsonAtomic } from '../fsx.js';
import { allGateIds, type SksLoopGatePlan, type SksLoopNode } from './loop-schema.js';
import { loopBudgetPath, loopGatePath, loopStatePath } from './loop-artifacts.js';
import { resolveLoopGate, type LoopGateDefinition } from './loop-gate-registry.js';
import { decideLoopFixturePolicy, writeLoopFixturePolicyDecision } from './loop-fixture-policy.js';
import { loopFinalArbiterGateContractRelativePath, writeLoopFinalArbiterGateContract } from './loop-final-arbiter-contract.js';

export interface SksLoopGateRunResult {
  ok: boolean;
  selected_gates: string[];
  passed_gates: string[];
  failed_gates: string[];
  skipped_gates: string[];
  blockers: string[];
}

export async function runLoopGates(input: {
  root: string;
  missionId: string;
  node: SksLoopNode;
  gates: SksLoopGatePlan;
  timeoutMs?: number;
  checkerArtifacts?: string[];
  cacheKey?: string;
}): Promise<SksLoopGateRunResult> {
  const selected = allGateIds(input.gates);
  const failed: string[] = [];
  const passed: string[] = [];
  const skipped: string[] = [];
  const blockers: string[] = [];
  for (const gate of selected) {
    const result = await runOneGate(input, gate);
    if (result.skipped) skipped.push(gate);
    else if (result.ok) passed.push(gate);
    else failed.push(gate);
    blockers.push(...result.blockers);
  }
  return {
    ok: failed.length === 0,
    selected_gates: selected,
    passed_gates: passed,
    failed_gates: failed,
    skipped_gates: skipped,
    blockers
  };
}

async function runOneGate(input: {
  root: string;
  missionId: string;
  node: SksLoopNode;
  timeoutMs?: number;
  checkerArtifacts?: string[];
  cacheKey?: string;
}, gateId: string): Promise<{ ok: boolean; skipped: boolean; blockers: string[]; handled_by?: 'loop-finalizer'; deferred_contract_path?: string; deferred_reason?: string }> {
  const started = Date.now();
  const definition = await resolveLoopGate(input.root, gateId);
  const fullReleaseCheckInsideLoop = gateId === 'release:check' && input.node.route !== '$Integration';
  const unknown = !definition;
  const packageJson = unknown ? await readJson<any>(path.join(input.root, 'package.json'), null) : null;
  const fixtureMode = process.env.SKS_LOOP_GATE_FIXTURE === '1';
  const cacheKey = definition
    ? await loopGateCacheKey(input.root, input.node, definition, fixtureMode, input.cacheKey)
    : null;
  const fixtureDecision = decideLoopFixturePolicy({
    root: input.root,
    missionId: input.missionId,
    mode: 'gate',
    requested: fixtureMode || (unknown && !packageJson)
  });
  if (fixtureDecision.requested) await writeLoopFixturePolicyDecision(input.root, input.missionId, fixtureDecision).catch(() => undefined);
  const skipUnknownFixtureGate = unknown && !packageJson && fixtureDecision.allowed;
  const blockers: string[] = [
    ...(unknown && !skipUnknownFixtureGate ? [`unknown_loop_gate:${gateId}`] : []),
    ...(fullReleaseCheckInsideLoop ? ['full_release_check_inside_non_integration_loop'] : []),
    ...(fixtureMode && !fixtureDecision.allowed ? [...fixtureDecision.blockers, 'loop_gate_fixture_forbidden_in_production'] : [])
  ];
  let ok = blockers.length === 0;
  let skipped = skipUnknownFixtureGate;
  let exitCode: number | null = null;
  let stdoutTail = '';
  let stderrTail = '';
  let timedOut = false;
  let handledBy: 'loop-finalizer' | undefined;
  let deferredContractPath: string | undefined;
  let deferredReason: string | undefined;

  if (definition?.cache_allowed === true && definition.source !== 'builtin-pseudo' && cacheKey) {
    const artifactPath = loopGatePath(input.root, input.missionId, input.node.loop_id, gateId);
    const cached = await readJson<any>(artifactPath, null);
    if (cached?.schema === 'sks.loop-gate-result.v1'
      && cached.cache_key === cacheKey
      && cached.ok === true
      && cached.timed_out !== true
      && cached.fixture_mode === fixtureMode
      && Array.isArray(cached.blockers)
      && cached.blockers.length === 0) {
      await writeJsonAtomic(artifactPath, {
        ...cached,
        cache_hit: true,
        cache_hits: Math.max(0, Number(cached.cache_hits || 0)) + 1,
        duration_ms: Math.max(1, Date.now() - started),
        generated_at: new Date().toISOString()
      });
      return { ok: true, skipped: cached.skipped === true, blockers: [] };
    }
  }

  if (definition && ok) {
    if (fixtureMode && !fixtureDecision.allowed) {
      ok = false;
    } else if (fixtureMode && definition.source !== 'builtin-pseudo') {
      ok = true;
    } else if (definition.source === 'builtin-pseudo') {
      const builtin = await runBuiltinGate(input.root, input.missionId, input.node.loop_id, definition, input.checkerArtifacts || []);
      ok = builtin.ok;
      skipped = builtin.skipped;
      blockers.push(...builtin.blockers);
      handledBy = builtin.handled_by;
      deferredContractPath = builtin.deferred_contract_path;
      deferredReason = builtin.deferred_reason;
    } else {
      const command = definition.command;
      const result = await runProcess(process.env.SHELL || '/bin/sh', ['-lc', command], {
        cwd: input.root,
        timeoutMs: input.timeoutMs || definition.timeout_ms,
        maxOutputBytes: 512 * 1024,
        env: {
          SKS_LOOP_ID: input.node.loop_id,
          SKS_MISSION_ID: input.missionId,
          SKS_LOOP_GATE: gateId
        }
      });
      exitCode = result.code;
      stdoutTail = result.stdout.slice(-8000);
      stderrTail = result.stderr.slice(-8000);
      timedOut = result.timedOut;
      ok = result.code === 0;
      if (!ok) blockers.push(`gate_command_failed:${gateId}:${result.code}`);
    }
  }

  const artifact = {
    schema: 'sks.loop-gate-result.v1',
    ok,
    gate_id: gateId,
    loop_id: input.node.loop_id,
    command: definition?.command || null,
    source: definition?.source || null,
    exit_code: exitCode,
    duration_ms: Math.max(1, Date.now() - started),
    stdout_tail: stdoutTail,
    stderr_tail: stderrTail,
    cached_allowed: definition?.cache_allowed ?? false,
    cache_key: cacheKey,
    cache_hit: false,
    cache_hits: 0,
    fixture_mode: fixtureMode,
    fixture_policy: fixtureDecision,
    fixture_allowed_reason: fixtureDecision.allowed ? fixtureDecision.reason : null,
    skipped,
    handled_by: handledBy,
    deferred_contract_path: deferredContractPath,
    deferred_reason: deferredReason,
    deferred_unknown_fixture_gate: skipUnknownFixtureGate,
    timed_out: timedOut,
    full_release_check_inside_loop: fullReleaseCheckInsideLoop,
    generated_at: new Date().toISOString(),
    blockers
  };
  await writeJsonAtomic(loopGatePath(input.root, input.missionId, input.node.loop_id, gateId), artifact);
  return {
    ok,
    skipped,
    blockers,
    ...(handledBy ? { handled_by: handledBy } : {}),
    ...(deferredContractPath ? { deferred_contract_path: deferredContractPath } : {}),
    ...(deferredReason ? { deferred_reason: deferredReason } : {})
  };
}

async function loopGateCacheKey(
  root: string,
  node: SksLoopNode,
  definition: LoopGateDefinition,
  fixtureMode: boolean,
  callerKey?: string
) {
  // A command definition alone is not a safe cache identity: the same test
  // command can observe different code after a maker iteration. Central loop
  // runtime supplies a revision+diff fingerprint; callers without an input
  // fingerprint execute the gate normally instead of reusing stale success.
  if (!callerKey) return null;
  let sourceContract: unknown = definition.command;
  if (definition.source === 'package-json') {
    const pkg = await readJson<any>(path.join(root, 'package.json'), {});
    sourceContract = pkg?.scripts?.[definition.id] ?? null;
  } else if (definition.source === 'release-gates-v2') {
    const release = await readJson<any>(path.join(root, 'release-gates.v2.json'), {});
    sourceContract = Array.isArray(release?.gates)
      ? release.gates.find((gate: any) => gate?.id === definition.id) || null
      : null;
  }
  return `sha256:${sha256(stableJson({
    gate_id: definition.id,
    command: definition.command,
    source: definition.source,
    source_contract: sourceContract,
    side_effect: definition.side_effect,
    fixture_mode: fixtureMode,
    route: node.route,
    caller_key: callerKey || null
  }))}`;
}

function stableJson(value: unknown): string {
  if (value === undefined) return '"__undefined__"';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${stableJson(row[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? '"__unserializable__"' : encoded;
}

async function runBuiltinGate(root: string, missionId: string, loopId: string, definition: LoopGateDefinition, checkerArtifacts: string[]): Promise<{ ok: boolean; skipped: boolean; blockers: string[]; handled_by?: 'loop-finalizer'; deferred_contract_path?: string; deferred_reason?: string }> {
  if (definition.id === 'gpt:final-arbiter') {
    await writeLoopFinalArbiterGateContract(root, missionId);
    return {
      ok: true,
      skipped: true,
      blockers: [],
      handled_by: 'loop-finalizer',
      deferred_contract_path: loopFinalArbiterGateContractRelativePath(missionId),
      deferred_reason: 'gpt_final_arbiter_runs_after_integration_merge'
    };
  }
  if (definition.id === 'human:handoff-required') return { ok: false, skipped: false, blockers: ['human_handoff_required'] };
  if (definition.id === 'loop:state-valid') {
    const state = await readJson<any>(loopStatePath(root, missionId, loopId), null);
    return state?.schema === 'sks.loop-state.v1' ? { ok: true, skipped: false, blockers: [] } : { ok: false, skipped: false, blockers: ['loop_state_invalid'] };
  }
  if (definition.id === 'loop:budget-valid') {
    const budget = await readJson<any>(loopBudgetPath(root, missionId, loopId), null);
    return budget && typeof budget === 'object' ? { ok: true, skipped: false, blockers: [] } : { ok: false, skipped: false, blockers: ['loop_budget_invalid'] };
  }
  if (definition.id === 'loop:checker-fresh-session') {
    const artifacts = await Promise.all(checkerArtifacts.map((artifact) => readCheckerArtifact(root, missionId, artifact)));
    const fresh = artifacts.some((artifact) => artifact?.fresh_session === true && artifact?.approved === true);
    return fresh ? { ok: true, skipped: false, blockers: [] } : { ok: false, skipped: false, blockers: ['loop_checker_fresh_session_missing'] };
  }
  return { ok: false, skipped: false, blockers: [`unknown_builtin_gate:${definition.id}`] };
}

async function readCheckerArtifact(root: string, missionId: string, artifact: string): Promise<any | null> {
  for (const candidate of checkerArtifactPathCandidates(root, missionId, artifact)) {
    const readable = await checkerArtifactReadablePath(root, missionId, candidate);
    if (!readable) continue;
    const row = await readJson<any>(readable, null);
    if (row) return row;
  }
  return null;
}

function checkerArtifactPathCandidates(root: string, missionId: string, artifact: string): string[] {
  const raw = String(artifact || '').trim();
  if (!raw) return [];
  const missionRoot = path.join(root, '.sneakoscope', 'missions', missionId);
  const resolvedMissionRoot = path.resolve(missionRoot);
  if (path.isAbsolute(raw)) {
    return [path.resolve(raw)];
  }
  return uniqueStrings([
    safeResolveWithin(path.join(resolvedMissionRoot, 'agents'), raw),
    safeResolveWithin(resolvedMissionRoot, raw),
    safeResolveWithin(path.join(resolvedMissionRoot, 'loops'), raw)
  ].filter((value): value is string => Boolean(value)));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

async function checkerArtifactReadablePath(root: string, missionId: string, candidate: string): Promise<string | null> {
  const resolvedMissionRoot = path.resolve(root, '.sneakoscope', 'missions', missionId);
  const resolvedCandidate = path.resolve(candidate);
  try {
    const [realMissionRoot, realCandidate] = await Promise.all([
      fsp.realpath(resolvedMissionRoot),
      fsp.realpath(resolvedCandidate)
    ]);
    return isWithinPath(realMissionRoot, realCandidate) ? realCandidate : null;
  } catch {
    return null;
  }
}

function safeResolveWithin(base: string, target: string): string | null {
  const resolvedBase = path.resolve(base);
  const resolvedTarget = path.resolve(resolvedBase, target);
  return isWithinPath(resolvedBase, resolvedTarget) ? resolvedTarget : null;
}

function isWithinPath(base: string, target: string): boolean {
  const resolvedBase = path.resolve(base);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedBase || resolvedTarget.startsWith(`${resolvedBase}${path.sep}`);
}
