#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from '../core/fsx.js'
import { createMission } from '../core/mission.js'
import { MAD_SKS_SQL_PLANE_ACK, closeMadSksSqlPlaneCycle, createMadSksSqlPlaneCapability } from '../core/mad-sks/sql-plane/capability.js'
import { MadSksSqlPlaneMcpExecutor } from '../core/mad-sks/sql-plane/mcp-executor.js'
import { createMadSksSqlPlaneRuntimeProfile, closeMadSksSqlPlaneRuntimeProfile } from '../core/mad-sks/sql-plane/runtime-profile.js'
import { emitGate } from './gate-lib.js'

const requireReal = process.argv.includes('--require-real')
const projectRef = process.env.SKS_MAD_SKS_SQL_PLANE_E2E_PROJECT_REF || process.env.SKS_MAD_SKS_SQL_PLANE_PROJECT_REF || ''
const hasAuth = Boolean(process.env.SUPABASE_ACCESS_TOKEN || process.env.SKS_MAD_SKS_SQL_PLANE_SUPABASE_ACCESS_TOKEN)
if (!projectRef || !hasAuth) {
  const detail = {
    status: 'unverified',
    require_real: requireReal,
    missing_project_ref: !projectRef,
    missing_supabase_access_token: !hasAuth,
    required_env: ['SKS_MAD_SKS_SQL_PLANE_E2E_PROJECT_REF', 'SUPABASE_ACCESS_TOKEN or SKS_MAD_SKS_SQL_PLANE_SUPABASE_ACCESS_TOKEN']
  }
  console.error(JSON.stringify({ schema: 'sks.mad-sks-sql-plane-real-e2e.v1', ok: false, ...detail }, null, 2))
  process.exit(requireReal ? 2 : 0)
}

const root = tmpdir('sks-mad-sks-sql-plane-real-e2e-')
await fs.mkdir(path.join(root, '.codex'), { recursive: true })
await fs.writeFile(path.join(root, '.codex', 'config.toml'), `[mcp_servers.supabase]\nurl = "https://mcp.supabase.com/mcp?project_ref=${projectRef}&read_only=true"\n`)
const mission = await createMission(root, { mode: 'mad-sks', prompt: 'real disposable Supabase MAD-SKS SQL-plane E2E' })
const cycleId = `real-e2e-${Date.now().toString(36)}`
const profile = await createMadSksSqlPlaneRuntimeProfile({ root, missionId: mission.id, cycleId, projectRef, runtimeSessionId: 'real-e2e-session' })
await createMadSksSqlPlaneCapability(root, {
  missionId: mission.id,
  ack: MAD_SKS_SQL_PLANE_ACK,
  cwd: root,
  cycleId,
  projectRef,
  runtimeSessionId: 'real-e2e-session',
  profilePath: profile.profile_path,
  profileSha256: profile.profile_sha256,
  serverUrlRedacted: profile.server_url_redacted,
  status: 'active'
})

const executor = new MadSksSqlPlaneMcpExecutor(profile, { timeoutMs: Number(process.env.SKS_MAD_SKS_SQL_PLANE_E2E_TIMEOUT_MS || 120000) })
const suffix = Date.now().toString(36).replace(/[^a-z0-9]/g, '')
const table = `sks_mad_sks_sql_plane_e2e_${suffix}`
const migrationName = `sks_mad_sks_sql_plane_e2e_migration_${suffix}`
const steps: Array<{ name: string; tool: 'execute_sql' | 'apply_migration'; sql: string; verify: string }> = [
  {
    name: 'create_table',
    tool: 'execute_sql',
    sql: `create table public.${table} (id integer primary key, label text not null);`,
    verify: `select case when to_regclass('public.${table}') is not null then 1 else 1/0 end as ok;`
  },
  {
    name: 'add_column',
    tool: 'execute_sql',
    sql: `alter table public.${table} add column note text;`,
    verify: `select case when exists (select 1 from information_schema.columns where table_schema='public' and table_name='${table}' and column_name='note') then 1 else 1/0 end as ok;`
  },
  {
    name: 'insert',
    tool: 'execute_sql',
    sql: `insert into public.${table} (id, label, note) values (1, 'alpha', 'inserted');`,
    verify: `select case when (select count(*) from public.${table}) = 1 then 1 else 1/0 end as ok;`
  },
  {
    name: 'update',
    tool: 'execute_sql',
    sql: `update public.${table} set label = 'beta' where id = 1;`,
    verify: `select case when exists (select 1 from public.${table} where id=1 and label='beta') then 1 else 1/0 end as ok;`
  },
  {
    name: 'targeted_delete',
    tool: 'execute_sql',
    sql: `delete from public.${table} where id = 1;`,
    verify: `select case when (select count(*) from public.${table}) = 0 then 1 else 1/0 end as ok;`
  },
  {
    name: 'all_row_delete',
    tool: 'execute_sql',
    sql: `insert into public.${table} (id, label) values (2, 'two'), (3, 'three'); delete from public.${table};`,
    verify: `select case when (select count(*) from public.${table}) = 0 then 1 else 1/0 end as ok;`
  },
  {
    name: 'truncate',
    tool: 'execute_sql',
    sql: `insert into public.${table} (id, label) values (4, 'four'), (5, 'five'); truncate table public.${table};`,
    verify: `select case when (select count(*) from public.${table}) = 0 then 1 else 1/0 end as ok;`
  },
  {
    name: 'drop_column',
    tool: 'execute_sql',
    sql: `alter table public.${table} add column drop_me text; alter table public.${table} drop column drop_me;`,
    verify: `select case when not exists (select 1 from information_schema.columns where table_schema='public' and table_name='${table}' and column_name='drop_me') then 1 else 1/0 end as ok;`
  },
  {
    name: 'migration_apply',
    tool: 'apply_migration',
    sql: `alter table public.${table} add column migrated_flag boolean default false;`,
    verify: `select case when exists (select 1 from information_schema.columns where table_schema='public' and table_name='${table}' and column_name='migrated_flag') then 1 else 1/0 end as ok;`
  },
  {
    name: 'drop_table',
    tool: 'execute_sql',
    sql: `drop table public.${table};`,
    verify: `select case when to_regclass('public.${table}') is null then 1 else 1/0 end as ok;`
  }
]

const timings: number[] = []
const matrix: any[] = []
let inventory: any = null
let restoration: any = null
let failure: any = null
try {
  inventory = await executor.inventory()
  if (inventory.ok !== true) throw failureDetail('real Supabase MCP inventory must expose execute_sql and apply_migration', inventory)
  for (const step of steps) {
    const started = Date.now()
    const result = step.tool === 'apply_migration'
      ? await executor.applyMigration(`${migrationName}_${step.name}`, step.sql)
      : await executor.executeSql(step.sql)
    const verify = await executor.executeSql(step.verify)
    const elapsed = Date.now() - started
    timings.push(elapsed)
    matrix.push({ name: step.name, tool: step.tool, execute_ok: result.ok, verify_ok: verify.ok, duration_ms: elapsed, result_digest: result.result_digest, verify_digest: verify.result_digest })
    if (result.ok !== true || verify.ok !== true) throw failureDetail(`real MAD-SKS SQL-plane E2E step failed: ${step.name}`, matrix[matrix.length - 1])
  }
} catch (err: any) {
  failure = err?.detail || { message: err?.message || String(err) }
} finally {
  await executor.close()
  restoration = await closeMadSksSqlPlaneRuntimeProfile({ root, missionId: mission.id, profile, reason: 'real_e2e_finally' })
  await closeMadSksSqlPlaneCycle(root, mission.id, cycleId, 'real_e2e_finally')
}

if (failure) {
  console.error(JSON.stringify({
    schema: 'sks.mad-sks-sql-plane-real-e2e.v1',
    ok: false,
    status: 'failed_real_supabase',
    project_ref_hash: profile.project_ref_hash,
    failure,
    destructive_operation_matrix: matrix,
    read_only_restoration: restoration
  }, null, 2))
  process.exit(1)
}

timings.sort((a, b) => a - b)
const percentile = (p: number) => timings.length ? timings[Math.min(timings.length - 1, Math.floor((timings.length - 1) * p))] : 0
emitGate('mad-sks-sql-plane:real-e2e', {
  status: 'passed_real_supabase',
  project_ref_hash: profile.project_ref_hash,
  table_hash: table.slice(-10),
  inventory: { execute_sql_available: inventory?.execute_sql_available === true, apply_migration_available: inventory?.apply_migration_available === true, tool_count: inventory?.tool_names?.length || 0 },
  destructive_operation_matrix: matrix,
  timings_ms: { p50: percentile(0.5), p95: percentile(0.95), max: timings[timings.length - 1] || 0 },
  read_only_restoration: restoration
})

function failureDetail(message: string, detail: unknown) {
  const err: any = new Error(message)
  err.detail = { message, detail }
  return err
}
