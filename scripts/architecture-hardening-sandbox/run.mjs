#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const childTimeoutMs = 60_000;
const internalSentinels = [
  'sandbox-lb-credential-do-not-log',
  'sandbox-openrouter-credential-do-not-log',
  'sandbox-desktop-oauth-do-not-forward',
  'sandbox-forged-provider-key-do-not-forward',
];
const keepSandbox = process.env.SKS_ARCHITECTURE_KEEP_SANDBOX === '1';
const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-desktop-bridge-sandbox-'));
const directories = {
  home: path.join(root, 'home'),
  codexHome: path.join(root, 'codex-home'),
  sksHome: path.join(root, 'sks-home'),
  globalRoot: path.join(root, 'global'),
  temp: path.join(root, 'tmp'),
};

await Promise.all(Object.values(directories).map((directory) =>
  fsp.mkdir(directory, { recursive: true, mode: 0o700 })));

const childEnv = {
  PATH: process.env.PATH || '/usr/bin:/bin',
  HOME: directories.home,
  CODEX_HOME: directories.codexHome,
  SKS_HOME: directories.sksHome,
  SKS_GLOBAL_ROOT: directories.globalRoot,
  TMPDIR: directories.temp,
  SKS_ARCHITECTURE_SANDBOX_ROOT: root,
  SKS_ARCHITECTURE_SCENARIOS: path.join(
    repoRoot,
    'test',
    'fixtures',
    'architecture-hardening',
    'scenario-matrix.json',
  ),
};

try {
  const { value: worker, stdout } = await runJson(
    process.execPath,
    [path.join(scriptDir, 'worker.mjs')],
    childEnv,
  );
  assertSecretFree(stdout, internalSentinels);
  const result = {
    schema: 'sks.desktop-bridge-hermetic-sandbox-report.v1',
    ok: worker.ok === true,
    isolation: worker.isolation,
    bridge_contract: worker.bridge_contract,
    evidence_path: keepSandbox ? path.join(root, 'evidence', 'bridge-report.json') : null,
  };
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  assertSecretFree(serialized, internalSentinels);
  process.stdout.write(serialized);
  if (!result.ok) process.exitCode = 1;
} finally {
  if (!keepSandbox) await fsp.rm(root, { recursive: true, force: true });
}

function runJson(command, args, env) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const child = spawn(command, args, {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value);
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`desktop_bridge_sandbox_child_timeout:${childTimeoutMs}`));
    }, childTimeoutMs);
    timeout.unref?.();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      if (code !== 0) {
        finish(new Error(`desktop_bridge_sandbox_child_failed:${code}:${stderr.trim().slice(0, 600)}`));
        return;
      }
      try {
        finish(null, { value: JSON.parse(stdout), stdout });
      } catch {
        finish(new Error('desktop_bridge_sandbox_child_output_invalid'));
      }
    });
  });
}

function assertSecretFree(text, sentinels) {
  for (const sentinel of sentinels) {
    if (text.includes(sentinel)) throw new Error('desktop_bridge_sandbox_secret_in_stdout');
  }
  if (/authorization\s*[:=]\s*bearer\s+\S+/i.test(text)) {
    throw new Error('desktop_bridge_sandbox_authorization_in_stdout');
  }
}
