import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ContextGraphExtractionInput, ContextGraphFragment } from '../../../contracts.js';
import { isWorkspaceRelativePosixPath } from '../../../paths.js';
import { TOPOLOGY_COMMAND_MANIFEST_PATH, TOPOLOGY_ROUTES_PATH, TOPOLOGY_RUNTIME_SCRIPTS_PATH, createTopologyGraphExtractor } from '../index.js';
import { canonicalCommandName } from '../commands.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sks-topology-commands-'));
}

function write(root: string, relative: string, content: string): void {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

/**
 * The control-plane manifests are imported from this package, but a node is only
 * emitted when the manifest file is present in the workspace, so a fixture only
 * has to stand the files up for the topology to appear.
 */
function writeControlPlane(root: string): void {
  write(root, TOPOLOGY_COMMAND_MANIFEST_PATH, 'export const COMMAND_MANIFEST_LITE = [];\n');
  write(root, TOPOLOGY_ROUTES_PATH, 'export const ROUTES = [];\n');
}

function writeGateManifest(root: string, gates: readonly unknown[]): void {
  write(root, 'release-gates.v2.json', JSON.stringify({ schema: 'sks.release-gates.v2', gates }, null, 2));
}

function extractionInput(root: string): ContextGraphExtractionInput {
  return {
    root,
    changedPaths: null,
    limits: { maxFiles: 8000, maxFileBytes: 4_000_000, maxNodes: 50_000, maxEdges: 120_000, timeoutMs: 60_000 },
    observedAt: '2026-01-01T00:00:00.000Z'
  };
}

async function extract(root: string): Promise<ContextGraphFragment> {
  return createTopologyGraphExtractor().extract(extractionInput(root));
}

function edgeBetween(fragment: ContextGraphFragment, from: string, to: string, type: string): ContextGraphFragment['edges'][number] | undefined {
  return fragment.edges.find((edge) => edge.from === from && edge.to === to && edge.type === type);
}

test('a command reaches a gate through the preset pipeline it dispatches', async () => {
  const root = makeRoot();
  try {
    writeControlPlane(root);
    write(root, 'package.json', '{"name":"fixture"}\n');
    write(root, 'src/core/commands/release-command.ts', 'export const releaseCommand = 1;\n');
    write(root, 'src/scripts/release-proof-truth-check.ts', 'export const check = 1;\n');
    writeGateManifest(root, [
      {
        id: 'release:proof-truth',
        command: 'node ./dist/scripts/release-proof-truth-check.js',
        deps: [],
        cache: { enabled: true, inputs: ['package.json'] },
        preset: ['release']
      }
    ]);

    const fragment = await extract(root);
    assert.deepEqual(fragment.issues.filter((issue) => issue.severity === 'error'), []);

    const toPipeline = edgeBetween(fragment, 'command:release', 'pipeline:gates:release', 'routes_to');
    assert.ok(toPipeline, 'the release command must reach the release preset pipeline');
    assert.equal(toPipeline?.provenance.path, 'release-gates.v2.json');

    const toGate = edgeBetween(fragment, 'pipeline:gates:release', 'gate:release:proof-truth', 'gated_by');
    assert.ok(toGate, 'the preset pipeline must be gated by its member gate');

    const handler = edgeBetween(fragment, 'command:release', 'file:src/core/commands/release-command.ts', 'routes_to');
    assert.ok(handler, 'a command must route to its handler file');
    assert.equal(handler?.confidence, 'derived', 'a convention-derived handler is not a manifest claim');
    assert.equal(handler?.provenance.path, TOPOLOGY_COMMAND_MANIFEST_PATH);

    const commandNode = fragment.nodes.find((node) => node.id === 'command:release');
    assert.equal(commandNode?.kind, 'command');
    assert.equal(commandNode?.metadata.commandName, 'release');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime-required-scripts.json turns a handler file into a manifest-grade owns relation', async () => {
  const root = makeRoot();
  try {
    writeControlPlane(root);
    write(root, 'src/core/commands/gates-command.ts', 'export const gatesCommand = 1;\n');
    write(
      root,
      TOPOLOGY_RUNTIME_SCRIPTS_PATH,
      JSON.stringify({
        schema: 'sks.runtime-required-scripts.v1',
        scripts: [],
        reference_source_policies: [
          { source: 'src/core/commands/gates-command.ts', classification: 'installed_runtime', reason: 'dispatches the packaged DAG' }
        ]
      })
    );

    const fragment = await extract(root);
    const owns = edgeBetween(fragment, 'command:gates', 'file:src/core/commands/gates-command.ts', 'owns');
    assert.ok(owns, 'a manifest that names a command source expresses ownership');
    assert.equal(owns?.confidence, 'manifest');
    assert.equal(owns?.provenance.path, TOPOLOGY_RUNTIME_SCRIPTS_PATH);

    const routes = edgeBetween(fragment, 'command:gates', 'file:src/core/commands/gates-command.ts', 'routes_to');
    assert.equal(routes?.confidence, 'manifest', 'a manifest-declared handler is not merely derived');

    const fileNode = fragment.nodes.find((node) => node.id === 'file:src/core/commands/gates-command.ts');
    assert.equal(fileNode?.metadata.runtimeClassification, 'installed_runtime');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('routes become lifecycle pipelines and a renamed CLI verb resolves to the canonical command', async () => {
  const root = makeRoot();
  try {
    writeControlPlane(root);
    write(root, 'src/core/commands/image-ux-review-command.ts', 'export const imageUxReview = 1;\n');

    const fragment = await extract(root);
    assert.equal(canonicalCommandName('ux-review'), 'image-ux-review');

    const routeNode = fragment.nodes.find((node) => node.id === 'route:ImageUXReview');
    assert.equal(routeNode?.kind, 'route');
    assert.equal(routeNode?.path, TOPOLOGY_ROUTES_PATH);

    const pipelineNode = fragment.nodes.find((node) => node.id === 'pipeline:route:ImageUXReview');
    assert.equal(pipelineNode?.kind, 'pipeline');
    const stages = pipelineNode?.metadata.stages;
    assert.ok(Array.isArray(stages) && stages.length > 0, 'a route pipeline carries its declared lifecycle stages');

    assert.ok(
      edgeBetween(fragment, 'route:ImageUXReview', 'pipeline:route:ImageUXReview', 'routes_to'),
      'a route must reach its own lifecycle pipeline'
    );
    assert.ok(
      edgeBetween(fragment, 'command:image-ux-review', 'pipeline:route:ImageUXReview', 'routes_to'),
      'the declared cliEntrypoint verb `ux-review` must resolve to the canonical command node'
    );
    assert.ok(
      !fragment.nodes.some((node) => node.id === 'command:ux-review'),
      'an alias must never mint a second command node'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('extraction is byte-deterministic and every edge cites a workspace-relative path', async () => {
  const root = makeRoot();
  try {
    writeControlPlane(root);
    write(root, 'package.json', '{"name":"fixture"}\n');
    write(root, 'src/scripts/demo-check.ts', 'export const demo = 1;\n');
    writeGateManifest(root, [
      {
        id: 'harness:demo',
        command: 'node ./dist/scripts/demo-check.js',
        deps: [],
        cache: { enabled: true, inputs: ['package.json'] },
        preset: ['harness']
      }
    ]);

    const first = await extract(root);
    const second = await extract(root);
    assert.equal(JSON.stringify(second), JSON.stringify(first), 'two extractions of one workspace must be identical');

    for (const edge of first.edges) {
      assert.ok(edge.provenance.path, `edge ${edge.id} has no provenance path`);
      assert.ok(isWorkspaceRelativePosixPath(edge.provenance.path), `edge ${edge.id} cites ${edge.provenance.path}`);
      assert.equal(edge.provenance.extractor, 'topology');
      assert.ok(edge.provenance.hash.length === 64, `edge ${edge.id} has no content hash`);
      assert.equal(edge.observedAt, '2026-01-01T00:00:00.000Z');
    }
    for (const node of first.nodes) {
      if (node.path === undefined) continue;
      assert.ok(isWorkspaceRelativePosixPath(node.path), `node ${node.id} carries ${node.path}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the real release gate manifest compiles into a clean, fully covered gate topology', async () => {
  const repoRoot = path.join(__dirname, '..', '..', '..', '..', '..', '..', '..');
  const manifestPath = path.join(repoRoot, 'release-gates.v2.json');
  assert.ok(fs.existsSync(manifestPath), `resolved repo root must contain release-gates.v2.json (${repoRoot})`);

  const fragment = await extract(repoRoot);
  assert.deepEqual(
    fragment.issues.filter((issue) => issue.severity === 'error').map((issue) => `${issue.code}: ${issue.message}`),
    [],
    'the real control plane must extract without lint errors'
  );

  const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const gates = (parsed as { gates?: Array<{ id?: string }> }).gates ?? [];
  assert.ok(gates.length > 50, 'expected the real release gate DAG');
  const nodeIds = new Set(fragment.nodes.map((node) => node.id));
  for (const entry of gates) {
    assert.ok(entry.id, 'every real gate declares an id');
    assert.ok(nodeIds.has(`gate:${entry.id}`), `gate ${entry.id} is missing from the fragment`);
  }

  const protectedGates = fragment.nodes.filter((node) => node.kind === 'gate' && node.risk === 'protected');
  assert.ok(protectedGates.length > 10, 'publish-critical gates must be marked protected');
  assert.ok(
    fragment.nodes.some((node) => node.kind === 'command') && fragment.nodes.some((node) => node.kind === 'route'),
    'the real workspace also carries the command and route manifests'
  );
});
