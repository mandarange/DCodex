/**
 * Gate manifest parsing and gate node construction.
 *
 * The release DAG is machine-readable, so nothing here guesses: a gate exists
 * because a manifest declares it, and `protected` risk is taken from the release
 * manifest sets plus the dependency structure, never from a hand-written list.
 */
import { ALWAYS_ON_GATES, FORBIDDEN_RECURSIVE_GATES, REQUIRED_FOR_PUBLISH } from '../../../../release/gate-manifest.js';
import type { ContextGraphMetadata } from '../../contracts.js';
import { contextGraphNodeId } from '../../ids.js';
import type { TopologyContext } from './shared.js';
import {
  addNode,
  asRecord,
  estimateTokenCost,
  isCanonicalId,
  mapIdentifierLines,
  readNumberField,
  readStringArrayField,
  readStringField,
  readWorkspaceText,
  recordSkip,
  topologyLintError
} from './shared.js';

export interface GateManifestSource {
  readonly path: string;
  readonly schemas: readonly string[];
}

/** Manifests that declare the SKS gate DAG. Both share the same entry shape. */
export const TOPOLOGY_GATE_MANIFESTS: readonly GateManifestSource[] = [
  { path: 'release-gates.v2.json', schemas: ['sks.release-gates.v2'] },
  { path: 'infra-harness-gates.json', schemas: ['sks.infra-harness-gates.v1'] }
];

/** Gate id namespaces that are release/security critical by construction. */
export const TOPOLOGY_PROTECTED_NAMESPACES: ReadonlySet<string> = new Set([
  'release',
  'publish',
  'security',
  'secret',
  'prepublish'
]);

export interface TopologyGate {
  readonly id: string;
  readonly nodeId: string;
  readonly manifestPath: string;
  readonly manifestHash: string;
  readonly line: number | undefined;
  readonly command: string;
  readonly deps: readonly string[];
  readonly cacheInputs: readonly string[];
  readonly cacheEnabled: boolean;
  readonly presets: readonly string[];
  readonly sideEffect: string;
  readonly resource: readonly string[];
  readonly timeoutMs: number;
  readonly outputContract: string;
}

const GATE_ID_LINE = /"id"\s*:\s*"([^"]+)"/;

/**
 * Parse both gate manifests. A manifest that exists but does not parse produces
 * an explicit lint error; only a manifest that is absent from this workspace is
 * allowed to contribute nothing.
 */
export function collectTopologyGates(ctx: TopologyContext): TopologyGate[] {
  const gates: TopologyGate[] = [];
  const seen = new Map<string, string>();

  for (const manifest of TOPOLOGY_GATE_MANIFESTS) {
    const read = readWorkspaceText(ctx, manifest.path);
    if (!read) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(read.text);
    } catch {
      topologyLintError(ctx, 'invalid_node_field', `${manifest.path} is not valid JSON`, { path: manifest.path });
      continue;
    }
    const root = asRecord(parsed);
    if (!root) {
      topologyLintError(ctx, 'invalid_node_field', `${manifest.path} is not a gate manifest object`, { path: manifest.path });
      continue;
    }
    const schema = readStringField(root, 'schema');
    if (!manifest.schemas.includes(schema)) {
      topologyLintError(
        ctx,
        'invalid_node_field',
        `${manifest.path} declares schema "${schema}" instead of ${manifest.schemas.join(' | ')}`,
        { path: manifest.path }
      );
      continue;
    }
    const rawGates = root.gates;
    if (!Array.isArray(rawGates)) {
      topologyLintError(ctx, 'invalid_node_field', `${manifest.path} has no gates array`, { path: manifest.path });
      continue;
    }
    const lines = mapIdentifierLines(read.text, GATE_ID_LINE);

    for (const [index, rawGate] of rawGates.entries()) {
      const entry = asRecord(rawGate);
      if (!entry) {
        topologyLintError(ctx, 'invalid_node_field', `${manifest.path} gate[${index}] is not an object`, { path: manifest.path });
        continue;
      }
      const id = readStringField(entry, 'id').trim();
      if (!id) {
        topologyLintError(ctx, 'invalid_node_field', `${manifest.path} gate[${index}] has no id`, { path: manifest.path });
        continue;
      }
      const nodeId = contextGraphNodeId({ kind: 'gate', gateId: id });
      if (!isCanonicalId('gate', id, nodeId)) {
        topologyLintError(ctx, 'invalid_node_field', `${manifest.path} gate id "${id}" is not a canonical gate id`, {
          path: manifest.path
        });
        continue;
      }
      const previous = seen.get(id);
      if (previous) {
        topologyLintError(ctx, 'duplicate_node_conflict', `gate ${id} is declared in both ${previous} and ${manifest.path}`, {
          nodeId,
          path: manifest.path
        });
        continue;
      }
      seen.set(id, manifest.path);
      const cache = asRecord(entry.cache);
      gates.push({
        id,
        nodeId,
        manifestPath: manifest.path,
        manifestHash: read.hash,
        line: lines.get(id),
        command: readStringField(entry, 'command'),
        deps: readStringArrayField(entry, 'deps'),
        cacheInputs: cache ? readStringArrayField(cache, 'inputs') : [],
        cacheEnabled: cache ? cache.enabled === true : false,
        presets: readStringArrayField(entry, 'preset'),
        sideEffect: readStringField(entry, 'side_effect'),
        resource: readStringArrayField(entry, 'resource'),
        timeoutMs: readNumberField(entry, 'timeout_ms'),
        outputContract: readStringField(entry, 'output_contract')
      });
    }
  }

  gates.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return gates;
}

/** Gate ids some other gate depends on: breaking them breaks the DAG downstream. */
export function gateDependentIds(gates: readonly TopologyGate[]): Set<string> {
  const dependedOn = new Set<string>();
  for (const gate of gates) for (const dep of gate.deps) dependedOn.add(dep);
  return dependedOn;
}

export function isProtectedGate(id: string, dependedOn: ReadonlySet<string>): boolean {
  if (REQUIRED_FOR_PUBLISH.has(id) || ALWAYS_ON_GATES.has(id) || FORBIDDEN_RECURSIVE_GATES.has(id)) return true;
  if (dependedOn.has(id)) return true;
  return TOPOLOGY_PROTECTED_NAMESPACES.has(id.split(':')[0] ?? '');
}

function gateRisk(gate: TopologyGate, dependedOn: ReadonlySet<string>): 'protected' | 'high' | 'medium' {
  if (isProtectedGate(gate.id, dependedOn)) return 'protected';
  return gate.sideEffect === 'hermetic' ? 'medium' : 'high';
}

/**
 * The manifest command line is stored as the mapped script token only, never as
 * a raw shell string, so the artifact stays free of ad-hoc command text.
 */
export function gateCheckCandidates(command: string): string[] {
  const out: string[] = [];
  for (const token of String(command ?? '').split(/\s+/)) {
    const cleaned = token.replace(/^['"]|['"]$/g, '').replace(/^\.\//, '');
    if (!/\.(js|mjs|cjs)$/.test(cleaned)) continue;
    if (cleaned.startsWith('node_modules/')) continue;
    if (cleaned.startsWith('/') || cleaned.startsWith('~') || /^[A-Za-z]:/.test(cleaned)) continue;
    if (cleaned.includes('..')) continue;
    const mapped = cleaned.startsWith('dist/')
      ? `src/${cleaned.slice('dist/'.length).replace(/\.(js|mjs|cjs)$/, '.ts')}`
      : cleaned;
    if (!out.includes(mapped)) out.push(mapped);
  }
  return out;
}

export function buildGateNodes(ctx: TopologyContext, gates: readonly TopologyGate[]): void {
  const dependedOn = gateDependentIds(gates);
  for (const gate of gates) {
    const metadata: ContextGraphMetadata = {
      source: 'gate-manifest',
      manifest: gate.manifestPath,
      gateId: gate.id,
      namespace: gate.id.split(':')[0] ?? '',
      deps: [...gate.deps],
      presets: [...gate.presets],
      resource: [...gate.resource],
      sideEffect: gate.sideEffect,
      timeoutMs: gate.timeoutMs,
      cacheEnabled: gate.cacheEnabled,
      cacheInputs: [...gate.cacheInputs],
      checkScripts: gateCheckCandidates(gate.command),
      outputContract: gate.outputContract,
      requiredForPublish: REQUIRED_FOR_PUBLISH.has(gate.id),
      alwaysOnRelease: ALWAYS_ON_GATES.has(gate.id),
      nonRecursive: FORBIDDEN_RECURSIVE_GATES.has(gate.id),
      hasDependents: dependedOn.has(gate.id)
    };
    addNode(ctx, {
      id: gate.nodeId,
      kind: 'gate',
      label: gate.id,
      path: gate.manifestPath,
      line: gate.line,
      contentHash: gate.manifestHash,
      trust: 0.95,
      risk: gateRisk(gate, dependedOn),
      tokenCost: estimateTokenCost([gate.id, gate.sideEffect, gate.cacheInputs.join(' ')]),
      metadata,
      sourcePath: gate.manifestPath
    });
  }
  if (!gates.length) {
    for (const manifest of TOPOLOGY_GATE_MANIFESTS) {
      if (ctx.inputHashes[manifest.path] === undefined) continue;
      recordSkip(ctx, manifest.path, 'excluded', 'manifest declared no usable gates');
    }
  }
}
