#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertGate, emitGate, makeTempRoot, writeText } from './skill-fixture-check-lib.js';
import { repairCodexStartupConfig } from '../core/doctor/codex-startup-config-repair.js';
import { MANAGED_OFFICIAL_SUBAGENT_ROLES } from '../core/managed-assets/managed-assets-manifest.js';
import { parse } from 'smol-toml';

const root = await makeTempRoot('sks-startup-config-blackbox-');
await writeText(path.join(root, '.codex', 'config.toml'), '# SKS managed Codex config fixture\n[agents.analysis_scout]\nconfig_file = ".codex/agents/stale.toml"\nmessage_role_prefix = "legacy"\n');
const report = await repairCodexStartupConfig({ root, apply: true, home: path.join(root, 'home'), codexHome: path.join(root, 'codex-home') });
const text = await fs.readFile(path.join(root, '.codex', 'config.toml'), 'utf8');
const parsed = parse(text);
const agents = (parsed as any).agents || {};
const files = (await fs.readdir(path.join(root, '.codex', 'agents'))).sort();
assertGate(report.ok === true, 'startup config blackbox must pass postcheck', report);
assertGate(agents.max_concurrent_threads_per_session === 12 && agents.max_threads === undefined && agents.max_depth === 1 && agents.interrupt_message === true && agents.enabled === true, 'startup config blackbox must persist official settings', agents);
const expectedRoleFiles = MANAGED_OFFICIAL_SUBAGENT_ROLES.map((role) => role.filename).sort();
assertGate(files.join(',') === expectedRoleFiles.join(','), 'startup config blackbox must create exactly the official managed role TOMLs', files);
assertGate(text.includes('config_file = ".codex/agents/stale.toml"') && text.includes('message_role_prefix = "legacy"'), 'startup config blackbox must preserve legacy compatibility tables', { text });
emitGate('doctor:startup-config-repair-blackbox');
