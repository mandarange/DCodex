import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { MANAGED_ASSET_VERSION } from '../managed-assets/managed-assets-manifest.js';
import { PACKAGE_VERSION, packageRoot, sha256 } from '../fsx.js';
import { hashJson } from '../triwiki/triwiki-cache-key.js';
import { SKS_MENUBAR_LABEL, sksMenuBarPaths } from '../codex-app/menubar/index.js';

export const DOCTOR_DIRTY_PLAN_SCHEMA = 'sks.doctor-dirty-plan.v2';

export interface DoctorDirtyPlan {
  schema: typeof DOCTOR_DIRTY_PLAN_SCHEMA;
  root: string;
  phases: DoctorDirtyPhase[];
  dirty_count: number;
  clean_count: number;
  runtime_probe_failed: string[];
  semantic_dirty_plan_path: string;
}

export interface DoctorDirtyPhase {
  id: string;
  status: 'dirty' | 'clean' | 'unknown';
  reason: string;
  input_hash: string;
  last_clean_proof_id: string | null;
  postcheck_required: boolean;
  postcheck_pending: boolean;
  runtime_probe_failed: string[];
}

/**
 * Phases whose trigger is state that no input hash can observe, and which decide
 * for themselves whether there is anything to do.
 *
 * A provider catalog turns stale with the passage of time — an `expires_at`
 * moment, not an edit — so nothing this planner hashes ever changes when it
 * lapses. The clean marker recorded while it was fresh therefore made
 * `doctor --fix` skip the repair the user was running it for and print a green
 * check over an expired catalog, run after run. The phase's own first step is a
 * cheap bridge status read that returns immediately when nothing is stale, so
 * re-evaluating it every time costs almost nothing and mutates nothing.
 */
export const SELF_GUARDING_DOCTOR_PHASES: ReadonlySet<string> = new Set(['desktop_bridge_catalog_repair']);

export function planDoctorDirtyRepair(root: string, phaseIds: string[]): DoctorDirtyPlan {
  const phases = phaseIds.map((id) => {
    const marker = markerPath(root, id);
    const inputHash = phaseInputHash(root, id);
    const postcheckRequired = phaseRequiresPostcheck(id);
    const markerState = readMarker(marker);
    const runtimeProbeFailed = runtimeProbeFailures(root, id);
    if (SELF_GUARDING_DOCTOR_PHASES.has(id)) {
      return { id, status: 'dirty' as const, reason: 'self_guarding_phase', input_hash: inputHash, last_clean_proof_id: markerState?.proof_id || null, postcheck_required: postcheckRequired, postcheck_pending: false, runtime_probe_failed: runtimeProbeFailed };
    }
    if (!markerState) return { id, status: 'dirty' as const, reason: 'no_clean_marker', input_hash: inputHash, last_clean_proof_id: null, postcheck_required: postcheckRequired, postcheck_pending: false, runtime_probe_failed: runtimeProbeFailed };
    if (markerState.input_hash !== inputHash) {
      return { id, status: 'dirty' as const, reason: 'input_hash_changed', input_hash: inputHash, last_clean_proof_id: markerState.proof_id, postcheck_required: postcheckRequired, postcheck_pending: false, runtime_probe_failed: runtimeProbeFailed };
    }
    if (markerState.proof_id && !proofExists(root, markerState.proof_id)) {
      return { id, status: 'dirty' as const, reason: 'clean_proof_missing', input_hash: inputHash, last_clean_proof_id: markerState.proof_id, postcheck_required: postcheckRequired, postcheck_pending: false, runtime_probe_failed: runtimeProbeFailed };
    }
    if (!markerState.repair_applied) {
      return { id, status: 'dirty' as const, reason: 'repair_not_applied', input_hash: inputHash, last_clean_proof_id: markerState.proof_id, postcheck_required: postcheckRequired, postcheck_pending: false, runtime_probe_failed: runtimeProbeFailed };
    }
    if (runtimeProbeFailed.length) {
      return { id, status: 'dirty' as const, reason: `runtime_probe_failed:${runtimeProbeFailed.join(',')}`, input_hash: inputHash, last_clean_proof_id: markerState.proof_id, postcheck_required: postcheckRequired, postcheck_pending: false, runtime_probe_failed: runtimeProbeFailed };
    }
    return {
      id,
      status: markerState.postcheck_pending ? 'dirty' as const : 'clean' as const,
      reason: postcheckRequired && markerState.postcheck_pending ? 'matching_repair_marker_postcheck_pending' : 'matching_clean_proof',
      input_hash: inputHash,
      last_clean_proof_id: markerState.proof_id,
      postcheck_required: postcheckRequired,
      postcheck_pending: postcheckRequired && markerState.postcheck_pending,
      runtime_probe_failed: []
    };
  });
  const plan: DoctorDirtyPlan = {
    schema: DOCTOR_DIRTY_PLAN_SCHEMA,
    root,
    phases,
    dirty_count: phases.filter((phase) => phase.status === 'dirty').length,
    clean_count: phases.filter((phase) => phase.status === 'clean').length,
    runtime_probe_failed: phases.flatMap((phase) => phase.runtime_probe_failed.map((failure) => `${phase.id}:${failure}`)),
    semantic_dirty_plan_path: dirtyPlanPath(root)
  };
  writeDirtyPlan(root, plan);
  return plan;
}

export function markDoctorPhaseClean(root: string, id: string, proofId = `doctor-${id}-${Date.now()}`, postcheckPassed = true): string {
  const file = markerPath(root, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    schema: 'sks.doctor-phase-receipt.v2',
    phase_id: id,
    proof_id: proofId,
    sks_version: PACKAGE_VERSION,
    managed_asset_version: MANAGED_ASSET_VERSION,
    cleaned_at: new Date().toISOString(),
    input_hash: phaseInputHash(root, id),
    target_semantic_hash: phaseInputHash(root, id),
    postcheck_id: `${id}:postcheck`,
    repair_applied: true,
    postcheck_passed: postcheckPassed,
    postcheck_pending: postcheckPassed !== true
  }, null, 2)}\n`);
  return proofId;
}

export function isDoctorPhaseClean(plan: DoctorDirtyPlan | null | undefined, id: string): boolean {
  return plan?.phases.find((phase) => phase.id === id)?.status === 'clean';
}

function markerPath(root: string, id: string): string {
  return path.join(root, '.sneakoscope', 'cache', 'doctor-dirty', `${id.replace(/[^a-zA-Z0-9._-]+/g, '_')}.clean`);
}

function readMarker(file: string): { proof_id: string | null; input_hash: string | null; repair_applied: boolean; postcheck_passed: boolean; postcheck_pending: boolean } | null {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim().startsWith('{')) return { proof_id: null, input_hash: null, repair_applied: false, postcheck_passed: false, postcheck_pending: false };
    const json = JSON.parse(raw) as { proof_id?: string; input_hash?: string; repair_applied?: boolean; postcheck_passed?: boolean; postcheck_pending?: boolean };
    const proofId = json.proof_id || null;
    const postcheckPassed = json.postcheck_passed === true;
    return {
      proof_id: proofId,
      input_hash: json.input_hash || null,
      repair_applied: json.repair_applied !== false && Boolean(proofId),
      postcheck_passed: postcheckPassed,
      postcheck_pending: json.postcheck_pending === true || !postcheckPassed
    };
  } catch {
    return null;
  }
}

function phaseInputHash(root: string, id: string): string {
  const files = phaseInputFiles(id).map((rel) => {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) return { rel, hash: 'missing' };
    return hashSemanticPath(root, rel);
  });
  // Every phase hashes both Codex configs, not just the ones whose id happens to
  // match a `phaseInputFiles` branch. Phases that fell through to the default
  // bucket — codex_config_syntax_repair, command_alias_cleanup, hook_trust_repair,
  // setup, desktop_bridge_catalog_repair — kept their `clean` marker across any
  // config edit, so `doctor --fix` skipped the repair that was needed. The home
  // config was never hashed by any phase; it is absolute, so it cannot go through
  // `phaseInputFiles` (which joins against root) and gets its own term.
  return hashJson({
    id,
    package: packageIdentity(),
    files,
    env: phaseEnvPresence(id),
    semantic_state: phaseSemanticState(root, id),
    project_codex_config: hashSemanticPath(root, '.codex/config.toml').hash,
    codex_home_config: hashFileIfExists(codexHomeConfigPath()),
    phase_schema_version: 3
  });
}

function codexHomeConfigPath(): string {
  const codexHome = process.env.CODEX_HOME
    || path.join(process.env.HOME || os.homedir(), '.codex');
  return path.join(codexHome, 'config.toml');
}

function phaseInputFiles(id: string): string[] {
  if (id.includes('context7')) return ['src/core/doctor/context7-mcp-repair.ts', '.codex/config.toml'];
  if (id.includes('startup')) return ['src/core/doctor/codex-startup-config-repair.ts', '.codex/config.toml'];
  if (id.includes('supabase')) return ['src/core/doctor/supabase-mcp-repair.ts', '.codex/config.toml'];
  if (id.includes('menubar')) return ['src/core/codex-app/menubar/index.ts', 'src/commands/doctor.ts', 'package.json'];
  if (id.includes('skill')) return ['.agents/skills', 'src/scripts/skill-registry-ledger-check.ts'];
  if (id.includes('native')) return ['src/core/codex-native', 'src/scripts/native-capability-postcheck-check.ts'];
  if (id.includes('secret')) return ['safety-mutation-allowlist.json', 'src/scripts/secret-preservation-check.ts'];
  return ['package.json', 'package-lock.json', 'src/core/codex-compat/codex-runtime-contract.ts'];
}

function packageIdentity(): Record<string, string | null> {
  const root = packageRoot();
  return {
    sks_version: PACKAGE_VERSION,
    package_realpath: realpathOrNull(root),
    package_json_sha256: hashFileIfExists(path.join(root, 'package.json')),
    build_manifest_sha256: hashFileIfExists(path.join(root, 'dist', 'build-manifest.json')),
    managed_asset_version: MANAGED_ASSET_VERSION
  };
}

function realpathOrNull(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

function hashFileIfExists(file: string): string | null {
  try {
    return sha256(fs.readFileSync(file));
  } catch {
    return null;
  }
}

function phaseEnvPresence(id: string): Record<string, boolean> {
  const keys = id.includes('supabase') ? ['SUPABASE_ACCESS_TOKEN'] : id.includes('context7') ? ['CONTEXT7_API_KEY'] : [];
  return Object.fromEntries(keys.map((key) => [key, process.env[key] !== undefined]));
}

function phaseSemanticState(root: string, id: string): Record<string, unknown> {
  const config = readTextIfSmall(path.join(root, '.codex', 'config.toml'));
  return {
    context7_transport: id.includes('context7') ? parseMcpTransport(config, 'context7') : undefined,
    startup_config_targets: id.includes('startup') ? parseConfigTargets(config) : undefined,
    supabase_env_present: id.includes('supabase') ? process.env.SUPABASE_ACCESS_TOKEN !== undefined : undefined,
    skill_registry_hash: id.includes('skill') ? hashSemanticPath(root, '.agents/skills').hash : undefined,
    native_capability_hash: id.includes('native') ? hashSemanticPath(root, 'src/core/codex-native').hash : undefined,
    secret_fingerprint_hash: id.includes('secret') ? hashJson({ has_allowlist: fs.existsSync(path.join(root, 'safety-mutation-allowlist.json')) }) : undefined
  };
}

function hashSemanticPath(root: string, rel: string): { rel: string; hash: string } {
  const absolute = path.join(root, rel);
  if (!fs.existsSync(absolute)) return { rel, hash: 'missing' };
  const stat = fs.lstatSync(absolute);
  if (stat.isDirectory()) {
    const records = walkFiles(absolute).map((file) => {
      const fileStat = fs.lstatSync(file);
      const relative = path.relative(root, file).replace(/\\/g, '/');
      return fileStat.isSymbolicLink()
        ? { path: relative, mode: 'symlink', target: fs.readlinkSync(file) }
        : { path: relative, mode: 'file', hash: hashFile(file), size: fileStat.size };
    });
    return { rel, hash: hashJson(records) };
  }
  if (stat.isSymbolicLink()) return { rel, hash: hashJson({ mode: 'symlink', target: fs.readlinkSync(absolute) }) };
  return { rel, hash: hashFile(absolute) };
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(absolute);
      else if (entry.isFile() || entry.isSymbolicLink()) out.push(absolute);
    }
  }
  return out.sort();
}

function hashFile(file: string): string {
  return hashJson({ text: fs.readFileSync(file, 'utf8') });
}

function readTextIfSmall(file: string): string {
  try {
    const stat = fs.statSync(file);
    if (stat.size > 512_000) return '';
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function parseMcpTransport(text: string, name: string): string | null {
  const block = text.match(new RegExp(`\\[mcp_servers\\.${name}\\]([\\s\\S]*?)(?:\\n\\[|$)`));
  if (!block?.[1]) return null;
  const transport = block[1].match(/transport\s*=\s*["']?([^"'\n]+)["']?/);
  const command = block[1].match(/command\s*=\s*["']?([^"'\n]+)["']?/);
  return transport?.[1]?.trim() || (command ? 'stdio' : 'unknown');
}

function parseConfigTargets(text: string): string[] {
  return [...text.matchAll(/config_file\s*=\s*["']([^"']+)["']/g)].map((match) => match[1] || '').filter(Boolean).sort();
}

function proofExists(root: string, proofId: string): boolean {
  const transaction = path.join(root, '.sneakoscope', 'reports', 'doctor-fix-transaction.json');
  if (fs.existsSync(transaction) && fs.readFileSync(transaction, 'utf8').includes(proofId)) return true;
  const index = path.join(root, '.sneakoscope', 'cache', 'proof-index.json');
  if (!fs.existsSync(index)) return false;
  try {
    const text = fs.readFileSync(index, 'utf8');
    return text.includes(`"${proofId}"`) || text.includes(proofId);
  } catch {
    return false;
  }
}

function phaseRequiresPostcheck(id: string): boolean {
  return /context7|startup|supabase|native|secret|menubar/i.test(id);
}

function runtimeProbeFailures(root: string, id: string): string[] {
  if (!id.includes('menubar') || process.platform !== 'darwin') return [];
  const failures: string[] = [];
  const paths = sksMenuBarPaths(process.env.HOME, root);
  if (!fs.existsSync(paths.executable_path)) failures.push('menubar_app_missing');
  if (!fs.existsSync(paths.action_script_path)) failures.push('action_script_missing');
  else {
    try {
      fs.accessSync(paths.action_script_path, fs.constants.X_OK);
    } catch {
      failures.push('action_script_not_executable');
    }
  }
  const launchctl = process.env.SKS_MENUBAR_LAUNCHCTL || '/bin/launchctl';
  if (!fs.existsSync(launchctl)) {
    failures.push('launchctl_missing');
    return failures;
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const service = `${uid === null ? 'gui' : `gui/${uid}`}/${SKS_MENUBAR_LABEL}`;
  const result = spawnSync(launchctl, ['print', service], {
    encoding: 'utf8',
    timeout: 500,
    maxBuffer: 32 * 1024
  });
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.error) failures.push(`launchctl_probe_error:${result.error.message}`);
  else if (result.status !== 0 || !(/\bstate = running\b|\bpid = \d+\b/.test(text))) failures.push('launchd_not_running');
  return failures;
}

function writeDirtyPlan(root: string, plan: DoctorDirtyPlan): void {
  const file = dirtyPlanPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(plan, null, 2)}\n`);
}

function dirtyPlanPath(root: string): string {
  return path.join(root, '.sneakoscope', 'reports', 'doctor-dirty-plan.json');
}
