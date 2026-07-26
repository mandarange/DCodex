import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ContextGraphExtractionInput, ContextGraphFragment } from '../../../contracts.js';
import { createTopologyGraphExtractor } from '../index.js';
import { TOPOLOGY_GLOB_MATCH_CAP } from '../shared.js';

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sks-topology-gates-'));
}

function write(root: string, relative: string, content: string): void {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

function writeGateManifest(root: string, gates: readonly unknown[]): void {
  write(root, 'release-gates.v2.json', JSON.stringify({ schema: 'sks.release-gates.v2', gates }, null, 2));
}

interface GateOverrides {
  command?: string;
  deps?: readonly string[];
  inputs?: readonly string[];
  preset?: readonly string[];
}

function gate(id: string, overrides: GateOverrides = {}): Record<string, unknown> {
  return {
    id,
    command: overrides.command ?? 'node ./dist/scripts/demo-check.js',
    deps: overrides.deps ?? [],
    resource: ['cpu-light'],
    side_effect: 'hermetic',
    timeout_ms: 120000,
    cache: { enabled: true, inputs: overrides.inputs ?? [] },
    preset: overrides.preset ?? ['release'],
    output_contract: 'sks.gate-result.v1'
  };
}

function extractionInput(root: string): ContextGraphExtractionInput {
  return {
    root,
    changedPaths: null,
    limits: { maxFiles: 4000, maxFileBytes: 2_000_000, maxNodes: 20_000, maxEdges: 60_000, timeoutMs: 30_000 },
    observedAt: '2026-01-01T00:00:00.000Z'
  };
}

async function extract(root: string): Promise<ContextGraphFragment> {
  return createTopologyGraphExtractor().extract(extractionInput(root));
}

function errorCodes(fragment: ContextGraphFragment): string[] {
  return fragment.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.code);
}

function edgesOfType(fragment: ContextGraphFragment, type: string): ContextGraphFragment['edges'] {
  return fragment.edges.filter((edge) => edge.type === type);
}

test('a gate manifest becomes gate nodes with check, cache-input, and preset relations', async () => {
  const root = makeRoot();
  try {
    write(root, 'package.json', '{"name":"fixture"}\n');
    write(root, 'src/scripts/demo-check.ts', 'export const demo = 1;\n');
    write(root, 'src/core/demo.ts', 'export const value = 1;\n');
    writeGateManifest(root, [gate('release:demo', { inputs: ['package.json', 'src/core/*.ts'] })]);

    const fragment = await extract(root);
    assert.deepEqual(errorCodes(fragment), []);

    const gateNode = fragment.nodes.find((node) => node.id === 'gate:release:demo');
    assert.ok(gateNode, 'expected a canonical gate node id');
    assert.equal(gateNode?.kind, 'gate');
    assert.equal(gateNode?.path, 'release-gates.v2.json');
    assert.equal(gateNode?.risk, 'protected', 'release namespace gates are publish critical');
    assert.deepEqual(gateNode?.metadata.cacheInputs, ['package.json', 'src/core/*.ts']);
    assert.deepEqual(gateNode?.metadata.checkScripts, ['src/scripts/demo-check.ts']);

    const verified = edgesOfType(fragment, 'verified_by');
    assert.equal(verified.length, 1);
    assert.equal(verified[0]?.from, 'gate:release:demo');
    assert.equal(verified[0]?.to, 'file:src/scripts/demo-check.ts');
    assert.equal(verified[0]?.confidence, 'manifest');

    const manifestHash = crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(root, 'release-gates.v2.json')))
      .digest('hex');
    assert.equal(verified[0]?.provenance.path, 'release-gates.v2.json');
    assert.equal(verified[0]?.provenance.hash, manifestHash);
    assert.equal(verified[0]?.provenance.extractor, 'topology');
    assert.equal(fragment.inputHashes['release-gates.v2.json'], manifestHash);

    const affected = edgesOfType(fragment, 'affected_by').map((edge) => edge.to).sort();
    assert.deepEqual(affected, ['file:package.json', 'file:src/core/demo.ts']);

    const gatedBy = edgesOfType(fragment, 'gated_by');
    assert.equal(gatedBy.length, 1);
    assert.equal(gatedBy[0]?.from, 'pipeline:gates:release');
    assert.equal(gatedBy[0]?.to, 'gate:release:demo');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a gate whose check implementation is missing gets no verified_by edge and an explicit skip', async () => {
  const root = makeRoot();
  try {
    write(root, 'package.json', '{"name":"fixture"}\n');
    writeGateManifest(root, [
      gate('harness:absent', { command: 'node ./dist/scripts/absent-check.js', inputs: ['package.json'] })
    ]);

    const fragment = await extract(root);
    assert.deepEqual(errorCodes(fragment), []);
    assert.equal(edgesOfType(fragment, 'verified_by').length, 0);
    assert.ok(
      fragment.skipped.some((skip) => String(skip.detail ?? '').includes('src/scripts/absent-check.ts')),
      'the missing check implementation must be reported, not silently dropped'
    );
    assert.ok(fragment.nodes.some((node) => node.id === 'gate:harness:absent'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a protected gate with no check implementation and no cache input is a lint error', async () => {
  const root = makeRoot();
  try {
    writeGateManifest(root, [gate('release:unbacked', { command: 'node ./dist/scripts/absent-check.js', inputs: [] })]);
    const fragment = await extract(root);
    assert.ok(
      errorCodes(fragment).includes('protected_gate_without_source_relation'),
      'a protected gate the graph cannot explain must fail the compile'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a dependency on an undeclared gate is a dangling_edge error and produces no edge', async () => {
  const root = makeRoot();
  try {
    write(root, 'src/scripts/demo-check.ts', 'export const demo = 1;\n');
    writeGateManifest(root, [gate('harness:child', { deps: ['harness:ghost'] })]);

    const fragment = await extract(root);
    assert.equal(edgesOfType(fragment, 'depends_on').length, 0, 'an unresolved dependency must not become an edge');
    const issue = fragment.issues.find((entry) => entry.code === 'dangling_edge');
    assert.ok(issue, 'expected a dangling_edge lint issue');
    assert.equal(issue?.severity, 'error');
    assert.match(issue?.message ?? '', /harness:ghost/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a gate dependency cycle is reported as manifest_dag_cycle', async () => {
  const root = makeRoot();
  try {
    write(root, 'src/scripts/demo-check.ts', 'export const demo = 1;\n');
    writeGateManifest(root, [
      gate('harness:alpha', { deps: ['harness:beta'] }),
      gate('harness:beta', { deps: ['harness:alpha'] }),
      gate('harness:self', { deps: ['harness:self'] })
    ]);

    const fragment = await extract(root);
    const cycles = fragment.issues.filter((issue) => issue.code === 'manifest_dag_cycle');
    assert.ok(cycles.length >= 2, `expected the pair cycle and the self cycle, got ${cycles.length}`);
    assert.ok(cycles.every((issue) => issue.severity === 'error'));
    assert.ok(cycles.some((issue) => issue.message.includes('gate:harness:alpha -> gate:harness:beta')));
    assert.ok(cycles.some((issue) => issue.message.includes('harness:self depends on itself')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cache-input globs reverse-map to real files and over-wide globs stay raw on the gate node', async () => {
  const root = makeRoot();
  try {
    write(root, 'package.json', '{"name":"fixture"}\n');
    write(root, 'src/scripts/demo-check.ts', 'export const demo = 1;\n');
    write(root, 'src/narrow/one.ts', 'export const one = 1;\n');
    write(root, 'src/narrow/two.ts', 'export const two = 2;\n');
    const wide = TOPOLOGY_GLOB_MATCH_CAP + 2;
    for (let index = 0; index < wide; index += 1) {
      write(root, `src/wide/file-${String(index).padStart(3, '0')}.ts`, 'export const wide = 1;\n');
    }
    writeGateManifest(root, [gate('harness:globs', { inputs: ['src/narrow/**', 'src/wide/**'] })]);

    const fragment = await extract(root);
    const affected = edgesOfType(fragment, 'affected_by').map((edge) => edge.to).sort();
    assert.deepEqual(affected, ['file:src/narrow/one.ts', 'file:src/narrow/two.ts']);
    assert.ok(
      !fragment.nodes.some((node) => node.id.startsWith('file:src/wide/')),
      'an over-wide glob must not flood the snapshot with file nodes'
    );
    assert.ok(
      fragment.skipped.some(
        (skip) => skip.reason === 'cap_reached' && String(skip.detail ?? '').includes(`src/wide/** matched ${wide} files`)
      ),
      'the capped glob must be reported'
    );
    const gateNode = fragment.nodes.find((node) => node.id === 'gate:harness:globs');
    assert.deepEqual(gateNode?.metadata.cacheInputs, ['src/narrow/**', 'src/wide/**']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a malformed gate manifest produces a lint error instead of a silent empty fragment', async () => {
  const brokenJson = makeRoot();
  try {
    write(brokenJson, 'release-gates.v2.json', '{ "schema": "sks.release-gates.v2", "gates": [');
    const fragment = await extract(brokenJson);
    assert.ok(errorCodes(fragment).includes('invalid_node_field'));
    assert.match(fragment.issues[0]?.message ?? '', /not valid JSON/);
    assert.equal(fragment.nodes.length, 0);
  } finally {
    fs.rmSync(brokenJson, { recursive: true, force: true });
  }

  const wrongSchema = makeRoot();
  try {
    write(wrongSchema, 'release-gates.v2.json', JSON.stringify({ schema: 'sks.release-gates.v1', gates: [] }));
    const fragment = await extract(wrongSchema);
    assert.ok(errorCodes(fragment).includes('invalid_node_field'));
    assert.match(fragment.issues[0]?.message ?? '', /declares schema/);
  } finally {
    fs.rmSync(wrongSchema, { recursive: true, force: true });
  }

  const missingId = makeRoot();
  try {
    write(missingId, 'release-gates.v2.json', JSON.stringify({ schema: 'sks.release-gates.v2', gates: [{ command: 'x' }] }));
    const fragment = await extract(missingId);
    assert.ok(errorCodes(fragment).includes('invalid_node_field'));
    assert.match(fragment.issues[0]?.message ?? '', /has no id/);
  } finally {
    fs.rmSync(missingId, { recursive: true, force: true });
  }
});
