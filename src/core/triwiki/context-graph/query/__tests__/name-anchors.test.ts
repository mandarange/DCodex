/**
 * Label and basename anchoring, asserted at the join.
 *
 * Every test here publishes a real generation — the real writer, the real
 * lexicon config, the real `begin`/`stage`/`commit` lifecycle — and asks the
 * public `queryWorkspaceContext` for an answer. Nothing is injected and no lane
 * is called directly.
 *
 * That is deliberate and it is the only level at which these properties exist.
 * A unit test over `markNameAnchors` can prove it sets a bit; it cannot prove
 * that the bit changes what comes back, because the thing that decides that is
 * the interaction of the flag with reciprocal-rank fusion, the traversal's seed
 * strength, the group share cap and the token budget. The recorded failure this
 * work exists to avoid is exactly of that shape: an earlier probe added a
 * *correct* anchor and lost recall on `review-reverse-dependency`, because the
 * anchor and its own children displaced a gold node out of top-k. Every
 * component was right and the join was wrong.
 *
 * Two shapes are pinned, and the refusing one matters more than the admitting
 * one:
 *
 *   - **admits** a query that is one bare token, which is the shape at which
 *     "your query is this node's name" is a claim about the query;
 *   - **refuses** a phrase, even when its individual words name nodes. That is
 *     the shape that took an earlier probe's §4 violation count from 3 to 16
 *     for zero recall, by reading a three-word jargon phrase as six resolved
 *     identifiers.
 *
 * And one invariant runs through all of them: a name match is a *ranking* fact.
 * It never produces a confidence in the exact family, so no case's §4 ceiling
 * can move because of it.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { CANDIDATE_FLAG } from '../kernel.js';
import { changedPathKernelSeeds } from '../changed-path-seeds.js';
import { queryWorkspaceContext } from '../workspace.js';
import { CONTEXT_GRAPH_EXACT_SEED_CONFIDENCES } from '../ranking-config.js';
import {
  buildFixtureSnapshot,
  IDS,
  makeFixtureRoot,
  removeFixtureRoot,
} from './query-fixtures.js';
import {
  materializeSources,
  publishFixtureContextIndex,
  resetContextIndexCache,
} from './workspace-fixtures.js';
import type { WorkspaceContextAnswer } from '../workspace.js';

const SOURCES = [
  'src/app/service.ts',
  'src/app/consumer.ts',
  'src/app/__tests__/service.test.ts',
  'src/legacy/old.ts',
  'src/other/a.ts',
  'src/other/b.ts',
  'src/cli/manifest.ts',
  'config/release-gates.json',
  'config/proofs.json',
] as const;

/** One bare token that is a file's basename. `service.ts` is `src/app/service.ts`. */
const BASENAME_QUERY = 'service.ts';

/** One bare token that is a symbol's label, and nothing's basename. */
const LABEL_QUERY = 'runService';

/**
 * A phrase whose words *are* names — `service` is `service.ts`'s stem and `old`
 * is `old.ts`'s. A gate that admitted per word rather than per query would fire
 * here, which is why the refusal case uses words that would match rather than
 * words that would not: a phrase of nonsense would pass a broken gate too.
 */
const PHRASE_QUERY = 'where does service reach old';

const EXACT_CONFIDENCES = new Set<string>(CONTEXT_GRAPH_EXACT_SEED_CONFIDENCES);

let root = '';

interface Row {
  readonly rank: number;
  readonly nodeId: string;
  readonly named: boolean;
  readonly exactSeed: boolean;
  readonly confidence: string;
}

function rowsOf(answer: WorkspaceContextAnswer): Row[] {
  return answer.kernel.selected.map((candidate, rank) => ({
    rank,
    nodeId: answer.hydration.nodes[rank]?.nodeId ?? '',
    named: (candidate.candidate.flags & CANDIDATE_FLAG.NAME_MATCH) !== 0,
    exactSeed: (candidate.candidate.flags & CANDIDATE_FLAG.EXACT_SEED) !== 0,
    confidence: String(candidate.confidence),
  }));
}

async function ask(query: string, seeds?: readonly string[]): Promise<Row[]> {
  const provided = changedPathKernelSeeds(seeds);
  const answer = await queryWorkspaceContext(root, {
    query,
    profile: 'implementation',
    ...(provided.length === 0 ? {} : { seeds: provided }),
  }, { clock: () => 0 });
  return rowsOf(answer);
}

describe('label and basename anchoring, through the published index', () => {
  before(async () => {
    resetContextIndexCache();
    root = makeFixtureRoot('name-anchors');
    materializeSources(root, SOURCES);
    await publishFixtureContextIndex(root, buildFixtureSnapshot());
  });

  after(() => {
    resetContextIndexCache();
    if (root !== '') removeFixtureRoot(root);
  });

  it('admits a bare basename and ranks the file it names first', async () => {
    const rows = await ask(BASENAME_QUERY);
    const named = rows.filter((row) => row.named);
    assert.ok(named.length > 0, 'a bare basename must name at least the file it belongs to');
    assert.ok(
      named.some((row) => row.nodeId === IDS.fileService),
      'the file whose basename is the query must be named by it',
    );
    // The property is ordering, not membership: the release record's whole point
    // is that these nodes were already returned and ranked out.
    const lastNamed = Math.max(...named.map((row) => row.rank));
    const firstOther = rows.find((row) => !row.named && !row.exactSeed)?.rank ?? Number.POSITIVE_INFINITY;
    assert.ok(
      firstOther > lastNamed,
      `every named candidate must outrank every merely-well-scored one (last named ${lastNamed}, first other ${firstOther})`,
    );
  });

  it('admits a bare label and pulls the file it is written in up with it', async () => {
    const rows = await ask(LABEL_QUERY);
    const symbol = rows.find((row) => row.nodeId === IDS.symbolRun);
    assert.ok(symbol !== undefined, 'the symbol whose label is the query must be selected');
    assert.equal(symbol.named, true, 'a bare label is a name');

    // The seed-strength half of the change, and the half a membership assertion
    // cannot see: the file is in the answer either way. What the name match buys
    // is that the walk seeds from the named symbol at its own strength, so the
    // file it defines inherits a score that carries it past every node the query
    // reached only through text. Without that, the file lands *below* six
    // unrelated ones and a caller asking about a symbol is shown everything but
    // where it lives.
    const file = rows.find((row) => row.nodeId === IDS.fileService);
    assert.ok(file !== undefined, 'the named symbol must pull its own file into the answer');
    const firstUnrelated = rows.find((row) => !row.named && row.nodeId !== IDS.fileService)?.rank
      ?? Number.POSITIVE_INFINITY;
    assert.ok(
      file.rank < firstUnrelated,
      `the named symbol's own file must outrank every node the query only scored (file ${file.rank}, first unrelated ${firstUnrelated})`,
    );
  });

  it('refuses a phrase, even when its words name nodes', async () => {
    const rows = await ask(PHRASE_QUERY);
    assert.deepEqual(
      rows.filter((row) => row.named).map((row) => row.nodeId),
      [],
      'a phrase must not produce anchor-grade seeds; the recorded cost of that is 12 §4 violations for zero recall',
    );
    // The words really are names — otherwise the assertion above would pass on a
    // gate that was simply broken in the other direction.
    const single = await ask('service');
    assert.ok(
      single.some((row) => row.named),
      'the same word as a whole query must anchor, or the refusal above proves nothing',
    );
  });

  it('never claims a confidence in the exact family for a name match', async () => {
    for (const query of [BASENAME_QUERY, LABEL_QUERY, 'service', 'old.ts']) {
      for (const row of await ask(query)) {
        if (!row.named || row.exactSeed) continue;
        assert.ok(
          !EXACT_CONFIDENCES.has(row.confidence),
          `${query}: ${row.nodeId} was named, not resolved, and claimed ${row.confidence}`,
        );
      }
    }
  });

  it('places a caller-resolved seed above every node the query merely names', async () => {
    const rows = await ask(BASENAME_QUERY, ['src/other/a.ts']);
    const seedRank = rows.find((row) => row.nodeId === IDS.fileOtherA)?.rank;
    assert.ok(seedRank !== undefined, 'a caller-supplied changed path must reach the answer');
    const namedOnly = rows.filter((row) => row.named && !row.exactSeed).map((row) => row.rank);
    assert.ok(namedOnly.length > 0, 'the query must still name something, or the ordering is untested');
    assert.ok(
      seedRank < Math.min(...namedOnly),
      `an identifier the caller resolved outranks one the query named (seed ${seedRank}, first named ${Math.min(...namedOnly)})`,
    );
  });

  it('is stable across repeats, so the flag adds no ordering nondeterminism', async () => {
    const first = await ask(BASENAME_QUERY);
    const second = await ask(BASENAME_QUERY);
    assert.deepEqual(second, first);
  });
});
