import path from 'node:path';
import { exists, readJson, writeJsonAtomic, readText, nowIso, appendJsonlBounded } from './fsx.mjs';
import { missionDir } from './mission.mjs';

export const DEFAULT_DB_SAFETY_POLICY = Object.freeze({
  schema_version: 1,
  mode: 'read_only_default',
  destructive_operations: 'deny_always',
  production_writes: 'deny_always',
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

export async function ensureDbSafetyPolicy(root) {
  const p = path.join(root, '.sneakoscope', 'db-safety.json');
  if (!(await exists(p))) await writeJsonAtomic(p, DEFAULT_DB_SAFETY_POLICY);
  return p;
}

export async function loadDbSafetyPolicy(root) {
  const p = path.join(root, '.sneakoscope', 'db-safety.json');
  const data = await readJson(p, {});
  return { ...DEFAULT_DB_SAFETY_POLICY, ...(data || {}) };
}

export function safeSupabaseMcpConfig({ projectRef = '<project_ref>', readOnly = true, features = 'database,docs' } = {}) {
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

function stripSqlComments(sql = '') {
  return String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n\r]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function norm(s = '') { return stripSqlComments(s).toLowerCase(); }

export function splitSqlStatements(sql = '') {
  const text = stripSqlComments(sql);
  const out = [];
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

function hasWhere(stmt) { return /\bwhere\b/i.test(stmt); }
function hasLimit(stmt) { return /\blimit\s+\d+\b/i.test(stmt); }
function isReadOnly(stmt) {
  const s = norm(stmt);
  return /^(select|with|show|explain|describe)\b/.test(s) && !/(\binsert\b|\bupdate\b|\bdelete\b|\bdrop\b|\btruncate\b|\balter\b|\bcreate\b|\bgrant\b|\brevoke\b)/.test(s);
}

export function classifySql(sql = '') {
  const statements = splitSqlStatements(sql);
  if (!statements.length) return { level: 'none', kind: 'none', reasons: [], statements: [] };
  const reasons = [];
  let level = 'safe';
  let kind = 'read';
  for (const stmtRaw of statements) {
    const stmt = norm(stmtRaw);
    if (!stmt) continue;
    const destructiveChecks = [
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

export function classifyCommand(command = '') {
  const c = String(command);
  const low = c.toLowerCase();
  const reasons = [];
  if (!low.trim()) return { level: 'none', kind: 'none', reasons: [], command: c };
  const hard = [
    [/\bsupabase\s+db\s+reset\b/, 'supabase_db_reset'],
    [/\bsupabase\s+db\s+push\b/, 'supabase_db_push'],
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
  const sqlClass = maybeSql ? classifySql(maybeSql) : { level: 'none', reasons: [] };
  if (reasons.length) return { level: 'destructive', kind: 'db_command', reasons, sql: sqlClass, command: c };
  if (/\b(psql|supabase|prisma|drizzle-kit|knex|sequelize)\b/.test(low)) {
    if (sqlClass.level === 'destructive' || sqlClass.level === 'write') return { level: sqlClass.level, kind: 'db_command', reasons: sqlClass.reasons, sql: sqlClass, command: c };
    return { level: sqlClass.level === 'safe' ? 'safe' : 'possible_db', kind: 'db_command', reasons: sqlClass.reasons, sql: sqlClass, command: c };
  }
  return { level: sqlClass.level, kind: sqlClass.kind, reasons: sqlClass.reasons, sql: sqlClass, command: c };
}

function extractSqlLiterals(command = '') {
  const out = [];
  const patterns = [
    /-c\s+(['"])([\s\S]*?)\1/g,
    /--command\s+(['"])([\s\S]*?)\1/g,
    /--sql\s+(['"])([\s\S]*?)\1/g
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(command))) out.push(m[2]);
  }
  if (/\b(select|insert|update|delete|drop|truncate|alter|create|grant|revoke)\b/i.test(command)) out.push(command);
  return out;
}

function recursivelyCollectStrings(obj, out = [], depth = 0) {
  if (depth > 8 || obj == null) return out;
  if (typeof obj === 'string') { out.push(obj); return out; }
  if (Array.isArray(obj)) { for (const x of obj) recursivelyCollectStrings(x, out, depth + 1); return out; }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (/^(sql|query|statement|command|migration|body|input|text)$/i.test(k) || typeof v === 'object') recursivelyCollectStrings(v, out, depth + 1);
    }
  }
  return out;
}

function looksLikeSqlText(text = '') {
  const s = stripSqlComments(text).trim();
  return /^(select|with|show|explain|describe|insert|update|delete|drop|truncate|alter|create|grant|revoke)\b/i.test(s)
    || /;\s*(select|with|show|explain|describe|insert|update|delete|drop|truncate|alter|create|grant|revoke)\b/i.test(s);
}

export function classifyToolPayload(payload = {}) {
  const strings = recursivelyCollectStrings(payload).slice(0, 200);
  const toolName = [payload.tool_name, payload.toolName, payload.name, payload.tool?.name, payload.server, payload.mcp_tool, payload.tool, payload.type].filter(Boolean).join(' ').toLowerCase();
  const combined = strings.filter(looksLikeSqlText).join('\n');
  const sqlClass = classifySql(combined);
  const commandClass = classifyCommand(strings.find((s) => /\b(supabase|psql|prisma|drizzle|knex|sequelize)\b/i.test(s)) || '');
  const toolReasons = [];
  if (/supabase|postgres|database|execute_sql|apply_migration|mcp/.test(toolName)) toolReasons.push('database_tool');
  if (/delete_project|pause_project|restore_project|delete_branch|reset_branch|merge_branch/.test(toolName)) toolReasons.push('dangerous_supabase_management_tool');
  let level = 'none';
  for (const candidate of [sqlClass.level, commandClass.level]) {
    if (candidate === 'destructive') level = 'destructive';
    else if (candidate === 'write' && level !== 'destructive') level = 'write';
    else if ((candidate === 'safe' || candidate === 'possible_db') && level === 'none') level = candidate;
  }
  if (toolReasons.includes('dangerous_supabase_management_tool')) level = 'destructive';
  if (toolReasons.includes('database_tool') && level === 'none') level = 'possible_db';
  return { level, toolName, toolReasons, sql: sqlClass, command: commandClass, stringsExamined: strings.length };
}

function contractAllowsDbWrite(contract = {}) {
  const hc = contract.hard_constraints || {};
  const mode = hc.database_write_mode || hc.db_write_mode || contract.answers?.DATABASE_WRITE_MODE || 'read_only_only';
  const env = hc.database_target_environment || contract.answers?.DATABASE_TARGET_ENVIRONMENT || 'no_database';
  const destructive = hc.destructive_db_operations_allowed === true || contract.answers?.DESTRUCTIVE_DB_OPERATIONS_ALLOWED === 'yes';
  const migrationApply = contract.answers?.DB_MIGRATION_APPLY_ALLOWED || 'no';
  return { mode, env, destructive, migrationApply };
}

export function evaluateDbSafety({ classification, policy = DEFAULT_DB_SAFETY_POLICY, contract = null, duringRalph = false } = {}) {
  const cls = classification || { level: 'none', reasons: [] };
  const reasons = [];
  const effective = contractAllowsDbWrite(contract || {});
  if (cls.level === 'none') return { allowed: true, action: 'allow', reasons: [], classification: cls };
  if (cls.level === 'safe') return { allowed: true, action: 'allow', reasons: ['read_only_operation'], classification: cls };
  if (cls.level === 'possible_db') return { allowed: !duringRalph, action: duringRalph ? 'block' : 'warn', reasons: duringRalph ? ['unknown_database_operation_blocked_during_ralph'] : ['unknown_database_operation'], classification: cls };
  if (cls.level === 'destructive') reasons.push('destructive_database_operation_blocked_always');
  if (cls.level === 'write') {
    if (effective.mode === 'read_only_only') reasons.push('database_write_mode_is_read_only_only');
    if (effective.env === 'production' || effective.env === 'production_read_only') reasons.push('production_database_writes_forbidden');
    if (!['local_dev', 'preview_branch', 'supabase_branch'].includes(effective.env)) reasons.push('database_write_target_not_local_or_branch');
    if (policy.block_direct_execute_sql_writes && cls.toolReasons?.includes?.('database_tool')) reasons.push('direct_mcp_execute_sql_writes_blocked');
  }
  if (effective.destructive) reasons.push('contract_attempted_to_allow_destructive_but_policy_denies');
  if (reasons.length) return { allowed: false, action: 'block', reasons, classification: cls, effective };
  return { allowed: true, action: 'allow', reasons: ['write_allowed_by_contract_to_safe_target'], classification: cls, effective };
}

export async function loadMissionContract(root, state = {}) {
  if (!state?.mission_id) return null;
  const p = path.join(missionDir(root, state.mission_id), 'decision-contract.json');
  if (!(await exists(p))) return null;
  return readJson(p, null);
}

export async function checkDbOperation(root, state, payload, { duringRalph = false } = {}) {
  const policy = await loadDbSafetyPolicy(root);
  const contract = await loadMissionContract(root, state);
  const classification = classifyToolPayload(payload);
  const decision = evaluateDbSafety({ classification, policy, contract, duringRalph });
  if (decision.action !== 'allow' && state?.mission_id) {
    await appendJsonlBounded(path.join(missionDir(root, state.mission_id), 'db-safety.jsonl'), { ts: nowIso(), decision });
  }
  return decision;
}

export async function checkSqlFile(file) {
  const sql = await readText(file);
  return classifySql(sql);
}

export function dbBlockReason(decision) {
  return [
    'Sneakoscope Codex Database Safety Gate blocked this operation.',
    `Reasons: ${(decision.reasons || []).join(', ') || 'unknown'}.`,
    'Destructive database operations are never allowed. Production writes are forbidden. Supabase/Postgres MCP write tools must not be used for live destructive changes.',
    'Use read-only/project-scoped Supabase MCP URLs, create migration files, and apply them only to local or preview/branch environments when explicitly allowed by the sealed contract.'
  ].join(' ');
}

export async function scanDbSafety(root, opts = {}) {
  const findings = [];
  findings.push(...await scanSupabaseMcpConfigs(root));
  if (opts.includeMigrations) findings.push(...await scanMissionMigrationFiles(root, opts));
  const ok = !findings.some((f) => ['critical', 'high'].includes(f.severity));
  const report = { checked_at: nowIso(), ok, findings };
  await writeJsonAtomic(path.join(root, '.sneakoscope', 'db-safety-scan.json'), report).catch(() => {});
  return report;
}

async function scanSupabaseMcpConfigs(root) {
  const files = ['.codex/config.toml', '.cursor/mcp.json', '.windsurf/mcp_config.json', '.vscode/mcp.json', '.mcp.json', 'mcp.json', 'claude_desktop_config.json', '.claude/mcp.json'];
  const findings = [];
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
    for (const url of urls) findings.push(...checkSupabaseMcpUrl(url).map((x) => ({ ...x, file: rel(root, file), url: redactUrl(url) })));
  }
  return findings;
}

function extractSupabaseMcpUrls(text) {
  const out = new Set();
  const re = /https:\/\/mcp\.supabase\.com\/mcp[^"'\s)>,]*/gi;
  let m;
  while ((m = re.exec(text))) out.add(m[0]);
  if (/mcp\.supabase\.com\/mcp/i.test(text) && !out.size) out.add('https://mcp.supabase.com/mcp');
  return [...out];
}

function checkSupabaseMcpUrl(url) {
  const findings = [];
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
    for (const f of featuresRaw.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)) {
      if (forbidden.has(f)) findings.push({ id: 'supabase_mcp_forbidden_feature', severity: 'critical', feature: f, reason: `Supabase MCP feature '${f}' is forbidden.` });
      else if (!allowed.has(f)) findings.push({ id: 'supabase_mcp_unapproved_feature', severity: 'high', feature: f, reason: `Supabase MCP feature '${f}' is not in Sneakoscope Codex allowlist.` });
    }
  }
  return findings;
}

async function scanMissionMigrationFiles(root, opts = {}) {
  const since = opts.since ? Date.parse(opts.since) : 0;
  const findings = [];
  async function walk(dir, depth = 0) {
    if (depth > 8) return;
    let entries = [];
    try { entries = await (await import('node:fs/promises')).readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      const rp = rel(root, p);
      if (rp.startsWith('.git/') || rp.startsWith('node_modules/') || rp.startsWith('.sneakoscope/')) continue;
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

function redactUrl(url) { return String(url).replace(/(access_token|token|apikey|key)=([^&]+)/gi, '$1=<redacted>'); }
function rel(root, file) { return path.relative(root, file).split(path.sep).join('/'); }
