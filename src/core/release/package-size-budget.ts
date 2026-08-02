/**
 * Packed tarball ceiling; slight headroom above the measured Context Graph surface.
 *
 * The compiled Context Graph engine — extractors, compiler, store, lint, query,
 * projections — is required at runtime: `sks search context`,
 * `sks wiki refresh --code`, TriWiki attention and the Naruto advisory all read
 * it from an installed package. Its benchmark corpus, fixtures and tuning
 * optimizer are development instruments and are excluded from the packlist
 * instead of being paid for here.
 *
 * 8.0.4 re-measure: the complete BotFather/Center runtime, retained audit
 * segments, crash-safe cross-language state lock and bot-bound state are
 * installed runtime code. Native tests and development-only fixture modules
 * are excluded. The measured package is 2,880,480 packed / 12,980,920
 * unpacked across 1,624 files.
 */
export const DEFAULT_MAX_PACK_BYTES = 2850 * 1024
/** ~12.45 MiB; narrow headroom above the measured Desktop bridge, capability and Telegram runtime surface. */
export const DEFAULT_MAX_UNPACKED_BYTES = 13_050_000
