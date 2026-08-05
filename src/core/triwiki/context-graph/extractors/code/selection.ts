/**
 * Which files an extraction actually parses.
 *
 * A full run parses the whole inventory. An incremental run parses the changed
 * files plus everything that transitively imports them (the reverse-dependency
 * closure), plus one hop of their own dependencies — without that hop the
 * closure has no symbol table to point `references`/`calls` edges at, and the
 * extractor would have to downgrade exact relations to guesses.
 */
import ts from 'typescript';
import { tryNormalizeGraphPath } from '../../paths.js';
import type { CodeResolutionContext } from './ts-config.js';
import { resolveSpecifier } from './ts-config.js';
import type { CodeInventory, CodeSourceFileRecord } from './types.js';

export interface ExtractionSelection {
  /** files to parse, sorted by path */
  targets: CodeSourceFileRecord[];
  /** every source file read for this extraction, including text-parsed languages */
  selectedRels: string[];
  /** `true` when the whole inventory is being extracted */
  full: boolean;
  /** normalized changed paths that are not scannable source files in this workspace */
  unknownChanged: string[];
  /** changed paths that could not be normalized to a workspace-relative path */
  unmappableChanged: number;
}

function impliedFormat(context: CodeResolutionContext, record: CodeSourceFileRecord): ts.ResolutionMode {
  try {
    return ts.getImpliedNodeFormatForFile(record.abs, context.cache.getPackageJsonInfoCache(), context.host, context.options);
  } catch {
    return undefined;
  }
}

/**
 * Cheap forward-dependency map over the whole inventory.
 *
 * `ts.preProcessFile` is the compiler's own scanner-level preprocessor, used
 * here only to decide *which* files to parse; every edge that reaches the graph
 * still comes from a real AST and a real `ts.resolveModuleName` call.
 */
function buildForwardDependencies(
  context: CodeResolutionContext,
  inventory: CodeInventory
): Map<string, string[]> {
  const forward = new Map<string, string[]>();
  for (const record of inventory.files) {
    if (record.parser !== 'typescript') {
      forward.set(record.rel, []);
      continue;
    }
    const mode = impliedFormat(context, record);
    const targets = new Set<string>();
    let preprocessed: ts.PreProcessedFileInfo;
    try {
      preprocessed = ts.preProcessFile(record.text, true, true);
    } catch {
      forward.set(record.rel, []);
      continue;
    }
    for (const reference of preprocessed.importedFiles) {
      const resolved = resolveSpecifier(context, reference.fileName, record.abs, mode);
      if (!resolved) continue;
      const rel = tryNormalizeGraphPath(context.root, resolved.fileName);
      if (rel === null || !inventory.byRel.has(rel)) continue;
      targets.add(rel);
    }
    forward.set(record.rel, [...targets].sort());
  }
  return forward;
}

function invert(forward: ReadonlyMap<string, string[]>): Map<string, string[]> {
  const reverse = new Map<string, string[]>();
  for (const [from, targets] of forward) {
    for (const target of targets) {
      const bucket = reverse.get(target);
      if (bucket) bucket.push(from);
      else reverse.set(target, [from]);
    }
  }
  for (const [, importers] of reverse) importers.sort();
  return reverse;
}

/** Decide the parse set for this extraction. */
export function selectExtractionTargets(
  context: CodeResolutionContext,
  inventory: CodeInventory,
  changedPaths: readonly string[] | null
): ExtractionSelection {
  if (changedPaths === null) {
    return {
      targets: inventory.files.filter((record) => record.parser === 'typescript'),
      selectedRels: inventory.files.map((record) => record.rel),
      full: true,
      unknownChanged: [],
      unmappableChanged: 0
    };
  }

  const seeds: string[] = [];
  const unknownChanged: string[] = [];
  let unmappableChanged = 0;
  for (const candidate of changedPaths) {
    const rel = tryNormalizeGraphPath(context.root, candidate);
    if (rel === null) {
      unmappableChanged += 1;
      continue;
    }
    if (inventory.byRel.has(rel)) seeds.push(rel);
    else unknownChanged.push(rel);
  }

  const forward = buildForwardDependencies(context, inventory);
  const reverse = invert(forward);

  const closure = new Set<string>();
  const queue = [...new Set(seeds)].sort();
  for (const seed of queue) closure.add(seed);
  while (queue.length) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const importer of reverse.get(current) ?? []) {
      if (closure.has(importer)) continue;
      closure.add(importer);
      queue.push(importer);
    }
  }

  const selected = new Set<string>(closure);
  for (const rel of closure) {
    for (const dependency of forward.get(rel) ?? []) selected.add(dependency);
  }

  const selectedRels = inventory.files.filter((record) => selected.has(record.rel)).map((record) => record.rel);
  const targets = inventory.files.filter((record) => selected.has(record.rel) && record.parser === 'typescript');
  return {
    targets,
    selectedRels,
    full: false,
    unknownChanged: [...new Set(unknownChanged)].sort(),
    unmappableChanged
  };
}
