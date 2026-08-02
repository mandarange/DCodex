#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../core/fsx.js';
import { codexLbFixtureEnv } from './codex-lb-fixture-env.js';

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-codex-lb-fixture-home-'));
const entry = path.resolve('dist/bin/sks.js');

const status = await runProcess(process.execPath, [entry, 'codex-lb', 'status', '--json'], {
  cwd: home,
  env: codexLbFixtureEnv(home),
  timeoutMs: 15_000,
  maxOutputBytes: 128 * 1024
});

const setup = await runProcess(process.execPath, [entry, 'codex-lb', 'setup', '--host', 'lb.example.test', '--api-key-stdin', '--yes', '--json'], {
  cwd: home,
  input: 'sk-fixture-secret\n',
  env: codexLbFixtureEnv(home),
  timeoutMs: 15_000,
  maxOutputBytes: 128 * 1024
});

const combined = `${status.stdout}\n${status.stderr}\n${setup.stdout}\n${setup.stderr}`;
const leaks = [];
if (/Missing environment variable/i.test(combined)) leaks.push('raw_missing_env_message');
if (/sk-fixture-secret/.test(combined)) leaks.push('api_key_leak');

let statusJson = {};
let setupJson = {};
try { statusJson = JSON.parse(status.stdout); } catch {}
try { setupJson = JSON.parse(setup.stdout); } catch {}

const envPath = path.join(home, '.codex', 'sks-codex-lb.env');
const envStat = await fs.stat(envPath).catch(() => null);
const mode = envStat ? (envStat.mode & 0o777).toString(8) : null;
const ok = status.code === 1
  && setup.code === 0
  && statusJson.setup_needed === true
  && setupJson.ok === true
  && setupJson.api_key?.redacted === true
  && mode === '600'
  && leaks.length === 0;

console.log(JSON.stringify({
  schema: 'sks.codex-lb-setup-fixture-check.v1',
  ok,
  home,
  status_code: status.code,
  setup_code: setup.code,
  setup_needed: statusJson.setup_needed === true,
  configured: setupJson.ok === true,
  env_mode: mode,
  leaks
}, null, 2));

if (!ok && leaks.length) await recordCodexLbWrongness(leaks);
if (!ok) process.exitCode = 1;

async function recordCodexLbWrongness(leaks) {
  const { addWrongnessRecord } = await import('../core/triwiki-wrongness/wrongness-ledger.js');
  await addWrongnessRecord(process.cwd(), {
    route: '$CodexLB',
    wrongness_kind: 'codex_lb_missing_env_raw_message',
    severity: 'high',
    claim: { text: `codex-lb fixture exposed forbidden output: ${leaks.join(', ')}` },
    detected_by: {
      source: 'codex_lb_setup_fixture',
      command: 'npm run codex-lb:setup-fixture',
      artifact: 'dist/scripts/codex-lb-setup-fixture-check.js',
      detail: leaks.join(', ')
    },
    root_cause: {
      category: 'route_policy_gap',
      explanation: 'codex-lb setup/status must convert missing key states into structured setup guidance without secret leakage.'
    },
    corrective_action: {
      summary: 'Repair codex-lb env loading, setup output, or redaction before release.',
      required_evidence: ['npm run codex-lb:setup-fixture'],
      patch_status: 'pending'
    },
    avoidance_rule: {
      text: 'Do not print raw CODEX_LB_API_KEY missing messages; use setup wizard guidance and redaction.',
      applies_to: ['codex-lb', 'release'],
      severity: 'high'
    },
    links: { tests: ['npm run codex-lb:setup-fixture'], files: ['dist/scripts/codex-lb-setup-fixture-check.js'] }
  });
}
