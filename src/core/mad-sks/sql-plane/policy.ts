export const MAD_SKS_SQL_PLANE_POLICY_SCHEMA = 'sks.mad-sks-sql-plane-policy.v2' as const;

export const MAD_SKS_SQL_PLANE_OPERATION_CLASSES = [
  'create',
  'alter',
  'drop',
  'drop_database_sql',
  'insert',
  'update',
  'delete',
  'all_row_update',
  'all_row_delete',
  'truncate',
  'migration_apply',
  'direct_execute_sql',
  'rls_policy_change',
  'function_or_trigger_change',
  'index_change',
  'unknown_sql_mutation'
] as const;

export type MadSksSqlPlaneOperationClass = typeof MAD_SKS_SQL_PLANE_OPERATION_CLASSES[number];

export const MAD_SKS_SQL_PLANE_TOOL_NAMES = Object.freeze([
  'execute_sql',
  'apply_migration',
  'supabase.execute_sql',
  'supabase.apply_migration',
  'mcp__supabase__execute_sql',
  'mcp__supabase__apply_migration',
  'supabase_mad_sks_sql_plane.execute_sql',
  'supabase_mad_sks_sql_plane.apply_migration',
  'mcp__supabase_mad_sks_sql_plane__execute_sql',
  'mcp__supabase_mad_sks_sql_plane__apply_migration'
]);

export const MAD_SKS_SQL_PLANE_CONTROL_PLANE_DENIED_TOOL_PATTERNS = Object.freeze([
  'delete_project',
  'pause_project',
  'restore_project',
  'create_project',
  'list_organizations',
  'get_organization',
  'billing',
  'organization',
  'credential',
  'access_token',
  'service_role',
  'delete_branch',
  'reset_branch',
  'merge_branch'
]);

export const MAD_SKS_SQL_PLANE_POLICY = Object.freeze({
  schema: MAD_SKS_SQL_PLANE_POLICY_SCHEMA,
  default_mode: 'deny_mutations',
  active_mode: {
    sql_plane: 'allow_all_mutations',
    control_plane: 'deny',
    requires: [
      'capability_v2',
      'project_binding',
      'session_binding',
      'write_transport_ready',
      'not_expired'
    ]
  },
  sql_plane_allowed: MAD_SKS_SQL_PLANE_OPERATION_CLASSES,
  sql_plane_tools: MAD_SKS_SQL_PLANE_TOOL_NAMES,
  control_plane_denied: MAD_SKS_SQL_PLANE_CONTROL_PLANE_DENIED_TOOL_PATTERNS,
  normal_supabase_mcp: {
    read_only_required: true,
    project_ref_required: true
  },
  runtime_profile: {
    mission_local_only: true,
    read_only_omitted_only_for_active_capability: true,
    features: ['database']
  },
  ttl: {
    default_ms: 15 * 60 * 1000,
    hard_max_ms: 30 * 60 * 1000
  }
});

export function madSksSqlPlanePolicySnapshot() {
  return MAD_SKS_SQL_PLANE_POLICY;
}

export function isMadSksSqlPlaneToolName(toolName: unknown): boolean {
  const normalized = normalizeToolName(toolName);
  if (!normalized) return false;
  return MAD_SKS_SQL_PLANE_TOOL_NAMES.some((name) => normalized.endsWith(normalizeToolName(name)) || normalized.includes(normalizeToolName(name)));
}

export function isMadSksSqlPlaneControlPlaneDeniedTool(toolName: unknown): boolean {
  const normalized = normalizeToolName(toolName);
  if (!normalized) return false;
  return MAD_SKS_SQL_PLANE_CONTROL_PLANE_DENIED_TOOL_PATTERNS.some((pattern) => normalized.includes(normalizeToolName(pattern)));
}

export function normalizeToolName(toolName: unknown): string {
  return String(toolName || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '_');
}

export function madSksSqlPlaneOperationClassesFromClassification(classification: any = {}): MadSksSqlPlaneOperationClass[] {
  const reasons = new Set<string>([
    ...stringArray(classification.reasons),
    ...stringArray(classification.sql?.reasons),
    ...stringArray(classification.command?.reasons),
    ...stringArray(classification.toolReasons)
  ]);
  const out = new Set<MadSksSqlPlaneOperationClass>();
  const toolName = classification.toolName || classification.tool_name || '';
  if (isMadSksSqlPlaneToolName(toolName)) out.add('direct_execute_sql');
  if (reasons.has('migration_apply_tool') || reasons.has('supabase_migration_apply')) out.add('migration_apply');
  if (hasAny(reasons, ['drop_database'])) out.add('drop_database_sql');
  if (hasAny(reasons, ['drop_schema', 'drop_table', 'drop_view', 'drop_materialized_view', 'drop_extension', 'drop_policy', 'drop_statement', 'alter_table_drop'])) out.add('drop');
  if (hasAny(reasons, ['truncate'])) out.add('truncate');
  if (hasAny(reasons, ['insert_or_upsert'])) out.add('insert');
  if (hasAny(reasons, ['update_with_where'])) out.add('update');
  if (hasAny(reasons, ['update_without_where'])) out.add('all_row_update');
  if (hasAny(reasons, ['delete_with_where'])) out.add('delete');
  if (hasAny(reasons, ['delete_without_where'])) out.add('all_row_delete');
  if (hasAny(reasons, ['schema_change', 'alter_table_rename'])) out.add('alter');
  if (hasAny(reasons, ['create_or_replace'])) out.add('function_or_trigger_change');
  const statements = stringArray(classification.sql?.statements);
  for (const statement of statements) {
    const normalized = statement.trim().toLowerCase();
    if (/^create\s+(table|schema|view|materialized\s+view)/.test(normalized)) out.add('create');
    if (/^create\s+(index|unique\s+index)/.test(normalized)) out.add('index_change');
    if (/^drop\s+index/.test(normalized)) out.add('index_change');
    if (/policy|row\s+level\s+security|rls/.test(normalized)) out.add('rls_policy_change');
    if (/function|trigger|procedure/.test(normalized)) out.add('function_or_trigger_change');
  }
  if (!out.size && ['write', 'destructive', 'possible_db'].includes(String(classification.level || ''))) out.add('unknown_sql_mutation');
  return [...out];
}

export function activeMadSksSqlPlaneAllowsMutation(classification: any = {}): boolean {
  const toolName = classification.toolName || classification.tool_name || '';
  if (classification.level === 'possible_db' && classification.toolReasons?.includes?.('database_tool')) return false;
  if (isMadSksSqlPlaneControlPlaneDeniedTool(toolName)) return false;
  if (classification.toolReasons?.includes?.('dangerous_supabase_management_tool')) return false;
  if (isMadSksSqlPlaneToolName(toolName)) return true;
  return ['write', 'destructive', 'possible_db'].includes(String(classification.level || ''));
}

export function madSksSqlPlanePolicyText(commandPrefix = 'sks'): string {
  return `---
name: mad-sks-sql-plane-policy
description: Canonical MAD-SKS SQL-plane execution policy.
---

MAD-SKS SQL-plane rules: execute SQL-plane mutations that the operator requested through $MAD-SKS or ${commandPrefix} mad-sks sql|apply-migration, including CREATE, ALTER, table/schema DROP, column add/drop/rename, INSERT, UPDATE, DELETE including all-row mutations, TRUNCATE, execute_sql, and apply_migration. Catastrophic SQL is allowed only in the SQL-plane executor and only when the user's prompt or CLI SQL statement literally names the operation.

Keep normal Supabase MCP configuration read-only. MAD-SKS sql-plane must create a mission-local ephemeral write-capable Supabase MCP profile bound to capability v2, project_ref, root, mission, thread/session, intent, runtime profile hash, TTL, and SQL-plane operation classes. Verify execute_sql and apply_migration availability before claiming readiness. Require actual tool results plus independent read-back verification before claiming success. Close/revoke the capability and runtime profile in finally and prove read-only restoration.

Still deny Supabase account/project/billing/credential control-plane actions, credential exfiltration, unrelated non-database admin changes, and unrequested fallback implementation. Do not add prompt-only SQL deny lists inside active sql-plane; capability binding, SQL-plane scope, operation ledgering, literal catastrophic intent, and read-back verification are the approval boundary. Pair with db-safety-guard, Context7 evidence for MCP/API docs, route-local reflection, and Honest Mode.`;
}

export function dbSafetyGuardSkillText(): string {
  return `---
name: db-safety-guard
description: Enforce Sneakoscope Codex database safety before using SQL, Supabase MCP, Postgres, Prisma, Drizzle, Knex, or migration commands.
---

Rules:
- Default non-MAD-SKS mode is read-only. When a migration is required, produce exactly one mission-local manual-migration.sql with active forward SQL and a complete rollback section that remains commented out, then tell the user to apply it manually.
- Before any DB change, inspect the existing canonical adapter/query helper, pool/client ownership and acquire/release/shutdown/reconnect behavior, N+1/repeated I/O, and transaction integrity for sensitive or multi-step mutations.
- Supabase MCP must be read-only and project-scoped by default.
- Live execute_sql writes are blocked unless a bound active MAD-SKS sql-plane capability v2 is present.
- Active MAD-SKS sql-plane is the explicit exception: SQL-plane mutations requested by $MAD-SKS or sks mad-sks sql|apply-migration are allowed, including DROP, DELETE, TRUNCATE, RLS/policy changes, and execute_sql/apply_migration, and must be executed with read-back verification.
- Default read-only restrictions do not apply to SQL-plane work while the active MAD-SKS sql-plane capability v2 is bound.
- Supabase project/account/billing/credential control-plane actions remain denied even in MAD-SKS sql-plane.
- If no active bound MAD-SKS sql-plane cycle exists, fall back to read-only only.`;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry || '')).filter(Boolean);
}

function hasAny(values: Set<string>, keys: string[]): boolean {
  return keys.some((key) => values.has(key));
}
