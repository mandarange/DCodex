import { constants as fsConstants } from 'node:fs';
import type { Stats } from 'node:fs';
import fsp from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  PACKAGE_VERSION,
  nowIso,
  randomId,
  readJson,
  sha256,
  withScratchDir
} from '../fsx.js';
import { withManagedSkillGenerationLock } from '../codex-native/managed-skill-generation-lock.js';
import {
  ensureConfinedDirectory,
  inspectConfinedPath,
  isLexicallyConfined,
  ManagedPathSafetyError,
  uniqueConfinedPath
} from '../managed-path-safety.js';
import {
  buildMigrationEvent,
  type MigrationEvent
} from '../migration/migration-transaction-journal.js';
import {
  currentSksSkillName,
  inspectCurrentSksManagedSkillContent,
  type ManagedSkillDigestRecoveryAttempt,
  type ManagedSkillDigestRecoveryReport,
  type SksSkillSourceIssue,
  type SksSkillSourceResolution
} from '../codex-native/sks-skill-paths.js';

const CONTENT_DIGEST_MISMATCH = 'content_digest_mismatch';
const PACKAGED_SKILLS_MANIFEST_SCHEMA = 'sks.skills-manifest.v1';
const MANAGED_SKILL_MARKER_RE = /BEGIN SKS (?:IMMUTABLE CORE|MANAGED) SKILL/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const MIGRATION_JOURNAL_FILE = 'migration-journal.jsonl';

interface PackagedManagedSkillContent {
  canonical_name: string;
  content: string;
  content_sha256: string;
}

interface FileSnapshotIdentity {
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtime_ms: number;
  ctime_ms: number;
}

interface SafeRegularSkillSnapshot {
  content: string;
  content_sha256: string;
  identity: FileSnapshotIdentity;
}

interface OpenSafeRegularSkillSnapshot {
  handle: FileHandle;
  snapshot: SafeRegularSkillSnapshot;
}

export interface ManagedSkillDigestHealTestHooks {
  beforeAtomicReplace?: (context: {
    canonical_skill: string;
    original_path: string;
    backup_path: string;
  }) => void | Promise<void>;
  beforeFinalPromotion?: (context: {
    canonical_skill: string;
    original_path: string;
    backup_path: string;
  }) => void | Promise<void>;
  afterAtomicReplace?: (context: {
    canonical_skill: string;
    original_path: string;
    backup_path: string;
  }) => void | Promise<void>;
}

class ManagedSkillReplaceConflict extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ManagedSkillReplaceConflict';
  }
}

let packagedManagedSkillContentsPromise: Promise<Map<string, PackagedManagedSkillContent>> | null = null;
const activeHealAttempts = new Map<string, Promise<ManagedSkillDigestRecoveryAttempt>>();
const activeGenerationHealAttempts = new Map<string, Promise<ManagedSkillDigestRecoveryReport>>();

export interface StaleGlobalManagedSkillGeneration {
  home: string;
  installed_version: string;
  runtime_version: string;
  reason:
    | 'version_mismatch'
    | 'manifest_missing'
    | 'manifest_digest_mismatch'
    | 'installed_content_mismatch';
}

export function managedSkillResolutionIsHealable(resolution: SksSkillSourceResolution | null): boolean {
  return healableMismatchIssues(resolution).length > 0;
}

export async function healAuthoritativeManagedSkillDigestMismatches(input: {
  root: string;
  resolution: SksSkillSourceResolution;
  home?: string;
  testHooks?: ManagedSkillDigestHealTestHooks;
  generationOnly?: boolean;
}): Promise<ManagedSkillDigestRecoveryReport> {
  const issues = healableMismatchIssues(input.resolution);
  if (!issues.length) return { attempted: false, healed_count: 0, attempts: [] };

  const root = path.resolve(input.root);
  const home = path.resolve(input.home || process.env.HOME || os.homedir());
  // The per-file claim transaction below is retained only for deterministic
  // fault-injection tests. Production admission repairs whole trusted
  // generations, so a process crash can never strand a canonical SKILL.md in
  // the claim window.
  const generationOnly = input.generationOnly === true || !input.testHooks;
  if (!input.testHooks) {
    const staleGeneration = await staleGlobalManagedSkillGeneration(home).catch(() => null);
    if (staleGeneration) {
      const key = `${home}\0${staleGeneration.installed_version}\0${staleGeneration.reason}`;
      let work = activeGenerationHealAttempts.get(key);
      if (!work) {
        work = reconcileStaleGlobalManagedSkillGeneration({
          root,
          home,
          issues,
          expected: staleGeneration
        });
        activeGenerationHealAttempts.set(key, work);
      }
      try {
        const shared = await work;
        const outcome = shared.attempts[0];
        return outcome
          ? generationRecoveryReport(issues, outcome.status, outcome.reason)
          : shared;
      } finally {
        if (activeGenerationHealAttempts.get(key) === work) {
          activeGenerationHealAttempts.delete(key);
        }
      }
    }
  }
  if (generationOnly) {
    return { attempted: false, healed_count: 0, attempts: [] };
  }
  let packaged: Map<string, PackagedManagedSkillContent>;
  try {
    packaged = await currentPackagedManagedSkillContents();
  } catch {
    return {
      attempted: true,
      healed_count: 0,
      attempts: issues.map((issue) => recoveryAttempt(issue, {
        status: 'failed',
        reason: 'packaged_authoritative_content_unavailable'
      }))
    };
  }

  const attempts: ManagedSkillDigestRecoveryAttempt[] = [];
  for (const issue of issues) {
    const createAttempt = () => healOneManagedSkillDigestMismatch({
      root,
      home,
      issue,
      packaged: packaged.get(issue.canonical_name) || null,
      ...(input.testHooks ? { testHooks: input.testHooks } : {})
    });
    if (input.testHooks) {
      attempts.push(await createAttempt());
      continue;
    }

    const key = `${root}\0${home}\0${issue.canonical_name}\0${issue.content_sha256 || ''}`;
    let work = activeHealAttempts.get(key);
    if (!work) {
      work = withGlobalManagedSkillHealLock(home, createAttempt);
      activeHealAttempts.set(key, work);
    }
    try {
      attempts.push(await work);
    } finally {
      if (activeHealAttempts.get(key) === work) activeHealAttempts.delete(key);
    }
  }
  return {
    attempted: true,
    healed_count: attempts.filter((attempt) => attempt.status === 'healed').length,
    attempts
  };
}

export async function staleGlobalManagedSkillGeneration(
  home?: string
): Promise<StaleGlobalManagedSkillGeneration | null> {
  const resolvedHome = path.resolve(home || process.env.HOME || os.homedir());
  const skillsRoot = path.join(resolvedHome, '.agents', 'skills');
  const marker: any = await readJson(path.join(skillsRoot, '.sks-generated.json'), null);
  if (String(marker?.generated_by || '') !== 'sneakoscope') return null;

  const installedVersion = String(marker?.version || '').trim();
  if (!installedVersion || installedVersion !== PACKAGE_VERSION) {
    return {
      home: resolvedHome,
      installed_version: installedVersion || 'unknown',
      runtime_version: PACKAGE_VERSION,
      reason: 'version_mismatch'
    };
  }

  const installedManifest: any = await readJson(path.join(skillsRoot, 'skills-manifest.json'), null);
  const installedFingerprint = skillManifestGenerationFingerprint(installedManifest);
  if (!installedFingerprint) {
    return {
      home: resolvedHome,
      installed_version: installedVersion,
      runtime_version: PACKAGE_VERSION,
      reason: 'manifest_missing'
    };
  }
  const currentManifest = await import('../init/skills.js')
    .then(({ loadBundledSkillsManifest }) => loadBundledSkillsManifest())
    .catch(() => null);
  const currentFingerprint = skillManifestGenerationFingerprint(currentManifest);
  if (currentFingerprint && currentFingerprint !== installedFingerprint) {
    return {
      home: resolvedHome,
      installed_version: installedVersion,
      runtime_version: PACKAGE_VERSION,
      reason: 'manifest_digest_mismatch'
    };
  }
  const markerFingerprint = String(marker?.skill_generation_sha256 || '').trim().toLowerCase();
  const actualFingerprint = await installedManagedSkillGenerationFingerprint(
    resolvedHome,
    skillsRoot,
    currentManifest
  );
  if (!SHA256_RE.test(markerFingerprint)
    || !actualFingerprint
    || markerFingerprint !== actualFingerprint
    || (currentFingerprint && currentFingerprint !== actualFingerprint)) {
    return {
      home: resolvedHome,
      installed_version: installedVersion,
      runtime_version: PACKAGE_VERSION,
      reason: 'installed_content_mismatch'
    };
  }
  return null;
}

async function staleGlobalManagedSkillGenerationIsTrusted(
  home: string,
  stale: StaleGlobalManagedSkillGeneration
): Promise<boolean> {
  const skillsRoot = path.join(home, '.agents', 'skills');
  const [marker, currentManifest] = await Promise.all([
    readJson<any>(path.join(skillsRoot, '.sks-generated.json'), null),
    import('../init/skills.js').then(({ loadBundledSkillsManifest }) => loadBundledSkillsManifest())
  ]);
  if (marker?.generated_by !== 'sneakoscope'
    || String(marker?.version || '').trim() !== stale.installed_version
    || !Array.isArray(marker?.skills)
    || currentManifest?.schema !== PACKAGED_SKILLS_MANIFEST_SCHEMA
    || String(currentManifest?.package_version || '').trim() !== PACKAGE_VERSION
    || !Array.isArray(currentManifest?.skills)) {
    return false;
  }

  const known = new Map<string, Set<string>>();
  for (const row of currentManifest.skills || []) {
    const canonicalName = currentSksSkillName(row?.canonical_name);
    if (!canonicalName) continue;
    const digests = known.get(canonicalName) || new Set<string>();
    for (const value of [row?.content_sha256, ...(row?.hash_history || [])]) {
      const digest = String(value || '').trim().toLowerCase();
      if (SHA256_RE.test(digest)) digests.add(digest);
    }
    known.set(canonicalName, digests);
  }

  const ownedNames = new Set<string>([
    ...(marker.skills || []),
    ...currentManifest.skills.map((row: any) => row?.canonical_name)
  ].map((name) => currentSksSkillName(name)).filter(Boolean));
  for (const canonicalName of ownedNames) {
    const file = path.join(skillsRoot, canonicalName, 'SKILL.md');
    const inspection = await inspectConfinedPath(home, file);
    if (!inspection.exists) continue;
    if (inspection.leafSymlink || !inspection.stat?.isFile()) return false;
    const snapshot = await readSafeRegularSkill(home, skillsRoot, file);
    if (!managedSkillIdentityMatches(snapshot.content, canonicalName)
      || !known.get(canonicalName)?.has(snapshot.content_sha256)) {
      return false;
    }
  }
  return true;
}

async function reconcileStaleGlobalManagedSkillGeneration(input: {
  root: string;
  home: string;
  issues: SksSkillSourceIssue[];
  expected: StaleGlobalManagedSkillGeneration;
}): Promise<ManagedSkillDigestRecoveryReport> {
  try {
    const { reconcileSkillsAfterLockedPrecondition } = await import('../init/skills.js');
    let failureReason = 'stale_global_generation_reconcile_failed';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let rejectedReason = 'stale_generation_reconciled_by_peer';
      const guarded = await reconcileSkillsAfterLockedPrecondition({
          targetDir: path.join(input.home, '.agents', 'skills'),
          scope: 'global',
          fix: true,
          globalRuntimeRoot: path.join(input.home, '.sneakoscope-global')
        }, async () => {
          const stale = await staleGlobalManagedSkillGeneration(input.home);
          if (!stale) return false;
          const trusted = await staleGlobalManagedSkillGenerationIsTrusted(input.home, stale)
            .catch(() => false);
          if (!trusted) {
            rejectedReason = 'stale_generation_contains_unknown_managed_content';
            return false;
          }
          return true;
        })
        .catch(() => null);
      if (guarded && !guarded.precondition_met) {
        return generationRecoveryReport(input.issues, 'blocked', rejectedReason);
      }
      const report = guarded?.report || null;
      if (!report?.ok) {
        failureReason = report?.warnings?.includes('packaged_authoritative_content_inconsistent')
          ? 'packaged_authoritative_content_inconsistent'
          : 'stale_global_generation_reconcile_failed';
        break;
      }
      const remaining = await staleGlobalManagedSkillGeneration(input.home);
      if (!remaining) {
        return generationRecoveryReport(
          input.issues,
          'healed',
          `stale_global_generation_reconciled:${input.expected.reason}`
        );
      }
      failureReason = `stale_global_generation_remains:${remaining.reason}`;
    }
    return generationRecoveryReport(input.issues, 'failed', failureReason);
  } catch (error: unknown) {
    return generationRecoveryReport(
      input.issues,
      'failed',
      safeFailureReason(error, 'stale_global_generation_reconcile_failed')
    );
  }
}

async function installedManagedSkillGenerationFingerprint(
  home: string,
  skillsRoot: string,
  manifest: any
): Promise<string | null> {
  if (!Array.isArray(manifest?.skills) || !manifest.skills.length) return null;
  const rows: Array<{ canonical_name: string; content_sha256: string }> = [];
  for (const row of manifest.skills) {
    const canonicalName = currentSksSkillName(row?.canonical_name);
    if (!canonicalName) return null;
    const file = path.join(skillsRoot, canonicalName, 'SKILL.md');
    let snapshot: SafeRegularSkillSnapshot;
    try {
      snapshot = await readSafeRegularSkill(home, skillsRoot, file);
    } catch {
      return null;
    }
    if (!managedSkillIdentityMatches(snapshot.content, canonicalName)) return null;
    rows.push({ canonical_name: canonicalName, content_sha256: snapshot.content_sha256 });
  }
  rows.sort((left, right) => left.canonical_name.localeCompare(right.canonical_name));
  return sha256(JSON.stringify(rows));
}

function generationRecoveryReport(
  issues: SksSkillSourceIssue[],
  status: ManagedSkillDigestRecoveryAttempt['status'],
  reason: string
): ManagedSkillDigestRecoveryReport {
  const attempts = issues.map((issue) => recoveryAttempt(issue, { status, reason }));
  return {
    attempted: true,
    healed_count: status === 'healed' ? attempts.length : 0,
    attempts
  };
}

function skillManifestGenerationFingerprint(value: any): string | null {
  if (value?.schema !== PACKAGED_SKILLS_MANIFEST_SCHEMA || !Array.isArray(value?.skills)) {
    return null;
  }
  const rows = value.skills
    .map((skill: any) => ({
      canonical_name: currentSksSkillName(skill?.canonical_name),
      content_sha256: String(skill?.content_sha256 || '').trim().toLowerCase()
    }))
    .filter((skill: any) => skill.canonical_name && SHA256_RE.test(skill.content_sha256))
    .sort((left: any, right: any) => left.canonical_name.localeCompare(right.canonical_name));
  if (!rows.length) return null;
  return sha256(JSON.stringify(rows));
}

async function withGlobalManagedSkillHealLock<T>(
  home: string,
  run: () => Promise<T>
): Promise<T> {
  const resolvedHome = path.resolve(home);
  const homeInspection = await inspectConfinedPath(resolvedHome, resolvedHome);
  if (homeInspection.leafSymlink || !homeInspection.stat?.isDirectory()) {
    throw new Error('managed_skill_home_not_safe_directory');
  }
  return withManagedSkillGenerationLock(resolvedHome, 'global', run);
}

function healableMismatchIssues(resolution: SksSkillSourceResolution | null): SksSkillSourceIssue[] {
  if (!resolution?.blockers.length || !resolution.unresolved.length) return [];
  const blockers = new Set(resolution.blockers);
  const unresolved = new Set(resolution.unresolved);
  const unique = new Map<string, SksSkillSourceIssue>();
  for (const issue of resolution.issues || []) {
    if (issue.reason !== CONTENT_DIGEST_MISMATCH
      || issue.scope !== 'global'
      || !unresolved.has(issue.canonical_name)
      || !SHA256_RE.test(String(issue.content_sha256 || ''))
      || !blockers.has(`${CONTENT_DIGEST_MISMATCH}:${issue.canonical_name}:global`)) {
      continue;
    }
    unique.set(`${issue.canonical_name}\0${path.resolve(issue.path)}`, issue);
  }
  return [...unique.values()].sort((left, right) => (
    left.canonical_name.localeCompare(right.canonical_name)
    || left.path.localeCompare(right.path)
  ));
}

async function healOneManagedSkillDigestMismatch(input: {
  root: string;
  home: string;
  issue: SksSkillSourceIssue;
  packaged: PackagedManagedSkillContent | null;
  testHooks?: ManagedSkillDigestHealTestHooks;
}): Promise<ManagedSkillDigestRecoveryAttempt> {
  const canonicalName = currentSksSkillName(input.issue.canonical_name);
  const skillsRoot = path.join(input.home, '.agents', 'skills');
  const expectedPath = canonicalName
    ? path.join(skillsRoot, canonicalName, 'SKILL.md')
    : '';
  if (!canonicalName || canonicalName !== input.issue.canonical_name) {
    return recoveryAttempt(input.issue, {
      status: 'blocked',
      reason: 'canonical_skill_name_invalid'
    });
  }
  if (!input.packaged
    || input.packaged.canonical_name !== canonicalName
    || !SHA256_RE.test(input.packaged.content_sha256)
    || sha256(input.packaged.content) !== input.packaged.content_sha256
    || !managedSkillIdentityMatches(input.packaged.content, canonicalName)) {
    return recoveryAttempt(input.issue, {
      status: 'blocked',
      reason: 'packaged_authoritative_content_unavailable'
    });
  }
  if (path.resolve(input.issue.path) !== path.resolve(expectedPath)
    || path.resolve(input.issue.root) !== path.resolve(skillsRoot)
    || !isLexicallyConfined(input.home, expectedPath)
    || !isLexicallyConfined(skillsRoot, expectedPath)) {
    return recoveryAttempt(input.issue, {
      status: 'blocked',
      reason: 'authoritative_skill_path_confinement_failed',
      newDigest: input.packaged.content_sha256
    });
  }

  let original: SafeRegularSkillSnapshot;
  try {
    original = await readSafeRegularSkill(input.home, skillsRoot, expectedPath);
  } catch (error: unknown) {
    return recoveryAttempt(input.issue, {
      status: 'blocked',
      reason: safeFailureReason(error, 'authoritative_skill_path_not_safe'),
      newDigest: input.packaged.content_sha256
    });
  }
  const originalInspection = await inspectCurrentSksManagedSkillContent(
    original.content,
    canonicalName
  );
  if (originalInspection.status !== CONTENT_DIGEST_MISMATCH) {
    return recoveryAttempt(input.issue, {
      status: 'blocked',
      reason: `managed_skill_not_healable:${originalInspection.status}`,
      oldDigest: originalInspection.content_sha256,
      newDigest: input.packaged.content_sha256
    });
  }
  if (originalInspection.content_sha256 !== input.issue.content_sha256) {
    return recoveryAttempt(input.issue, {
      status: 'blocked',
      reason: 'managed_skill_changed_since_resolution',
      oldDigest: originalInspection.content_sha256,
      newDigest: input.packaged.content_sha256
    });
  }

  const timestamp = nowIso();
  const stamp = timestamp.replace(/[:.]/g, '-');
  const backupDir = path.join(
    input.root,
    '.sneakoscope',
    'backups',
    'managed-skill-digest-heal',
    canonicalName
  );
  const journalPath = path.join(input.root, '.sneakoscope', 'reports', MIGRATION_JOURNAL_FILE);
  let backupPath: string | null = null;
  let journalCommitted = false;
  let replacementCommitted = false;
  try {
    await prepareRecoveryArtifactDirectories(input.root, backupDir, journalPath);
    backupPath = await uniqueConfinedPath(
      input.root,
      path.join(backupDir, `${stamp}-${process.pid}-${randomId(8)}.SKILL.md.bak`)
    );
    await writeNewDurableConfinedFile(input.root, backupPath, original.content, 0o600);
    await verifyBackup(input.root, backupPath, original.content_sha256);

    const backupReadyEvent = buildMigrationEvent({
      step: 'self_heal_content_digest_mismatch_backup_ready',
      target: expectedPath,
      beforeHash: original.content_sha256,
      afterHash: original.content_sha256,
      backupPath,
      changed: false,
      rollbackAvailable: true,
      operatorAction: `Restore ${backupPath} to ${expectedPath}.`,
      note: JSON.stringify({
        status: 'backup_ready_before_atomic_replace',
        canonical_skill: canonicalName,
        rollback_path: backupPath,
        planned_new_digest: input.packaged.content_sha256,
        runtime_version: PACKAGE_VERSION,
        package_version: PACKAGE_VERSION
      })
    });
    await appendDurableMigrationRecord(input.root, journalPath, backupReadyEvent);
    journalCommitted = true;

    await atomicReplaceBoundSkill({
      home: input.home,
      skillsRoot,
      file: expectedPath,
      expected: original,
      replacement: input.packaged.content,
      ...(input.testHooks?.beforeAtomicReplace
        ? { beforeReplace: () => input.testHooks!.beforeAtomicReplace!({
            canonical_skill: canonicalName,
            original_path: expectedPath,
            backup_path: backupPath!
          }) }
        : {}),
      ...(input.testHooks?.beforeFinalPromotion
        ? { beforeFinalPromotion: () => input.testHooks!.beforeFinalPromotion!({
            canonical_skill: canonicalName,
            original_path: expectedPath,
            backup_path: backupPath!
          }) }
        : {})
    });
    replacementCommitted = true;

    if (input.testHooks?.afterAtomicReplace) {
      await input.testHooks.afterAtomicReplace({
        canonical_skill: canonicalName,
        original_path: expectedPath,
        backup_path: backupPath
      });
    }
    const healed = await readSafeRegularSkill(input.home, skillsRoot, expectedPath);
    if (healed.content_sha256 !== input.packaged.content_sha256
      || !managedSkillIdentityMatches(healed.content, canonicalName)) {
      throw new Error('managed_skill_post_write_verification_failed');
    }
    const commitEvent = buildMigrationEvent({
      step: 'self_heal_content_digest_mismatch_commit',
      target: expectedPath,
      beforeHash: original.content_sha256,
      afterHash: input.packaged.content_sha256,
      backupPath,
      changed: true,
      rollbackAvailable: true,
      operatorAction: `Restore ${backupPath} to ${expectedPath}.`,
      note: JSON.stringify({
        status: 'atomic_replace_verified',
        canonical_skill: canonicalName,
        rollback_path: backupPath,
        runtime_version: PACKAGE_VERSION,
        package_version: PACKAGE_VERSION
      })
    });
    await appendDurableMigrationRecord(input.root, journalPath, commitEvent);
    return recoveryAttempt(input.issue, {
      status: 'healed',
      reason: 'content_digest_mismatch_replaced',
      oldDigest: originalInspection.content_sha256,
      newDigest: input.packaged.content_sha256,
      backupPath,
      journalPath
    });
  } catch (error: unknown) {
    if (error instanceof ManagedSkillReplaceConflict) {
      return recoveryAttempt(input.issue, {
        status: 'blocked',
        reason: error.code,
        oldDigest: originalInspection.content_sha256,
        newDigest: input.packaged.content_sha256,
        backupPath,
        journalPath: journalCommitted ? journalPath : null
      });
    }

    let reason = safeFailureReason(error, 'managed_skill_digest_heal_failed');
    if (replacementCommitted) {
      try {
        await restoreOriginalIfSafe({
          home: input.home,
          skillsRoot,
          file: expectedPath,
          original,
          packagedDigest: input.packaged.content_sha256
        });
      } catch (rollbackError: unknown) {
        reason = `${reason}:rollback_${safeFailureReason(
          rollbackError,
          'managed_skill_rollback_failed'
        )}`;
      }
    }
    return recoveryAttempt(input.issue, {
      status: 'failed',
      reason,
      oldDigest: originalInspection.content_sha256,
      newDigest: input.packaged.content_sha256,
      backupPath,
      journalPath: journalCommitted ? journalPath : null
    });
  }
}

async function currentPackagedManagedSkillContents(): Promise<Map<string, PackagedManagedSkillContent>> {
  if (!packagedManagedSkillContentsPromise) {
    packagedManagedSkillContentsPromise = materializeCurrentPackagedManagedSkillContents();
  }
  const work = packagedManagedSkillContentsPromise;
  try {
    return await work;
  } finally {
    // Like the digest loader, this is only an in-flight dedupe. A later build
    // must materialize the new authoritative skill generation.
    if (packagedManagedSkillContentsPromise === work) {
      packagedManagedSkillContentsPromise = null;
    }
  }
}

async function materializeCurrentPackagedManagedSkillContents(): Promise<Map<string, PackagedManagedSkillContent>> {
  return withScratchDir('managed-skill-package-', async (scratchRoot) => {
    const targetDir = path.join(scratchRoot, '.agents', 'skills');
    const globalRuntimeRoot = path.join(scratchRoot, '.sneakoscope-global');
    const { reconcileSkills } = await import('../init/skills.js');
    const report = await reconcileSkills({
      targetDir,
      scope: 'global',
      fix: true,
      globalRuntimeRoot
    });
    if (!report.ok) throw new Error('packaged_skill_scratch_reconcile_failed');

    const manifestPath = path.join(targetDir, 'skills-manifest.json');
    const manifestInspection = await inspectConfinedPath(scratchRoot, manifestPath);
    if (!manifestInspection.exists
      || manifestInspection.leafSymlink
      || !manifestInspection.stat?.isFile()) {
      throw new Error('packaged_skill_manifest_missing');
    }
    const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
    if (manifest?.schema !== PACKAGED_SKILLS_MANIFEST_SCHEMA
      || manifest?.package_version !== PACKAGE_VERSION
      || !Array.isArray(manifest?.skills)) {
      throw new Error('packaged_skill_manifest_invalid');
    }

    const contents = new Map<string, PackagedManagedSkillContent>();
    for (const row of manifest.skills) {
      const canonicalName = currentSksSkillName(row?.canonical_name);
      const expectedDigest = String(row?.content_sha256 || '').trim().toLowerCase();
      if (!canonicalName || !SHA256_RE.test(expectedDigest)) continue;
      const file = path.join(targetDir, canonicalName, 'SKILL.md');
      const inspection = await inspectConfinedPath(scratchRoot, file);
      if (!inspection.exists || inspection.leafSymlink || !inspection.stat?.isFile()) continue;
      const content = await fsp.readFile(file, 'utf8');
      if (sha256(content) !== expectedDigest
        || !managedSkillIdentityMatches(content, canonicalName)) {
        continue;
      }
      contents.set(canonicalName, {
        canonical_name: canonicalName,
        content,
        content_sha256: expectedDigest
      });
    }
    return contents;
  });
}

async function readSafeRegularSkill(
  home: string,
  skillsRoot: string,
  file: string
): Promise<SafeRegularSkillSnapshot> {
  const opened = await openSafeRegularSkill(home, skillsRoot, file);
  try {
    return opened.snapshot;
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

async function openSafeRegularSkill(
  home: string,
  skillsRoot: string,
  file: string
): Promise<OpenSafeRegularSkillSnapshot> {
  if (!isLexicallyConfined(home, file) || !isLexicallyConfined(skillsRoot, file)) {
    throw new Error('authoritative_skill_path_confinement_failed');
  }
  await assertSafeRegularPath(home, skillsRoot, file);

  let handle: FileHandle;
  try {
    handle = await fsp.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error: unknown) {
    const code = filesystemErrorCode(error);
    if (code === 'ELOOP') throw new Error('authoritative_skill_leaf_symlink_refused');
    if (code === 'ENOENT') throw new Error('authoritative_skill_missing_during_safe_read');
    throw new Error('authoritative_skill_open_no_follow_failed');
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('authoritative_skill_not_regular_file');
    const content = await handle.readFile('utf8');
    const after = await handle.stat();
    if (!sameStableFileState(before, after)) {
      throw new Error('authoritative_skill_changed_during_safe_read');
    }
    await assertBoundPathStillCurrent(home, skillsRoot, file, after);
    return {
      handle,
      snapshot: {
        content,
        content_sha256: sha256(content),
        identity: fileSnapshotIdentity(after)
      }
    };
  } catch (error: unknown) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function assertSafeRegularPath(
  home: string,
  skillsRoot: string,
  file: string
): Promise<void> {
  const [homeInspection, rootInspection] = await Promise.all([
    inspectConfinedPath(home, file),
    inspectConfinedPath(skillsRoot, file)
  ]);
  if (!homeInspection.exists
    || homeInspection.leafSymlink
    || !homeInspection.stat?.isFile()
    || !rootInspection.exists
    || rootInspection.leafSymlink
    || !rootInspection.stat?.isFile()) {
    throw new Error('authoritative_skill_not_regular_file');
  }
}

async function assertBoundPathStillCurrent(
  home: string,
  skillsRoot: string,
  file: string,
  boundStat: Stats
): Promise<void> {
  const [homeInspection, rootInspection] = await Promise.all([
    inspectConfinedPath(home, file),
    inspectConfinedPath(skillsRoot, file)
  ]);
  for (const inspection of [homeInspection, rootInspection]) {
    if (!inspection.exists) throw new Error('authoritative_skill_missing_during_safe_read');
    if (inspection.leafSymlink) throw new Error('authoritative_skill_leaf_symlink_refused');
    if (!inspection.stat?.isFile()) throw new Error('authoritative_skill_not_regular_file');
    if (inspection.stat.dev !== boundStat.dev || inspection.stat.ino !== boundStat.ino) {
      throw new Error('authoritative_skill_path_identity_changed');
    }
  }
}

async function atomicReplaceBoundSkill(input: {
  home: string;
  skillsRoot: string;
  file: string;
  expected: SafeRegularSkillSnapshot;
  replacement: string;
  beforeReplace?: () => void | Promise<void>;
  beforeFinalPromotion?: () => void | Promise<void>;
}): Promise<void> {
  const tempPath = await uniqueConfinedPath(
    input.skillsRoot,
    `${input.file}.${process.pid}.${randomId(8)}.sks-heal.tmp`
  );
  let tempExists = false;
  let claimExists = false;
  let bound: OpenSafeRegularSkillSnapshot | null = null;
  const claimPath = await uniqueConfinedPath(
    input.skillsRoot,
    `${input.file}.${process.pid}.${randomId(8)}.sks-heal.claim`
  );
  try {
    await writeNewDurableConfinedFile(
      input.skillsRoot,
      tempPath,
      input.replacement,
      input.expected.identity.mode & 0o777
    );
    tempExists = true;
    if (input.beforeReplace) await input.beforeReplace();

    try {
      bound = await openSafeRegularSkill(input.home, input.skillsRoot, input.file);
    } catch (error: unknown) {
      throw new ManagedSkillReplaceConflict(
        `managed_skill_changed_before_atomic_replace:${safeFailureReason(
          error,
          'authoritative_skill_path_not_safe'
        )}`
      );
    }
    if (!sameBoundSnapshot(input.expected, bound.snapshot)) {
      throw new ManagedSkillReplaceConflict('managed_skill_changed_before_atomic_replace');
    }
    const boundStat = await bound.handle.stat();
    await assertBoundPathStillCurrent(input.home, input.skillsRoot, input.file, boundStat);
    if (input.beforeFinalPromotion) await input.beforeFinalPromotion();

    // Claim the exact verified inode, then promote with a no-overwrite hard
    // link. A concurrent edit can therefore be restored or preserved, never
    // silently overwritten by a path-based rename.
    await fsp.rename(input.file, claimPath);
    claimExists = true;
    const claimed = await readSafeRegularSkill(input.home, input.skillsRoot, claimPath)
      .catch(() => null);
    if (!claimed || !sameClaimedSnapshot(input.expected, claimed)) {
      if (await restoreClaimWithoutOverwrite(claimPath, input.file)) claimExists = false;
      throw new ManagedSkillReplaceConflict('managed_skill_changed_during_final_promotion');
    }
    try {
      await fsp.link(tempPath, input.file);
    } catch (error: unknown) {
      if (await restoreClaimWithoutOverwrite(claimPath, input.file)) claimExists = false;
      throw new ManagedSkillReplaceConflict(
        filesystemErrorCode(error) === 'EEXIST'
          ? 'managed_skill_concurrent_target_during_final_promotion'
          : 'managed_skill_final_promotion_failed'
      );
    }
    const promoted = await readSafeRegularSkill(input.home, input.skillsRoot, input.file);
    if (promoted.content_sha256 !== sha256(input.replacement)) {
      throw new ManagedSkillReplaceConflict('managed_skill_final_promotion_verification_failed');
    }
    await fsp.rm(claimPath, { force: true });
    claimExists = false;
    await fsp.rm(tempPath, { force: true });
    tempExists = false;
  } finally {
    await bound?.handle.close().catch(() => undefined);
    if (tempExists) await fsp.rm(tempPath, { force: true }).catch(() => undefined);
    // A claim is retained only when a concurrent target prevented safe
    // restoration; its contents remain recoverable instead of being deleted.
    const targetExists = await inspectConfinedPath(input.skillsRoot, input.file)
      .then((inspection) => inspection.exists)
      .catch(() => true);
    if (claimExists && !targetExists) {
      if (await restoreClaimWithoutOverwrite(claimPath, input.file)) claimExists = false;
    }
  }
}

async function restoreClaimWithoutOverwrite(claimPath: string, targetPath: string): Promise<boolean> {
  try {
    await fsp.link(claimPath, targetPath);
    await fsp.rm(claimPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

async function writeNewDurableConfinedFile(
  boundary: string,
  file: string,
  content: string,
  mode: number
): Promise<void> {
  if (!isLexicallyConfined(boundary, file)) {
    throw new ManagedPathSafetyError('managed_path_escape_refused', path.resolve(file));
  }
  await ensureConfinedDirectory(boundary, path.dirname(file));
  const existing = await inspectConfinedPath(boundary, file);
  if (existing.exists) throw new Error('managed_recovery_artifact_already_exists');

  const flags = fsConstants.O_WRONLY
    | fsConstants.O_CREAT
    | fsConstants.O_EXCL
    | fsConstants.O_NOFOLLOW;
  const handle = await fsp.open(file, flags, mode & 0o777);
  let writtenStat: Stats;
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    writtenStat = await handle.stat();
    if (!writtenStat.isFile()) throw new Error('managed_recovery_artifact_not_regular_file');
  } finally {
    await handle.close().catch(() => undefined);
  }
  const inspected = await inspectConfinedPath(boundary, file);
  if (!inspected.exists
    || inspected.leafSymlink
    || !inspected.stat?.isFile()
    || inspected.stat.dev !== writtenStat.dev
    || inspected.stat.ino !== writtenStat.ino) {
    throw new Error('managed_recovery_artifact_path_identity_changed');
  }
}

async function prepareRecoveryArtifactDirectories(
  root: string,
  backupDir: string,
  journalPath: string
): Promise<void> {
  const rootInspection = await inspectConfinedPath(root, root);
  if (rootInspection.leafSymlink || !rootInspection.stat?.isDirectory()) {
    throw new Error('project_root_not_safe_directory');
  }
  await ensureConfinedDirectory(root, backupDir);
  await ensureConfinedDirectory(root, path.dirname(journalPath));
  const journalInspection = await inspectConfinedPath(root, journalPath);
  if (journalInspection.exists
    && (journalInspection.leafSymlink || !journalInspection.stat?.isFile())) {
    throw new Error('migration_journal_not_safe_regular_file');
  }
}

async function verifyBackup(
  root: string,
  backupPath: string,
  expectedDigest: string
): Promise<void> {
  const backup = await readSafeRegularSkill(root, root, backupPath);
  if (backup.content_sha256 !== expectedDigest) {
    throw new Error('managed_skill_backup_digest_mismatch');
  }
}

async function appendDurableMigrationRecord(
  root: string,
  journalPath: string,
  record: MigrationEvent
): Promise<void> {
  const before = await inspectConfinedPath(root, journalPath);
  if (before.exists && (before.leafSymlink || !before.stat?.isFile())) {
    throw new Error('migration_journal_not_safe_regular_file');
  }
  const flags = fsConstants.O_APPEND
    | fsConstants.O_CREAT
    | fsConstants.O_WRONLY
    | fsConstants.O_NOFOLLOW;
  const handle = await fsp.open(journalPath, flags, 0o600);
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error('migration_journal_not_safe_regular_file');
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
    const finalInspection = await inspectConfinedPath(root, journalPath);
    if (!finalInspection.exists
      || finalInspection.leafSymlink
      || !finalInspection.stat?.isFile()
      || finalInspection.stat.dev !== opened.dev
      || finalInspection.stat.ino !== opened.ino) {
      throw new Error('migration_journal_post_write_verification_failed');
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function restoreOriginalIfSafe(input: {
  home: string;
  skillsRoot: string;
  file: string;
  original: SafeRegularSkillSnapshot;
  packagedDigest: string;
}): Promise<void> {
  const current = await readSafeRegularSkill(input.home, input.skillsRoot, input.file);
  if (current.content_sha256 === input.original.content_sha256) return;
  if (current.content_sha256 !== input.packagedDigest) {
    throw new Error('managed_skill_rollback_concurrent_change_refused');
  }
  await atomicReplaceBoundSkill({
    home: input.home,
    skillsRoot: input.skillsRoot,
    file: input.file,
    expected: current,
    replacement: input.original.content
  });
  const restored = await readSafeRegularSkill(input.home, input.skillsRoot, input.file);
  if (restored.content_sha256 !== input.original.content_sha256) {
    throw new Error('managed_skill_rollback_verification_failed');
  }
}

function sameBoundSnapshot(
  left: SafeRegularSkillSnapshot,
  right: SafeRegularSkillSnapshot
): boolean {
  return left.content_sha256 === right.content_sha256
    && left.identity.dev === right.identity.dev
    && left.identity.ino === right.identity.ino
    && left.identity.mode === right.identity.mode
    && left.identity.size === right.identity.size
    && left.identity.mtime_ms === right.identity.mtime_ms
    && left.identity.ctime_ms === right.identity.ctime_ms;
}

function sameClaimedSnapshot(
  left: SafeRegularSkillSnapshot,
  right: SafeRegularSkillSnapshot
): boolean {
  return left.content_sha256 === right.content_sha256
    && left.identity.dev === right.identity.dev
    && left.identity.ino === right.identity.ino
    && left.identity.mode === right.identity.mode
    && left.identity.size === right.identity.size
    && left.identity.mtime_ms === right.identity.mtime_ms;
}

function sameStableFileState(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function fileSnapshotIdentity(stat: Stats): FileSnapshotIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    size: stat.size,
    mtime_ms: stat.mtimeMs,
    ctime_ms: stat.ctimeMs
  };
}

function managedSkillIdentityMatches(text: string, canonicalName: string): boolean {
  if (!MANAGED_SKILL_MARKER_RE.test(text)) return false;
  const declaredName = String(text.match(/^name:\s*([^\n\r]+)/m)?.[1] || '')
    .trim()
    .replace(/^["']|["']$/g, '');
  return currentSksSkillName(declaredName) === canonicalName;
}

function recoveryAttempt(
  issue: SksSkillSourceIssue,
  input: {
    status: ManagedSkillDigestRecoveryAttempt['status'];
    reason: string;
    oldDigest?: string | null;
    newDigest?: string | null;
    backupPath?: string | null;
    journalPath?: string | null;
  }
): ManagedSkillDigestRecoveryAttempt {
  const backupPath = input.backupPath ?? null;
  return {
    canonical_skill: issue.canonical_name,
    original_path: issue.path,
    old_digest: input.oldDigest ?? issue.content_sha256,
    new_digest: input.newDigest ?? null,
    status: input.status,
    reason: input.reason,
    backup_path: backupPath,
    rollback_path: backupPath,
    journal_path: input.journalPath ?? null
  };
}

function safeFailureReason(error: unknown, fallback: string): string {
  if (error instanceof ManagedPathSafetyError) return error.code;
  const message = error instanceof Error ? error.message : '';
  return /^[a-z0-9_:-]{1,240}$/.test(message) ? message : fallback;
}

function filesystemErrorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : '';
}
