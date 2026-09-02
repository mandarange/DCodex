import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Verification profile — how much of SKS's proof machinery stands between a
 * model and "done".
 *
 * SKS was built when models lied often enough that every completion needed a
 * ritual: an "Honest Mode" section matched by regex, a completion-proof
 * artifact, a reflection gate, a root-cause analysis, evidence ledgers written
 * on every tool call. Models no longer need to be policed that way, and the
 * rituals themselves became the product's biggest cost — two cold hook
 * processes per tool call, finishes blocked over wording, work stopped by a
 * one-byte skill-file drift.
 *
 * `essential` (the default) keeps what protects the user's machine and data —
 * DB safety, catastrophic-operation refusal, secret redaction, the
 * harness-maintenance guard, recursion/fan-out caps — and drops the
 * anti-lying rituals. `strict` is the legacy behavior, available to anyone
 * who still wants it.
 */
export type VerificationProfile = 'essential' | 'strict';

export const VERIFICATION_PROFILES: readonly VerificationProfile[] = ['essential', 'strict'];
export const DEFAULT_VERIFICATION_PROFILE: VerificationProfile = 'essential';
export const VERIFICATION_PROFILE_ENV = 'SKS_VERIFICATION_PROFILE';
/** `{ "profile": "strict" }` under `<root>/.sneakoscope/` or the global root. */
export const VERIFICATION_PROFILE_FILE = 'verification-profile.json';

const CACHE_TTL_MS = 5_000;
const cache = new Map<string, { at: number; profile: VerificationProfile }>();

export function normalizeVerificationProfile(value: unknown): VerificationProfile | null {
  const text = String(value ?? '').trim().toLowerCase();
  return text === 'essential' || text === 'strict' ? text : null;
}

function globalRootDir(env: NodeJS.ProcessEnv): string {
  return env.SKS_GLOBAL_ROOT || path.join(env.HOME || os.homedir(), '.sneakoscope-global');
}

function readProfileFile(file: string): VerificationProfile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { profile?: unknown };
    return normalizeVerificationProfile(parsed?.profile);
  } catch {
    return null;
  }
}

/**
 * Whether this process is the SKS test harness. Inside it the legacy `strict`
 * profile stays the default so the existing suite keeps proving strict
 * behavior; `essential` is exercised by tests that ask for it explicitly and
 * by the built-CLI gates, which run outside the harness.
 */
export function isVerificationTestHarness(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_TEST_CONTEXT !== undefined || env.SKS_TEST_ISOLATION === '1';
}

/**
 * Precedence: `SKS_VERIFICATION_PROFILE` → `<root>/.sneakoscope/verification-profile.json`
 * → `<global root>/verification-profile.json` → harness default (`strict`)
 * → product default (`essential`). Cached briefly per root; hooks call this on
 * every event.
 */
export function resolveVerificationProfile(root?: string | null, env: NodeJS.ProcessEnv = process.env): VerificationProfile {
  const explicit = normalizeVerificationProfile(env[VERIFICATION_PROFILE_ENV]);
  if (explicit) return explicit;
  const key = `${root ? path.resolve(root) : ''}|${globalRootDir(env)}|${isVerificationTestHarness(env) ? 't' : 'p'}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.profile;
  const profile = (root ? readProfileFile(path.join(path.resolve(root), '.sneakoscope', VERIFICATION_PROFILE_FILE)) : null)
    ?? readProfileFile(path.join(globalRootDir(env), VERIFICATION_PROFILE_FILE))
    ?? (isVerificationTestHarness(env) ? 'strict' : DEFAULT_VERIFICATION_PROFILE);
  cache.set(key, { at: Date.now(), profile });
  return profile;
}

/** Tests and the profile writer use this after changing a profile file. */
export function resetVerificationProfileCache(): void {
  cache.clear();
}

export function isStrictVerification(root?: string | null, env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveVerificationProfile(root, env) === 'strict';
}

/** Stop-hook finalization rituals: Honest Mode / completion-summary wording, gap loopback, route proof, reflection. */
export function stopFinalizationRitualsEnforced(root?: string | null, env: NodeJS.ProcessEnv = process.env): boolean {
  return isStrictVerification(root, env);
}

/** Managed-skill digest drift blocks prompts and tool calls (strict) or is repaired/advised silently (essential). */
export function managedSkillDigestBlocksEnforced(root?: string | null, env: NodeJS.ProcessEnv = process.env): boolean {
  return isStrictVerification(root, env);
}

/** Per-tool-call evidence recording (PostToolUse hook) is installed and run. */
export function postToolEvidenceEnabled(root?: string | null, env: NodeJS.ProcessEnv = process.env): boolean {
  return isStrictVerification(root, env);
}

/** Routes whose only readiness proof is a manual real-output binding count against doctor `ok`. */
export function manualProofRoutesBlockReadiness(root?: string | null, env: NodeJS.ProcessEnv = process.env): boolean {
  return isStrictVerification(root, env);
}

/**
 * Hook commands go through the warm `sksd` daemon (~150 ms) instead of a cold
 * Node start (~600 ms). `SKS_HOOK_DAEMON=1|0` wins; otherwise on, except
 * inside the test harness, where a detached daemon per temp root would leak.
 */
export function hookDaemonEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = String(env.SKS_HOOK_DAEMON ?? '').trim();
  if (explicit === '1') return true;
  if (explicit === '0') return false;
  return !isVerificationTestHarness(env);
}

export interface VerificationProfileSummary {
  schema: 'sks.verification-profile.v1';
  profile: VerificationProfile;
  source: 'env' | 'project_file' | 'global_file' | 'harness_default' | 'default';
  hook_daemon: boolean;
  post_tool_evidence: boolean;
  stop_finalization_rituals: boolean;
  managed_skill_digest_blocks: boolean;
  manual_proof_routes_block_readiness: boolean;
}

export function verificationProfileSummary(root?: string | null, env: NodeJS.ProcessEnv = process.env): VerificationProfileSummary {
  const explicit = normalizeVerificationProfile(env[VERIFICATION_PROFILE_ENV]);
  const projectFile = root ? readProfileFile(path.join(path.resolve(root), '.sneakoscope', VERIFICATION_PROFILE_FILE)) : null;
  const globalFile = readProfileFile(path.join(globalRootDir(env), VERIFICATION_PROFILE_FILE));
  const source: VerificationProfileSummary['source'] = explicit ? 'env'
    : projectFile ? 'project_file'
      : globalFile ? 'global_file'
        : isVerificationTestHarness(env) ? 'harness_default' : 'default';
  const profile = explicit ?? projectFile ?? globalFile ?? (isVerificationTestHarness(env) ? 'strict' : DEFAULT_VERIFICATION_PROFILE);
  const strict = profile === 'strict';
  return {
    schema: 'sks.verification-profile.v1',
    profile,
    source,
    hook_daemon: hookDaemonEnabled(env),
    post_tool_evidence: strict,
    stop_finalization_rituals: strict,
    managed_skill_digest_blocks: strict,
    manual_proof_routes_block_readiness: strict,
  };
}

/** Write the project or global profile file; returns the path written. */
export function writeVerificationProfile(profile: VerificationProfile, target: { root?: string | null; scope: 'project' | 'global' }, env: NodeJS.ProcessEnv = process.env): string {
  const dir = target.scope === 'project'
    ? path.join(path.resolve(target.root || process.cwd()), '.sneakoscope')
    : globalRootDir(env);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, VERIFICATION_PROFILE_FILE);
  fs.writeFileSync(file, `${JSON.stringify({ schema: 'sks.verification-profile.v1', profile }, null, 2)}\n`);
  resetVerificationProfileCache();
  return file;
}
