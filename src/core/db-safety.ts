import path from 'node:path';
import { exists, readJson, writeJsonAtomic, readText, nowIso, appendJsonlBounded, sha256 } from './fsx.js';
import { missionDir, setCurrent } from './mission.js';
import { evaluateMadSksPermissionGate, isMadSksRouteState } from './permission-gates.js';
import { resolveMadSksSqlPlaneMutationPolicy } from './mad-sks/sql-plane/policy-resolver.js';
import { appendMadSksSqlPlaneLedgerEvent } from './mad-sks/sql-plane/ledger.js';
import { lifecycleHookFromUnknown, type MadSksSqlPlaneLifecycleHook } from './mad-sks/sql-plane/result-lifecycle.js';
import { extractCanonicalToolCallId, reserveMadSksSqlPlaneOperation, transitionMadSksSqlPlaneOperation } from './mad-sks/sql-plane/operation-store.js';
import { madSksSqlPlaneOperationClassesFromClassification } from './mad-sks/sql-plane/policy.js';
import { MAD_SKS_SQL_PLANE_CAPABILITY_FILE, madSksSqlPlaneRelativePath } from './mad-sks/sql-plane/paths.js';

export const DEFAULT_DB_SAFETY_POLICY = Object.freeze({
  schema_version: 1,
  mode: 'read_only_default',
  destructive_operations: 'deny_without_active_mad_sks_sql_plane_capability',
  production_writes: 'deny_without_active_mad_sks_sql_plane_capability',
  mcp_live_writes: 'deny_by_default',
  require_project_scoped_mcp: true,
  require_read_only_mcp_for_real_data: true,
  require_branch_or_local_for_writes: true,
  require_migration_files_for_schema_changes: true,
  require_backup_or_branch_for_any_write: true,
  block_direct_execute_sql_writes: true,
  safe_supabase_mcp_url: 'https://mcp.supabase.com/mcp?project_ref=<project_ref>&read_only=true&features=database,docs',
  max_select_limit_recommendation: 1000,
  always_block_sql_patterns: [
    'drop', 'truncate', 'delete_without_where', 'update_without_where', 'alter_drop', 'create_or_replace',
    'grant', 'revoke', 'disable_rls', 'drop_policy', 'drop_extension', 'drop_schema', 'drop_database'
  ],
  always_block_tools: [
    'delete_project', 'pause_project', 'restore_project', 'delete_branch', 'reset_branch', 'merge_branch',
    'supabase db reset', 'supabase db push', 'supabase migration repair'
  ]
});

const MAD_SKS_GATE_FILE = 'mad-sks-gate.json';
const MAD_SKS_TABLE_DELETE_CONFIRMATION_FILE = 'mad-sks-table-delete-confirmation.json';
const MAD_SKS_TABLE_DELETE_TIMEOUT_MS = 30_000;

export async function ensureDbSafetyPolicy(root: any) {
  const p = path.join(root, '.sneakoscope', 'db-safety.json');
  if (!(await exists(p))) await writeJsonAtomic(p, DEFAULT_DB_SAFETY_POLICY);
  return p;
}

export async function loadDbSafetyPolicy(root: any) {
  const p = path.join(root, '.sneakoscope', 'db-safety.json');
  const data = await readJson(p, {});
  return { ...DEFAULT_DB_SAFETY_POLICY, ...(data || {}) };
}

export function safeSupabaseMcpConfig({ projectRef = '<project_ref>', readOnly = true, features = 'database,docs' }: any = {}) {
  const qs = new URLSearchParams();
  if (projectRef) qs.set('project_ref', projectRef);
  if (readOnly) qs.set('read_only', 'true');
  if (features) qs.set('features', features);
  return {
    mcpServers: {
      supabase: {
        type: 'http',
        url: `https://mcp.supabase.com/mcp?${qs.toString()}`
      }
    }
  };
}

function stripSqlComments(sql: any = '') {
  return String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n\r]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function norm(s: any = '') { return stripSqlComments(s).toLowerCase(); }

function stripSqlStringLiterals(sql: any = '') {
  let out = '';
  let quote = null;
  for (let i = 0; i < String(sql).length; i++) {
    const ch = sql[i];
    if ((ch === "'" || ch === '"') && sql[i - 1] !== '\\') {
      quote = quote === ch ? null : (quote || ch);
      out += ' ';
      continue;
    }
    out += quote ? ' ' : ch;
  }
  return out;
}

export function splitSqlStatements(sql: any = '') {
  const text = stripSqlComments(sql);
  const out: any[] = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    current += ch;
    if ((ch === "'" || ch === '"') && text[i - 1] !== '\\') quote = quote === ch ? null : (quote || ch);
    if (ch === ';' && !quote) { out.push(current.trim()); current = ''; }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function hasWhere(stmt: any) { return /\bwhere\b/i.test(stmt); }
function hasLimit(stmt: any) { return /\blimit\s+\d+\b/i.test(stmt); }
function isReadOnly(stmt: any) {
  const s = stripSqlStringLiterals(norm(stmt));
  return /^(select|with|show|explain|describe)\b/.test(s) && !/(\binsert\b|\bupdate\b|\bdelete\b|\bdrop\b|\btruncate\b|\balter\b|\bcreate\b|\bgrant\b|\brevoke\b)/.test(s);
}

export function classifySql(sql: any = '') {
  const statements = splitSqlStatements(sql);
  if (!statements.length) return { level: 'none', kind: 'none', reasons: [], statements: [] };
  const reasons: any[] = [];
  let level = 'safe';
  let kind = 'read';
  for (const stmtRaw of statements) {
    const stmt = stripSqlStringLiterals(norm(stmtRaw));
    if (!stmt) continue;
    const destructiveChecks: Array<[RegExp, string]> = [
      [/\bdrop\s+database\b/, 'drop_database'],
      [/\bdrop\s+schema\b/, 'drop_schema'],
      [/\bdrop\s+table\b/, 'drop_table'],
      [/\bdrop\s+view\b/, 'drop_view'],
      [/\bdrop\s+materialized\s+view\b/, 'drop_materialized_view'],
      [/\bdrop\s+extension\b/, 'drop_extension'],
      [/\bdrop\s+policy\b/, 'drop_policy'],
      [/\bdrop\b/, 'drop_statement'],
      [/\btruncate\b/, 'truncate'],
      [/\balter\s+table\b[\s\S]*\bdrop\b/, 'alter_table_drop'],
      [/\balter\s+table\b[\s\S]*\brename\b/, 'alter_table_rename'],
      [/\bdelete\s+from\b(?![\s\S]*\bwhere\b)/, 'delete_without_where'],
      [/\bupdate\b[\s\S]*\bset\b(?![\s\S]*\bwhere\b)/, 'update_without_where'],
      [/\bcreate\s+or\s+replace\b/, 'create_or_replace'],
      [/\bdisable\s+row\s+level\s+security\b|\bdisable\s+rls\b/, 'disable_rls'],
      [/\bgrant\b/, 'grant'],
      [/\brevoke\b/, 'revoke']
    ];
    for (const [re, reason] of destructiveChecks) {
      if (re.test(stmt)) { reasons.push(reason); level = 'destructive'; kind = 'destructive'; }
    }
    if (/\bdelete\s+from\b/.test(stmt) && hasWhere(stmt) && level !== 'destructive') { reasons.push('delete_with_where'); level = 'write'; kind = 'dml'; }
    if (/\bupdate\b[\s\S]*\bset\b/.test(stmt) && hasWhere(stmt) && level !== 'destructive') { reasons.push('update_with_where'); level = 'write'; kind = 'dml'; }
    if (/\binsert\s+into\b|\bupsert\b/.test(stmt) && level !== 'destructive') { reasons.push('insert_or_upsert'); level = 'write'; kind = 'dml'; }
    if (/\bcreate\s+(table|index|schema|view|function|policy|extension)\b|\balter\s+table\b/.test(stmt) && level !== 'destructive') { reasons.push('schema_change'); level = 'write'; kind = 'ddl'; }
    if (/\bcopy\b[\s\S]*\bfrom\b/.test(stmt) && level !== 'destructive') { reasons.push('bulk_copy_from'); level = 'write'; kind = 'bulk'; }
    if (!isReadOnly(stmtRaw) && level === 'safe') { reasons.push('non_readonly_or_unknown_sql'); level = 'write'; kind = 'unknown_write'; }
    if (isReadOnly(stmtRaw) && !hasLimit(stmtRaw) && /^\s*select\s+\*/i.test(stmtRaw)) reasons.push('select_star_without_limit');
  }
  return { level, kind, reasons: [...new Set(reasons)], statements };
}

export function classifyCommand(command: any = '') {
  const c = String(command);
  const low = c.toLowerCase();
  const reasons: any[] = [];
  if (!low.trim()) return { level: 'none', kind: 'none', reasons: [], command: c };
  const supabaseMigrationApply: any[] = [];
  if (/\bsupabase\s+migration\s+up\b/.test(low)) supabaseMigrationApply.push('supabase_migration_up', 'supabase_migration_apply');
  if (/\bsupabase\s+db\s+push\b/.test(low)) supabaseMigrationApply.push('supabase_db_push', 'supabase_migration_apply');
  const supabaseMigrationRead: any[] = [];
  if (/\bsupabase\s+db\s+(diff|pull)\b/.test(low)) supabaseMigrationRead.push('supabase_migration_schema_read');
  if (/\bsupabase\s+migration\s+(list|new|squash)\b/.test(low)) supabaseMigrationRead.push('supabase_migration_file_work');
  const hard: Array<[RegExp, string]> = [
    [/\bsupabase\s+db\s+reset\b/, 'supabase_db_reset'],
    [/\bsupabase\s+migration\s+repair\b/, 'supabase_migration_repair'],
    [/\bprisma\s+migrate\s+reset\b/, 'prisma_migrate_reset'],
    [/\bprisma\s+db\s+push\b/, 'prisma_db_push'],
    [/\bdrizzle-kit\s+push\b/, 'drizzle_push'],
    [/\bsequelize\s+db:migrate:undo/, 'sequelize_migrate_undo'],
    [/\bknex\s+migrate:rollback\b/, 'knex_migrate_rollback'],
    [/\b(dropdb|createdb)\b/, 'postgres_database_admin_command']
  ];
  for (const [re, reason] of hard) if (re.test(low)) reasons.push(reason);
  const maybeSql = extractSqlLiterals(c).join('\n');
  const sqlClass = maybeSql ? classifySql(maybeSql) : { level: 'none', kind: 'none', reasons: [] };
  if (reasons.length) return { level: 'destructive', kind: 'db_command', reasons, sql: sqlClass, command: c };
  if (supabaseMigrationApply.length) {
    const level = sqlClass.level === 'destructive' ? 'destructive' : 'write';
    return {
      level,
      kind: 'db_migration',
      reasons: [...new Set([...supabaseMigrationApply, ...(sqlClass.reasons || [])])],
      sql: sqlClass,
      command: c
    };
  }
  if (supabaseMigrationRead.length && !['write', 'destructive'].includes(sqlClass.level)) {
    return {
      level: 'safe',
      kind: 'db_migration',
      reasons: [...new Set([...supabaseMigrationRead, ...(sqlClass.reasons || [])])],
      sql: sqlClass,
      command: c
    };
  }
  if (/\b(psql|supabase|prisma|drizzle-kit|knex|sequelize)\b/.test(low)) {
    if (sqlClass.level === 'destructive' || sqlClass.level === 'write') return { level: sqlClass.level, kind: 'db_command', reasons: sqlClass.reasons, sql: sqlClass, command: c };
    return { level: sqlClass.level === 'safe' ? 'safe' : 'possible_db', kind: 'db_command', reasons: sqlClass.reasons, sql: sqlClass, command: c };
  }
  return { level: sqlClass.level, kind: sqlClass.kind, reasons: sqlClass.reasons, sql: sqlClass, command: c };
}

function extractSqlLiterals(command: any = '') {
  const out: any[] = [];
  const patterns = [
    /-c\s+(['"])([\s\S]*?)\1/g,
    /--command\s+(['"])([\s\S]*?)\1/g,
    /--sql\s+(['"])([\s\S]*?)\1/g
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(command))) out.push(m[2]);
  }
  if (looksLikeSqlText(command)) out.push(command);
  return out;
}

function recursivelyCollectStrings(obj: any, out: any = [], depth: any = 0) {
  if (depth > 8 || obj == null) return out;
  if (typeof obj === 'string') { out.push(obj); return out; }
  if (Array.isArray(obj)) { for (const x of obj) recursivelyCollectStrings(x, out, depth + 1); return out; }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (/^(sql|query|statement|command|migration|body|input|text|action|purpose|intent|description)$/i.test(k) || typeof v === 'object') recursivelyCollectStrings(v, out, depth + 1);
    }
  }
  return out;
}

function looksLikeSqlText(text: any = '') {
  const s = stripSqlComments(text).trim();
  return /^(select|with|show|explain|describe|insert|update|delete|drop|truncate|alter|create|grant|revoke)\b/i.test(s)
    || /;\s*(select|with|show|explain|describe|insert|update|delete|drop|truncate|alter|create|grant|revoke)\b/i.test(s);
}

function hasReadOnlyDbInspectionIntent(text: any = '') {
  const s = String(text || '').toLowerCase();
  if (/\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|write|mutate|migration|apply|push|reset|repair)\b|삭제|수정|변경|쓰기|삽입|생성|초기화|적용/i.test(s)) return false;
  return /\b(read.?only|select|with|show|explain|describe|inspect|list|get|fetch|count|schema)\b|조회|확인|읽|보기|목록|스키마/i.test(s);
}

export function classifyToolPayload(payload: any = {}) {
  const strings = recursivelyCollectStrings(payload).slice(0, 200);
  const toolName = [payload.tool_name, payload.toolName, payload.name, payload.tool?.name, payload.server, payload.mcp_tool, payload.tool, payload.type].filter(Boolean).join(' ').toLowerCase();
  const combined = strings.filter(looksLikeSqlText).join('\n');
  const sqlClass = classifySql(combined);
  const commandClass = classifyCommand(strings.find((s: any) => /\b(supabase|psql|prisma|drizzle|knex|sequelize)\b/i.test(s)) || '');
  const toolReasons: any[] = [];
  const reasons: any[] = [];
  if (/\b(apply_patch|edit|write|create|remove|rename|str_replace|file_write|fs_write)\b/i.test(toolName) && !/supabase|postgres|database|execute_sql|apply_migration|sql_query|db_|_db\b|migration/.test(toolName)) {
    return { level: 'none', toolName, toolReasons, reasons, sql: sqlClass, command: commandClass, stringsExamined: strings.length };
  }
  if (/supabase|postgres|database|execute_sql|apply_migration|sql_query|db_|_db\b|migration/.test(toolName)) toolReasons.push('database_tool');
  if (/apply_migration|migration_apply/i.test(toolName)) {
    toolReasons.push('migration_apply_tool');
    reasons.push('supabase_migration_apply');
  }
  if (/delete_project|pause_project|restore_project|delete_branch|reset_branch|merge_branch/.test(toolName)) toolReasons.push('dangerous_supabase_management_tool');
  let level = 'none';
  for (const candidate of [sqlClass.level, commandClass.level]) {
    if (candidate === 'destructive') level = 'destructive';
    else if (candidate === 'write' && level !== 'destructive') level = 'write';
    else if ((candidate === 'safe' || candidate === 'possible_db') && level === 'none') level = candidate;
  }
  if (toolReasons.includes('dangerous_supabase_management_tool')) level = 'destructive';
  if (toolReasons.includes('migration_apply_tool') && level !== 'destructive') level = 'write';
  if (toolReasons.includes('database_tool') && level === 'none') {
    if (hasReadOnlyDbInspectionIntent([toolName, ...strings].join(' '))) {
      level = 'safe';
      reasons.push('read_only_database_inspection_intent');
    } else {
      level = 'possible_db';
    }
  }
  return { level, toolName, toolReasons, reasons, sql: sqlClass, command: commandClass, stringsExamined: strings.length };
}

function contractAllowsDbWrite(contract: any = {}) {
  const hc = contract.hard_constraints || {};
  const mode = hc.database_write_mode || hc.db_write_mode || contract.answers?.DATABASE_WRITE_MODE || 'read_only_only';
  const env = hc.database_target_environment || contract.answers?.DATABASE_TARGET_ENVIRONMENT || 'no_database';
  const destructive = hc.destructive_db_operations_allowed === true || contract.answers?.DESTRUCTIVE_DB_OPERATIONS_ALLOWED === 'yes';
  const migrationApply = contract.answers?.DB_MIGRATION_APPLY_ALLOWED || 'no';
  return { mode, env, destructive, migrationApply };
}

function hasTableRemovalRisk(cls: any = {}) {
  const reasons = new Set([
    ...(cls.reasons || []),
    ...(cls.sql?.reasons || []),
    ...(cls.command?.reasons || [])
  ]);
  return ['drop_table', 'truncate'].some((reason: any) => reasons.has(reason));
}

export function evaluateDbSafety({ classification, policy = DEFAULT_DB_SAFETY_POLICY, contract = null, duringNoQuestion = false, madSks = null }: any = {}) {
  const cls = classification || { level: 'none', reasons: [] };
  const noQuestion = Boolean(duringNoQuestion);
  const reasons: any[] = [];
  const effective = contractAllowsDbWrite(contract || {});
  if (cls.level === 'none') return { allowed: true, action: 'allow', reasons: [], classification: cls };
  if (cls.level === 'safe') return { allowed: true, action: 'allow', reasons: ['read_only_operation'], classification: cls };
  if (cls.level === 'possible_db') return { allowed: !noQuestion, action: noQuestion ? 'block' : 'warn', reasons: noQuestion ? ['unknown_database_operation_blocked_during_no_question_run'] : ['unknown_database_operation'], classification: cls };
  if (madSks?.active && (cls.level === 'write' || cls.level === 'destructive')) {
    const madGate = evaluateMadSksPermissionGate({ classification: cls, active: true });
    if (!madGate.allowed) {
      return {
        allowed: false,
        action: 'block',
        reasons: madGate.reasons,
        classification: cls,
        effective,
        mad_sks: {
          active: true,
          catastrophic_safety_guard_active: true,
          blocked_categories: madGate.blocked_categories,
          permission_profile: madGate.profile
        }
      };
    }
    return {
      allowed: true,
      action: 'allow',
      reasons: madGate.reasons,
      classification: cls,
      effective,
      mad_sks: {
        active: true,
        sks_db_constraints_removed: true,
        catastrophic_safety_guard_active: true,
        supabase_mcp_schema_cleanup_allowed: true,
        live_server_writes_allowed: true,
        permission_profile: madGate.profile
      }
    };
  }
  if (cls.level === 'destructive') reasons.push('destructive_database_operation_blocked_always');
  if (cls.level === 'write') {
    const reasonSet = new Set([
      ...(cls.reasons || []),
      ...(cls.sql?.reasons || []),
      ...(cls.command?.reasons || [])
    ]);
    if (reasonSet.has('supabase_db_push')) reasons.push('supabase_db_push_requires_active_mad_sks');
    if (effective.mode === 'read_only_only') reasons.push('database_write_mode_is_read_only_only');
    if (effective.env === 'production' || effective.env === 'production_read_only') reasons.push('production_database_writes_forbidden');
    if (!['local_dev', 'preview_branch', 'supabase_branch'].includes(effective.env)) reasons.push('database_write_target_not_local_or_branch');
    if (policy.block_direct_execute_sql_writes && cls.toolReasons?.includes?.('database_tool')) reasons.push('direct_mcp_execute_sql_writes_blocked');
    reasons.push('database_mutation_requires_manual_sql_or_active_mad_sks_sql_plane');
  }
  if (effective.destructive) reasons.push('contract_attempted_to_allow_destructive_but_policy_denies');
  if (reasons.length) return { allowed: false, action: 'block', reasons, classification: cls, effective };
  return { allowed: true, action: 'allow', reasons: ['write_allowed_by_contract_to_safe_target'], classification: cls, effective };
}

async function writeMadSksTableDeletePending(root: any, state: any = {}, decision: any = {}) {
  if (!state?.mission_id) return null;
  const dir = missionDir(root, state.mission_id);
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + MAD_SKS_TABLE_DELETE_TIMEOUT_MS).toISOString();
  const pending = {
    schema_version: 1,
    status: 'pending',
    mission_id: state.mission_id,
    created_at: createdAt,
    expires_at: expiresAt,
    timeout_ms: MAD_SKS_TABLE_DELETE_TIMEOUT_MS,
    reason: 'table_delete_requires_explicit_user_confirmation',
    classification: decision.classification || null
  };
  await writeJsonAtomic(path.join(dir, MAD_SKS_TABLE_DELETE_CONFIRMATION_FILE), pending);
  await appendJsonlBounded(path.join(dir, 'mad-sks-confirmation.jsonl'), pending);
  return pending;
}

function looksLikeConfirmationYes(prompt: any = '') {
  return /^(yes|y|confirm|confirmed|approve|approved|proceed|continue|ok|okay|네|예|응|허용|승인|진행|계속|삭제\s*허용|테이블\s*삭제\s*허용)(?=$|\s|[.!?。！？,，])/i.test(String(prompt || '').trim());
}

function looksLikeConfirmationNo(prompt: any = '') {
  return /^(no|n|stop|abort|cancel|deny|denied|아니|아니요|중단|취소|거부|멈춰)(?=$|\s|[.!?。！？,，])/i.test(String(prompt || '').trim());
}

export async function handleMadSksUserConfirmation(root: any, state: any = {}, prompt: any = '') {
  if (!isMadSksRouteState(state) || !state?.mission_id) return null;
  const file = path.join(missionDir(root, state.mission_id), MAD_SKS_TABLE_DELETE_CONFIRMATION_FILE);
  const pending = await readJson(file, null);
  if (!pending || pending.status !== 'pending') return null;
  const expiresAtMs = Date.parse(pending.expires_at || '');
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    const expired = { ...pending, status: 'expired', resolved_at: nowIso() };
    await writeJsonAtomic(file, expired);
    await appendJsonlBounded(path.join(missionDir(root, state.mission_id), 'mad-sks-confirmation.jsonl'), expired);
    return {
      handled: true,
      additionalContext: 'MAD-SKS table deletion confirmation expired after about 30 seconds. Abort the table deletion operation and do not retry it unless the user invokes a new explicit confirmation flow.'
    };
  }
  if (looksLikeConfirmationNo(prompt)) {
    const denied = { ...pending, status: 'denied', resolved_at: nowIso() };
    await writeJsonAtomic(file, denied);
    await appendJsonlBounded(path.join(missionDir(root, state.mission_id), 'mad-sks-confirmation.jsonl'), denied);
    return {
      handled: true,
      additionalContext: 'MAD-SKS table deletion confirmation was denied. Abort the table deletion operation and continue only with non-table-deletion work.'
    };
  }
  if (!looksLikeConfirmationYes(prompt)) return null;
  const confirmedUntil = new Date(Math.min(expiresAtMs, Date.now() + MAD_SKS_TABLE_DELETE_TIMEOUT_MS)).toISOString();
  const accepted = { ...pending, status: 'accepted', resolved_at: nowIso(), confirmed_until: confirmedUntil };
  await writeJsonAtomic(file, accepted);
  await appendJsonlBounded(path.join(missionDir(root, state.mission_id), 'mad-sks-confirmation.jsonl'), accepted);
  await setCurrent(root, {
    ...state,
    mad_sks_active: true,
    mad_sks_table_delete_confirmed_until: confirmedUntil
  }, { sessionKey: state._session_key });
  return {
    handled: true,
    additionalContext: `MAD-SKS table deletion confirmation accepted until ${confirmedUntil}. Retry the exact table deletion only if it is still required; otherwise continue without using the confirmation.`
  };
}

export async function loadMissionContract(root: any, state: any = {}) {
  if (!state?.mission_id) return null;
  const p = path.join(missionDir(root, state.mission_id), 'decision-contract.json');
  if (!(await exists(p))) return null;
  return readJson(p, null);
}

export async function checkDbOperation(root: any, state: any, payload: any, { duringNoQuestion = false }: any = {}) {
  const policy = await loadDbSafetyPolicy(root);
  const contract = await loadMissionContract(root, state);
  const classification = classifyToolPayload(payload);
  const madSksSqlPlane: any = await resolveMadSksSqlPlaneMutationPolicy(root, state, classification);
  if (madSksSqlPlane.allowed === true && madSksSqlPlane.mission_id) {
    const madSksSqlPlaneDecision = madSksSqlPlane;
    const madSksSqlPlaneMissionId = String(madSksSqlPlaneDecision.mission_id);
    const sqlText = classification.sql?.statements?.length ? String(classification.sql.statements.join('\n')) : null;
    const sqlHash = sqlText ? sha256(sqlText) : null;
    const toolCallId = extractCanonicalToolCallId(payload) || `payload-${sha256(JSON.stringify({ tool: classification.toolName || '', sqlHash, level: classification.level })).slice(0, 16)}`;
    const operationClasses = madSksSqlPlaneDecision.operation_classes?.length ? madSksSqlPlaneDecision.operation_classes : madSksSqlPlaneOperationClassesFromClassification(classification);
    const reservation = await reserveMadSksSqlPlaneOperation({
      root,
      missionId: madSksSqlPlaneMissionId,
      capability: madSksSqlPlaneDecision.capability,
      toolCallId,
      toolName: classification.toolName || 'unknown_database_tool',
      sql: sqlText,
      operationClasses
    });
    await transitionMadSksSqlPlaneOperation({
      root,
      missionId: madSksSqlPlaneMissionId,
      toolCallId,
      state: 'started'
    });
    const lifecycleHook: MadSksSqlPlaneLifecycleHook = {
      mission_id: madSksSqlPlaneMissionId,
      operation_id: reservation.operation.operation_id,
      tool_call_id: toolCallId,
      cycle_id: madSksSqlPlaneDecision.cycle_id || null,
      tool_name: classification.toolName || null,
      sql_hash: sqlHash,
      destructive: classification.level === 'destructive'
    };
    const decision = {
      allowed: true,
      action: 'allow',
      reasons: madSksSqlPlane.reasons,
      classification,
      effective: { mode: 'mad-sks-sql-plane-active', env: 'operator_authorized_one_cycle', destructive: true, migrationApply: 'yes' },
      mad_sks_sql_plane: {
        active: true,
        priority: 'highest',
        capability_schema: 'sks.mad-sks-sql-plane-capability.v2',
        one_cycle_only: true,
        cycle_id: madSksSqlPlaneDecision.cycle_id,
        capability_file: madSksSqlPlaneRelativePath(MAD_SKS_SQL_PLANE_CAPABILITY_FILE),
        status: reservation.capability.status,
        operation_id: reservation.operation.operation_id,
        tool_call_id: toolCallId,
        tool_call_id_missing: extractCanonicalToolCallId(payload) === null,
        lifecycle_result_pending: true,
        ledger_result_hook: lifecycleHook,
        operation_classes: operationClasses,
        state_source: madSksSqlPlaneDecision.state_source || 'hook_state',
        counters: reservation.capability.counters,
        idempotent_reservation_reused: reservation.reused
      }
    };
    await appendMadSksSqlPlaneLedgerEvent(root, madSksSqlPlaneMissionId, { type: 'db_mutation.allowed', cycle_id: madSksSqlPlaneDecision.cycle_id, mode: madSksSqlPlaneDecision.mode, classification, operation_id: reservation.operation.operation_id, tool_call_id: toolCallId });
    await appendJsonlBounded(path.join(missionDir(root, madSksSqlPlaneMissionId), 'db-safety.jsonl'), { ts: nowIso(), decision });
    return decision;
  }
  const decision = evaluateDbSafety({ classification, policy, contract, duringNoQuestion, madSks: null });
  if (isMadSksRouteState(state) && ['write', 'destructive'].includes(classification.level)) {
    decision.reasons = [...new Set([
      ...(decision.reasons || []),
      'mad_sks_sql_plane_capability_v2_required'
    ])];
    decision.allowed = false;
    decision.action = 'block';
  }
  if (decision.action === 'confirm') await writeMadSksTableDeletePending(root, state, decision);
  if (decision.action !== 'allow' && state?.mission_id) {
    await appendJsonlBounded(path.join(missionDir(root, state.mission_id), 'db-safety.jsonl'), { ts: nowIso(), decision });
  }
  return decision;
}

export function madSksSqlPlaneLifecycleHookFromDecision(decision: any): MadSksSqlPlaneLifecycleHook | null {
  return lifecycleHookFromUnknown(decision)
}

export async function checkSqlFile(file: any) {
  const sql = await readText(file);
  return classifySql(sql);
}

export function dbBlockReason(decision: any) {
  if ((decision.reasons || []).includes('mad_sks_catastrophic_db_operation_blocked')) {
    return [
      'Sneakoscope Codex MAD-SKS catastrophic database safeguard blocked this operation.',
      'MAD-SKS opens live-server changes, Supabase MCP column/schema cleanup, direct execute SQL, migrations when required, and normal DB writes only while the mission gate is active.',
      'Whole database/table removal, all-row value wipes, database reset, and dangerous project or branch management remain blocked.'
    ].join(' ');
  }
  if ((decision.reasons || []).includes('mad_sks_table_delete_requires_user_confirmation_30s')) {
    return [
      'Sneakoscope Codex MAD-SKS gate paused a table deletion operation.',
      'Explicit user confirmation is required for table deletion, even in MAD-SKS mode.',
      'Ask the user to confirm now; if no confirmation arrives within about 30 seconds, abort this operation.',
      'After confirmation, retry only the same table deletion while the short confirmation window is still valid.'
    ].join(' ');
  }
  return [
    'Sneakoscope Codex Database Safety Gate blocked this operation.',
    `Reasons: ${(decision.reasons || []).join(', ') || 'unknown'}.`,
    'Default DB mode is read-only. If a migration is required outside MAD-SKS, create one mission-local manual-migration.sql with forward SQL and an inactive rollback section, then ask the user to apply it manually.',
    'All live database mutations require an explicit active MAD-SKS SQL-plane capability v2 opened by $MAD-SKS or sks mad-sks sql|apply-migration.',
    'Use read-only/project-scoped Supabase MCP URLs outside MAD-SKS SQL-plane. Supabase project/account/billing/credential control-plane operations remain denied even there.'
  ].join(' ');
}

export async function scanDbSafety(root: any, opts: any = {}) {
  const findings: any[] = [];
  findings.push(...await scanSupabaseMcpConfigs(root));
  if (opts.includeMigrations) findings.push(...await scanMissionMigrationFiles(root, opts));
  const ok = !findings.some((f: any) => ['critical', 'high'].includes(f.severity));
  const report = { checked_at: nowIso(), ok, findings };
  await writeJsonAtomic(path.join(root, '.sneakoscope', 'db-safety-scan.json'), report).catch(() => {});
  return report;
}

async function scanSupabaseMcpConfigs(root: any) {
  const files = ['.codex/config.toml', '.cursor/mcp.json', '.windsurf/mcp_config.json', '.vscode/mcp.json', '.mcp.json', 'mcp.json', 'claude_desktop_config.json'];
  const findings: any[] = [];
  for (const name of files) {
    const file = path.join(root, name);
    if (!(await exists(file))) continue;
    const text = await readText(file, '');
    if (!/supabase|mcp\.supabase\.com/i.test(text)) continue;
    const urls = extractSupabaseMcpUrls(text);
    if (!urls.length) {
      findings.push({ id: 'supabase_mcp_unparsed', severity: 'medium', file: rel(root, file), reason: 'Supabase MCP reference found but URL could not be parsed. Verify read_only=true, project_ref, and restricted features manually.' });
      continue;
    }
    for (const url of urls) findings.push(...checkSupabaseMcpUrl(url).map((x: any) => ({ ...x, file: rel(root, file), url: redactUrl(url) })));
  }
  return findings;
}

function extractSupabaseMcpUrls(text: any) {
  const out = new Set();
  // Config files (TOML/JSON) always quote URL values, so a closing quote or
  // whitespace is the only reliable terminator. A comma is a legitimate query-string
  // character (e.g. "...&features=database,docs") - excluding it here silently
  // truncated multi-value features lists, which happened to be benign only because
  // the truncated remainder still contained an allowed feature. Stopping at ')'/'>' is
  // unnecessary for structured config scanning and risks the same truncation for any
  // URL whose query string legitimately contains those characters (URL-encoded or not).
  const re = /https:\/\/mcp\.supabase\.com\/mcp[^"'\s]*/gi;
  let m;
  while ((m = re.exec(text))) out.add(m[0]);
  if (/mcp\.supabase\.com\/mcp/i.test(text) && !out.size) out.add('https://mcp.supabase.com/mcp');
  return [...out];
}

function checkSupabaseMcpUrl(url: any) {
  const findings: any[] = [];
  let u;
  try { u = new URL(url); } catch { u = new URL('https://mcp.supabase.com/mcp'); }
  const q = u.searchParams;
  if (q.get('read_only') !== 'true') findings.push({ id: 'supabase_mcp_not_read_only', severity: 'critical', reason: 'Supabase MCP must use read_only=true.' });
  if (!q.get('project_ref')) findings.push({ id: 'supabase_mcp_not_project_scoped', severity: 'critical', reason: 'Supabase MCP must include project_ref=<id>.' });
  const featuresRaw = q.get('features');
  if (!featuresRaw) findings.push({ id: 'supabase_mcp_features_unrestricted', severity: 'high', reason: 'Supabase MCP must restrict features, e.g. features=database,docs.' });
  else {
    const allowed = new Set(['database', 'docs', 'development']);
    const forbidden = new Set(['account', 'account_management', 'branching', 'storage', 'edge_functions', 'edge-functions']);
    for (const f of featuresRaw.split(',').map((x: any) => x.trim().toLowerCase()).filter(Boolean)) {
      if (forbidden.has(f)) findings.push({ id: 'supabase_mcp_forbidden_feature', severity: 'critical', feature: f, reason: `Supabase MCP feature '${f}' is forbidden.` });
      else if (!allowed.has(f)) findings.push({ id: 'supabase_mcp_unapproved_feature', severity: 'high', feature: f, reason: `Supabase MCP feature '${f}' is not in Sneakoscope Codex allowlist.` });
    }
  }
  return findings;
}

async function scanMissionMigrationFiles(root: any, opts: any = {}) {
  const since = opts.since ? Date.parse(opts.since) : 0;
  const findings: any[] = [];
  async function walk(dir: any, depth: any = 0) {
    if (depth > 8) return;
    let entries: any[] = [];
    try { entries = await (await import('node:fs/promises')).readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      const rp = rel(root, p);
      if (
        e.name.startsWith('.')
        || ['node_modules', 'dist', 'build', 'coverage', 'vendor', 'archive'].includes(e.name)
        || rp.startsWith('.git/')
        || rp.startsWith('node_modules/')
        || rp.startsWith('.sneakoscope/')
      ) continue;
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.isFile() && /(^|\/)(supabase\/migrations|migrations|db\/migrations|database\/migrations)\/.*\.sql$/i.test(rp)) {
        let st; try { st = await (await import('node:fs/promises')).stat(p); } catch { continue; }
        if (since && st.mtimeMs < since - 5000) continue;
        const cls = classifySql(await readText(p, ''));
        if (cls.level === 'destructive') findings.push({ id: 'destructive_migration_file', severity: 'critical', file: rp, classification: cls, reason: 'Mission migration file contains destructive SQL.' });
        else if (cls.level === 'write') findings.push({ id: 'write_migration_file', severity: 'info', file: rp, classification: cls, reason: 'Migration file contains write/DDL SQL; review artifact only.' });
      }
    }
  }
  await walk(root, 0);
  return findings;
}

function redactUrl(url: any) { return String(url).replace(/(access_token|token|apikey|key)=([^&]+)/gi, '$1=<redacted>'); }
function rel(root: any, file: any) { return path.relative(root, file).split(path.sep).join('/'); }
