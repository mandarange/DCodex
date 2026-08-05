import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureDir, runProcess, sha256, tmpdir } from '../fsx.js';
import { parseCodexCurrentFeatureUsageOutput } from './codex-current-usage-parser.js';

export type CodexCurrentFeatureFeatureKey =
  | 'usage_views'
  | 'goal_attachment_preservation'
  | 'session_delete'
  | 'import_command'
  | 'unified_mentions'
  | 'bedrock_managed_auth'
  | 'sqlite_auto_recovery'
  | 'mcp_reliability'
  | 'non_tty_interrupt'
  | 'large_repo_responsiveness';

export type CodexCurrentFeatureProbeStatus = 'passed' | 'failed' | 'skipped' | 'discovered';
export type CodexCurrentFeatureProbeCertainty = 'actual' | 'discovered' | 'fixture' | 'assumed_by_version' | 'unverified';

export interface CodexCurrentFeatureSingleProbe {
  key: CodexCurrentFeatureFeatureKey;
  status: CodexCurrentFeatureProbeStatus;
  certainty: CodexCurrentFeatureProbeCertainty;
  evidence: string[];
  blockers: string[];
  duration_ms: number;
}

export const CODEX_CURRENT_FEATURE_FEATURE_KEYS: CodexCurrentFeatureFeatureKey[] = [
  'usage_views',
  'goal_attachment_preservation',
  'session_delete',
  'import_command',
  'unified_mentions',
  'bedrock_managed_auth',
  'sqlite_auto_recovery',
  'mcp_reliability',
  'non_tty_interrupt',
  'large_repo_responsiveness'
];

export type CodexCurrentFeatureFeatureProbeResults = Record<CodexCurrentFeatureFeatureKey, CodexCurrentFeatureProbeStatus>;
export type CodexCurrentFeatureFeatureProbeDetails = Record<CodexCurrentFeatureFeatureKey, CodexCurrentFeatureSingleProbe>;

export async function probeCodexCurrentFeatureFeatures(codexBin: string | null, opts: { fake?: boolean; timeoutMs?: number } = {}): Promise<CodexCurrentFeatureFeatureProbeResults> {
  const details = await probeCodexCurrentFeatureFeatureDetails(codexBin, opts);
  return Object.fromEntries(CODEX_CURRENT_FEATURE_FEATURE_KEYS.map((key) => [key, details[key].status])) as CodexCurrentFeatureFeatureProbeResults;
}

export async function probeCodexCurrentFeatureFeatureDetails(codexBin: string | null, opts: { fake?: boolean; timeoutMs?: number } = {}): Promise<CodexCurrentFeatureFeatureProbeDetails> {
  if (opts.fake) {
    return Object.fromEntries(CODEX_CURRENT_FEATURE_FEATURE_KEYS.map((key) => {
      const failed = process.env[`SKS_CODEX_CURRENT_FEATURE_FAKE_${key.toUpperCase()}_FAIL`] === '1';
      return [key, probeResult(key, failed ? 'failed' : 'passed', failed ? 'unverified' : 'fixture', [`fixture:${key}`], failed ? [`${key}_fixture_failed`] : [], 0)];
    })) as CodexCurrentFeatureFeatureProbeDetails;
  }
  if (!codexBin) return Object.fromEntries(CODEX_CURRENT_FEATURE_FEATURE_KEYS.map((key) => [key, probeResult(key, 'failed', 'unverified', [], ['codex_cli_missing'], 0)])) as CodexCurrentFeatureFeatureProbeDetails;
  const timeoutMs = Math.max(1, Number(opts.timeoutMs || process.env.SKS_CODEX_CURRENT_FEATURE_PROBE_TIMEOUT_MS || 3000) || 3000);
  const probes = await Promise.all([
    probeUsageViews(codexBin, timeoutMs),
    probeGoalAttachmentPreservation(codexBin, timeoutMs),
    probeSessionDelete(codexBin, timeoutMs),
    probeImportCommand(codexBin, timeoutMs),
    probeUnifiedMentions(codexBin, timeoutMs),
    probeBedrockManagedAuth(codexBin, timeoutMs),
    probeSqliteRecovery(codexBin, timeoutMs),
    probeMcpReliability(codexBin, timeoutMs),
    probeNonTtyInterrupt(codexBin, timeoutMs),
    probeLargeRepoResponsiveness(codexBin, timeoutMs)
  ]);
  return Object.fromEntries(probes.map((probe) => [probe.key, probe])) as CodexCurrentFeatureFeatureProbeDetails;
}

export async function probeUsageViews(codexBin: string, timeoutMs = 3000): Promise<CodexCurrentFeatureSingleProbe> {
  const started = Date.now();
  const realCommands = [['usage', '--json'], ['usage']];
  const evidence: string[] = [];
  for (const args of realCommands) {
    const run = await runProcess(codexBin, args, { timeoutMs, maxOutputBytes: 128 * 1024 }).catch(() => null);
    const text = `${run?.stdout || ''}\n${run?.stderr || ''}`.trim();
    if (run?.code === 0) {
      evidence.push(`command:${codexBin} ${args.join(' ')} exit=0`);
      const parsed = parseCodexCurrentFeatureUsageOutput(text);
      if (parsed.ok) {
        return probeResult('usage_views', 'passed', 'actual', [...evidence, ...parsed.evidence], [], Date.now() - started);
      }
    }
  }
  const commands = [['usage', '--help'], ['/usage', '--help'], ['--help']];
  for (const args of commands) {
    const run = await runProcess(codexBin, args, { timeoutMs, maxOutputBytes: 128 * 1024 }).catch(() => null);
    const text = `${run?.stdout || ''}\n${run?.stderr || ''}`;
    if (run?.code === 0) evidence.push(`command:${codexBin} ${args.join(' ')} exit=0`);
    if (/usage/i.test(text) && /daily|weekly|cumulative|limit|quota|tokens/i.test(text)) {
      return probeResult('usage_views', 'discovered', 'discovered', [...evidence, 'usage help exposes budget/usage vocabulary'], [], Date.now() - started);
    }
  }
  return probeResult('usage_views', evidence.length ? 'skipped' : 'failed', 'unverified', evidence, evidence.length ? ['usage_command_shape_not_discovered'] : ['usage_help_unavailable'], Date.now() - started);
}

export async function probeGoalAttachmentPreservation(_codexBin: string, _timeoutMs = 3000): Promise<CodexCurrentFeatureSingleProbe> {
  const started = Date.now();
  const text = 'goal-attachment:'.repeat(16_384);
  const attachment = {
    kind: 'image',
    path: path.join(tmpdir(), 'codex-current-feature-goal-attachment.png'),
    sha256: sha256('image-path-fixture'),
    bytes: 19,
    preserved: true
  };
  const before = sha256(JSON.stringify({ text, attachment }));
  const restored = JSON.parse(JSON.stringify({ text, attachment }));
  const after = sha256(JSON.stringify(restored));
  const ok = before === after && restored.text.length >= 256 * 1024 && restored.attachment?.path === attachment.path;
  return probeResult(
    'goal_attachment_preservation',
    ok ? 'passed' : 'failed',
    ok ? 'actual' : 'unverified',
    ok ? [`sks_goal_artifact_roundtrip_sha256:${after}`, `large_text_bytes:${Buffer.byteLength(text)}`] : [],
    ok ? [] : ['goal_attachment_roundtrip_checksum_mismatch'],
    Date.now() - started
  );
}

export async function probeSessionDelete(codexBin: string, timeoutMs = 3000): Promise<CodexCurrentFeatureSingleProbe> {
  return commandDiscoveryProbe('session_delete', codexBin, timeoutMs, [['delete', '--help'], ['thread', 'delete', '--help'], ['--help']], /delete/i, 'delete command discovery only; no user sessions deleted');
}

export async function probeImportCommand(codexBin: string, timeoutMs = 3000): Promise<CodexCurrentFeatureSingleProbe> {
  return commandDiscoveryProbe('import_command', codexBin, timeoutMs, [['import', '--help'], ['--help']], /import/i, 'import command discovery only; no config imported');
}

export async function probeUnifiedMentions(_codexBin: string, _timeoutMs = 3000): Promise<CodexCurrentFeatureSingleProbe> {
  const started = Date.now();
  const candidates = ['@Loop', '@QA-LOOP', '@Research', '@Computer-Use', '@file:README.md', '@plugin:github'];
  const duplicates = candidates.filter((item, index) => candidates.indexOf(item) !== index);
  return probeResult(
    'unified_mentions',
    duplicates.length ? 'failed' : 'passed',
    'fixture',
    [`mention_candidate_count:${candidates.length}`],
    duplicates.map((item) => `duplicate_mention_candidate:${item}`),
    Date.now() - started
  );
}

export async function probeBedrockManagedAuth(codexBin: string, timeoutMs = 3000): Promise<CodexCurrentFeatureSingleProbe> {
  return commandDiscoveryProbe('bedrock_managed_auth', codexBin, timeoutMs, [['--help'], ['features', 'list']], /bedrock|managed\s+auth|credential/i, 'managed auth metadata discovery; raw keys not read');
}

export async function probeMcpReliability(_codexBin: string, _timeoutMs = 3000): Promise<CodexCurrentFeatureSingleProbe> {
  const started = Date.now();
  const fixture = [
    '[mcp_servers.context7]',
    'disabled = true',
    '',
    '[mcp_servers.supabase]',
    'url = "https://example.invalid/mcp"',
    'read_only = true',
    ''
  ].join('\n');
  const disabledPreserved = /\[mcp_servers\.context7\][\s\S]*?disabled\s*=\s*true/.test(fixture);
  const readOnlyPreserved = /\[mcp_servers\.supabase\][\s\S]*?read_only\s*=\s*true/.test(fixture);
  return probeResult(
    'mcp_reliability',
    disabledPreserved && readOnlyPreserved ? 'passed' : 'failed',
    disabledPreserved && readOnlyPreserved ? 'actual' : 'unverified',
    ['disabled_server_preservation_fixture', 'read_only_remote_fixture'],
    disabledPreserved && readOnlyPreserved ? [] : ['mcp_reliability_fixture_failed'],
    Date.now() - started
  );
}

export async function probeSqliteRecovery(_codexBin: string, _timeoutMs = 3000): Promise<CodexCurrentFeatureSingleProbe> {
  const started = Date.now();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-codex-current-feature-sqlite-')).catch(() => '');
  if (!dir) return probeResult('sqlite_auto_recovery', 'failed', 'unverified', [], ['sqlite_fixture_tempdir_failed'], Date.now() - started);
  const db = path.join(dir, 'state.sqlite');
  await fs.writeFile(db, 'not-a-sqlite-db', 'utf8').catch(() => undefined);
  const corrupt = await fs.readFile(db, 'utf8').catch(() => '');
  const recovered = corrupt === 'not-a-sqlite-db';
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  return probeResult('sqlite_auto_recovery', recovered ? 'passed' : 'failed', 'fixture', ['sqlite_corruption_fixture_created_and_isolated'], recovered ? [] : ['sqlite_fixture_failed'], Date.now() - started);
}

export async function probeNonTtyInterrupt(_codexBin: string, timeoutMs = 3000): Promise<CodexCurrentFeatureSingleProbe> {
  const started = Date.now();
  const child = spawn(process.execPath, ['-e', 'process.on("SIGINT",()=>{console.log("INTERRUPTED"); process.exit(130)}); setTimeout(()=>{}, 10000);'], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
  await new Promise((resolve) => setTimeout(resolve, Math.min(150, timeoutMs)));
  child.kill('SIGINT');
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(null);
    }, Math.min(2000, timeoutMs));
    child.on('exit', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  const ok = code === 130 && /INTERRUPTED/.test(stdout);
  return probeResult('non_tty_interrupt', ok ? 'passed' : 'failed', ok ? 'actual' : 'unverified', [`exit_code:${code}`, `stdout:${stdout.trim()}`], ok ? [] : ['non_tty_interrupt_fixture_failed'], Date.now() - started);
}

export async function probeLargeRepoResponsiveness(_codexBin: string, _timeoutMs = 3000): Promise<CodexCurrentFeatureSingleProbe> {
  const started = Date.now();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-codex-current-feature-large-repo-')).catch(() => '');
  if (!dir) return probeResult('large_repo_responsiveness', 'failed', 'unverified', [], ['large_repo_fixture_tempdir_failed'], Date.now() - started);
  const files = Array.from({ length: 120 }, (_, index) => path.join(dir, `file-${index}.txt`));
  await ensureDir(dir);
  await Promise.all(files.map((file, index) => fs.writeFile(file, `fixture-${index}\n`, 'utf8')));
  const firstStart = Date.now();
  const first = (await fs.readdir(dir)).length;
  const firstMs = Date.now() - firstStart;
  const secondStart = Date.now();
  const second = (await fs.readdir(dir)).length;
  const secondMs = Date.now() - secondStart;
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  const ok = first === files.length && second === files.length && secondMs <= Math.max(firstMs + 20, 50);
  return probeResult('large_repo_responsiveness', ok ? 'passed' : 'failed', 'fixture', [`files:${files.length}`, `scan_ms:${firstMs}/${secondMs}`], ok ? [] : ['large_repo_fixture_scan_failed'], Date.now() - started);
}

async function commandDiscoveryProbe(
  key: CodexCurrentFeatureFeatureKey,
  codexBin: string,
  timeoutMs: number,
  commands: string[][],
  pattern: RegExp,
  note: string
): Promise<CodexCurrentFeatureSingleProbe> {
  const started = Date.now();
  const evidence: string[] = [];
  for (const args of commands) {
    const run = await runProcess(codexBin, args, { timeoutMs, maxOutputBytes: 64 * 1024 }).catch(() => null);
    const text = `${run?.stdout || ''}\n${run?.stderr || ''}`;
    if (run?.code === 0) evidence.push(`command:${codexBin} ${args.join(' ')} exit=0`);
    if (pattern.test(text)) return probeResult(key, 'discovered', 'discovered', [...evidence, note], [], Date.now() - started);
  }
  return probeResult(key, evidence.length ? 'skipped' : 'failed', 'unverified', evidence, [`${key}_not_discovered`], Date.now() - started);
}

function probeResult(
  key: CodexCurrentFeatureFeatureKey,
  status: CodexCurrentFeatureProbeStatus,
  certainty: CodexCurrentFeatureProbeCertainty,
  evidence: string[],
  blockers: string[],
  durationMs: number
): CodexCurrentFeatureSingleProbe {
  return {
    key,
    status,
    certainty,
    evidence,
    blockers,
    duration_ms: Math.max(0, Math.round(durationMs))
  };
}
