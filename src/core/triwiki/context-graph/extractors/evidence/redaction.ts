/**
 * Bounded projection + secret/path guard for the TriWiki evidence extractor.
 *
 * This is a thin wrapper over the repository redactor (`src/core/secret-redaction.ts`):
 * it never implements a second pattern list. On top of redaction it enforces the
 * Context Graph path discipline (no absolute paths, no home paths, no `..`) and a
 * hard length cap so no raw evidence payload can be smuggled into node metadata.
 *
 * The guard is fail-closed: a value that still looks secret-like *after* redaction
 * is never written; the node that carries it is refused and reported as a
 * `secret_like_value` lint error.
 */
import { REDACTION_MARKER, containsPlaintextSecret, redactString } from '../../../../secret-redaction.js';
import {
  lintError,
  type ContextGraphEdge,
  type ContextGraphFragment,
  type ContextGraphLintIssue,
  type ContextGraphMetadata,
  type ContextGraphMetadataValue,
  type ContextGraphNode
} from '../../contracts.js';
import { isStructuralValue } from '../../lint/rules.js';
import { isWorkspaceRelativePosixPath } from '../../paths.js';

export const EVIDENCE_REDACTED_PATH = '[redacted-path]';
export const EVIDENCE_MAX_META_STRING = 160;
export const EVIDENCE_MAX_META_LIST = 12;

const UNSAFE_PATH_PATTERNS: readonly RegExp[] = [
  /(?:^|[\s"'(=:,])~\//,
  /(?:^|[\s"'(=:,])\/(?:Users|home|root|var|etc|tmp|private|opt|usr|Volumes)\//i,
  /(?:^|[\s"'(=:,])[A-Za-z]:[\\/]/,
  /(?:^|[\s"'(=:,])\\\\[^\\/\s]+\\/,
  /\.\.\//
];

/** `true` when the text embeds something that reads like an absolute, UNC, or home path. */
export function looksLikeUnsafePath(value: string): boolean {
  return UNSAFE_PATH_PATTERNS.some((pattern) => pattern.test(value));
}

// ---------------------------------------------------------------------------
// Free-form prose
// ---------------------------------------------------------------------------

/**
 * Shapes that are dangerous to *store* even though the repository redactor does
 * not name them, matched only in free-form prose (see `safeFreeText`).
 *
 * `redactString` is a prefix-and-keyword list: it knows `sk-…`, `ghp_…`, `AKIA…`,
 * `Bearer …`, `key: value`. That is the right shape for a config value and the
 * wrong shape for a sentence somebody wrote, where a credential arrives without
 * its variable name. These three carry no recognisable prefix and are not
 * entropy-shaped either, so neither the redactor nor the proxy below sees them.
 */
const FREE_TEXT_SECRET_PATTERNS: readonly RegExp[] = [
  // A JWT is three base64url segments and the first always begins `eyJ` — the
  // base64 of `{"`. It is matched whole because the entropy proxy catches only
  // its header segment: the payload and signature are usually under the
  // 20-character floor, and half a token removed is a token leaked.
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]*)?/,
  // An address is personal data, and its local part survives tokenization as an
  // ordinary searchable term — the same failure mode as `/Users/alice`.
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/,
  // Dotted quad with every octet in range, and not part of a longer dotted
  // number, so a four-part version string is the only plausible false positive.
  /(?<![\d.])(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}(?![\d.])/
];

const SECRET_TOKEN_MIN_LENGTH = 20;
const SECRET_HEX_MIN_LENGTH = 32;

/**
 * Entropy by integer counting, deliberately the same rule the runtime index's
 * `looksLikeSecretToken` applies to a term.
 *
 * The approach is reproduced rather than imported: the index layer sits
 * downstream of this one, and an extractor that imported from `runtime-index/`
 * would invert that dependency to share thirty lines. Reproducing it also keeps
 * the two answers *identical* on purpose — a token this layer stores and that
 * layer then refuses to index is precisely the divergence that put a secret in
 * the string table while the search path looked clean.
 *
 * Integer comparisons only, for the reason that module states: a float entropy
 * threshold would make "is this indexable" engine-dependent.
 *
 * The thresholds and the unit are matched deliberately. That module's
 * `emitLatinRun` judges a whole alphanumeric run *before* lowercasing and
 * *before* camel-splitting — "its camel segments and acronym are just as much
 * of a leak as the key itself" — so this predicate judges the same unit. The
 * consequence is worth stating plainly: a token this rejects is a token the
 * index already refused to make searchable, so nothing that was retrievable
 * becomes unretrievable here. What differs is blast radius, since a caller of
 * `safeFreeText` drops the whole field rather than one term. Measured on this
 * repository's own claim prose that costs nothing (0 of 24 claims), and the
 * false-positive class is narrow enough to name: a CamelCase identifier at
 * least 20 characters long that embeds a number, such as `Utf8`, `Crk2`,
 * `Sha256`, `Bm25`. See `evidence-claim-text.test.ts`, which pins it.
 */
function tokenLooksLikeKeyMaterial(token: string): boolean {
  if (token.length < SECRET_TOKEN_MIN_LENGTH) return false;
  let lower = 0;
  let upper = 0;
  let digit = 0;
  const distinct = new Set<string>();
  for (const char of token) {
    distinct.add(char);
    const code = char.codePointAt(0) as number;
    if (code >= 0x61 && code <= 0x7a) lower += 1;
    else if (code >= 0x41 && code <= 0x5a) upper += 1;
    else if (code >= 0x30 && code <= 0x39) digit += 1;
    else return false;
  }
  // A long run of digits is a number somebody wrote — a byte count, a line
  // range, a nanosecond timestamp — and would otherwise satisfy the hex rule.
  if (lower + upper === 0) return false;
  if (/^[0-9a-fA-F]+$/.test(token) && token.length >= SECRET_HEX_MIN_LENGTH) return true;
  // Mixed case plus digits plus better than half the characters distinct: an
  // identifier repeats letters, a random key does not.
  return lower > 0 && upper > 0 && digit > 0 && distinct.size * 2 >= token.length;
}

/**
 * `true` when free-form text carries something that must not be stored: a
 * key-shaped token the prefix list would miss, a JWT, an address, or an IP.
 *
 * Runs of ASCII alphanumerics are the unit, which is the same split the index
 * tokenizer performs — every ASCII character below 0x80 that is not a letter or
 * digit is a separator there, so a token this predicate judges is a token that
 * lane would otherwise have indexed.
 *
 * A run is judged after its **encoding punctuation** is removed — `-` `_` `+`
 * `/` `=`. Those five characters are exactly the ones base64 and base64url
 * spend as payload, and a 32-byte secret in either encoding is a 43-character
 * token carrying three or four of them. Split on punctuation alone, it becomes
 * several runs that are each under the 20-character floor and each individually
 * innocent, so a floor applied per run never sees the token at all.
 *
 * The rates are measured, 5,000 random 32-byte secrets per encoding, and the
 * unpunctuated encodings are the control that shows the floor itself is sound:
 *
 * | encoding | split on punctuation | rejoined |
 * | --- | --: | --: |
 * | base62 (no punctuation) | 100.0% | 100.0% |
 * | hex (no punctuation) | 100.0% | 100.0% |
 * | base64url (`-` `_`) | 87.8% | **99.9%** |
 * | base64 (`+` `/` `=`) | 87.0% | **99.9%** |
 *
 * Only `-` and `_` were rejoined at first, which closed base64url and left
 * standard base64 at its unfixed rate — the same defect, one encoding over, and
 * invisible because the encoding that was tested was the one that got fixed.
 *
 * Rejoining *shrinks* the false-positive surface rather than growing it: a name
 * like `Crk2-Bm25-Fix` is 13 characters once its separators are dropped and
 * falls below the floor, where each of its parts already did. Checked against
 * prose carrying paths and ratios — `src/core/search/context.ts`, `a/b testing`,
 * `the ratio was 3/4` — none of which trips it.
 */
export function looksLikeSecretShape(value: string): boolean {
  if (FREE_TEXT_SECRET_PATTERNS.some((pattern) => pattern.test(value))) return true;
  for (const run of value.split(/[^A-Za-z0-9_+/=-]+/)) {
    if (tokenLooksLikeKeyMaterial(run.replace(/[-_+/=]/g, ''))) return true;
  }
  return false;
}

/**
 * How far into a value the shape scan reads, independent of what is stored.
 *
 * Scanning only the stored prefix would leave a credential that straddles the
 * metadata bound half-stored, and half a credential in the published bytes is a
 * leaked credential. Scanning is therefore wider than storing, and bounded so a
 * pathological input cannot turn the scan into the expensive part of extraction.
 */
const FREE_TEXT_SCAN_LIMIT = 4096;

export interface SafeFreeText {
  /** The prose to store, or `null` when nothing may be stored at all. */
  readonly text: string | null;
  /** `true` when what survived is not what was declared. Truncation alone is not redaction. */
  readonly redacted: boolean;
}

/**
 * The projection for prose a human wrote, as opposed to a field a manifest
 * declared. `safeText` is right for the latter and insufficient for the former.
 *
 * Two things differ from `safeText`, and both follow from free text being the
 * place a pasted credential actually turns up:
 *
 * - The secret-shape guard above runs, so an unprefixed key, a JWT, an address
 *   or an IP is caught by shape rather than by variable name.
 * - A hit collapses the **whole** field. Cutting the offending span out and
 *   keeping the sentence would publish a partially redacted secret, and it is
 *   the part that survives that gets indexed.
 *
 * This is deliberately not folded into `safeText`. That function projects every
 * metadata value in the graph, including fields whose legitimate content is
 * exactly what the entropy proxy is built to catch — a proof card's 64-character
 * `input_hash`, a content digest, a cache key. Applying the proxy there would
 * empty those fields across the graph and prove nothing about prose. Callers
 * therefore opt in, per field, where the value really is free text.
 */
export function safeFreeText(value: unknown, maxLength = EVIDENCE_MAX_META_STRING): SafeFreeText {
  const declared = boundedText(value, FREE_TEXT_SCAN_LIMIT);
  if (!declared) return { text: null, redacted: false };
  const scanned = safeText(declared, FREE_TEXT_SCAN_LIMIT);
  if (!scanned || scanned === EVIDENCE_REDACTED_PATH || looksLikeSecretShape(scanned)) {
    return { text: null, redacted: true };
  }
  const stored = boundedText(scanned, maxLength);
  return { text: stored || null, redacted: scanned !== declared };
}

/**
 * Project an arbitrary value into a bounded, redacted metadata string.
 * Unsafe paths collapse to a marker rather than being partially disclosed.
 */
export function safeText(value: unknown, maxLength = EVIDENCE_MAX_META_STRING): string {
  if (value === null || value === undefined) return '';
  const raw = typeof value === 'string' ? value : String(value);
  const collapsed = raw.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!collapsed) return '';
  const redacted = redactString(collapsed);
  const guarded = looksLikeUnsafePath(redacted) ? EVIDENCE_REDACTED_PATH : redacted;
  return guarded.length > maxLength ? `${guarded.slice(0, Math.max(1, maxLength - 1))}…` : guarded;
}

/**
 * Bound a value for metadata *without* redacting it.
 *
 * Builders use this so the guard below is the single place redaction happens and
 * can therefore report honestly (`redacted: true`) that an input was dirty. A
 * pre-redacted value would look clean and the signal would be lost.
 */
export function boundedText(value: unknown, maxLength = EVIDENCE_MAX_META_STRING): string {
  if (value === null || value === undefined) return '';
  const raw = typeof value === 'string' ? value : String(value);
  const collapsed = raw.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!collapsed) return '';
  return collapsed.length > maxLength ? `${collapsed.slice(0, Math.max(1, maxLength - 1))}…` : collapsed;
}

/** Count- and length-bounded list projection, still unredacted; the guard finishes the job. */
export function boundedList(
  values: readonly unknown[],
  maxItems = EVIDENCE_MAX_META_LIST,
  maxLength = EVIDENCE_MAX_META_STRING
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (out.length >= maxItems) break;
    const text = boundedText(value, maxLength);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** Bounded, deterministic list projection. Empty results are dropped by the caller. */
export function safeTextList(
  values: readonly unknown[],
  maxItems = EVIDENCE_MAX_META_LIST,
  maxLength = EVIDENCE_MAX_META_STRING
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (out.length >= maxItems) break;
    const text = safeText(value, maxLength);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function valueIsClean(value: ContextGraphMetadataValue): boolean {
  if (typeof value === 'string') return !containsPlaintextSecret(value);
  if (Array.isArray(value)) return value.every((entry) => !containsPlaintextSecret(entry));
  return true;
}

function sanitizeMetadataValue(value: ContextGraphMetadataValue): { value: ContextGraphMetadataValue; changed: boolean } {
  if (typeof value === 'string') {
    const next = safeText(value);
    return { value: next, changed: next !== value };
  }
  if (Array.isArray(value)) {
    const next = safeTextList(value);
    const changed = next.length !== value.length || next.some((entry, index) => entry !== value[index]);
    return { value: next, changed };
  }
  return { value, changed: false };
}

interface NodeGuardResult {
  node: ContextGraphNode | null;
  issue: ContextGraphLintIssue | null;
}

/**
 * Identity checks share the snapshot lint's structural-value exemption: node
 * ids and labels are manifest identifiers, and an honest name such as the
 * `secret:preservation` gate id must not be refused here when the final lint
 * would accept it. Anything with a high-entropy run is still checked.
 */
function identityLooksSecret(value: string): boolean {
  return !isStructuralValue(value) && containsPlaintextSecret(value);
}

function guardNode(node: ContextGraphNode, extractor: string): NodeGuardResult {
  if (identityLooksSecret(node.id) || identityLooksSecret(node.label)) {
    return {
      node: null,
      issue: lintError('secret_like_value', 'evidence node identity looks secret-like and was refused', {
        nodeId: node.id.slice(0, 24),
        extractor
      })
    };
  }
  if (node.path !== undefined && identityLooksSecret(node.path)) {
    return {
      node: null,
      issue: lintError('secret_like_value', 'evidence node path looks secret-like and was refused', {
        nodeId: node.id,
        extractor
      })
    };
  }
  if (node.path !== undefined && !isWorkspaceRelativePosixPath(node.path)) {
    return {
      node: null,
      issue: lintError('absolute_or_escaping_path', 'evidence node path is not workspace-relative and was refused', {
        nodeId: node.id,
        extractor
      })
    };
  }
  const metadata: ContextGraphMetadata = {};
  let redactedFields = 0;
  for (const key of Object.keys(node.metadata).sort()) {
    const raw = node.metadata[key];
    if (raw === undefined) continue;
    const sanitized = sanitizeMetadataValue(raw);
    if (!valueIsClean(sanitized.value)) {
      return {
        node: null,
        issue: lintError('secret_like_value', `evidence node metadata "${key}" stayed secret-like after redaction`, {
          nodeId: node.id,
          extractor
        })
      };
    }
    if (sanitized.changed) redactedFields += 1;
    if (typeof sanitized.value === 'string' && !sanitized.value) continue;
    if (Array.isArray(sanitized.value) && !sanitized.value.length) continue;
    metadata[key] = sanitized.value;
  }
  if (redactedFields > 0) {
    metadata.redacted = true;
    metadata.redacted_field_count = redactedFields;
    metadata.redaction_marker = REDACTION_MARKER;
  }
  return { node: { ...node, metadata }, issue: null };
}

function edgeIsSafe(edge: ContextGraphEdge, nodeIds: ReadonlySet<string>): boolean {
  if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) return false;
  if (!edge.provenance.path || !isWorkspaceRelativePosixPath(edge.provenance.path)) return false;
  if (containsPlaintextSecret(edge.provenance.path) || containsPlaintextSecret(edge.provenance.hash)) return false;
  return true;
}

/**
 * Final guard over a built fragment. Redacts every metadata string, refuses any
 * node it cannot sanitize, and drops edges whose endpoints or provenance did not
 * survive. Returns a new fragment; the input is left untouched.
 */
export function sanitizeEvidenceFragment(fragment: ContextGraphFragment): ContextGraphFragment {
  const issues: ContextGraphLintIssue[] = [...fragment.issues];
  const nodes: ContextGraphNode[] = [];
  const keptIds = new Set<string>();
  for (const node of fragment.nodes) {
    const guarded = guardNode(node, fragment.extractor);
    if (guarded.issue) issues.push(guarded.issue);
    if (!guarded.node) continue;
    nodes.push(guarded.node);
    keptIds.add(guarded.node.id);
  }
  const edges = fragment.edges.filter((edge) => edgeIsSafe(edge, keptIds));
  const inputHashes: Record<string, string> = {};
  for (const key of Object.keys(fragment.inputHashes).sort()) {
    const value = fragment.inputHashes[key];
    if (value === undefined) continue;
    if (!isWorkspaceRelativePosixPath(key) || containsPlaintextSecret(key)) continue;
    inputHashes[key] = value;
  }
  const skipped = fragment.skipped.filter(
    (entry) => isWorkspaceRelativePosixPath(entry.path) && !containsPlaintextSecret(entry.path) && !containsPlaintextSecret(entry.detail ?? '')
  );
  return { ...fragment, nodes, edges, issues, skipped, inputHashes };
}
