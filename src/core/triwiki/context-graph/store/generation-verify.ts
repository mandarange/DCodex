/**
 * Proof that a candidate generation is what it claims to be.
 *
 * Two independent checks live here, and the commit path runs both before it will
 * promote anything:
 *
 * - **Structure and section checksums**, delegated to the binary format's own
 *   validation. Verification always runs against bytes read back from disk as
 *   well as against the bytes in memory, because a checksum computed from memory
 *   proves nothing about what the filesystem actually kept — a torn write is
 *   only observable from the disk side.
 * - **Content-address identity**: the header's snapshot hash must equal the hash
 *   the generation is being filed under. A generation stored at an address its
 *   own header does not claim would make the content address a lie, and every
 *   later staleness check reads that address rather than the file.
 */
import fsp from 'node:fs/promises';
import {
  CONTEXT_INDEX_HASH_BYTES,
  contextIndexChecksum,
  readContextIndexHeader,
  readSectionTable,
  validateSectionLayout,
  type ContextIndexHeader,
} from '../runtime-index/format.js';
import { refuseStore } from './generation-errors.js';

export interface VerifiedContextIndex {
  readonly header: ContextIndexHeader;
  readonly byteLength: number;
  readonly checksum: string;
}

export function contextIndexFileChecksum(bytes: Uint8Array): string {
  return contextIndexChecksum(bytes).toString(16).padStart(16, '0');
}

function hexToFixedBytes(value: string, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const usable = Math.min(length * 2, value.length - (value.length % 2));
  for (let index = 0; index < usable; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

/**
 * A `Buffer` from `readFile` is a view into a pooled allocation and its `slice`
 * returns another view, so header fields sliced out of it would keep the whole
 * pool alive. A plain `Uint8Array` view restores copying `slice` semantics
 * without duplicating a multi-megabyte index.
 */
function asBytes(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/**
 * Full structural verification: header, section table, bounds, overlap,
 * completeness, and every section checksum.
 */
export function verifyContextIndexBytes(bytes: Uint8Array): VerifiedContextIndex {
  const header = readContextIndexHeader(bytes);
  const descriptors = readSectionTable(bytes, header);
  validateSectionLayout(bytes, header, descriptors);
  return { header, byteLength: bytes.length, checksum: contextIndexFileChecksum(bytes) };
}

export function assertGenerationIdentity(header: ContextIndexHeader, snapshotHash: string): void {
  const expected = hexToFixedBytes(snapshotHash, CONTEXT_INDEX_HASH_BYTES);
  for (let index = 0; index < CONTEXT_INDEX_HASH_BYTES; index += 1) {
    if (header.snapshotHash[index] !== expected[index]) refuseStore('generation_identity_mismatch', { at: index });
  }
}

/** Reads the file back and re-verifies it; this is the only check a torn write cannot pass. */
export async function verifyContextIndexFile(
  filePath: string,
  expected: { snapshotHash?: string | undefined; checksum?: string | undefined },
): Promise<VerifiedContextIndex> {
  let raw: Buffer;
  try {
    raw = await fsp.readFile(filePath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') refuseStore('temp_index_missing', {});
    throw error;
  }
  const verified = verifyContextIndexBytes(asBytes(raw));
  if (expected.snapshotHash) assertGenerationIdentity(verified.header, expected.snapshotHash);
  // Checked even when the bytes are structurally perfect: a file that verifies
  // internally but is not the artifact this operation recorded is a substitution,
  // and plausibility is not the property the commit needs.
  if (expected.checksum && expected.checksum !== verified.checksum) {
    refuseStore('generation_checksum_mismatch', { bytes: verified.byteLength });
  }
  return verified;
}
