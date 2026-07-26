/**
 * The TriWiki code pack.
 *
 * The pack is no longer produced by a directory scanner that walks the repository
 * on its own — it is a projection of the compiled Context Graph. `buildCodePack`
 * therefore takes a snapshot (or a built index) instead of a `CodeIndex`, and the
 * fields consumers already read keep their meaning:
 *
 *   - `entries[].citations` are the graph's provenance records, so every entry
 *     points at real workspace-relative repository paths;
 *   - `entries[].freshness` is a verdict about source bytes, not a placeholder;
 *   - `index_digest` binds the pack to the snapshot hash *and* to the projected
 *     content, so an export or dependency change moves it.
 *
 * This file owns the artifact: where it lives, how it is validated, and how it is
 * written. The projection itself lives in `context-graph/projections/`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, exists, readJson, writeJsonAtomic } from '../fsx.js';
import type { ContextGraphSnapshot } from './context-graph/contracts.js';
import type { ContextGraphIndex } from './context-graph/graph-index.js';
import {
  buildCodePackFromGraph,
  type BuildCodePackFromGraphOptions
} from './context-graph/projections/code-pack.js';
import { CODE_PACK_SCHEMA, type CodePack } from './context-graph/projections/pack-contract.js';

export { CODE_PACK_SCHEMA, DEFAULT_CODE_PACK_TOKEN_BUDGET } from './context-graph/projections/pack-contract.js';
export type { CodePack, CodePackCitation, CodePackEntry } from './context-graph/projections/pack-contract.js';
export {
  buildCodePackFromGraph,
  computeCodePackIndexDigest,
  projectCodePackFromGraph,
  type BuildCodePackFromGraphOptions,
  type CodePackProjection
} from './context-graph/projections/code-pack.js';
export {
  buildWorkspaceCodePack,
  type WorkspaceCodePackOptions,
  type WorkspaceCodePackResult
} from './context-graph/projections/code-pack-workspace.js';

export function codePackDir(root: string): string {
  return path.join(root, '.sneakoscope', 'wiki');
}

export function codePackPath(root: string): string {
  return path.join(codePackDir(root), 'code-pack.json');
}

export function codePackPrevPath(root: string): string {
  return path.join(codePackDir(root), 'code-pack.prev.json');
}

/**
 * Project a code pack from a compiled Context Graph.
 *
 * `source` is a snapshot or an already-built index; passing the index avoids
 * rebuilding adjacency for a graph the caller already holds. Options carry the
 * query, profile and risk that decide *which* nodes earn the token budget —
 * relevance ranking replaces the old module inventory order.
 */
export function buildCodePack(
  root: string,
  source: ContextGraphSnapshot | ContextGraphIndex,
  options: BuildCodePackFromGraphOptions = {}
): CodePack {
  return buildCodePackFromGraph(root, source, options);
}

export async function validateCodePack(pack: CodePack, root: string): Promise<{ ok: boolean; issues: string[] }> {
  const issues: string[] = [];
  const seenIds = new Set<string>();
  if (pack.schema !== CODE_PACK_SCHEMA) issues.push(`unexpected pack schema: ${String(pack.schema)}`);
  if (!pack.index_digest) issues.push('pack has no index_digest');
  for (const entry of pack.entries) {
    if (seenIds.has(entry.id)) {
      issues.push(`duplicate entry id: ${entry.id}`);
    } else {
      seenIds.add(entry.id);
    }
    if (!entry.citations.length) {
      issues.push(`entry ${entry.id} has no citations`);
      continue;
    }
    for (const citation of entry.citations) {
      const absolute = path.join(root, citation.path);
      if (!fs.existsSync(absolute)) {
        issues.push(`entry ${entry.id} citation path does not exist: ${citation.path}`);
      }
    }
  }
  const totalTokenCost = pack.entries.reduce((sum, entry) => sum + entry.token_cost, 0);
  if (totalTokenCost > pack.token_budget) {
    issues.push(`total_token_cost ${totalTokenCost} exceeds token_budget ${pack.token_budget}`);
  }
  return { ok: issues.length === 0, issues };
}

export async function writeCodePackAtomic(root: string, pack: CodePack): Promise<{ ok: boolean; path: string; prev_path: string | null }> {
  const targetPath = codePackPath(root);
  const prevPath = codePackPrevPath(root);
  await ensureDir(codePackDir(root));
  let prevWritten: string | null = null;
  if (await exists(targetPath)) {
    const previous = await readJson<CodePack>(targetPath);
    await writeJsonAtomic(prevPath, previous);
    prevWritten = prevPath;
  }
  await writeJsonAtomic(targetPath, pack);
  return { ok: true, path: targetPath, prev_path: prevWritten };
}
