#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertGate, emitGate, makeTempRoot, writeText } from './skill-fixture-check-lib.js';
import { writeManagedEnvConfig, writeManagedJsonConfig, writeManagedTomlConfig } from '../core/config/managed-config-merge.js';

const root = await makeTempRoot('sks-managed-merge-');
const envFile = path.join(root, '.env.local');
await writeText(envFile, 'NEXT_PUBLIC_SUPABASE_ANON_KEY=keep-me\n');
await writeManagedEnvConfig(envFile, await fs.readFile(envFile, 'utf8'), ['SKS_MANAGED=1', 'NEXT_PUBLIC_SUPABASE_ANON_KEY=replace-me']);
const envText = await fs.readFile(envFile, 'utf8');
const tomlFile = path.join(root, '.codex', 'config.toml');
const toml = await writeManagedTomlConfig(tomlFile, '[mcp.supabase]\n# keep this comment\ntoken = "keep-token"\nunknown = "keep-unknown"\n', ['[mcp.supabase]\nurl = "https://example.supabase.co"']);
const tomlAgain = await writeManagedTomlConfig(tomlFile, await fs.readFile(tomlFile, 'utf8'), ['[mcp.supabase]\nurl = "https://example.supabase.co"']);
const jsonFile = path.join(root, '.sneakoscope', 'config.json');
const json = await writeManagedJsonConfig(jsonFile, { supabase: { anon_key: 'keep-json', service_role_key: 'keep-service' }, mcp: { supabase: { token: 'keep-token-json' } } }, { supabase: { anon_key: 'replace-json', service_role_key: 'replace-service', url: 'x' }, mcp: { supabase: { token: 'replace-token-json', url: 'y' } } });
const jsonText = await fs.readFile(jsonFile, 'utf8');
const tomlText = await fs.readFile(tomlFile, 'utf8');
assertGate(envText.includes('keep-me') && !envText.includes('replace-me'), 'env merge must preserve protected secret line', envText);
assertGate(tomlText.includes('# keep this comment') && tomlText.includes('unknown = "keep-unknown"') && tomlText.includes('token = "keep-token"'), 'toml merge must preserve comments, unknown keys, and secret-bearing lines', tomlText);
assertGate(jsonText.includes('keep-json') && jsonText.includes('keep-service') && jsonText.includes('keep-token-json') && !jsonText.includes('replace-json') && !jsonText.includes('replace-service') && !jsonText.includes('replace-token-json'), 'json merge must preserve nested protected secret values', jsonText);
assertGate(toml.preserved_secret_lines_sha256.length > 0 && tomlAgain.changed === false, 'toml merge must report secret line hashes and be idempotent', { toml, tomlAgain });
assertGate(toml.ok && json.ok, 'managed config merge results must be ok', { toml, json });
emitGate('config:managed-merge');
