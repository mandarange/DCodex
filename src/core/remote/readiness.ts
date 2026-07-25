import fsp from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PACKAGE_VERSION, exists, runProcess, which } from '../fsx.js';
import { resolveAllowedProjectRoot } from './machine-registry.js';
import { REMOTE_READINESS_SCHEMA, type RemoteMachineV1, type RemoteReadinessV1 } from './types.js';
import { asRecordOrNull as asRecord } from '../json/records.js';

interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RemoteReadinessDependencies {
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
  readonly packageVersion?: string;
  readonly findExecutable?: (command: string) => Promise<string | null>;
  readonly pathExists?: (file: string) => Promise<boolean>;
  readonly run?: (command: string, args: readonly string[], cwd?: string) => Promise<CommandResult>;
  readonly probeMcp?: (codexCliPath: string | null, cwd: string) => Promise<{ effective_count: number; failed_count: number }>;
  readonly proofSurfacesReady?: (root: string) => Promise<boolean>;
  readonly awakeHint?: () => Promise<string | null>;
  readonly resolveAllowedRoot?: (machine: RemoteMachineV1, root: string) => Promise<string>;
}

export interface RemoteReadinessOptions {
  readonly root: string;
  readonly machine?: RemoteMachineV1 | null;
  readonly dependencies?: RemoteReadinessDependencies;
}

export async function remoteReadiness(options: RemoteReadinessOptions): Promise<RemoteReadinessV1> {
  const root = path.resolve(options.root);
  const deps = dependencies(options.dependencies);
  const blockers: string[] = [];
  const warnings: string[] = [];
  const codexCliPath = await deps.findExecutable('codex');
  const appCandidates = codexAppCandidates(deps.platform, deps.homeDir);
  const codexAppFound = (await Promise.all(appCandidates.map((candidate) => deps.pathExists(candidate)))).some(Boolean);
  const git = await probeGit(root, deps.run);
  const allowed = options.machine
    ? await deps.resolveAllowedRoot(options.machine, root).then(() => true).catch(() => false)
    : true;
  if (!options.machine) warnings.push('ssh_machine_allowlist_not_checked');
  const mcp = await deps.probeMcp(codexCliPath, root).catch(() => ({ effective_count: 0, failed_count: 1 }));
  const proofReady = await deps.proofSurfacesReady(root);

  if (!codexAppFound) blockers.push('codex_app_not_found');
  if (!codexCliPath) blockers.push('codex_cli_not_found');
  if (!git.git_repo) blockers.push('project_not_git_repo');
  if (!allowed) blockers.push('project_root_not_allowlisted');
  if (mcp.failed_count > 0) blockers.push('mcp_health_failed');
  if (!proofReady) blockers.push('sks_proof_surfaces_not_ready');
  if (git.branch === null && git.git_repo) warnings.push('git_detached_head');
  if (git.dirty) warnings.push('git_worktree_dirty');

  return {
    schema: REMOTE_READINESS_SCHEMA,
    ok: blockers.length === 0,
    host: {
      platform: deps.platform,
      awake_hint: await deps.awakeHint(),
      codex_app_found: codexAppFound,
      codex_cli_found: codexCliPath !== null,
      codex_cli_path: codexCliPath
    },
    project: {
      root,
      git_repo: git.git_repo,
      branch: git.branch,
      dirty: git.dirty,
      worktree: git.worktree,
      allowed
    },
    mcp,
    sks: {
      version: deps.packageVersion,
      proof_surfaces_ready: proofReady
    },
    blockers,
    warnings
  };
}

function dependencies(input: RemoteReadinessDependencies = {}): Required<RemoteReadinessDependencies> {
  const platform = input.platform ?? process.platform;
  return {
    platform,
    homeDir: input.homeDir ?? os.homedir(),
    packageVersion: input.packageVersion ?? PACKAGE_VERSION,
    findExecutable: input.findExecutable ?? which,
    pathExists: input.pathExists ?? exists,
    run: input.run ?? defaultRun,
    probeMcp: input.probeMcp ?? defaultMcpProbe,
    proofSurfacesReady: input.proofSurfacesReady ?? defaultProofSurfacesReady,
    awakeHint: input.awakeHint ?? (() => defaultAwakeHint(platform)),
    resolveAllowedRoot: input.resolveAllowedRoot ?? resolveAllowedProjectRoot
  };
}

async function probeGit(root: string, run: Required<RemoteReadinessDependencies>['run']): Promise<{
  git_repo: boolean;
  branch: string | null;
  dirty: boolean;
  worktree: boolean;
}> {
  const inside = await run('git', ['rev-parse', '--is-inside-work-tree'], root).catch(() => null);
  const gitRepo = inside?.code === 0 && inside.stdout.trim() === 'true';
  if (!gitRepo) return { git_repo: false, branch: null, dirty: false, worktree: false };
  const [branchResult, statusResult, dotGit] = await Promise.all([
    run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], root).catch(() => null),
    run('git', ['status', '--porcelain=v1', '--untracked-files=normal'], root).catch(() => null),
    fsp.lstat(path.join(root, '.git')).catch(() => null)
  ]);
  const branchValue = branchResult?.code === 0 ? branchResult.stdout.trim() : '';
  return {
    git_repo: true,
    branch: branchValue && branchValue !== 'HEAD' ? branchValue : null,
    dirty: statusResult?.code !== 0 || Boolean(statusResult?.stdout.trim()),
    worktree: dotGit?.isFile() === true
  };
}

async function defaultMcpProbe(codexCliPath: string | null, cwd: string): Promise<{ effective_count: number; failed_count: number }> {
  if (!codexCliPath) return { effective_count: 0, failed_count: 0 };
  const result = await defaultRun(codexCliPath, ['mcp', 'list', '--json'], cwd);
  if (result.code !== 0) return { effective_count: 0, failed_count: 1 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { effective_count: 0, failed_count: 1 };
  }
  const rows = Array.isArray(parsed) ? parsed : [];
  const enabled = rows.filter((row) => asRecord(row)?.enabled === true);
  const failed = enabled.filter((row) => {
    const record = asRecord(row);
    const authStatus = String(record?.auth_status ?? '').toLowerCase();
    return Boolean(record?.disabled_reason) || /failed|error|invalid/.test(authStatus);
  });
  return { effective_count: enabled.length, failed_count: failed.length };
}

async function defaultProofSurfacesReady(root: string): Promise<boolean> {
  const sine = path.join(root, '.sneakoscope');
  const stat = await fsp.lstat(sine).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return false;
  return fsp.access(sine, fsConstants.R_OK).then(() => true).catch(() => false);
}

async function defaultAwakeHint(platform: NodeJS.Platform): Promise<string | null> {
  if (platform !== 'darwin') return null;
  const result = await defaultRun('pmset', ['-g', 'assertions']).catch(() => null);
  if (!result || result.code !== 0) return null;
  return /PreventSystemSleep\s+1|PreventUserIdleSystemSleep\s+1/.test(result.stdout)
    ? 'sleep_prevention_assertion_present'
    : 'no_sleep_prevention_assertion_detected';
}

async function defaultRun(command: string, args: readonly string[], cwd?: string): Promise<CommandResult> {
  const options: { cwd?: string; timeoutMs: number; maxOutputBytes: number } = { timeoutMs: 10_000, maxOutputBytes: 1024 * 1024 };
  if (cwd !== undefined) options.cwd = cwd;
  const result = await runProcess(command, [...args], options);
  return { code: result.code, stdout: result.stdout, stderr: result.stderr };
}

function codexAppCandidates(platform: NodeJS.Platform, homeDir: string): string[] {
  if (platform !== 'darwin') return [];
  return [
    '/Applications/Codex.app',
    '/Applications/ChatGPT.app',
    path.join(homeDir, 'Applications', 'Codex.app'),
    path.join(homeDir, 'Applications', 'ChatGPT.app')
  ];
}
