/**
 * Two measurements about node metadata that look alike and have opposite
 * dispositions. Both are here because reasoning about either one produced the
 * wrong answer, and measuring produced the right one.
 *
 * **1. Metadata values used to lose their type through the writer — fixed in
 * format revision 2, and still measured.** Revision 1 interned a value as
 * `Array.isArray(value) ? value.join(',') : String(value)` and the reader handed
 * back `Record<string, string>`, so a boolean `true` written by an extractor
 * arrived as the string `"true"` and every consumer asking `metadata.isTest ===
 * true` silently stopped matching; a string array was joined on a comma the
 * value could itself contain, unreversibly. Measured at 11 lost predicates
 * across 9 fixture families. Revision 2's 16-byte metadata row carries a type
 * tag, and the counts below now have to agree rather than differ.
 *
 * The measurement is kept, not deleted, and its assertions were inverted instead.
 * The failure it guards is invisible by construction — a lost predicate makes a
 * test selector choose *fewer* tests and the suite run *faster* — so the number
 * that proves it is absent is worth more than the number that proved it present.
 * `contextNodeFlag` is kept for the same reason: extractors author these flags
 * as booleans *and* as text, so the helper reads both.
 *
 * **2. The protected-gate metadata flags are unreachable, not merely untested.**
 * The release record asked for a fixture family exercising a gate protected only
 * by `requiredForPublish` / `alwaysOnRelease`, with `risk !== 'protected'`. That
 * fixture cannot exist. `buildGateNodes` sets the metadata flag and
 * `risk: gateRisk(...)` in the *same* `addNode` call, and each flag's source set
 * is one of `gateRisk`'s disjuncts — so the flag being true *implies*
 * `risk === 'protected'`, with no path between them. A fixture built for that
 * shape would emit an ordinary protected gate and pass while proving nothing,
 * which is worse than leaving the arm untested, because the green result would
 * then be cited as evidence. `measureProtectedGateFlagReachability` proves the
 * implication exhaustively over the real manifest instead, and covers all three
 * flags — `nonRecursive` is the same disjunct and would be born unreachable too.
 */
import {
  ALWAYS_ON_GATES,
  FORBIDDEN_RECURSIVE_GATES,
  REQUIRED_FOR_PUBLISH,
} from '../../../release/gate-manifest.js';
import type { ContextGraphMetadataValue, ContextGraphSnapshot } from '../contracts.js';
import { isProtectedGate } from '../extractors/topology/gates.js';
import { CONTEXT_GRAPH_LEXICON_CONFIG } from '../query/ranking-config.js';
import { contextNodeFlag } from '../query/index.js';
import { openContextIndex } from '../runtime-index/reader.js';
import { encodeContextIndex } from '../runtime-index/writer.js';

/** The metadata value types the contract allows. Under revision 2, all five survive. */
export type Crk2MetadataValueType = 'string' | 'boolean' | 'number' | 'null' | 'string_array';

function valueTypeOf(value: ContextGraphMetadataValue): Crk2MetadataValueType {
  if (Array.isArray(value)) return 'string_array';
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  return 'string';
}

export interface Crk2MetadataTypeLoss {
  /** Metadata entries the snapshot authored, by authored JS type. */
  readonly authored: Readonly<Record<Crk2MetadataValueType, number>>;
  /** Entries whose value arrives from the reader with its authored type intact. */
  readonly preserved: Readonly<Record<Crk2MetadataValueType, number>>;
  /** `=== true` predicate matches on the snapshot side. */
  readonly booleanTruePredicatesV1: number;
  /** The same predicate against the reader's view. Structurally zero before revision 2. */
  readonly booleanTruePredicatesV2: number;
  /** The same predicate read through the `contextNodeFlag` workaround. */
  readonly booleanTruePredicatesViaFlag: number;
  /** String arrays whose own values contain the join separator, so the join is irreversible. */
  readonly ambiguousArrayJoins: number;
  /** Distinct metadata keys that lost at least one predicate. */
  readonly lostKeys: readonly string[];
}

const EMPTY_COUNTS: Readonly<Record<Crk2MetadataValueType, number>> = Object.freeze({
  string: 0,
  boolean: 0,
  number: 0,
  null: 0,
  string_array: 0,
});

/**
 * Round-trip one snapshot through the real writer and reader and count what the
 * types cost.
 *
 * The comparison is against the snapshot the compiler produced, not against a
 * hand-written expectation: an expectation written by the same hand that wrote
 * the fixture would agree with itself.
 */
export function measureMetadataTypeLoss(snapshot: ContextGraphSnapshot): Crk2MetadataTypeLoss {
  const bytes = encodeContextIndex({
    snapshot,
    configHash: new Uint8Array(32).fill(0x11),
    schemaRevision: 1,
    lexicon: CONTEXT_GRAPH_LEXICON_CONFIG,
  }).bytes;
  const reader = openContextIndex(bytes);

  const authored: Record<Crk2MetadataValueType, number> = { ...EMPTY_COUNTS };
  const preserved: Record<Crk2MetadataValueType, number> = { ...EMPTY_COUNTS };
  const lostKeys = new Set<string>();
  let booleanTrueV1 = 0;
  let booleanTrueV2 = 0;
  let booleanTrueViaFlag = 0;
  let ambiguousArrayJoins = 0;

  const viewByNodeId = new Map<string, ReturnType<typeof reader.hydrateNode>>();
  for (let index = 0; index < reader.nodeCount; index += 1) {
    const view = reader.hydrateNode(index);
    viewByNodeId.set(view.id, view);
  }

  for (const node of snapshot.nodes) {
    const view = viewByNodeId.get(node.id);
    for (const [key, value] of Object.entries(node.metadata)) {
      const type = valueTypeOf(value);
      authored[type] += 1;
      const readBack: unknown = view?.metadata[key];
      // `typeof readBack === typeof value` would call `null` an object and pass;
      // the authored type is what a consumer's predicate is written against.
      if (type === 'string') {
        if (typeof readBack === 'string' && readBack === value) preserved.string += 1;
        else lostKeys.add(key);
      }
      if (type === 'boolean') {
        // Both polarities are counted as preserved. Only `true` feeds the
        // predicate counts, because `=== true` is the predicate the release
        // record measured — but a writer that turned `false` into `'false'`
        // would break `!== true` consumers just as silently, so the loss set
        // sees both.
        if (readBack === value) preserved.boolean += 1;
        else lostKeys.add(key);
        if (value === true) {
          booleanTrueV1 += 1;
          if ((readBack as unknown) === true) booleanTrueV2 += 1;
          if (view && contextNodeFlag(view, key)) booleanTrueViaFlag += 1;
        }
      }
      if (type === 'string_array') {
        // Element-wise, not `Array.isArray`. A writer that handed back an array
        // of the wrong length, or with the elements reordered, would satisfy the
        // shape check while losing exactly the information the join used to
        // lose.
        const authored = value as readonly string[];
        if (
          Array.isArray(readBack)
          && readBack.length === authored.length
          && authored.every((item, at) => readBack[at] === item)
        ) preserved.string_array += 1;
        else lostKeys.add(key);
        if (authored.some((item) => item.includes(','))) ambiguousArrayJoins += 1;
      }
      if (type === 'number') {
        if (typeof readBack === 'number' && (readBack === value || (Number.isNaN(readBack) && Number.isNaN(value)))) {
          preserved.number += 1;
        } else lostKeys.add(key);
      }
      if (type === 'null') {
        if (readBack === null) preserved.null += 1;
        else lostKeys.add(key);
      }
    }
  }

  return {
    authored: Object.freeze(authored),
    preserved: Object.freeze(preserved),
    booleanTruePredicatesV1: booleanTrueV1,
    booleanTruePredicatesV2: booleanTrueV2,
    booleanTruePredicatesViaFlag: booleanTrueViaFlag,
    ambiguousArrayJoins,
    lostKeys: [...lostKeys].sort(),
  };
}

export interface Crk2MetadataGapEntry {
  readonly label: string;
  readonly loss: Crk2MetadataTypeLoss;
}

export interface Crk2MetadataGapReport {
  readonly entries: readonly Crk2MetadataGapEntry[];
  /** Sources that authored at least one `=== true` predicate. */
  readonly sourcesWithTruePredicates: number;
  readonly booleanTruePredicatesV1: number;
  readonly booleanTruePredicatesV2: number;
  readonly booleanTruePredicatesViaFlag: number;
  readonly ambiguousArrayJoins: number;
  readonly lostKeys: readonly string[];
  /** True when every authored boolean `true` survives as a boolean. The format-level fix. */
  readonly typePreserved: boolean;
  /** True when the consumer-level workaround recovers every lost predicate. */
  readonly workaroundComplete: boolean;
}

/** Aggregate per-source measurements into the number the release notes carry. */
export function summarizeCrk2MetadataGap(entries: readonly Crk2MetadataGapEntry[]): Crk2MetadataGapReport {
  const lostKeys = new Set<string>();
  let v1 = 0;
  let v2 = 0;
  let viaFlag = 0;
  let ambiguous = 0;
  let sourcesWithTruePredicates = 0;
  for (const entry of entries) {
    v1 += entry.loss.booleanTruePredicatesV1;
    v2 += entry.loss.booleanTruePredicatesV2;
    viaFlag += entry.loss.booleanTruePredicatesViaFlag;
    ambiguous += entry.loss.ambiguousArrayJoins;
    if (entry.loss.booleanTruePredicatesV1 > 0) sourcesWithTruePredicates += 1;
    for (const key of entry.loss.lostKeys) lostKeys.add(key);
  }
  return {
    entries,
    sourcesWithTruePredicates,
    booleanTruePredicatesV1: v1,
    booleanTruePredicatesV2: v2,
    booleanTruePredicatesViaFlag: viaFlag,
    ambiguousArrayJoins: ambiguous,
    lostKeys: [...lostKeys].sort(),
    typePreserved: v1 === v2,
    workaroundComplete: v1 === viaFlag,
  };
}

// ---------------------------------------------------------------------------
// The protected-gate flags
// ---------------------------------------------------------------------------

export interface Crk2FlagReachability {
  readonly flag: 'requiredForPublish' | 'alwaysOnRelease' | 'nonRecursive';
  readonly gateIds: number;
  /** Gate ids carrying the flag that `gateRisk` would *not* classify protected. */
  readonly counterexamples: readonly string[];
}

export interface Crk2ProtectedGateReachability {
  readonly flags: readonly Crk2FlagReachability[];
  readonly totalCounterexamples: number;
  /**
   * True when no flag can be true on a node whose risk is not `protected` — i.e.
   * the metadata arm of `isProtectedGateNode` is unreachable from a compiled
   * graph, and no fixture can exercise it.
   */
  readonly metadataArmUnreachable: boolean;
}

/**
 * Exhaustive, not sampled.
 *
 * Every id in each manifest set is classified under the weakest inputs the code
 * allows — no declared protection and no dependents — because those are the only
 * inputs under which a counterexample could exist. A sampled check here would be
 * the same mistake that produced the fixture request: a claim about every id,
 * evidenced by some of them.
 */
export function measureProtectedGateFlagReachability(): Crk2ProtectedGateReachability {
  const noDependents: ReadonlySet<string> = new Set();
  const sets: ReadonlyArray<readonly [Crk2FlagReachability['flag'], ReadonlySet<string>]> = [
    ['requiredForPublish', REQUIRED_FOR_PUBLISH],
    ['alwaysOnRelease', ALWAYS_ON_GATES],
    ['nonRecursive', FORBIDDEN_RECURSIVE_GATES],
  ];
  const flags = sets.map(([flag, ids]) => ({
    flag,
    gateIds: ids.size,
    counterexamples: [...ids].filter((id) => !isProtectedGate(id, noDependents, false)).sort(),
  }));
  const totalCounterexamples = flags.reduce((sum, entry) => sum + entry.counterexamples.length, 0);
  return { flags, totalCounterexamples, metadataArmUnreachable: totalCounterexamples === 0 };
}
