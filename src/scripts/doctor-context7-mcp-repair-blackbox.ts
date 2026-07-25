#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertGate, emitGate, makeTempRoot, writeText } from './skill-fixture-check-lib.js';
import { repairContext7Mcp } from '../core/doctor/context7-mcp-repair.js';

const root = await makeTempRoot('sks-context7-blackbox-');
const configPath = path.join(root, '.codex', 'config.toml');
await writeText(configPath, '[mcp_servers.context7]\ncommand = "npx"\n');
const repaired = await repairContext7Mcp({ root, apply: true });
const text = await fs.readFile(configPath, 'utf8');
assertGate(repaired.ok === true && text.includes('https://mcp.context7.com/mcp'), 'Context7 blackbox must write remote URL', { repaired, text });
await writeText(configPath, '[mcp_servers.context7]\ndisabled = true\ncommand = "npx"\n');
const disabled = await repairContext7Mcp({ root, apply: true });
assertGate(disabled.after_transport === 'disabled' && disabled.repaired === false && disabled.disabled_preserved === true, 'Context7 blackbox must preserve explicitly disabled server', disabled);
emitGate('doctor:context7-mcp-repair-blackbox');
