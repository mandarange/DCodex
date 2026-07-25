import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, exists, nowIso, readJson, writeJsonAtomic, writeTextAtomic } from '../fsx.js';
import { withFileLock } from '../locks/file-lock.js';
import { findLatestMission, missionsDir } from '../mission.js';
import { codexSchemaPath, runCodexExecResumeWithOutputSchema } from '../codex-exec-output-schema.js';
import {
  WRONGNESS_INDEX_SCHEMA,
  WRONGNESS_LEDGER_SCHEMA,
  createWrongnessRecord,
  deterministicWrongnessId,
  emptyWrongnessLedger,
  normalizeRootCauseKind,
  normalizeSeverity,
  normalizeWrongnessKind,
  severityForRecord,
  validateWrongnessLedger,
  type WrongnessKind,
  type WrongnessLedger,
  type WrongnessRecord,
  type WrongnessSeverity
} from './wrongness-schema.js';
import { asRecordOrEmpty as asRecord } from '../json/records.js';

type JsonRecord = Record<string, unknown>;
const CANONICAL_MISSION_ID_RE = /^M-[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function projectWrongnessLedgerPath(root: string): string {
  return path.join(safeWrongnessWikiDir(root), 'wrongness-ledger.json');
}

export function wrongnessIndexPath(root: string): string {
  return path.join(safeWrongnessWikiDir(root), 'wrongness-index.json');
}

export function wrongnessSummaryPath(root: string): string {
  return path.join(safeWrongnessWikiDir(root), 'wrongness-summary.md');
}

export function missionWrongnessLedgerPath(root: string, missionId: string): string {
  return path.join(safeWrongnessMissionDir(root, missionId), 'wrongness-ledger.json');
}

export function missionWrongnessSummaryPath(root: string, missionId: string): string {
  return path.join(safeWrongnessMissionDir(root, missionId), 'wrongness-summary.md');
}

export function missionWrongnessLinksPath(root: string, missionId: string): string {
  return path.join(safeWrongnessMissionDir(root, missionId), 'wrongness-triwiki-links.json');
}

export async function resolveWrongnessMissionId(root: string, missionArg: unknown = null): Promise<string | null> {
  const raw = typeof missionArg === 'string' && missionArg.trim() ? missionArg.trim() : null;
  if (!raw || raw === 'project') return null;
  const resolved = raw === 'latest' ? await findLatestMission(root) : raw;
  if (!resolved) return null;
  assertCanonicalMissionId(resolved);
  return resolved;
}

export async function readWrongnessLedger(root: string, missionId: string | null = null): Promise<WrongnessLedger> {
  const ledger = await readBaseWrongnessLedger(root, missionId);
  if (missionId) return ledger;
  const shared = await readSharedWrongnessShardRecords(root);
  return {
    ...ledger,
    records: dedupeRecords([...shared, ...ledger.records])
  };
}

async function readBaseWrongnessLedger(root: string, missionId: string | null = null): Promise<WrongnessLedger> {
  const file = missionId ? missionWrongnessLedgerPath(root, missionId) : projectWrongnessLedgerPath(root);
  if (!(await exists(file))) return emptyWrongnessLedger(missionId ? 'mission' : 'project', missionId);
  const raw = await readJson(file, emptyWrongnessLedger(missionId ? 'mission' : 'project', missionId));
  return normalizeWrongnessLedger(raw, missionId ? 'mission' : 'project', missionId);
}

export async function writeWrongnessLedger(root: string, ledger: WrongnessLedger): Promise<WrongnessLedger> {
  return withWrongnessMutationLock(root, () => writeWrongnessLedgerUnlocked(root, ledger));
}

async function writeWrongnessLedgerUnlocked(root: string, ledger: WrongnessLedger): Promise<WrongnessLedger> {
  const file = ledger.mission_id ? missionWrongnessLedgerPath(root, ledger.mission_id) : projectWrongnessLedgerPath(root);
  const normalized = normalizeWrongnessLedger({ ...ledger, generated_at: nowIso() }, ledger.scope, ledger.mission_id);
  await ensureDir(path.dirname(file));
  await writeJsonAtomic(file, normalized);
  return normalized;
}

export async function readCombinedWrongnessRecords(root: string, missionId: string | null = null): Promise<WrongnessRecord[]> {
  const project = await readWrongnessLedger(root, null);
  const mission = missionId ? await readWrongnessLedger(root, missionId) : emptyWrongnessLedger('mission', missionId);
  // The project ledger is also the cross-mission index, so it contains copies
  // of mission-scoped records. A mission proof must inherit only truly global
  // project records plus rows owned by that mission; otherwise unrelated old
  // missions can block every future route forever.
  const projectRecords = missionId
    ? project.records.filter((record) => !record.mission_id || record.mission_id === missionId)
    : project.records;
  return dedupeRecords([...projectRecords, ...mission.records]);
}

export async function addWrongnessRecord(root: string, input: unknown = {}, opts: { missionId?: string | null } = {}): Promise<{ record: WrongnessRecord; project: WrongnessLedger; mission: WrongnessLedger | null }> {
  const row = asRecord(input);
  const missionId = typeof opts.missionId === 'string'
    ? opts.missionId
    : typeof row.mission_id === 'string'
      ? row.mission_id
      : null;
  if (missionId) assertCanonicalMissionId(missionId);
  const record = createWrongnessRecord({ ...row, mission_id: missionId });
  return withWrongnessMutationLock(root, async () => {
    const project = await upsertIntoScopeUnlocked(root, null, record);
    const mission = missionId ? await upsertIntoScopeUnlocked(root, missionId, record) : null;
    await writeWrongnessSummariesUnlocked(root, missionId);
    return { record, project, mission };
  });
}

export async function extractWrongnessWithOutputSchema(root: string, {
  sessionId,
  prompt,
  outputFile = null
}: { sessionId?: string | null; prompt?: string | null; outputFile?: string | null } = {}) {
  if (!sessionId) {
    return {
      schema: 'sks.wrongness-output-schema-run.v1',
      ok: false,
      status: 'integration_optional',
      blocker: 'codex_resume_session_required'
    };
  }
  const schemaPath = await codexSchemaPath('wrongness-record');
  return runCodexExecResumeWithOutputSchema({
    sessionId,
    prompt: prompt || 'Extract a single SKS Wrongness record as strict schema-bound JSON.',
    outputSchemaPath: schemaPath,
    outputFile
  }, { cwd: root });
}

export async function resolveWrongnessRecord(root: string, id: string, reason = 'Resolved after corrective action', status: 'resolved' | 'false_alarm' = 'resolved'): Promise<{ updated: number; records: WrongnessRecord[] }> {
  return withWrongnessMutationLock(root, async () => {
    const scopes = await discoverWrongnessScopes(root);
    const updatedRecords: WrongnessRecord[] = [];
    const changedMissions = new Set<string>();
    let updated = 0;
    for (const missionId of scopes) {
      // Mutations must start from the writable base ledger. The project reader also
      // overlays shared shards, and writing that combined view would duplicate every
      // shared record into the project ledger.
      const ledger = await readBaseWrongnessLedger(root, missionId);
      let changed = false;
      const records = ledger.records.map((record) => {
        if (record.id !== id) return record;
        changed = true;
        updated += 1;
        const next: WrongnessRecord = {
          ...record,
          updated_at: nowIso(),
          status,
          truth_status: status === 'false_alarm' ? 'uncertain' : 'corrected',
          corrective_action: {
            ...record.corrective_action,
            patch_status: status,
            summary: reason || record.corrective_action.summary
          }
        };
        updatedRecords.push(next);
        return next;
      });
      if (changed) {
        await writeWrongnessLedgerUnlocked(root, { ...ledger, records });
        if (missionId) changedMissions.add(missionId);
      }
    }
    await writeWrongnessSummariesUnlocked(root, null);
    for (const missionId of changedMissions) await writeMissionWrongnessSummaryUnlocked(root, missionId);
    return { updated, records: updatedRecords };
  });
}

export async function findWrongnessRecord(root: string, id: string): Promise<WrongnessRecord | null> {
  for (const missionId of await discoverWrongnessScopes(root)) {
    const ledger = await readWrongnessLedger(root, missionId);
    const found = ledger.records.find((record) => record.id === id);
    if (found) return found;
  }
  return null;
}

export async function validateWrongnessScope(root: string, target: string | null = null): Promise<{ ok: boolean; checked: number; issues: string[]; ledgers: number }> {
  const missionId = await resolveWrongnessMissionId(root, target || 'project');
  const ledgers = missionId ? [await readWrongnessLedger(root, missionId)] : [await readWrongnessLedger(root, null)];
  if (target === 'latest') {
    const project = await readWrongnessLedger(root, null);
    ledgers.unshift(project);
  }
  const issues: string[] = [];
  let checked = 0;
  for (const ledger of ledgers) {
    const validation = validateWrongnessLedger(ledger);
    checked += validation.checked;
    issues.push(...validation.issues.map((issue) => `${ledger.scope}:${ledger.mission_id || 'project'}:${issue}`));
  }
  return { ok: issues.length === 0, checked, issues: [...new Set(issues)], ledgers: ledgers.length };
}

export async function summarizeWrongness(root: string, missionId: string | null = null): Promise<JsonRecord> {
  const records = await readCombinedWrongnessRecords(root, missionId);
  return summarizeWrongnessRecords(records);
}

export function summarizeWrongnessRecords(records: readonly WrongnessRecord[]): JsonRecord {
  const active = records.filter((record) => record.status === 'active');
  const byKind = countBy(records, (record) => record.wrongness_kind);
  const bySeverity = countBy(active, (record) => record.severity);
  return {
    schema: 'sks.triwiki-wrongness-summary.v1',
    generated_at: nowIso(),
    total: records.length,
    active: active.length,
    resolved: records.filter((record) => record.status === 'resolved').length,
    high_severity_active: active.filter((record) => record.severity === 'high' || record.severity === 'critical').length,
    medium_severity_active: active.filter((record) => record.severity === 'medium').length,
    by_kind: byKind,
    by_severity: bySeverity,
    active_ids: active.map((record) => record.id),
    avoidance_rules: active.map((record) => record.avoidance_rule).filter((rule) => rule.text)
  };
}

export async function writeWrongnessSummaries(root: string, missionId: string | null = null): Promise<void> {
  return withWrongnessMutationLock(root, () => writeWrongnessSummariesUnlocked(root, missionId));
}

async function writeWrongnessSummariesUnlocked(root: string, missionId: string | null = null): Promise<void> {
  await writeProjectWrongnessIndex(root);
  await writeTextAtomic(wrongnessSummaryPath(root), renderWrongnessSummaryMarkdown(await readWrongnessLedger(root, null), 'Project Wrongness Memory'));
  if (missionId) await writeMissionWrongnessSummaryUnlocked(root, missionId);
}

async function writeMissionWrongnessSummaryUnlocked(root: string, missionId: string): Promise<void> {
  const ledger = await readBaseWrongnessLedger(root, missionId);
  await writeTextAtomic(missionWrongnessSummaryPath(root, missionId), renderWrongnessSummaryMarkdown(ledger, `Mission ${missionId} Wrongness Memory`));
  await writeJsonAtomic(missionWrongnessLinksPath(root, missionId), {
    schema: 'sks.triwiki-wrongness-links.v1',
    generated_at: nowIso(),
    mission_id: missionId,
    project_ledger: '.sneakoscope/wiki/wrongness-ledger.json',
    mission_ledger: `.sneakoscope/missions/${missionId}/wrongness-ledger.json`,
    active_ids: ledger.records.filter((record) => record.status === 'active').map((record) => record.id)
  });
}

export async function recordWrongnessFromTrustReport(root: string, report: unknown): Promise<{ created: number; records: WrongnessRecord[] }> {
  const row = asRecord(report);
  if (row.ok === true) return { created: 0, records: [] };
  const issues = Array.isArray(row.issues) ? row.issues.map(String) : [];
  const missionId = typeof row.mission_id === 'string' ? row.mission_id : null;
  const records: WrongnessRecord[] = [];
  for (const issue of issues) {
    if (/^wrongness:|active_wrongness/i.test(issue)) continue;
    const kind = wrongnessKindForTrustIssue(issue);
    const record = createWrongnessRecord({
      id: deterministicWrongnessId(['trust', missionId, issue]),
      mission_id: missionId,
      route: typeof row.route === 'string' ? row.route : null,
      wrongness_kind: kind,
      severity: kind === 'trust_status_overclaim' ? 'high' : 'medium',
      claim: {
        text: `Trust validation issue remained active: ${issue}`,
        prior_status: typeof row.status === 'string' ? row.status : null
      },
      detected_by: {
        source: 'trust_validate',
        artifact: missionId ? `.sneakoscope/missions/${missionId}/trust-report.json` : null,
        command: 'sks trust validate',
        detail: issue
      },
      root_cause: {
        category: issueRootCause(issue),
        explanation: `Trust validation reported ${issue}.`
      },
      corrective_action: {
        summary: 'Fix or explicitly verify the blocked trust issue, then rerun trust validation.',
        required_evidence: ['trust-report.json', 'completion-proof.json'],
        patch_status: 'pending'
      },
      links: { artifacts: missionId ? [`.sneakoscope/missions/${missionId}/trust-report.json`] : [] }
    });
    const saved = await addWrongnessRecord(root, record, { missionId });
    records.push(saved.record);
  }
  return { created: records.length, records };
}

export async function recordTestFailureWrongness(root: string, input: unknown = {}): Promise<WrongnessRecord> {
  const row = asRecord(input);
  const missionId = typeof row.mission_id === 'string' ? row.mission_id : null;
  const command = typeof row.command === 'string' ? row.command : 'test command';
  const failure = typeof row.failure === 'string' ? row.failure : 'test failure';
  const saved = await addWrongnessRecord(root, {
    id: deterministicWrongnessId(['test_failure', missionId, command, failure]),
    mission_id: missionId,
    route: typeof row.route === 'string' ? row.route : null,
    wrongness_kind: 'test_failure',
    severity: normalizeSeverity(row.severity ?? 'high'),
    claim: { text: `A verification command failed: ${command} (${failure})` },
    detected_by: { source: 'test_failure', command, artifact: typeof row.artifact === 'string' ? row.artifact : null, detail: failure },
    root_cause: { category: 'insufficient_test_coverage', explanation: 'A test or fixture detected behavior that the current proof cannot support.' },
    corrective_action: { summary: 'Fix the failing behavior or narrow the claim, then rerun the command.', required_evidence: [command], patch_status: 'pending' },
    links: { tests: [command], artifacts: typeof row.artifact === 'string' ? [row.artifact] : [] }
  }, { missionId });
  return saved.record;
}

export async function recordDbSafetyMismatchWrongness(root: string, input: unknown = {}): Promise<WrongnessRecord | null> {
  const row = asRecord(input);
  const expected = String(row.expected || '').toLowerCase();
  const actual = String(row.actual || '').toLowerCase();
  if (!expected || !actual || expected === actual) return null;
  const missionId = typeof row.mission_id === 'string' ? row.mission_id : null;
  const kind: WrongnessKind = expected === 'blocked' && actual !== 'blocked'
    ? 'db_safety_false_negative'
    : 'db_safety_false_positive';
  const saved = await addWrongnessRecord(root, {
    id: deterministicWrongnessId(['db_mismatch', missionId, expected, actual, row.command, row.sql]),
    mission_id: missionId,
    route: '$DB',
    wrongness_kind: kind,
    severity: kind === 'db_safety_false_negative' ? 'high' : 'medium',
    claim: { text: `DB safety expected ${expected} but classified ${actual}.` },
    detected_by: { source: 'db_safety_check', command: typeof row.command === 'string' ? row.command : '$DB internal safety check', artifact: typeof row.artifact === 'string' ? row.artifact : null, detail: typeof row.sql === 'string' ? row.sql : null },
    root_cause: { category: 'missing_db_policy', explanation: 'A DB safety expectation did not match the current classifier output.' },
    corrective_action: { summary: 'Adjust the policy/classifier or fixture expectation, then rerun DB safety validation.', required_evidence: ['db-operation-report.json'], patch_status: 'pending' },
    links: { artifacts: typeof row.artifact === 'string' ? [row.artifact] : [] }
  }, { missionId });
  return saved.record;
}

export async function recordHookPolicyMismatchWrongness(root: string, input: unknown = {}): Promise<WrongnessRecord> {
  const row = asRecord(input);
  const missionId = typeof row.mission_id === 'string' ? row.mission_id : null;
  const kind = normalizeWrongnessKind(row.wrongness_kind ?? row.kind ?? 'hook_policy_mismatch');
  const saved = await addWrongnessRecord(root, {
    id: deterministicWrongnessId([kind, missionId, row.expected, row.actual, row.artifact]),
    mission_id: missionId,
    route: typeof row.route === 'string' ? row.route : null,
    wrongness_kind: kind,
    severity: 'high',
    claim: { text: `Hook policy mismatch: expected ${String(row.expected || 'unknown')} but observed ${String(row.actual || 'unknown')}.` },
    detected_by: { source: kind === 'hook_semantic_mismatch' || kind === 'hook_strict_subset_misclassified' ? 'hook_semantic_validator' : 'hook_replay', command: 'sks hooks replay', artifact: typeof row.artifact === 'string' ? row.artifact : null, detail: typeof row.detail === 'string' ? row.detail : null },
    root_cause: { category: 'route_policy_gap', explanation: kind === 'hook_strict_subset_misclassified' ? 'Hook output classification mixed upstream parser unsupported fields with SKS zero-warning strict-subset rules.' : kind === 'hook_semantic_mismatch' ? 'Hook output passed schema-tolerant shape but violated Codex runtime semantic parser rules.' : 'Hook replay output diverged from the configured route/trust policy.' },
    corrective_action: { summary: kind === 'hook_strict_subset_misclassified' ? 'Separate upstream semantic unsupported issues from SKS strict-subset policy issues and rerun warning gates.' : kind === 'hook_semantic_mismatch' ? 'Align hook builders and fixtures with Codex runtime semantic parser rules before release.' : 'Align hook policy, replay fixture, and trust expectation before accepting hook evidence.', required_evidence: ['hooks replay output'], patch_status: 'pending' },
    links: { artifacts: typeof row.artifact === 'string' ? [row.artifact] : [] }
  }, { missionId });
  return saved.record;
}

export async function recordAgentMismatchWrongness(root: string, input: unknown = {}): Promise<WrongnessRecord> {
  const row = asRecord(input);
  const missionId = typeof row.mission_id === 'string' ? row.mission_id : null;
  const agentId = typeof row.agent_id === 'string' ? row.agent_id : 'unknown-agent';
  const issues = Array.isArray(row.issues) ? row.issues.map(String) : [String(row.issue || 'agent mismatch')];
  const saved = await addWrongnessRecord(root, {
    id: deterministicWrongnessId(['agent_mismatch', missionId, agentId, issues]),
    mission_id: missionId,
    route: typeof row.route === 'string' ? row.route : null,
    wrongness_kind: 'agent_output_error',
    severity: 'medium',
    claim: { text: `Agent ${agentId} produced a parse or claim mismatch: ${issues.join(', ')}` },
    detected_by: { source: 'agent_validation', command: 'sks naruto run', artifact: typeof row.artifact === 'string' ? row.artifact : null, detail: issues.join(', ') },
    root_cause: { category: 'agent_reasoning_error', explanation: 'Agent output could not be accepted as clean handoff evidence.' },
    corrective_action: { summary: 'Repair agent output parsing or downgrade the agent claim before consensus uses it.', required_evidence: ['agent result json'], patch_status: 'pending' },
    avoidance_rule: { text: 'Do not promote agent findings with parse issues or claim mismatches into consensus without correction.', applies_to: ['agents', '$Naruto'], severity: 'medium' },
    links: { artifacts: typeof row.artifact === 'string' ? [row.artifact] : [] }
  }, { missionId });
  return saved.record;
}

function normalizeWrongnessLedger(value: unknown, scope: 'project' | 'mission', missionId: string | null): WrongnessLedger {
  const row = asRecord(value);
  const records = Array.isArray(row.records) ? row.records.map((record) => createWrongnessRecord(record)) : [];
  return {
    schema: WRONGNESS_LEDGER_SCHEMA,
    generated_at: typeof row.generated_at === 'string' ? row.generated_at : nowIso(),
    scope,
    mission_id: missionId,
    records
  };
}

async function upsertIntoScopeUnlocked(root: string, missionId: string | null, record: WrongnessRecord): Promise<WrongnessLedger> {
  const ledger = await readBaseWrongnessLedger(root, missionId);
  const nextRecords = upsertRecord(ledger.records, record);
  return writeWrongnessLedgerUnlocked(root, { ...ledger, records: nextRecords });
}

function withWrongnessMutationLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const lockDir = safeWrongnessLockDir(root);
  return withFileLock({
    lockPath: path.join(lockDir, 'triwiki-wrongness.lock'),
    timeoutMs: 60_000,
    staleMs: 120_000
  }, fn);
}

function upsertRecord(records: readonly WrongnessRecord[], record: WrongnessRecord): WrongnessRecord[] {
  const seen = new Set<string>();
  const out: WrongnessRecord[] = [];
  let replaced = false;
  for (const existing of records) {
    if (seen.has(existing.id)) continue;
    seen.add(existing.id);
    if (existing.id === record.id) {
      out.push({ ...existing, ...record, created_at: existing.created_at || record.created_at, updated_at: nowIso() });
      replaced = true;
    } else {
      out.push(existing);
    }
  }
  if (!replaced) out.push(record);
  return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

async function discoverWrongnessScopes(root: string): Promise<Array<string | null>> {
  const scopes: Array<string | null> = [null];
  const base = missionsDir(root);
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(base);
  } catch {
    return scopes;
  }
  for (const name of entries) {
    if (!CANONICAL_MISSION_ID_RE.test(name)) continue;
    if (await exists(missionWrongnessLedgerPath(root, name))) scopes.push(name);
  }
  return scopes;
}

function assertCanonicalMissionId(missionId: string) {
  if (!CANONICAL_MISSION_ID_RE.test(String(missionId || ''))) throw new Error(`invalid_mission_id:${missionId}`);
}

function safeWrongnessMissionDir(root: string, missionId: string) {
  assertCanonicalMissionId(missionId);
  const resolvedRoot = path.resolve(root);
  const stateRoot = assertSafeSneakoscopeRoot(resolvedRoot);
  const base = path.resolve(missionsDir(resolvedRoot));
  const candidate = path.resolve(base, missionId);
  const relative = path.relative(base, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`mission_path_outside_root:${missionId}`);
  const baseStat = lstatIfPresent(base);
  if (baseStat && (!baseStat.isDirectory() || baseStat.isSymbolicLink())) throw new Error('unsafe_missions_root_symlink');
  const candidateStat = lstatIfPresent(candidate);
  if (candidateStat && (!candidateStat.isDirectory() || candidateStat.isSymbolicLink())) throw new Error(`unsafe_mission_directory:${missionId}`);
  if (baseStat && candidateStat) {
    const realBase = fs.realpathSync(base);
    const realCandidate = fs.realpathSync(candidate);
    const realRelative = path.relative(realBase, realCandidate);
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new Error(`mission_realpath_outside_root:${missionId}`);
  }
  return candidate;
}

function safeWrongnessWikiDir(root: string) {
  const stateRoot = assertSafeSneakoscopeRoot(root);
  const wiki = path.join(stateRoot, 'wiki');
  const wikiStat = lstatIfPresent(wiki);
  if (wikiStat && (!wikiStat.isDirectory() || wikiStat.isSymbolicLink())) throw new Error('unsafe_wrongness_wiki_symlink');
  if (wikiStat) {
    const realState = fs.realpathSync(stateRoot);
    const realWiki = fs.realpathSync(wiki);
    const relative = path.relative(realState, realWiki);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('wrongness_wiki_realpath_outside_root');
  }
  return wiki;
}

function safeWrongnessLockDir(root: string) {
  const stateRoot = assertSafeSneakoscopeRoot(root);
  const locks = path.join(stateRoot, 'locks');
  const lockStat = lstatIfPresent(locks);
  if (lockStat && (!lockStat.isDirectory() || lockStat.isSymbolicLink())) throw new Error('unsafe_wrongness_lock_symlink');
  if (lockStat) {
    const realState = fs.realpathSync(stateRoot);
    const realLocks = fs.realpathSync(locks);
    const relative = path.relative(realState, realLocks);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('wrongness_lock_realpath_outside_root');
  }
  return locks;
}

function assertSafeSneakoscopeRoot(root: string) {
  const resolvedRoot = path.resolve(root);
  const stateRoot = path.join(resolvedRoot, '.sneakoscope');
  const stateStat = lstatIfPresent(stateRoot);
  if (stateStat && (!stateStat.isDirectory() || stateStat.isSymbolicLink())) throw new Error('unsafe_sneakoscope_root_symlink');
  if (stateStat) {
    const realRoot = fs.realpathSync(resolvedRoot);
    const realState = fs.realpathSync(stateRoot);
    const relative = path.relative(realRoot, realState);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('sneakoscope_realpath_outside_root');
  }
  return stateRoot;
}

function lstatIfPresent(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function dedupeRecords(records: readonly WrongnessRecord[]): WrongnessRecord[] {
  const byId = new Map<string, WrongnessRecord>();
  for (const record of records) byId.set(record.id, record);
  return Array.from(byId.values()).sort((a, b) => a.created_at.localeCompare(b.created_at));
}

async function readSharedWrongnessShardRecords(root: string): Promise<WrongnessRecord[]> {
  const dir = path.join(root, '.sneakoscope', 'wiki', 'wrongness');
  const records: WrongnessRecord[] = [];
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return records;
  }
  for (const name of entries.filter((entry) => entry.endsWith('.json')).sort()) {
    const row = await readJson(path.join(dir, name), null);
    if (!row || typeof row !== 'object') continue;
    const wrapped = row as Record<string, unknown>;
    if (wrapped.schema === 'sks.triwiki-wrongness-record.v1' && wrapped.wrongness) records.push(createWrongnessRecord(wrapped.wrongness));
    else records.push(createWrongnessRecord(wrapped));
  }
  return records;
}

async function writeProjectWrongnessIndex(root: string): Promise<void> {
  const ledger = await readWrongnessLedger(root, null);
  const active = ledger.records.filter((record) => record.status === 'active');
  const index = {
    schema: WRONGNESS_INDEX_SCHEMA,
    generated_at: nowIso(),
    project_ledger: '.sneakoscope/wiki/wrongness-ledger.json',
    summary: summarizeWrongnessRecords(ledger.records),
    records: ledger.records.map((record) => ({
      id: record.id,
      status: record.status,
      truth_status: record.truth_status,
      wrongness_kind: record.wrongness_kind,
      severity: record.severity,
      mission_id: record.mission_id,
      route: record.route,
      claim: record.claim.text,
      avoidance_rule: record.avoidance_rule.text,
      updated_at: record.updated_at
    })),
    active_avoidance_rules: active.map((record) => record.avoidance_rule)
  };
  await ensureDir(path.dirname(wrongnessIndexPath(root)));
  await writeJsonAtomic(wrongnessIndexPath(root), index);
}

function renderWrongnessSummaryMarkdown(ledger: WrongnessLedger, title: string): string {
  const summary = summarizeWrongnessRecords(ledger.records);
  const lines = [
    `# ${title}`,
    '',
    `- Generated: ${nowIso()}`,
    `- Scope: ${ledger.scope}`,
    `- Mission: ${ledger.mission_id || 'project'}`,
    `- Total records: ${summary.total}`,
    `- Active: ${summary.active}`,
    `- High severity active: ${summary.high_severity_active}`,
    '',
    '## Active Records',
    ''
  ];
  const active = ledger.records.filter((record) => record.status === 'active');
  if (!active.length) lines.push('- None');
  for (const record of active) {
    lines.push(`- ${record.id} [${record.severity}/${record.wrongness_kind}] ${record.claim.text}`);
    lines.push(`  Avoid: ${record.avoidance_rule.text}`);
  }
  return `${lines.join('\n')}\n`;
}

function wrongnessKindForTrustIssue(issue: string): WrongnessKind {
  if (/mock|fixture|static/i.test(issue)) return 'mock_real_confusion';
  if (/stale/i.test(issue)) return 'stale_evidence';
  if (/missing|not_found|required/i.test(issue)) return 'missing_evidence';
  if (/schema|artifact/i.test(issue)) return 'artifact_schema_error';
  if (/status|verified|overclaim|unsupported/i.test(issue)) return 'trust_status_overclaim';
  return 'trust_status_overclaim';
}

function issueRootCause(issue: string): ReturnType<typeof normalizeRootCauseKind> {
  if (/stale/i.test(issue)) return 'stale_context';
  if (/mock|fixture|static/i.test(issue)) return 'mock_evidence_overweight';
  if (/schema|artifact/i.test(issue)) return 'schema_validation_gap';
  if (/missing|required/i.test(issue)) return 'bad_source';
  return 'unknown';
}

function countBy(records: readonly WrongnessRecord[], key: (record: WrongnessRecord) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const record of records) out[key(record)] = Number(out[key(record)] || 0) + 1;
  return out;
}

export function highSeverityActive(records: readonly WrongnessRecord[]): WrongnessRecord[] {
  return records.filter((record) => record.status === 'active' && ['high', 'critical'].includes(severityForRecord(record)));
}

export function mediumSeverityActive(records: readonly WrongnessRecord[]): WrongnessRecord[] {
  return records.filter((record) => record.status === 'active' && severityForRecord(record) === 'medium');
}

export function normalizeAutomaticWrongnessKind(value: unknown): WrongnessKind {
  return normalizeWrongnessKind(value);
}

export function normalizeAutomaticSeverity(value: unknown): WrongnessSeverity {
  return normalizeSeverity(value);
}
