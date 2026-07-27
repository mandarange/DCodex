/**
 * Report environment capture, scoring-code integrity and the report writer.
 *
 * Reading the git SHA and the dirty state is allowed here: this is the reporting
 * path, not the query hot path. The porcelain status text is hashed, never
 * stored, so the report records *that* the tree was dirty without recording what
 * was dirty.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { isLexicallyConfined } from '../../../managed-path-safety.js';
import { contextGraphBenchmarkReportPath } from '../paths.js';
import { scanForLeaks } from './floors.js';
import type {
  ContextGraphBenchmarkEnvironment,
  ContextGraphBenchmarkMachineProfile,
  ContextGraphBenchmarkReport
} from './types.js';

const EMPTY_FINGERPRINT = crypto.createHash('sha256').update('').digest('hex');

function gitOutput(root: string, args: readonly string[]): string | null {
  const result = spawnSync('git', [...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') return null;
  return result.stdout;
}

export function machineProfile(): ContextGraphBenchmarkMachineProfile {
  const cpus = os.cpus();
  const first = cpus[0];
  const nodeMajor = Number.parseInt(String(process.versions.node ?? '0').split('.')[0] ?? '0', 10);
  return {
    platform: process.platform,
    arch: process.arch,
    cpuCount: cpus.length,
    cpuModel: first ? String(first.model).trim() : 'unknown',
    totalMemoryMb: Math.round(os.totalmem() / (1024 * 1024)),
    nodeMajor: Number.isFinite(nodeMajor) ? nodeMajor : 0
  };
}

export function captureEnvironment(root: string): ContextGraphBenchmarkEnvironment {
  const sha = gitOutput(root, ['rev-parse', 'HEAD']);
  const branch = gitOutput(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = gitOutput(root, ['status', '--porcelain']);
  const machine = machineProfile();
  if (sha === null || status === null) {
    return {
      gitSha: sha === null ? null : sha.trim() || null,
      gitBranch: branch === null ? null : branch.trim() || null,
      gitState: 'unknown',
      dirtyFingerprint: EMPTY_FINGERPRINT,
      dirtyEntryCount: 0,
      machine
    };
  }
  const entries = status.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  return {
    gitSha: sha.trim() || null,
    gitBranch: branch === null ? null : branch.trim() || null,
    gitState: entries.length ? 'dirty' : 'clean',
    dirtyFingerprint: crypto.createHash('sha256').update(entries.sort().join('\n')).digest('hex'),
    dirtyEntryCount: entries.length,
    machine
  };
}

/**
 * Hash of the modules that decide the score. If a scorer edit lands without the
 * expected hash being updated, the runner reports an integrity failure instead of
 * publishing a quietly different number.
 */
export function computeScoringCodeHash(moduleDir: string): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(moduleDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const names = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => (name.endsWith('.ts') || name.endsWith('.js')) && !name.endsWith('.d.ts'))
    .sort();
  if (!names.length) return null;
  const digest = crypto.createHash('sha256');
  for (const name of names) {
    let content: Buffer;
    try {
      content = fs.readFileSync(path.join(moduleDir, name));
    } catch {
      return null;
    }
    digest.update(name);
    digest.update('\0');
    digest.update(crypto.createHash('sha256').update(content).digest('hex'));
    digest.update('\n');
  }
  return digest.digest('hex');
}

export function serializeReport(report: ContextGraphBenchmarkReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** Rule ids violated by the serialized report; empty means the report is safe to write. */
export function reportLeakRules(report: ContextGraphBenchmarkReport): string[] {
  const scan = scanForLeaks(JSON.stringify(report));
  return [...scan.secretRules, ...scan.pathRules].sort();
}

export interface WriteBenchmarkReportResult {
  readonly written: boolean;
  /** Workspace-relative POSIX path, never the absolute location. */
  readonly relativePath: string;
  readonly leakRules: readonly string[];
}

/**
 * Writes the report under the workspace artifact directory. Refuses to write when
 * the serialized report trips a leak rule: a leaking report must not be persisted.
 */
export function writeBenchmarkReport(
  root: string,
  report: ContextGraphBenchmarkReport,
  targetPath?: string
): WriteBenchmarkReportResult {
  const workspaceRoot = path.resolve(root);
  const reportDir = path.join(workspaceRoot, '.sneakoscope', 'reports');
  const absolute = targetPath
    ? path.resolve(workspaceRoot, targetPath)
    : path.resolve(contextGraphBenchmarkReportPath(workspaceRoot));
  const relativePath = path.relative(workspaceRoot, absolute).split(path.sep).join('/');
  if (!isLexicallyConfined(reportDir, absolute)) {
    return { written: false, relativePath, leakRules: ['benchmark_report_path_outside_workspace_reports'] };
  }
  const leakRules = reportLeakRules(report);
  if (leakRules.length) return { written: false, relativePath, leakRules };
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, serializeReport(report), 'utf8');
  return { written: true, relativePath, leakRules: [] };
}
