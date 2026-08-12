/**
 * The strict / `validate` hydration path (CG2-10, ADR §7, work order §8.5).
 *
 * This is the only place in CRK2 that touches the filesystem to answer a
 * question about a retrieved node, and it is reachable only from `sks wiki
 * validate` and explicit strict diagnostics. A query never calls it. That is
 * enforced structurally rather than by review: `hydrate.ts` does not import this
 * module and does not re-export it, so the query path never links a filesystem
 * import at all.
 *
 * Two properties are load-bearing:
 *
 * - **Dedupe before probing.** Provenance repeats heavily — every symbol in a
 *   file names the same file — so the unit of work is the unique path, not the
 *   node. On a real selection this is the difference between tens of probes and
 *   hundreds.
 * - **Bounded fan-out.** `Promise.all` over the whole path set opens every
 *   descriptor at once and dies with `EMFILE` on a large workspace. The probes
 *   run in fixed-size batches, which is why the batch size is a constant with a
 *   reason rather than a tuning knob.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { isWorkspaceRelativePosixPath } from '../paths.js';
import {
  contextHydrationCoverage,
  withHydrationGrounding,
  type HydratedNode,
  type HydrationResult,
} from './hydrate.js';

export const CONTEXT_HYDRATION_VERIFICATION_SCHEMA = 'sks.context-hydration-verification.v1' as const;

/**
 * Probes in flight at once. Bounded because an unbounded fan-out over a large
 * selection exhausts the process's file descriptors — and it would do so inside
 * a diagnostic, which is the worst place for a failure that looks like
 * corruption but is not.
 */
export const HYDRATION_PROBE_CONCURRENCY = 32;

/** Codes only (§1.4). The message is the code; no path, no environment value. */
export class ContextHydrationError extends Error {
  readonly code: 'hydration_verify_target_missing';

  constructor(code: ContextHydrationError['code']) {
    super(code);
    this.name = 'ContextHydrationError';
    this.code = code;
  }
}

/**
 * Answers whether a workspace-relative path names a file.
 *
 * The seam takes the relative path, never an absolute one: a probe that received
 * absolute paths would be a place where an absolute path is routinely handled,
 * and the first consumer to log its argument would leak one.
 */
export type HydrationProbe = (relative: string) => Promise<boolean>;

export interface StrictHydrationOptions {
  /** Absolute workspace root. An input; it never appears in the result. */
  readonly root?: string;
  /** Overrides the default filesystem probe. Tests and diagnostics inject here. */
  readonly probe?: HydrationProbe;
  readonly concurrency?: number;
}

export interface HydrationVerification {
  readonly schema: typeof CONTEXT_HYDRATION_VERIFICATION_SCHEMA;
  /** The same nodes, restamped with `filesystem_verified` or `unverified`. */
  readonly nodes: readonly HydratedNode[];
  readonly uniquePaths: number;
  readonly probes: number;
  readonly verifiedPaths: number;
  readonly missingPaths: number;
  /** Paths refused for not being workspace-relative POSIX. Never probed. */
  readonly refusedPaths: number;
  readonly verifiedNodes: number;
  readonly concurrency: number;
  /** Unchanged by verification: grounding is a claim, provenance is a record. */
  readonly provenanceCoverage: number;
}

/**
 * Re-ground a hydration result against the real filesystem.
 *
 * A node is verified when *any* of its provenance paths is a file on disk, which
 * is the v1 `hydrated` rule — preserved here, on the path where it belongs,
 * rather than deleted along with its use on the query path.
 */
export async function verifyHydrationOnDisk(
  result: HydrationResult,
  options: StrictHydrationOptions = {},
): Promise<HydrationVerification> {
  const probe = options.probe ?? (options.root === undefined ? null : workspaceProbe(options.root));
  if (probe === null) throw new ContextHydrationError('hydration_verify_target_missing');
  const concurrency = Math.max(1, Math.trunc(options.concurrency ?? HYDRATION_PROBE_CONCURRENCY));

  // Sorted so a batch boundary — and therefore the probe order — is a function of
  // the answer rather than of Set insertion order (§1.3).
  const unique = new Set<string>();
  for (const node of result.nodes) for (const ref of node.provenance) unique.add(ref.path);
  const paths = [...unique].sort();

  const verdict = new Map<string, boolean>();
  let refusedPaths = 0;
  let probes = 0;
  for (let at = 0; at < paths.length; at += concurrency) {
    const batch = paths.slice(at, at + concurrency).filter((relative) => {
      if (isWorkspaceRelativePosixPath(relative)) return true;
      refusedPaths += 1;
      verdict.set(relative, false);
      return false;
    });
    probes += batch.length;
    const answers = await Promise.all(batch.map((relative) => probe(relative)));
    for (let index = 0; index < batch.length; index += 1) {
      verdict.set(batch[index] as string, answers[index] === true);
    }
  }

  let verifiedPaths = 0;
  for (const answer of verdict.values()) if (answer) verifiedPaths += 1;

  const nodes: HydratedNode[] = [];
  let verifiedNodes = 0;
  for (const node of result.nodes) {
    const verified = node.provenance.some((ref) => verdict.get(ref.path) === true);
    if (verified) verifiedNodes += 1;
    nodes.push(withHydrationGrounding(node, verified));
  }

  return Object.freeze({
    schema: CONTEXT_HYDRATION_VERIFICATION_SCHEMA,
    nodes: Object.freeze(nodes),
    uniquePaths: paths.length,
    probes,
    verifiedPaths,
    missingPaths: paths.length - refusedPaths - verifiedPaths,
    refusedPaths,
    verifiedNodes,
    concurrency,
    provenanceCoverage: contextHydrationCoverage(nodes),
  });
}

/**
 * The default probe: a `stat` under the workspace root.
 *
 * Containment is re-checked after resolution even though every path reaching
 * here already passed the shape test. The shape test rejects a path that *looks*
 * like an escape; only resolution can reject one that becomes an escape.
 */
export function workspaceProbe(root: string): HydrationProbe {
  const base = path.resolve(root);
  return async (relative: string): Promise<boolean> => {
    if (!isWorkspaceRelativePosixPath(relative)) return false;
    const absolute = path.resolve(base, relative);
    const inside = path.relative(base, absolute);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return false;
    try {
      return (await fsp.stat(absolute)).isFile();
    } catch {
      return false;
    }
  };
}
