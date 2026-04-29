import os from 'node:os';
import path from 'node:path';
import { ensureDir, exists, readText, writeTextAtomic } from './fsx.mjs';

export const AUTO_REVIEW_REVIEWER = 'auto_review';
export const LEGACY_AUTO_REVIEW_REVIEWER = 'guardian_subagent';
export const AUTO_REVIEW_PROFILE = 'sks-auto-review';
export const AUTO_REVIEW_HIGH_PROFILE = 'sks-auto-review-high';
export const MAD_HIGH_PROFILE = 'sks-mad-high';

export function codexHome(env = process.env) {
  return path.resolve(env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex'));
}

export function codexConfigPath(env = process.env) {
  return path.join(codexHome(env), 'config.toml');
}

export function autoReviewProfileName(opts = {}) {
  return opts.high ? AUTO_REVIEW_HIGH_PROFILE : AUTO_REVIEW_PROFILE;
}

export async function autoReviewStatus(opts = {}) {
  const configPath = opts.configPath || codexConfigPath(opts.env || process.env);
  const text = await readText(configPath, '');
  const approvalsReviewer = readTomlString(text, 'approvals_reviewer');
  const profileReviewer = readTableString(text, `profiles.${AUTO_REVIEW_PROFILE}`, 'approvals_reviewer');
  const highProfileReviewer = readTableString(text, `profiles.${AUTO_REVIEW_HIGH_PROFILE}`, 'approvals_reviewer');
  return {
    config_path: configPath,
    exists: await exists(configPath),
    approvals_reviewer: approvalsReviewer,
    enabled: approvalsReviewer === AUTO_REVIEW_REVIEWER,
    profile: profileReviewer === AUTO_REVIEW_REVIEWER,
    high_profile: highProfileReviewer === AUTO_REVIEW_REVIEWER,
    legacy_invalid: [approvalsReviewer, profileReviewer, highProfileReviewer].includes(LEGACY_AUTO_REVIEW_REVIEWER),
    policy: readTableString(text, 'auto_review', 'policy') || ''
  };
}

export async function enableAutoReview(opts = {}) {
  const configPath = opts.configPath || codexConfigPath(opts.env || process.env);
  const high = Boolean(opts.high);
  await ensureDir(path.dirname(configPath));
  const current = await readText(configPath, '');
  let next = current || '';
  next = upsertTopLevelString(next, 'approvals_reviewer', AUTO_REVIEW_REVIEWER);
  next = upsertProfile(next, AUTO_REVIEW_PROFILE, 'medium');
  next = upsertProfile(next, AUTO_REVIEW_HIGH_PROFILE, 'high');
  next = upsertAutoReviewPolicy(next);
  if (!next.endsWith('\n')) next += '\n';
  await writeTextAtomic(configPath, next);
  return {
    ...(await autoReviewStatus({ configPath })),
    profile_name: autoReviewProfileName({ high }),
    launch_args: ['--profile', autoReviewProfileName({ high })]
  };
}

export async function enableMadHighProfile(opts = {}) {
  const configPath = opts.configPath || codexConfigPath(opts.env || process.env);
  await ensureDir(path.dirname(configPath));
  const current = await readText(configPath, '');
  let next = upsertTable(current, `profiles.${MAD_HIGH_PROFILE}`, [
    `[profiles.${MAD_HIGH_PROFILE}]`,
    'model = "gpt-5.5"',
    'approval_policy = "on-request"',
    `approvals_reviewer = "${AUTO_REVIEW_REVIEWER}"`,
    'sandbox_mode = "danger-full-access"',
    'model_reasoning_effort = "high"'
  ].join('\n'));
  next = upsertAutoReviewPolicy(next);
  if (!next.endsWith('\n')) next += '\n';
  await writeTextAtomic(configPath, next);
  return {
    config_path: configPath,
    profile_name: MAD_HIGH_PROFILE,
    launch_args: ['--profile', MAD_HIGH_PROFILE],
    sandbox_mode: 'danger-full-access',
    approval_policy: 'on-request',
    approvals_reviewer: AUTO_REVIEW_REVIEWER,
    model_reasoning_effort: 'high',
    scope: 'explicit_launch_only'
  };
}

export function madHighProfileName() {
  return MAD_HIGH_PROFILE;
}

export async function disableAutoReview(opts = {}) {
  const configPath = opts.configPath || codexConfigPath(opts.env || process.env);
  const current = await readText(configPath, '');
  let next = upsertTopLevelString(current, 'approvals_reviewer', 'user');
  if (tableBody(next, `profiles.${AUTO_REVIEW_PROFILE}`)) next = upsertProfile(next, AUTO_REVIEW_PROFILE, 'medium', 'user');
  if (tableBody(next, `profiles.${AUTO_REVIEW_HIGH_PROFILE}`)) next = upsertProfile(next, AUTO_REVIEW_HIGH_PROFILE, 'high', 'user');
  if (!next.endsWith('\n')) next += '\n';
  await writeTextAtomic(configPath, next);
  return autoReviewStatus({ configPath });
}

export function autoReviewSummary(status = {}) {
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

function readTomlString(text, key) {
  const re = new RegExp(`^${escapeRegExp(key)}\\s*=\\s*"([^"]*)"\\s*$`, 'm');
  return text.match(re)?.[1] || null;
}

function readTableString(text, table, key) {
  const body = tableBody(text, table);
  if (!body) return null;
  return readTomlString(body, key);
}

function tableHasString(text, table, key, value) {
  return readTableString(text, table, key) === value;
}

function tableBody(text, table) {
  const lines = String(text || '').split('\n');
  const header = `[${table}]`;
  const out = [];
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

function upsertTopLevelString(text, key, value) {
  const line = `${key} = "${value}"`;
  const lines = String(text || '').split('\n');
  const firstTable = lines.findIndex((x) => /^\s*\[.+\]\s*$/.test(x));
  const end = firstTable === -1 ? lines.length : firstTable;
  for (let i = 0; i < end; i++) {
    if (new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`).test(lines[i])) {
      lines[i] = line;
      return lines.join('\n').replace(/\n+$/, '\n');
    }
  }
  lines.splice(end, 0, line);
  return lines.join('\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n');
}

function upsertProfile(text, profile, effort, reviewer = AUTO_REVIEW_REVIEWER) {
  const block = [
    `[profiles.${profile}]`,
    'model = "gpt-5.5"',
    'approval_policy = "on-request"',
    `approvals_reviewer = "${reviewer}"`,
    'sandbox_mode = "workspace-write"',
    `model_reasoning_effort = "${effort}"`
  ].join('\n');
  return upsertTable(text, `profiles.${profile}`, block);
}

function upsertAutoReviewPolicy(text) {
  const policy = [
    '[auto_review]',
    'policy = "Deny destructive database operations, credential exfiltration, persistent security weakening, broad file deletion, and writes outside the workspace unless explicitly authorized by the user."'
  ].join('\n');
  if (readTableString(text, 'auto_review', 'policy')) return text;
  return upsertTable(text, 'auto_review', policy);
}

function upsertTable(text, table, block) {
  const lines = String(text || '').replace(/\s+$/, '').split('\n');
  const header = `[${table}]`;
  const start = lines.findIndex((x) => x.trim() === header);
  if (start === -1) {
    return `${lines.filter((x, i) => i > 0 || x.trim()).join('\n')}${lines.some((x) => x.trim()) ? '\n\n' : ''}${block}\n`;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[.+\]\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  lines.splice(start, end - start, ...block.split('\n'));
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
