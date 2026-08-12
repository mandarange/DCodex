/**
 * Character classification, machine-path redaction and secret detection — the
 * decisions about what a character *is* and what text is allowed to be indexed
 * at all, before anything is split into terms.
 *
 * Classification is by explicit code-point range, not by `\p{...}`. Unicode
 * property sets grow with every Unicode release, so a Node upgrade would
 * silently reclassify characters and change the compiled bytes of an index that
 * is addressed by its own hash. NFKC and `toLowerCase` are used elsewhere in
 * the lexicon because both are covered by Unicode's normalization and case
 * stability policies; property membership and collation are not, so neither is
 * used here.
 *
 * Security (work order §1.4): absolute, home and temp paths are stripped from
 * free text before it is split, because once `/Users/alice/x` is tokenized the
 * username survives as a perfectly ordinary-looking term. High-entropy tokens
 * are dropped rather than indexed, so a key pasted into a comment does not
 * become searchable.
 */
import type { ContextLexiconConfig } from './lexicon-contract.js';

export const LEXICON_CLASS_SEPARATOR = 0;
export const LEXICON_CLASS_LOWER = 1;
export const LEXICON_CLASS_UPPER = 2;
export const LEXICON_CLASS_DIGIT = 3;
export const LEXICON_CLASS_LETTER = 4;
export const LEXICON_CLASS_CJK = 5;

/**
 * Scripts whose words are separated by spaces. They get no case boundary — a
 * camel split inside Cyrillic or Greek is not a thing — but they must not fall
 * through to `SEPARATOR`, because a separator would erase the word entirely and
 * reproduce the v1 "returns nothing for non-English" failure.
 */
const LETTER_RANGES: readonly (readonly [number, number])[] = [
  [0x00c0, 0x00d6], [0x00d8, 0x00f6], [0x00f8, 0x024f], // Latin-1 + Latin Extended-A/B
  [0x0370, 0x03ff], // Greek
  [0x0400, 0x052f], // Cyrillic + supplement
  [0x0530, 0x058f], // Armenian
  [0x0590, 0x05ff], // Hebrew
  [0x0600, 0x06ff], // Arabic
  [0x0900, 0x097f], // Devanagari
  [0x0e00, 0x0e7f], // Thai
];

/** Scripts written without spaces; these are the n-gram cases. */
const CJK_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x11ff], // Hangul Jamo
  [0x3040, 0x309f], // Hiragana
  [0x30a0, 0x30fa], // Katakana, stopping before the U+30FB separator dot
  [0x30fc, 0x30ff],
  [0x3130, 0x318f], // Hangul Compatibility Jamo
  [0x31f0, 0x31ff], // Katakana Phonetic Extensions
  [0x3400, 0x4dbf], // CJK Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa960, 0xa97f], // Hangul Jamo Extended-A
  [0xac00, 0xd7a3], // Hangul Syllables
  [0xd7b0, 0xd7ff], // Hangul Jamo Extended-B
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0x20000, 0x2a6df], // CJK Extension B
  [0x2a700, 0x2ebef], // CJK Extensions C-F
];

function inRanges(codePoint: number, ranges: readonly (readonly [number, number])[]): boolean {
  for (const range of ranges) {
    if (codePoint >= range[0] && codePoint <= range[1]) return true;
  }
  return false;
}

/**
 * Anything unrecognised is a separator, never a word character. Splitting on an
 * unknown code point loses a boundary; absorbing it would let an unassigned
 * character glue two terms together and change the term table the day that
 * character gets assigned.
 */
export function classifyLexiconCodePoint(codePoint: number): number {
  if (codePoint >= 0x30 && codePoint <= 0x39) return LEXICON_CLASS_DIGIT;
  if (codePoint >= 0x41 && codePoint <= 0x5a) return LEXICON_CLASS_UPPER;
  if (codePoint >= 0x61 && codePoint <= 0x7a) return LEXICON_CLASS_LOWER;
  if (codePoint < 0x80) return LEXICON_CLASS_SEPARATOR;
  if (inRanges(codePoint, CJK_RANGES)) return LEXICON_CLASS_CJK;
  if (inRanges(codePoint, LETTER_RANGES)) return LEXICON_CLASS_LETTER;
  return LEXICON_CLASS_SEPARATOR;
}

export function isAllDigits(value: string): boolean {
  for (const char of value) {
    if (classifyLexiconCodePoint(char.codePointAt(0) as number) !== LEXICON_CLASS_DIGIT) return false;
  }
  return value !== '';
}

// ---------------------------------------------------------------------------
// Machine paths
// ---------------------------------------------------------------------------

/**
 * Path shapes that name the machine rather than the workspace. These are
 * matched before tokenizing, because once `/Users/alice/x` is split the
 * username survives as a perfectly ordinary-looking term.
 */
const MACHINE_PATH_PATTERNS: readonly RegExp[] = [
  // The whole remainder goes, not just the user segment: everything after
  // `/Users/alice` is filesystem layout outside the workspace, and a term like
  // `Desktop` is both useless for retrieval and a fact about the machine.
  /\/(?:Users|home)\/[^\s]*/g,
  /\/Volumes\/[^\s]*/g,
  /\/private\/(?:tmp|var)\/[^\s]*/g,
  /\/var\/folders\/[^\s]*/g,
  /(?:^|[\s"'(])\/tmp\/[^\s]*/g,
  /[A-Za-z]:[\\/]Users[\\/][^\s\\/]+/g,
  /(?:^|[\s"'(])~\/[^\s]*/g,
];

export interface MachinePathScan {
  readonly text: string;
  readonly redactedSpans: number;
}

export function redactMachinePaths(value: string): MachinePathScan {
  let text = value;
  let redactedSpans = 0;
  for (const pattern of MACHINE_PATH_PATTERNS) {
    // `lastIndex` is per-regex mutable state on a module-level object, so it is
    // reset explicitly rather than trusted across calls.
    pattern.lastIndex = 0;
    text = text.replace(pattern, () => {
      redactedSpans += 1;
      return ' ';
    });
  }
  return { text, redactedSpans };
}

/** A path-shaped field must be workspace-relative POSIX before it is indexed. */
export function isWorkspaceRelativeLexiconPath(value: string): boolean {
  if (value === '') return false;
  if (value.startsWith('/') || value.startsWith('~')) return false;
  if (/^[A-Za-z]:[\\/]/.test(value)) return false;
  if (value.includes('\\')) return false;
  if (value.split('/').includes('..')) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/**
 * Entropy by integer counting rather than by `Math.log2`.
 *
 * A Shannon entropy threshold would be the textbook answer and would put a
 * transcendental function on the path that decides what reaches the index —
 * `Math.log2` is implementation-approximated by the spec, so two engines could
 * disagree about whether a token is indexed at all. The proxy below — length,
 * character-class mix, and share of distinct characters — is made of integer
 * comparisons, so it classifies identically everywhere. It is tuned to miss
 * ordinary long identifiers (`ContextGraphSnapshotBuilder` has few distinct
 * characters relative to its length) and to catch base64 and hex key material.
 */
export function looksLikeSecretToken(token: string, config: ContextLexiconConfig): boolean {
  if (token.length < config.minSecretTokenLength) return false;

  let lower = 0;
  let upper = 0;
  let digit = 0;
  let other = 0;
  const distinct = new Set<string>();
  for (const char of token) {
    distinct.add(char);
    const cls = classifyLexiconCodePoint(char.codePointAt(0) as number);
    if (cls === LEXICON_CLASS_LOWER) lower += 1;
    else if (cls === LEXICON_CLASS_UPPER) upper += 1;
    else if (cls === LEXICON_CLASS_DIGIT) digit += 1;
    else other += 1;
  }
  if (other > 0) return false;

  const isHex = upper + lower + digit === token.length && /^[0-9a-fA-F]+$/.test(token);
  if (isHex && token.length >= config.minHexSecretLength) return true;

  // Mixed case plus digits plus better than half the characters distinct: an
  // identifier repeats letters, a random key does not.
  if (lower > 0 && upper > 0 && digit > 0 && distinct.size * 2 >= token.length) return true;
  return false;
}
