import { performance } from 'node:perf_hooks';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureDir, projectRoot, which, writeJsonAtomic } from '../fsx.js';
import { search, searchBatch, searchCapabilities } from './provider.js';
import { SEARCH_SCHEMA_VERSION, type SearchResponse } from './types.js';

export interface BenchmarkScenarioResult {
  id: number;
  name: string;
  ok: boolean;
  engine: string;
  provider: string;
  wallMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  processSpawns: number;
  scannedFiles: number;
  scannedBytes: number;
  matchCount: number;
  cacheHit: boolean;
  accuracy?: { tp: number; fp: number; fn: number; note?: string };
  errors: string[];
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] || 0;
}

async function timeRuns(n: number, fn: () => Promise<SearchResponse>): Promise<{ runs: number[]; last: SearchResponse }> {
  const runs: number[] = [];
  let last!: SearchResponse;
  for (let i = 0; i < n; i += 1) {
    const t0 = performance.now();
    last = await fn();
    runs.push(performance.now() - t0);
  }
  runs.sort((a, b) => a - b);
  return { runs, last };
}

function summarize(id: number, name: string, runs: number[], last: SearchResponse, accuracy?: BenchmarkScenarioResult['accuracy']): BenchmarkScenarioResult {
  const row: BenchmarkScenarioResult = {
    id,
    name,
    ok: last.ok,
    engine: last.engine,
    provider: last.provider,
    wallMs: runs.reduce((a, b) => a + b, 0),
    p50Ms: percentile(runs, 50),
    p95Ms: percentile(runs, 95),
    p99Ms: percentile(runs, 99),
    processSpawns: last.processSpawns,
    scannedFiles: last.scanned.files,
    scannedBytes: last.scanned.bytes,
    matchCount: last.matches.length,
    cacheHit: last.cacheHit,
    errors: last.errors
  };
  if (accuracy) row.accuracy = accuracy;
  return row;
}

export async function runSearchEngineBenchmark(opts: { root?: string; writeArtifacts?: boolean } = {}) {
  const root = path.resolve(opts.root || (await projectRoot(process.cwd())));
  const caps = await searchCapabilities(root);
  const scenarios: BenchmarkScenarioResult[] = [];
  const rgBin = await which('rg');

  // 1 cold file discovery
  {
    const { runs, last } = await timeRuns(1, () =>
      search({ schemaVersion: SEARCH_SCHEMA_VERSION, mode: 'files', root, limits: { maxMatches: 50_000 } })
    );
    scenarios.push(summarize(1, 'files_cold', runs, last));
  }
  // 2 warm file discovery
  {
    const { runs, last } = await timeRuns(3, () =>
      search({ schemaVersion: SEARCH_SCHEMA_VERSION, mode: 'files', root, limits: { maxMatches: 50_000 } })
    );
    scenarios.push(summarize(2, 'files_warm', runs, last));
  }
  // 3 text simple
  {
    const { runs, last } = await timeRuns(3, () =>
      search({
        schemaVersion: SEARCH_SCHEMA_VERSION,
        mode: 'text',
        root,
        pattern: 'SearchProvider',
        include: ['src/**'],
        limits: { maxMatches: 200 }
      })
    );
    scenarios.push(
      summarize(3, 'text_simple', runs, last, {
        tp: last.matches.length > 0 ? 1 : 0,
        fp: 0,
        fn: last.matches.length > 0 ? 0 : 1,
        note: 'expects hits in src/core/search'
      })
    );
  }
  // 4 unicode / korean
  {
    const { runs, last } = await timeRuns(2, () =>
      search({
        schemaVersion: SEARCH_SCHEMA_VERSION,
        mode: 'text',
        root,
        pattern: '검색|Search',
        include: ['docs/**', 'src/core/search/**'],
        limits: { maxMatches: 50 }
      })
    );
    scenarios.push(summarize(4, 'text_unicode_korean', runs, last));
  }
  // 5 case insensitive
  {
    const { runs, last } = await timeRuns(2, () =>
      search({
        schemaVersion: SEARCH_SCHEMA_VERSION,
        mode: 'text',
        root,
        pattern: 'searchprovider',
        caseSensitive: false,
        include: ['src/core/search/**'],
        limits: { maxMatches: 50 }
      })
    );
    scenarios.push(summarize(5, 'text_case_insensitive', runs, last));
  }
  // 6 long-line / binary skip path
  {
    const { runs, last } = await timeRuns(1, () =>
      search({
        schemaVersion: SEARCH_SCHEMA_VERSION,
        mode: 'text',
        root,
        pattern: '.',
        include: ['package.json'],
        limits: { maxMatches: 5, maxBytes: 1024 * 1024 }
      })
    );
    scenarios.push(summarize(6, 'text_bounded_bytes', runs, last));
  }
  // 7 ignored paths skipped
  {
    const { runs, last } = await timeRuns(1, () =>
      search({
        schemaVersion: SEARCH_SCHEMA_VERSION,
        mode: 'files',
        root,
        query: 'node_modules',
        limits: { maxMatches: 20 }
      })
    );
    const fp = last.matches.filter((m) => m.path.includes('node_modules/')).length;
    scenarios.push(summarize(7, 'files_ignore_node_modules', runs, last, { tp: 0, fp, fn: 0, note: 'node_modules path hits should be 0' }));
  }
  // 8 structure function_declaration
  {
    const { runs, last } = await timeRuns(2, () =>
      search({
        schemaVersion: SEARCH_SCHEMA_VERSION,
        mode: 'structure',
        root,
        pattern: 'function_declaration search',
        language: 'typescript',
        include: ['src/core/search/**'],
        limits: { maxMatches: 20 }
      })
    );
    scenarios.push(summarize(8, 'structure_function_declaration', runs, last));
  }
  // 9 structure capability error (not text disguise)
  {
    const { runs, last } = await timeRuns(1, () =>
      search({
        schemaVersion: SEARCH_SCHEMA_VERSION,
        mode: 'structure',
        root,
        pattern: 'function_declaration foo',
        language: 'python',
        limits: { maxMatches: 5 }
      })
    );
    const ok = !last.ok && last.errors.some((e) => e.includes('structure_unsupported_language'));
    scenarios.push({
      ...summarize(9, 'structure_unsupported_language', runs, last),
      ok
    });
  }
  // 10 symbol confidence
  {
    const { runs, last } = await timeRuns(1, () =>
      search({
        schemaVersion: SEARCH_SCHEMA_VERSION,
        mode: 'symbol',
        root,
        query: 'search',
        include: ['src/core/search/**'],
        limits: { maxMatches: 100 }
      })
    );
    const bad = last.matches.filter((m) => m.confidence === 'exact_reference' && m.meta?.note).length;
    scenarios.push(
      summarize(10, 'symbol_confidence', runs, last, {
        tp: last.matches.filter((m) => m.confidence === 'exact_definition' || m.confidence === 'syntactic_reference' || m.confidence === 'text_candidate').length,
        fp: bad,
        fn: 0,
        note: 'no text hits labeled exact_reference'
      })
    );
  }
  // 11 context pack
  {
    const { runs, last } = await timeRuns(1, () =>
      search({
        schemaVersion: SEARCH_SCHEMA_VERSION,
        mode: 'context',
        root,
        query: 'SearchProvider',
        why: 'benchmark',
        limits: { maxMatches: 40 }
      })
    );
    scenarios.push(summarize(11, 'context_triwiki', runs, last));
  }
  // 12 batch 20 queries (spawn reduction)
  {
    const t0 = performance.now();
    const batch = await searchBatch({
      schemaVersion: SEARCH_SCHEMA_VERSION,
      root,
      requests: Array.from({ length: 20 }, (_, i) => ({
        schemaVersion: SEARCH_SCHEMA_VERSION,
        mode: 'text' as const,
        root,
        pattern: i % 2 === 0 ? 'export' : 'import',
        include: ['src/core/search/**'],
        limits: { maxMatches: 10 }
      }))
    });
    const wall = performance.now() - t0;
    scenarios.push({
      id: 12,
      name: 'batch_20_text',
      ok: batch.ok,
      engine: 'batch',
      provider: batch.provider,
      wallMs: wall,
      p50Ms: wall / 20,
      p95Ms: wall / 20,
      p99Ms: wall / 20,
      processSpawns: batch.processSpawns,
      scannedFiles: batch.responses.reduce((n, r) => n + r.scanned.files, 0),
      scannedBytes: batch.responses.reduce((n, r) => n + r.scanned.bytes, 0),
      matchCount: batch.responses.reduce((n, r) => n + r.matches.length, 0),
      cacheHit: batch.responses.some((r) => r.cacheHit),
      errors: []
    });
  }
  // 13 rg CLI comparison (optional)
  {
    if (rgBin) {
      const t0 = performance.now();
      const r = spawnSync(rgBin, ['-n', '--glob', 'src/**', 'SearchProvider', '.'], {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024
      });
      const wall = performance.now() - t0;
      const count = String(r.stdout || '')
        .split('\n')
        .filter(Boolean).length;
      scenarios.push({
        id: 13,
        name: 'rg_cli_compare',
        ok: r.status === 0 || r.status === 1,
        engine: 'rg-cli',
        provider: 'external',
        wallMs: wall,
        p50Ms: wall,
        p95Ms: wall,
        p99Ms: wall,
        processSpawns: 1,
        scannedFiles: -1,
        scannedBytes: -1,
        matchCount: count,
        cacheHit: false,
        errors: r.status === 0 || r.status === 1 ? [] : [String(r.stderr || 'rg_failed')]
      });
    } else {
      scenarios.push({
        id: 13,
        name: 'rg_cli_compare',
        ok: true,
        engine: 'rg-cli',
        provider: 'external',
        wallMs: 0,
        p50Ms: 0,
        p95Ms: 0,
        p99Ms: 0,
        processSpawns: 0,
        scannedFiles: 0,
        scannedBytes: 0,
        matchCount: 0,
        cacheHit: false,
        errors: [],
        accuracy: { tp: 0, fp: 0, fn: 0, note: 'rg not installed; comparison skipped' }
      });
    }
  }
  // 14 hidden/symlink skip smoke via files
  {
    const { runs, last } = await timeRuns(1, () =>
      search({
        schemaVersion: SEARCH_SCHEMA_VERSION,
        mode: 'files',
        root,
        query: '.git',
        limits: { maxMatches: 5 }
      })
    );
    scenarios.push(summarize(14, 'files_skip_dot_git_objects', runs, last));
  }
  // 15 AI token omission estimate for context
  {
    const last = await search({
      schemaVersion: SEARCH_SCHEMA_VERSION,
      mode: 'context',
      root,
      query: 'triwiki',
      limits: { maxMatches: 10 }
    });
    scenarios.push({
      id: 15,
      name: 'context_token_budget',
      ok: last.ok,
      engine: last.engine,
      provider: last.provider,
      wallMs: last.durationMs,
      p50Ms: last.durationMs,
      p95Ms: last.durationMs,
      p99Ms: last.durationMs,
      processSpawns: last.processSpawns,
      scannedFiles: last.scanned.files,
      scannedBytes: last.scanned.bytes,
      matchCount: last.matches.length,
      cacheHit: last.cacheHit,
      accuracy: {
        tp: last.context?.tokenBudgetOmissions ?? 0,
        fp: 0,
        fn: 0,
        note: 'tp field reused as tokenBudgetOmissions count'
      },
      errors: last.errors
    });
  }

  const rss = process.memoryUsage().rss;
  const report = {
    schema: 'sks.search-engine-benchmark.v1',
    generated_at: new Date().toISOString(),
    root,
    package_version: process.env.npm_package_version || null,
    capabilities: caps,
    scenarios,
    summary: {
      scenario_count: scenarios.length,
      ok_count: scenarios.filter((s) => s.ok).length,
      total_process_spawns: scenarios.reduce((n, s) => n + s.processSpawns, 0),
      batch_spawns: scenarios.find((s) => s.id === 12)?.processSpawns ?? null,
      rss_bytes: rss,
      notes: [
        'JS fallback is valid when sks-rs is not built.',
        'rg CLI comparison is optional and not a core dependency.',
        'Structure never falls back silently to text.'
      ]
    }
  };

  if (opts.writeArtifacts !== false) {
    const outJson = path.join(root, '.sneakoscope/reports/search-engine-benchmark.json');
    await ensureDir(path.dirname(outJson));
    await writeJsonAtomic(outJson, report);
    const md = renderBenchmarkMarkdown(report);
    const outMd = path.join(root, 'docs/performance/search-engine-benchmark.md');
    await ensureDir(path.dirname(outMd));
    await fsp.writeFile(outMd, md, 'utf8');
  }
  return report;
}

function renderBenchmarkMarkdown(report: Awaited<ReturnType<typeof runSearchEngineBenchmark>>): string {
  const lines = [
    '# Search Engine Benchmark',
    '',
    `Generated: ${report.generated_at}`,
    `Root: ${report.root}`,
    '',
    '| ID | Scenario | OK | Provider | p50ms | p95ms | Spawns | Matches |',
    '|----|----------|----|----------|-------|-------|--------|---------|'
  ];
  for (const s of report.scenarios) {
    lines.push(
      `| ${s.id} | ${s.name} | ${s.ok} | ${s.provider}/${s.engine} | ${s.p50Ms.toFixed(1)} | ${s.p95Ms.toFixed(1)} | ${s.processSpawns} | ${s.matchCount} |`
    );
  }
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- OK: ${report.summary.ok_count}/${report.summary.scenario_count}`);
  lines.push(`- Total process spawns across scenarios: ${report.summary.total_process_spawns}`);
  lines.push(`- Batch-20 process spawns: ${report.summary.batch_spawns}`);
  lines.push(`- RSS bytes: ${report.summary.rss_bytes}`);
  for (const note of report.summary.notes) lines.push(`- ${note}`);
  lines.push('');
  return lines.join('\n');
}
