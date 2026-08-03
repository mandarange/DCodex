import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { sha256, writeJsonAtomic } from '../../fsx.js';

export type ImageReferenceConsent = 'local-only' | 'external-transfer-approved';
export type ImageReferenceStatus = 'valid' | 'expired_reference';

export interface ImageReferenceEvidence {
  readonly schema: 'sks.image-reference-evidence.v1';
  readonly id: string;
  readonly locator: { readonly kind: 'path' | 'uri'; readonly value: string };
  readonly sha256: string;
  readonly size_bytes: number;
  readonly media_type: string;
  readonly mtime_ms: number | null;
  readonly consent: ImageReferenceConsent;
  readonly scope: 'inside-root' | 'external-explicit' | 'remote-uri';
  readonly status: ImageReferenceStatus;
  readonly reason_code: string | null;
}

export interface ExternalTransferPermit {
  readonly schema: 'sks.image-external-transfer-permit.v1';
  readonly reference_id: string;
  readonly token: string;
}

export async function registerPathImageReference(input: {
  id: string;
  filePath: string;
  allowedRoots: readonly string[];
  consent?: ImageReferenceConsent;
  allowOutOfRoot?: boolean;
}): Promise<ImageReferenceEvidence> {
  const id = safeId(input.id);
  const absolute = path.resolve(input.filePath);
  const lstat = await fsp.lstat(absolute).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new Error('image_reference_missing');
    throw error;
  });
  if (lstat.isSymbolicLink()) throw new Error('image_reference_symlink_forbidden');
  if (!lstat.isFile()) throw new Error('image_reference_not_file');
  const real = await fsp.realpath(absolute);
  const canonicalRoots = await Promise.all(input.allowedRoots.map(async (root) => {
    const resolved = path.resolve(root);
    return fsp.realpath(resolved).catch(() => resolved);
  }));
  const inside = canonicalRoots.some((root) => isInside(root, real));
  if (!inside && !input.allowOutOfRoot) throw new Error('image_reference_out_of_root');
  return {
    schema: 'sks.image-reference-evidence.v1', id,
    locator: { kind: 'path', value: absolute },
    sha256: await sha256File(absolute), size_bytes: lstat.size,
    media_type: mediaTypeForPath(absolute), mtime_ms: lstat.mtimeMs,
    consent: input.consent || 'local-only', scope: inside ? 'inside-root' : 'external-explicit',
    status: 'valid', reason_code: null
  };
}

export function registerUriImageReference(input: {
  id: string;
  uri: string;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
  consent?: ImageReferenceConsent;
}): ImageReferenceEvidence {
  const parsed = new URL(input.uri);
  if (!['https:', 'file:'].includes(parsed.protocol)) throw new Error('image_reference_uri_scheme_forbidden');
  if (!/^[a-f0-9]{64}$/.test(input.sha256) || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) {
    throw new Error('image_reference_metadata_invalid');
  }
  return {
    schema: 'sks.image-reference-evidence.v1', id: safeId(input.id),
    locator: { kind: 'uri', value: parsed.toString() }, sha256: input.sha256,
    size_bytes: input.sizeBytes, media_type: safeMediaType(input.mediaType), mtime_ms: null,
    consent: input.consent || 'local-only', scope: parsed.protocol === 'file:' ? 'external-explicit' : 'remote-uri',
    status: 'valid', reason_code: null
  };
}

export async function revalidateImageReference(reference: ImageReferenceEvidence): Promise<ImageReferenceEvidence> {
  if (reference.locator.kind !== 'path') return reference;
  let stat;
  try {
    stat = await fsp.lstat(reference.locator.value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return expired(reference, 'image_reference_missing');
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return expired(reference, 'image_reference_type_changed');
  if (stat.size !== reference.size_bytes || stat.mtimeMs !== reference.mtime_ms) return expired(reference, 'image_reference_metadata_changed');
  if (await sha256File(reference.locator.value) !== reference.sha256) return expired(reference, 'image_reference_bytes_changed');
  return { ...reference, status: 'valid', reason_code: null };
}

export async function writeImageReferenceRegistry(file: string, references: readonly ImageReferenceEvidence[]): Promise<void> {
  const ids = new Set<string>();
  for (const reference of references) {
    if (ids.has(reference.id)) throw new Error('image_reference_duplicate_id');
    ids.add(reference.id);
  }
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeJsonAtomic(file, { schema: 'sks.image-reference-registry.v1', references });
}

export async function upsertImageReferenceRegistry(file: string, reference: ImageReferenceEvidence): Promise<void> {
  let existing: ImageReferenceEvidence[] = [];
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as { schema?: unknown; references?: unknown };
    if (parsed.schema === 'sks.image-reference-registry.v1' && Array.isArray(parsed.references)) existing = parsed.references as ImageReferenceEvidence[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await writeImageReferenceRegistry(file, [...existing.filter((entry) => entry.id !== reference.id), reference]);
}

export class ExternalTransferPermitRegistry {
  private readonly permits = new Map<string, string>();

  issue(reference: ImageReferenceEvidence): ExternalTransferPermit {
    if (reference.status !== 'valid') throw new Error('image_reference_expired');
    if (reference.consent !== 'external-transfer-approved') throw new Error('image_external_transfer_consent_required');
    const token = randomBytes(24).toString('base64url');
    this.permits.set(reference.id, sha256(token));
    return { schema: 'sks.image-external-transfer-permit.v1', reference_id: reference.id, token };
  }

  consume(reference: ImageReferenceEvidence, token: string): void {
    const expected = this.permits.get(reference.id);
    if (!expected || expected !== sha256(token)) throw new Error('image_external_transfer_permit_invalid');
    this.permits.delete(reference.id);
  }
}

export function assertReferenceCanPass(reference: ImageReferenceEvidence): void {
  if (reference.status !== 'valid') throw new Error('image_reference_cannot_hit_or_pass');
}

function expired(reference: ImageReferenceEvidence, reason: string): ImageReferenceEvidence {
  return { ...reference, status: 'expired_reference', reason_code: reason };
}

function safeId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(String(value || ''))) throw new Error('image_reference_id_invalid');
  return value;
}

function safeMediaType(value: string): string {
  if (!/^image\/[a-z0-9.+-]+$/i.test(value)) throw new Error('image_reference_media_type_invalid');
  return value.toLowerCase();
}

function mediaTypeForPath(file: string): string {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.gif') return 'image/gif';
  if (extension === '.webp') return 'image/webp';
  throw new Error('image_reference_media_type_unsupported');
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function sha256File(file: string): Promise<string> {
  return sha256(await fsp.readFile(file));
}
