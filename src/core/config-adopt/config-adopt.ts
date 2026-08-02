import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  canonicalFilesystemPath,
  randomId,
  sha256,
  writeJsonAtomic
} from '../fsx.js';
import {
  hasExplicitSksManagedCodexConfigMarker,
  isProjectCodexConfig,
  SKS_MANAGED_CODEX_CONFIG_MARKER,
  writeCodexConfigGuarded,
  type WriteCodexConfigGuardedResult
} from '../codex/codex-config-guard.js';
import { validateCodexConfigRoundTrip } from '../codex/codex-config-toml.js';
import {
  ensureConfinedDirectory,
  inspectConfinedPath
} from '../managed-path-safety.js';

export const SKS_CONFIG_ADOPT_SCHEMA = 'sks.config-adopt.v1' as const;
export const SKS_CONFIG_ADOPT_RECEIPT_SCHEMA = 'sks.config-adopt-receipt.v1' as const;

export type SksConfigAdoptStatus =
  | 'adopted'
  | 'would_adopt'
  | 'already_adopted'
  | 'blocked'
  | 'adopted_receipt_unconfirmed';

export interface SksConfigAdoptResult {
  schema: typeof SKS_CONFIG_ADOPT_SCHEMA;
  ok: boolean;
  status: SksConfigAdoptStatus;
  changed: boolean;
  project_root: string;
  config_path: string;
  marker: typeof SKS_MANAGED_CODEX_CONFIG_MARKER;
  backup_path: string | null;
  receipt_path: string | null;
  before_sha256: string | null;
  after_sha256: string | null;
  blocker: string | null;
  remedy: string | null;
}

export interface SksConfigAdoptReceipt {
  schema: typeof SKS_CONFIG_ADOPT_RECEIPT_SCHEMA;
  id: string;
  generated_at: string;
  status: 'prepared' | 'adopted' | 'blocked' | 'adopted_receipt_unconfirmed';
  project_root: string;
  config_path: string;
  marker: typeof SKS_MANAGED_CODEX_CONFIG_MARKER;
  changed: boolean;
  backup_path: string | null;
  before_sha256: string;
  after_sha256: string;
  blocker: string | null;
}

export interface RunSksConfigAdoptOptions {
  root?: string;
  configPath?: string;
  dryRun?: boolean;
  now?: () => Date;
  /** @internal deterministic seam for exercising commit-boundary CAS behavior. */
  beforeCommit?: () => void | Promise<void>;
}

type ConfigSnapshot =
  | { ok: true; text: string; mode: number }
  | { ok: false; blocker: string };

export async function runSksConfigAdopt(
  options: RunSksConfigAdoptOptions = {}
): Promise<SksConfigAdoptResult> {
  const requestedRoot = path.resolve(options.root || process.cwd());
  const projectRoot = await canonicalFilesystemPath(requestedRoot);
  const configPath = path.resolve(options.configPath || path.join(projectRoot, '.codex', 'config.toml'));
  const base = {
    schema: SKS_CONFIG_ADOPT_SCHEMA,
    project_root: projectRoot,
    config_path: configPath,
    marker: SKS_MANAGED_CODEX_CONFIG_MARKER
  } as const;

  if (projectRoot === path.parse(projectRoot).root) {
    return blocked(base, 'config_adopt_filesystem_root_refused');
  }
  if (!isProjectCodexConfig(projectRoot, configPath)) {
    return blocked(base, 'config_adopt_project_config_path_required');
  }

  const snapshot = await readAdoptableConfig(projectRoot, configPath);
  if (!snapshot.ok) return blocked(base, snapshot.blocker);
  const before = snapshot.text;
  const beforeSha256 = sha256(before);
  const validation = validateCodexConfigRoundTrip(before);
  if (!validation.ok) return blocked(base, 'config_adopt_toml_invalid', beforeSha256);
  if (hasExplicitSksManagedCodexConfigMarker(before)) {
    return {
      ...base,
      ok: true,
      status: 'already_adopted',
      changed: false,
      backup_path: null,
      receipt_path: null,
      before_sha256: beforeSha256,
      after_sha256: beforeSha256,
      blocker: null,
      remedy: null
    };
  }

  const after = insertSksManagedCodexConfigMarker(before);
  const afterSha256 = sha256(after);
  if (options.dryRun === true) {
    return {
      ...base,
      ok: true,
      status: 'would_adopt',
      changed: false,
      backup_path: null,
      receipt_path: null,
      before_sha256: beforeSha256,
      after_sha256: afterSha256,
      blocker: null,
      remedy: null
    };
  }
  const now = options.now || (() => new Date());
  const receiptId = `config-adopt-${now().toISOString().replace(/[:.]/g, '-')}-${randomId(10)}`;
  const receiptDirectory = path.join(projectRoot, '.sneakoscope', 'receipts', 'config-adopt');
  const receiptPath = path.join(receiptDirectory, `${receiptId}.json`);
  try {
    await ensureConfinedDirectory(projectRoot, receiptDirectory);
  } catch {
    return blocked(base, 'config_adopt_receipt_directory_unavailable', beforeSha256);
  }
  const receiptBase = {
    schema: SKS_CONFIG_ADOPT_RECEIPT_SCHEMA,
    id: receiptId,
    generated_at: now().toISOString(),
    project_root: projectRoot,
    config_path: configPath,
    marker: SKS_MANAGED_CODEX_CONFIG_MARKER,
    before_sha256: beforeSha256,
    after_sha256: afterSha256
  } as const;
  try {
    await writeAdoptReceipt(projectRoot, receiptPath, {
      ...receiptBase,
      status: 'prepared',
      changed: false,
      backup_path: null,
      blocker: null
    });
  } catch {
    return blocked(base, 'config_adopt_receipt_prepare_failed', beforeSha256);
  }

  let guard: WriteCodexConfigGuardedResult;
  try {
    guard = await writeCodexConfigGuarded({
      root: projectRoot,
      configPath,
      before,
      mutate: async () => {
        await options.beforeCommit?.();
        return after;
      },
      cause: 'config-adopt',
      backupTag: 'config-adopt',
      ownershipVerified: true,
      verifyUnchangedBeforeWrite: true,
      expectedBeforeExists: true,
      expectedBeforeMode: snapshot.mode,
      preserveFastUiKeys: false,
      preserveTextFormatting: true
    });
  } catch (error: unknown) {
    const blocker = `config_adopt_guard_failed:${errorCode(error)}`;
    await writeAdoptReceipt(projectRoot, receiptPath, {
      ...receiptBase,
      status: 'blocked',
      changed: false,
      backup_path: null,
      blocker
    }).catch(() => undefined);
    return blocked(base, blocker, beforeSha256, receiptPath);
  }

  if (!guard.ok) {
    const blocker = guard.status === 'concurrent_change_detected'
      ? 'config_adopt_concurrent_change_detected'
      : `config_adopt_guard:${guard.status}`;
    const receiptStatus = guard.changed ? 'adopted_receipt_unconfirmed' : 'blocked';
    await writeAdoptReceipt(projectRoot, receiptPath, {
      ...receiptBase,
      status: receiptStatus,
      changed: guard.changed,
      backup_path: guard.backup_path,
      blocker
    }).catch(() => undefined);
    if (guard.changed) {
      const observed = await readAdoptableConfig(projectRoot, configPath);
      return {
        ...base,
        ok: false,
        status: 'adopted_receipt_unconfirmed',
        changed: true,
        backup_path: guard.backup_path,
        receipt_path: receiptPath,
        before_sha256: beforeSha256,
        after_sha256: observed.ok ? sha256(observed.text) : null,
        blocker,
        remedy: remedyForConfigAdoptBlocker(blocker, configPath)
      };
    }
    return blocked(base, blocker, beforeSha256, receiptPath, guard.backup_path);
  }

  const committed = await readAdoptableConfig(projectRoot, configPath);
  const backup = guard.backup_path
    ? await readAdoptableConfig(projectRoot, guard.backup_path)
    : null;
  const commitVerified = committed.ok
    && committed.text === after
    && committed.mode === 0o600
    && backup?.ok === true
    && backup.text === before
    && backup.mode === 0o600;
  if (!commitVerified) {
    const blocker = 'config_adopt_postwrite_verification_failed';
    await writeAdoptReceipt(projectRoot, receiptPath, {
      ...receiptBase,
      status: 'adopted_receipt_unconfirmed',
      changed: guard.changed,
      backup_path: guard.backup_path,
      blocker
    }).catch(() => undefined);
    return {
      ...base,
      ok: false,
      status: 'adopted_receipt_unconfirmed',
      changed: guard.changed,
      backup_path: guard.backup_path,
      receipt_path: receiptPath,
      before_sha256: beforeSha256,
      after_sha256: committed.ok ? sha256(committed.text) : null,
      blocker,
      remedy: remedyForConfigAdoptBlocker(blocker, configPath)
    };
  }

  const finalReceipt: SksConfigAdoptReceipt = {
    ...receiptBase,
    status: 'adopted',
    changed: true,
    backup_path: guard.backup_path,
    blocker: null
  };
  try {
    await writeAdoptReceipt(projectRoot, receiptPath, finalReceipt);
  } catch {
    const blocker = 'config_adopt_receipt_finalize_failed';
    return {
      ...base,
      ok: false,
      status: 'adopted_receipt_unconfirmed',
      changed: true,
      backup_path: guard.backup_path,
      receipt_path: receiptPath,
      before_sha256: beforeSha256,
      after_sha256: afterSha256,
      blocker,
      remedy: remedyForConfigAdoptBlocker(blocker, configPath)
    };
  }

  return {
    ...base,
    ok: true,
    status: 'adopted',
    changed: true,
    backup_path: guard.backup_path,
    receipt_path: receiptPath,
    before_sha256: beforeSha256,
    after_sha256: afterSha256,
    blocker: null,
    remedy: null
  };
}

export const adoptSksCodexConfig = runSksConfigAdopt;

export async function adoptProjectCodexConfig(input: {
  projectRoot: string;
  dryRun?: boolean;
}): Promise<SksConfigAdoptResult> {
  return runSksConfigAdopt({
    root: input.projectRoot,
    ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun })
  });
}

export function insertSksManagedCodexConfigMarker(text: string): string {
  const source = String(text || '');
  if (hasExplicitSksManagedCodexConfigMarker(source)) return source;
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = bom ? source.slice(1) : source;
  return `${bom}${SKS_MANAGED_CODEX_CONFIG_MARKER}\n${body}`;
}

export function formatSksConfigAdoptText(result: SksConfigAdoptResult): string {
  const lines = [
    result.ok
      ? result.status === 'would_adopt'
        ? 'SKS Codex config would be adopted; no files were changed.'
        : result.changed ? 'SKS Codex config adopted.' : 'SKS Codex config was already adopted.'
      : 'SKS Codex config adoption failed.',
    `File: ${result.config_path}`
  ];
  if (result.backup_path) lines.push(`Backup: ${result.backup_path}`);
  if (result.receipt_path) lines.push(`Receipt: ${result.receipt_path}`);
  if (!result.ok) {
    lines.push(`Blocker: ${result.blocker || 'config_adopt_failed'}`);
    lines.push(`Remedy: ${result.remedy || remedyForConfigAdoptBlocker(result.blocker || '', result.config_path)}`);
  }
  return lines.join('\n');
}

export function remedyForConfigAdoptBlocker(blocker: string, configPath: string): string {
  if (blocker === 'user_owned_file_without_sks_marker') {
    return `\`${configPath}\` has no \`${SKS_MANAGED_CODEX_CONFIG_MARKER}\` marker → add it as line 1 or run \`sks config adopt\`.`;
  }
  if (blocker === 'config_adopt_toml_invalid') {
    return `Fix the TOML syntax in ${configPath}, then rerun sks config adopt.`;
  }
  if (blocker === 'config_adopt_concurrent_change_detected') {
    return `Review the latest ${configPath} and rerun sks config adopt; no adoption write was committed.`;
  }
  if (blocker.includes('symlink') || blocker.includes('non_regular') || blocker.includes('ancestor')) {
    return `Replace ${configPath} with a regular project-owned file, then rerun sks config adopt.`;
  }
  if (blocker.includes('missing')) {
    return `Create ${configPath} as a valid TOML file, then rerun sks config adopt.`;
  }
  if (blocker.includes('receipt') || blocker.includes('postwrite')) {
    return `Inspect ${configPath} and its reported backup before retrying; adoption completion could not be proven.`;
  }
  return `Resolve ${blocker || 'the reported blocker'} for ${configPath}, then rerun sks config adopt.`;
}

export function formatUpdateBlockerWithRemedy(blocker: string, configPath: string): string {
  const value = String(blocker || '').trim();
  if (!value) return '';
  const adoptBlocker = 'user_owned_file_without_sks_marker';
  if (value !== adoptBlocker && !value.endsWith(`:${adoptBlocker}`)) return value;
  return `${value}: ${remedyForConfigAdoptBlocker(adoptBlocker, configPath)}`;
}

async function readAdoptableConfig(root: string, configPath: string): Promise<ConfigSnapshot> {
  let inspected;
  try {
    inspected = await inspectConfinedPath(root, configPath);
  } catch (error: unknown) {
    const code = typeof error === 'object' && error && 'code' in error
      ? String((error as { code?: unknown }).code || 'config_adopt_path_unsafe')
      : 'config_adopt_path_unsafe';
    return { ok: false, blocker: `config_adopt_path:${code}` };
  }
  if (!inspected.exists) return { ok: false, blocker: 'config_adopt_config_missing' };
  if (inspected.leafSymlink) return { ok: false, blocker: 'config_adopt_config_symlink_refused' };
  if (!inspected.stat?.isFile()) return { ok: false, blocker: 'config_adopt_config_non_regular_refused' };
  try {
    return {
      ok: true,
      text: await fsp.readFile(configPath, 'utf8'),
      mode: inspected.stat.mode & 0o777
    };
  } catch {
    return { ok: false, blocker: 'config_adopt_config_read_failed' };
  }
}

async function writeAdoptReceipt(root: string, file: string, receipt: SksConfigAdoptReceipt): Promise<void> {
  const expected = `${JSON.stringify(receipt, null, 2)}\n`;
  await writeJsonAtomic(file, receipt, { mode: 0o600 });
  const observed = await readAdoptableConfig(root, file);
  if (!observed.ok || observed.text !== expected || observed.mode !== 0o600) {
    throw new Error('config_adopt_receipt_verification_failed');
  }
}

function blocked(
  base: Pick<SksConfigAdoptResult, 'schema' | 'project_root' | 'config_path' | 'marker'>,
  blocker: string,
  beforeSha256: string | null = null,
  receiptPath: string | null = null,
  backupPath: string | null = null
): SksConfigAdoptResult {
  return {
    ...base,
    ok: false,
    status: 'blocked',
    changed: false,
    backup_path: backupPath,
    receipt_path: receiptPath,
    before_sha256: beforeSha256,
    after_sha256: null,
    blocker,
    remedy: remedyForConfigAdoptBlocker(blocker, base.config_path)
  };
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String((error as { code?: unknown }).code || '').trim();
    if (/^[A-Za-z0-9_.-]{1,80}$/.test(code)) return code;
  }
  return 'unexpected_error';
}
