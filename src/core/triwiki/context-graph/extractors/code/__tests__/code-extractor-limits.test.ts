import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contextGraphNodeId } from '../../../ids.js';
import { createCodeGraphExtractor } from '../index.js';
import { fixtureInput, fixtureLimits, makeCodeFixture, removeFixture } from './fixture-repo.js';

const CONSUMER = contextGraphNodeId({ kind: 'file', path: 'src/consumer.ts' });
const ALPHA = contextGraphNodeId({ kind: 'file', path: 'src/alpha/index.ts' });
const BETA = contextGraphNodeId({ kind: 'file', path: 'src/beta/index.ts' });

test('unsupported and binary files are recorded as explicit skips', async () => {
  const root = makeCodeFixture();
  try {
    const fragment = await createCodeGraphExtractor().extract(fixtureInput(root));
    const python = fragment.skipped.find((skip) => skip.path === 'src/legacy.py');
    assert.ok(python, 'a Python source file must be skipped, not ignored');
    assert.equal(python.reason, 'unsupported_language');
    assert.ok(python.detail && python.detail.length > 0);

    const blob = fragment.skipped.find((skip) => skip.path === 'src/blob.ts');
    assert.ok(blob, 'a binary payload with a source extension must be skipped');
    assert.equal(blob.reason, 'binary');
    assert.ok(!fragment.nodes.some((node) => node.path === 'src/blob.ts'));
    assert.ok(!fragment.nodes.some((node) => node.path === 'src/legacy.py'));
  } finally {
    removeFixture(root);
  }
});

test('a source file that uses a raw NUL as a key separator is still parsed', async () => {
  const root = makeCodeFixture();
  try {
    const fragment = await createCodeGraphExtractor().extract(fixtureInput(root));
    assert.ok(
      !fragment.skipped.some((skip) => skip.path === 'src/nul-key.ts'),
      'a lone NUL inside a template literal must not read as a binary file'
    );
    const file = fragment.nodes.find((node) => node.kind === 'file' && node.path === 'src/nul-key.ts');
    assert.ok(file, 'the file must reach the graph');
    const symbol = fragment.nodes.find((node) => node.kind === 'symbol' && node.path === 'src/nul-key.ts' && node.label === 'cacheKey');
    assert.ok(symbol, 'its declaration must be extracted');
    assert.ok(!JSON.stringify(fragment).includes(String.fromCharCode(0)), 'no raw NUL leaks into the fragment');
  } finally {
    removeFixture(root);
  }
});

test('a symlink that escapes the workspace is refused with a symlink_escape skip', async () => {
  const root = makeCodeFixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-code-graph-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'secret.ts'), 'export const secret = 1;\n');
    fs.symlinkSync(path.join(outside, 'secret.ts'), path.join(root, 'src', 'escaped.ts'));
    const fragment = await createCodeGraphExtractor().extract(fixtureInput(root));
    const escape = fragment.skipped.find((skip) => skip.path === 'src/escaped.ts');
    assert.ok(escape, 'the escaping symlink must be recorded');
    assert.equal(escape.reason, 'symlink_escape');
    assert.ok(!fragment.nodes.some((node) => node.path === 'src/escaped.ts'));
    assert.ok(!JSON.stringify(fragment).includes(outside));
  } finally {
    removeFixture(root);
    removeFixture(outside);
  }
});

test('three extractions of identical input are byte-identical', async () => {
  const root = makeCodeFixture();
  try {
    const extractor = createCodeGraphExtractor();
    const first = JSON.stringify(await extractor.extract(fixtureInput(root)));
    const second = JSON.stringify(await extractor.extract(fixtureInput(root)));
    const third = JSON.stringify(await createCodeGraphExtractor().extract(fixtureInput(root)));
    assert.equal(first, second);
    assert.equal(second, third);
    assert.ok(first.length > 1000);
  } finally {
    removeFixture(root);
  }
});

test('changedPaths limits extraction to the reverse-dependency closure', async () => {
  const root = makeCodeFixture();
  try {
    const fragment = await createCodeGraphExtractor().extract(
      fixtureInput(root, { changedPaths: ['src/alpha/index.ts'] })
    );
    const scanned = new Set(
      fragment.nodes.filter((node) => node.kind === 'file' && node.metadata.scanned === true).map((node) => node.path)
    );
    assert.ok(scanned.has('src/alpha/index.ts'), 'the changed file is extracted');
    assert.ok(scanned.has('src/consumer.ts'), 'a direct importer is in the reverse closure');
    assert.ok(scanned.has('src/late-import.ts'), 'a second importer is in the reverse closure');
    assert.ok(scanned.has('src/__tests__/consumer.test.ts'), 'a transitive importer is in the reverse closure');
    assert.ok(scanned.has('src/beta/index.ts'), 'one dependency hop is extracted so symbol targets exist');
    assert.ok(!scanned.has('src/barrel/index.ts'), 'a file two hops away from the closure is not extracted');

    const stub = fragment.nodes.find((node) => node.kind === 'file' && node.path === 'src/barrel/index.ts');
    assert.ok(stub, 'an unscanned re-export target still gets a hashed file node so no edge dangles');
    assert.equal(stub.metadata.scanned, false);

    assert.ok(fragment.inputHashes['src/beta/index.ts'], 'inputHashes covers everything the walk read');
    assert.ok(fragment.inputHashes['src/alpha/index.ts']);
    assert.ok(fragment.edges.some((edge) => edge.from === CONSUMER && edge.to === ALPHA && edge.type === 'imports'));
  } finally {
    removeFixture(root);
  }
});

test('changedPaths outside the inventory are reported instead of silently ignored', async () => {
  const root = makeCodeFixture();
  try {
    const fragment = await createCodeGraphExtractor().extract(
      fixtureInput(root, { changedPaths: ['src/does-not-exist.ts'] })
    );
    const warning = fragment.issues.find((issue) => issue.code === 'extractor_skipped_input');
    assert.ok(warning, 'an unknown changed path must surface as a warning');
    assert.equal(warning.severity, 'warning');
    assert.equal(warning.path, 'src/does-not-exist.ts');
    assert.ok(!fragment.nodes.some((node) => node.kind === 'file' && node.metadata.scanned === true));
  } finally {
    removeFixture(root);
  }
});

test('the node cap is enforced and reported as a cap_reached skip', async () => {
  const root = makeCodeFixture();
  try {
    const fragment = await createCodeGraphExtractor().extract(
      fixtureInput(root, { limits: fixtureLimits({ maxNodes: 6 }) })
    );
    assert.equal(fragment.nodes.length, 6);
    assert.ok(fragment.skipped.some((skip) => skip.reason === 'cap_reached' && (skip.detail ?? '').includes('maxNodes')));
  } finally {
    removeFixture(root);
  }
});

test('the file cap is enforced and reported as a cap_reached skip', async () => {
  const root = makeCodeFixture();
  try {
    const fragment = await createCodeGraphExtractor().extract(
      fixtureInput(root, { limits: fixtureLimits({ maxFiles: 2 }) })
    );
    assert.ok(fragment.skipped.some((skip) => skip.reason === 'cap_reached' && (skip.detail ?? '').includes('maxFiles')));
    assert.ok(Object.keys(fragment.inputHashes).length <= 3, 'only the files actually read are hashed');
  } finally {
    removeFixture(root);
  }
});

test('an oversized file is skipped rather than truncated', async () => {
  const root = makeCodeFixture();
  try {
    const fragment = await createCodeGraphExtractor().extract(
      fixtureInput(root, { limits: fixtureLimits({ maxFileBytes: 40 }) })
    );
    assert.ok(fragment.skipped.some((skip) => skip.reason === 'oversized' && skip.path === 'src/consumer.ts'));
    assert.ok(!fragment.nodes.some((node) => node.path === 'src/consumer.ts'));
  } finally {
    removeFixture(root);
  }
});

test('the extractor ships without any process spawning dependency', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const moduleDir = path.dirname(here);
  const entries = fs.readdirSync(moduleDir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.js'));
  assert.ok(entries.length >= 5, `expected the compiled extractor modules next to the tests, found ${entries.length}`);
  for (const entry of entries) {
    const source = fs.readFileSync(path.join(moduleDir, entry.name), 'utf8');
    assert.ok(!source.includes('child_process'), `${entry.name} must not reach for child_process`);
    assert.ok(!/\bexecSync\b|\bspawnSync\b|\bexecFileSync\b/.test(source), `${entry.name} must not spawn a process`);
  }
});

test('the extractor exposes a stable identity for the compiler', async () => {
  const extractor = createCodeGraphExtractor();
  assert.equal(extractor.id, 'code');
  assert.match(extractor.revision, /^\d+\.\d+\.\d+$/);
  const root = makeCodeFixture();
  try {
    const fragment = await extractor.extract(fixtureInput(root));
    assert.equal(fragment.extractor, 'code');
    assert.equal(fragment.extractorRevision, extractor.revision);
    assert.equal(fragment.schema, 'sks.context-graph-fragment.v1');
    assert.ok(!fragment.nodes.some((node) => node.path === 'src/beta/index.ts' && node.metadata.scanned === false));
    assert.ok(fragment.nodes.some((node) => node.id === BETA));
  } finally {
    removeFixture(root);
  }
});
