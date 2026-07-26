/**
 * Read-only Context Graph diagnostics for `sks triwiki`.
 *
 * These are inspection surfaces, not build surfaces: nothing here compiles,
 * writes, or repairs the graph. A full rebuild is owned by
 * `sks wiki refresh --code`, and every failure here names that command rather
 * than quietly doing it for you.
 */
import { flag, readOption } from '../../cli/args.js';
import {
  CONTEXT_GRAPH_REPAIR_COMMAND,
  type ContextGraphLintIssue
} from '../triwiki/context-graph/contracts.js';
import { contextGraphExtractors } from '../triwiki/context-graph/extractors/index.js';
import { runContextGraphLint } from '../triwiki/context-graph/lint/index.js';
import { contextGraphQueryProfile } from '../triwiki/context-graph/profiles.js';
import { queryContextGraph } from '../triwiki/context-graph/query/index.js';
import { contextGraphStatus } from '../triwiki/context-graph/store/graph-status.js';
import { readContextGraphMeta, readContextGraphSnapshot } from '../triwiki/context-graph/store/snapshot-store.js';

export const TRIWIKI_GRAPH_SUBCOMMANDS = ['graph-status', 'graph-lint', 'graph-query'] as const;

export type TriWikiGraphSubcommand = (typeof TRIWIKI_GRAPH_SUBCOMMANDS)[number];

export function isTriWikiGraphSubcommand(value: unknown): value is TriWikiGraphSubcommand {
  return typeof value === 'string' && (TRIWIKI_GRAPH_SUBCOMMANDS as readonly string[]).includes(value);
}

function issueLine(issue: ContextGraphLintIssue): string {
  const where = issue.nodeId ?? issue.edgeId ?? issue.path ?? '';
  return `${issue.severity}: ${issue.code}${where ? ` ${where}` : ''} — ${issue.message}`;
}

async function graphStatus(root: string): Promise<{ result: unknown; ok: boolean; lines: string[] }> {
  const status = await contextGraphStatus(root, { extractors: contextGraphExtractors() });
  const meta = await readContextGraphMeta(root);
  const result = {
    schema: 'sks.triwiki-graph-status.v1',
    ok: status.status === 'fresh',
    status: status.status,
    snapshot_hash: status.snapshotHash,
    generated_at: status.generatedAt,
    stale_reasons: status.reasons,
    error_code: status.errorCode,
    node_count: status.nodeCount,
    edge_count: status.edgeCount,
    lint: meta.status === 'ok' && meta.meta ? meta.meta.lint : null,
    repair_command: status.repairCommand
  };
  const lines = [
    `Context graph: ${status.status} (${status.nodeCount} nodes, ${status.edgeCount} edges)`,
    ...(status.snapshotHash ? [`Snapshot: ${status.snapshotHash.slice(0, 16)}`] : []),
    ...(status.reasons.length ? [`Stale reasons: ${status.reasons.join(', ')}`] : []),
    ...(status.status === 'fresh' ? [] : [`Repair: ${status.repairCommand}`])
  ];
  return { result, ok: result.ok, lines };
}

async function graphLint(root: string): Promise<{ result: unknown; ok: boolean; lines: string[] }> {
  const snapshotLoad = await readContextGraphSnapshot(root);
  if (snapshotLoad.status !== 'ok' || !snapshotLoad.snapshot) {
    const errorCode = snapshotLoad.status === 'missing' ? 'context_graph_missing' : 'context_graph_corrupt';
    return {
      result: {
        schema: 'sks.triwiki-graph-lint.v1',
        ok: false,
        error_code: errorCode,
        errors: [],
        warnings: [],
        repair_command: CONTEXT_GRAPH_REPAIR_COMMAND
      },
      ok: false,
      lines: [`Context graph lint: ${errorCode}`, `Repair: ${CONTEXT_GRAPH_REPAIR_COMMAND}`]
    };
  }
  const meta = await readContextGraphMeta(root);
  const lint = runContextGraphLint({
    root,
    snapshot: snapshotLoad.snapshot,
    meta: meta.status === 'ok' ? meta.meta : null
  });
  const result = {
    schema: 'sks.triwiki-graph-lint.v1',
    ok: lint.ok,
    snapshot_hash: snapshotLoad.snapshot.snapshotHash,
    error_count: lint.errorCount,
    warning_count: lint.warningCount,
    errors: lint.errors.map(issueLine),
    warnings: lint.warnings.slice(0, 40).map(issueLine),
    repair_command: CONTEXT_GRAPH_REPAIR_COMMAND
  };
  return {
    result,
    ok: lint.ok,
    lines: [
      `Context graph lint: ${lint.ok ? 'ok' : 'blocked'} (${lint.errorCount} errors, ${lint.warningCount} warnings)`,
      ...lint.errors.slice(0, 20).map((issue) => `- ${issueLine(issue)}`)
    ]
  };
}

async function graphQuery(root: string, args: string[]): Promise<{ result: unknown; ok: boolean; lines: string[] }> {
  const query = args.find((arg) => !arg.startsWith('-')) ?? '';
  const profile = contextGraphQueryProfile(readOption(args, '--profile', 'implementation')).name;
  const budgetRaw = readOption(args, '--token-budget', '');
  const parsedBudget = budgetRaw ? Number.parseInt(String(budgetRaw), 10) : Number.NaN;
  if (!query) {
    return {
      result: { schema: 'sks.triwiki-graph-query.v1', ok: false, errors: ['missing_query'] },
      ok: false,
      lines: ['Usage: sks triwiki graph-query "<query>" [--profile implementation|review|planning|answer] [--json]']
    };
  }
  const answer = await queryContextGraph({
    root,
    query,
    profile,
    ...(Number.isFinite(parsedBudget) ? { tokenBudget: parsedBudget } : {})
  });
  const result = {
    schema: 'sks.triwiki-graph-query.v1',
    ok: answer.ok,
    profile: answer.profile,
    snapshot_hash: answer.snapshotHash,
    snapshot_freshness: answer.snapshotFreshness,
    seed_count: answer.seedCount,
    visited_nodes: answer.visitedNodes,
    selected: answer.selected.map((node) => ({
      id: node.nodeId,
      kind: node.kind,
      path: node.path ?? null,
      score: node.score,
      trust: node.trust,
      freshness: node.freshness,
      token_cost: node.tokenCost,
      reason_path: node.reasonPath,
      provenance: node.provenance
    })),
    provenance_coverage: answer.provenanceCoverage,
    stale_excluded: answer.staleExcluded,
    invalidated_excluded: answer.invalidatedExcluded,
    token_cost: answer.tokenCost,
    token_budget: answer.tokenBudget,
    truncated: answer.truncated,
    timeout: answer.timeout,
    omission_reasons: answer.omissionReasons,
    warnings: answer.warnings,
    errors: answer.errors,
    repair_command: CONTEXT_GRAPH_REPAIR_COMMAND
  };
  const lines = answer.ok
    ? [
        `Context graph query (${answer.profile}): ${answer.selected.length} nodes, ${answer.tokenCost}/${answer.tokenBudget} tokens`,
        ...answer.selected.slice(0, 12).map((node) => `- ${node.nodeId}  [${node.reasonPath.join(' ')}]`)
      ]
    : [`Context graph query blocked: ${answer.errors.join(', ')}`, `Repair: ${CONTEXT_GRAPH_REPAIR_COMMAND}`];
  return { result, ok: answer.ok, lines };
}

/** Dispatch a `graph-*` subcommand. Returns the JSON-shaped result for the caller to print. */
export async function triwikiGraphCommand(
  root: string,
  sub: TriWikiGraphSubcommand,
  args: string[]
): Promise<{ result: unknown; ok: boolean; lines: string[] }> {
  if (sub === 'graph-status') return graphStatus(root);
  if (sub === 'graph-lint') return graphLint(root);
  return graphQuery(root, args.filter((arg) => arg !== 'graph-query' && !flag([arg], '--json')));
}
