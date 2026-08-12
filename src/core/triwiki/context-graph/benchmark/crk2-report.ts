/**
 * The before/after report.
 *
 * Three rules are enforced by the shape of this module rather than by review:
 *
 * **A latency figure is never published without the recall beside it.** The v1
 * baseline's two fastest cases were `korean` and `jargon`, and they were fast
 * because they matched nothing. `Crk2BeforeAfterRow` therefore has no way to
 * carry a duration without also carrying what the query returned, and
 * `emptyAnswer` marks a row whose speed is an artefact of finding nothing.
 *
 * **Every delta carries a confidence interval.** A mean with no spread cannot
 * separate a real change from run-to-run noise, and "3× faster" from two
 * single-sample runs is a number, not evidence.
 *
 * **The lexicon counts sit next to the index stats.** A caller that builds an
 * index without threading `lexicon` gets four empty dictionary sections and an
 * engine that answers a pasted path and nothing else — catastrophic recall that
 * measures as a working search. A zero in `lexiconTermCount` invalidates every
 * recall number in the same report, so it is printed in the same table rather
 * than left for someone to look up.
 */
import type { Crk2LatencyStats, Crk2ResourceReport } from './crk2-resource-runner.js';

export const CRK2_REPORT_SCHEMA = 'sks.context-graph-crk2-report.v1' as const;

export interface Crk2SnapshotParseMeasurement {
  readonly bytes: number;
  readonly parseMs: number;
  readonly heapDeltaBytes: number;
  readonly rssBytes: number;
  readonly nodeCount: number;
  readonly edgeCount: number;
}

export interface Crk2IndexLexiconCounts {
  readonly termCount: number;
  readonly postingCount: number;
  readonly coarseTermCount: number;
  readonly coarsePostingCount: number;
}

export interface Crk2BeforeAfterRow {
  readonly metric: string;
  readonly unit: 'bytes' | 'ms' | 'count' | 'ratio';
  readonly before: number;
  readonly after: number;
  /** `before / after`; >1 means v2 is smaller or faster. */
  readonly factor: number;
  /** Half-width of the 95% CI on the *after* mean, when the metric was sampled. */
  readonly ci95: number | null;
  /**
   * True when the "after" number is only better because the answer was empty.
   * A row carrying this is a recall finding wearing a performance win's clothes.
   */
  readonly emptyAnswer: boolean;
}

export interface Crk2QueryRow {
  readonly id: string;
  readonly profile: string;
  readonly coldMs: number;
  readonly warmP50Ms: number;
  readonly warmP95Ms: number;
  readonly warmCi95Ms: number;
  readonly selected: number;
  readonly postingsExamined: number;
  readonly visitedNodes: number;
  readonly hydratedNodes: number;
  readonly coarseOnlySelected: number;
  readonly lexicalOnlySelected: number;
  /** Zero selections. Its latency is a floor to beat on quality, not a budget to preserve. */
  readonly emptyAnswer: boolean;
}

export type Crk2CoarseVerdict = 'proved' | 'delete';

export interface Crk2Report {
  readonly schema: typeof CRK2_REPORT_SCHEMA;
  readonly generatedAt: string;
  readonly beforeAfter: readonly Crk2BeforeAfterRow[];
  readonly queries: readonly Crk2QueryRow[];
  readonly lexicon: Crk2IndexLexiconCounts;
  /**
   * `delete` when no query in the run produced a selection the coarse lane alone
   * contributed. A lane that contributes nothing measurable costs bytes in every
   * index and reads as working, which is worse than absent.
   */
  readonly coarseVerdict: Crk2CoarseVerdict;
  readonly coarseOnlySelected: number;
  readonly queriesWithCoarseOnly: number;
  readonly emptyAnswerQueries: readonly string[];
  readonly notes: readonly string[];
}

function ratio(before: number, after: number): number {
  if (after === 0) return before === 0 ? 1 : Number.POSITIVE_INFINITY;
  return before / after;
}

function row(
  metric: string,
  unit: Crk2BeforeAfterRow['unit'],
  before: number,
  after: number,
  ci95: number | null = null
): Crk2BeforeAfterRow {
  return { metric, unit, before, after, factor: ratio(before, after), ci95, emptyAnswer: false };
}

/**
 * Build the report from a v1 snapshot-parse measurement and a v2 resource run.
 *
 * The two must come from the same graph. Nothing here can check that — a
 * snapshot and an index carry no shared identity a report could compare — so the
 * caller passes both and the node/edge counts are published side by side, which
 * is the cheapest way for a mismatch to be visible rather than silent.
 */
export function buildCrk2Report(input: {
  readonly snapshot: Crk2SnapshotParseMeasurement;
  readonly resources: Crk2ResourceReport;
  readonly lexicon: Crk2IndexLexiconCounts;
  readonly generatedAt: string;
}): Crk2Report {
  const { snapshot, resources, lexicon } = input;

  const warmMeans = resources.rows.map((entry) => entry.warmLatency.mean);
  const meanWarm = warmMeans.length === 0 ? 0 : warmMeans.reduce((sum, value) => sum + value, 0) / warmMeans.length;
  const pooledCi = pooledCi95(resources.rows.map((entry) => entry.warmLatency));

  const beforeAfter: readonly Crk2BeforeAfterRow[] = [
    row('runtime store bytes', 'bytes', snapshot.bytes, resources.open.indexBytes),
    row('open / parse', 'ms', snapshot.parseMs, resources.open.openMs),
    row('open heap delta', 'bytes', snapshot.heapDeltaBytes, resources.open.heapDeltaBytes),
    row('process RSS after open', 'bytes', snapshot.rssBytes, resources.open.rssBytes),
    row('nodes', 'count', snapshot.nodeCount, resources.open.nodeCount),
    row('edges', 'count', snapshot.edgeCount, resources.open.edgeCount),
    row('mean warm query', 'ms', Number.NaN, meanWarm, pooledCi),
  ];

  const queries: readonly Crk2QueryRow[] = resources.rows.map((entry) => ({
    id: entry.id,
    profile: entry.profile,
    coldMs: entry.cold.durationMs,
    warmP50Ms: entry.warmLatency.p50,
    warmP95Ms: entry.warmLatency.p95,
    warmCi95Ms: entry.warmLatency.ci95,
    selected: entry.warm.selected,
    postingsExamined: entry.warm.postingsExamined,
    visitedNodes: entry.warm.visitedNodes,
    hydratedNodes: entry.warm.hydratedNodes,
    coarseOnlySelected: entry.warm.coarseOnlySelected,
    lexicalOnlySelected: entry.warm.lexicalOnlySelected,
    emptyAnswer: entry.warm.selected === 0,
  }));

  const emptyAnswerQueries = queries.filter((entry) => entry.emptyAnswer).map((entry) => entry.id);
  const notes: string[] = [];
  if (lexicon.termCount === 0) notes.push('lexicon_empty:every_recall_number_in_this_report_is_void');
  if (lexicon.coarseTermCount === 0) notes.push('coarse_lane_empty');
  for (const id of emptyAnswerQueries) notes.push(`empty_answer:${id}`);
  if (resources.coarseOnlySelected === 0) notes.push('coarse_lane_contributed_no_unique_selection');

  return {
    schema: CRK2_REPORT_SCHEMA,
    generatedAt: input.generatedAt,
    beforeAfter,
    queries,
    lexicon,
    coarseVerdict: resources.coarseOnlySelected > 0 ? 'proved' : 'delete',
    coarseOnlySelected: resources.coarseOnlySelected,
    queriesWithCoarseOnly: resources.queriesWithCoarseOnly,
    emptyAnswerQueries,
    notes,
  };
}

/**
 * Pool the per-query confidence intervals into one for the mean of means.
 *
 * Averaging the half-widths would understate the spread; the variances add.
 */
export function pooledCi95(stats: readonly Crk2LatencyStats[]): number {
  const usable = stats.filter((entry) => entry.samples > 1);
  if (usable.length === 0) return 0;
  const variance = usable.reduce((sum, entry) => sum + (entry.stddev ** 2) / entry.samples, 0) / (usable.length ** 2);
  return 1.96 * Math.sqrt(variance);
}

function human(value: number, unit: Crk2BeforeAfterRow['unit']): string {
  if (!Number.isFinite(value)) return '—';
  if (unit === 'bytes') return `${(value / 1_048_576).toFixed(1)} MB`;
  if (unit === 'ms') return `${value.toFixed(2)} ms`;
  return value.toLocaleString('en-US');
}

/** Markdown, for the release record. Numbers only; no path from the measured workspace. */
export function formatCrk2Report(report: Crk2Report): string {
  const lines: string[] = ['| metric | v1 | v2 | factor |', '| --- | ---: | ---: | ---: |'];
  for (const entry of report.beforeAfter) {
    const factor = Number.isFinite(entry.factor) ? `${entry.factor.toFixed(2)}x` : '—';
    const after = entry.ci95 === null
      ? human(entry.after, entry.unit)
      : `${human(entry.after, entry.unit)} ±${entry.ci95.toFixed(3)}`;
    lines.push(`| ${entry.metric} | ${human(entry.before, entry.unit)} | ${after} | ${factor} |`);
  }

  lines.push('', '| query | profile | cold ms | warm p50 | warm p95 | ±ci95 | selected | postings | visited | hydrated | coarse-only |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const entry of report.queries) {
    // The empty marker travels with the row, so a fast-and-empty case cannot be
    // quoted out of the table as a latency win.
    const mark = entry.emptyAnswer ? ' **(empty)**' : '';
    lines.push(
      `| ${entry.id}${mark} | ${entry.profile} | ${entry.coldMs.toFixed(2)} | ${entry.warmP50Ms.toFixed(2)}`
      + ` | ${entry.warmP95Ms.toFixed(2)} | ${entry.warmCi95Ms.toFixed(3)} | ${entry.selected}`
      + ` | ${entry.postingsExamined} | ${entry.visitedNodes} | ${entry.hydratedNodes} | ${entry.coarseOnlySelected} |`
    );
  }

  lines.push('', `lexicon: ${report.lexicon.termCount} terms / ${report.lexicon.postingCount} postings`
    + `, coarse ${report.lexicon.coarseTermCount} / ${report.lexicon.coarsePostingCount}`);
  lines.push(`coarse lane: ${report.coarseVerdict} (${report.coarseOnlySelected} unique selections in ${report.queriesWithCoarseOnly} queries)`);
  if (report.notes.length > 0) lines.push(`notes: ${report.notes.join(', ')}`);
  return lines.join('\n');
}
