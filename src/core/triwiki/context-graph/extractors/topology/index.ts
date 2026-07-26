/**
 * Command / route / pipeline / gate topology extractor.
 *
 * Everything here comes from a machine-readable control-plane manifest that is
 * really present in the workspace being compiled. Nothing is spawned, nothing is
 * imported from the workspace, and no relation is read out of prose: if a
 * manifest is missing the fragment says so through `skipped`, and if a manifest
 * is present but unusable it says so through an `issues` error.
 *
 * The command and route lists come from this package's own compiled manifest
 * modules, but a node is only emitted when the corresponding manifest file
 * exists in the workspace, so every provenance record still cites a real path.
 */
import type {
  ContextGraphExtractionInput,
  ContextGraphExtractor,
  ContextGraphFragment,
  ContextGraphLintIssue,
  ContextGraphSkip
} from '../../contracts.js';
import { emptyContextGraphFragment } from '../../contracts.js';
import { compareContextGraphIds } from '../../ids.js';
import { buildCommandGraph, collectRuntimeManifest } from './commands.js';
import {
  buildGateAffectedEdges,
  buildGateDependencyEdges,
  buildGatePresetPipelines,
  buildGateVerificationEdges,
  reportUnbackedProtectedGates
} from './gate-edges.js';
import type { TopologyPresetPipeline } from './gate-edges.js';
import { buildGateNodes, collectTopologyGates } from './gates.js';
import { buildFileInventory } from './globs.js';
import { buildRouteGraph } from './routes.js';
import type { TopologyContext } from './shared.js';
import {
  TOPOLOGY_EXTRACTOR_ID,
  TOPOLOGY_EXTRACTOR_REVISION,
  createTopologyContext,
  recordSkip,
  topologyExpired
} from './shared.js';

const INVENTORY_SKIP_PATH = 'release-gates.v2.json';

function sortIssues(issues: readonly ContextGraphLintIssue[]): ContextGraphLintIssue[] {
  return [...issues].sort((left, right) => {
    const byCode = left.code.localeCompare(right.code);
    if (byCode !== 0) return byCode;
    return left.message.localeCompare(right.message);
  });
}

function sortSkips(skips: readonly ContextGraphSkip[]): ContextGraphSkip[] {
  return [...skips].sort((left, right) => {
    const byPath = left.path.localeCompare(right.path);
    if (byPath !== 0) return byPath;
    const byReason = left.reason.localeCompare(right.reason);
    if (byReason !== 0) return byReason;
    return String(left.detail ?? '').localeCompare(String(right.detail ?? ''));
  });
}

function sortedHashes(hashes: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(hashes).sort()) {
    const value = hashes[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function finalize(ctx: TopologyContext): ContextGraphFragment {
  const fragment = emptyContextGraphFragment(TOPOLOGY_EXTRACTOR_ID, TOPOLOGY_EXTRACTOR_REVISION);
  fragment.nodes = [...ctx.nodes.values()].sort((left, right) => compareContextGraphIds(left.id, right.id));
  fragment.edges = [...ctx.edges.values()].sort((left, right) => compareContextGraphIds(left.id, right.id));
  fragment.issues = sortIssues(ctx.issues);
  fragment.skipped = sortSkips(ctx.skipped);
  fragment.inputHashes = sortedHashes(ctx.inputHashes);
  return fragment;
}

/**
 * Manifest extraction is cheap and whole-graph by nature: a changed handler file
 * can flip an edge for a gate whose manifest bytes never moved, so this
 * extractor always returns a complete fragment rather than a partial one that
 * would look authoritative while missing relations.
 */
export class TopologyGraphExtractor implements ContextGraphExtractor {
  readonly id = TOPOLOGY_EXTRACTOR_ID;

  readonly revision = TOPOLOGY_EXTRACTOR_REVISION;

  async extract(input: ContextGraphExtractionInput): Promise<ContextGraphFragment> {
    const startedAt = Date.now();
    const files = buildFileInventory(input.root, input.limits.maxFiles);
    const ctx = createTopologyContext({
      root: input.root,
      observedAt: input.observedAt,
      limits: input.limits,
      files,
      startedAt
    });
    if (files.truncated) {
      recordSkip(ctx, INVENTORY_SKIP_PATH, 'cap_reached', `file inventory stopped at ${input.limits.maxFiles} files`);
    }

    const runtime = collectRuntimeManifest(ctx);
    const gates = collectTopologyGates(ctx);
    buildGateNodes(ctx, gates);
    buildGateDependencyEdges(ctx, gates);

    let presets: readonly TopologyPresetPipeline[] = [];
    if (topologyExpired(ctx)) {
      recordSkip(ctx, INVENTORY_SKIP_PATH, 'cap_reached', 'extraction time budget reached before gate file relations');
    } else {
      const verified = buildGateVerificationEdges(ctx, gates);
      const affected = buildGateAffectedEdges(ctx, gates);
      reportUnbackedProtectedGates(ctx, gates, verified, affected);
      presets = buildGatePresetPipelines(ctx, gates);
    }

    if (topologyExpired(ctx)) {
      recordSkip(ctx, INVENTORY_SKIP_PATH, 'cap_reached', 'extraction time budget reached before command topology');
      return finalize(ctx);
    }
    buildCommandGraph(ctx, runtime, presets);
    buildRouteGraph(ctx);
    return finalize(ctx);
  }
}

export function createTopologyGraphExtractor(): ContextGraphExtractor {
  return new TopologyGraphExtractor();
}

export { TOPOLOGY_EXTRACTOR_ID, TOPOLOGY_EXTRACTOR_REVISION } from './shared.js';
export { TOPOLOGY_GATE_MANIFESTS } from './gates.js';
export { TOPOLOGY_COMMAND_MANIFEST_PATH, TOPOLOGY_RUNTIME_SCRIPTS_PATH } from './commands.js';
export { TOPOLOGY_ROUTES_PATH } from './routes.js';
