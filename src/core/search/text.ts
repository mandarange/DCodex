import fsp from 'node:fs/promises';
import path from 'node:path';
import { searchFilesJs } from './files.js';
import {
  compareMatches,
  defaultSearchLimits,
  emptySkipped,
  SEARCH_PROVIDER_SCHEMA,
  SEARCH_SCHEMA_VERSION,
  type SearchMatch,
  type SearchRequest,
  type SearchResponse
} from './types.js';

const BINARY_HINT = /\0/;
const TEXT_EXT_RE = /\.(?:[cm]?[jt]sx?|json|md|css|scss|html|yml|yaml|toml|rs|py|txt|sh|bash|zsh|c|h|cpp|go|java|kt|swift|rb|php|sql|xml|svg)?$/i;

export async function searchTextJs(req: SearchRequest): Promise<SearchResponse> {
  const started = Date.now();
  const limits = defaultSearchLimits(req.limits);
  const root = path.resolve(req.root);
  const pattern = req.pattern || req.query || '';
  if (!pattern) {
    return errorResponse(req, limits, started, ['missing_pattern'], 0);
  }

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, req.caseSensitive === false ? 'gi' : 'g');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(req, limits, started, [`invalid_regex:${message}`], 0);
  }

  const filesResp = await searchFilesJs({
    ...req,
    mode: 'files',
    query: '',
    pattern: '',
    limits: { ...limits, maxMatches: limits.maxFiles }
  });

  const matches: SearchMatch[] = [];
  const skipped = emptySkipped();
  let scannedBytes = 0;
  let truncated = false;
  let timeout = false;
  const deadline = started + limits.timeoutMs;

  for (const fileMatch of filesResp.matches) {
    if (Date.now() > deadline) {
      timeout = true;
      truncated = true;
      break;
    }
    if (matches.length >= limits.maxMatches) {
      truncated = true;
      break;
    }
    const rel = fileMatch.path;
    if (!TEXT_EXT_RE.test(rel) && path.extname(rel)) {
      // still allow extensionless; skip known binary-ish by null byte check below
    }
    const abs = path.join(root, rel);
    let buf: Buffer;
    try {
      buf = await fsp.readFile(abs);
    } catch {
      skipped.files += 1;
      skipped.reasons.read = (skipped.reasons.read || 0) + 1;
      continue;
    }
    if (buf.length > limits.maxBytes) {
      skipped.files += 1;
      skipped.reasons.too_large = (skipped.reasons.too_large || 0) + 1;
      continue;
    }
    if (BINARY_HINT.test(buf.subarray(0, Math.min(buf.length, 8192)).toString('binary'))) {
      skipped.files += 1;
      skipped.reasons.binary = (skipped.reasons.binary || 0) + 1;
      continue;
    }
    scannedBytes += buf.length;
    let text: string;
    try {
      text = buf.toString('utf8');
    } catch {
      skipped.files += 1;
      skipped.reasons.utf8 = (skipped.reasons.utf8 || 0) + 1;
      continue;
    }
    const lines = text.split(/\r?\n/);
    let perFile = 0;
    for (let i = 0; i < lines.length && perFile < 50; i += 1) {
      if (matches.length >= limits.maxMatches) {
        truncated = true;
        break;
      }
      const line = lines[i] || '';
      regex.lastIndex = 0;
      const m = regex.exec(line);
      if (!m) continue;
      matches.push({
        path: rel,
        line: i + 1,
        column: (m.index || 0) + 1,
        text: line.slice(0, 240),
        confidence: 'text_candidate'
      });
      perFile += 1;
    }
  }

  matches.sort(compareMatches);
  return {
    schemaVersion: SEARCH_SCHEMA_VERSION,
    schema: SEARCH_PROVIDER_SCHEMA,
    ok: true,
    mode: 'text',
    provider: 'js',
    engine: 'js-regex-scanner',
    matches,
    confidence: 'text_candidate',
    truncated: truncated || filesResp.truncated,
    timeout,
    limits,
    scanned: { files: filesResp.scanned.files, bytes: scannedBytes },
    skipped,
    cacheHit: false,
    warnings: filesResp.warnings,
    errors: [],
    durationMs: Date.now() - started,
    processSpawns: filesResp.processSpawns,
    deterministicOrder: 'path_line_column'
  };
}

function errorResponse(
  req: SearchRequest,
  limits: ReturnType<typeof defaultSearchLimits>,
  started: number,
  errors: string[],
  spawns: number
): SearchResponse {
  return {
    schemaVersion: SEARCH_SCHEMA_VERSION,
    schema: SEARCH_PROVIDER_SCHEMA,
    ok: false,
    mode: 'text',
    provider: 'js',
    engine: 'js-regex-scanner',
    matches: [],
    confidence: 'text_candidate',
    truncated: false,
    timeout: false,
    limits,
    scanned: { files: 0, bytes: 0 },
    skipped: emptySkipped(),
    cacheHit: false,
    warnings: [],
    errors,
    durationMs: Date.now() - started,
    processSpawns: spawns,
    deterministicOrder: 'path_line_column'
  };
}
