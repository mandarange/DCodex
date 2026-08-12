/**
 * SKSCG2 binary index format — public surface.
 *
 * The index is a generated cache that a reader indexes into by offset, which
 * makes every count and offset in the file a security boundary rather than a
 * hint. A truncated length, an overlapping section, or a CSR row that walks
 * backwards is enough to read outside the buffer or to size an allocation from
 * a number an attacker chose. So the parser treats a file we wrote ourselves as
 * hostile input: a volume that filled mid-write, a bad sector, or a crash
 * produces exactly the same bytes as malice would.
 *
 * It refuses rather than repairs. There is deliberately no best-effort salvage
 * path, because an index a reader guessed at is an index whose results nothing
 * can attest to.
 *
 * `formatRevision` is a property of the layout, never of the product. A release
 * that does not change the layout must produce byte-identical indexes.
 *
 * The implementation is split across four modules to stay inside this repo's
 * new-file budget; this file is the only import path callers should use.
 */
export * from './format-contract.js';
export * from './format-primitives.js';
export * from './format-header.js';
export * from './format-sections.js';
