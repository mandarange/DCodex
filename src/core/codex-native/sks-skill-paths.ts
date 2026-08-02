import path from 'node:path';
import os from 'node:os';
import { constants as fsConstants } from 'node:fs';
import fsp from 'node:fs/promises';
import { sha256 } from '../fsx.js';
import { sksPrefixedSkillName } from '../routes/dollar-prefix.js';
import { inspectConfinedPath, ManagedPathSafetyError } from '../managed-path-safety.js';
import { buildSksCoreSkillManifest } from './core-skill-manifest.js';

export const AUTHORITATIVE_SKS_SKILL_ROOT_REFERENCE = '~/.agents/skills';

export type CodexSkillRootScope = 'global' | 'project' | 'codex-home';

export interface CodexSkillRoot {
  scope: CodexSkillRootScope;
  root: string;
}

export interface ResolvedSksSkillSource {
  requested_name: string;
  canonical_name: string;
  scope: 'global';
  root: string;
  path: string;
}

export type SksSkillSourceIssueReason =
  | 'unsafe_symlink'
  | 'not_regular_file'
  | CurrentSksManagedSkillContentStatus;

export interface SksSkillSourceIssue {
  requested_name: string;
  canonical_name: string;
  scope: 'global';
  root: string;
  path: string;
  reason: SksSkillSourceIssueReason;
  content_sha256: string | null;
}

export interface ManagedSkillDigestRecoveryAttempt {
  canonical_skill: string;
  original_path: string;
  old_digest: string | null;
  new_digest: string | null;
  status: 'healed' | 'blocked' | 'failed';
  reason: string;
  backup_path: string | null;
  rollback_path: string | null;
  journal_path: string | null;
}

export interface ManagedSkillDigestRecoveryReport {
  attempted: boolean;
  healed_count: number;
  attempts: ManagedSkillDigestRecoveryAttempt[];
}

export interface SksSkillSourceResolution {
  schema: 'sks.authoritative-skill-sources.v1';
  sources: ResolvedSksSkillSource[];
  unresolved: string[];
  blockers: string[];
  issues: SksSkillSourceIssue[];
  recovery?: ManagedSkillDigestRecoveryReport;
}

const CURRENT_SKS_SKILL_NAME_RE = /^sks(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

export type CurrentSksManagedSkillContentStatus =
  | 'current'
  | 'not_sks_managed'
  | 'canonical_name_mismatch'
  | 'authoritative_digest_missing'
  | 'content_digest_mismatch';

let packagedSkillDigestsPromise: Promise<Map<string, Set<string>>> | null = null;

export function currentSksSkillName(value: unknown): string {
  const name = sksPrefixedSkillName(value);
  return CURRENT_SKS_SKILL_NAME_RE.test(name) ? name : '';
}

export async function inspectCurrentSksManagedSkillContent(
  text: string,
  canonicalName: string,
  authoritativeDigests?: ReadonlyMap<string, ReadonlySet<string>>
): Promise<{ status: CurrentSksManagedSkillContentStatus; content_sha256: string }> {
  const contentSha256 = sha256(text);
  if (!/BEGIN SKS (?:IMMUTABLE CORE|MANAGED) SKILL/.test(text)) {
    return { status: 'not_sks_managed', content_sha256: contentSha256 };
  }
  const declaredName = String(text.match(/^name:\s*([^\n\r]+)/m)?.[1] || '').trim().replace(/^["']|["']$/g, '');
  if (currentSksSkillName(declaredName) !== canonicalName) {
    return { status: 'canonical_name_mismatch', content_sha256: contentSha256 };
  }
  const expected = authoritativeDigests?.get(canonicalName)
    || (await currentPackagedSksSkillDigests()).get(canonicalName);
  if (!expected?.size) return { status: 'authoritative_digest_missing', content_sha256: contentSha256 };
  return {
    status: expected.has(contentSha256) ? 'current' : 'content_digest_mismatch',
    content_sha256: contentSha256
  };
}

export function currentCodexSkillRoots(input: {
  root: string;
  home?: string;
  codexHome?: string;
}): CodexSkillRoot[] {
  const projectRoot = path.resolve(input.root);
  const home = path.resolve(input.home || process.env.HOME || os.homedir());
  const codexHome = path.resolve(input.codexHome || process.env.CODEX_HOME || path.join(home, '.codex'));
  return uniqueSkillRoots([
    { scope: 'global', root: path.join(home, '.agents', 'skills') },
    { scope: 'project', root: path.join(projectRoot, '.agents', 'skills') },
    { scope: 'codex-home', root: path.join(codexHome, 'skills') }
  ]);
}

export async function resolveAuthoritativeSksSkillSources(input: {
  root: string;
  skillNames: readonly unknown[];
  home?: string;
  codexHome?: string;
}): Promise<SksSkillSourceResolution> {
  return resolveAuthoritativeSksSkillSourcesReadOnly(input);
}

async function resolveAuthoritativeSksSkillSourcesReadOnly(input: {
  root: string;
  skillNames: readonly unknown[];
  home?: string;
  codexHome?: string;
}): Promise<SksSkillSourceResolution> {
  const home = path.resolve(input.home || process.env.HOME || os.homedir());
  const requested = Array.from(new Set(input.skillNames
    .map((name) => String(name || '').trim())
    .filter(Boolean)));
  const roots = currentCodexSkillRoots({ ...input, home }).filter((entry) => entry.scope === 'global') as Array<{
    scope: 'global';
    root: string;
  }>;
  const sources: ResolvedSksSkillSource[] = [];
  const unresolved: string[] = [];
  const blockers: string[] = [];
  const issues: SksSkillSourceIssue[] = [];
  const authoritativeDigests = await currentPackagedSksSkillDigests();

  for (const requestedName of requested) {
    const canonicalName = currentSksSkillName(requestedName);
    if (!canonicalName) {
      blockers.push('invalid_managed_skill_name');
      continue;
    }
    let source: ResolvedSksSkillSource | null = null;
    let unsafe = false;
    for (const root of roots) {
      const candidate = confinedManagedSkillFile(root.root, canonicalName);
      if (!candidate) {
        blockers.push(`managed_skill_path_outside_root:${canonicalName}:${root.scope}`);
        unsafe = true;
        break;
      }
      const inspection = await inspectManagedSkillFile(
        home,
        candidate,
        canonicalName,
        authoritativeDigests
      );
      if (inspection.status === 'missing') continue;
      if (inspection.status !== 'current') {
        blockers.push(`${inspection.status}:${canonicalName}:${root.scope}`);
        issues.push({
          requested_name: requestedName,
          canonical_name: canonicalName,
          scope: root.scope,
          root: root.root,
          path: candidate,
          reason: inspection.status,
          content_sha256: 'content_sha256' in inspection ? inspection.content_sha256 : null
        });
        unsafe = true;
        break;
      }
      source = {
        requested_name: requestedName,
        canonical_name: canonicalName,
        scope: root.scope,
        root: root.root,
        path: candidate
      };
      break;
    }
    if (source) sources.push(source);
    else {
      unresolved.push(canonicalName);
      if (unsafe) continue;
    }
  }

  return {
    schema: 'sks.authoritative-skill-sources.v1',
    sources,
    unresolved: Array.from(new Set(unresolved)).sort(),
    blockers: Array.from(new Set(blockers)).sort(),
    issues: issues.sort((left, right) => (
      left.canonical_name.localeCompare(right.canonical_name)
      || left.path.localeCompare(right.path)
    ))
  };
}

export async function authoritativeSksSkillContext(input: {
  root: string;
  skillNames: readonly unknown[];
  home?: string;
  codexHome?: string;
}): Promise<string> {
  const resolution = await resolveAuthoritativeSksSkillSources(input);
  return renderAuthoritativeSksSkillContext(resolution);
}

export function renderAuthoritativeSksSkillContext(resolution: SksSkillSourceResolution): string {
  if (!resolution.sources.length && !resolution.unresolved.length && !resolution.blockers.length) return '';
  const lines = [
    'Authoritative SKS skill sources for this turn:',
    ...resolution.sources.map((source) => `- ${source.canonical_name}: ${JSON.stringify(source.path)}`)
  ];
  if (resolution.unresolved.length) {
    lines.push(`- unresolved current managed skills: ${resolution.unresolved.join(', ')}`);
  }
  if (resolution.blockers.length) {
    lines.push(`- unsafe managed-skill candidates rejected: ${resolution.blockers.join(', ')}`);
  }
  for (const issue of resolution.issues || []) {
    const recovery = resolution.recovery?.attempts.find((attempt) => (
      attempt.canonical_skill === issue.canonical_name
      && attempt.original_path === issue.path
    ));
    lines.push(
      `- rejected managed-skill file: ${JSON.stringify(issue.path)}; canonical=${issue.canonical_name}; reason=${issue.reason}`
      + (recovery
        ? `; recovery=${recovery.backup_path ? JSON.stringify(recovery.backup_path) : 'none'}; heal_status=${recovery.status}:${recovery.reason}`
        : '; recovery=none')
    );
  }
  lines.push(
    'These existing current files override stale project-local, .codex/skills, plugin-cache, picker, pre-compaction, and prior-message paths for the listed managed SKS skills.',
    'Read the resolved file directly. After a successful remap, continue silently and do not report a skill-path mismatch to the user. Never guess a path for an unresolved or rejected skill.',
    'For an unresolved skill, do not mention an old or stale path mismatch; report only that the current managed SKS skill is unavailable if it actually blocks the task.'
  );
  return lines.join('\n');
}

function confinedManagedSkillFile(skillsRoot: string, canonicalName: string): string | null {
  const root = path.resolve(skillsRoot);
  const candidate = path.resolve(root, canonicalName, 'SKILL.md');
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) return null;
  return candidate;
}

async function inspectManagedSkillFile(
  homeBoundary: string,
  file: string,
  canonicalName: string,
  authoritativeDigests: ReadonlyMap<string, ReadonlySet<string>>
): Promise<
  | { status: 'missing' | 'unsafe_symlink' | 'not_regular_file' }
  | { status: CurrentSksManagedSkillContentStatus; content_sha256: string }
> {
  let inspected;
  try {
    inspected = await inspectConfinedPath(homeBoundary, file);
  } catch (error: unknown) {
    if (error instanceof ManagedPathSafetyError) {
      if (error.code === 'managed_path_boundary_missing') return { status: 'missing' };
      if (error.code.includes('symlink')) return { status: 'unsafe_symlink' };
      return { status: 'not_regular_file' };
    }
    throw error;
  }
  if (!inspected.exists) return { status: 'missing' };
  if (inspected.leafSymlink) return { status: 'unsafe_symlink' };
  if (!inspected.stat?.isFile()) return { status: 'not_regular_file' };
  let handle;
  try {
    handle = await fsp.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error: unknown) {
    const code = filesystemErrorCode(error);
    if (code === 'ENOENT') return { status: 'missing' };
    if (code === 'ELOOP') return { status: 'unsafe_symlink' };
    return { status: 'not_regular_file' };
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) return { status: 'not_regular_file' };
    const text = await handle.readFile('utf8');
    const after = await handle.stat();
    if (!sameStableFileSnapshot(before, after)) return { status: 'not_regular_file' };
    const finalInspection = await inspectConfinedPath(homeBoundary, file);
    if (!finalInspection.exists) return { status: 'missing' };
    if (finalInspection.leafSymlink) return { status: 'unsafe_symlink' };
    if (!finalInspection.stat?.isFile()
      || finalInspection.stat.dev !== after.dev
      || finalInspection.stat.ino !== after.ino) {
      return { status: 'not_regular_file' };
    }
    return inspectCurrentSksManagedSkillContent(text, canonicalName, authoritativeDigests);
  } catch (error: unknown) {
    const code = filesystemErrorCode(error);
    if (code === 'ENOENT') return { status: 'missing' };
    if (code === 'ELOOP') return { status: 'unsafe_symlink' };
    return { status: 'not_regular_file' };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function sameStableFileSnapshot(
  left: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number },
  right: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function filesystemErrorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : '';
}

async function currentPackagedSksSkillDigests(): Promise<Map<string, Set<string>>> {
  if (!packagedSkillDigestsPromise) {
    packagedSkillDigestsPromise = loadCurrentPackagedSksSkillDigests();
  }
  const work = packagedSkillDigestsPromise;
  try {
    return await work;
  } finally {
    // Development builds can replace the packaged manifest while the hook
    // daemon remains alive. Keep only an in-flight dedupe, never a
    // process-lifetime digest snapshot.
    if (packagedSkillDigestsPromise === work) packagedSkillDigestsPromise = null;
  }
}

async function loadCurrentPackagedSksSkillDigests(): Promise<Map<string, Set<string>>> {
  const digests = new Map<string, Set<string>>();
  const add = (nameValue: unknown, digestValue: unknown) => {
    const name = currentSksSkillName(nameValue);
    const digest = String(digestValue || '').trim().toLowerCase();
    if (!name || !SHA256_RE.test(digest)) return;
    const current = digests.get(name) || new Set<string>();
    current.add(digest);
    digests.set(name, current);
  };
  for (const skill of buildSksCoreSkillManifest('1970-01-01T00:00:00.000Z').skills) {
    add(skill.canonical_name, skill.content_sha256);
  }
  const manifest = await import('../init/skills.js')
    .then(({ loadBundledSkillsManifest }) => loadBundledSkillsManifest())
    .catch(() => null);
  for (const skill of manifest?.skills || []) add(skill?.canonical_name, skill?.content_sha256);
  return digests;
}

function uniqueSkillRoots(roots: CodexSkillRoot[]): CodexSkillRoot[] {
  const unique = new Map<string, CodexSkillRoot>();
  for (const entry of roots) {
    const resolved = path.resolve(entry.root);
    if (!unique.has(resolved)) unique.set(resolved, { ...entry, root: resolved });
  }
  return [...unique.values()];
}
