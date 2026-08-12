/**
 * A published CRK2 generation for the projection fixtures.
 *
 * The projections migrated to the compact reader in CG2-13, so their tests can no
 * longer hand them a parsed snapshot. This publishes the fixture's snapshot
 * through the real store lifecycle and opens it through the query facade, which
 * is the only sequence production uses — a fixture that hand-wrote a pointer or
 * called `openContextIndex` on loose bytes would be testing the test.
 *
 * **One publish per root.** The store keeps an operation journal and refuses a
 * second, different operation until the first is recovered (`operation_in_flight`),
 * which is correct: two compilers racing on one workspace is exactly what that
 * refusal exists to stop. So a case that needs a modified graph builds a fresh
 * fixture and publishes the modified snapshot as its only generation. The fixture
 * is deterministic, so the source files on disk and their hashes are identical
 * either way and a freshness verdict still decides on real bytes.
 *
 * Roots come from `createProjectionFixture`, which is `fs.mkdtempSync` under
 * `os.tmpdir()`; nothing here touches the operator's HOME.
 */
import type { ContextGraphSnapshot } from '../../contracts.js';
import {
  HydrationCursor,
  openWorkspaceContextIndex,
  type ContextIndexReader,
  type WorkspaceContextIndexHandle
} from '../../query/index.js';
import { publishFixtureContextIndex, resetContextIndexCache } from '../../query/__tests__/workspace-fixtures.js';
import { createProjectionFixture, type ProjectionFixture, type ProjectionFixtureOptions } from './projection-fixtures.js';

export interface IndexedProjectionFixture extends ProjectionFixture {
  readonly handle: WorkspaceContextIndexHandle;
  readonly reader: ContextIndexReader;
  readonly cursor: HydrationCursor;
}

/** Rewrites the fixture's snapshot before it is published. Identity by default. */
export type SnapshotTransform = (snapshot: ContextGraphSnapshot) => ContextGraphSnapshot;

/** Publish `snapshot` into `root` and open it. Call once per root. */
export async function publishProjectionIndex(
  root: string,
  snapshot: ContextGraphSnapshot
): Promise<{ handle: WorkspaceContextIndexHandle; reader: ContextIndexReader; cursor: HydrationCursor }> {
  await publishFixtureContextIndex(root, snapshot);
  const handle = await openWorkspaceContextIndex(root);
  return { handle, reader: handle.reader, cursor: new HydrationCursor(handle.reader) };
}

/**
 * The standard fixture, compiled and published.
 *
 * `transform` rewrites the snapshot before it is published, so a case about
 * weakened trust or a stale module gets one generation describing exactly that
 * rather than a second generation layered over a healthy one.
 */
export async function createIndexedProjectionFixture(
  options: ProjectionFixtureOptions = {},
  transform?: SnapshotTransform
): Promise<IndexedProjectionFixture> {
  resetContextIndexCache();
  const fixture = createProjectionFixture(options);
  const snapshot = transform ? transform(fixture.snapshot) : fixture.snapshot;
  const opened = await publishProjectionIndex(fixture.root, snapshot);
  return { ...fixture, snapshot, ...opened };
}

export { resetContextIndexCache };
