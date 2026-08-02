import path from 'node:path';
import fsp from 'node:fs/promises';
import { ensureDir, exists, packageRoot, readJson, runProcess, which } from './fsx.js';
import { codexVersionPolicy, compareSemverLike, parseCodexVersionText } from './codex-compat/codex-version-policy.js';
import { validateJsonSchemaRecursive } from './json-schema-validator.js';
import { inspectCodexLbCliLaunchRecovery } from './codex-control/codex-lb-launch-recovery.js';
import { prepareCodexAppServerRuntimeEnv } from './codex-control/codex-app-server-runtime-env.js';
import type { CodexLbToolOutputRecoveryProbe } from './codex-lb/codex-lb-tool-output-recovery.js';

export interface CodexExecResumeOutputSchemaAvailability {
  schema: 'sks.codex-exec-output-schema-availability.v1';
  ok: boolean;
  status: 'available' | 'integration_optional' | 'degraded_supported';
  codex_bin: string | null;
  version: string | null;
  output_schema_supported: boolean;
  output_last_message_supported: boolean;
  warnings: string[];
}

export interface CodexExecOutputSchemaSyntaxAvailability {
  schema: 'sks.codex-exec-output-schema-syntax.v1';
  ok: boolean;
  status: 'available' | 'integration_optional' | 'degraded_supported';
  codex_bin: string | null;
  version: string | null;
  exec: {
    output_schema_supported: boolean;
    output_last_message_supported: boolean;
    help_checked: boolean;
  };
  resume: {
    output_schema_supported: boolean;
    output_last_message_supported: boolean;
    help_checked: boolean;
  };
  parity: boolean;
  blockers: string[];
  warnings: string[];
}

export interface CodexResumeOutputSchemaCommandInput {
  sessionId: string;
  prompt?: string;
  outputSchemaPath: string;
  outputFile?: string | null;
  json?: boolean;
  extraArgs?: readonly string[];
}

export interface CodexExecOutputSchemaCommandInput {
  prompt: string;
  outputSchemaPath: string;
  outputFile?: string | null;
  json?: boolean;
  extraArgs?: readonly string[];
}

export async function detectCodexExecOutputSchemaSyntax(opts: any = {}): Promise<CodexExecOutputSchemaSyntaxAvailability> {
  const codexBin = opts.codexBin || await which('codex').catch(() => null);
  if (!codexBin) {
    return {
      schema: 'sks.codex-exec-output-schema-syntax.v1',
      ok: true,
      status: 'integration_optional',
      codex_bin: null,
      version: null,
      exec: { output_schema_supported: false, output_last_message_supported: false, help_checked: false },
      resume: { output_schema_supported: false, output_last_message_supported: false, help_checked: false },
      parity: false,
      blockers: [],
      warnings: ['codex binary not detected; output-schema syntax check is integration_optional']
    };
  }
  const versionResult = opts.versionText
    ? { code: 0, stdout: String(opts.versionText), stderr: '' }
    : await runProcess(codexBin, ['--version'], { timeoutMs: opts.timeoutMs || 3000, maxOutputBytes: 16 * 1024 });
  const execHelpResult = opts.execHelpText
    ? { code: 0, stdout: String(opts.execHelpText), stderr: '' }
    : await runProcess(codexBin, ['exec', '--help'], { timeoutMs: opts.timeoutMs || 5000, maxOutputBytes: 64 * 1024 });
  const resumeHelpResult = opts.resumeHelpText
    ? { code: 0, stdout: String(opts.resumeHelpText), stderr: '' }
    : await runProcess(codexBin, ['exec', 'resume', '--help'], { timeoutMs: opts.timeoutMs || 5000, maxOutputBytes: 64 * 1024 });
  const rawVersion = `${versionResult.stdout || ''}\n${versionResult.stderr || ''}`;
  const version = parseCodexVersionText(rawVersion);
  const execHelp = `${execHelpResult.stdout || ''}\n${execHelpResult.stderr || ''}`;
  const resumeHelp = `${resumeHelpResult.stdout || ''}\n${resumeHelpResult.stderr || ''}`;
  const execSupported = /--output-schema\b/.test(execHelp);
  const resumeSupported = /--output-schema\b/.test(resumeHelp) || Boolean(version && compareSemverLike(version, '0.132.0') >= 0 && /--output-schema\b/.test(resumeHelp));
  const execLastMessage = /--output-last-message\b|-o,/.test(execHelp);
  const resumeLastMessage = /--output-last-message\b|-o,/.test(resumeHelp);
  const policy = codexVersionPolicy({ available: Boolean(version), version, source: 'codex --version' });
  const blockers = [
    ...(execHelpResult.code === 0 ? [] : ['codex_exec_help_failed']),
    ...(resumeHelpResult.code === 0 ? [] : ['codex_exec_resume_help_failed'])
  ];
  const status = policy.status === 'integration_optional'
    ? 'integration_optional'
    : execSupported || resumeSupported ? 'available' : 'degraded_supported';
  return {
    schema: 'sks.codex-exec-output-schema-syntax.v1',
    ok: blockers.length === 0,
    status,
    codex_bin: codexBin,
    version,
    exec: {
      output_schema_supported: execSupported,
      output_last_message_supported: execLastMessage,
      help_checked: execHelpResult.code === 0
    },
    resume: {
      output_schema_supported: resumeSupported,
      output_last_message_supported: resumeLastMessage,
      help_checked: resumeHelpResult.code === 0
    },
    parity: execSupported === resumeSupported,
    blockers,
    warnings: [
      ...policy.warnings,
      ...(execSupported ? [] : ['codex exec --output-schema unavailable']),
      ...(resumeSupported ? [] : ['codex exec resume --output-schema unavailable'])
    ]
  };
}

export interface CodexExecResumeOutputSchemaRunResult {
  schema: 'sks.codex-exec-output-schema-run.v1';
  ok: boolean;
  status: 'parsed' | 'blocked' | 'integration_optional' | 'degraded_supported';
  args: string[];
  codex_bin: string | null;
  output_file: string | null;
  parsed_json: unknown | null;
  blocker: ReturnType<typeof structuredOutputBlocker> | null;
  validation: { ok: boolean; issues: string[] };
  stdout_tail: string;
  stderr_tail: string;
  timed_out: boolean;
  exit_code: number | null;
  codex_lb_tool_output_recovery: CodexLbToolOutputRecoveryProbe;
}

export async function detectCodexExecResumeOutputSchema(opts: any = {}): Promise<CodexExecResumeOutputSchemaAvailability> {
  const codexBin = opts.codexBin || await which('codex').catch(() => null);
  if (!codexBin) {
    return {
      schema: 'sks.codex-exec-output-schema-availability.v1',
      ok: true,
      status: 'integration_optional',
      codex_bin: null,
      version: null,
      output_schema_supported: false,
      output_last_message_supported: false,
      warnings: ['codex binary not detected; output-schema resume path is integration_optional']
    };
  }
  const versionResult = opts.versionText
    ? { code: 0, stdout: String(opts.versionText), stderr: '' }
    : await runProcess(codexBin, ['--version'], { timeoutMs: opts.timeoutMs || 3000, maxOutputBytes: 16 * 1024 });
  const helpResult = opts.resumeHelpText
    ? { code: 0, stdout: String(opts.resumeHelpText), stderr: '' }
    : await runProcess(codexBin, ['exec', 'resume', '--help'], { timeoutMs: opts.timeoutMs || 5000, maxOutputBytes: 64 * 1024 });
  const rawVersion = `${versionResult.stdout || ''}\n${versionResult.stderr || ''}`;
  const version = parseCodexVersionText(rawVersion);
  const help = `${helpResult.stdout || ''}\n${helpResult.stderr || ''}`;
  const outputSchemaSupported = /--output-schema\b/.test(help) || Boolean(version && compareSemverLike(version, '0.132.0') >= 0);
  const outputLastMessageSupported = /--output-last-message\b|-o,/.test(help);
  const policy = codexVersionPolicy({ available: Boolean(version), version, source: 'codex --version' });
  const status = policy.status === 'integration_optional'
    ? 'integration_optional'
    : outputSchemaSupported ? 'available' : 'degraded_supported';
  const warnings = [
    ...policy.warnings,
    ...(outputSchemaSupported ? [] : ['codex exec resume --output-schema unavailable; fallback is capped at verified_partial'])
  ];
  return {
    schema: 'sks.codex-exec-output-schema-availability.v1',
    ok: true,
    status,
    codex_bin: codexBin,
    version,
    output_schema_supported: outputSchemaSupported,
    output_last_message_supported: outputLastMessageSupported,
    warnings
  };
}

export async function buildCodexExecOutputSchemaArgs(input: CodexExecOutputSchemaCommandInput): Promise<string[]> {
  const schemaPath = path.resolve(input.outputSchemaPath);
  const schema = await assertCodexSchemaFile(schemaPath);
  if (!schema.ok) throw new Error(`Invalid output schema: ${schema.issues.join(', ')}`);
  const args = ['exec'];
  if (input.json !== false) args.push('--json');
  args.push('--output-schema', schemaPath);
  if (input.outputFile) args.push('--output-last-message', path.resolve(input.outputFile));
  args.push(...Array.from(input.extraArgs || []));
  args.push(String(input.prompt || ''));
  return args;
}

export async function codexSchemaPath(name: string): Promise<string> {
  const clean = String(name || '').replace(/[^A-Za-z0-9_.-]+/g, '');
  const file = clean.endsWith('.json') ? clean : `${clean}.schema.json`;
  const candidate = path.join(packageRoot(), 'schemas', 'codex', file);
  if (!(await exists(candidate))) throw new Error(`Codex output schema missing: ${candidate}`);
  return candidate;
}

export async function assertCodexSchemaFile(schemaPath: string): Promise<{ ok: boolean; path: string; schema_id: string | null; issues: string[] }> {
  const absolute = path.resolve(schemaPath);
  const issues: string[] = [];
  if (!(await exists(absolute))) issues.push('schema_file_missing');
  const parsed = issues.length ? null : await readJson<any>(absolute, null);
  if (!parsed || typeof parsed !== 'object') issues.push('schema_invalid_json');
  if (parsed && parsed.type !== 'object') issues.push('schema_root_type_not_object');
  return { ok: issues.length === 0, path: absolute, schema_id: parsed?.$id || parsed?.title || null, issues };
}

export async function buildCodexExecResumeOutputSchemaArgs(input: CodexResumeOutputSchemaCommandInput): Promise<string[]> {
  const sessionId = sanitizeResumeId(input.sessionId);
  const schemaPath = path.resolve(input.outputSchemaPath);
  const schema = await assertCodexSchemaFile(schemaPath);
  if (!schema.ok) throw new Error(`Invalid output schema: ${schema.issues.join(', ')}`);
  const args = ['exec', 'resume'];
  if (input.json !== false) args.push('--json');
  args.push('--output-schema', schemaPath);
  if (input.outputFile) args.push('-o', path.resolve(input.outputFile));
  args.push(...Array.from(input.extraArgs || []));
  args.push(sessionId);
  if (input.prompt) args.push(String(input.prompt));
  return args;
}

export async function runCodexExecResumeWithOutputSchema(
  input: CodexResumeOutputSchemaCommandInput,
  opts: { codexBin?: string | null; timeoutMs?: number; maxOutputBytes?: number; cwd?: string; env?: NodeJS.ProcessEnv; recoveryFetch?: typeof fetch; recoveryTimeoutMs?: number; runProcessImpl?: typeof runProcess; prepareCodexRuntimeEnvImpl?: typeof prepareCodexAppServerRuntimeEnv } = {}
): Promise<CodexExecResumeOutputSchemaRunResult> {
  const root = opts.cwd || packageRoot();
  const env = await (opts.prepareCodexRuntimeEnvImpl || prepareCodexAppServerRuntimeEnv)({
    env: opts.env || process.env
  });
  const toolOutputRecovery = await inspectCodexLbCliLaunchRecovery({
    root,
    env,
    cliArgs: input.extraArgs || [],
    ...(opts.recoveryFetch ? { fetchImpl: opts.recoveryFetch } : {}),
    ...(opts.recoveryTimeoutMs === undefined ? {} : { timeoutMs: opts.recoveryTimeoutMs })
  });
  if (!toolOutputRecovery.ok) {
    return {
      schema: 'sks.codex-exec-output-schema-run.v1',
      ok: false,
      status: 'blocked',
      args: [],
      codex_bin: opts.codexBin || null,
      output_file: null,
      parsed_json: null,
      blocker: structuredOutputBlocker('codex_lb_tool_output_recovery_blocked', toolOutputRecovery.blockers.join(', ')),
      validation: { ok: false, issues: ['codex_lb_tool_output_recovery_blocked'] },
      stdout_tail: '',
      stderr_tail: '',
      timed_out: false,
      exit_code: null,
      codex_lb_tool_output_recovery: toolOutputRecovery
    };
  }
  const availability = await detectCodexExecResumeOutputSchema({ codexBin: opts.codexBin || undefined });
  if (!availability.codex_bin || availability.status !== 'available' || !availability.output_schema_supported) {
    const status = availability.status === 'available' ? 'degraded_supported' : availability.status;
    return {
      schema: 'sks.codex-exec-output-schema-run.v1',
      ok: false,
      status,
      args: [],
      codex_bin: availability.codex_bin,
      output_file: null,
      parsed_json: null,
      blocker: structuredOutputBlocker('output_schema_unavailable', availability.warnings.join('; ') || 'codex exec resume --output-schema unavailable'),
      validation: { ok: false, issues: ['output_schema_unavailable'] },
      stdout_tail: '',
      stderr_tail: '',
      timed_out: false,
      exit_code: null,
      codex_lb_tool_output_recovery: toolOutputRecovery
    };
  }

  const outputFile = input.outputFile
    ? path.resolve(input.outputFile)
    : path.join(packageRoot(), '.sneakoscope', 'tmp', `codex-output-schema-${Date.now()}.json`);
  await ensureDir(path.dirname(outputFile));
  const args = await buildCodexExecResumeOutputSchemaArgs({ ...input, outputFile });
  const runOpts: Parameters<typeof runProcess>[2] = {
    cwd: root,
    timeoutMs: opts.timeoutMs || 120_000,
    maxOutputBytes: opts.maxOutputBytes || 256 * 1024
  };
  runOpts.env = env;
  const result = await (opts.runProcessImpl || runProcess)(availability.codex_bin, args, runOpts);
  const outputText = await readOutputText(outputFile, result.stdout);
  const parsed = parseStructuredCodexOutput(outputText);
  const schema = await readJson<any>(path.resolve(input.outputSchemaPath), null);
  const validation = parsed.ok ? validateStructuredOutput(parsed.value, schema) : { ok: false, issues: ['json_parse_failed'] };
  const blocker = !parsed.ok
    ? parsed.blocker
    : validation.ok
      ? null
      : structuredOutputBlocker('schema_validation_failed', validation.issues.join(', '));
  return {
    schema: 'sks.codex-exec-output-schema-run.v1',
    ok: result.code === 0 && parsed.ok && validation.ok,
    status: result.code === 0 && parsed.ok && validation.ok ? 'parsed' : 'blocked',
    args,
    codex_bin: availability.codex_bin,
    output_file: outputFile,
    parsed_json: parsed.ok ? parsed.value : null,
    blocker,
    validation,
    stdout_tail: redactCodexOutput(result.stdout).slice(-12_000),
    stderr_tail: redactCodexOutput(result.stderr).slice(-12_000),
    timed_out: result.timedOut,
    exit_code: result.code,
    codex_lb_tool_output_recovery: toolOutputRecovery
  };
}

export function parseStructuredCodexOutput(text: unknown): { ok: boolean; value: unknown | null; blocker: any | null } {
  const raw = String(text || '').trim();
  if (!raw) {
    return { ok: false, value: null, blocker: structuredOutputBlocker('json_parse_failed', 'empty output') };
  }
  try {
    return { ok: true, value: JSON.parse(raw), blocker: null };
  } catch (err) {
    return { ok: false, value: null, blocker: structuredOutputBlocker('json_parse_failed', err instanceof Error ? err.message : String(err)) };
  }
}

export function validateStructuredOutput(value: unknown, schema: any): { ok: boolean; issues: string[] } {
  return validateJsonSchemaRecursive(value, schema);
}

export function structuredOutputBlocker(reason: string, detail: string) {
  return {
    schema: 'sks.codex-structured-output-blocker.v1',
    reason,
    detail: redactCodexOutput(detail),
    status: 'verified_partial_or_blocked',
    wrongness_kind: reason === 'schema_validation_failed' ? 'callout_extraction_schema_failed' : 'missing_evidence'
  };
}

export function redactCodexOutput(text: unknown): string {
  return String(text || '')
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, '[REDACTED_OPENAI_KEY]')
    .replace(/github_pat_[A-Za-z0-9_]+/g, '[REDACTED_GITHUB_PAT]')
    .slice(0, 12_000);
}

function sanitizeResumeId(value: unknown): string {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(id)) throw new Error('Unsafe Codex resume session id');
  return id;
}

async function readOutputText(outputFile: string, stdout: string) {
  try {
    const text = await fsp.readFile(outputFile, 'utf8');
    if (text.trim()) return text;
  } catch {}
  return stdout;
}
