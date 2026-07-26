#!/usr/bin/env node
// @ts-nocheck
// Production invariant: a codex-lb config write must NEVER corrupt ~/.codex/config.toml,
// especially on initial install. Every codex-lb writer routes through
// safeWriteCodexConfigToml, which parse-gates current + next and backs up before mutating.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertGate, emitGate, importDist } from './gate-lib.js';

const helpers = await importDist('cli/install-helpers.js');

// Reproduce the on-disk parse smoke the runtime uses (unterminated triple-quote / bad header).
function parses(text) {
  const tripleTokens = (String(text).match(/"""|'''/g) || []).length;
  if (tripleTokens % 2 !== 0) return false;
  const badHeader = String(text).split('\n').find((l) => /^\s*\[/.test(l) && !/^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/.test(l));
  return !badHeader;
}

const results = [];
const BASE_URL = 'http://127.0.0.1:2455/backend-api/codex';

// --- Case 1: fresh/empty config -> codex-lb provider added cleanly, parses ---
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-cdxlb-fresh-'));
  const cfg = path.join(dir, 'config.toml');
  const next = helpers.upsertCodexLbConfig('', BASE_URL);
  const res = await helpers.safeWriteCodexConfigToml(cfg, '', next, 'codex-lb');
  const after = await fs.readFile(cfg, 'utf8');
  const ok = res.ok && /\[model_providers\.codex-lb\]/.test(after) && /^model_provider = "codex-lb"/m.test(after) && parses(after);
  results.push({ case: 'fresh_adds_provider_parseable', ok, status: res.status });
}

// --- Case 2: existing config with a multiline string containing a bracketed line
//     (the upsertTomlTable blind spot) must NEVER be written corrupted ---
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-cdxlb-multiline-'));
  const cfg = path.join(dir, 'config.toml');
  const tricky = [
    'model = "gpt-5.1-codex"',
    'custom_note = """',
    'here is a note with a [not-a-real-header] inside a multiline string',
    'second line',
    '"""',
    '',
    '[mcp_servers.x]',
    'command = "y"',
    ''
  ].join('\n');
  await fs.writeFile(cfg, tricky);
  const next = helpers.normalizeCodexFastModeUiConfig(helpers.upsertCodexLbConfig(tricky, BASE_URL));
  const res = await helpers.safeWriteCodexConfigToml(cfg, tricky, next, 'codex-lb');
  const after = await fs.readFile(cfg, 'utf8');
  // INVARIANT: whatever happens, the on-disk config must still parse.
  const ok = parses(after) && (res.ok ? /\[model_providers\.codex-lb\]/.test(after) : after === tricky);
  results.push({ case: 'multiline_trap_never_corrupts', ok, status: res.status, on_disk_parses: parses(after) });
}

// --- Case 3: an already-unparseable existing config is preserved + backed up, not clobbered ---
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-cdxlb-broken-'));
  const cfg = path.join(dir, 'config.toml');
  const broken = 'model = "x"\n[features\nhooks = true\n';
  await fs.writeFile(cfg, broken);
  const next = helpers.upsertCodexLbConfig(broken, BASE_URL);
  const res = await helpers.safeWriteCodexConfigToml(cfg, broken, next, 'codex-lb');
  const after = await fs.readFile(cfg, 'utf8');
  const backups = (await fs.readdir(dir)).filter((f) => f.includes('.sks-codex-lb-unparseable-'));
  const ok = res.status === 'unparseable_config_preserved' && after === broken && backups.length >= 1;
  results.push({ case: 'unparseable_preserved_backed_up', ok, status: res.status });
}

// --- Case 4: idempotent — re-applying when already configured is a no-op ('present') ---
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-cdxlb-idem-'));
  const cfg = path.join(dir, 'config.toml');
  const seeded = helpers.upsertCodexLbConfig('', BASE_URL);
  await helpers.safeWriteCodexConfigToml(cfg, '', seeded, 'codex-lb');
  const cur = await fs.readFile(cfg, 'utf8');
  const next = helpers.upsertCodexLbConfig(cur, BASE_URL);
  const res = await helpers.safeWriteCodexConfigToml(cfg, cur, next, 'codex-lb');
  results.push({ case: 'idempotent_present', ok: res.status === 'present' && res.changed === false, status: res.status });
}

const ok = results.every((r) => r.ok);
if (!ok) {
  console.error(JSON.stringify({ ok: false, message: 'codex-lb config TOML-safety regression failed', results }, null, 2));
  process.exit(1);
}
emitGate('codex-lb:config-toml-safety', { cases: results.map((r) => r.case) });
