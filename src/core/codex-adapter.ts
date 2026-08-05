import path from 'node:path';
import { runProcess, type RunProcessResult } from './fsx.js';
import { preserveCodexModelArgs } from './codex-model-guard.js';
import { managedProxyEnvForChild } from './codex/managed-proxy-env.js';
import { resolveCodexRuntime } from './codex-runtime/resolve-codex-runtime.js';
import {
  desktopBridgeLaunchBlockedProcessResult,
  withDesktopBridgeCliLaunchGuard
} from './codex-control/desktop-bridge-launch-guard.js';
import { prepareCodexAppServerRuntimeEnv } from './codex-control/codex-app-server-runtime-env.js';

export async function findCodexBinary(): Promise<string | null> {
  const resolved = await resolveCodexRuntime({
    explicitPath: process.env.DCODEX_CODEX_BIN || null,
    requestedBy: 'codex-adapter'
  });
  return resolved.identity?.realpath || null;
}

export async function codexVersion(bin: string | null): Promise<string | null> {
  if (!bin) return null;
  const result = await runProcess(bin, ['--version'], { timeoutMs: 10000, maxOutputBytes: 16 * 1024 });
  const text = `${result.stdout}${result.stderr}`.trim();
  return result.code === 0 ? text : null;
}

/** Shape returned by {@link getCodexInfo}; use {@link EMPTY_CODEX_INFO} for safe fallbacks. */
export type CodexInfo = {
  bin: string | null;
  version: string | null;
  available: boolean;
};

export const EMPTY_CODEX_INFO: CodexInfo = Object.freeze({
  bin: null,
  version: null,
  available: false
});

export async function getCodexInfo(): Promise<CodexInfo> {
  const bin = await findCodexBinary();
  const version = await codexVersion(bin);
  return { bin, version, available: Boolean(bin) };
}

export function buildCodexExecArgs({ root, prompt, outputFile, json = true, profile = null, extraArgs = [] }: any) {
  const args = ['exec', '--cd', root];
  if (profile) args.push('--profile', profile);
  if (json) args.push('--json');
  if (outputFile) args.push('--output-last-message', outputFile);
  args.push(...preserveCodexModelArgs(extraArgs));
  args.push(prompt);
  return args;
}

export async function runCodexExec({ root, recoveryRoot = root, prompt, outputFile, json = true, profile = null, extraArgs = [], onStdout, onStderr, logDir = null, stdoutFile = null, stderrFile = null, maxBufferBytes = 256 * 1024, timeoutMs = null, env = process.env, codexBin = null, findCodexBinaryImpl = findCodexBinary, runProcessImpl = runProcess, prepareCodexRuntimeEnvImpl = prepareCodexAppServerRuntimeEnv }: any): Promise<RunProcessResult> {
  const args = buildCodexExecArgs({ root, prompt, outputFile, json, profile, extraArgs });
  const effectiveTimeoutMs = Number(timeoutMs || process.env.SKS_CODEX_TIMEOUT_MS || process.env.DCODEX_CODEX_TIMEOUT_MS || 30 * 60 * 1000);
  const recoveryArgs = args.slice(1, -1);
  const runtimeEnv = await prepareCodexRuntimeEnvImpl({ env });
  const guarded = await withDesktopBridgeCliLaunchGuard({
    root: recoveryRoot,
    env: runtimeEnv,
    cliArgs: recoveryArgs
  }, async (sanitizedEnv) => {
    const bin = codexBin || await findCodexBinaryImpl();
    if (!bin) {
      return {
        code: 127,
        stdout: '',
        stderr: 'Codex CLI not found. Install @openai/codex or set SKS_CODEX_BIN.',
        stdoutBytes: 0,
        stderrBytes: 0,
        truncated: false,
        timedOut: false
      } satisfies RunProcessResult;
    }
    return runProcessImpl(bin, args, {
      cwd: root,
      env: { ...sanitizedEnv, ...managedProxyEnvForChild(sanitizedEnv) },
      onStdout,
      onStderr,
      timeoutMs: effectiveTimeoutMs,
      maxOutputBytes: maxBufferBytes,
      stdoutFile: stdoutFile || (logDir ? path.join(logDir, 'codex.stdout.log') : undefined),
      stderrFile: stderrFile || (logDir ? path.join(logDir, 'codex.stderr.log') : undefined)
    });
  });
  return guarded.launched
    ? { ...guarded.value, desktop_bridge_launch_guard: guarded.desktopBridgeLaunchGuard }
    : desktopBridgeLaunchBlockedProcessResult(guarded.desktopBridgeLaunchGuard);
}
