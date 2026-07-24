import path from 'node:path';
import fsp from 'node:fs/promises';
import { appendJsonlBounded, exists, nowIso, readJson, readText, sha256, writeJsonAtomic } from './fsx.js';

export const HARNESS_GUARD_PATH = '.sneakoscope/harness-guard.json';

export const HARNESS_STATIC_FILES = [
  '.codex/config.toml',
  '.codex/hooks.json',
  '.codex/SNEAKOSCOPE.md',
  'AGENTS.md',
  '.sneakoscope/manifest.json',
  '.sneakoscope/policy.json',
  '.sneakoscope/db-safety.json',
  HARNESS_GUARD_PATH
];

export const HARNESS_STATIC_DIRS = [
  '.agents/skills',
  '.codex/agents',
  'node_modules/sneakoscope'
];

export const HARNESS_RUNTIME_MUTABLE = [
  '.sneakoscope/state',
  '.sneakoscope/missions',
  '.sneakoscope/reports',
  '.sneakoscope/tmp',
  '.sneakoscope/wiki',
  '.sneakoscope/gx/cartridges',
  '.sneakoscope/hproof',
  '.sneakoscope/db-safety-scan.json'
];

export async function isHarnessSourceProject(root: any) {
  const pkg = await readJson(path.join(root, 'package.json'), null);
  return pkg?.name === 'sneakoscope'
    && await exists(path.join(root, 'src', 'bin', 'sks.ts'))
    && await exists(path.join(root, 'src', 'core', 'init.ts'))
    && await exists(path.join(root, 'src', 'core', 'hooks-runtime.ts'));
}

export async function writeHarnessGuardPolicy(root: any, opts: any = {}) {
  const sourceException = opts.engineSourceException ?? await isHarnessSourceProject(root);
  const policy = {
    schema_version: 1,
    enabled: true,
    locked: !sourceException,
    engine_source_exception: sourceException,
    engine_source_detection: 'package.name=sneakoscope + src/bin/sks.ts + src/core/init.ts + src/core/hooks-runtime.ts',
    rule: 'LLM tool calls must not modify installed Sneakoscope harness control files. Agents must never run `sks doctor --fix`; ask the user to run it in their own terminal when repair is needed.',
    protected_files: HARNESS_STATIC_FILES,
    protected_dirs: HARNESS_STATIC_DIRS,
    runtime_mutable_paths: HARNESS_RUNTIME_MUTABLE,
    blocked_maintenance_commands: [
      'sks setup/init/fix-path',
      'sks doctor --fix (operator-only; agents must ask the user)',
      'sks context7 setup',
      'npm remove/uninstall sneakoscope'
    ],
    fingerprints: await collectHarnessFingerprints(root),
    updated_at: nowIso()
  };
  await writeJsonAtomic(path.join(root, HARNESS_GUARD_PATH), policy);
  return policy;
}

export async function loadHarnessGuardPolicy(root: any) {
  const policy = await readJson(path.join(root, HARNESS_GUARD_PATH), null);
  const sourceException = await isHarnessSourceProject(root);
  return {
    schema_version: 1,
    enabled: true,
    locked: !sourceException,
    engine_source_exception: sourceException,
    protected_files: HARNESS_STATIC_FILES,
    protected_dirs: HARNESS_STATIC_DIRS,
    runtime_mutable_paths: HARNESS_RUNTIME_MUTABLE,
    fingerprints: {},
    ...(policy || {})
  };
}

export async function harnessGuardStatus(root: any) {
  const policyPath = path.join(root, HARNESS_GUARD_PATH);
  const existsPolicy = await exists(policyPath);
  const policy = await loadHarnessGuardPolicy(root);
  const sourceException = await isHarnessSourceProject(root);
  const current = await collectHarnessFingerprints(root);
  const expected = policy.fingerprints || {};
  const missing: any[] = [];
  const changed: any[] = [];
  for (const [file, hash] of Object.entries(expected)) {
    if (!current[file]) missing.push(file);
    else if (current[file] !== hash) changed.push(file);
  }
  return {
    ok: sourceException || (existsPolicy && policy.enabled && policy.locked && missing.length === 0 && changed.length === 0),
    source_exception: sourceException,
    policy_path: HARNESS_GUARD_PATH,
    policy_exists: existsPolicy,
    locked: Boolean(policy.locked),
    protected_files: policy.protected_files || HARNESS_STATIC_FILES,
    protected_dirs: policy.protected_dirs || HARNESS_STATIC_DIRS,
    fingerprints_checked: Object.keys(expected).length,
    missing,
    changed
  };
}

export async function checkHarnessModification(root: any, payload: any = {}, opts: any = {}) {
  const policy = await loadHarnessGuardPolicy(root);
  const classification = classifyHarnessPayload(root, payload, policy);
  // Operator-only: agents must never self-run doctor --fix, including in the
  // Sneakoscope engine source repo where other harness writes remain allowed.
  if ((classification.reasons || []).includes('sks_doctor_fix_blocked')) {
    const decision = {
      action: 'block',
      reasons: ['sks_doctor_fix_blocked'],
      matches: classification.matches,
      command: classification.command,
      tool: classification.toolName
    };
    await appendJsonlBounded(path.join(root, '.sneakoscope', 'state', 'harness-guard.jsonl'), {
      ts: nowIso(),
      decision,
      payload_keys: Object.keys(payload || {}).sort()
    }).catch(() => {});
    return decision;
  }
  if (!policy.enabled || !policy.locked || policy.engine_source_exception || await isHarnessSourceProject(root)) {
    return { action: 'allow', reason: 'harness_source_exception_or_unlocked' };
  }
  if (classification.block) {
    const decision = { action: 'block', reasons: classification.reasons, matches: classification.matches, command: classification.command, tool: classification.toolName };
    await appendJsonlBounded(path.join(root, '.sneakoscope', 'state', 'harness-guard.jsonl'), { ts: nowIso(), decision, payload_keys: Object.keys(payload || {}).sort() }).catch(() => {});
    return decision;
  }
  return { action: 'allow', classification };
}

export function harnessGuardBlockReason(decision: any = {}) {
  if ((decision.reasons || []).includes('sks_doctor_fix_blocked')) {
    return 'SKS agents must not run `sks doctor --fix`. Ask the user to run `sks doctor --fix` in their own terminal when repair is needed, then continue after they confirm.';
  }
  const matches = (decision.matches || []).slice(0, 6).join(', ');
  return `SKS harness guard blocked this tool call. Installed Sneakoscope harness files are immutable to LLM edits after setup${matches ? `: ${matches}` : ''}. Use manual terminal maintenance or update/reinstall SKS outside the agent. This repository is editable only when it is the Sneakoscope engine source repo.`;
}

export function classifyHarnessPayload(root: any, payload: any = {}, policy: any = {}) {
  const strings = collectPayloadStrings(payload).slice(0, 300);
  const hay = strings.join('\n');
  const toolName = [payload.tool_name, payload.toolName, payload.name, payload.tool?.name, payload.server, payload.mcp_tool, payload.tool, payload.type].filter(Boolean).join(' ').toLowerCase();
  const command = extractCommand(payload);
  const writeIntent = hasWriteIntent(toolName, command, hay);
  const maintenance = classifyMaintenanceCommand(command || hay);
  const writeTargets = extractWriteTargets(root, payload, strings, command);
  const protectedMatches = findProtectedMatches(root, writeTargets.length ? writeTargets : strings, policy);
  const packageEdit = writeIntent && packageManifestEditDetected(writeTargets, hay);
  const block = maintenance.block || packageEdit || (writeIntent && protectedMatches.length > 0);
  const reasons: any[] = [];
  if (maintenance.block) reasons.push(...maintenance.reasons);
  if (packageEdit) reasons.push('package_manifest_sneakoscope_edit_blocked');
  if (writeIntent && protectedMatches.length) reasons.push('protected_harness_path_write_blocked');
  return { block, reasons: [...new Set(reasons)], matches: protectedMatches, writeIntent, toolName, command, writeTargets };
}

export async function collectHarnessFingerprints(root: any) {
  const out: Record<string, string> = {};
  for (const rel of HARNESS_STATIC_FILES) {
    if (rel === HARNESS_GUARD_PATH) continue;
    const abs = path.join(root, rel);
    if (await exists(abs)) out[rel] = sha256(await readText(abs, ''));
  }
  for (const rel of HARNESS_STATIC_DIRS) {
    const abs = path.join(root, rel);
    if (!(await exists(abs))) continue;
    for (const file of await listFiles(abs)) {
      const r = toRel(root, file);
      out[r] = sha256(await readText(file, ''));
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a]: any, [b]: any) => a.localeCompare(b)));
}

async function listFiles(dir: any) {
  const out: any[] = [];
  let entries: any[] = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listFiles(p));
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

function extractCommand(payload: any = {}) {
  return payload.command || payload.tool_input?.command || payload.toolInput?.command || payload.input?.command || payload.tool?.input?.command || '';
}

function collectPayloadStrings(obj: any, out: any = [], depth: any = 0) {
  if (depth > 10 || obj == null) return out;
  if (typeof obj === 'string') { out.push(obj); return out; }
  if (Array.isArray(obj)) { for (const x of obj) collectPayloadStrings(x, out, depth + 1); return out; }
  if (typeof obj === 'object') {
    for (const v of Object.values(obj)) collectPayloadStrings(v, out, depth + 1);
  }
  return out;
}

function extractWriteTargets(root: any, payload: any = {}, strings: any[] = [], command: any = '') {
  const targets = new Set<string>();
  for (const value of collectPathFieldStrings(payload)) addWriteTarget(root, targets, value);
  for (const text of [command, ...strings]) {
    const s = String(text || '');
    for (const match of s.matchAll(/^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s+(.+)$/gmi)) addWriteTarget(root, targets, match[1]);
    for (const match of s.matchAll(/^\*\*\*\s+Move to:\s+(.+)$/gmi)) addWriteTarget(root, targets, match[1]);
    for (const match of s.matchAll(/>{1,2}\s*(['"]?)([^\s;&|'"`]+)\1/g)) addWriteTarget(root, targets, match[2]);
    collectShellCommandTargets(root, targets, s);
  }
  return [...targets].sort();
}

function collectPathFieldStrings(obj: any, out: any = [], depth: any = 0) {
  if (depth > 8 || obj == null) return out;
  if (Array.isArray(obj)) {
    for (const value of obj) collectPathFieldStrings(value, out, depth + 1);
    return out;
  }
  if (typeof obj !== 'object') return out;
  for (const [key, value] of Object.entries(obj)) {
    const normalized = String(key || '').toLowerCase();
    if (typeof value === 'string' && /^(?:path|file|filename|target|destination|dest|to|from|cwd|workdir|file_path|target_path|output_path|artifact_path)$/.test(normalized)) out.push(value);
    collectPathFieldStrings(value, out, depth + 1);
  }
  return out;
}

function collectShellCommandTargets(root: any, targets: Set<string>, text: string) {
  const words = shellWords(text);
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] || '';
    if (!/^(?:rm|rmdir|mv|cp|touch|mkdir|chmod|chown)$/.test(word)) continue;
    for (let j = i + 1; j < words.length; j += 1) {
      const candidate = words[j] || '';
      if (!candidate || candidate.startsWith('-')) continue;
      if (/^(?:&&|\|\||;|\|)$/.test(candidate)) break;
      if (/^(?:rm|rmdir|mv|cp|touch|mkdir|chmod|chown|git|npm|node|python\d?)$/.test(candidate) && j > i + 1) break;
      addWriteTarget(root, targets, candidate);
    }
  }
}

function shellWords(text: string) {
  return [...String(text || '').matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)].map((match) => match[1] || match[2] || match[3]).filter(Boolean);
}

function addWriteTarget(root: any, targets: Set<string>, value: any) {
  const normalized = normalizeTargetPath(root, value);
  if (normalized) targets.add(normalized);
}

function normalizeTargetPath(root: any, value: any) {
  let s = String(value || '').trim();
  if (!s) return '';
  s = s.replace(/^['"`<]+|['"`>,]+$/g, '');
  if (!s || /^\$[\w{]/.test(s) || /^[A-Z_][A-Z0-9_]*=/.test(s)) return '';
  if (/^(?:--?|&&|\|\||;|\|)$/.test(s)) return '';
  s = s.replace(/\\/g, '/');
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  if (s.startsWith('./')) s = s.slice(2);
  const rootNorm = String(root || '').replace(/\\/g, '/').replace(/\/$/, '');
  if (rootNorm && s.startsWith(`${rootNorm}/`)) s = s.slice(rootNorm.length + 1);
  return s.replace(/\/$/, '');
}

function packageManifestEditDetected(writeTargets: string[], hay: string) {
  const hasPackageTarget = writeTargets.length > 0
    ? writeTargets.some((target) => /(^|\/)(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(target))
    : /\b(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)\b/i.test(hay);
  return hasPackageTarget && /\bsneakoscope\b/i.test(hay);
}

function hasWriteIntent(toolName: any, command: any, hay: any) {
  if (/\b(apply_patch|edit|write|create|delete|remove|rename|str_replace|file_write|fs_write)\b/i.test(toolName)) return true;
  const c = String(command || hay || '');
  return /(^|[\s;&|])(?:rm|mv|cp|touch|chmod|chown|mkdir|rmdir|tee)\b/i.test(c)
    || /\b(?:sed\s+-i|perl\s+-pi|python\d?\s+-c|node\s+-e)\b/i.test(c)
    || />{1,2}\s*(?:\.\/)?(?:\.codex|\.agents|\.sneakoscope|AGENTS\.md|package(?:-lock)?\.json)\b/i.test(c)
    || /\*\*\*\s+(?:Update|Add|Delete|Move to)\s+File:/i.test(c)
    || classifyMaintenanceCommand(c).block;
}

function classifyMaintenanceCommand(command: any = '') {
  const c = String(command || '').replace(/\s+/g, ' ').trim();
  const low = c.toLowerCase();
  const reasons: any[] = [];
  const sksInvoke = '(?:sks|sneakoscope|node\\s+\\S*sks\\.js|npx\\s+(?:-y\\s+)?(?:-p\\s+\\S+\\s+)?sks)';
  if (new RegExp(`(^|[\\s;&|])${sksInvoke}(?:\\s+|$)(?:setup|init|fix-path)\\b`).test(low)) reasons.push('sks_harness_maintenance_command_blocked');
  if (new RegExp(`(^|[\\s;&|])${sksInvoke}\\s+doctor\\b[\\s\\S]*\\s--fix\\b`).test(low)) reasons.push('sks_doctor_fix_blocked');
  if (new RegExp(`(^|[\\s;&|])${sksInvoke}\\s+context7\\s+setup\\b`).test(low)) reasons.push('sks_context7_setup_blocked');
  if (/(^|[\s;&|])npm\s+(?:remove|rm|uninstall)\s+[^;&|]*\bsneakoscope\b/.test(low)) reasons.push('sneakoscope_uninstall_blocked');
  if (/(^|[\s;&|])(?:pnpm|yarn)\s+(?:remove|uninstall)\s+[^;&|]*\bsneakoscope\b/.test(low)) reasons.push('sneakoscope_uninstall_blocked');
  return { block: reasons.length > 0, reasons };
}

function findProtectedMatches(root: any, strings: any, policy: any) {
  const rels = [...(policy.protected_files || HARNESS_STATIC_FILES), ...(policy.protected_dirs || HARNESS_STATIC_DIRS)];
  const matches = new Set();
  const normalizedTexts = strings.map((s: any) => String(s || '').replace(/\\/g, '/'));
  for (const rel of rels) {
    const normalizedRel = rel.replace(/\\/g, '/').replace(/\/$/, '');
    const abs = path.join(root, rel).replace(/\\/g, '/').replace(/\/$/, '');
    for (const text of normalizedTexts) {
      if (text.includes(normalizedRel) || text.includes(`./${normalizedRel}`) || text.includes(abs)) matches.add(rel);
    }
  }
  return [...matches].sort();
}

function toRel(root: any, file: any) {
  return path.relative(root, file).split(path.sep).join('/');
}
