import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ContextIndexReader } from '../../runtime-index/reader.js';
import { fixedKernelClock, runContextKernel, type KernelRequest } from '../kernel.js';
import { hydrateSelectedCandidates, type HydrationResult } from '../hydrate.js';
import {
  CONTEXT_HYDRATION_VERIFICATION_SCHEMA,
  ContextHydrationError,
  HYDRATION_PROBE_CONCURRENCY,
  verifyHydrationOnDisk,
} from '../hydrate-verify.js';
import { GATE_ID, KERNEL_PATH, openKernelIndex } from './kernel-fixtures.js';

const clock = fixedKernelClock(0);
const BROAD: KernelRequest = { query: `${KERNEL_PATH} ${GATE_ID} kernel retrieval`, profile: 'review', risk: 'high' };

function hydrate(reader: ContextIndexReader = openKernelIndex()): HydrationResult {
  return hydrateSelectedCandidates(reader, runContextKernel(reader, BROAD, { clock }).selected, { indexFresh: true });
}

/** Every test writes inside its own `mkdtemp`; nothing here may touch the real HOME. */
async function withWorkspace(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-hydrate-'));
  try {
    await run(root);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

async function writeFile(root: string, relative: string): Promise<void> {
  const target = path.join(root, relative);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, '// fixture\n', 'utf8');
}

function provenancePaths(result: HydrationResult): string[] {
  const unique = new Set<string>();
  for (const node of result.nodes) for (const ref of node.provenance) unique.add(ref.path);
  return [...unique].sort();
}

test('the validate path re-grounds against real files and says which claim it is making', async () => {
  await withWorkspace(async (root) => {
    const result = hydrate();
    const paths = provenancePaths(result);
    assert.ok(paths.length > 0);
    for (const relative of paths) await writeFile(root, relative);

    const verified = await verifyHydrationOnDisk(result, { root });
    assert.equal(verified.schema, CONTEXT_HYDRATION_VERIFICATION_SCHEMA);
    assert.equal(verified.nodes.length, result.nodes.length);
    assert.equal(verified.verifiedNodes, result.nodes.length);
    assert.equal(verified.missingPaths, 0);
    assert.equal(verified.verifiedPaths, paths.length);
    assert.equal(verified.provenanceCoverage, 1);
    for (const node of verified.nodes) {
      assert.equal(node.hydrated, true);
      assert.equal(node.grounding, 'filesystem_verified');
    }
  });
});

test('a node whose files are gone is unverified, never quietly left claiming freshness', async () => {
  await withWorkspace(async (root) => {
    const result = hydrate();
    // The fast path called every groundable node hydrated. On an empty
    // workspace the strict path must contradict it rather than inherit it.
    assert.ok(result.nodes.some((node) => node.grounding === 'fresh_index'));

    const verified = await verifyHydrationOnDisk(result, { root });
    assert.equal(verified.verifiedNodes, 0);
    assert.equal(verified.verifiedPaths, 0);
    assert.equal(verified.missingPaths, verified.uniquePaths);
    for (const node of verified.nodes) {
      assert.equal(node.hydrated, false);
      assert.equal(node.grounding, 'unverified');
    }
    // Provenance is a record of what the compiler read; a missing file does not
    // retract it, so coverage is unchanged by verification.
    assert.equal(verified.provenanceCoverage, result.provenanceCoverage);
  });
});

test('paths are deduplicated before probing: the unit of work is the path, not the node', async () => {
  const result = hydrate();
  const paths = provenancePaths(result);
  const total = result.nodes.reduce((sum, node) => sum + node.provenance.length, 0);
  assert.ok(total > paths.length, 'the fixture must repeat at least one provenance path');

  const asked: string[] = [];
  const verified = await verifyHydrationOnDisk(result, {
    probe: async (relative) => {
      asked.push(relative);
      return true;
    },
  });
  assert.deepEqual(asked.slice().sort(), paths);
  assert.equal(verified.probes, paths.length);
  assert.equal(verified.uniquePaths, paths.length);
});

test('the fan-out is bounded, so a large selection cannot exhaust the descriptor table', async () => {
  const nodes = Array.from({ length: 400 }, (_, index) => ({
    provenance: [{ path: `src/generated/file-${index}.ts`, hash: `sha256:${index}` }],
  }));
  const result = { nodes } as unknown as HydrationResult;

  let inFlight = 0;
  let peak = 0;
  const probe = async (): Promise<boolean> => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setImmediate(resolve));
    inFlight -= 1;
    return false;
  };

  const wide = await verifyHydrationOnDisk(result, { probe });
  assert.equal(wide.uniquePaths, 400);
  assert.equal(wide.concurrency, HYDRATION_PROBE_CONCURRENCY);
  assert.ok(peak <= HYDRATION_PROBE_CONCURRENCY, `peak fan-out ${peak} exceeded the bound`);

  peak = 0;
  const narrow = await verifyHydrationOnDisk(result, { probe, concurrency: 4 });
  assert.equal(narrow.concurrency, 4);
  assert.ok(peak <= 4, `peak fan-out ${peak} exceeded the requested bound`);
});

test('a path that is not workspace-relative is refused rather than probed', async () => {
  const result = {
    nodes: [{ provenance: [{ path: '/etc/passwd', hash: 'sha256:x' }, { path: '../escape.ts', hash: 'sha256:y' }] }],
  } as unknown as HydrationResult;

  let probed = 0;
  const verified = await verifyHydrationOnDisk(result, {
    probe: async () => {
      probed += 1;
      return true;
    },
  });
  assert.equal(probed, 0, 'a refused path must never reach the filesystem');
  assert.equal(verified.refusedPaths, 2);
  assert.equal(verified.probes, 0);
  assert.equal(verified.verifiedPaths, 0);
  assert.equal(verified.missingPaths, 0);
  assert.equal(verified.nodes[0]?.grounding, 'unverified');
});

test('the default probe refuses an escape and finds only real files under the root', async () => {
  await withWorkspace(async (root) => {
    await writeFile(root, 'src/core/kernel.ts');
    await fsp.mkdir(path.join(root, 'src/core/empty-dir'), { recursive: true });
    const result = {
      nodes: [
        { provenance: [{ path: 'src/core/kernel.ts', hash: 'sha256:a' }] },
        { provenance: [{ path: 'src/core/missing.ts', hash: 'sha256:b' }] },
        // A directory is not a file: `stat` alone would call this hydrated.
        { provenance: [{ path: 'src/core/empty-dir', hash: 'sha256:c' }] },
      ],
    } as unknown as HydrationResult;

    const verified = await verifyHydrationOnDisk(result, { root });
    assert.equal(verified.verifiedPaths, 1);
    assert.equal(verified.missingPaths, 2);
    assert.deepEqual(verified.nodes.map((node) => node.grounding), [
      'filesystem_verified',
      'unverified',
      'unverified',
    ]);
  });
});

test('verification without a root or a probe fails with a code, not a path', async () => {
  const result = hydrate();
  await assert.rejects(
    () => verifyHydrationOnDisk(result),
    (error: unknown) => {
      assert.ok(error instanceof ContextHydrationError);
      assert.equal(error.code, 'hydration_verify_target_missing');
      assert.equal(error.message, 'hydration_verify_target_missing');
      return true;
    },
  );
});
