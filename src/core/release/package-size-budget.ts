/**
 * Packed tarball ceiling; slight headroom above the measured Context Graph surface.
 *
 * The compiled Context Graph engine — extractors, compiler, store, lint, query,
 * projections — is required at runtime: `sks search context`,
 * `sks wiki refresh --code`, TriWiki attention and the Naruto advisory all read
 * it from an installed package. Its benchmark corpus, fixtures and tuning
 * optimizer are development instruments and are excluded from the packlist
 * instead of being paid for here.
 */
export const DEFAULT_MAX_PACK_BYTES = 2725 * 1024
/** ~11.92 MiB; narrow headroom above the measured Desktop bridge and capability runtime surface. */
export const DEFAULT_MAX_UNPACKED_BYTES = 12_500_000
