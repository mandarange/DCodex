/**
 * Payload validation for sections whose internal shape the section table cannot
 * describe: string offsets, CSR rows, and cross-table references.
 *
 * Validating these once at open time is what lets every later lookup index
 * without a per-read bounds check.
 */
import { fail } from './format-contract.js';
import type { SectionDescriptor } from './format-header.js';

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * String table: `count` u32 end-offsets followed by the UTF-8 blob.
 *
 * Validating decodability up front is what lets the reader hand out slices
 * later without a try/catch per lookup.
 */
export function validateStringTable(bytes: Uint8Array, descriptor: SectionDescriptor): void {
  const start = Number(descriptor.offset);
  const length = Number(descriptor.length);
  const indexBytes = descriptor.count * 4;
  if (indexBytes > length) fail('string_offset_invalid', { count: descriptor.count, length });
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, length);
  const blobStart = indexBytes;
  let previous = 0;
  for (let index = 0; index < descriptor.count; index += 1) {
    const end = view.getUint32(index * 4, true);
    if (end < previous) fail('string_offset_invalid', { index, end, previous });
    if (blobStart + end > length) fail('string_offset_invalid', { index, end, length });
    previous = end;
  }
  try {
    utf8Decoder.decode(bytes.subarray(start + blobStart, start + blobStart + previous));
  } catch {
    fail('string_not_utf8', { count: descriptor.count });
  }
}

/**
 * CSR row offsets must be non-decreasing and must end exactly at the edge
 * count. A row that walks backwards yields a negative slice length, which is
 * the shape that turns a corrupt file into an out-of-bounds read.
 */
export function validateCsrOffsets(
  bytes: Uint8Array,
  offsets: SectionDescriptor,
  edges: SectionDescriptor,
  nodeCount: number,
): void {
  if (offsets.count !== nodeCount + 1) {
    fail('csr_length_mismatch', { count: offsets.count, expected: nodeCount + 1 });
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + Number(offsets.offset), Number(offsets.length));
  if (offsets.count * 4 > Number(offsets.length)) {
    fail('csr_length_mismatch', { count: offsets.count, length: Number(offsets.length) });
  }
  let previous = 0;
  for (let index = 0; index < offsets.count; index += 1) {
    const value = view.getUint32(index * 4, true);
    if (value < previous) fail('csr_not_monotonic', { index, value, previous });
    previous = value;
  }
  if (previous !== edges.count) fail('csr_length_mismatch', { terminal: previous, edgeCount: edges.count });
}

/** Every u32 in a reference section must address a live row. */
export function validateReferenceRange(
  bytes: Uint8Array,
  descriptor: SectionDescriptor,
  stride: number,
  fieldOffset: number,
  exclusiveMax: number,
): void {
  const base = bytes.byteOffset + Number(descriptor.offset);
  const length = Number(descriptor.length);
  if (descriptor.count * stride > length) {
    fail('reference_out_of_range', { count: descriptor.count, stride, length });
  }
  const view = new DataView(bytes.buffer, base, length);
  for (let index = 0; index < descriptor.count; index += 1) {
    const value = view.getUint32(index * stride + fieldOffset, true);
    if (value >= exclusiveMax) fail('reference_out_of_range', { index, value, exclusiveMax });
  }
}
