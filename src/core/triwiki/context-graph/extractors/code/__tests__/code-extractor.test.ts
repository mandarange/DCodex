import test from 'node:test';
import assert from 'node:assert/strict';
import { contextGraphNodeId } from '../../../ids.js';
import { isWorkspaceRelativePosixPath } from '../../../paths.js';
import { createCodeGraphExtractor } from '../index.js';
import {
  edgesOfType,
  findSymbol,
  fixtureInput,
  hasEdge,
  makeCodeFixture,
  nodesOfKind,
  removeFixture
} from './fixture-repo.js';

const CONSUMER = contextGraphNodeId({ kind: 'file', path: 'src/consumer.ts' });
const ALPHA = contextGraphNodeId({ kind: 'file', path: 'src/alpha/index.ts' });
const BETA = contextGraphNodeId({ kind: 'file', path: 'src/beta/index.ts' });
const INNER = contextGraphNodeId({ kind: 'file', path: 'src/barrel/inner.ts' });
const OUTER = contextGraphNodeId({ kind: 'file', path: 'src/barrel/outer.ts' });
const BARREL = contextGraphNodeId({ kind: 'file', path: 'src/barrel/index.ts' });
const LATE = contextGraphNodeId({ kind: 'file', path: 'src/late-import.ts' });
const SUITE = contextGraphNodeId({ kind: 'file', path: 'src/__tests__/consumer.test.ts' });
const SUITE_TEST = contextGraphNodeId({ kind: 'test', path: 'src/__tests__/consumer.test.ts' });

test('resolves a tsconfig path alias through ts.resolveModuleName', async () => {
  const root = makeCodeFixture();
  try {
    const fragment = await createCodeGraphExtractor().extract(fixtureInput(root));
    assert.ok(hasEdge(fragment, 'imports', CONSUMER, ALPHA), 'consumer should import the aliased @app/alpha module');
    assert.ok(hasEdge(fragment, 'imports', CONSUMER, BETA), 'consumer should import the aliased @app/beta module');
    const edge = fragment.edges.find((candidate) => candidate.type === 'imports' && candidate.from === CONSUMER && candidate.to === ALPHA);
    assert.ok(edge);
    assert.equal(edge.confidence, 'exact');
    assert.equal(edge.provenance.path, 'src/consumer.ts');
    assert.equal(edge.provenance.line, 1);
  } finally {
    removeFixture(root);
  }
});

test('follows the barrel re-export chain to the final defining file and symbol', async () => {
  const root = makeCodeFixture();
  try {
    const fragment = await createCodeGraphExtractor().extract(fixtureInput(root));
    const deepHelper = findSymbol(fragment, 'src/barrel/inner.ts', 'deepHelper');
    assert.ok(deepHelper, 'expected the defining symbol to live in inner.ts');
    assert.ok(hasEdge(fragment, 'reexports', OUTER, BARREL), 'outer re-exports through the barrel index');
    assert.ok(hasEdge(fragment, 'reexports', BARREL, INNER), 'the barrel index star-re-exports inner');
    assert.ok(hasEdge(fragment, 'reexports', OUTER, deepHelper.id), 'the chain resolves to the final definition');
    assert.ok(hasEdge(fragment, 'reexports', OUTER, INNER), 'the chain records the final defining file');

    const reference = fragment.edges.find(
      (edge) => edge.type === 'references' && edge.from === CONSUMER && edge.to === deepHelper.id
    );
    assert.ok(reference, 'consumer references the definition, not the barrel');
    assert.equal(reference.confidence, 'exact');
    assert.ok(hasEdge(fragment, 'calls', CONSUMER, deepHelper.id));
  } finally {
    removeFixture(root);
  }
});

test('same-name symbols in two modules stay distinct nodes', async () => {
  const root = makeCodeFixture();
  try {
    const fragment = await createCodeGraphExtractor().extract(fixtureInput(root));
    const alphaParse = findSymbol(fragment, 'src/alpha/index.ts', 'parse');
    const betaParse = findSymbol(fragment, 'src/beta/index.ts', 'parse');
    assert.ok(alphaParse);
    assert.ok(betaParse);
    assert.notEqual(alphaParse.id, betaParse.id);
    assert.ok(hasEdge(fragment, 'calls', CONSUMER, alphaParse.id), 'the aliased import calls alpha.parse');
    assert.ok(hasEdge(fragment, 'calls', CONSUMER, betaParse.id), 'the namespace member call reaches beta.parse');
    assert.ok(hasEdge(fragment, 'defines', ALPHA, alphaParse.id));
    assert.ok(hasEdge(fragment, 'defines', BETA, betaParse.id));
  } finally {
    removeFixture(root);
  }
});

test('finds an import that appears after line 120 of a file', async () => {
  const root = makeCodeFixture();
  try {
    const fragment = await createCodeGraphExtractor().extract(fixtureInput(root));
    const edge = fragment.edges.find((candidate) => candidate.type === 'imports' && candidate.from === LATE && candidate.to === ALPHA);
    assert.ok(edge, 'the late import must still be discovered');
    assert.ok((edge.provenance.line ?? 0) > 120, `expected a line past 120, got ${String(edge.provenance.line)}`);
    const version = findSymbol(fragment, 'src/alpha/index.ts', 'VERSION');
    assert.ok(version);
    assert.ok(hasEdge(fragment, 'references', LATE, version.id));
    assert.ok(!hasEdge(fragment, 'calls', LATE, version.id), 'a const read is not a call');
  } finally {
    removeFixture(root);
  }
});

test('a literal dynamic import produces an edge and a computed one does not', async () => {
  const root = makeCodeFixture();
  try {
    const fragment = await createCodeGraphExtractor().extract(fixtureInput(root));
    const edge = fragment.edges.find((candidate) => candidate.type === 'imports' && candidate.from === CONSUMER && candidate.to === INNER);
    assert.ok(edge, "import('./barrel/inner.js') should produce an imports edge");
    assert.equal(edge.confidence, 'exact');
    const consumerImports = edgesOfType(fragment, 'imports').filter((candidate) => candidate.from === CONSUMER);
    const targets = consumerImports.map((candidate) => candidate.to).sort();
    assert.deepEqual(targets, [ALPHA, BETA, INNER, OUTER].sort(), 'the computed specifier must not invent a target');
  } finally {
    removeFixture(root);
  }
});

test('emits module, file, symbol and test nodes with containment edges', async () => {
  const root = makeCodeFixture();
  try {
    const fragment = await createCodeGraphExtractor().extract(fixtureInput(root));
    const modules = nodesOfKind(fragment, 'module');
    assert.ok(modules.length >= 4, `expected several module boundaries, got ${modules.length}`);
    const alphaModule = contextGraphNodeId({ kind: 'module', moduleId: 'src/alpha' });
    assert.ok(hasEdge(fragment, 'contains', alphaModule, ALPHA), 'module contains its file');

    const parse = findSymbol(fragment, 'src/alpha/index.ts', 'parse');
    assert.ok(parse);
    assert.ok(hasEdge(fragment, 'contains', ALPHA, parse.id), 'file contains its symbol');

    const tests = nodesOfKind(fragment, 'test');
    assert.equal(tests.length, 1);
    assert.equal(tests[0]?.id, SUITE_TEST);
    assert.ok(hasEdge(fragment, 'contains', SUITE, SUITE_TEST));
    assert.ok(hasEdge(fragment, 'tests', SUITE_TEST, CONSUMER), 'the suite tests the production file it imports');
    assert.ok(hasEdge(fragment, 'tests', SUITE_TEST, parse.id), 'the suite tests the symbol it uses');
    assert.ok(!hasEdge(fragment, 'tests', SUITE_TEST, SUITE), 'a suite never tests itself');
  } finally {
    removeFixture(root);
  }
});

test('every node and edge carries workspace-relative provenance and no absolute paths', async () => {
  const root = makeCodeFixture();
  try {
    const fragment = await createCodeGraphExtractor().extract(fixtureInput(root));
    assert.ok(fragment.edges.length > 0);
    for (const edge of fragment.edges) {
      assert.ok(isWorkspaceRelativePosixPath(edge.provenance.path), `bad provenance path ${edge.provenance.path}`);
      assert.match(edge.provenance.hash, /^[0-9a-f]{64}$/);
      assert.equal(edge.provenance.extractor, 'code');
      assert.equal(edge.observedAt, '2026-01-01T00:00:00.000Z');
    }
    for (const node of fragment.nodes) {
      if (node.path !== undefined) assert.ok(isWorkspaceRelativePosixPath(node.path), `bad node path ${node.path}`);
    }
    const serialized = JSON.stringify(fragment);
    assert.ok(!serialized.includes(root), 'the fragment must never carry the absolute workspace path');
    for (const [key, value] of Object.entries(fragment.inputHashes)) {
      assert.ok(isWorkspaceRelativePosixPath(key), `bad inputHashes key ${key}`);
      assert.match(value, /^[0-9a-f]{64}$/);
    }
    assert.ok(fragment.inputHashes['tsconfig.json'], 'tsconfig participates in freshness');
    assert.ok(fragment.inputHashes['src/consumer.ts']);
  } finally {
    removeFixture(root);
  }
});

test('nodes and edges are sorted by id', async () => {
  const root = makeCodeFixture();
  try {
    const fragment = await createCodeGraphExtractor().extract(fixtureInput(root));
    const nodeIds = fragment.nodes.map((node) => node.id);
    const edgeIds = fragment.edges.map((edge) => edge.id);
    assert.deepEqual(nodeIds, [...nodeIds].sort());
    assert.deepEqual(edgeIds, [...edgeIds].sort());
    assert.equal(new Set(nodeIds).size, nodeIds.length);
    assert.equal(new Set(edgeIds).size, edgeIds.length);
    const ids = new Set(nodeIds);
    for (const edge of fragment.edges) {
      assert.ok(ids.has(edge.from), `dangling from ${edge.from}`);
      assert.ok(ids.has(edge.to), `dangling to ${edge.to}`);
    }
  } finally {
    removeFixture(root);
  }
});
