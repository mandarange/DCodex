/**
 * Gate relations: dependencies, check implementations, cache-input fan-in, and
 * the preset pipelines that group gates into a runnable DAG.
 *
 * A dependency on a gate nobody declares is a `dangling_edge` lint error and no
 * edge at all: an unresolvable dependency must fail the compile loudly instead
 * of quietly shrinking the DAG.
 */
import type { ContextGraphMetadata } from '../../contracts.js';
import { computeStronglyConnectedComponents } from '../../graph-index.js';
import { contextGraphNodeId } from '../../ids.js';
import type { TopologyGate } from './gates.js';
import { gateCheckCandidates, gateDependentIds, isProtectedGate } from './gates.js';
import { expandGlob, isGlobPattern } from './globs.js';
import type { TopologyContext } from './shared.js';
import {
  TOPOLOGY_GATE_AFFECTED_CAP,
  TOPOLOGY_GATE_VERIFIED_CAP,
  TOPOLOGY_GLOB_MATCH_CAP,
  addEdge,
  addNode,
  ensureFileNode,
  estimateTokenCost,
  recordSkip,
  topologyLintError
} from './shared.js';

export interface TopologyPresetPipeline {
  readonly preset: string;
  readonly pipelineId: string;
  readonly manifestPath: string;
  readonly manifestHash: string;
  readonly gateCount: number;
}

/** `gate depends_on gate`, plus the cycle report the release DAG must not have. */
export function buildGateDependencyEdges(ctx: TopologyContext, gates: readonly TopologyGate[]): void {
  const byId = new Map(gates.map((gate) => [gate.id, gate]));
  const adjacency = new Map<string, { to: string }[]>();

  for (const gate of gates) {
    const resolved: { to: string }[] = [];
    for (const dep of [...gate.deps].sort()) {
      if (dep === gate.id) {
        topologyLintError(ctx, 'manifest_dag_cycle', `gate ${gate.id} depends on itself`, {
          nodeId: gate.nodeId,
          path: gate.manifestPath
        });
        continue;
      }
      const target = byId.get(dep);
      if (!target) {
        topologyLintError(ctx, 'dangling_edge', `gate ${gate.id} depends on unknown gate ${dep}`, {
          nodeId: gate.nodeId,
          path: gate.manifestPath
        });
        continue;
      }
      const added = addEdge(ctx, {
        from: gate.nodeId,
        to: target.nodeId,
        type: 'depends_on',
        confidence: 'manifest',
        path: gate.manifestPath,
        hash: gate.manifestHash,
        line: gate.line
      });
      if (added) resolved.push({ to: target.nodeId });
    }
    adjacency.set(gate.nodeId, resolved);
  }

  const components = computeStronglyConnectedComponents(
    gates.map((gate) => gate.nodeId),
    (nodeId) => adjacency.get(nodeId) ?? []
  );
  for (const component of components) {
    topologyLintError(ctx, 'manifest_dag_cycle', `gate dependency cycle: ${component.join(' -> ')}`, {
      nodeId: component[0] ?? '',
      path: gates[0]?.manifestPath ?? ''
    });
  }
}

/**
 * `gate verified_by file`: the manifest command names a built script, and the
 * graph points at the TypeScript source it is built from when that source is
 * really there. A missing implementation is recorded, never invented.
 */
export function buildGateVerificationEdges(ctx: TopologyContext, gates: readonly TopologyGate[]): Set<string> {
  const verified = new Set<string>();
  for (const gate of gates) {
    let emitted = 0;
    for (const candidate of gateCheckCandidates(gate.command)) {
      if (emitted >= TOPOLOGY_GATE_VERIFIED_CAP) break;
      const expansion = expandGlob(ctx.files, candidate, TOPOLOGY_GLOB_MATCH_CAP);
      if (expansion.capped) {
        recordSkip(ctx, gate.manifestPath, 'cap_reached', `check pattern ${candidate} matched ${expansion.total} files`);
        continue;
      }
      if (!expansion.matches.length) {
        recordSkip(ctx, gate.manifestPath, 'excluded', `check implementation ${candidate} is not in this workspace`);
        continue;
      }
      const confidence = isGlobPattern(candidate) ? 'derived' : 'manifest';
      for (const match of expansion.matches) {
        if (emitted >= TOPOLOGY_GATE_VERIFIED_CAP) break;
        const fileId = ensureFileNode(ctx, match, 'gate_check', gate.manifestPath);
        if (!fileId) continue;
        const added = addEdge(ctx, {
          from: gate.nodeId,
          to: fileId,
          type: 'verified_by',
          confidence,
          path: gate.manifestPath,
          hash: gate.manifestHash,
          line: gate.line
        });
        if (added) {
          emitted += 1;
          verified.add(gate.id);
        }
      }
    }
  }
  return verified;
}

/**
 * `gate affected_by file`: every cache input glob is expanded against the real
 * file inventory. Over-wide inputs stay on the gate node as raw globs instead of
 * becoming thousands of low-value edges.
 */
export function buildGateAffectedEdges(ctx: TopologyContext, gates: readonly TopologyGate[]): Set<string> {
  const affected = new Set<string>();
  for (const gate of gates) {
    let emitted = 0;
    const seen = new Set<string>();
    for (const input of gate.cacheInputs) {
      if (emitted >= TOPOLOGY_GATE_AFFECTED_CAP) break;
      const expansion = expandGlob(ctx.files, input, TOPOLOGY_GLOB_MATCH_CAP);
      if (expansion.capped) {
        recordSkip(ctx, gate.manifestPath, 'cap_reached', `cache input ${input} matched ${expansion.total} files`);
        continue;
      }
      for (const match of expansion.matches) {
        if (emitted >= TOPOLOGY_GATE_AFFECTED_CAP) break;
        if (seen.has(match)) continue;
        seen.add(match);
        const fileId = ensureFileNode(ctx, match, 'gate_cache_input', gate.manifestPath);
        if (!fileId) continue;
        const added = addEdge(ctx, {
          from: gate.nodeId,
          to: fileId,
          type: 'affected_by',
          confidence: 'derived',
          path: gate.manifestPath,
          hash: gate.manifestHash,
          line: gate.line
        });
        if (added) {
          emitted += 1;
          affected.add(gate.id);
        }
      }
    }
  }
  return affected;
}

/**
 * A protected gate with no relation back to source is unexplainable: nothing in
 * the graph can answer "what does this gate actually check".
 */
export function reportUnbackedProtectedGates(
  ctx: TopologyContext,
  gates: readonly TopologyGate[],
  verified: ReadonlySet<string>,
  affected: ReadonlySet<string>
): void {
  const dependedOn = gateDependentIds(gates);
  for (const gate of gates) {
    if (!isProtectedGate(gate.id, dependedOn)) continue;
    if (verified.has(gate.id) || affected.has(gate.id)) continue;
    topologyLintError(
      ctx,
      'protected_gate_without_source_relation',
      `protected gate ${gate.id} has no check implementation and no cache input inside this workspace`,
      { nodeId: gate.nodeId, path: gate.manifestPath }
    );
  }
}

/**
 * Presets are the manifest's own grouping of gates into runnable pipelines, so
 * they are the one honest source for `pipeline gated_by gate`.
 */
export function buildGatePresetPipelines(ctx: TopologyContext, gates: readonly TopologyGate[]): TopologyPresetPipeline[] {
  const byPreset = new Map<string, TopologyGate[]>();
  for (const gate of gates) {
    for (const preset of gate.presets) {
      const bucket = byPreset.get(preset);
      if (bucket) bucket.push(gate);
      else byPreset.set(preset, [gate]);
    }
  }

  const dependedOn = gateDependentIds(gates);
  const pipelines: TopologyPresetPipeline[] = [];
  for (const preset of [...byPreset.keys()].sort()) {
    const members = byPreset.get(preset) ?? [];
    const first = members[0];
    if (!first) continue;
    const pipelineId = contextGraphNodeId({ kind: 'pipeline', pipelineId: `gates:${preset}` });
    const metadata: ContextGraphMetadata = {
      source: 'gate-manifest',
      pipelineKind: 'gate_preset',
      preset,
      manifest: first.manifestPath,
      gateCount: members.length,
      protectedGateCount: members.filter((gate) => isProtectedGate(gate.id, dependedOn)).length
    };
    const added = addNode(ctx, {
      id: pipelineId,
      kind: 'pipeline',
      label: `gates:${preset}`,
      path: first.manifestPath,
      contentHash: first.manifestHash,
      trust: 0.95,
      risk: preset === 'release' ? 'protected' : 'high',
      tokenCost: estimateTokenCost([preset, String(members.length)]),
      metadata,
      sourcePath: first.manifestPath
    });
    if (!added) continue;
    for (const gate of members) {
      addEdge(ctx, {
        from: pipelineId,
        to: gate.nodeId,
        type: 'gated_by',
        confidence: 'manifest',
        path: gate.manifestPath,
        hash: gate.manifestHash,
        line: gate.line
      });
    }
    pipelines.push({
      preset,
      pipelineId,
      manifestPath: first.manifestPath,
      manifestHash: first.manifestHash,
      gateCount: members.length
    });
  }
  return pipelines;
}
