/**
 * Command nodes and the files/pipelines a command reaches.
 *
 * The command list is imported from the lite manifest rather than scraped out of
 * the registry source: the manifest is the machine-readable contract, and a
 * regex over TypeScript would invent commands that do not exist.
 */
import {
  COMMAND_ALIASES_LITE,
  COMMAND_MANIFEST_LITE,
  LEGACY_COMMAND_ALIASES_LITE
} from '../../../../../cli/command-manifest-lite.js';
import type { ContextGraphEdgeConfidence, ContextGraphMetadata, ContextGraphRisk } from '../../contracts.js';
import { contextGraphNodeId } from '../../ids.js';
import type { TopologyPresetPipeline } from './gate-edges.js';
import type { TopologyContext } from './shared.js';
import {
  addEdge,
  addNode,
  asRecord,
  ensureFileNode,
  estimateTokenCost,
  isCanonicalId,
  mapIdentifierLines,
  readStringField,
  readWorkspaceText,
  recordSkip,
  topologyLintError
} from './shared.js';

export const TOPOLOGY_COMMAND_MANIFEST_PATH = 'src/cli/command-manifest-lite.ts';
export const TOPOLOGY_RUNTIME_SCRIPTS_PATH = 'runtime-required-scripts.json';
const RUNTIME_SCRIPTS_SCHEMA = 'sks.runtime-required-scripts.v1';
const COMMAND_NAME_LINE = /\{\s*name:\s*'([^']+)'/;

export interface TopologyRuntimeManifest {
  readonly present: boolean;
  readonly path: string;
  readonly hash: string;
  /** workspace source paths the runtime manifest names verbatim */
  readonly sources: ReadonlySet<string>;
}

const EMPTY_RUNTIME_MANIFEST: TopologyRuntimeManifest = {
  present: false,
  path: TOPOLOGY_RUNTIME_SCRIPTS_PATH,
  hash: '',
  sources: new Set<string>()
};

/**
 * `runtime-required-scripts.json` classifies which sources are installed runtime
 * entrypoints and which are checkout-only. That classification is attached to
 * file nodes and promotes a convention-derived handler edge to manifest grade.
 */
export function collectRuntimeManifest(ctx: TopologyContext): TopologyRuntimeManifest {
  const read = readWorkspaceText(ctx, TOPOLOGY_RUNTIME_SCRIPTS_PATH);
  if (!read) return EMPTY_RUNTIME_MANIFEST;

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    topologyLintError(ctx, 'invalid_node_field', `${TOPOLOGY_RUNTIME_SCRIPTS_PATH} is not valid JSON`, {
      path: TOPOLOGY_RUNTIME_SCRIPTS_PATH
    });
    return EMPTY_RUNTIME_MANIFEST;
  }
  const root = asRecord(parsed);
  if (!root || readStringField(root, 'schema') !== RUNTIME_SCRIPTS_SCHEMA) {
    topologyLintError(
      ctx,
      'invalid_node_field',
      `${TOPOLOGY_RUNTIME_SCRIPTS_PATH} does not declare ${RUNTIME_SCRIPTS_SCHEMA}`,
      { path: TOPOLOGY_RUNTIME_SCRIPTS_PATH }
    );
    return EMPTY_RUNTIME_MANIFEST;
  }

  const sources = new Set<string>();
  const scripts = Array.isArray(root.scripts) ? root.scripts : [];
  for (const raw of scripts) {
    const entry = asRecord(raw);
    if (!entry) continue;
    const mapped = mapDistPathToSource(readStringField(entry, 'path'));
    if (!mapped || !ctx.files.set.has(mapped)) continue;
    ctx.fileClassification.set(mapped, readStringField(entry, 'category') || 'installed_runtime');
    sources.add(mapped);
  }
  const policies = Array.isArray(root.reference_source_policies) ? root.reference_source_policies : [];
  for (const raw of policies) {
    const entry = asRecord(raw);
    if (!entry) continue;
    const source = readStringField(entry, 'source').split('#')[0] ?? '';
    if (!source || source.includes('*') || source.startsWith('dist/')) continue;
    if (!ctx.files.set.has(source)) continue;
    ctx.fileClassification.set(source, readStringField(entry, 'classification') || 'unclassified');
    sources.add(source);
  }
  return { present: true, path: TOPOLOGY_RUNTIME_SCRIPTS_PATH, hash: read.hash, sources };
}

function mapDistPathToSource(value: string): string | null {
  if (!value.startsWith('dist/') || value.includes('..')) return null;
  return `src/${value.slice('dist/'.length).replace(/\.(js|mjs|cjs)$/, '.ts')}`;
}

/** Conventional handler locations; only paths that really exist become edges. */
export function commandHandlerCandidates(name: string): string[] {
  return [
    `src/commands/${name}.ts`,
    `src/core/commands/${name}-command.ts`,
    `src/cli/${name}-command.ts`,
    `src/cli/${name}.ts`
  ];
}

const RISK_BY_LEVEL: Record<string, ContextGraphRisk> = { R0: 'low', R1: 'medium', R2: 'medium', R3: 'high' };

export function commandNodeIdFor(name: string): string {
  return contextGraphNodeId({ kind: 'command', name });
}

/**
 * Every alias, including the legacy (renamed) ones, mapped to its canonical
 * command name. A rename must never mint a second command node.
 */
function commandAliasMap(): Record<string, string> {
  return {
    ...(LEGACY_COMMAND_ALIASES_LITE as Record<string, string>),
    ...(COMMAND_ALIASES_LITE as Record<string, string>)
  };
}

/** Resolve an alias (a renamed or shorthand verb) to its canonical command name. */
export function canonicalCommandName(candidate: string): string | null {
  const raw = String(candidate ?? '').trim();
  if (!raw) return null;
  const resolved = commandAliasMap()[raw] ?? raw;
  return COMMAND_MANIFEST_LITE.some((entry) => entry.name === resolved) ? resolved : null;
}

export interface TopologyCommandGraph {
  readonly present: boolean;
  readonly path: string;
  readonly hash: string;
}

export function buildCommandGraph(
  ctx: TopologyContext,
  runtime: TopologyRuntimeManifest,
  presets: readonly TopologyPresetPipeline[]
): TopologyCommandGraph {
  const read = readWorkspaceText(ctx, TOPOLOGY_COMMAND_MANIFEST_PATH);
  if (!read) return { present: false, path: TOPOLOGY_COMMAND_MANIFEST_PATH, hash: '' };
  const lines = mapIdentifierLines(read.text, COMMAND_NAME_LINE);
  const aliasesByCommand = groupAliases();

  for (const entry of COMMAND_MANIFEST_LITE) {
    const nodeId = commandNodeIdFor(entry.name);
    if (!isCanonicalId('command', entry.name, nodeId)) {
      topologyLintError(ctx, 'invalid_node_field', `command "${entry.name}" is not a canonical command id`, {
        path: TOPOLOGY_COMMAND_MANIFEST_PATH
      });
      continue;
    }
    const line = lines.get(entry.name);
    const metadata: ContextGraphMetadata = {
      source: 'command-manifest-lite',
      commandName: entry.name,
      summary: entry.summary,
      maturity: entry.maturity,
      riskLevel: entry.risk,
      latency: entry.latency,
      inputProfile: entry.inputProfile,
      supportsJson: entry.supportsJson,
      remoteAllowed: entry.remoteAllowed,
      readonlyCommand: entry.readonly === true,
      diagnostic: entry.diagnostic === true,
      deprecated: entry.deprecated === true,
      hidden: entry.hidden === true,
      mutatesRouteState: entry.mutatesRouteState === true,
      requiredCapabilities: [...entry.requiredCapabilities],
      aliases: aliasesByCommand.get(entry.name) ?? []
    };
    addNode(ctx, {
      id: nodeId,
      kind: 'command',
      label: entry.name,
      path: TOPOLOGY_COMMAND_MANIFEST_PATH,
      line,
      contentHash: read.hash,
      trust: 0.95,
      risk: RISK_BY_LEVEL[entry.risk] ?? 'medium',
      tokenCost: estimateTokenCost([entry.name, entry.summary]),
      metadata,
      sourcePath: TOPOLOGY_COMMAND_MANIFEST_PATH
    });

    let handlers = 0;
    for (const candidate of commandHandlerCandidates(entry.name)) {
      if (!ctx.files.set.has(candidate)) continue;
      const fileId = ensureFileNode(ctx, candidate, 'command_handler', TOPOLOGY_COMMAND_MANIFEST_PATH);
      if (!fileId) continue;
      const declared = runtime.present && runtime.sources.has(candidate);
      const confidence: ContextGraphEdgeConfidence = declared ? 'manifest' : 'derived';
      const added = addEdge(ctx, {
        from: nodeId,
        to: fileId,
        type: 'routes_to',
        confidence,
        path: declared ? runtime.path : TOPOLOGY_COMMAND_MANIFEST_PATH,
        hash: declared ? runtime.hash : read.hash,
        ...(declared ? {} : { line })
      });
      if (added) handlers += 1;
      if (declared) {
        addEdge(ctx, {
          from: nodeId,
          to: fileId,
          type: 'owns',
          confidence: 'manifest',
          path: runtime.path,
          hash: runtime.hash
        });
      }
    }
    if (!handlers) {
      recordSkip(
        ctx,
        TOPOLOGY_COMMAND_MANIFEST_PATH,
        'excluded',
        `command ${entry.name} has no conventional handler file in this workspace`
      );
    }
  }

  linkCommandsToPresetPipelines(ctx, presets);
  return { present: true, path: TOPOLOGY_COMMAND_MANIFEST_PATH, hash: read.hash };
}

function groupAliases(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const aliases = commandAliasMap();
  for (const alias of Object.keys(aliases).sort()) {
    const target = aliases[alias];
    if (!target) continue;
    const bucket = out.get(target);
    if (bucket) bucket.push(alias);
    else out.set(target, [alias]);
  }
  return out;
}

/**
 * A preset whose name is also a command name is the manifest saying the two are
 * the same runnable surface (`release`, `harness`). The match is on canonical
 * ids only, so a preset without a command simply gets no edge.
 */
function linkCommandsToPresetPipelines(ctx: TopologyContext, presets: readonly TopologyPresetPipeline[]): void {
  for (const preset of presets) {
    const name = canonicalCommandName(preset.preset);
    if (!name) continue;
    const commandId = commandNodeIdFor(name);
    if (!ctx.nodes.has(commandId)) continue;
    addEdge(ctx, {
      from: commandId,
      to: preset.pipelineId,
      type: 'routes_to',
      confidence: 'derived',
      path: preset.manifestPath,
      hash: preset.manifestHash
    });
  }
}
