/**
 * Identifier-aware lexicon: the compile-time half of lexical retrieval.
 *
 * This file is the public entry point and holds no logic of its own. Importers
 * outside `runtime-index/` — `query/ranking-config.ts` among them — depend on
 * this path and should not have to know which module a symbol lives in.
 *
 *   `lexicon-contract.ts`   field identity, config shape, refusal, ordering
 *   `lexicon-text.ts`       character classes, path redaction, secret detection
 *   `lexicon-tokenizer.ts`  the single tokenizer and the query normalizer
 *   `lexicon-bm25.ts`       scoring arithmetic and fixed-point conversion
 *   `lexicon-builder.ts`    term table, postings, and the binary search
 *
 * Two properties hold across all five, and each module's header states the part
 * it is responsible for:
 *
 *   - **Determinism.** The index is addressed by its own content hash, so the
 *     same snapshot must compile to the same bytes anywhere. Ordering is by
 *     code unit, character classification is by explicit code-point range, and
 *     scores come from exactly-specified floating-point operations only. Each
 *     of those replaces something — `localeCompare`, `\p{...}`, `Math.log` —
 *     that the spec or ICU permits to vary between builds.
 *   - **A BM25F score is never evidence of a relation.** §4 of the contract
 *     fixes lexical results at `text_candidate` at any magnitude. The
 *     canonical-id field is not tokenizable, postings carry no confidence
 *     field, and an unsupported-language hit is a candidate like any other.
 *     The v1 baseline returned nothing for Korean and jargon queries, and the
 *     tempting fix is to let a strong text match claim `exact`; that is the
 *     violation this arrangement is built to make unavailable.
 *
 * Security (work order §1.4) is enforced in `lexicon-text.ts` and applied by
 * the tokenizer: machine paths are refused on path-shaped fields and redacted
 * from free text, high-entropy tokens are dropped, and errors carry a code and
 * integers so a rejection never echoes the text it rejected.
 */
export * from './lexicon-contract.js';
export * from './lexicon-text.js';
export * from './lexicon-tokenizer.js';
export * from './lexicon-bm25.js';
export * from './lexicon-builder.js';
