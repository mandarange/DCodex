/**
 * Workspace-facing code pack projection.
 *
 * This is the only place in the projection package that touches the file system.
 * It resolves the stored graph, reads the recorded HEAD out of the graph metadata
 * (rather than spawning `git rev-parse`), and re-hashes the sources the pack ends
 * up citing so `freshness` is a real verdict about real bytes.
 *
 * A missing, corrupt or stale graph produces an explicit error code plus the
 * repair command. There is no fallback that rebuilds a pack some other way.
 */
import { CONTEXT_GRAPH_REPAIR_COMMAND } from '../contracts.js';
import { readSourceHashes } from '../compiler/freshness.js';
import { readContextGraphMeta } from '../store/snapshot-store.js';
import { loadContextGraphIndex, type ContextGraphLoadErrorCode, type LoadContextGraphIndexOptions } from '../query/load.js';
import type { CodePack } from './pack-contract.js';
import { projectCodePackFromGraph, type BuildCodePackFromGraphOptions } from './code-pack.js';

/** Upper bound on how many cited sources are re-hashed for the freshness verdict. */
const MAX_FRESHNESS_SOURCES = 512;

export interface WorkspaceCodePackOptions
  extends Omit<BuildCodePackFromGraphOptions, 'gitHeadSha' | 'snapshotFreshness' | 'observedSourceHashes'>,
    LoadContextGraphIndexOptions {}

export interface WorkspaceCodePackResult {
  readonly ok: boolean;
  readonly pack: CodePack | null;
  readonly errorCode: ContextGraphLoadErrorCode | null;
  readonly errors: string[];
  readonly warnings: string[];
  readonly snapshotHash: string;
  readonly snapshotFreshness: 'fresh' | 'stale';
  readonly candidateCount: number;
  readonly omittedForBudget: number;
  readonly repairCommand: typeof CONTEXT_GRAPH_REPAIR_COMMAND;
}

function citedPaths(pack: CodePack): string[] {
  const paths = new Set<string>();
  for (const entry of pack.entries) {
    for (const citation of entry.citations) {
      if (citation.path) paths.add(citation.path);
      if (paths.size >= MAX_FRESHNESS_SOURCES) return [...paths];
    }
  }
  return [...paths];
}

/**
 * Build the code pack for `root` from the stored graph.
 *
 * Two passes: the first decides *which* sources the pack rests on, the second
 * re-projects with those sources' current hashes so every entry's `freshness` is
 * decided by bytes on disk. Candidate order does not depend on freshness, so the
 * second pass selects the same entries as the first.
 */
export async function buildWorkspaceCodePack(
  root: string,
  options: WorkspaceCodePackOptions = {}
): Promise<WorkspaceCodePackResult> {
  const load = await loadContextGraphIndex(root, options);
  if (!load.ok || !load.index) {
    return {
      ok: false,
      pack: null,
      errorCode: load.errorCode,
      errors: load.errors,
      warnings: load.warnings,
      snapshotHash: load.snapshotHash,
      snapshotFreshness: 'stale',
      candidateCount: 0,
      omittedForBudget: 0,
      repairCommand: CONTEXT_GRAPH_REPAIR_COMMAND
    };
  }

  const metaLoad = await readContextGraphMeta(root);
  const gitHeadSha = metaLoad.status === 'ok' && metaLoad.meta ? metaLoad.meta.cacheKeyParts.head : null;
  const base: BuildCodePackFromGraphOptions = {
    tokenBudget: options.tokenBudget,
    query: options.query,
    profile: options.profile,
    risk: options.risk,
    maxEntries: options.maxEntries,
    generatedAt: options.generatedAt,
    gitHeadSha,
    snapshotFreshness: load.freshness
  };

  const firstPass = projectCodePackFromGraph(root, load.index, base);
  const observedSourceHashes = await readSourceHashes(root, citedPaths(firstPass.pack));
  const projection = projectCodePackFromGraph(root, load.index, { ...base, observedSourceHashes });

  return {
    ok: true,
    pack: projection.pack,
    errorCode: null,
    errors: [],
    warnings: load.warnings,
    snapshotHash: load.snapshotHash,
    snapshotFreshness: load.freshness,
    candidateCount: projection.candidateCount,
    omittedForBudget: projection.omittedForBudget,
    repairCommand: CONTEXT_GRAPH_REPAIR_COMMAND
  };
}
