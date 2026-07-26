#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'smol-toml';
import { assertGate, emitGate, makeTempRoot, writeText } from './skill-fixture-check-lib.js';
import { repairCodexStartupConfig } from '../core/doctor/codex-startup-config-repair.js';
import { MANAGED_OFFICIAL_SUBAGENT_ROLES } from '../core/managed-assets/managed-assets-manifest.js';
import { repairContext7Mcp } from '../core/doctor/context7-mcp-repair.js';
import { repairSupabaseMcp } from '../core/doctor/supabase-mcp-repair.js';
import { runDoctorFixTransaction } from '../core/doctor/doctor-transaction.js';
import { doctorRepairPostcheck } from '../core/doctor/doctor-repair-postcheck.js';

const root = await makeTempRoot('sks-doctor-production-');
await writeText(path.join(root, '.codex', 'config.toml'), '# SKS-MANAGED-CODEX-CONFIG\n[mcp_servers.context7]\ncommand = "npx"\n\n[mcp_servers.supabase]\nurl = "https://supabase.example/mcp"\nread_only = true\n\n[agents.analysis_scout]\nconfig_file = ".codex/agents/stale.toml"\nmessage_role_prefix = "legacy"\n');
const startup = await repairCodexStartupConfig({ root, apply: true, home: path.join(root, 'home'), codexHome: path.join(root, 'codex-home') });
const startupText = await fs.readFile(path.join(root, '.codex', 'config.toml'), 'utf8');
const startupConfig = parse(startupText);
const startupAgents = (startupConfig as any).agents || {};
const startupAgentFiles = (await fs.readdir(path.join(root, '.codex', 'agents'))).sort();
assertGate(startup.ok === true, 'doctor production startup repair must pass', startup);
assertGate((startupAgents.max_concurrent_threads_per_session === 12 || startupAgents.max_threads === 12) && startupAgents.max_depth === 1 && startupAgents.interrupt_message === true && startupAgents.enabled === true, 'doctor production startup repair must write official config defaults', startupAgents);
const expectedRoleFiles = MANAGED_OFFICIAL_SUBAGENT_ROLES.map((role) => role.filename).sort();
assertGate(startupAgentFiles.join(',') === expectedRoleFiles.join(','), 'doctor production startup repair must create exactly the official managed role TOMLs', startupAgentFiles);
assertGate(startupText.includes('[agents.analysis_scout]') && startupText.includes('config_file = ".codex/agents/stale.toml"'), 'doctor production startup repair must preserve legacy config tables', startupText);
const context7 = await repairContext7Mcp({ root, apply: true });
const supabase = await repairSupabaseMcp({ root, apply: true });
const tx = await runDoctorFixTransaction({ root, phases: [
  { id: 'preflight', run: async () => ({ id: 'preflight', ok: true }) },
  { id: 'codex_startup_config_repair', run: async () => ({ id: 'codex_startup_config_repair', ok: startup.ok, repaired: true, blockers: startup.blockers, rollback_evidence: 'fixture_config_backup' }) },
  { id: 'context7_mcp_repair', run: async () => ({ id: 'context7_mcp_repair', ok: context7.ok, repaired: context7.repaired, blockers: context7.blockers, rollback_evidence: 'fixture_context7_backup' }) },
  { id: 'supabase_mcp_repair', required_for_ready: false, run: async () => ({ id: 'supabase_mcp_repair', ok: supabase.ok, manual_required: supabase.manual_required, required_for_ready: false, blockers: supabase.blockers, warnings: supabase.warnings, rollback_evidence: 'optional_supabase_fixture' }) },
  { id: 'postcheck', run: async () => ({ id: 'postcheck', ok: true }) }
] });
const postcheck = doctorRepairPostcheck(tx);
assertGate(tx.schema === 'sks.doctor-fix-transaction.v2' && tx.raw_secret_values_recorded === false, 'doctor transaction must write production schema without raw secrets', tx);
assertGate(tx.phases.every((phase) => typeof phase.duration_ms === 'number' && phase.started_at && phase.completed_at), 'doctor transaction phases must include runtime evidence', tx);
assertGate(postcheck.ok === true, 'doctor repair postcheck must pass when only manual-required optional phases remain', postcheck);
emitGate('doctor:fix-production-blackbox', { phases: tx.phases.length });
