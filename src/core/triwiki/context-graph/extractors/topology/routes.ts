/**
 * Route nodes and the per-route lifecycle pipelines.
 *
 * A route's `lifecycle` is the manifest's own ordered pipeline for that route,
 * so it becomes a `pipeline` node rather than a synthetic invention, and the
 * declared `cliEntrypoint` is the only thing allowed to connect a command to it.
 */
import { ROUTES } from '../../../../routes.js';
import type { ContextGraphMetadata } from '../../contracts.js';
import { contextGraphNodeId } from '../../ids.js';
import { canonicalCommandName, commandNodeIdFor } from './commands.js';
import type { TopologyContext } from './shared.js';
import {
  addEdge,
  addNode,
  asRecord,
  estimateTokenCost,
  isCanonicalId,
  mapIdentifierLines,
  readStringArrayField,
  readStringField,
  readWorkspaceText,
  recordSkip,
  topologyLintError
} from './shared.js';

export const TOPOLOGY_ROUTES_PATH = 'src/core/routes.ts';
const ROUTE_ID_LINE = /^\s*id:\s*'([^']+)'/;
const CLI_VERB = /^sks\s+([a-z][a-z0-9-]*)/;

/** The CLI verb a route declares, resolved through the alias table. */
export function routeCliCommandName(cliEntrypoint: string): string | null {
  const match = CLI_VERB.exec(String(cliEntrypoint ?? '').trim());
  const verb = match?.[1];
  return verb ? canonicalCommandName(verb) : null;
}

export function buildRouteGraph(ctx: TopologyContext): void {
  const read = readWorkspaceText(ctx, TOPOLOGY_ROUTES_PATH);
  if (!read) return;
  const lines = mapIdentifierLines(read.text, ROUTE_ID_LINE);
  const entries = ROUTES as readonly unknown[];
  if (!entries.length) {
    topologyLintError(ctx, 'invalid_node_field', `${TOPOLOGY_ROUTES_PATH} declares no routes`, { path: TOPOLOGY_ROUTES_PATH });
    return;
  }

  for (const raw of entries) {
    const route = asRecord(raw);
    if (!route) {
      topologyLintError(ctx, 'invalid_node_field', `${TOPOLOGY_ROUTES_PATH} contains a non-object route`, {
        path: TOPOLOGY_ROUTES_PATH
      });
      continue;
    }
    const id = readStringField(route, 'id').trim();
    if (!id) {
      topologyLintError(ctx, 'invalid_node_field', `${TOPOLOGY_ROUTES_PATH} contains a route with no id`, {
        path: TOPOLOGY_ROUTES_PATH
      });
      continue;
    }
    const routeNodeId = contextGraphNodeId({ kind: 'route', name: id });
    if (!isCanonicalId('route', id, routeNodeId)) {
      topologyLintError(ctx, 'invalid_node_field', `route "${id}" is not a canonical route id`, { path: TOPOLOGY_ROUTES_PATH });
      continue;
    }

    const line = lines.get(id);
    const lifecycle = readStringArrayField(route, 'lifecycle');
    const routeLabel = readStringField(route, 'route') || id;
    const stopGate = readStringField(route, 'stopGate');
    const codexAppOnly = route.codexAppOnly === true;
    const cliEntrypoint = readStringField(route, 'cliEntrypoint');

    const routeMetadata: ContextGraphMetadata = {
      source: 'routes',
      routeId: id,
      command: readStringField(route, 'command'),
      mode: readStringField(route, 'mode'),
      routeName: routeLabel,
      stopGate,
      context7Policy: readStringField(route, 'context7Policy'),
      reasoningPolicy: readStringField(route, 'reasoningPolicy'),
      requiredSkills: readStringArrayField(route, 'requiredSkills'),
      dollarAliases: readStringArrayField(route, 'dollarAliases'),
      hidden: route.hidden === true,
      codexAppOnly,
      cliEntrypointDeclared: Boolean(cliEntrypoint)
    };
    const routeAdded = addNode(ctx, {
      id: routeNodeId,
      kind: 'route',
      label: id,
      path: TOPOLOGY_ROUTES_PATH,
      line,
      contentHash: read.hash,
      trust: 0.9,
      risk: route.mutatesRouteState === true ? 'high' : 'medium',
      tokenCost: estimateTokenCost([id, routeLabel, lifecycle.join(' ')]),
      metadata: routeMetadata,
      sourcePath: TOPOLOGY_ROUTES_PATH
    });
    if (!routeAdded) continue;

    if (!lifecycle.length) {
      recordSkip(ctx, TOPOLOGY_ROUTES_PATH, 'excluded', `route ${id} declares no lifecycle pipeline`);
      continue;
    }
    const pipelineNodeId = contextGraphNodeId({ kind: 'pipeline', pipelineId: `route:${id}` });
    const pipelineMetadata: ContextGraphMetadata = {
      source: 'routes',
      pipelineKind: 'route_lifecycle',
      routeId: id,
      stages: lifecycle,
      stageCount: lifecycle.length,
      stopGate,
      codexAppOnly
    };
    const pipelineAdded = addNode(ctx, {
      id: pipelineNodeId,
      kind: 'pipeline',
      label: routeLabel,
      path: TOPOLOGY_ROUTES_PATH,
      line,
      contentHash: read.hash,
      trust: 0.9,
      risk: 'medium',
      tokenCost: estimateTokenCost([routeLabel, lifecycle.join(' ')]),
      metadata: pipelineMetadata,
      sourcePath: TOPOLOGY_ROUTES_PATH
    });
    if (!pipelineAdded) continue;

    addEdge(ctx, {
      from: routeNodeId,
      to: pipelineNodeId,
      type: 'routes_to',
      confidence: 'manifest',
      path: TOPOLOGY_ROUTES_PATH,
      hash: read.hash,
      line
    });

    // `codexAppOnly` routes state in the manifest that their CLI verb is a
    // neighbouring discovery command, not an invocation of the route.
    if (codexAppOnly) continue;
    const commandName = routeCliCommandName(cliEntrypoint);
    if (!commandName) continue;
    const commandId = commandNodeIdFor(commandName);
    if (!ctx.nodes.has(commandId)) continue;
    addEdge(ctx, {
      from: commandId,
      to: pipelineNodeId,
      type: 'routes_to',
      confidence: 'manifest',
      path: TOPOLOGY_ROUTES_PATH,
      hash: read.hash,
      line
    });
  }
}
