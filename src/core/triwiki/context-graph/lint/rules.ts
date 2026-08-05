/**
 * Blocking Context Graph lint rules.
 *
 * Every rule here returns errors that stop the snapshot from being written at
 * all. The structural half is delegated to `validateContextGraphSnapshot()` and
 * the secret predicate to `secret-redaction.ts`; this file only adds the checks
 * that need the workspace on disk or the canonical serialization.
 */
import {
  lintError,
  validateContextGraphSnapshot,
  type ContextGraphEdge,
  type ContextGraphLintIssue,
  type ContextGraphMeta,
  type ContextGraphNode,
  type ContextGraphNodeKind,
  type ContextGraphSnapshot
} from '../contracts.js';
import type { ContextGraphIndex } from '../graph-index.js';
import { computeStronglyConnectedComponents } from '../graph-index.js';
import { isWorkspaceRelativePosixPath, isSymlinkEscape } from '../paths.js';
import { containsPlaintextSecret } from '../../../secret-redaction.js';
import {
  computeContextGraphSnapshotHash,
  orderedEdge,
  orderedNode,
  sortContextGraphEdges,
  sortContextGraphNodes
} from '../compiler/serialize.js';

const SHA256_RE = /^[a-f0-9]{64}$/;
const MIN_ENV_VALUE_LENGTH = 12;

/**
 * Codex exposes its caller surface as public process metadata. The value is a
 * product label, not user data or a credential, and legitimately appears in
 * source-purpose comments. Keep this exception exact so arbitrary values in the
 * same variable (and every other environment variable) remain leak-checked.
 */
function isPublicRuntimeLabel(key: string, value: string): boolean {
  return key === 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE' && value === 'Codex Desktop';
}

/** Node kinds that can ground a protected gate in repository truth. */
const SOURCE_RELATION_KINDS: ReadonlySet<ContextGraphNodeKind> = new Set<ContextGraphNodeKind>([
  'file',
  'config',
  'schema',
  'test',
  'proof',
  'source',
  'module',
  'symbol',
  'pipeline',
  'command',
  'route'
]);

export function structuralIssues(snapshot: ContextGraphSnapshot): ContextGraphLintIssue[] {
  return validateContextGraphSnapshot(snapshot).issues;
}

export function pathSafetyIssues(root: string, snapshot: ContextGraphSnapshot): ContextGraphLintIssue[] {
  const issues: ContextGraphLintIssue[] = [];
  const checked = new Set<string>();
  const check = (value: string, label: string, extra: Partial<ContextGraphLintIssue>): void => {
    if (!isWorkspaceRelativePosixPath(value)) {
      issues.push(
        lintError('absolute_or_escaping_path', `${label} is not a workspace-relative POSIX path`, {
          ...extra,
          path: value
        })
      );
      return;
    }
    if (checked.has(value)) return;
    checked.add(value);
    if (isSymlinkEscape(root, value)) {
      issues.push(
        lintError('symlink_escape', `${label} resolves outside the workspace through a symlink`, {
          ...extra,
          path: value
        })
      );
    }
  };
  for (const node of snapshot.nodes) {
    if (node.path !== undefined) check(node.path, `node ${node.id} path`, { nodeId: node.id });
  }
  for (const edge of snapshot.edges) {
    const provenancePath = edge.provenance?.path;
    if (typeof provenancePath === 'string' && provenancePath) {
      check(provenancePath, `edge ${edge.id} provenance path`, {
        edgeId: edge.id,
        extractor: edge.provenance.extractor
      });
    }
  }
  return issues;
}

/**
 * Values are scanned one at a time rather than joined.
 *
 * Concatenating a node's fields synthesizes matches that exist in neither field:
 * a symbol legitimately named `BEARER` followed by its own file path reads as
 * `Bearer <19 token chars>` to the shared prose detector.
 */
function nodeValues(node: ContextGraphNode): string[] {
  const parts: string[] = [node.label ?? '', node.path ?? ''];
  for (const [key, value] of Object.entries(node.metadata ?? {})) {
    if (typeof value === 'string') parts.push(`${key}=${value}`);
    else if (Array.isArray(value)) for (const item of value) parts.push(`${key}=${item}`);
  }
  return parts.filter(Boolean);
}

function edgeValues(edge: ContextGraphEdge): string[] {
  return [edge.provenance?.path ?? '', edge.provenance?.extractor ?? '', edge.provenance?.hash ?? ''].filter(Boolean);
}

const HIGH_ENTROPY_RUN_RE = /[A-Za-z0-9_+/=~-]{20,}/g;

function looksHighEntropy(token: string): boolean {
  // A content hash is deliberate graph payload, not key material.
  if (/^[a-f0-9]{8,64}$/.test(token)) return false;
  if (token.length >= 32) return true;
  return /[A-Z]/.test(token) && /[a-z]/.test(token) && /[0-9]/.test(token);
}

/**
 * The graph stores identifiers, workspace-relative paths, content hashes, and
 * enumerated statuses — never prose and never configuration values. A value with
 * no high-entropy run cannot carry key material, so honest names like the
 * `secret:preservation` gate id must not fail the compile. Anything with a
 * random-looking run still goes through the shared secret predicate.
 */
function isStructuralValue(value: string): boolean {
  if (value.length > 512) return false;
  for (const run of value.match(HIGH_ENTROPY_RUN_RE) ?? []) {
    if (looksHighEntropy(run)) return false;
  }
  return true;
}

function environmentValues(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (
      typeof value === 'string'
      && value.length >= MIN_ENV_VALUE_LENGTH
      && !isPublicRuntimeLabel(key, value)
    ) out.push(value);
  }
  return out;
}

/** Secret-like or raw-environment values anywhere in the artifact. */
export function secretIssues(
  snapshot: ContextGraphSnapshot,
  env: NodeJS.ProcessEnv = process.env
): ContextGraphLintIssue[] {
  const issues: ContextGraphLintIssue[] = [];
  const envValues = environmentValues(env);
  const scan = (values: string[], where: Partial<ContextGraphLintIssue>, label: string): void => {
    for (const text of values) {
      if (!isStructuralValue(text) && containsPlaintextSecret(text, env)) {
        issues.push(lintError('secret_like_value', `${label} carries a secret-like value`, where));
        return;
      }
      // A raw environment value is a leak whatever it looks like.
      for (const value of envValues) {
        if (text.includes(value)) {
          issues.push(lintError('secret_like_value', `${label} carries a raw environment value`, where));
          return;
        }
      }
    }
  };
  for (const node of snapshot.nodes) scan(nodeValues(node), { nodeId: node.id }, `node ${node.id}`);
  for (const edge of snapshot.edges) {
    scan(edgeValues(edge), { edgeId: edge.id, extractor: edge.provenance?.extractor }, `edge ${edge.id}`);
  }
  return issues;
}

/** The written arrays must already be in canonical order with canonical key order. */
export function determinismIssues(snapshot: ContextGraphSnapshot): ContextGraphLintIssue[] {
  const issues: ContextGraphLintIssue[] = [];
  const canonicalNodes = JSON.stringify(sortContextGraphNodes(snapshot.nodes).map(orderedNode));
  if (JSON.stringify(snapshot.nodes.map(orderedNode)) !== canonicalNodes) {
    issues.push(lintError('non_deterministic_serialization', 'nodes are not in canonical order'));
  }
  if (JSON.stringify(snapshot.nodes) !== canonicalNodes) {
    issues.push(lintError('non_deterministic_serialization', 'node objects do not use the canonical key order'));
  }
  const canonicalEdges = JSON.stringify(sortContextGraphEdges(snapshot.edges).map((edge) => orderedEdge(edge)));
  if (JSON.stringify(snapshot.edges.map((edge) => orderedEdge(edge))) !== canonicalEdges) {
    issues.push(lintError('non_deterministic_serialization', 'edges are not in canonical order'));
  }
  if (JSON.stringify(snapshot.edges) !== canonicalEdges) {
    issues.push(lintError('non_deterministic_serialization', 'edge objects do not use the canonical key order'));
  }
  return issues;
}

export function hashIssues(
  snapshot: ContextGraphSnapshot,
  meta: ContextGraphMeta | null | undefined
): ContextGraphLintIssue[] {
  const issues: ContextGraphLintIssue[] = [];
  const recomputed = computeContextGraphSnapshotHash(snapshot);
  if (recomputed !== snapshot.snapshotHash) {
    issues.push(lintError('hash_mismatch', 'snapshotHash does not match the canonical serialization'));
  }
  for (const node of snapshot.nodes) {
    if (node.contentHash !== undefined && !SHA256_RE.test(node.contentHash)) {
      issues.push(lintError('hash_mismatch', `node ${node.id} contentHash is not a sha256 digest`, { nodeId: node.id }));
    }
  }
  for (const edge of snapshot.edges) {
    const hash = edge.provenance?.hash;
    if (typeof hash !== 'string' || !SHA256_RE.test(hash)) {
      issues.push(lintError('hash_mismatch', `edge ${edge.id} provenance hash is not a sha256 digest`, { edgeId: edge.id }));
    }
    if (typeof edge.provenance?.extractor !== 'string' || !edge.provenance.extractor) {
      issues.push(lintError('edge_without_provenance', `edge ${edge.id} provenance names no extractor`, { edgeId: edge.id }));
    }
  }
  if (!meta) return issues;
  if (meta.snapshotHash !== snapshot.snapshotHash) {
    issues.push(lintError('snapshot_meta_mismatch', 'meta snapshotHash does not match the snapshot'));
  }
  if (meta.nodeCount !== snapshot.nodeCount || meta.edgeCount !== snapshot.edgeCount) {
    issues.push(lintError('snapshot_meta_mismatch', 'meta counts do not match the snapshot'));
  }
  return issues;
}

export function protectedGateIssues(index: ContextGraphIndex): ContextGraphLintIssue[] {
  const issues: ContextGraphLintIssue[] = [];
  for (const node of index.snapshot.nodes) {
    if (node.kind !== 'gate' || node.risk !== 'protected') continue;
    const incident = [...(index.outgoing.get(node.id) ?? []), ...(index.incoming.get(node.id) ?? [])];
    const grounded = incident.some((edgeId) => {
      const edge = index.edgesById.get(edgeId);
      if (!edge) return false;
      const otherId = edge.from === node.id ? edge.to : edge.from;
      const other = index.nodesById.get(otherId);
      return Boolean(other && SOURCE_RELATION_KINDS.has(other.kind));
    });
    if (!grounded) {
      issues.push(
        lintError('protected_gate_without_source_relation', `protected gate ${node.id} has no relation to a repository source`, {
          nodeId: node.id
        })
      );
    }
  }
  return issues;
}

/** Manifest-declared relations must form a DAG; a cycle there is a manifest bug, not a graph nuance. */
export function manifestCycleIssues(snapshot: ContextGraphSnapshot): ContextGraphLintIssue[] {
  const manifest = new Map<string, Array<{ to: string }>>();
  for (const edge of snapshot.edges) {
    if (edge.confidence !== 'manifest') continue;
    const bucket = manifest.get(edge.from);
    if (bucket) bucket.push({ to: edge.to });
    else manifest.set(edge.from, [{ to: edge.to }]);
  }
  if (manifest.size === 0) return [];
  const nodeIds = snapshot.nodes.map((node) => node.id);
  const components = computeStronglyConnectedComponents(nodeIds, (nodeId) => manifest.get(nodeId) ?? []);
  return components.map((component) =>
    lintError('manifest_dag_cycle', `manifest relations form a cycle across ${component.length} nodes`, {
      nodeId: component[0] ?? ''
    })
  );
}

export function freshnessClaimIssues(
  snapshot: ContextGraphSnapshot,
  sourceHashes: Record<string, string> | undefined
): ContextGraphLintIssue[] {
  if (!sourceHashes) return [];
  const issues: ContextGraphLintIssue[] = [];
  for (const node of snapshot.nodes) {
    if (node.freshness !== 'fresh' || node.path === undefined) continue;
    const current = sourceHashes[node.path];
    if (current === undefined) continue;
    if (node.contentHash === undefined || node.contentHash === '') continue;
    if (current !== node.contentHash) {
      issues.push(
        lintError('freshness_claim_mismatch', `node ${node.id} claims fresh but its source hash changed`, {
          nodeId: node.id,
          path: node.path
        })
      );
    }
  }
  return issues;
}
