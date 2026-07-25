import path from 'node:path';
import fsp from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { nowIso, sha256, writeJsonAtomic } from './fsx.js';
import {
  LEAN_CHANGE_EVIDENCE_SCHEMA,
  type LeanFinding,
  type LeanSimplificationMarker,
  assessTestVolume,
  leanPolicyReference,
  parseLeanSimplificationMarkerLine
} from './lean-engineering-policy.js';

export const CODE_STRUCTURE_THRESHOLDS = {
  warning: 1000,
  review: 2000,
  split_required_review: 3000
};

const DEFAULT_INCLUDE = new Set(['.js', '.ts', '.tsx', '.jsx', '.cjs', '.mjs']);
const SKIP_DIRS = new Set(['.git', 'node_modules', '.sneakoscope', 'dist', 'build', 'coverage']);
const SOURCE_DIR_RE = /^(src|test|tests|schemas|scripts|crates|docs)\//;
const SOURCE_EXT_RE = /\.(js|ts|tsx|jsx|cjs|mjs|json|md|rs|toml)$/;
const FALLBACK_RE = /\b(fallback|legacy|shim|compat|mock|catch-all|catch all|default provider)\b/i;
const CONFIG_FLAG_RE = /\b(process\.env|SKS_[A-Z0-9_]+|CODEX_[A-Z0-9_]+|[A-Z][A-Z0-9_]{5,})\b/;
const ABSTRACTION_RE = /\b(interface|abstract class|class|factory|provider|adapter|registry|orchestrator|manager)\b/;
const N_PLUS_ONE_RE = /(?:(?:for\s*(?:await\s*)?\([^)]*\)|for\s+(?:await\s+)?(?:const|let|var)\s+\w+\s+of\s+[^{]+|\.forEach\s*\(\s*async\b|\.map\s*\(\s*async\b))[\s\S]{0,1200}\bawait\s+[\w.$]*(?:query|execute|findMany|findUnique|findFirst|select|insert|update|delete|save)\s*\(/i;
const UNBOUNDED_LOOP_RE = /\bwhile\s*\(\s*true\s*\)|\bfor\s*\(\s*;\s*;\s*\)/i;
const RENDER_LOOP_RE = /\buseEffect\s*\(\s*\(\s*\)\s*=>\s*\{[\s\S]{0,1200}\bset[A-Z]\w*\s*\([^)]*\)[\s\S]{0,400}\}\s*\)\s*;?/i;
const VERIFICATION_BYPASS_RE = /\b(?:test|it|describe)\.(?:skip|only)\s*\(|\b(?:xit|xdescribe)\s*\(|@ts-ignore\b|eslint-disable(?:-next-line)?\b|\.catch\s*\(\s*\(\s*\)\s*=>\s*(?:undefined|\{\s*\})\s*\)|catch\s*\([^)]*\)\s*\{\s*\}/i;
const DB_POOL_CONSTRUCTOR_RE = /\bnew\s+(?:Pool|PrismaClient|DataSource|Sequelize)\s*\(|\bcreatePool\s*\(|\bknex\s*\(/i;
const SENSITIVE_DOMAIN_RE = /\b(payment|billing|invoice|charge|refund|ledger|balance|payout|settlement|wallet)\b|결제|청구|환불|원장|잔액|정산/i;
const DB_WRITE_CALL_RE = /\b(?:insert|update|delete|upsert|save|create|execute|query)\s*\(/gi;
const TRANSACTION_MARKER_RE = /\b(?:transaction|withTransaction|atomic|begin|commit|rollback|savepoint|\$transaction)\b/i;
const ENGINEERING_SANITY_TAGS = new Set([
  'solid',
  'n-plus-one',
  'unbounded-loop',
  'verification-bypass',
  'db-pool',
  'transaction'
]);

export async function scanCodeStructure(root: any, opts: any = {}) {
  const changedScope = await collectChangedScope(root, opts);
  const addedHunkScopes = await collectAddedHunkScopes(root, changedScope);
  const files = await resolveScanFiles(root, opts, changedScope);
  const touched = new Set((opts.touchedFiles || []).map((file: any) => normalizeRel(root, file)));
  const changedSet = new Set((changedScope.source_files || []).map((file: string) => normalizeSlashes(file)));
  const entries: any[] = [];
  const intentionalSimplifications: LeanSimplificationMarker[] = [];

  for (const file of files) {
    const rel = normalizeRel(root, file);
    const text = await fsp.readFile(file, 'utf8').catch(() => '');
    const lineCount = text ? text.split(/\n/).length : 0;
    const status = structureStatus(lineCount);
    const changedByDiff = changedSet.has(rel);
    if (status === 'ok' && !opts.includeOk && !changedByDiff) continue;
    const addedScope = addedHunkScopes.get(rel);
    const signals = analyzeTextSignals(rel, text, changedByDiff, addedScope || {
      scope: changedByDiff ? 'changed_file_without_added_hunks' : 'full_file_advisory',
      text: changedByDiff ? '' : text,
      line_ranges: []
    });
    intentionalSimplifications.push(...signals.lean_markers);
    entries.push({
      path: rel,
      line_count: lineCount,
      status,
      generated_or_vendor: isGeneratedOrVendor(rel),
      touched_by_mission: touched.size ? touched.has(rel) : changedByDiff,
      recommended_action: recommendedAction(rel, lineCount),
      exception: lineCount >= CODE_STRUCTURE_THRESHOLDS.split_required_review && !isGeneratedOrVendor(rel)
        ? {
            file: rel,
            line_count: lineCount,
            why_not_split_now: opts.exception || 'No split was performed in this scan-only gate.',
            risk: lineCount >= 4000 ? 'high' : 'medium',
            next_split_candidate: nextSplitCandidate(rel),
            temporary_until: 'next substantial edit to this file'
          }
        : null,
      lean_signals: signals
    });
  }

  const dependencyDelta = await collectDependencyDelta(root, changedScope.base);
  const fallbackSites = await collectAddedFallbackSites(root, changedScope);
  const runnableChecks = collectRunnableChecks(changedScope);
  const semanticReview = buildSemanticReview({
    entries,
    changedScope,
    dependencyDelta,
    fallbackSites,
    intentionalSimplifications,
    runnableChecks
  });
  const leanChangeEvidence = buildLeanChangeEvidence({
    changedScope,
    dependencyDelta,
    fallbackSites,
    intentionalSimplifications,
    runnableChecks,
    semanticReview
  });

  return {
    schema_version: 1,
    mission_id: opts.missionId || null,
    scanned_at: nowIso(),
    thresholds: CODE_STRUCTURE_THRESHOLDS,
    files: entries.sort((a: any, b: any) => b.line_count - a.line_count),
    changed_scope: changedScope,
    dependencies_added: dependencyDelta.added,
    dependencies_removed: dependencyDelta.removed,
    fallback_sites_added: fallbackSites,
    intentional_simplifications: intentionalSimplifications,
    runnable_checks: runnableChecks,
    semantic_review: semanticReview,
    lean_change_evidence: leanChangeEvidence,
    actions_taken: opts.actions_taken || [],
    remaining_risks: entries.filter((entry: any) => entry.exception).map((entry: any) => `${entry.path}: ${entry.status}`)
  };
}

export async function writeCodeStructureReport(root: any, dir: any, opts: any = {}) {
  const report = await scanCodeStructure(root, opts);
  await writeJsonAtomic(path.join(dir, 'code-structure-report.json'), report);
  return report;
}

export function leanChangeEvidenceFromReport(report: any) {
  if (report?.lean_change_evidence) return report.lean_change_evidence;
  return buildLeanChangeEvidence({
    changedScope: report?.changed_scope || emptyChangedScope('unknown', 'HEAD'),
    dependencyDelta: {
      added: report?.dependencies_added || [],
      removed: report?.dependencies_removed || []
    },
    fallbackSites: report?.fallback_sites_added || [],
    intentionalSimplifications: report?.intentional_simplifications || [],
    runnableChecks: report?.runnable_checks || [],
    semanticReview: report?.semantic_review || { status: 'needs-review', findings: [] }
  });
}

async function resolveScanFiles(root: string, opts: any, changedScope: any) {
  if (opts.files?.length) return opts.files.map((file: any) => path.resolve(root, file));
  const changedSourceFiles = (changedScope.source_files || [])
    .filter((file: string) => DEFAULT_INCLUDE.has(path.extname(file)))
    .map((file: string) => path.resolve(root, file));
  // A caller that asked for a changed scope gets exactly that scope, even when
  // it is empty. Falling back to the whole tree turned "nothing changed" — the
  // normal state when a route is prepared, before any edit — into a full-repo
  // deep scan, which stalls the UserPromptSubmit hook that seeds the
  // engineering-sanity review. Only a caller that asked for no scope at all
  // (`sks code-structure scan` without --changed, the wiki sweep) scans it all.
  if (opts.changed || opts.changedSince || opts.changedFiles?.length) return changedSourceFiles;
  return listSourceFiles(root);
}

async function collectChangedScope(root: string, opts: any) {
  if (opts.changedFiles?.length) {
    const changedFiles: string[] = Array.from(new Set<string>(opts.changedFiles.map((file: string) => normalizeRel(root, file))));
    const entries = [];
    for (const file of changedFiles) {
      const text = await fsp.readFile(path.join(root, file), 'utf8').catch(() => '');
      entries.push({ path: file, status: 'M', lines_added: 0, lines_deleted: 0, source_sha256: isSourceLike(file) ? sha256(text) : null });
    }
    return {
      ...emptyChangedScope('explicit', opts.changedSince || 'HEAD'),
      changed_files: changedFiles,
      source_files: changedFiles.filter(isSourceLike),
      entries
    };
  }

  const shouldCollect = opts.changed || opts.changedSince;
  if (!shouldCollect) return emptyChangedScope('full', opts.changedSince || 'HEAD');
  const base = String(opts.changedSince || (typeof opts.changed === 'string' ? opts.changed : 'HEAD'));
  const numstat = gitLines(root, ['diff', '--numstat', base, '--']);
  const nameStatus = gitLines(root, ['diff', '--name-status', base, '--']);
  const untracked = gitLines(root, ['ls-files', '--others', '--exclude-standard']);
  const entriesByPath = new Map<string, any>();

  for (const line of numstat) {
    const parts = line.split(/\t/);
    if (parts.length < 3) continue;
    const linesAdded = parseNumstat(parts[0] || '0');
    const linesDeleted = parseNumstat(parts[1] || '0');
    const rel = normalizeSlashes(parts.slice(2).join('\t'));
    entriesByPath.set(rel, {
      path: rel,
      status: 'M',
      lines_added: linesAdded,
      lines_deleted: linesDeleted
    });
  }

  for (const line of nameStatus) {
    const parts = line.split(/\t/).filter(Boolean);
    if (parts.length < 2) continue;
    const status = parts[0];
    const rel = normalizeSlashes(parts[parts.length - 1] || '');
    if (!rel) continue;
    const existing = entriesByPath.get(rel) || { path: rel, lines_added: 0, lines_deleted: 0 };
    entriesByPath.set(rel, { ...existing, status });
  }

  for (const rel of untracked.map(normalizeSlashes).filter(Boolean)) {
    if (entriesByPath.has(rel)) continue;
    const text = await fsp.readFile(path.join(root, rel), 'utf8').catch(() => '');
    entriesByPath.set(rel, {
      path: rel,
      status: 'A',
      lines_added: addedFileLines(text).length,
      lines_deleted: 0,
      source_sha256: isSourceLike(rel) ? sha256(text) : null
    });
  }

  const entries = [...entriesByPath.values()].filter((entry) => entry.path && isChangedScopePath(entry.path));
  for (const entry of entries) {
    if (!isSourceLike(entry.path) || entry.source_sha256) continue;
    const text = await fsp.readFile(path.join(root, entry.path), 'utf8').catch(() => '');
    entry.source_sha256 = sha256(text);
  }
  const changedFiles = entries.map((entry) => entry.path);
  const sourceFiles = changedFiles.filter(isSourceLike);
  const linesAdded = entries.reduce((sum, entry) => sum + Number(entry.lines_added || 0), 0);
  const linesDeleted = entries.reduce((sum, entry) => sum + Number(entry.lines_deleted || 0), 0);
  return {
    mode: 'git-diff',
    base,
    changed_files: changedFiles,
    files_added: entries.filter((entry) => String(entry.status || '').startsWith('A')).length,
    files_deleted: entries.filter((entry) => String(entry.status || '').startsWith('D')).length,
    lines_added: linesAdded,
    lines_deleted: linesDeleted,
    net_lines: linesAdded - linesDeleted,
    source_files: sourceFiles,
    entries
  };
}

async function listSourceFiles(root: any, dir: any = root, out: any = []) {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    // Hidden runtime/worktree directories can contain complete repository copies.
    // Only .agents is a source-bearing project directory; all other hidden trees
    // are state, caches, or external workspaces and must stay outside this scan.
    if (entry.name.startsWith('.') && entry.name !== '.agents') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await listSourceFiles(root, full, out);
      continue;
    }
    if (DEFAULT_INCLUDE.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

async function collectDependencyDelta(root: string, base = 'HEAD') {
  const current = await readPackageDependencyNames(path.join(root, 'package.json'));
  const previousText = gitText(root, ['show', `${base}:package.json`]);
  const previous = parsePackageDependencyNames(previousText || '{}');
  return {
    added: [...current].filter((name) => !previous.has(name)).sort(),
    removed: [...previous].filter((name) => !current.has(name)).sort()
  };
}

async function readPackageDependencyNames(file: string) {
  const text = await fsp.readFile(file, 'utf8').catch(() => '{}');
  return parsePackageDependencyNames(text);
}

function parsePackageDependencyNames(text: string) {
  const value = safeJson(text);
  const names = new Set<string>();
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const deps = value?.[section] && typeof value[section] === 'object' ? value[section] : {};
    for (const name of Object.keys(deps)) names.add(`${section}:${name}`);
  }
  return names;
}

async function collectAddedFallbackSites(root: string, changedScope: any) {
  if (!changedScope?.source_files?.length || changedScope.mode !== 'git-diff') return [];
  const diff = gitText(root, ['diff', '--unified=0', changedScope.base || 'HEAD', '--', ...changedScope.source_files]);
  const sites: any[] = [];
  let currentFile = '';
  let currentLine = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++ b/')) {
      currentFile = normalizeSlashes(line.slice('+++ b/'.length));
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      currentLine = Number(hunk[1]) || 0;
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      if (FALLBACK_RE.test(line)) sites.push({ file: currentFile, line: currentLine, text: line.slice(1).trim().slice(0, 160) });
      currentLine += 1;
      continue;
    }
    if (!line.startsWith('-')) currentLine += 1;
  }
  return sites;
}

async function collectAddedHunkScopes(root: string, changedScope: any) {
  const scopes = new Map<string, { scope: string; text: string; line_ranges: Array<{ start: number; end: number }> }>();
  if (!changedScope?.source_files?.length) return scopes;
  if (changedScope.mode === 'explicit') {
    for (const rel of changedScope.source_files) {
      const text = await fsp.readFile(path.join(root, rel), 'utf8').catch(() => '');
      const lineCount = text ? text.split(/\r?\n/).length : 0;
      scopes.set(normalizeSlashes(rel), {
        scope: 'explicit_changed_file',
        text,
        line_ranges: lineCount ? [{ start: 1, end: lineCount }] : []
      });
    }
    return scopes;
  }
  if (changedScope.mode !== 'git-diff') return scopes;

  const diff = gitText(root, ['diff', '--unified=0', changedScope.base || 'HEAD', '--', ...changedScope.source_files]);
  let currentFile = '';
  let currentLine = 0;
  const linesByFile = new Map<string, Array<{ line: number; text: string }>>();
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++ b/')) {
      currentFile = normalizeSlashes(line.slice('+++ b/'.length));
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      currentLine = Number(hunk[1]) || 0;
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      if (currentFile) {
        const rows = linesByFile.get(currentFile) || [];
        rows.push({ line: currentLine, text: line.slice(1) });
        linesByFile.set(currentFile, rows);
      }
      currentLine += 1;
      continue;
    }
    if (!line.startsWith('-')) currentLine += 1;
  }

  for (const rel of changedScope.source_files) {
    const normalized = normalizeSlashes(rel);
    let rows = linesByFile.get(normalized) || [];
    const entry = changedScope.entries?.find((candidate: any) => normalizeSlashes(candidate.path) === normalized);
    if (!rows.length && String(entry?.status || '').startsWith('A')) {
      const text = await fsp.readFile(path.join(root, normalized), 'utf8').catch(() => '');
      rows = addedFileLines(text).map((value, index) => ({ line: index + 1, text: value }));
    }
    scopes.set(normalized, {
      scope: 'added_hunks',
      text: joinAddedHunkRows(rows),
      line_ranges: contiguousLineRanges(rows.map((row) => row.line))
    });
  }
  return scopes;
}

function analyzeTextSignals(
  rel: string,
  text: string,
  changedByDiff: boolean,
  sanityScope: { scope: string; text: string; line_ranges: Array<{ start: number; end: number }> }
) {
  const lines = text.split(/\r?\n/);
  const scopedText = String(sanityScope.text || '');
  const scopedCode = stripNonCodeForSanity(scopedText);
  const imports = lines.filter((line) => /^\s*import\s/.test(line));
  const externalImports = imports
    .map((line) => /from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/.exec(line)?.[1] || /from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/.exec(line)?.[2] || '')
    .filter((specifier) => specifier && !specifier.startsWith('.') && !specifier.startsWith('node:'));
  const leanMarkers = lines
    .map((line, index) => parseLeanSimplificationMarkerLine(line, rel, index + 1))
    .filter((marker): marker is LeanSimplificationMarker => Boolean(marker));
  const effectiveLines = lines.map((line) => line.trim()).filter(Boolean);
  const scopeCoversWholeFile = sanityScope.line_ranges.length === 1
    && sanityScope.line_ranges[0]?.start === 1
    && sanityScope.line_ranges[0]?.end >= lines.length;
  const forwardingOnly = scopeCoversWholeFile
    && effectiveLines.length > 0
    && effectiveLines.length <= 10
    && effectiveLines.every((line) => line.startsWith('import ') || line.startsWith('export ') || line.startsWith('//') || line.startsWith('/*') || line.startsWith('*'));
  return {
    import_count: imports.length,
    external_dependency_imports: Array.from(new Set(externalImports)).sort(),
    ts_nocheck: /^\s*\/\/\s*@ts-nocheck\b/m.test(scopedText),
    changed_by_diff: changedByDiff,
    forwarding_only: forwardingOnly,
    fallback_markers: countMatches(scopedCode, FALLBACK_RE),
    config_flag_markers: countMatches(scopedCode, CONFIG_FLAG_RE),
    abstraction_markers: countMatches(scopedCode, ABSTRACTION_RE),
    engineering_sanity: engineeringSanitySignals(scopedText, sanityScope),
    lean_markers: leanMarkers
  };
}

function engineeringSanitySignals(text: string, scope: { scope: string; line_ranges: Array<{ start: number; end: number }> }) {
  const code = stripNonCodeForSanity(text);
  const writeCalls = code.match(DB_WRITE_CALL_RE)?.length || 0;
  return {
    source_scope: scope.scope,
    added_hunk_line_ranges: scope.line_ranges,
    candidate_detection_only: true,
    n_plus_one_candidates: countMatches(code, N_PLUS_ONE_RE),
    unbounded_loop_candidates: countMatches(code, UNBOUNDED_LOOP_RE),
    render_loop_candidates: countMatches(code, RENDER_LOOP_RE),
    direct_recursion_candidates: countDirectRecursionCandidates(code),
    verification_bypass_markers: countMatches(code, VERIFICATION_BYPASS_RE),
    db_pool_constructor_markers: countMatches(code, DB_POOL_CONSTRUCTOR_RE),
    sensitive_transaction_candidate: SENSITIVE_DOMAIN_RE.test(code)
      && writeCalls >= 2
      && !TRANSACTION_MARKER_RE.test(code),
    db_write_call_markers: writeCalls
  };
}

function stripNonCodeForSanity(text: string) {
  return String(text || '')
    .replace(/^\s*const\s+[A-Z0-9_]+_RE\s*=\s*\/.*\/[dgimsuvy]*;?\s*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, (value) => value.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1')
    .replace(/(['"`])(?:\\.|(?!\1)[\s\S])*?\1/g, (value) => value.replace(/[^\n]/g, ' '));
}

function countDirectRecursionCandidates(text: string) {
  let count = 0;
  const functions = /(?:function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>)\s*\{([\s\S]{0,3000}?)\n?\}/g;
  let match;
  while ((match = functions.exec(text))) {
    const name = match[1] || match[2];
    const body = match[3] || '';
    if (name && new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`).test(body)) count += 1;
  }
  return count;
}

function collectRunnableChecks(changedScope: any) {
  return (changedScope.source_files || [])
    .filter((file: string) => /\b(test|tests|fixture|fixtures|spec|check|__tests__)\b/i.test(file))
    .sort();
}

function buildSemanticReview(input: any) {
  const findings: LeanFinding[] = [];
  const testVolume = assessTestVolume(input.changedScope?.entries || []);
  if (testVolume.over_budget) {
    findings.push({
      tag: 'yagni',
      severity: 'review',
      summary: `change adds ${testVolume.added_test_lines} test lines for ${testVolume.added_source_lines} source lines (${testVolume.ratio?.toFixed(1)}x); keep the cases a real defect would produce and drop the rest — exhaustive cases are only owed on money-handling paths`
    });
  }
  for (const dep of input.dependencyDelta.added || []) {
    findings.push({
      tag: 'reuse',
      severity: 'blocker',
      summary: `new dependency requires explicit lean justification: ${dep}`
    });
  }
  if ((input.fallbackSites || []).length) {
    findings.push({
      tag: 'fallback',
      severity: 'review',
      summary: `${input.fallbackSites.length} added fallback/compat/mock marker(s) need authority and proof`
    });
  }
  const changedEntries = (input.entries || input.changedScope?.entries || []);
  if (input.changedScope?.net_lines > 300) {
    findings.push({
      tag: 'shrink',
      severity: 'review',
      summary: `changed diff is +${input.changedScope.net_lines} net lines; confirm this is the smallest sufficient change`
    });
  }
  if ((input.changedScope?.source_files || []).length && !(input.runnableChecks || []).length) {
    findings.push({
      tag: 'verify',
      severity: 'review',
      summary: 'changed source files were detected without a changed runnable check file'
    });
  }
  for (const entry of input.entries || []) {
    if (!entry.lean_signals?.changed_by_diff) continue;
    if (entry.lean_signals.ts_nocheck) {
      findings.push({
        tag: 'verify',
        severity: isLeanOwnedTypeSafetyPath(entry.path) ? 'blocker' : 'review',
        file: entry.path,
        summary: isLeanOwnedTypeSafetyPath(entry.path)
          ? 'changed Lean/architecture-owned file contains @ts-nocheck'
          : 'changed auxiliary fixture/gate file contains @ts-nocheck; keep typed migration scoped'
      });
    }
    if (entry.lean_signals.forwarding_only) {
      findings.push({
        tag: 'reuse',
        severity: 'review',
        file: entry.path,
        summary: 'changed file is forwarding-only; confirm it replaces an older path instead of duplicating an SSOT'
      });
    }
    const sanity = entry.lean_signals.engineering_sanity || {};
    if (entry.lean_signals.config_flag_markers > 6 || entry.lean_signals.abstraction_markers > 12) {
      findings.push({
        tag: 'solid',
        severity: 'review',
        file: entry.path,
        source_scope: sanity.source_scope,
        added_hunk_line_ranges: sanity.added_hunk_line_ranges,
        summary: 'changed file has dense config/abstraction markers; review single responsibility, dependency direction, and unrequested layers'
      });
    }
    if (sanity.n_plus_one_candidates > 0) {
      findings.push({
        tag: 'n-plus-one',
        severity: 'review',
        file: entry.path,
        source_scope: sanity.source_scope,
        added_hunk_line_ranges: sanity.added_hunk_line_ranges,
        summary: `${sanity.n_plus_one_candidates} loop-bound database or I/O call candidate(s) require batching, prefetching, or bounded-query review`
      });
    }
    if (sanity.unbounded_loop_candidates > 0 || sanity.render_loop_candidates > 0 || sanity.direct_recursion_candidates > 0) {
      findings.push({
        tag: 'unbounded-loop',
        severity: 'review',
        file: entry.path,
        source_scope: sanity.source_scope,
        added_hunk_line_ranges: sanity.added_hunk_line_ranges,
        summary: `control-flow review required: unbounded=${sanity.unbounded_loop_candidates || 0}, render=${sanity.render_loop_candidates || 0}, recursion=${sanity.direct_recursion_candidates || 0}`
      });
    }
    if (sanity.verification_bypass_markers > 0) {
      findings.push({
        tag: 'verification-bypass',
        severity: 'review',
        file: entry.path,
        source_scope: sanity.source_scope,
        added_hunk_line_ranges: sanity.added_hunk_line_ranges,
        summary: `${sanity.verification_bypass_markers} disabled-check or swallowed-failure marker(s) require explicit justification and equivalent verification`
      });
    }
    if (sanity.db_pool_constructor_markers > 0) {
      findings.push({
        tag: 'db-pool',
        severity: 'review',
        file: entry.path,
        source_scope: sanity.source_scope,
        added_hunk_line_ranges: sanity.added_hunk_line_ranges,
        summary: `${sanity.db_pool_constructor_markers} database client/pool construction marker(s) require canonical ownership, bounded acquire/release, shutdown, and exhaustion review`
      });
    }
    if (sanity.sensitive_transaction_candidate) {
      findings.push({
        tag: 'transaction',
        severity: 'review',
        file: entry.path,
        source_scope: sanity.source_scope,
        added_hunk_line_ranges: sanity.added_hunk_line_ranges,
        summary: 'sensitive or financial multi-write flow lacks an obvious transaction marker; verify atomic rollback, error propagation, idempotency, and post-commit invariants'
      });
    }
  }
  for (const marker of input.intentionalSimplifications || []) {
    if (marker.status === 'complete') continue;
    findings.push({
      tag: 'shrink',
      severity: 'review',
      file: marker.file,
      line: marker.line,
      summary: `lean simplification marker is incomplete: ${marker.status}`
    });
  }
  const finalizedFindings = findings.map((finding) => ({
    ...finding,
    id: `eng-${sha256(`${finding.tag}:${finding.file || ''}:${finding.line || 0}:${finding.summary}`).slice(0, 16)}`
  }));
  const status = finalizedFindings.some((finding) => finding.severity === 'blocker')
    ? 'blocked'
    : finalizedFindings.some((finding) => finding.severity === 'review')
      ? 'needs-review'
      : 'pass';
  return { status, findings: finalizedFindings };
}

function isLeanOwnedTypeSafetyPath(file: string): boolean {
  return [
    'src/core/code-structure.ts',
    'src/core/commands/code-structure-command.ts',
    'src/core/lean-engineering-policy.ts',
    'src/core/codex-control/gpt-final-arbiter.ts',
    'src/core/codex-control/gpt-final-review-schema.ts',
    'src/core/codex-control/codex-fake-sdk-adapter.ts',
    'src/core/agents/native-worker-backend-router.ts',
    'src/scripts/check-architecture.ts',
    'src/scripts/check-command-module-budget.ts',
    'src/scripts/check-pipeline-budget.ts',
    'src/scripts/check-route-modularity.ts',
    'src/scripts/check-publish-tag.ts',
    'src/scripts/gpt-final-arbiter-check.ts',
    'src/scripts/release-registry-check.ts'
  ].includes(file);
}

function buildLeanChangeEvidence(input: any) {
  const changedScope = input.changedScope || emptyChangedScope('unknown', 'HEAD');
  return {
    schema: LEAN_CHANGE_EVIDENCE_SCHEMA,
    ...leanPolicyReference(),
    changed_files: changedScope.changed_files || [],
    files_added: changedScope.files_added || 0,
    files_deleted: changedScope.files_deleted || 0,
    lines_added: changedScope.lines_added || 0,
    lines_deleted: changedScope.lines_deleted || 0,
    net_lines: changedScope.net_lines || 0,
    dependencies_added: input.dependencyDelta?.added || [],
    dependencies_removed: input.dependencyDelta?.removed || [],
    fallback_sites_added: input.fallbackSites || [],
    intentional_simplifications: input.intentionalSimplifications || [],
    runnable_checks: input.runnableChecks || [],
    engineering_sanity: {
      status: (changedScope.source_files || []).length ? 'manual-review-required' : 'not-applicable',
      automated_candidate_status: (input.semanticReview?.findings || []).some((finding: LeanFinding) => ENGINEERING_SANITY_TAGS.has(finding.tag))
        ? 'candidates-found'
        : 'no-candidates-found',
      required_checks: [
        'solid_boundaries',
        'n_plus_one_and_repeated_io',
        'bounded_render_recursion_event_retry_polling',
        'verification_bypass_absent',
        'canonical_db_pool_lifecycle_when_applicable',
        'transaction_integrity_when_sensitive_or_multi_step'
      ],
      findings: (input.semanticReview?.findings || []).filter((finding: LeanFinding) => ENGINEERING_SANITY_TAGS.has(finding.tag))
    },
    semantic_review: input.semanticReview || { status: 'needs-review', findings: [] }
  };
}

async function countLines(file: any) {
  const text = await fsp.readFile(file, 'utf8');
  return text ? text.split(/\n/).length : 0;
}

function structureStatus(lines: any) {
  if (lines >= CODE_STRUCTURE_THRESHOLDS.split_required_review) return 'over_3000_split_required_review';
  if (lines >= CODE_STRUCTURE_THRESHOLDS.review) return 'over_2000_refactor_review';
  if (lines >= CODE_STRUCTURE_THRESHOLDS.warning) return 'over_1000_warning';
  return 'ok';
}

function isGeneratedOrVendor(rel: any) {
  return /(^|\/)(node_modules|dist|build|coverage)\//.test(rel) || /package-lock\.json$/.test(rel);
}

function recommendedAction(rel: any, lines: any) {
  if (lines < CODE_STRUCTURE_THRESHOLDS.warning) return 'none';
  if (/src\/cli\/main\.(js|ts)$/.test(rel)) return 'extract CLI subcommand handlers into focused modules before adding substantial command logic';
  if (/routes|pipeline|init/.test(rel)) return 'extract policy tables or route-specific execution into focused modules';
  return 'identify a cohesive module boundary and extract before adding unrelated logic';
}

function nextSplitCandidate(rel: any) {
  if (/src\/cli\/main\.(js|ts)$/.test(rel)) return 'goal/wiki/naruto/eval/db command handlers';
  if (/src\/core\/pipeline\.(js|ts)$/.test(rel)) return 'route prepare handlers and stop-gate evaluators';
  return 'largest cohesive command or policy section';
}

function countMatches(text: string, pattern: RegExp) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return [...text.matchAll(new RegExp(pattern.source, flags))].length;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isSourceLike(file: string) {
  const rel = normalizeSlashes(file);
  return SOURCE_DIR_RE.test(rel) && SOURCE_EXT_RE.test(rel) && !isGeneratedOrVendor(rel);
}

function isChangedScopePath(file: string) {
  const rel = normalizeSlashes(file);
  const first = rel.split('/')[0] || '';
  if (first.startsWith('.') && first !== '.agents') return false;
  return !isGeneratedOrVendor(rel);
}

function parseNumstat(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

// Untracked files are read from the working tree instead of a diff, so their
// line accounting has to match what `git diff` reports for the same file once
// it is tracked; otherwise a scope bound to a base commit changes shape the
// moment those files are committed. Git counts a trailing newline as the end
// of the last line, not as an extra empty line.
function addedFileLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// The concrete commit a mission's changed scope is measured against. Resolving
// 'HEAD' to a sha at route-preparation time keeps the scope stable across a
// route that creates its own commit (for example $Commit).
export function resolveChangedScopeBase(root: string, fallback = 'HEAD'): string {
  const sha = gitText(root, ['rev-parse', 'HEAD']).trim();
  return /^[0-9a-f]{40}$/i.test(sha) ? sha : fallback;
}

function gitLines(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) return [];
  return String(result.stdout || '').split(/\r?\n/).filter(Boolean);
}

function gitText(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) return '';
  return String(result.stdout || '');
}

function emptyChangedScope(mode: string, base: string) {
  return {
    mode,
    base,
    changed_files: [],
    files_added: 0,
    files_deleted: 0,
    lines_added: 0,
    lines_deleted: 0,
    net_lines: 0,
    source_files: [],
    entries: []
  };
}

function normalizeRel(root: string, file: string) {
  return normalizeSlashes(path.relative(root, path.resolve(root, file)));
}

function normalizeSlashes(file: string) {
  return String(file || '').replace(/\\/g, '/');
}

function contiguousLineRanges(lines: number[]) {
  const sorted = [...new Set(lines.filter((line) => Number.isInteger(line) && line > 0))].sort((a, b) => a - b);
  const ranges: Array<{ start: number; end: number }> = [];
  for (const line of sorted) {
    const last = ranges.at(-1);
    if (last && line === last.end + 1) last.end = line;
    else ranges.push({ start: line, end: line });
  }
  return ranges;
}

function joinAddedHunkRows(rows: Array<{ line: number; text: string }>) {
  const out: string[] = [];
  let previousLine = 0;
  for (const row of rows) {
    if (previousLine > 0 && row.line > previousLine + 1) {
      out.push(' '.repeat(1301));
    }
    out.push(row.text);
    previousLine = row.line;
  }
  return out.join('\n');
}
