/**
 * "Is this node named exactly this?" — the only text question the ranking path
 * is allowed to ask about a node.
 *
 * ## Why the reader answers it, and why it is not `hydrateNode`
 *
 * A node's label and path are string-table ids in its row. The kernel holds a
 * `ContextIndexReader`, not the geometry, so it cannot reach either — and the
 * one member that would give it them, `hydrateNode`, is forbidden on the
 * ranking path for a reason that still holds here: it builds a whole object,
 * decodes every metadata pair, and would be called in a loop. So the predicate
 * is answered where the bytes are, and it hands back a boolean rather than a
 * string, which is what keeps it from becoming the `getNode()` §3 deleted.
 *
 * ## What counts as a name
 *
 * Three keys, and deliberately not a fourth:
 *
 *   - the node's `label`;
 *   - its path's POSIX basename (`src/a/reader.ts` -> `reader.ts`);
 *   - that basename without its final extension (`context_graph_smoke.py` ->
 *     `context_graph_smoke`), because the stem is the form a developer types
 *     and the tokenizer never emits it as a term for a `_`-separated stem.
 *
 * A symbol node carries the path of the file it is written in, so the last two
 * name every symbol in the file as well as the file itself. That is stated
 * rather than filtered out: a caller who types `reader.ts` is asking about its
 * contents, and the symbols in it are the contents. It does mean the count of
 * matches for a filename is the file plus its symbols, not one.
 *
 * The whole path is **not** here. It is the anchor lane's own key
 * (`basenamePostings`), it is the one of these that legitimately claims exact
 * confidence, and answering it twice would let one node be counted as both an
 * anchor and a name.
 *
 * ## What this is not
 *
 * It is not evidence of an exact relation. It says the caller's token and one of
 * the node's names are the same string — nothing about why. Two files can share
 * a basename, a symbol and a directory can share a stem, and a label is prose
 * often enough that a match on it is a coincidence as easily as an
 * identification. §4 gives `exact` to a *resolved identifier*, and a name is not
 * resolved by being typed. Callers use this to rank, never to claim.
 *
 * ## Cost
 *
 * Byte comparison against the string blob, with no decode and no allocation.
 * The probe is encoded once by the caller and reused across nodes; a node whose
 * label length differs from the probe's is rejected on two `u32` reads.
 */
import { CONTEXT_INDEX_NO_VALUE } from './writer.js';
import { NODE_LABEL_AT, NODE_PATH_AT, type ContextIndexGeometry } from './reader-layout.js';

const SLASH = 0x2f;
const DOT = 0x2e;

const nameEncoder = new TextEncoder();

/** UTF-8 bytes of a name, encoded once so a scan over candidates allocates nothing. */
export type ContextIndexNameProbe = Uint8Array;

export function contextIndexNameProbe(name: string): ContextIndexNameProbe {
  return nameEncoder.encode(name);
}

/**
 * The string's byte range inside the blob. The table stores end offsets, so a
 * string's start is the previous entry's end — the same rule `stringAt` decodes
 * by, kept in integers here.
 */
function stringStart(geometry: ContextIndexGeometry, id: number): number {
  return id === 0 ? 0 : geometry.view.getUint32(geometry.stringIndexBase + (id - 1) * 4, true);
}

function stringEnd(geometry: ContextIndexGeometry, id: number): number {
  return geometry.view.getUint32(geometry.stringIndexBase + id * 4, true);
}

/** Byte equality over `[start, end)` of the blob. Valid UTF-8 makes this string equality. */
function blobEquals(
  geometry: ContextIndexGeometry,
  start: number,
  end: number,
  probe: ContextIndexNameProbe,
): boolean {
  if (end - start !== probe.length) return false;
  const base = geometry.stringBlobBase + start;
  for (let index = 0; index < probe.length; index += 1) {
    if (geometry.bytes[base + index] !== probe[index]) return false;
  }
  return true;
}

/**
 * The basename's start offset: one past the last `/`, or the string's own start
 * when the path has no directory. Scanned backwards because a path's tail is
 * short and its head is not.
 */
function basenameStart(geometry: ContextIndexGeometry, start: number, end: number): number {
  const base = geometry.stringBlobBase;
  for (let index = end - 1; index >= start; index -= 1) {
    if (geometry.bytes[base + index] === SLASH) return index + 1;
  }
  return start;
}

/**
 * The stem's end offset: the last `.` strictly after the basename's first byte,
 * or `-1` when there is none. A dotfile (`.gitignore`) has its dot *at* the
 * first byte and therefore no stem, which is correct — its name is the whole
 * thing.
 */
function stemEnd(geometry: ContextIndexGeometry, from: number, end: number): number {
  const base = geometry.stringBlobBase;
  for (let index = end - 1; index > from; index -= 1) {
    if (geometry.bytes[base + index] === DOT) return index;
  }
  return -1;
}

/**
 * True when `probe` is the node's label, its basename, or its basename's stem.
 *
 * `rowAt` is the caller's already-bounds-checked node row, so this performs no
 * range check of its own — the reader class owns that, once, in `nodeRow`.
 */
export function nodeHasNameAt(
  geometry: ContextIndexGeometry,
  rowAt: number,
  probe: ContextIndexNameProbe,
): boolean {
  if (probe.length === 0) return false;

  const labelId = geometry.view.getUint32(rowAt + NODE_LABEL_AT, true);
  if (blobEquals(geometry, stringStart(geometry, labelId), stringEnd(geometry, labelId), probe)) return true;

  const pathId = geometry.view.getUint32(rowAt + NODE_PATH_AT, true);
  if (pathId === CONTEXT_INDEX_NO_VALUE) return false;

  const start = stringStart(geometry, pathId);
  const end = stringEnd(geometry, pathId);
  const nameAt = basenameStart(geometry, start, end);
  if (blobEquals(geometry, nameAt, end, probe)) return true;

  const stem = stemEnd(geometry, nameAt, end);
  return stem > nameAt && blobEquals(geometry, nameAt, stem, probe);
}
