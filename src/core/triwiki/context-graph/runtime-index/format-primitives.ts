/**
 * Checked arithmetic, fixed-point conversion, and the section checksum.
 *
 * Every operand here is read from an untrusted file, so arithmetic refuses
 * rather than wrapping: a wrapped offset is how a corrupt file talks a reader
 * into indexing outside its buffer. Scores are integer for a different reason —
 * they decide result order, and leaving them on the platform float path would
 * let the same query rank differently on two machines.
 */
import { CONTEXT_INDEX_LIMITS, fail } from './format-contract.js';

// ---------------------------------------------------------------------------
// Checked arithmetic
// ---------------------------------------------------------------------------

/**
 * `offset + length` on numbers read from the file. Both operands are attacker
 * controlled, so the sum is checked against the file-size cap rather than
 * against `Number.MAX_SAFE_INTEGER` after the fact.
 */
export function checkedAdd(a: bigint, b: bigint, limit = CONTEXT_INDEX_LIMITS.maxFileBytes): bigint {
  if (a < 0n || b < 0n) fail('offset_overflow', { a, b });
  const sum = a + b;
  if (sum > limit) fail('offset_overflow', { a, b, limit });
  return sum;
}

export function checkedMul(a: bigint, b: bigint, limit = CONTEXT_INDEX_LIMITS.maxSectionBytes): bigint {
  if (a < 0n || b < 0n) fail('offset_overflow', { a, b });
  const product = a * b;
  if (product > limit) fail('offset_overflow', { a, b, limit });
  return product;
}

// ---------------------------------------------------------------------------
// Fixed point
// ---------------------------------------------------------------------------

/**
 * Scores decide result order, so they must not depend on the platform's float
 * rounding. Everything is integer until the public API boundary.
 */
export const CONTEXT_INDEX_FIXED_POINT_SCALE = 1_000;
export const CONTEXT_INDEX_TRUST_SCALE = 65_535;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

export function toFixedPoint(value: number, scale = CONTEXT_INDEX_FIXED_POINT_SCALE): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * scale);
}

export function fromFixedPoint(value: number, scale = CONTEXT_INDEX_FIXED_POINT_SCALE): number {
  return value / scale;
}

export function quantizeTrust(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const clamped = value <= 0 ? 0 : value >= 1 ? 1 : value;
  return Math.round(clamped * CONTEXT_INDEX_TRUST_SCALE);
}

export function dequantizeTrust(value: number): number {
  return value / CONTEXT_INDEX_TRUST_SCALE;
}

/** Saturating rather than wrapping: a wrapped score silently reorders results. */
export function clampScore(value: bigint): bigint {
  if (value > I64_MAX) return I64_MAX;
  if (value < I64_MIN) return I64_MIN;
  return value;
}

// ---------------------------------------------------------------------------
// Checksum
// ---------------------------------------------------------------------------

/**
 * Two 32-bit lanes combined into a u64. A BigInt-per-byte hash would be correct
 * and unusable: the measured graph is 55 MB, and this runs over every section.
 */
export function contextIndexChecksum(bytes: Uint8Array, start = 0, end = bytes.length): bigint {
  if (start < 0 || end > bytes.length || start > end) fail('offset_overflow', { start, end, size: bytes.length });
  let lo = 0x811c9dc5 | 0;
  let hi = 0x01000193 | 0;
  for (let index = start; index < end; index += 1) {
    const byte = bytes[index] as number;
    lo = Math.imul(lo ^ byte, 0x01000193);
    hi = Math.imul((hi + byte) | 0, 0x85ebca6b) ^ (hi >>> 13);
  }
  return (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
}
