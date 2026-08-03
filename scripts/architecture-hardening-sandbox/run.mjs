#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const SANDBOX_CHILD_TIMEOUT_MS = 60_000;
const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-architecture-sandbox-'));
const home = path.join(root, 'home');
const codexHome = path.join(root, 'codex-home');
const sksHome = path.join(root, 'sks-home');
await Promise.all([home, codexHome, sksHome].map((directory) => fsp.mkdir(directory, { recursive: true, mode: 0o700 })));

const approved = process.env.SKS_ARCHITECTURE_LIVE_APPROVED === '1';
const liveKey = process.env.CODEX_LB_API_KEY || '';
const liveBaseUrl = process.env.CODEX_LB_BASE_URL || '';
const liveRequested = Boolean(liveKey && liveBaseUrl);
const childEnv = {
  PATH: process.env.PATH || '/usr/bin:/bin',
  HOME: home,
  CODEX_HOME: codexHome,
  SKS_HOME: sksHome,
  SKS_GLOBAL_ROOT: path.join(root, 'global'),
  SKS_ARCHITECTURE_SANDBOX_ROOT: root,
  SKS_ARCHITECTURE_SCENARIOS: path.join(repoRoot, 'test', 'fixtures', 'architecture-hardening', 'scenario-matrix.json'),
  SKS_ARCHITECTURE_KEEP_SANDBOX: process.env.SKS_ARCHITECTURE_KEEP_SANDBOX === '1' ? '1' : '0'
};

try {
  const mock = await runJson(process.execPath, [path.join(scriptDir, 'worker.mjs')], childEnv);
  let live;
  if (!liveRequested) {
    live = { status: 'not_verified', reason: 'secret_injection_required' };
  } else if (!approved) {
    live = { status: 'not_verified', reason: 'explicit_live_approval_required' };
  } else {
    live = await runJson(process.execPath, [path.join(scriptDir, 'live-probe.mjs')], {
      ...childEnv,
      CODEX_LB_API_KEY: liveKey,
      CODEX_LB_BASE_URL: liveBaseUrl,
      SKS_ARCHITECTURE_LIVE_MODEL: process.env.SKS_ARCHITECTURE_LIVE_MODEL || 'gpt-5.6-codex'
    });
  }
  const result = {
    schema: 'sks.architecture-hardening-sandbox-report.v1',
    ok: mock.ok === true,
    isolation: mock.isolation,
    mock_contract: mock.mock_contract,
    live,
    evidence_path: process.env.SKS_ARCHITECTURE_KEEP_SANDBOX === '1'
      ? path.join(root, 'evidence', 'mock-report.json')
      : null
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
} finally {
  if (process.env.SKS_ARCHITECTURE_KEEP_SANDBOX !== '1') {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

function runJson(command, args, env) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value);
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`architecture_sandbox_child_timeout:${SANDBOX_CHILD_TIMEOUT_MS}`));
    }, SANDBOX_CHILD_TIMEOUT_MS);
    timeout.unref?.();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      if (code !== 0) {
        finish(new Error(`architecture_sandbox_child_failed:${code}:${stderr.trim().slice(0, 400)}`));
        return;
      }
      try {
        finish(null, JSON.parse(stdout));
      } catch {
        finish(new Error('architecture_sandbox_child_output_invalid'));
      }
    });
  });
}
