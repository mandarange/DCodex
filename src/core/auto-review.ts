import os from 'node:os';
import path from 'node:path';
import { ensureDir, exists, readText, writeTextAtomic } from './fsx.js';
import { writeCodexConfigGuarded } from './codex/codex-config-guard.js';
import { inspectConfinedPath, removeManagedPathVerified } from './managed-path-safety.js';
import {
  RETIRED_AUTO_REVIEW_POLICY_TEXTS,
  RETIRED_SKS_CONFIG_PROFILE_NAMES
} from './doctor/retired-auto-review-config.js';
import { retiredGlmDesktopProfileBody } from './codex-app/openrouter-provider.js';
import { escapeRegExp } from './text/regex.js';

export { RETIRED_SKS_CONFIG_PROFILE_NAMES } from './doctor/retired-auto-review-config.js';

export const AUTO_REVIEW_REVIEWER = 'auto_review';
export const LEGACY_AUTO_REVIEW_REVIEWER = 'guardian_subagent';
export const AUTO_REVIEW_PROFILE = 'sks-auto-review';
export const AUTO_REVIEW_HIGH_PROFILE = 'sks-auto-review-high';
export const MAD_HIGH_PROFILE = 'sks-mad-high';
export const AUTO_REVIEW_POLICY_TEXT = 'In MAD-SKS launches, allow only scoped high-risk work approved for the active invocation and keep catastrophic DB wipe/all-row safeguards active. The explicit $MAD-SKS or sks mad-sks sql|apply-migration invocation is the SQL-plane approval boundary: execute requested execute_sql/apply_migration mutations with mission-local write transport, read-back proof, and final read-only restoration. Supabase project/account/billing/credential control-plane actions remain denied.';
export const REVIEW_NATIVE_AGENT_PLAN = Object.freeze({
  schema: 'sks.review-native-agent-plan.v1',
  backend: 'native_multi_session_agent_kernel',
  central_ledger: 'agents/agent-events.jsonl',
  personas: [
    {
      id: 'review_safety',
      role: 'safety',
      label: 'Review Safety',
      read_only: true,
      mandate: 'Review permission, DB, destructive action, and unrequested fallback risks before approval.'
    },
    {
      id: 'review_verifier',
      role: 'verifier',
      label: 'Review Verifier',
      read_only: true,
      mandate: 'Check claims, tests, and route evidence before approval.'
    },
    {
      id: 'review_integrator',
      role: 'integrator',
      label: 'Review Integrator',
      read_only: true,
      mandate: 'Close approval only after ledger, session cleanup, and proof graph pass.'
    }
  ],
  safety_personas_read_only_by_default: true,
  manual_agent_count_syntax: 'sks auto-review fixture --json and sks naruto run "$Review <review task>" --agents 5 --max-threads 4 --json',
  dynamic_effort: 'parent assigns high effort to safety/integrator lanes and medium or higher to verification lanes when proof risk is present'
});

export function codexHome(env: any = process.env) {
  return path.resolve(env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex'));
}

export function codexConfigPath(env: any = process.env) {
  return path.join(codexHome(env), 'config.toml');
}

export function codexProfileConfigPath(profile: any, env: any = process.env) {
  return path.join(codexHome(env), `${String(profile || '').trim()}.config.toml`);
}

export function autoReviewProfileName(opts: any = {}) {
  return opts.high ? AUTO_REVIEW_HIGH_PROFILE : AUTO_REVIEW_PROFILE;
}

export async function autoReviewStatus(opts: any = {}) {
  const configPath = opts.configPath || codexConfigPath(opts.env || process.env);
  const text = await readText(configPath, '');
  const profileText = await readText(path.join(path.dirname(configPath), `${AUTO_REVIEW_PROFILE}.config.toml`), '');
  const highProfileText = await readText(path.join(path.dirname(configPath), `${AUTO_REVIEW_HIGH_PROFILE}.config.toml`), '');
  const approvalsReviewer = readTomlString(text, 'approvals_reviewer');
  const profileReviewer = readTomlString(profileText, 'approvals_reviewer');
  const highProfileReviewer = readTomlString(highProfileText, 'approvals_reviewer');
  const legacyReviewProfile = readTableString(text, `profiles.${AUTO_REVIEW_PROFILE}`, 'approvals_reviewer');
  const legacyHighProfile = readTableString(text, `profiles.${AUTO_REVIEW_HIGH_PROFILE}`, 'approvals_reviewer');
  return {
    config_path: configPath,
    exists: await exists(configPath),
    approvals_reviewer: approvalsReviewer,
    enabled: approvalsReviewer === AUTO_REVIEW_REVIEWER,
    profile: profileReviewer === AUTO_REVIEW_REVIEWER,
    high_profile: highProfileReviewer === AUTO_REVIEW_REVIEWER,
    legacy_invalid: [approvalsReviewer, profileReviewer, highProfileReviewer, legacyReviewProfile, legacyHighProfile].includes(LEGACY_AUTO_REVIEW_REVIEWER),
    policy: readTableString(text, 'auto_review', 'policy') || '',
    native_agent_plan: REVIEW_NATIVE_AGENT_PLAN
  };
}

export async function enableAutoReview(opts: any = {}) {
  const configPath = opts.configPath || codexConfigPath(opts.env || process.env);
  const high = Boolean(opts.high);
  await ensureDir(path.dirname(configPath));
  const current = await readText(configPath, '');
  let next = current || '';
  next = upsertTopLevelString(next, 'approvals_reviewer', AUTO_REVIEW_REVIEWER);
  next = removeLegacyProfileConfig(next, AUTO_REVIEW_PROFILE);
  next = removeLegacyProfileConfig(next, AUTO_REVIEW_HIGH_PROFILE);
  next = upsertAutoReviewPolicy(next);
  if (!next.endsWith('\n')) next += '\n';
  await writeCodexConfigGuarded({
    configPath,
    before: current,
    cause: 'auto-review-enable',
    mutate: () => next
  });
  await writeProfileConfig(configPath, AUTO_REVIEW_PROFILE, profileConfigBlock({ effort: 'medium' }));
  await writeProfileConfig(configPath, AUTO_REVIEW_HIGH_PROFILE, profileConfigBlock({ effort: 'high' }));
  return {
    ...(await autoReviewStatus({ configPath })),
    profile_name: autoReviewProfileName({ high }),
    launch_args: ['--profile', autoReviewProfileName({ high })]
  };
}

// Canonical registry of every SKS config profile. Codex 0.134+ deprecated the
// `[profiles.*]` tables / top-level `profile=` selector (warns at startup) in favor of
// per-file `$CODEX_HOME/<name>.config.toml` overlays loaded by `--profile <name>`.
// `stripTable: true` => remove the legacy `[profiles.<name>]` table from the home
// config during migration. Fast mode now persists through top-level
// `service_tier = "fast"` and per-file overlays; `[user.fast_mode]`,
// `default_profile`, and `[profiles.sks-fast-high]` are stripped as legacy schema.
export const SKS_CONFIG_PROFILES: Array<{ name: string; stripTable: boolean; block: string }> = [
  { name: 'sks-task-low', stripTable: true, block: sksProfileFileBlock({ effort: 'low' }) },
  { name: 'sks-task-medium', stripTable: true, block: sksProfileFileBlock({ effort: 'medium' }) },
  { name: 'sks-logic-high', stripTable: true, block: sksProfileFileBlock({ effort: 'high' }) },
  { name: 'sks-fast-high', stripTable: true, block: sksProfileFileBlock({ effort: 'high', serviceTier: 'fast', inheritSandbox: true }) },
  { name: 'sks-research-xhigh', stripTable: true, block: sksProfileFileBlock({ effort: 'xhigh' }) },
  { name: 'sks-research', stripTable: true, block: sksProfileFileBlock({ effort: 'xhigh', approvalPolicy: 'never' }) },
  { name: MAD_HIGH_PROFILE, stripTable: true, block: sksProfileFileBlock({ effort: 'xhigh', approvalPolicy: 'never', sandboxMode: 'danger-full-access', reviewer: AUTO_REVIEW_REVIEWER }) },
  { name: 'sks-default', stripTable: true, block: sksProfileFileBlock({ effort: 'high' }) }
];

function sksProfileFileBlock(opts: any = {}) {
  return [
    `service_tier = "${opts.serviceTier || 'fast'}"`,
    `approval_policy = "${opts.approvalPolicy || 'on-request'}"`,
    ...(opts.reviewer ? [`approvals_reviewer = "${opts.reviewer}"`] : []),
    ...(opts.inheritSandbox ? [] : [`sandbox_mode = "${opts.sandboxMode || 'workspace-write'}"`]),
    `model_reasoning_effort = "${opts.effort || 'medium'}"`
  ].join('\n');
}

// Migrate every SKS config profile to a per-file `<name>.config.toml` overlay in
// CODEX_HOME and strip the deprecated legacy `[profiles.sks-*]` tables / `profile=`
// selectors from the home config. Idempotent (second run is a no-op). This is the
// step that clears the Codex deprecation warning on `sks --mad`.
export async function migrateSksProfilesToPerFile(opts: any = {}) {
  const configPath = opts.configPath || codexConfigPath(opts.env || process.env);
  await ensureDir(path.dirname(configPath));
  const current = await readText(configPath, '');
  let next = String(current || '');
  let retiredProfileTableCount = 0;
  for (const profile of RETIRED_SKS_CONFIG_PROFILE_NAMES) {
    if (tableBody(next, `profiles.${profile}`) || readTomlString(topLevelBody(next), 'profile') === profile) {
      retiredProfileTableCount += 1;
    }
    next = removeLegacyProfileConfig(next, profile);
  }
  for (const profile of SKS_CONFIG_PROFILES) {
    if (profile.stripTable) next = removeLegacyProfileConfig(next, profile.name);
  }
  if (next && !next.endsWith('\n')) next += '\n';
  if (next !== String(current || '')) await writeCodexConfigGuarded({
    configPath,
    before: current,
    cause: 'sks-profile-migration',
    mutate: () => next
  });
  for (const profile of SKS_CONFIG_PROFILES) await writeProfileConfig(configPath, profile.name, profile.block);
  let retiredProfileFileRemovedCount = 0;
  for (const profile of RETIRED_SKS_CONFIG_PROFILE_NAMES) {
    const file = path.join(path.dirname(configPath), `${profile}.config.toml`);
    const inspection = await inspectConfinedPath(path.dirname(configPath), file).catch(() => null);
    if (!inspection?.exists || inspection.leafSymlink || !inspection.stat?.isFile()) continue;
    const text = await readText(file, '');
    if (!isSksGeneratedRetiredProfileText(text)) continue;
    await removeManagedPathVerified(path.dirname(configPath), file);
    retiredProfileFileRemovedCount += 1;
  }
  return {
    config_path: configPath,
    profiles_written: SKS_CONFIG_PROFILES.map((profile) => profile.name),
    tables_stripped: SKS_CONFIG_PROFILES.filter((profile) => profile.stripTable).map((profile) => profile.name),
    retired_profile_table_count: retiredProfileTableCount,
    retired_profile_file_removed_count: retiredProfileFileRemovedCount
  };
}

export interface RetiredSksConfigTextReconcileResult {
  text: string;
  detected_count: number;
  user_authored_conflict: boolean;
}

export function reconcileRetiredSksConfigText(text: string): RetiredSksConfigTextReconcileResult {
  const before = String(text || '');
  let next = before;
  let detected = 0;
  let userAuthoredConflict = false;

  for (const profile of RETIRED_SKS_CONFIG_PROFILE_NAMES) {
    const body = tableBody(next, `profiles.${profile}`);
    const selected = readTomlString(topLevelBody(next), 'profile') === profile;
    if (body) {
      detected += 1;
      if (!isSksGeneratedRetiredProfileText(body)) userAuthoredConflict = true;
    } else if (selected) {
      detected += 1;
    }
    next = removeLegacyProfileConfig(next, profile);
  }

  const autoReviewPolicy = readTableString(next, 'auto_review', 'policy');
  if (autoReviewPolicy && RETIRED_AUTO_REVIEW_POLICY_TEXTS.has(autoReviewPolicy)) {
    detected += 1;
    next = upsertAutoReviewPolicy(next);
  }

  return {
    text: next,
    detected_count: detected,
    user_authored_conflict: userAuthoredConflict
  };
}

export function isSksGeneratedRetiredProfileText(text: string): boolean {
  const normalized = normalizeGeneratedProfileText(text);
  return managedRetiredProfileBodies().has(normalized);
}

export function buildMadHighLaunchProfileNoWrite(opts: any = {}) {
  const env = opts.env || process.env;
  const profileName = String(opts.profileName || MAD_HIGH_PROFILE);
  return {
    config_path: codexConfigPath(env),
    profile_config_path: codexProfileConfigPath(profileName, env),
    profile_name: profileName,
    launch_args: [
      '--sandbox',
      'danger-full-access',
      '--ask-for-approval',
      'never',
      '-c',
      'service_tier=fast',
      '-c',
      'model_reasoning_effort=xhigh'
    ],
    sandbox_mode: 'danger-full-access',
    approval_policy: 'never',
    model_reasoning_effort: 'xhigh',
    service_tier: 'fast',
    scope: 'explicit_launch_only',
    writes_user_codex_config: false
  };
}

export async function ensureMadHighProfileForSetupOrRepair(opts: any = {}) {
  const configPath = opts.configPath || codexConfigPath(opts.env || process.env);
  const env = opts.env || process.env;
  await ensureDir(path.dirname(configPath));
  const current = await readText(configPath, '');
  let next = removeLegacyProfileConfig(current, MAD_HIGH_PROFILE);
  next = upsertAutoReviewPolicy(next);
  if (!next.endsWith('\n')) next += '\n';
  await writeCodexConfigGuarded({
    configPath,
    before: current,
    cause: 'mad-high-profile-setup',
    mutate: () => next
  });
  // Convert all SKS profiles to per-file overlays and strip the deprecated tables /
  // selectors so Codex stops warning about the legacy config profile on launch.
  await migrateSksProfilesToPerFile({ configPath, env });
  await writeProfileConfig(configPath, MAD_HIGH_PROFILE, profileConfigBlock({
    effort: 'xhigh',
    approvalPolicy: 'never',
    sandboxMode: 'danger-full-access'
  }));
  return {
    config_path: configPath,
    profile_config_path: path.join(path.dirname(configPath), `${MAD_HIGH_PROFILE}.config.toml`),
    profile_name: MAD_HIGH_PROFILE,
    launch_args: ['--profile', MAD_HIGH_PROFILE, '--sandbox', 'danger-full-access', '--ask-for-approval', 'never', '-c', 'service_tier=fast', '-c', 'model_reasoning_effort=xhigh'],
    sandbox_mode: 'danger-full-access',
    approval_policy: 'never',
    approvals_reviewer: AUTO_REVIEW_REVIEWER,
    model_reasoning_effort: 'xhigh',
    service_tier: 'fast',
    scope: 'setup_or_repair_only',
    writes_user_codex_config: true
  };
}

export async function enableMadHighProfile(opts: any = {}) {
  if (opts.allowUserConfigWrite !== true) {
    throw new Error('enableMadHighProfile writes Codex user config; use buildMadHighLaunchProfileNoWrite for sks --mad');
  }
  return ensureMadHighProfileForSetupOrRepair(opts);
}

export function madHighProfileName() {
  return MAD_HIGH_PROFILE;
}

export async function disableAutoReview(opts: any = {}) {
  const configPath = opts.configPath || codexConfigPath(opts.env || process.env);
  const current = await readText(configPath, '');
  let next = upsertTopLevelString(current, 'approvals_reviewer', 'user');
  next = removeLegacyProfileConfig(next, AUTO_REVIEW_PROFILE);
  next = removeLegacyProfileConfig(next, AUTO_REVIEW_HIGH_PROFILE);
  if (!next.endsWith('\n')) next += '\n';
  await writeCodexConfigGuarded({
    configPath,
    before: current,
    cause: 'auto-review-disable',
    mutate: () => next
  });
  await writeProfileConfig(configPath, AUTO_REVIEW_PROFILE, profileConfigBlock({ effort: 'medium', reviewer: 'user' }));
  await writeProfileConfig(configPath, AUTO_REVIEW_HIGH_PROFILE, profileConfigBlock({ effort: 'high', reviewer: 'user' }));
  return autoReviewStatus({ configPath });
}

export function autoReviewSummary(status: any = {}) {
  const lines = [
    'Codex Auto-Review',
    '',
    `Config:             ${status.config_path || codexConfigPath()}`,
    `Approvals reviewer: ${status.approvals_reviewer || 'unset'}`,
    `Enabled:            ${status.enabled ? 'yes' : 'no'}`,
    `Profile:            ${status.profile ? AUTO_REVIEW_PROFILE : 'missing'}`,
    `High profile:       ${status.high_profile ? AUTO_REVIEW_HIGH_PROFILE : 'missing'}`
  ];
  if (!status.enabled) {
    lines.push('', 'Enable with: sks auto-review enable');
    lines.push('Launch high mode with: sks --Auto-review --high');
  }
  if (status.legacy_invalid) {
    lines.push('', 'Legacy reviewer value found: run sks auto-review enable or sks auto-review disable to rewrite Codex config.');
  }
  return lines.join('\n');
}

function readTomlString(text: any, key: any) {
  const re = new RegExp(`^${escapeRegExp(key)}\\s*=\\s*"([^"]*)"\\s*$`, 'm');
  return text.match(re)?.[1] || null;
}

function readTableString(text: any, table: any, key: any) {
  const body = tableBody(text, table);
  if (!body) return null;
  return readTomlString(body, key);
}

function tableHasString(text: any, table: any, key: any, value: any) {
  return readTableString(text, table, key) === value;
}

function tableBody(text: any, table: any) {
  const lines = String(text || '').split('\n');
  const header = `[${table}]`;
  const out: any[] = [];
  let inTable = false;
  for (const line of lines) {
    if (/^\s*\[.+\]\s*$/.test(line)) {
      if (inTable) break;
      inTable = line.trim() === header;
      continue;
    }
    if (inTable) out.push(line);
  }
  return inTable || out.length ? out.join('\n') : '';
}

function topLevelBody(text: any) {
  const lines = String(text || '').split('\n');
  const firstTable = lines.findIndex((line: string) => /^\s*\[.+\]\s*$/.test(line));
  return (firstTable === -1 ? lines : lines.slice(0, firstTable)).join('\n');
}

function upsertTopLevelString(text: any, key: any, value: any) {
  const line = `${key} = "${value}"`;
  const lines = String(text || '').split('\n');
  const firstTable = lines.findIndex((x: any) => /^\s*\[.+\]\s*$/.test(x));
  const end = firstTable === -1 ? lines.length : firstTable;
  for (let i = 0; i < end; i++) {
    if (new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`).test(lines[i] || '')) {
      lines[i] = line;
      return lines.join('\n').replace(/\n+$/, '\n');
    }
  }
  lines.splice(end, 0, line);
  return lines.join('\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n');
}

function profileConfigBlock(opts: any = {}) {
  const effort = opts.effort || 'medium';
  const reviewer = opts.reviewer || AUTO_REVIEW_REVIEWER;
  const approvalPolicy = opts.approvalPolicy || 'on-request';
  const sandboxMode = opts.sandboxMode || 'workspace-write';
  return [
    'service_tier = "fast"',
    `approval_policy = "${approvalPolicy}"`,
    `approvals_reviewer = "${reviewer}"`,
    `sandbox_mode = "${sandboxMode}"`,
    `model_reasoning_effort = "${effort}"`
  ].join('\n');
}

async function writeProfileConfig(configPath: string, profile: string, text: string) {
  const file = path.join(path.dirname(configPath), `${profile}.config.toml`);
  await writeTextAtomic(file, `${String(text || '').replace(/\s+$/, '')}\n`);
}

function removeLegacyProfileConfig(text: any, profile: any) {
  let next = removeTable(text, `profiles.${profile}`);
  next = removeTopLevelStringIfValue(next, 'profile', profile);
  return next;
}

function upsertAutoReviewPolicy(text: any) {
  const policy = [
    '[auto_review]',
    `policy = "${AUTO_REVIEW_POLICY_TEXT}"`
  ].join('\n');
  const existing = readTableString(text, 'auto_review', 'policy');
  if (existing && /unrequested fallback implementation code/i.test(existing)) return text;
  return upsertTable(text, 'auto_review', policy);
}

function upsertTable(text: any, table: any, block: any) {
  const lines = String(text || '').replace(/\s+$/, '').split('\n');
  const header = `[${table}]`;
  const start = lines.findIndex((x: any) => x.trim() === header);
  if (start === -1) {
    return `${lines.filter((x: any, i: any) => i > 0 || x.trim()).join('\n')}${lines.some((x: any) => x.trim()) ? '\n\n' : ''}${block}\n`;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[.+\]\s*$/.test(lines[i] || '')) {
      end = i;
      break;
    }
  }
  lines.splice(start, end - start, ...block.split('\n'));
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

function removeTable(text: any, table: any) {
  const lines = String(text || '').replace(/\s+$/, '').split('\n');
  const header = `[${table}]`;
  const start = lines.findIndex((x: any) => x.trim() === header);
  if (start === -1) return String(text || '');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[.+\]\s*$/.test(lines[i] || '')) {
      end = i;
      break;
    }
  }
  lines.splice(start, end - start);
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')}\n`;
}

function removeTopLevelStringIfValue(text: any, key: any, value: any) {
  const lines = String(text || '').split('\n');
  const firstTable = lines.findIndex((x: any) => /^\s*\[.+\]\s*$/.test(x));
  const end = firstTable === -1 ? lines.length : firstTable;
  for (let i = 0; i < end; i++) {
    const match = String(lines[i] || '').match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*"([^"]*)"\\s*$`));
    if (match?.[1] === String(value)) {
      lines.splice(i, 1);
      break;
    }
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')}\n`;
}

function normalizeGeneratedProfileText(text: string): string {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

function managedRetiredProfileBodies(): Set<string> {
  return new Set([
    sksProfileFileBlock({ effort: 'medium' }),
    profileConfigBlock({ effort: 'medium' }),
    profileConfigBlock({ effort: 'medium', reviewer: LEGACY_AUTO_REVIEW_REVIEWER }),
    [
      'model = "gpt-5.5"',
      'service_tier = "fast"',
      'approval_policy = "on-request"',
      'sandbox_mode = "workspace-write"',
      'model_reasoning_effort = "medium"'
    ].join('\n'),
    [
      'model = "gpt-5.6-terra"',
      'service_tier = "fast"',
      'approval_policy = "on-request"',
      'sandbox_mode = "workspace-write"',
      'model_reasoning_effort = "medium"'
    ].join('\n'),
    retiredGlmDesktopProfileBody('none'),
    retiredGlmDesktopProfileBody('minimal'),
    retiredGlmDesktopProfileBody('low'),
    retiredGlmDesktopProfileBody('medium'),
    retiredGlmDesktopProfileBody('high'),
    retiredGlmDesktopProfileBody('xhigh')
  ].map(normalizeGeneratedProfileText));
}
