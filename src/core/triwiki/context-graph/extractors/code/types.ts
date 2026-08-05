/**
 * Internal vocabulary shared by the TypeScript/JavaScript code graph extractor.
 *
 * Nothing here is part of the frozen Context Graph contract; the contract lives
 * in `../../contracts.ts` and is imported, never redefined.
 */
import type ts from 'typescript';

/** Extractor identity written into every edge provenance record. */
export const CODE_GRAPH_EXTRACTOR_ID = 'code';
export const CODE_GRAPH_EXTRACTOR_REVISION = '2.0.0';

/** Bound on how far a `export ... from` barrel chain is followed before giving up. */
export const MAX_REEXPORT_DEPTH = 8;

/** Declaration flavours the extractor is willing to promote to a `symbol` node. */
export const CODE_SYMBOL_KINDS = [
  'function',
  'class',
  'interface',
  'type',
  'enum',
  'namespace',
  'const',
  'let',
  'var',
  'default',
  'struct',
  'protocol',
  'trait',
  'actor',
  'extension',
  'module',
  'method',
  'procedure',
  'table',
  'view'
] as const;

export type CodeSymbolKind = (typeof CODE_SYMBOL_KINDS)[number];

export type CodeLanguage =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'ruby'
  | 'go'
  | 'rust'
  | 'java'
  | 'kotlin'
  | 'swift'
  | 'php'
  | 'c'
  | 'cpp'
  | 'csharp'
  | 'scala'
  | 'shell'
  | 'vue'
  | 'svelte'
  | 'dart'
  | 'objective-c'
  | 'perl'
  | 'lua'
  | 'elixir'
  | 'clojure'
  | 'haskell'
  | 'ocaml'
  | 'julia'
  | 'sql'
  | 'r';

/** A source file the walker accepted, together with the bytes it hashed. */
export interface CodeSourceFileRecord {
  /** workspace-relative POSIX path — the only path shape allowed in an artifact */
  rel: string;
  /** absolute on-disk path; used for module resolution only, never serialized */
  abs: string;
  /** sha256 of the raw bytes */
  hash: string;
  text: string;
  bytes: number;
  lines: number;
  isTest: boolean;
  extension: string;
  language: CodeLanguage;
  parser: 'typescript' | 'text';
  /** Leading source comment/docstring only; never inferred from docs or memory. */
  purpose: string | null;
}

export interface CodeInventory {
  /** sorted by `rel` so every downstream pass is order-stable */
  files: CodeSourceFileRecord[];
  byRel: Map<string, CodeSourceFileRecord>;
  skipped: CodeInventorySkip[];
}

/** Structurally a `ContextGraphSkip`; kept local so inventory.ts does not depend on edge building. */
export interface CodeInventorySkip {
  path: string;
  reason:
    | 'binary'
    | 'oversized'
    | 'unsupported_language'
    | 'symlink_escape'
    | 'unreadable'
    | 'generated'
    | 'cap_reached'
    | 'excluded';
  detail?: string;
}

export interface ParsedCodeFile {
  record: CodeSourceFileRecord;
  sourceFile: ts.SourceFile;
}

/** One top-level declaration promoted to a `symbol` node. */
export interface DeclaredSymbol {
  nodeId: string;
  name: string;
  symbolKind: CodeSymbolKind;
  startOffset: number;
  endOffset: number;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  exported: boolean;
  isDefault: boolean;
  /** names this declaration is importable under; empty when it is module-private */
  exportNames: string[];
  tokenCost: number;
}

/** A single imported binding in the importing file. */
export interface ImportBinding {
  local: string;
  /** export name in the target module; `*` for a namespace import, `default` for a default import */
  exportName: string;
  specifier: string;
  /** workspace-relative target, or `null` when the specifier did not resolve inside the workspace */
  targetRel: string | null;
  line: number;
}

export interface ReexportName {
  /** name this module publishes */
  exportName: string;
  /** name looked up in the target module */
  sourceName: string;
}

export interface ReexportRecord {
  targetRel: string;
  line: number;
  /** `true` for `export * from '...'`, in which case `names` is empty */
  star: boolean;
  names: ReexportName[];
}

/** Everything the module graph pass needs from one parsed file. */
export interface ModuleFacts {
  rel: string;
  /** resolved workspace-relative import targets, first observation wins */
  imports: Array<{ targetRel: string; line: number }>;
  reexports: ReexportRecord[];
  bindings: ImportBinding[];
  skips: CodeInventorySkip[];
  /** first-party specifiers the compiler could not resolve; surfaced as warnings, never as edges */
  unresolved: Array<{ specifier: string; line: number }>;
}

/** Rough token estimate; four characters per token is close enough for budgeting. */
export function estimateTokenCost(length: number): number {
  return Math.max(1, Math.ceil(Math.max(0, length) / 4));
}
