/**
 * Workspace-facing code pack projection.
 *
 * The only place in this package that touches the file system: it opens the
 * current generation through the CG2-13 facade and re-hashes the sources the pack
 * ends up citing, so `freshness` is a verdict about real bytes rather than a
 * restatement of what the compiler recorded. A missing, corrupt or stale index
 * produces an explicit `context_graph_*` code plus the repair command — no
 * fallback, and no branch to the previous generation.
 *
 * `git_head_sha` is now the caller's to supply. The v2 index meta records
 * pointer, fingerprints and counts and carries no git HEAD, and deriving one from
 * the working tree would mean spawning git on a read path. A pack built without
 * it reports `null`, which is what the field has always meant.
 */
import { CONTEXT_GRAPH_REPAIR_COMMAND } from '../contracts.js';
import { readSourceHashes } from '../compiler/freshness.js';
import {
  openWorkspaceContextIndex,
  workspaceContextFailureOf,
  type OpenWorkspaceContextIndexOptions
} from '../query/index.js';
import { projectionFailureCode, projectionFailureErrors, type ProjectionFailureCode } from './graph-facts.js';
import { codePackFreshnessSources } from './code-pack-entry.js';
import type { CodePack } from './pack-contract.js';
import { projectCodePackFromGraph, type BuildCodePackFromGraphOptions } from './code-pack.js';

export interface WorkspaceCodePackOptions
  extends Omit<BuildCodePackFromGraphOptions, 'snapshotFreshness' | 'observedSourceHashes'>,
    OpenWorkspaceContextIndexOptions {}

export interface WorkspaceCodePackResult {
  readonly ok: boolean;
  readonly pack: CodePack | null;
  readonly errorCode: ProjectionFailureCode | null;
  readonly errors: string[];
  readonly warnings: string[];
  readonly snapshotHash: string;
  readonly snapshotFreshness: 'fresh' | 'stale';
  readonly candidateCount: number;
  readonly omittedForBudget: number;
  readonly repairCommand: typeof CONTEXT_GRAPH_REPAIR_COMMAND;
}

function refusal(code: string, repairCommand: string): WorkspaceCodePackResult {
  return {
    ok: false,
    pack: null,
    errorCode: projectionFailureCode(code),
    errors: projectionFailureErrors(code, repairCommand),
    warnings: [],
    snapshotHash: '',
    snapshotFreshness: 'stale',
    candidateCount: 0,
    omittedForBudget: 0,
    repairCommand: CONTEXT_GRAPH_REPAIR_COMMAND
  };
}

/**
 * Build the code pack for `root` from the current generation. Two passes: the
 * first decides *which* sources the pack rests on, the second re-projects with
 * those sources' current hashes so every entry's `freshness` is decided by bytes
 * on disk. Candidate order does not depend on freshness, so the second pass
 * selects the same entries as the first.
 */
export async function buildWorkspaceCodePack(
  root: string,
  options: WorkspaceCodePackOptions = {}
): Promise<WorkspaceCodePackResult> {
  let handle;
  try {
    handle = await openWorkspaceContextIndex(root, options);
  } catch (error: unknown) {
    const failure = workspaceContextFailureOf(error);
    if (failure === null) throw error;
    return refusal(failure.code, failure.repairCommand);
  }

  // An index that is not fresh does not open at all, so this is the facade's
  // verdict restated rather than a second freshness check that could disagree.
  const snapshotFreshness = handle.fresh ? 'fresh' : 'stale';
  const base: BuildCodePackFromGraphOptions = {
    ...options,
    gitHeadSha: options.gitHeadSha ?? null,
    snapshotFreshness
  };

  const firstPass = projectCodePackFromGraph(root, handle.reader, base);
  const observedSourceHashes = await readSourceHashes(root, codePackFreshnessSources(firstPass.pack));
  const projection = projectCodePackFromGraph(root, handle.reader, { ...base, observedSourceHashes });

  return {
    ok: true,
    pack: projection.pack,
    errorCode: null,
    errors: [],
    warnings: [],
    snapshotHash: handle.snapshotHash,
    snapshotFreshness,
    candidateCount: projection.candidateCount,
    omittedForBudget: projection.omittedForBudget,
    repairCommand: CONTEXT_GRAPH_REPAIR_COMMAND
  };
}
