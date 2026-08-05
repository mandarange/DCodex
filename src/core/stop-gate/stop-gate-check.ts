import path from 'node:path';
import { ensureDir, exists, nowIso, readJson, writeJsonAtomic } from '../fsx.js';
import { missionDir } from '../mission.js';
import { resolveStopGate, gateStatInfo } from './stop-gate-resolver.js';
import type { SksStopGateV1, StopGateCheckResult, StopGateDiagnostics, StopGateAction } from './stop-gate-types.js';
import { isRecord } from '../json/records.js';
import { terminalBlockedNarutoGate } from '../subagents/terminal-subagent-state.js';

const HARD_BLOCKER_FILE = 'hard-blocker.json';

function normalizeRoute(route: string | null): string | null {
  if (!route) return null;
  const upper = route.toUpperCase().replace(/^\$/, '');
  if (upper === 'GLM_NARUTO' || upper === 'NARUTO') return 'Naruto';
  return route;
}

function rawGateToV1(raw: Record<string, unknown> | null, gatePath: string, route: string | null): SksStopGateV1 | null {
  if (!raw) return null;
  // Canonical input still needs runtime normalization. Older or hand-written
  // gate files can omit optional arrays; malformed types must fail closed
  // rather than throwing or being treated as empty.
  if (raw.schema === 'sks.stop-gate.v1') {
    return {
      ...(raw as any),
      schema: 'sks.stop-gate.v1',
      route: String(raw.route || route || 'Naruto'),
      route_command: String(raw.route_command || '$Naruto'),
      mission_id: String(raw.mission_id || ''),
      gate_file: String(raw.gate_file || path.basename(gatePath)),
      gate_abs_path: String(raw.gate_abs_path || gatePath),
      status: String(raw.status || 'blocked') as SksStopGateV1['status'],
      passed: raw.passed === true,
      reason: typeof raw.reason === 'string' ? raw.reason : null,
      terminal: raw.terminal === true,
      terminal_state: String(raw.terminal_state || 'blocked') as SksStopGateV1['terminal_state'],
      evidence: isRecord(raw.evidence) ? raw.evidence as SksStopGateV1['evidence'] : {},
      blockers: normalizedStringArray(raw.blockers, 'blockers_invalid'),
      missing_fields: normalizedStringArray(raw.missing_fields, 'missing_fields_invalid'),
      created_at: String(raw.created_at || raw.updated_at || nowIso()),
    };
  }
  // Normalize from legacy naruto-gate.json / glm-naruto termination
  const passed = raw.passed === true;
  const status = passed ? 'passed' : (raw.status as string || 'blocked');
  const terminalState = (raw.terminal_state as string) || (passed ? 'completed' : 'blocked');
  const evidence = isRecord(raw.evidence) ? raw.evidence : {};
  return {
    ...(raw as any),
    schema: 'sks.stop-gate.v1',
    route: route || String(raw.route || 'Naruto'),
    route_command: String(raw.route_command || '$Naruto'),
    mission_id: String(raw.mission_id || ''),
    gate_file: path.basename(gatePath),
    gate_abs_path: gatePath,
    status: status as SksStopGateV1['status'],
    passed,
    reason: typeof raw.reason === 'string' ? raw.reason : null,
    terminal: raw.terminal === true || passed,
    terminal_state: terminalState as SksStopGateV1['terminal_state'],
    evidence: evidence as SksStopGateV1['evidence'],
    blockers: normalizedStringArray(raw.blockers, 'blockers_invalid'),
    missing_fields: normalizedStringArray(raw.missing_fields, 'missing_fields_invalid'),
    created_at: String(raw.created_at || raw.updated_at || nowIso()),
  };
}

function normalizedStringArray(value: unknown, invalidMarker: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return [invalidMarker];
  const strings = value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean);
  if (strings.length !== value.length) strings.push(invalidMarker);
  return [...new Set(strings)];
}

async function checkHardBlocker(root: string, missionId: string | null): Promise<{ hardBlocked: boolean; file: string | null; reason: string | null; evidence: unknown[] }> {
  if (!missionId) return { hardBlocked: false, file: null, reason: null, evidence: [] };
  const file = path.join(missionDir(root, missionId), HARD_BLOCKER_FILE);
  if (!(await exists(file))) return { hardBlocked: false, file: null, reason: null, evidence: [] };
  const blocker = await readJson(file, null) as Record<string, unknown> | null;
  if (!blocker) return { hardBlocked: false, file, reason: null, evidence: [] };
  const evidence = (blocker.evidence as unknown[]) || [];
  const hardBlocked = String(blocker.status || '') === 'hard_blocked'
    && blocker.passed !== true
    && String(blocker.reason || '').trim().length > 0
    && Array.isArray(evidence)
    && evidence.length > 0;
  return { hardBlocked, file, reason: String(blocker.reason || ''), evidence };
}

export async function checkStopGate(input: {
  readonly root: string;
  readonly route?: string;
  readonly missionId?: string;
  readonly explicitGatePath?: string;
  readonly allowLatestFallback?: boolean;
}): Promise<StopGateCheckResult> {
  const root = path.resolve(input.root);
  const resolution = await resolveStopGate({
    root,
    ...(input.route ? { route: input.route } : {}),
    ...(input.missionId ? { missionId: input.missionId } : {}),
    ...(input.explicitGatePath ? { explicitGatePath: input.explicitGatePath } : {}),
    ...(input.allowLatestFallback === false ? { allowLatestFallback: false } : {}),
  });

  const route = normalizeRoute(resolution.route) ?? normalizeRoute(input.route ?? null) ?? 'Naruto';
  const missionId = resolution.mission_id;

  const statInfo = resolution.gate_path ? await gateStatInfo(resolution.gate_path) : { mtime: null, sha256: null };

  // Check hard blocker first
  const hardBlocker = await checkHardBlocker(root, missionId);
  if (hardBlocker.hardBlocked) {
    const action: StopGateAction = 'hard_blocked';
    const diagnostics: StopGateDiagnostics = {
      schema: 'sks.stop-gate-diagnostics.v1',
      resolved_root: root,
      route,
      mission_id: missionId,
      checked_paths: resolution.checked_paths,
      selected_gate_path: hardBlocker.file,
      selected_gate_schema: 'sks.hard-blocker.v1',
      selected_gate_sha256: null,
      selected_gate_mtime: null,
      current_state_path: resolution.current_state_path,
      current_state_mission_id: resolution.current_state_mission_id,
      reason: `hard_blocker: ${hardBlocker.reason}`,
      missing_fields: [],
      blockers: [],
    };
    await writeDiagnostics(root, missionId, diagnostics);
    return {
      schema: 'sks.stop-gate-check.v1',
      ok: false,
      action,
      route,
      mission_id: missionId,
      gate_path: hardBlocker.file,
      diagnostics,
      feedback: `Stop hard-blocked: ${hardBlocker.reason}`,
    };
  }

  const normalizedGate = rawGateToV1(resolution.gate_raw, resolution.gate_path || '', route);

  if (!normalizedGate || !resolution.gate_path) {
    const diagnostics: StopGateDiagnostics = {
      schema: 'sks.stop-gate-diagnostics.v1',
      resolved_root: root,
      route,
      mission_id: missionId,
      checked_paths: resolution.checked_paths,
      selected_gate_path: null,
      selected_gate_schema: null,
      selected_gate_sha256: null,
      selected_gate_mtime: null,
      current_state_path: resolution.current_state_path,
      current_state_mission_id: resolution.current_state_mission_id,
      reason: 'no_gate_file_found',
      missing_fields: [],
      blockers: [],
    };
    await writeDiagnostics(root, missionId, diagnostics);
    return {
      schema: 'sks.stop-gate-check.v1',
      ok: false,
      action: 'continue',
      route,
      mission_id: missionId,
      gate_path: null,
      diagnostics,
      feedback: `Stop blocked: no gate file found. Checked paths: ${resolution.checked_paths.join(', ')}`,
    };
  }

  const notApplicable = normalizedGate.status === 'not_applicable';
  const terminalBlocked = route === 'Naruto' && terminalBlockedNarutoGate(normalizedGate);
  const missingFields: string[] = [];
  if (!notApplicable && !terminalBlocked && normalizedGate.status !== 'passed') missingFields.push('status');
  if (!notApplicable && !terminalBlocked && normalizedGate.passed !== true) missingFields.push('passed');
  if (notApplicable && !String(normalizedGate.reason || '').trim()) missingFields.push('not_applicable_reason');
  if (!terminalBlocked && normalizedGate.blockers.length > 0) missingFields.push('blockers');
  if (!terminalBlocked && normalizedGate.missing_fields.length > 0) missingFields.push(...normalizedGate.missing_fields.map((field) => `missing_fields:${field}`));
  if (normalizedGate.evidence.required_coverage_passed === false) missingFields.push('coverage_required_but_not_passed');
  if ((normalizedGate.evidence.uncovered_required_count ?? 0) > 0) missingFields.push(`work_order_uncovered_count:${normalizedGate.evidence.uncovered_required_count}`);

  if (
    (normalizedGate.status === 'passed' && normalizedGate.passed === true || notApplicable || terminalBlocked)
    && (terminalBlocked || normalizedGate.blockers.length === 0)
    && (terminalBlocked || normalizedGate.missing_fields.length === 0)
    && missingFields.length === 0
  ) {
    const action: StopGateAction = 'allow_stop';
    const diagnostics: StopGateDiagnostics = {
      schema: 'sks.stop-gate-diagnostics.v1',
      resolved_root: root,
      route,
      mission_id: missionId,
      checked_paths: resolution.checked_paths,
      selected_gate_path: resolution.gate_path,
      selected_gate_schema: resolution.gate_schema,
      selected_gate_sha256: statInfo.sha256,
      selected_gate_mtime: statInfo.mtime,
      current_state_path: resolution.current_state_path,
      current_state_mission_id: resolution.current_state_mission_id,
      reason: notApplicable ? 'gate_not_applicable' : terminalBlocked ? 'gate_terminal_blocked' : 'gate_passed',
      missing_fields: [],
      blockers: terminalBlocked ? normalizedGate.blockers : [],
    };
    await writeDiagnostics(root, missionId, diagnostics);
    return {
      schema: 'sks.stop-gate-check.v1',
      ok: true,
      action,
      route,
      mission_id: missionId,
      gate_path: resolution.gate_path,
      normalized_gate: normalizedGate,
      diagnostics,
      feedback: notApplicable
        ? `Stop allowed: active gate is not applicable at ${resolution.gate_path}`
        : terminalBlocked
          ? `Stop allowed: official subagent workflow reached a trustworthy terminal blocked state at ${resolution.gate_path}`
        : `Stop allowed: gate passed at ${resolution.gate_path}`,
    };
  }

  // Gate not passed
  const action: StopGateAction = 'continue';
  const diagnostics: StopGateDiagnostics = {
    schema: 'sks.stop-gate-diagnostics.v1',
    resolved_root: root,
    route,
    mission_id: missionId,
    checked_paths: resolution.checked_paths,
    selected_gate_path: resolution.gate_path,
    selected_gate_schema: resolution.gate_schema,
    selected_gate_sha256: statInfo.sha256,
    selected_gate_mtime: statInfo.mtime,
    current_state_path: resolution.current_state_path,
    current_state_mission_id: resolution.current_state_mission_id,
    reason: `gate_not_passed:${normalizedGate.status}`,
    missing_fields: missingFields,
    blockers: normalizedGate.blockers,
  };
  await writeDiagnostics(root, missionId, diagnostics);
  return {
    schema: 'sks.stop-gate-check.v1',
    ok: false,
    action,
    route,
    mission_id: missionId,
    gate_path: resolution.gate_path,
    normalized_gate: normalizedGate,
    diagnostics,
    feedback: `Stop blocked: gate not passed. Selected: ${resolution.gate_path}. Missing fields: ${missingFields.join(', ') || 'none'}. Checked: ${resolution.checked_paths.join(', ')}`,
  };
}

async function writeDiagnostics(root: string, missionId: string | null, diagnostics: StopGateDiagnostics): Promise<void> {
  // Global report
  const reportsDir = path.join(root, '.sneakoscope', 'reports');
  await ensureDir(reportsDir);
  await writeJsonAtomic(path.join(reportsDir, 'stop-gate-last-check.json'), diagnostics);
  // Mission-local
  if (missionId) {
    const dir = missionDir(root, missionId);
    await ensureDir(dir);
    await writeJsonAtomic(path.join(dir, 'stop-gate-last-check.json'), diagnostics);
  }
}
