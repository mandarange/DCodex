#!/usr/bin/env node
// @ts-nocheck
// Production regression for the chronic "npm i -g wipes ~/.codex/config.toml" bug.
// Proves ensureGlobalCodexFastModeDuringInstall:
//   1. PRESERVES user-set top-level model/service_tier/model_reasoning_effort on update,
//   2. backs up the prior config before mutating,
//   3. still seeds SKS non-speed defaults for a fresh (empty) config,
//   4. NEVER blind-overwrites an unparseable config (backs up + preserves),
//   5. is idempotent (second run is a no-op 'present').
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertGate, emitGate, importDist } from './gate-lib.js';

const helpers = await importDist('cli/install-helpers.js');
const init = await importDist('core/init.js');
const context7 = await importDist('cli/context7-command.js');

const results = [];

// --- Case 1: customized config preserved + backed up on update ---
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-cfg-preserve-'));
  const codexDir = path.join(dir, '.codex');
  await fs.mkdir(codexDir, { recursive: true });
  const cfg = path.join(codexDir, 'config.toml');
  const userConfig = [
    '# my hand-tuned Codex config',
    'model = "future-codex-model"',
    'service_tier = "standard"',
    'model_reasoning_effort = "high"',
    '',
    '[mcp_servers.custom]',
    'command = "npx"',
    '',
    '[agents]',
    'max_threads = 20',
    ''
  ].join('\n');
  await fs.writeFile(cfg, userConfig);
  const res = await helpers.ensureGlobalCodexFastModeDuringInstall({ home: dir, configPath: cfg });
  const after = await fs.readFile(cfg, 'utf8');
  const backups = (await fs.readdir(codexDir)).filter((f) => f.startsWith('config.toml.sks-'));
  const ok =
    res.status === 'updated' &&
    /^model = "future-codex-model"/m.test(after) &&     // arbitrary user model preserved
    /^service_tier = "standard"/m.test(after) &&        // user tier preserved
    /^model_reasoning_effort = "high"/m.test(after) &&  // user effort NOT stripped
    /# my hand-tuned Codex config/.test(after) &&       // user comment preserved
    /\[mcp_servers\.custom\]/.test(after) &&            // user table preserved
    /\[agents\][\s\S]*max_threads = 20/.test(after) &&  // user concurrency preserved
    !/\[profiles\.sks-fast-high\]/.test(after) &&       // legacy profile table stripped
    !/\[user\.fast_mode\]/.test(after) &&               // legacy fast UI table stripped
    backups.length >= 1 &&                              // backup created
    Boolean(res.backup_path);
  results.push({ case: 'preserves_user_config', ok, status: res.status, backups, model_preserved: /future-codex-model/.test(after) });
}

// --- Case 2: fresh/empty config gets SKS defaults without forcing fast service tier ---
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-cfg-fresh-'));
  const cfg = path.join(dir, '.codex', 'config.toml');
  await fs.mkdir(path.dirname(cfg), { recursive: true });
  const res = await helpers.ensureGlobalCodexFastModeDuringInstall({ home: dir, configPath: cfg });
  const after = await fs.readFile(cfg, 'utf8');
  const topLevel = String(after).split(/\n\s*\[/)[0] || '';
  const ok = res.status === 'updated'
    && !/^model\s*=/m.test(topLevel)
    && !/^model_reasoning_effort\s*=/m.test(topLevel)
    && !/^service_tier = "fast"/m.test(topLevel)
    && /\[features\]/.test(after)
    && !/^max_threads\s*=/m.test(after);
  results.push({ case: 'fresh_config_seeds_defaults', ok, status: res.status });
}

// --- Case 3: unparseable config is preserved + backed up, NOT overwritten ---
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-cfg-broken-'));
  const codexDir = path.join(dir, '.codex');
  await fs.mkdir(codexDir, { recursive: true });
  const cfg = path.join(codexDir, 'config.toml');
  const broken = 'model = "gpt-5.6-terra"\n[features\nhooks = true\n'; // malformed table header
  await fs.writeFile(cfg, broken);
  const res = await helpers.ensureGlobalCodexFastModeDuringInstall({ home: dir, configPath: cfg });
  const after = await fs.readFile(cfg, 'utf8');
  const backups = (await fs.readdir(codexDir)).filter((f) => f.includes('.sks-unparseable-'));
  const ok = res.status === 'unparseable_config_preserved' && after === broken && backups.length >= 1 && Boolean(res.backup_path);
  results.push({ case: 'unparseable_preserved_not_clobbered', ok, status: res.status, untouched: after === broken });
}

// --- Case 4: idempotent — second run on a healthy config is a no-op ---
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-cfg-idem-'));
  const cfg = path.join(dir, '.codex', 'config.toml');
  await fs.mkdir(path.dirname(cfg), { recursive: true });
  await helpers.ensureGlobalCodexFastModeDuringInstall({ home: dir, configPath: cfg });
  const second = await helpers.ensureGlobalCodexFastModeDuringInstall({ home: dir, configPath: cfg });
  const ok = second.status === 'present';
  results.push({ case: 'idempotent_second_run_noop', ok, status: second.status });
}

// --- Case 5: project Context7 setup preserves user API key args/env instead of resetting the block ---
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-context7-project-'));
  const cfg = path.join(dir, '.codex', 'config.toml');
  await fs.mkdir(path.dirname(cfg), { recursive: true });
  const userConfig = [
    '[mcp_servers.context7]',
    'command = "npx"',
    'args = ["-y", "@upstash/context7-mcp@latest", "--api-key", "ctx7-user-key"]',
    '',
    '[mcp_servers.context7.env]',
    'CONTEXT7_API_KEY = "ctx7-user-key"',
    ''
  ].join('\n');
  await fs.writeFile(cfg, userConfig);
  const changed = await helpers.ensureProjectContext7Config(dir, 'local');
  const after = await fs.readFile(cfg, 'utf8');
  const ok = changed === false && after === userConfig;
  results.push({ case: 'context7_project_setup_preserves_existing_key_block', ok, changed });
}

// --- Case 6: setup/init regeneration preserves an existing Context7 block with custom credentials ---
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-context7-init-'));
  const cfg = path.join(dir, '.codex', 'config.toml');
  await fs.mkdir(path.dirname(cfg), { recursive: true });
  const customBlock = [
    '[mcp_servers.context7]',
    'url = "https://mcp.context7.com/mcp"',
    'headers = { CONTEXT7_API_KEY = "ctx7-user-key" }',
    ''
  ].join('\n');
  await fs.writeFile(cfg, customBlock);
  await init.initProject(dir, { installScope: 'global' });
  const after = await fs.readFile(cfg, 'utf8');
  const ok =
    /\[mcp_servers\.context7\]\nurl = "https:\/\/mcp\.context7\.com\/mcp"\nheaders = \{ CONTEXT7_API_KEY = "ctx7-user-key" \}/.test(after)
    && !/args = \["-y", "@upstash\/context7-mcp@latest"\]/.test(after);
  results.push({ case: 'context7_init_preserves_existing_key_block', ok });
}

// --- Case 7: global Context7 setup skips `codex mcp add` when context7 already exists ---
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-context7-global-'));
  const binDir = path.join(dir, 'bin');
  await fs.mkdir(binDir, { recursive: true });
  const fakeCodex = path.join(binDir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  const log = path.join(dir, 'codex.log');
  await fs.writeFile(fakeCodex, [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
    'if [ "$1" = "--version" ]; then echo "codex-cli 99.0.0"; exit 0; fi',
    'if [ "$1" = "mcp" ] && [ "$2" = "list" ]; then echo "context7  configured"; exit 0; fi',
    'if [ "$1" = "mcp" ] && [ "$2" = "add" ]; then echo "unexpected mcp add" >&2; exit 77; fi',
    'echo "unexpected codex $*" >&2',
    'exit 2',
    ''
  ].join('\n'));
  await fs.chmod(fakeCodex, 0o755);
  const previous = {
    SKS_CODEX_BIN: process.env.SKS_CODEX_BIN,
    CODEX_BIN: process.env.CODEX_BIN
  };
  process.env.SKS_CODEX_BIN = fakeCodex;
  delete process.env.CODEX_BIN;
  const previousConsoleLog = console.log;
  try {
    console.log = () => {};
    await context7.context7Command('setup', ['--scope', 'global', '--json']);
  } finally {
    console.log = previousConsoleLog;
    if (previous.SKS_CODEX_BIN === undefined) delete process.env.SKS_CODEX_BIN;
    else process.env.SKS_CODEX_BIN = previous.SKS_CODEX_BIN;
    if (previous.CODEX_BIN === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous.CODEX_BIN;
  }
  const calls = await fs.readFile(log, 'utf8');
  const ok = /--version/.test(calls) && /mcp list/.test(calls) && !/mcp add/.test(calls);
  results.push({ case: 'context7_global_setup_preserves_existing_entry', ok, calls: calls.trim().split(/\n+/) });
}

const ok = results.every((r) => r.ok);
if (!ok) {
  console.error(JSON.stringify({ ok: false, message: 'install config-preservation regression failed', results }, null, 2));
  process.exit(1);
}
emitGate('install:update-preserves-config', { cases: results.map((r) => r.case) });
