import path from 'node:path';
import { exists, packageRoot, runProcess, which } from './fsx.mjs';

export async function findCodexBinary() {
  const env = process.env.SKS_CODEX_BIN || process.env.DCODEX_CODEX_BIN || process.env.CODEX_BIN;
  if (env && await exists(env)) return env;
  const global = await which('codex');
  if (global) return global;
  const root = packageRoot();
  const local = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'codex.cmd' : 'codex');
  if (await exists(local)) return local;
  return null;
}

export async function codexVersion(bin) {
  if (!bin) return null;
  const result = await runProcess(bin, ['--version'], { timeoutMs: 10000, maxOutputBytes: 16 * 1024 });
  const text = `${result.stdout}${result.stderr}`.trim();
  return result.code === 0 ? text : null;
}

export async function getCodexInfo() {
  const bin = await findCodexBinary();
  const version = await codexVersion(bin);
  return { bin, version, available: Boolean(bin) };
}

export async function runCodexExec({ root, prompt, outputFile, json = true, profile = null, extraArgs = [], onStdout, onStderr, logDir = null, stdoutFile = null, stderrFile = null, maxBufferBytes = 256 * 1024, timeoutMs = null }) {
  const bin = await findCodexBinary();
  if (!bin) {
    return { code: 127, stdout: '', stderr: 'Codex CLI not found. Install @openai/codex or set SKS_CODEX_BIN.' };
  }
  const args = ['exec', '--cd', root];
  if (profile) args.push('--profile', profile);
  if (json) args.push('--json');
  if (outputFile) args.push('--output-last-message', outputFile);
  args.push(...extraArgs);
  args.push(prompt);
  const effectiveTimeoutMs = Number(timeoutMs || process.env.SKS_CODEX_TIMEOUT_MS || process.env.DCODEX_CODEX_TIMEOUT_MS || 30 * 60 * 1000);
  return runProcess(bin, args, {
    cwd: root,
    onStdout,
    onStderr,
    timeoutMs: effectiveTimeoutMs,
    maxOutputBytes: maxBufferBytes,
    stdoutFile: stdoutFile || (logDir ? path.join(logDir, 'codex.stdout.log') : undefined),
    stderrFile: stderrFile || (logDir ? path.join(logDir, 'codex.stderr.log') : undefined)
  });
}
