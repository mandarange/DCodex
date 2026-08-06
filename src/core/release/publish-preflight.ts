import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeReleaseOrigin, RELEASE_ORIGIN_IDENTITY } from './release-origin.js';
import { validatePhysicalReleaseGateInspection } from './physical-release-gates.js';

export interface PublishPreflightCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface PublishPreflightOptions {
  root: string;
  run?: (command: string, args: string[], cwd: string) => PublishPreflightCommandResult;
  /** Real publication requires the exact local and remote tag; a dry-run does not mutate the registry. */
  requireReleaseTag?: boolean;
  /**
   * Opt-in for environment-bound callers. Real publication callers must pass true;
   * non-mutating dry runs may leave this false while collecting local package proof.
   */
  requirePhysicalReleaseGates?: boolean;
}

export function inspectPublishPreflight(options: PublishPreflightOptions) {
  const root = path.resolve(options.root);
  const run = options.run || runCommand;
  const requireReleaseTag = options.requireReleaseTag !== false;
  const requirePhysicalReleaseGates = options.requirePhysicalReleaseGates === true;
  const blockers: string[] = [];
  const pkg = readPackageJson(root, blockers);
  const version = typeof pkg?.version === 'string' ? pkg.version : '';
  if (!validExactVersion(version)) blockers.push('package_version_invalid');

  const topLevel = commandText(run, 'git', ['rev-parse', '--show-toplevel'], root);
  if (!topLevel || canonical(topLevel) !== canonical(root)) blockers.push('publish_root_not_git_toplevel');

  const branch = commandText(run, 'git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], root);
  if (branch !== 'main') blockers.push(branch ? `publish_requires_main_branch:${branch}` : 'publish_requires_main_branch:detached');

  const status = run('git', ['status', '--porcelain=v1', '--untracked-files=all'], root);
  if (status.status !== 0) blockers.push('worktree_status_unavailable');
  else if (String(status.stdout || '').trim()) blockers.push('worktree_not_clean');

  const head = commandText(run, 'git', ['rev-parse', 'HEAD'], root);
  if (!validSha(head)) blockers.push('head_sha_unavailable');

  const originUrl = commandText(run, 'git', ['remote', 'get-url', 'origin'], root);
  const originIdentity = normalizeReleaseOrigin(originUrl);
  if (originIdentity !== RELEASE_ORIGIN_IDENTITY) blockers.push(`origin_identity_mismatch:${originIdentity || 'missing'}`);

  const remoteMainResult = run('git', ['ls-remote', '--exit-code', 'origin', 'refs/heads/main'], root);
  const remoteMain = remoteMainResult.status === 0 ? remoteRefSha(remoteMainResult.stdout, 'refs/heads/main') : '';
  if (!validSha(remoteMain)) blockers.push('origin_main_remote_unavailable');
  else if (head && remoteMain !== head) blockers.push(`head_not_origin_main:${remoteMain}`);

  const releaseTag = validExactVersion(version) ? `v${version}` : null;
  let localTag = '';
  let remoteTag = '';
  if (releaseTag && requireReleaseTag) {
    localTag = commandText(run, 'git', ['rev-parse', `refs/tags/${releaseTag}^{commit}`], root);
    if (!validSha(localTag)) blockers.push(`release_tag_missing:${releaseTag}`);
    else if (head && localTag !== head) blockers.push(`release_tag_not_head:${releaseTag}`);

    const remoteTagResult = run('git', ['ls-remote', '--exit-code', 'origin', `refs/tags/${releaseTag}`, `refs/tags/${releaseTag}^{}`], root);
    remoteTag = remoteTagResult.status === 0 ? remoteReleaseTagSha(remoteTagResult.stdout, releaseTag) : '';
    if (!validSha(remoteTag)) blockers.push(`remote_release_tag_missing:${releaseTag}`);
    else if (head && remoteTag !== head) blockers.push(`remote_release_tag_not_head:${releaseTag}`);
  }

  const physicalReleaseGates = requirePhysicalReleaseGates
    ? validatePhysicalReleaseGateInspection({
        root,
        version,
        sourceCommit: validSha(head) ? head : '',
      })
    : null;
  if (physicalReleaseGates && !physicalReleaseGates.ok) {
    blockers.push(...physicalReleaseGates.blockers);
  }

  return {
    schema: 'sks.publish-preflight.v1',
    ok: blockers.length === 0,
    package_name: typeof pkg?.name === 'string' ? pkg.name : null,
    package_version: version || null,
    release_tag: releaseTag,
    release_tag_required: requireReleaseTag,
    physical_release_gates_required: requirePhysicalReleaseGates,
    physical_release_gates: physicalReleaseGates,
    branch: branch || null,
    head: validSha(head) ? head : null,
    origin_identity: originIdentity || null,
    origin_main: validSha(remoteMain) ? remoteMain : null,
    local_release_tag_commit: validSha(localTag) ? localTag : null,
    remote_release_tag_commit: validSha(remoteTag) ? remoteTag : null,
    clean_tree: status.status === 0 && !String(status.stdout || '').trim(),
    checked_at: new Date().toISOString(),
    blockers: [...new Set(blockers)],
  };
}

function readPackageJson(root: string, blockers: string[]): any {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    blockers.push('package_json_unavailable');
    return null;
  }
}

function runCommand(command: string, args: string[], cwd: string): PublishPreflightCommandResult {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
}

function commandText(run: NonNullable<PublishPreflightOptions['run']>, command: string, args: string[], cwd: string): string {
  const result = run(command, args, cwd);
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}

function remoteRefSha(output: string, ref: string): string {
  for (const line of String(output || '').split(/\r?\n/)) {
    const [sha, name] = line.trim().split(/\s+/, 2);
    if (name === ref && validSha(sha || '')) return sha || '';
  }
  return '';
}

function remoteReleaseTagSha(output: string, tag: string): string {
  return remoteRefSha(output, `refs/tags/${tag}^{}`) || remoteRefSha(output, `refs/tags/${tag}`);
}

function validExactVersion(value: string): boolean {
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value);
}

function validSha(value: string): boolean {
  return /^[a-f0-9]{40}$/i.test(value);
}

function canonical(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}
