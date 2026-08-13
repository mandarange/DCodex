/**
 * Compiler-backed TypeScript/JavaScript code graph extractor.
 *
 * Replaces the regex + first-120-lines scanner: the AST is the source of truth
 * for declarations, `ts.resolveModuleName` is the source of truth for module
 * specifiers, and the whole pass is read-only, spawn-free, and deterministic —
 * three runs over identical bytes serialize identically.
 */
import fs from 'node:fs';
import path from 'node:path';
import type {
  ContextGraphExtractionInput,
  ContextGraphExtractor,
  ContextGraphFragment
} from '../../contracts.js';
import { emptyContextGraphFragment, lintWarning } from '../../contracts.js';
import { contextGraphNodeId } from '../../ids.js';
import { CodeGraphSink, riskFromFanIn } from './builders.js';
import { extractDeclarations, indexDeclaredNames, indexExports } from './declarations.js';
import { walkCodeInventory } from './inventory.js';
import type { ModuleGraphTables } from './module-graph.js';
import { buildImportAndReexportEdges, collectModuleFacts } from './module-graph.js';
import { buildModuleContainsEdges, buildModuleNodes, inferModuleBoundaries, moduleDirForPath } from './modules.js';
import { buildReferenceEdges } from './references.js';
import { selectExtractionTargets } from './selection.js';
import { extractTextDeclarations } from './text-declarations.js';
import type { SharedSourceInventory } from '../source-inventory.js';
import { createCodeSourceFile, createResolutionContext } from './ts-config.js';
import type { CodeInventory, CodeSourceFileRecord, DeclaredSymbol, ModuleFacts, ParsedCodeFile } from './types.js';
import { CODE_GRAPH_EXTRACTOR_ID, CODE_GRAPH_EXTRACTOR_REVISION, estimateTokenCost } from './types.js';

/** Unresolved first-party imports are worth reporting, but not thousands of them. */
const MAX_UNRESOLVED_WARNINGS = 100;

function realRoot(root: string): string {
  const absolute = path.resolve(root);
  try {
    // Module resolution returns realpath-ed file names; normalizing the root the
    // same way keeps `/tmp` style symlinked workspaces inside the workspace.
    return fs.realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function sortedHashes(hashes: ReadonlyMap<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of [...hashes.keys()].sort()) {
    const value = hashes.get(key);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

interface ParsePhase {
  parsedByRel: Map<string, ParsedCodeFile>;
  factsByRel: Map<string, ModuleFacts>;
  declarationsByRel: Map<string, DeclaredSymbol[]>;
  tables: ModuleGraphTables;
}

export class CodeGraphExtractor implements ContextGraphExtractor {
  readonly id = CODE_GRAPH_EXTRACTOR_ID;
  readonly revision = CODE_GRAPH_EXTRACTOR_REVISION;

  constructor(
    private readonly preparedInventory: CodeInventory | null = null,
    private readonly sourceInventory: SharedSourceInventory | null = null
  ) {}

  async extract(input: ContextGraphExtractionInput): Promise<ContextGraphFragment> {
    const startedAt = Date.now();
    const deadline = startedAt + Math.max(1, input.limits.timeoutMs);
    const root = realRoot(input.root);
    const sink = new CodeGraphSink(input.limits, input.observedAt);

    const inventory = this.preparedInventory
      ?? this.sourceInventory?.inventory(root, input.limits)
      ?? walkCodeInventory(root, input.limits);
    for (const skip of inventory.skipped) sink.addSkip(skip);

    const hashes = new Map<string, string>();
    for (const file of inventory.files) hashes.set(file.rel, file.hash);

    const context = createResolutionContext(root);
    if (context.configRel && context.configHash) hashes.set(context.configRel, context.configHash);

    const selection = selectExtractionTargets(context, inventory, input.changedPaths);
    for (const unknown of selection.unknownChanged) {
      sink.addIssue(
        lintWarning('extractor_skipped_input', 'changed path is not a scannable source file', {
          path: unknown,
          extractor: this.id
        })
      );
    }
    if (selection.unmappableChanged > 0) {
      sink.addIssue(
        lintWarning('extractor_skipped_input', `${selection.unmappableChanged} changed path(s) are outside the workspace`, {
          extractor: this.id
        })
      );
    }

    const phase = this.parseAndCollect(context, inventory, selection.targets, sink, deadline);
    for (const rel of selection.selectedRels) {
      const record = inventory.byRel.get(rel);
      if (!record || record.parser !== 'text') continue;
      phase.declarationsByRel.set(rel, extractTextDeclarations(record));
    }
    this.reportUnresolved(sink, phase.factsByRel);

    const fanIn = countFanIn(phase.factsByRel);
    const nodeRels = collectNodeRels(phase.factsByRel, phase.parsedByRel, inventory, selection.selectedRels);
    const scannedRels = new Set(selection.selectedRels);
    const fileNodeIdByRel = new Map<string, string>();
    const testNodeIdByRel = new Map<string, string>();
    this.buildFileNodes({ sink, inventory, nodeRels, scannedRels, fanIn, fileNodeIdByRel, testNodeIdByRel });
    this.buildSymbolNodes(sink, inventory, phase.declarationsByRel);

    const boundaries = inferModuleBoundaries([...fileNodeIdByRel.keys()].sort());
    buildModuleNodes(sink, boundaries);

    buildModuleContainsEdges(sink, boundaries, fileNodeIdByRel, inventory.byRel);
    this.buildContainmentEdges(sink, inventory, phase.declarationsByRel, fileNodeIdByRel, testNodeIdByRel);
    buildImportAndReexportEdges(sink, phase.tables, inventory.byRel, fileNodeIdByRel);
    buildReferenceEdges(sink, {
      tables: phase.tables,
      parsedByRel: phase.parsedByRel,
      byRel: inventory.byRel,
      fileNodeIdByRel,
      testNodeIdByRel
    });

    const result = sink.result();
    const fragment = emptyContextGraphFragment(this.id, this.revision);
    fragment.nodes = result.nodes;
    fragment.edges = result.edges;
    fragment.issues = result.issues;
    fragment.skipped = result.skipped;
    fragment.inputHashes = sortedHashes(hashes);
    return fragment;
  }

  private parseAndCollect(
    context: ReturnType<typeof createResolutionContext>,
    inventory: ReturnType<typeof walkCodeInventory>,
    targets: readonly CodeSourceFileRecord[],
    sink: CodeGraphSink,
    deadline: number
  ): ParsePhase {
    const parsedByRel = new Map<string, ParsedCodeFile>();
    const factsByRel = new Map<string, ModuleFacts>();
    const declarationsByRel = new Map<string, DeclaredSymbol[]>();
    const exportsByRel = new Map<string, Map<string, DeclaredSymbol>>();
    const declaredByRel = new Map<string, Map<string, DeclaredSymbol>>();
    const isKnownFile = (rel: string): boolean => inventory.byRel.has(rel);

    for (const record of targets) {
      if (Date.now() >= deadline) {
        sink.addSkip({ path: record.rel, reason: 'cap_reached', detail: 'timeoutMs exceeded before parse' });
        break;
      }
      const parsed: ParsedCodeFile = { record, sourceFile: createCodeSourceFile(context, record) };
      parsedByRel.set(record.rel, parsed);
      const facts = collectModuleFacts(context, parsed, isKnownFile);
      factsByRel.set(record.rel, facts);
      for (const skip of facts.skips) sink.addSkip(skip);
      const declarations = extractDeclarations(parsed.sourceFile, record.rel);
      declarationsByRel.set(record.rel, declarations);
      exportsByRel.set(record.rel, indexExports(declarations));
      declaredByRel.set(record.rel, indexDeclaredNames(declarations));
    }

    return { parsedByRel, factsByRel, declarationsByRel, tables: { factsByRel, exportsByRel, declaredByRel } };
  }

  private reportUnresolved(sink: CodeGraphSink, factsByRel: ReadonlyMap<string, ModuleFacts>): void {
    let reported = 0;
    for (const [rel, facts] of factsByRel) {
      for (const entry of facts.unresolved) {
        if (reported >= MAX_UNRESOLVED_WARNINGS) return;
        reported += 1;
        sink.addIssue(
          lintWarning('extractor_skipped_input', `unresolved first-party import '${entry.specifier}'`, {
            path: rel,
            extractor: this.id
          })
        );
      }
    }
  }

  private buildFileNodes(args: {
    sink: CodeGraphSink;
    inventory: ReturnType<typeof walkCodeInventory>;
    nodeRels: string[];
    scannedRels: ReadonlySet<string>;
    fanIn: ReadonlyMap<string, number>;
    fileNodeIdByRel: Map<string, string>;
    testNodeIdByRel: Map<string, string>;
  }): void {
    for (const rel of args.nodeRels) {
      const record = args.inventory.byRel.get(rel);
      if (!record) continue;
      const scanned = args.scannedRels.has(rel);
      const id = contextGraphNodeId({ kind: 'file', path: rel });
      const added = args.sink.addNode(
        {
          id,
          kind: 'file',
          label: path.posix.basename(rel),
          path: rel,
          contentHash: record.hash,
          trust: 1,
          risk: riskFromFanIn(args.fanIn.get(rel) ?? 0, record.isTest),
          tokenCost: estimateTokenCost(record.bytes),
          metadata: {
            extension: record.extension,
            language: record.language,
            lines: record.lines,
            bytes: record.bytes,
            isTest: record.isTest,
            fanIn: args.fanIn.get(rel) ?? 0,
            scanned,
            ...(record.purpose ? { purpose: record.purpose } : {})
          }
        },
        rel
      );
      if (!added) continue;
      args.fileNodeIdByRel.set(rel, id);
      if (!record.isTest || !scanned) continue;
      const testId = contextGraphNodeId({ kind: 'test', path: rel });
      if (args.sink.addNode(
        {
          id: testId,
          kind: 'test',
          label: path.posix.basename(rel),
          path: rel,
          contentHash: record.hash,
          trust: 1,
          risk: 'low',
          tokenCost: estimateTokenCost(record.bytes),
          metadata: { lines: record.lines, bytes: record.bytes, suite: 'file' }
        },
        rel
      )) {
        args.testNodeIdByRel.set(rel, testId);
      }
    }
  }

  private buildSymbolNodes(
    sink: CodeGraphSink,
    inventory: ReturnType<typeof walkCodeInventory>,
    declarationsByRel: ReadonlyMap<string, DeclaredSymbol[]>
  ): void {
    for (const rel of [...declarationsByRel.keys()].sort()) {
      const record = inventory.byRel.get(rel);
      const declarations = declarationsByRel.get(rel);
      if (!record || !declarations) continue;
      const moduleDir = moduleDirForPath(rel);
      for (const symbol of declarations) {
        sink.addNode(
          {
            id: symbol.nodeId,
            kind: 'symbol',
            label: symbol.name,
            path: rel,
            contentHash: record.hash,
            locator: { line: symbol.line, column: symbol.column, endLine: symbol.endLine, endColumn: symbol.endColumn },
            trust: record.parser === 'text' ? 0.85 : 1,
            risk: 'low',
            tokenCost: symbol.tokenCost,
            metadata: {
              symbolKind: symbol.symbolKind,
              exported: symbol.exported,
              default: symbol.isDefault,
              exportNames: symbol.exportNames,
              module: moduleDir
            }
          },
          rel
        );
      }
    }
  }

  private buildContainmentEdges(
    sink: CodeGraphSink,
    inventory: ReturnType<typeof walkCodeInventory>,
    declarationsByRel: ReadonlyMap<string, DeclaredSymbol[]>,
    fileNodeIdByRel: ReadonlyMap<string, string>,
    testNodeIdByRel: ReadonlyMap<string, string>
  ): void {
    for (const rel of [...declarationsByRel.keys()].sort()) {
      const record = inventory.byRel.get(rel);
      const from = fileNodeIdByRel.get(rel);
      const declarations = declarationsByRel.get(rel);
      if (!record || !from || !declarations) continue;
      const testNodeId = testNodeIdByRel.get(rel);
      if (testNodeId) {
        sink.addEdge({ from, to: testNodeId, type: 'contains', confidence: 'exact', path: rel, hash: record.hash });
      }
      for (const symbol of declarations) {
        sink.addEdge({
          from,
          to: symbol.nodeId,
          type: 'contains',
          confidence: record.parser === 'text' ? 'syntactic' : 'exact',
          path: rel,
          hash: record.hash,
          line: symbol.line
        });
        if (!symbol.exported) continue;
        sink.addEdge({
          from,
          to: symbol.nodeId,
          type: 'defines',
          confidence: record.parser === 'text' ? 'syntactic' : 'exact',
          path: rel,
          hash: record.hash,
          line: symbol.line
        });
      }
    }
  }
}

function countFanIn(factsByRel: ReadonlyMap<string, ModuleFacts>): Map<string, number> {
  const fanIn = new Map<string, number>();
  for (const facts of factsByRel.values()) {
    for (const entry of facts.imports) fanIn.set(entry.targetRel, (fanIn.get(entry.targetRel) ?? 0) + 1);
  }
  return fanIn;
}

/**
 * Files that need a `file` node: everything parsed, plus in-workspace import and
 * re-export targets that this run did not parse. Emitting the target keeps every
 * observed relation attached to a real, hashed file instead of dropping it.
 */
function collectNodeRels(
  factsByRel: ReadonlyMap<string, ModuleFacts>,
  parsedByRel: ReadonlyMap<string, ParsedCodeFile>,
  inventory: ReturnType<typeof walkCodeInventory>,
  selectedRels: readonly string[]
): string[] {
  const rels = new Set<string>([...parsedByRel.keys(), ...selectedRels]);
  for (const facts of factsByRel.values()) {
    for (const entry of facts.imports) if (inventory.byRel.has(entry.targetRel)) rels.add(entry.targetRel);
    for (const record of facts.reexports) if (inventory.byRel.has(record.targetRel)) rels.add(record.targetRel);
  }
  return [...rels].sort();
}

export function createCodeGraphExtractor(
  options: { preparedInventory?: CodeInventory; sourceInventory?: SharedSourceInventory } = {}
): ContextGraphExtractor {
  return new CodeGraphExtractor(options.preparedInventory ?? null, options.sourceInventory ?? null);
}

export { CODE_GRAPH_EXTRACTOR_ID, CODE_GRAPH_EXTRACTOR_REVISION } from './types.js';
