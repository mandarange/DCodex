import { search } from '../search/index.js';
import { SEARCH_SCHEMA_VERSION } from '../search/types.js';

export interface ImpactSymbol {
  name: string;
  file: string;
  kind: 'export' | 'local';
}

export interface ImpactReference {
  symbol: string;
  file: string;
  line: number;
  text: string;
  confidence?: 'exact_definition' | 'exact_reference' | 'syntactic_reference' | 'text_candidate' | 'structure_match';
}

export interface ImpactReport {
  schema: 'sks.impact-scan.v1';
  changed_symbols: ImpactSymbol[];
  references: ImpactReference[];
  cochange_required: string[];
  /** Engine used for reference discovery. Never claims text hits are exact references. */
  tool: 'search-provider' | 'search-provider-js';
}

const DECL_RE = /^\s*export\s+(?:async\s+)?(?:function|const|class|interface|type)\s+([A-Za-z_$][\w$]*)\b/;

export async function scanImpact(root: string, changedFiles: string[], patchText: string): Promise<ImpactReport> {
  const symbols = extractChangedExportedSymbols(patchText, changedFiles);
  const references: ImpactReference[] = [];
  let tool: ImpactReport['tool'] = 'search-provider-js';
  for (const sym of symbols) {
    const found = await findReferences(root, sym.name, { excludeFile: sym.file });
    if (found.provider === 'sks-rs') tool = 'search-provider';
    references.push(...found.refs);
  }
  const patchFiles = new Set(changedFiles.map(normalizePath));
  const cochange = [...new Set(references.map((ref) => ref.file))]
    .filter((file) => !patchFiles.has(normalizePath(file)));
  return {
    schema: 'sks.impact-scan.v1',
    changed_symbols: symbols,
    references,
    cochange_required: cochange,
    tool
  };
}

export function extractChangedExportedSymbols(patchText: string, changedFiles: string[]): ImpactSymbol[] {
  const symbols: ImpactSymbol[] = [];
  let currentFile = normalizePath(changedFiles[0] || '');
  for (const rawLine of String(patchText || '').split(/\r?\n/)) {
    if (rawLine.startsWith('+++ b/')) {
      currentFile = normalizePath(rawLine.slice('+++ b/'.length));
      continue;
    }
    if (rawLine.startsWith('--- ') || !rawLine.startsWith('-')) continue;
    const line = rawLine.slice(1);
    const match = line.match(DECL_RE);
    if (!match?.[1]) continue;
    symbols.push({ name: match[1], file: currentFile, kind: 'export' });
  }
  return dedupeSymbols(symbols);
}

/** @deprecated Prefer SearchProvider; retained for tests that inspect tool selection. */
export async function pickScanTool(): Promise<ImpactReport['tool']> {
  return 'search-provider-js';
}

export async function findReferences(
  root: string,
  symbol: string,
  opts: { excludeFile?: string } = {}
): Promise<{ refs: ImpactReference[]; provider: string }> {
  const normalizedExclude = normalizePath(opts.excludeFile || '');
  if (!symbol || !/^[A-Za-z_$][\w$]*$/.test(symbol)) return { refs: [], provider: 'none' };

  const symbolResp = await search({
    schemaVersion: SEARCH_SCHEMA_VERSION,
    mode: 'symbol',
    root,
    query: symbol,
    include: ['**/*.{ts,tsx,js,jsx,mjs,cjs,json,md}'],
    exclude: ['node_modules/**', 'dist/**', '.git/**'],
    limits: { maxMatches: 500, timeoutMs: 15_000 }
  });

  const refs: ImpactReference[] = [];
  for (const m of symbolResp.matches) {
    const file = normalizePath(m.path);
    if (!file || file === normalizedExclude || shouldIgnorePath(file)) continue;
    // Preserve LanguageService-backed exact_* confidence; never promote text to exact.
    const confidence = m.confidence;
    if (
      confidence !== 'exact_definition' &&
      confidence !== 'exact_reference' &&
      confidence !== 'syntactic_reference' &&
      confidence !== 'text_candidate' &&
      confidence !== 'structure_match'
    ) {
      continue;
    }
    refs.push({
      symbol,
      file,
      line: m.line || 1,
      text: String(m.text || '').trim().slice(0, 240),
      confidence
    });
  }
  return { refs: capReferences(refs), provider: symbolResp.provider };
}

function capReferences(refs: ImpactReference[]): ImpactReference[] {
  const perFile = new Map<string, number>();
  const out: ImpactReference[] = [];
  for (const ref of refs) {
    const key = `${ref.symbol}:${ref.file}`;
    const count = perFile.get(key) || 0;
    if (count >= 50) continue;
    perFile.set(key, count + 1);
    out.push(ref);
  }
  return out.slice(0, 500);
}

function dedupeSymbols(symbols: ImpactSymbol[]): ImpactSymbol[] {
  const seen = new Set<string>();
  return symbols.filter((sym) => {
    const key = `${sym.file}:${sym.name}:${sym.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function shouldIgnorePath(file: string): boolean {
  return file.startsWith('node_modules/') || file.startsWith('.git/') || file.startsWith('dist/');
}

function normalizePath(value: string): string {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
}
