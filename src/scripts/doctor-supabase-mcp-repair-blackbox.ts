#!/usr/bin/env node
import path from 'node:path';
import { assertGate, emitGate, makeTempRoot, writeText } from './skill-fixture-check-lib.js';
import { repairSupabaseMcp } from '../core/doctor/supabase-mcp-repair.js';

const root = await makeTempRoot('sks-supabase-mcp-blackbox-');
delete process.env.SUPABASE_ACCESS_TOKEN;
await writeText(path.join(root, '.codex', 'config.toml'), '[mcp_servers.supabase]\nurl = "https://supabase.example/mcp"\nSUPABASE_ACCESS_TOKEN = "env:SUPABASE_ACCESS_TOKEN"\n');
const unsafe = await repairSupabaseMcp({ root, apply: true });
assertGate(unsafe.ok === true && unsafe.manual_required === true && unsafe.read_only_migrated === true && unsafe.ready_blocking === false, 'Supabase unsafe write access must be migrated to read-only without passing silently as write-ready', unsafe);
await writeText(path.join(root, '.codex', 'config.toml'), '[mcp_servers.supabase_sauron]\ndisabled = true\n');
const optional = await repairSupabaseMcp({ root, apply: true });
assertGate(optional.ok === true && optional.disabled === true && optional.disabled_preserved === true, 'optional disabled Supabase config must be preserved', optional);
emitGate('doctor:supabase-mcp-repair-blackbox');
