/**
 * Index state, lifecycle, budget, determinism and cache cases.
 *
 * The rejection cases come first. ADR §1 forbids a silent downgrade to a slower
 * path and ADR §5 gives every failure one named repair command, so a missing,
 * stale, corrupt or too-new index is an error rather than a thinner answer.
 * Corrupt-input rejection is an equality floor at 100%: one index that answers
 * instead of refusing fails the run, and a best-effort partial read counts as
 * answering.
 *
 * The lifecycle cases check that the incremental compile path produces the same
 * answer as a full one — a 50% compile-time target bought with drift is not a
 * target met. The budget, determinism and cache cases close the loop:
 * `budget-no-matching-seed` is the one case where empty is the correct answer,
 * which is what anchors the `fast_but_empty` verdict everywhere else.
 */
import type { Crk2Case } from './crk2-types.js';
import {
  CRK2_DEFAULT_K,
  EMPTY_GOLD,
  FORMAT,
  JOURNAL,
  KERNEL,
  LEGACY_JSON,
  LEXICON,
  READER,
  SCORER,
  faultCase,
  file,
  gate,
  symbolAt
} from './crk2-corpus-workspace.js';

const STATE_CASES: readonly Crk2Case[] = [
  faultCase(
    'corrupt-header-magic',
    'index header magic is wrong',
    'compileContextIndex',
    'context_index_checksum_mismatch',
    'ADR §5: a header that fails validation is rejected with a repair command, never partially read.'
  ),
  faultCase(
    'corrupt-section-checksum',
    'a section checksum does not match its bytes',
    'readSectionDescriptor',
    'context_index_checksum_mismatch',
    'A section that hashes wrong is corrupt even when every offset is in range.'
  ),
  faultCase(
    'corrupt-truncated-binary',
    'declared section length exceeds the file',
    KERNEL,
    'context_index_truncated',
    'Truncation is the cheapest way to make a reader walk off the end of the buffer.'
  ),
  faultCase(
    'corrupt-oversized-count',
    'a node count large enough to exhaust memory',
    'reader.ts',
    'context_index_truncated',
    'Work order §1.4 requires an oversized count to be refused rather than allocated against.'
  ),
  faultCase(
    'index-state-missing-pointer',
    'no current index pointer exists',
    'frontierBudget',
    'context_index_missing',
    'ADR §1 forbids a silent downgrade to a slower path; a missing index is an error with a repair command.',
    'index_state'
  ),
  faultCase(
    'index-state-stale-pointer',
    'the pointer snapshot hash does not match the workspace',
    'compileContextIndex',
    'context_index_stale',
    'A stale index answering anyway is the silent-fallback failure the ADR exists to prevent.',
    'index_state'
  ),
  faultCase(
    'index-state-pointer-meta-divergent',
    'pointer and meta disagree on the snapshot hash',
    'reader.ts',
    'context_index_pointer_meta_divergent',
    'ADR §6: divergence is an error, not a preference for whichever record looks newer.',
    'index_state'
  ),
  faultCase(
    'lifecycle-journal-corrupt',
    'the operation journal cannot be parsed',
    'align run',
    'context_operation_journal_corrupt',
    'A journal that cannot be replayed makes incremental compile unattestable.',
    'lifecycle'
  ),
  faultCase(
    'index-state-format-unsupported',
    'format revision is newer than this reader',
    KERNEL,
    'context_index_format_unsupported',
    'ADR §2: a reader that meets an unknown revision fails closed instead of attempting a partial read.',
    'index_state'
  )
];

const LIFECYCLE_CASES: readonly Crk2Case[] = [
  {
    id: 'lifecycle-one-file-incremental',
    title: 'one file changed since the last compile',
    query: 'what does the lexicon change affect',
    category: 'lifecycle',
    workspace: 'crk2-retrieval',
    profile: 'review',
    changedPaths: [LEXICON],
    focusPaths: [],
    tokenBudget: 8000,
    risk: 'normal',
    k: CRK2_DEFAULT_K,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [file(LEXICON), file(KERNEL)],
      relevantNodeIds: [file('src/core/triwiki/context-graph/__tests__/lexicon.test.ts'), file(JOURNAL)]
    },
    rationale: 'The incremental path must produce the same answer as a full compile, or the 50% target is bought with drift.'
  },
  {
    id: 'lifecycle-file-deletion',
    title: 'a file that no longer exists',
    query: 'src/core/triwiki/context-graph/runtime-index/removed-scorer.ts',
    category: 'lifecycle',
    workspace: 'crk2-retrieval',
    profile: 'implementation',
    changedPaths: [],
    focusPaths: [],
    tokenBudget: 4000,
    risk: 'normal',
    k: 5,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [],
      relevantNodeIds: [file(SCORER)],
      forbiddenNodeIds: [file(LEGACY_JSON)]
    },
    rationale: 'A deleted path must leave no node behind; a dangling hit here is a dangling-edge failure with a friendly face.'
  },
  {
    id: 'lifecycle-file-rename',
    title: 'a file reachable only under its new name',
    query: 'bm25f-scorer.ts',
    category: 'lifecycle',
    workspace: 'crk2-retrieval',
    profile: 'implementation',
    changedPaths: [SCORER],
    focusPaths: [],
    tokenBudget: 4000,
    risk: 'normal',
    k: 5,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [file(SCORER)]
    },
    rationale: 'After a rename the old basename must stop resolving and the new one must start; a merged index gets both wrong.'
  },
  {
    id: 'lifecycle-gate-manifest-change',
    title: 'the gate manifest itself changed',
    query: 'which gates changed in this manifest edit',
    category: 'lifecycle',
    workspace: 'crk2-retrieval',
    profile: 'review',
    changedPaths: ['release-gates.v2.json'],
    focusPaths: [],
    tokenBudget: 8000,
    risk: 'high',
    k: CRK2_DEFAULT_K,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [file('release-gates.v2.json'), gate('release-proof-integrity')],
      gateIds: ['release-proof-integrity', 'secret-redaction', 'write-scope-isolation'],
      protectedGateIds: ['release-proof-integrity', 'secret-redaction', 'write-scope-isolation']
    },
    rationale: 'When the manifest moves, every protected gate it declares has to come back, not just the one whose text changed.'
  }
];

const BUDGET_AND_REPEAT_CASES: readonly Crk2Case[] = [
  {
    id: 'budget-token-budget-too-small',
    title: 'a token budget smaller than one answer',
    query: 'what imports the binary format module',
    category: 'budget',
    workspace: 'crk2-retrieval',
    profile: 'implementation',
    changedPaths: [],
    focusPaths: [],
    tokenBudget: 120,
    risk: 'normal',
    k: 2,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [file(FORMAT)],
      maxTokenCost: 120
    },
    rationale: 'Under an impossible budget the answer must shrink truthfully; overspending would make every budget advisory.'
  },
  {
    id: 'budget-no-matching-seed',
    title: 'a query nothing in the workspace answers',
    query: 'quantum teleportation scheduler',
    category: 'budget',
    workspace: 'crk2-retrieval',
    profile: 'implementation',
    changedPaths: [],
    focusPaths: [],
    tokenBudget: 6000,
    risk: 'normal',
    k: 5,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [],
      forbiddenNodeIds: [file(KERNEL), file(FORMAT), file(LEGACY_JSON)],
      maxTokenCost: 600,
      confidenceCeiling: 'text_candidate'
    },
    rationale: 'Empty is the correct answer here — and the only case where it is. It anchors the fast-but-empty comparison verdict.'
  },
  {
    id: 'determinism-repeat-identical-answer',
    title: 'the same query a hundred times',
    query: 'hydrateNode',
    category: 'determinism',
    workspace: 'crk2-retrieval',
    profile: 'implementation',
    changedPaths: [],
    focusPaths: [],
    tokenBudget: 6000,
    risk: 'normal',
    k: CRK2_DEFAULT_K,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [file(READER)],
      mustIncludeMatchers: [symbolAt(READER, 'hydrateNode')]
    },
    rationale: 'Work order §12.1 requires 0 mismatches in 100 repeats; the harness compares full answer signatures, not just membership.'
  },
  {
    id: 'determinism-tie-break-stability',
    title: 'candidates that tie on score',
    query: 'index.ts',
    category: 'determinism',
    workspace: 'crk2-retrieval',
    profile: 'implementation',
    changedPaths: [],
    focusPaths: [],
    tokenBudget: 6000,
    risk: 'normal',
    k: CRK2_DEFAULT_K,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [
        file('src/core/triwiki/context-graph/index.ts'),
        file('src/core/triwiki/context-graph/query/index.ts'),
        file('src/core/triwiki/context-graph/runtime-index/index.ts')
      ]
    },
    rationale: 'Three identically-named files tie on every field, so ordering can only come from the id comparator.'
  },
  {
    id: 'cache-multi-workspace-eviction',
    title: 'a repeated query after another workspace evicted the cache',
    query: 'readSectionDescriptor',
    category: 'cache',
    workspace: 'crk2-retrieval',
    profile: 'implementation',
    changedPaths: [],
    focusPaths: [],
    tokenBudget: 6000,
    risk: 'normal',
    k: CRK2_DEFAULT_K,
    gold: {
      ...EMPTY_GOLD,
      mustIncludeNodeIds: [file(FORMAT)],
      mustIncludeMatchers: [symbolAt(FORMAT, 'readSectionDescriptor')]
    },
    rationale: 'An evicted byte-budget cache must reload rather than answer from a partial residue; the answer cannot change.'
  }
];

/** Rejection, lifecycle, budget, determinism and cache cases, in their authored order. */
export const CRK2_STATE_CASES: readonly Crk2Case[] = [
  ...STATE_CASES,
  ...LIFECYCLE_CASES,
  ...BUDGET_AND_REPEAT_CASES
];
