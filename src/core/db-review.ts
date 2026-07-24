import path from 'node:path';
import fsp from 'node:fs/promises';
import { classifySql } from './db-safety.js';
import { exists, readJson, readText, sha256 } from './fsx.js';
import { missionDir } from './mission.js';
import {
  MAD_SKS_SQL_PLANE_CAPABILITY_FILE,
  MAD_SKS_SQL_PLANE_CLOSED_CAPABILITY_FILE,
  MAD_SKS_SQL_PLANE_RESULT_FILE,
  madSksSqlPlaneRelativePath
} from './mad-sks/sql-plane/paths.js';

export const DB_REVIEW_ARTIFACT = 'db-review.json';
export const DB_ACCESS_REVIEW_ARTIFACT = 'db-access-review.json';
export const DB_ACCESS_CANDIDATES_ARTIFACT = 'db-access-candidates.json';
export const DB_MANUAL_MIGRATION_ARTIFACT = 'manual-migration.sql';
export const DB_REVIEW_SCHEMA = 'sks.db-review.v2';
export const DB_ACCESS_REVIEW_SCHEMA = 'sks.db-access-review.v1';
export const DB_ACCESS_CANDIDATES_SCHEMA = 'sks.db-access-candidates.v1';
export const DB_MANUAL_MIGRATION_HEADER = '-- SKS MANUAL MIGRATION v1';
export const DB_MANUAL_FORWARD_MARKER = '-- === FORWARD SQL ===';
export const DB_MANUAL_ROLLBACK_MARKER = '-- === ROLLBACK SQL (MANUAL ONLY; RUN SEPARATELY) ===';
export const DB_MIGRATION_MODES = Object.freeze(['none', 'manual_sql', 'mad_sks_sql_plane'] as const);

const REVIEW_SECTION_STATUSES = new Set(['passed', 'not_applicable']);
const TRANSACTION_STRATEGIES = new Set(['single_transaction', 'non_transactional_required', 'mixed']);
const MANUAL_SQL_FORBIDDEN_CONTENT_RE = /postgres(?:ql)?:\/\/|(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:TODO|TBD|REPLACE_ME|CHANGEME|YOUR_[A-Z0-9_]+)\b|<(?:project_ref|password|secret|token|database_url)>/i;
const DB_SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.sql']);
const DB_SOURCE_SKIP_DIRS = new Set([
  '.git',
  '.sneakoscope',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'vendor',
  'test',
  'tests',
  '__tests__',
  'fixtures',
  '__fixtures__',
  'examples'
]);
const DB_IMPORT_MARKER_RE = /(?:\bfrom\s*['"](?:pg|postgres|mysql2?|mariadb|better-sqlite3|@supabase\/supabase-js|@prisma\/client|drizzle-orm|knex|sequelize|typeorm|mongodb|mongoose)['"]|\brequire\s*\(\s*['"](?:pg|postgres|mysql2?|mariadb|better-sqlite3|@supabase\/supabase-js|@prisma\/client|drizzle-orm|knex|sequelize|typeorm|mongodb|mongoose)['"]\s*\)|^\s*(?:from|import)\s+(?:psycopg2?|asyncpg|sqlalchemy|supabase|django\.db)\b|^\s*use\s+(?:sqlx|diesel|sea_orm|tokio_postgres)::|^\s*import\s+(?:java\.sql|javax\.persistence|jakarta\.persistence|org\.springframework\.(?:jdbc|data))\b|['"]database\/sql['"])/i;
const DB_QUERY_CALL_MARKER_RE = /\b(?:pool|client|connection|conn|db|database|supabase|prisma|knex|trx|tx|queryRunner|entityManager)\s*(?:\?\.|\.)\s*(?:query|execute|executeQuery|raw|from|rpc|select|insert|update|delete|upsert|save|create|findMany|findUnique|findFirst)\s*\(|\b(?:executeSql|execute_sql|queryRaw|executeRaw)\s*\(/i;
const DB_STRONG_QUERY_CALL_MARKER_RE = /\b(?:pool|db|database|supabase|prisma|knex|trx|tx|queryRunner|entityManager)\s*(?:\?\.|\.)\s*(?:query|execute|executeQuery|raw|from|rpc|select|insert|update|delete|upsert|save|create|findMany|findUnique|findFirst)\s*\(|\b(?:executeSql|execute_sql|queryRaw|executeRaw)\s*\(/i;
const DB_ADAPTER_MARKER_RE = /\b(?:class|interface|type|function|const|let)\s+[A-Za-z_$][\w$]*(?:Repository|Dao|DataSource|QueryHelper|DbClient|DatabaseClient|Adapter)\b|\b(?:repository|queryHelper|query_helper|dbClient|db_client|databaseClient|database_client)\s*(?:\?\.|\.)/i;
const DB_CLIENT_CONSTRUCTOR_RE = /\bnew\s+Client\s*\(|\b(?:createClient|createConnection)\s*\(/i;
const DB_POOL_MARKER_RE = /\bnew\s+(?:Pool|PrismaClient|DataSource|Sequelize)\s*\(|\b(?:createPool|knex)\s*\(/i;
const DB_ACQUIRE_RELEASE_MARKER_RE = /\b(?:pool|client|connection|conn|dataSource|prisma)\s*(?:\?\.|\.)\s*(?:connect|acquire|getConnection|get_connection|release|disconnect|destroy|end|close)\s*\(/i;
const DB_TRANSACTION_MARKER_RE = /\b(?:withTransaction|with_transaction|runInTransaction|run_in_transaction)\s*\(|\.(?:transaction|\$transaction)\s*\(|^\s*(?:begin|commit|rollback|savepoint)\b/i;
const DB_SENSITIVE_MARKER_RE = /\b(?:payment|billing|invoice|charge|refund|ledger|balance|payout|settlement|wallet)\b|결제|청구|환불|원장|잔액|정산/i;
const DB_WRITE_MARKER_RE = /\b(?:insert|update|delete|upsert|save|create|execute|query)\s*\(/gi;
const DB_CANDIDATE_DISPOSITIONS = new Set(['verified', 'false_positive']);

export function createDbReviewSeed(scanOk: boolean) {
  return {
    schema: DB_REVIEW_SCHEMA,
    passed: false,
    scan_ok: scanOk,
    destructive_operation_zero: true,
    safe_mcp_policy: false,
    context7_evidence: false,
    migration_mode: null,
    live_database_mutated: false,
    migration_not_required_reason: null,
    db_access_review_file: DB_ACCESS_REVIEW_ARTIFACT,
    manual_migration: {
      path: DB_MANUAL_MIGRATION_ARTIFACT,
      sha256: null,
      manual_apply_required: true,
      rollback_inactive_by_default: true,
      forward_validation: false,
      rollback_validation: false,
      transaction_strategy: {
        reviewed: false,
        strategy: null,
        summary: null
      },
      migration_order_and_prerequisites: {
        reviewed: false,
        summary: null
      },
      lock_and_rollout_review: {
        reviewed: false,
        summary: null
      },
      rls_and_grants_review: {
        reviewed: false,
        summary: null
      }
    },
    mad_sks_sql_plane: {
      capability_schema: 'sks.mad-sks-sql-plane-capability.v2',
      result_file: madSksSqlPlaneRelativePath(MAD_SKS_SQL_PLANE_RESULT_FILE),
      cycle_id: null,
      read_back_passed: false,
      capability_closed: false,
      read_only_restored: false
    },
    user_notice_ready: false,
    user_notice: null,
    blockers: [],
    notes: []
  };
}

export function createDbAccessReviewSeed(candidateScan: any = null) {
  return {
    schema: DB_ACCESS_REVIEW_SCHEMA,
    passed: false,
    candidate_scan_file: DB_ACCESS_CANDIDATES_ARTIFACT,
    source_snapshot_sha256: candidateScan?.source_snapshot_sha256 || null,
    reviewed_candidate_ids: [],
    candidate_dispositions: [],
    canonical_access: {
      status: 'pending',
      applicable: null,
      reason: null,
      entry_points: [],
      caller_chain: [],
      adapters_or_query_helpers: [],
      migration_helpers: [],
      transaction_helpers: [],
      new_parallel_path_absent: false,
      evidence: []
    },
    pool_lifecycle: {
      status: 'pending',
      applicable: null,
      reason: null,
      owners: [],
      request_scoped_pool_creation_absent: false,
      acquire_release_finally_verified: false,
      shutdown_reconnect_race_reviewed: false,
      bounded_limits_reviewed: false,
      exhaustion_observability_reviewed: false,
      evidence: []
    },
    query_efficiency: {
      status: 'pending',
      applicable: null,
      reason: null,
      n_plus_one_reviewed: false,
      repeated_io_reviewed: false,
      batching_or_prefetch_reviewed: false,
      evidence: []
    },
    transaction_integrity: {
      status: 'pending',
      applicable: null,
      reason: null,
      sensitive_flows: [],
      single_transaction_boundary_verified: false,
      rollback_and_error_propagation_verified: false,
      database_idempotency_verified: false,
      bounded_retry_verified: false,
      outbox_or_compensation_reviewed: false,
      independent_post_commit_invariants_verified: false,
      evidence: []
    },
    blockers: [],
    notes: []
  };
}

export async function scanDbAccessCandidates(root: string) {
  const sourceFiles = await listDbSourceFiles(root);
  const candidates: Array<{ id: string; kind: string; path: string; line: number; summary: string }> = [];
  const snapshotRows: string[] = [];
  let candidateSourceFileCount = 0;
  for (const file of sourceFiles) {
    const text = await readText(file, '');
    const relative = path.relative(root, file).split(path.sep).join('/');
    const lines = text.split(/\r?\n/);
    if (!isDbRelevantSource(relative, text, lines)) continue;
    const before = candidates.length;
    collectLineCandidates(candidates, relative, lines, 'entry_point', DB_IMPORT_MARKER_RE, 'database client import or production data-access entry point');
    collectLineCandidates(candidates, relative, lines, 'client_constructor', DB_CLIENT_CONSTRUCTOR_RE, 'database client construction and ownership candidate');
    collectLineCandidates(candidates, relative, lines, 'query_call', DB_QUERY_CALL_MARKER_RE, 'database query or mutation call candidate');
    collectLineCandidates(candidates, relative, lines, 'adapter_or_query_helper', DB_ADAPTER_MARKER_RE, 'repository, adapter, ORM, or query-helper candidate');
    collectLineCandidates(candidates, relative, lines, 'pool_constructor', DB_POOL_MARKER_RE, 'database client or pool construction candidate');
    collectLineCandidates(candidates, relative, lines, 'acquire_release', DB_ACQUIRE_RELEASE_MARKER_RE, 'connection acquire/release/shutdown lifecycle candidate');
    collectLineCandidates(candidates, relative, lines, 'transaction_helper', DB_TRANSACTION_MARKER_RE, 'transaction boundary or rollback helper candidate');
    const writeCount = text.match(DB_WRITE_MARKER_RE)?.length || 0;
    if (writeCount >= 2 && DB_SENSITIVE_MARKER_RE.test(text)) {
      const line = lines.findIndex((value) => DB_SENSITIVE_MARKER_RE.test(value)) + 1;
      candidates.push(dbCandidate(relative, Math.max(1, line), 'sensitive_multi_write', 'sensitive or financial multi-write transaction candidate'));
    }
    if (candidates.length > before) {
      candidateSourceFileCount += 1;
      snapshotRows.push(`${relative}:${sha256(text)}`);
    }
  }
  const deduped = [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()]
    .sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line || left.kind.localeCompare(right.kind));
  return {
    schema: DB_ACCESS_CANDIDATES_SCHEMA,
    scanned_at: new Date().toISOString(),
    source_snapshot_sha256: `sha256:${sha256(snapshotRows.sort().join('\n'))}`,
    scanned_source_file_count: sourceFiles.length,
    candidate_source_file_count: candidateSourceFileCount,
    candidate_count: deduped.length,
    candidates: deduped
  };
}

export function validateDbAccessReview(review: any = {}) {
  const blockers: string[] = [];
  if (review?.schema !== DB_ACCESS_REVIEW_SCHEMA) blockers.push('schema');
  if (review?.passed !== true) blockers.push('passed');
  if (!Array.isArray(review?.candidate_dispositions)) blockers.push('candidate_dispositions_invalid');
  if (!Array.isArray(review?.blockers)) blockers.push('blockers_invalid');
  else if (review.blockers.length > 0) blockers.push('blockers');

  validateApplicableSection(review?.canonical_access, 'canonical_access', blockers, {
    requiredBooleanFields: ['new_parallel_path_absent'],
    requiredArrayFields: ['entry_points', 'caller_chain', 'adapters_or_query_helpers', 'evidence'],
    allowEmptyArrayFields: ['migration_helpers', 'transaction_helpers']
  });
  validateApplicableSection(review?.pool_lifecycle, 'pool_lifecycle', blockers, {
    requiredBooleanFields: [
      'request_scoped_pool_creation_absent',
      'acquire_release_finally_verified',
      'shutdown_reconnect_race_reviewed',
      'bounded_limits_reviewed',
      'exhaustion_observability_reviewed'
    ],
    requiredArrayFields: ['owners', 'evidence']
  });
  validateApplicableSection(review?.query_efficiency, 'query_efficiency', blockers, {
    requiredBooleanFields: ['n_plus_one_reviewed', 'repeated_io_reviewed', 'batching_or_prefetch_reviewed'],
    requiredArrayFields: ['evidence']
  });
  validateApplicableSection(review?.transaction_integrity, 'transaction_integrity', blockers, {
    requiredBooleanFields: [
      'single_transaction_boundary_verified',
      'rollback_and_error_propagation_verified',
      'database_idempotency_verified',
      'bounded_retry_verified',
      'outbox_or_compensation_reviewed',
      'independent_post_commit_invariants_verified'
    ],
    requiredArrayFields: ['sensitive_flows', 'evidence']
  });

  return { ok: blockers.length === 0, blockers: [...new Set(blockers)] };
}

export async function validateDbAccessReviewArtifact(root: string, missionId: string, review: any = {}) {
  const basic = validateDbAccessReview(review);
  const blockers = [...basic.blockers];
  if (review?.candidate_scan_file !== DB_ACCESS_CANDIDATES_ARTIFACT) blockers.push('candidate_scan_file');
  const persisted = await readJson(path.join(missionDir(root, missionId), DB_ACCESS_CANDIDATES_ARTIFACT), null);
  if (persisted?.schema !== DB_ACCESS_CANDIDATES_SCHEMA) blockers.push(`${DB_ACCESS_CANDIDATES_ARTIFACT}:schema`);
  const fresh = await scanDbAccessCandidates(root);
  if (persisted?.source_snapshot_sha256 !== fresh.source_snapshot_sha256) blockers.push(`${DB_ACCESS_CANDIDATES_ARTIFACT}:stale_source_snapshot`);
  const persistedIds = candidateIds(persisted);
  const freshIds = candidateIds(fresh);
  if (JSON.stringify(persistedIds) !== JSON.stringify(freshIds)) blockers.push(`${DB_ACCESS_CANDIDATES_ARTIFACT}:stale_candidates`);
  if (review?.source_snapshot_sha256 !== fresh.source_snapshot_sha256) blockers.push('source_snapshot_sha256');
  const reviewedIds = sortedUniqueStrings(review?.reviewed_candidate_ids);
  if (JSON.stringify(reviewedIds) !== JSON.stringify(freshIds)) blockers.push('reviewed_candidate_ids');
  const dispositions = Array.isArray(review?.candidate_dispositions) ? review.candidate_dispositions : [];
  const dispositionIds = sortedUniqueStrings(dispositions.map((row: any) => row?.candidate_id));
  if (JSON.stringify(dispositionIds) !== JSON.stringify(freshIds)) blockers.push('candidate_dispositions');
  for (const row of dispositions) {
    if (!DB_CANDIDATE_DISPOSITIONS.has(String(row?.status || ''))) blockers.push('candidate_dispositions:status');
    if (!nonEmpty(row?.reason)) blockers.push('candidate_dispositions:reason');
    if (!nonEmptyArray(row?.evidence)) blockers.push('candidate_dispositions:evidence');
  }

  const candidates = Array.isArray(fresh.candidates) ? fresh.candidates : [];
  const canonicalCandidates = candidates.filter((candidate: any) => ['entry_point', 'client_constructor', 'query_call', 'adapter_or_query_helper'].includes(candidate.kind));
  const poolCandidates = candidates.filter((candidate: any) => ['client_constructor', 'pool_constructor', 'acquire_release'].includes(candidate.kind));
  const queryCandidates = candidates.filter((candidate: any) => ['query_call', 'sensitive_multi_write'].includes(candidate.kind));
  const sensitiveCandidates = candidates.filter((candidate: any) => candidate.kind === 'sensitive_multi_write');
  if (review?.canonical_access?.status === 'not_applicable' && canonicalCandidates.length > 0) blockers.push('canonical_access:not_applicable_with_candidates');
  if (review?.pool_lifecycle?.status === 'not_applicable' && poolCandidates.length > 0) blockers.push('pool_lifecycle:not_applicable_with_candidates');
  if (review?.query_efficiency?.status === 'not_applicable' && queryCandidates.length > 0) blockers.push('query_efficiency:not_applicable_with_candidates');
  if (review?.transaction_integrity?.status === 'not_applicable' && sensitiveCandidates.length > 0) blockers.push('transaction_integrity:not_applicable_with_sensitive_candidates');
  return { ok: blockers.length === 0, blockers: [...new Set(blockers)], candidate_scan: fresh };
}

export async function validateDbReview(root: string, missionId: string, review: any = {}) {
  const blockers: string[] = [];
  if (review?.schema !== DB_REVIEW_SCHEMA) blockers.push('schema');
  if (review?.passed !== true) blockers.push('passed');
  for (const field of ['scan_ok', 'destructive_operation_zero', 'safe_mcp_policy', 'context7_evidence']) {
    if (review?.[field] !== true) blockers.push(field);
  }
  if (review?.context7_evidence === true && !(await hasBoundContext7Evidence(root, missionId))) {
    blockers.push('context7_evidence_artifact');
  }
  if (!Array.isArray(review?.blockers)) blockers.push('blockers_invalid');
  else if (review.blockers.length > 0) blockers.push('blockers');
  const mode = String(review?.migration_mode || '');
  if (!(DB_MIGRATION_MODES as readonly string[]).includes(mode)) blockers.push('migration_mode');
  if (typeof review?.live_database_mutated !== 'boolean') blockers.push('live_database_mutated');

  const accessFile = String(review?.db_access_review_file || '');
  if (accessFile !== DB_ACCESS_REVIEW_ARTIFACT) blockers.push('db_access_review_file');
  const accessReview = accessFile === DB_ACCESS_REVIEW_ARTIFACT
    ? await readJson(path.join(missionDir(root, missionId), DB_ACCESS_REVIEW_ARTIFACT), null)
    : null;
  const accessValidation = await validateDbAccessReviewArtifact(root, missionId, accessReview);
  blockers.push(...accessValidation.blockers.map((item) => `${DB_ACCESS_REVIEW_ARTIFACT}:${item}`));

  if (mode === 'none') {
    if (review?.live_database_mutated !== false) blockers.push('none:live_database_mutated_false');
    if (!nonEmpty(review?.migration_not_required_reason)) blockers.push('none:migration_not_required_reason');
    if (await exists(path.join(missionDir(root, missionId), DB_MANUAL_MIGRATION_ARTIFACT))) blockers.push('none:manual_migration_present');
  } else if (mode === 'manual_sql') {
    if (review?.live_database_mutated !== false) blockers.push('manual_sql:live_database_mutated_false');
    if (review?.user_notice_ready !== true) blockers.push('manual_sql:user_notice_ready');
    if (!manualNoticeIsComplete(review?.user_notice)) blockers.push('manual_sql:user_notice');
    const manual = await validateManualMigrationArtifact(root, missionId, review?.manual_migration);
    blockers.push(...manual.blockers.map((item) => `manual_sql:${item}`));
  } else if (mode === 'mad_sks_sql_plane') {
    if (review?.live_database_mutated !== true) blockers.push('mad_sks_sql_plane:live_database_mutated_true');
    if (await exists(path.join(missionDir(root, missionId), DB_MANUAL_MIGRATION_ARTIFACT))) blockers.push('mad_sks_sql_plane:manual_migration_present');
    const sqlPlane = await validateMadSksSqlPlaneCompletion(root, missionId, review?.mad_sks_sql_plane);
    blockers.push(...sqlPlane.blockers.map((item) => `mad_sks_sql_plane:${item}`));
  }

  return { ok: blockers.length === 0, blockers: [...new Set(blockers)] };
}

export async function validateManualMigrationArtifact(root: string, missionId: string, manual: any = {}) {
  const blockers: string[] = [];
  const dir = missionDir(root, missionId);
  const relative = String(manual?.path || '');
  if (relative !== DB_MANUAL_MIGRATION_ARTIFACT || path.isAbsolute(relative) || relative.includes('..') || relative.includes('/') || relative.includes('\\')) {
    blockers.push('path');
    return { ok: false, blockers };
  }
  const file = path.join(dir, relative);
  const [dirStat, fileStat] = await Promise.all([
    fsp.lstat(dir).catch(() => null),
    fsp.lstat(file).catch(() => null)
  ]);
  if (!dirStat?.isDirectory() || dirStat.isSymbolicLink()) blockers.push('mission_directory_unsafe');
  if (!fileStat?.isFile() || fileStat.isSymbolicLink()) blockers.push('file_missing_or_symlink');
  if (blockers.length) return { ok: false, blockers };

  const [realDir, realFile] = await Promise.all([fsp.realpath(dir), fsp.realpath(file)]);
  const realRelative = path.relative(realDir, realFile);
  if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) blockers.push('realpath_outside_mission');
  const sqlFiles = await collectSqlFilesWithoutFollowingLinks(dir);
  if (sqlFiles.unsafe) blockers.push('sql_symlink_or_unsafe_entry');
  if (sqlFiles.files.length !== 1 || sqlFiles.files[0] !== DB_MANUAL_MIGRATION_ARTIFACT) blockers.push('exactly_one_sql_file');

  const content = await readText(file, '');
  const parsed = parseManualMigrationSql(content);
  blockers.push(...parsed.blockers);
  const digest = `sha256:${sha256(content)}`;
  if (String(manual?.sha256 || '') !== digest) blockers.push('sha256');
  if (manual?.manual_apply_required !== true) blockers.push('manual_apply_required');
  if (manual?.rollback_inactive_by_default !== true) blockers.push('rollback_inactive_by_default');
  if (manual?.forward_validation !== true) blockers.push('forward_validation');
  if (manual?.rollback_validation !== true) blockers.push('rollback_validation');
  validateReviewNote(manual?.transaction_strategy, 'transaction_strategy', blockers, true);
  if (manual?.transaction_strategy?.reviewed === true) {
    const strategy = String(manual.transaction_strategy.strategy || '');
    if (!TRANSACTION_STRATEGIES.has(strategy)) blockers.push('transaction_strategy:strategy');
    if (/\bcreate\s+(?:unique\s+)?index\s+concurrently\b/i.test(parsed.forwardSql) && strategy === 'single_transaction') {
      blockers.push('transaction_strategy:concurrent_index_cannot_use_single_transaction');
    }
  }
  validateReviewNote(manual?.migration_order_and_prerequisites, 'migration_order_and_prerequisites', blockers);
  validateReviewNote(manual?.lock_and_rollout_review, 'lock_and_rollout_review', blockers);
  validateReviewNote(manual?.rls_and_grants_review, 'rls_and_grants_review', blockers);
  return {
    ok: blockers.length === 0,
    blockers: [...new Set(blockers)],
    sha256: digest,
    forward_classification: parsed.forwardSql ? classifySql(parsed.forwardSql) : null,
    rollback_classification: parsed.rollbackSql ? classifySql(parsed.rollbackSql) : null
  };
}

export async function validateMadSksSqlPlaneCompletion(root: string, missionId: string, declared: any = {}) {
  const blockers: string[] = [];
  if (declared?.capability_schema !== 'sks.mad-sks-sql-plane-capability.v2') blockers.push('capability_schema');
  const resultFile = String(declared?.result_file || '');
  const expectedResultFile = madSksSqlPlaneRelativePath(MAD_SKS_SQL_PLANE_RESULT_FILE);
  if (resultFile !== expectedResultFile) blockers.push('result_file');
  const result = resultFile === expectedResultFile
    ? await readJson(path.join(missionDir(root, missionId), ...resultFile.split('/')), null)
    : null;
  if (result?.schema !== 'sks.mad-sks-sql-plane-cycle-result.v1') blockers.push('result_schema');
  if (result?.mission_id !== missionId) blockers.push('result_mission_id');
  if (result?.ok !== true) blockers.push('result_ok');
  if (!nonEmpty(declared?.cycle_id) || !nonEmpty(result?.cycle_id) || declared.cycle_id !== result?.cycle_id) blockers.push('cycle_id');
  if (result?.execution?.ok !== true) blockers.push('execution');
  if (result?.read_back?.ok !== true) blockers.push('independent_read_back');
  if (result?.capability_closed !== true) blockers.push('capability_closed');
  if (result?.read_only_restoration?.ok !== true) blockers.push('read_only_restoration');
  if (declared?.read_back_passed !== true) blockers.push('declared_read_back_passed');
  if (declared?.capability_closed !== true) blockers.push('declared_capability_closed');
  if (declared?.read_only_restored !== true) blockers.push('declared_read_only_restored');
  const sqlPlaneDir = path.join(missionDir(root, missionId), 'mad-sks', 'sql-plane');
  const [capability, closedCapability, runtimeProfile, restoration] = await Promise.all([
    readJson(path.join(sqlPlaneDir, MAD_SKS_SQL_PLANE_CAPABILITY_FILE), null),
    readJson(path.join(sqlPlaneDir, MAD_SKS_SQL_PLANE_CLOSED_CAPABILITY_FILE), null),
    readJson(path.join(sqlPlaneDir, 'runtime', 'runtime-profile-manifest.json'), null),
    readJson(path.join(sqlPlaneDir, 'runtime', 'read-only-restoration.json'), null)
  ]);
  if (capability?.schema !== 'sks.mad-sks-sql-plane-capability.v2') blockers.push('capability_artifact_schema');
  if (capability?.mission_id !== missionId || capability?.cycle_id !== declared?.cycle_id || capability?.status !== 'closed' || !nonEmpty(capability?.closed_at)) blockers.push('capability_artifact_closed_binding');
  if (closedCapability?.schema !== 'sks.mad-sks-sql-plane-capability.v2' || closedCapability?.mission_id !== missionId || closedCapability?.cycle_id !== declared?.cycle_id) blockers.push('closed_capability_artifact_binding');
  if (runtimeProfile?.schema !== 'sks.mad-sks-sql-plane-runtime-profile.v1' || runtimeProfile?.mission_id !== missionId || runtimeProfile?.cycle_id !== declared?.cycle_id) blockers.push('runtime_profile_binding');
  if (!nonEmpty(capability?.transport?.profile_sha256) || capability?.transport?.profile_sha256 !== runtimeProfile?.profile_sha256) blockers.push('runtime_profile_sha256_binding');
  if (restoration?.schema !== 'sks.mad-sks-sql-plane-read-only-restoration.v1' || restoration?.ok !== true || restoration?.runtime_profile_exists !== false) blockers.push('restoration_artifact');
  return { ok: blockers.length === 0, blockers: [...new Set(blockers)] };
}

function validateApplicableSection(section: any, name: string, blockers: string[], options: {
  requiredBooleanFields: string[];
  requiredArrayFields: string[];
  allowEmptyArrayFields?: string[];
}) {
  const status = String(section?.status || '');
  if (!REVIEW_SECTION_STATUSES.has(status)) blockers.push(`${name}:status`);
  if (status === 'not_applicable') {
    if (section?.applicable !== false) blockers.push(`${name}:applicable_false`);
    if (!nonEmpty(section?.reason)) blockers.push(`${name}:reason`);
    if (!nonEmptyArray(section?.evidence)) blockers.push(`${name}:evidence`);
    return;
  }
  if (status !== 'passed') return;
  if (section?.applicable !== true) blockers.push(`${name}:applicable_true`);
  for (const field of options.requiredBooleanFields) {
    if (section?.[field] !== true) blockers.push(`${name}:${field}`);
  }
  for (const field of options.requiredArrayFields) {
    if (!nonEmptyArray(section?.[field])) blockers.push(`${name}:${field}`);
  }
  for (const field of options.allowEmptyArrayFields || []) {
    if (!Array.isArray(section?.[field])) blockers.push(`${name}:${field}_invalid`);
  }
}

function validatePassedSection(section: any, name: string, blockers: string[], fields: string[]) {
  if (String(section?.status || '') !== 'passed') blockers.push(`${name}:status`);
  for (const field of fields) {
    if (section?.[field] !== true) blockers.push(`${name}:${field}`);
  }
  if (!nonEmptyArray(section?.evidence)) blockers.push(`${name}:evidence`);
}

function validateReviewNote(section: any, name: string, blockers: string[], requireStrategy = false) {
  if (section?.reviewed !== true) blockers.push(`${name}:reviewed`);
  if (!nonEmpty(section?.summary)) blockers.push(`${name}:summary`);
  if (requireStrategy && !nonEmpty(section?.strategy)) blockers.push(`${name}:strategy`);
}

function parseManualMigrationSql(content: string) {
  const blockers: string[] = [];
  const headerIndex = content.indexOf(DB_MANUAL_MIGRATION_HEADER);
  const forwardIndex = content.indexOf(DB_MANUAL_FORWARD_MARKER);
  const rollbackIndex = content.indexOf(DB_MANUAL_ROLLBACK_MARKER);
  if (headerIndex !== 0) blockers.push('header');
  if (forwardIndex < 0) blockers.push('forward_marker');
  if (rollbackIndex < 0) blockers.push('rollback_marker');
  if (forwardIndex >= 0 && rollbackIndex >= 0 && forwardIndex >= rollbackIndex) blockers.push('marker_order');
  if (blockers.length) return { blockers, forwardSql: '', rollbackSql: '' };

  const forwardSql = content.slice(forwardIndex + DB_MANUAL_FORWARD_MARKER.length, rollbackIndex).trim();
  const rollbackSection = content.slice(rollbackIndex + DB_MANUAL_ROLLBACK_MARKER.length);
  const rollbackMatch = /^\s*\/\*([\s\S]*?)\*\/\s*$/.exec(rollbackSection);
  const rollbackSql = rollbackMatch?.[1]?.trim() || '';
  if (!forwardSql || !forwardSql.endsWith(';')) blockers.push('forward_sql');
  if (!rollbackMatch || !rollbackSql || !rollbackSql.endsWith(';')) blockers.push('rollback_sql_inactive_block');
  if (MANUAL_SQL_FORBIDDEN_CONTENT_RE.test(`${forwardSql}\n${rollbackSql}`)) blockers.push('placeholder_secret_or_connection_string');
  const forwardClass = forwardSql ? classifySql(forwardSql) : null;
  const rollbackClass = rollbackSql ? classifySql(rollbackSql) : null;
  if (!forwardClass || !['write', 'destructive'].includes(forwardClass.level)) blockers.push('forward_sql_not_migration');
  if (!rollbackClass || !['write', 'destructive'].includes(rollbackClass.level)) blockers.push('rollback_sql_not_migration');
  const forwardReasons = new Set(forwardClass?.reasons || []);
  const rollbackReasons = new Set(rollbackClass?.reasons || []);
  for (const reason of ['drop_database', 'drop_schema', 'drop_table', 'truncate', 'delete_without_where', 'update_without_where']) {
    if (forwardReasons.has(reason)) blockers.push(`forward_catastrophic:${reason}`);
  }
  for (const reason of ['drop_database', 'drop_schema', 'truncate', 'delete_without_where', 'update_without_where']) {
    if (rollbackReasons.has(reason)) blockers.push(`rollback_catastrophic:${reason}`);
  }
  if (rollbackReasons.has('drop_table') && !rollbackDropsOnlyForwardCreatedTables(forwardSql, rollbackSql)) {
    blockers.push('rollback_drop_table_not_created_by_forward');
  }
  return { blockers, forwardSql, rollbackSql };
}

async function collectSqlFilesWithoutFollowingLinks(dir: string) {
  const files: string[] = [];
  let unsafe = false;
  async function walk(current: string, depth: number) {
    if (depth > 4) {
      unsafe = true;
      return;
    }
    const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(dir, absolute).split(path.sep).join('/');
      if (entry.isSymbolicLink()) {
        if (/\.sql$/i.test(entry.name)) unsafe = true;
        continue;
      }
      if (entry.isDirectory()) {
        await walk(absolute, depth + 1);
        continue;
      }
      if (entry.isFile() && /\.sql$/i.test(entry.name)) files.push(relative);
    }
  }
  await walk(dir, 0);
  return { files: files.sort(), unsafe };
}

function manualNoticeIsComplete(value: any) {
  const text = String(value || '');
  const manual = /\bmanual(?:ly)?\b|직접|수동/i.test(text);
  const rollback = /\brollback\b|롤백/i.test(text);
  const separate = /\bseparate(?:ly)?\b|별도|따로|분리/i.test(text);
  const artifact = /\bmanual-migration\.sql\b/i.test(text);
  return manual && rollback && separate && artifact;
}

async function hasBoundContext7Evidence(root: string, missionId: string) {
  const text = await readText(path.join(missionDir(root, missionId), 'context7-evidence.jsonl'), '');
  let resolved = false;
  let docs = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.stage === 'resolve-library-id') resolved = true;
      if (entry?.stage === 'get-library-docs') docs = true;
    } catch {}
  }
  return resolved && docs;
}

function nonEmpty(value: any) {
  return typeof value === 'string' && value.trim().length > 0;
}

function nonEmptyArray(value: any) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => nonEmpty(item));
}

async function listDbSourceFiles(root: string) {
  const out: string[] = [];
  async function walk(dir: string) {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (DB_SOURCE_SKIP_DIRS.has(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(file);
        continue;
      }
      if (entry.isFile() && DB_SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) out.push(file);
    }
  }
  await walk(root);
  return out.sort();
}

function isDbRelevantSource(relative: string, text: string, lines: string[]) {
  if (path.extname(relative).toLowerCase() === '.sql') {
    return /\b(?:select|insert|update|delete|upsert|merge|create|alter|drop|begin|commit|rollback)\b/i.test(text);
  }
  const codeLines = lines.map(candidateCodeLine).filter(Boolean);
  const directSignal = codeLines.some((candidate) => [
    DB_IMPORT_MARKER_RE,
    DB_POOL_MARKER_RE,
    DB_STRONG_QUERY_CALL_MARKER_RE
  ].some((pattern) => pattern.test(candidate)));
  if (directSignal) return true;
  const pathHint = /(?:^|\/)(?:db|database|postgres|supabase|sql-plane)(?:\/|[-_.])/i.test(relative);
  return pathHint && codeLines.some((candidate) => [
      DB_CLIENT_CONSTRUCTOR_RE,
      DB_QUERY_CALL_MARKER_RE
    ].some((pattern) => pattern.test(candidate)));
}

function collectLineCandidates(
  out: Array<{ id: string; kind: string; path: string; line: number; summary: string }>,
  relative: string,
  lines: string[],
  kind: string,
  pattern: RegExp,
  summary: string
) {
  for (let index = 0; index < lines.length; index += 1) {
    const line = candidateCodeLine(lines[index] || '');
    if (!line) continue;
    if (pattern.test(line)) out.push(dbCandidate(relative, index + 1, kind, summary));
  }
}

function candidateCodeLine(line: string) {
  const trimmed = String(line || '').trim();
  if (!trimmed || /^(?:\/\/|\/\*|\*|#|--)/.test(trimmed)) return '';
  if (/\b(?:DB|DATABASE)_[A-Z0-9_]*_?RE\s*=\s*\//.test(trimmed)) return '';
  return line;
}

function dbCandidate(relative: string, line: number, kind: string, summary: string) {
  return {
    id: `db-${sha256(`${kind}:${relative}:${line}:${summary}`).slice(0, 16)}`,
    kind,
    path: relative,
    line,
    summary
  };
}

function candidateIds(value: any) {
  return sortedUniqueStrings(Array.isArray(value?.candidates) ? value.candidates.map((candidate: any) => candidate?.id) : []);
}

function sortedUniqueStrings(value: any) {
  return [...new Set(Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : [])].sort();
}

function rollbackDropsOnlyForwardCreatedTables(forwardSql: string, rollbackSql: string) {
  const created = sqlObjectNames(forwardSql, /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?(?:"([^"]+)"|([A-Za-z_][\w$.]*))/gi);
  const dropped = sqlObjectNames(rollbackSql, /\bdrop\s+table\s+(?:if\s+exists\s+)?(?:"([^"]+)"|([A-Za-z_][\w$.]*))/gi);
  return dropped.length > 0 && dropped.every((name) => created.includes(name));
}

function sqlObjectNames(sql: string, pattern: RegExp) {
  const out: string[] = [];
  let match;
  while ((match = pattern.exec(sql))) {
    const name = String(match[1] || match[2] || '').replace(/^public\./i, '').toLowerCase();
    if (name) out.push(name);
  }
  return [...new Set(out)].sort();
}
