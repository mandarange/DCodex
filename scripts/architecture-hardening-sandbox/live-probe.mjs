#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { testCodexLbConnection } from '../../dist/cli/install-helpers-codex-lb-chain.js';

const apiKey = process.env.CODEX_LB_API_KEY || '';
const baseUrl = process.env.CODEX_LB_BASE_URL || '';
const model = process.env.SKS_ARCHITECTURE_LIVE_MODEL || 'gpt-5.6-codex';
const CODEX_VERSION_PROBE_TIMEOUT_MS = 5_000;
if (!apiKey || !baseUrl) throw new Error('secret_injection_required');
if (!isApprovedBaseUrl(baseUrl)) throw new Error('live_base_url_not_https_or_loopback');

const codex = await codexVersionProbe();
if (!codex.ok) {
  process.stdout.write(`${JSON.stringify({ status: 'not_verified', reason: 'codex_executable_required' })}\n`);
  process.exit(0);
}

const connection = await testCodexLbConnection({
  selected: true,
  provider_base_url_matches_credential: true,
  provider_contract_ok: true,
  base_url: baseUrl
}, {
  requireSelected: true,
  baseUrl,
  apiKey,
  model,
  timeoutMs: 20_000,
  env: {
    HOME: process.env.HOME,
    CODEX_HOME: process.env.CODEX_HOME
  }
});

process.stdout.write(`${JSON.stringify({
  status: connection.ok === true ? 'verified' : 'failed',
  reason: connection.ok === true ? null : String(connection.status || 'live_connection_failed'),
  codex_cli_detected: true,
  responses_protocol_completed: connection.ok === true
})}\n`);
if (connection.ok !== true) process.exitCode = 1;

function codexVersionProbe() {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn('codex', ['--version'], {
      env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: process.env.HOME || '', CODEX_HOME: process.env.CODEX_HOME || '' },
      stdio: ['ignore', 'ignore', 'ignore']
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, reason: 'codex_version_probe_timeout' });
    }, CODEX_VERSION_PROBE_TIMEOUT_MS);
    timeout.unref?.();
    child.once('error', () => finish({ ok: false, reason: 'codex_version_probe_error' }));
    child.once('close', (code) => finish({ ok: code === 0, reason: code === 0 ? null : 'codex_version_probe_failed' }));
  });
}

function isApprovedBaseUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname));
  } catch {
    return false;
  }
}
