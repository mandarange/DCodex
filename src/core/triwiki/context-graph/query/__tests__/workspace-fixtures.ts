/**
 * A real compiled generation on disk, for the CG2-13 consumer integration tests.
 *
 * Every consumer under migration is supposed to answer *through the facade*, and
 * the only way to prove that is to give it a workspace that actually has a v2
 * index in it — pointer, meta, and a content-addressed `.idx` — and then call the
 * consumer's own public entry point with nothing injected.
 *
 * Two deliberate choices:
 *
 * - **The index is built with `runtime-index/writer.ts` directly, not through the
 *   CG2-12 compiler.** A parity fixture should be produced by the simplest thing
 *   that yields a valid index. Routing it through the compiler would make a
 *   compiler defect show up as a consumer parity failure, and a defect that
 *   happened to be symmetric would produce matching before/after output and hide
 *   a real break.
 * - **The generation is published through the real store lifecycle**
 *   (`begin` → `stage` → `commit`), not by hand-writing pointer JSON. The pointer
 *   and meta agreeing is exactly what the read path checks, so a fixture that
 *   wrote them itself would be testing the test.
 *
 * Roots are `fs.mkdtemp` directories under `os.tmpdir()` and are removed by the
 * caller; nothing here touches the operator's HOME.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ContextGraphSnapshot } from '../../contracts.js';
import { encodeContextIndex } from '../../runtime-index/writer.js';
import {
  beginContextIndexOperation,
  commitContextIndexGeneration,
  stageContextIndexGeneration,
} from '../../store/generation-commit.js';
import { CONTEXT_GRAPH_LEXICON_CONFIG } from '../ranking-config.js';
import { setSharedContextIndexCache } from '../cache.js';

/** Fixed so a fixture's config fingerprint is stable across runs and machines. */
const FIXTURE_CONFIG_HASH = new Uint8Array(32).fill(7);

/**
 * The header's numeric schema revision, which is not the product's `1.0.0`
 * schema string. They are different identifiers and the writer takes the number.
 */
const FIXTURE_SCHEMA_REVISION = 1;

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export interface PublishedContextIndex {
  readonly snapshotHash: string;
  readonly sourceFingerprint: string;
  readonly indexBytes: number;
}

/**
 * Compile `snapshot` into `root`'s generation store and make it current.
 *
 * `sourceFingerprint` defaults to a digest of the snapshot hash, which is what
 * makes a rebuilt fixture look like a genuinely different workspace state rather
 * than the same one recompiled.
 */
export async function publishFixtureContextIndex(
  root: string,
  snapshot: ContextGraphSnapshot,
  options: { readonly sourceFingerprint?: string; readonly now?: string } = {},
): Promise<PublishedContextIndex> {
  const encoded = encodeContextIndex({
    snapshot,
    configHash: FIXTURE_CONFIG_HASH,
    schemaRevision: FIXTURE_SCHEMA_REVISION,
    // Required, not incidental. `lexicon` is optional with no default, and
    // omitting it emits four empty dictionary sections — an index whose anchor
    // lane works and whose lexical and coarse lanes return nothing. A consumer
    // test built on such a fixture passes while proving that text retrieval is
    // broken, so the fixture must pass the same config the compiler does.
    lexicon: CONTEXT_GRAPH_LEXICON_CONFIG,
  });
  const sourceFingerprint =
    options.sourceFingerprint ?? crypto.createHash('sha256').update(snapshot.snapshotHash).digest('hex');

  const journal = await beginContextIndexOperation(root, {
    targetSnapshotHash: snapshot.snapshotHash,
    configFingerprint: hex(FIXTURE_CONFIG_HASH),
    sourceFingerprint,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const staged = await stageContextIndexGeneration(root, journal, encoded.bytes);
  await commitContextIndexGeneration(root, staged, {
    lint: { passed: true, errorCount: 0, warningCount: 0 },
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  return {
    snapshotHash: snapshot.snapshotHash,
    sourceFingerprint,
    indexBytes: encoded.bytes.byteLength,
  };
}

/**
 * Drop the process-wide index cache.
 *
 * Required between fixtures, not merely tidy: the cache is keyed by workspace
 * digest and snapshot hash, and two fixtures that publish the same snapshot into
 * two temp roots are distinct keys — but a suite that reuses one root across
 * cases would otherwise serve the previous case's reader.
 */
export function resetContextIndexCache(): void {
  setSharedContextIndexCache(null);
}

/** Materialize the files a snapshot's provenance records point at. */
export function materializeSources(root: string, relatives: readonly string[]): void {
  for (const relative of relatives) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, `// ${relative}\n`, 'utf8');
  }
}
