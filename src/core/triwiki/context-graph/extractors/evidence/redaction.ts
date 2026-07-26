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

function guardNode(node: ContextGraphNode, extractor: string): NodeGuardResult {
  if (containsPlaintextSecret(node.id) || containsPlaintextSecret(node.label)) {
    return {
      node: null,
      issue: lintError('secret_like_value', 'evidence node identity looks secret-like and was refused', {
        nodeId: node.id.slice(0, 24),
        extractor
      })
    };
  }
  if (node.path !== undefined && containsPlaintextSecret(node.path)) {
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
