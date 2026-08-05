import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contextGraphNodeId } from '../../../ids.js';
import { createCodeGraphExtractor } from '../index.js';
import { walkCodeInventory } from '../inventory.js';
import { extractTextDeclarations } from '../text-declarations.js';
import type { CodeLanguage, CodeSourceFileRecord, CodeSymbolKind } from '../types.js';
import { fixtureInput, fixtureLimits, makeCodeFixture, removeFixture } from './fixture-repo.js';

const CONSUMER = contextGraphNodeId({ kind: 'file', path: 'src/consumer.ts' });
const ALPHA = contextGraphNodeId({ kind: 'file', path: 'src/alpha/index.ts' });
const BETA = contextGraphNodeId({ kind: 'file', path: 'src/beta/index.ts' });

test('every advertised text language has a literal declaration navigation case', () => {
  const cases: Array<{ language: CodeLanguage; extension: string; source: string; name: string; kind: CodeSymbolKind }> = [
    { language: 'python', extension: '.py', source: 'def run_task():', name: 'run_task', kind: 'function' },
    { language: 'ruby', extension: '.rb', source: 'class TaskRunner', name: 'TaskRunner', kind: 'class' },
    { language: 'go', extension: '.go', source: 'func RunTask() {}', name: 'RunTask', kind: 'function' },
    { language: 'rust', extension: '.rs', source: 'pub struct TaskRunner;', name: 'TaskRunner', kind: 'struct' },
    { language: 'java', extension: '.java', source: 'public class TaskRunner {', name: 'TaskRunner', kind: 'class' },
    { language: 'kotlin', extension: '.kt', source: 'public class TaskRunner {', name: 'TaskRunner', kind: 'class' },
    { language: 'swift', extension: '.swift', source: 'public actor TaskRunner {', name: 'TaskRunner', kind: 'actor' },
    { language: 'php', extension: '.php', source: 'final class TaskRunner {', name: 'TaskRunner', kind: 'class' },
    { language: 'c', extension: '.c', source: 'int run_task(int value) {', name: 'run_task', kind: 'function' },
    { language: 'cpp', extension: '.cpp', source: 'struct TaskRunner {', name: 'TaskRunner', kind: 'struct' },
    { language: 'csharp', extension: '.cs', source: 'public class TaskRunner {', name: 'TaskRunner', kind: 'class' },
    { language: 'scala', extension: '.scala', source: 'final class TaskRunner {', name: 'TaskRunner', kind: 'class' },
    { language: 'shell', extension: '.sh', source: 'run_task() {', name: 'run_task', kind: 'function' },
    { language: 'vue', extension: '.vue', source: 'export function runTask() {', name: 'runTask', kind: 'function' },
    { language: 'svelte', extension: '.svelte', source: 'export const runTask = () => 1;', name: 'runTask', kind: 'const' },
    { language: 'dart', extension: '.dart', source: 'sealed class TaskRunner {', name: 'TaskRunner', kind: 'class' },
    { language: 'objective-c', extension: '.m', source: '@interface TaskRunner : NSObject', name: 'TaskRunner', kind: 'class' },
    { language: 'perl', extension: '.pl', source: 'sub run_task {', name: 'run_task', kind: 'function' },
    { language: 'lua', extension: '.lua', source: 'function run_task()', name: 'run_task', kind: 'function' },
    { language: 'elixir', extension: '.ex', source: 'defmodule TaskRunner do', name: 'TaskRunner', kind: 'module' },
    { language: 'clojure', extension: '.clj', source: '(defn run-task []', name: 'run-task', kind: 'function' },
    { language: 'haskell', extension: '.hs', source: 'runTask :: Int -> Int', name: 'runTask', kind: 'function' },
    { language: 'ocaml', extension: '.ml', source: 'let run_task value = value + 1', name: 'run_task', kind: 'function' },
    { language: 'julia', extension: '.jl', source: 'function run_task(value)', name: 'run_task', kind: 'function' },
    { language: 'sql', extension: '.sql', source: 'CREATE TABLE task_runs (', name: 'task_runs', kind: 'table' },
    { language: 'r', extension: '.r', source: 'run_task <- function(value) {', name: 'run_task', kind: 'function' }
  ];
  for (const [index, entry] of cases.entries()) {
    const text = `# fixture\n  ${entry.source}\n`;
    const record: CodeSourceFileRecord = {
      rel: `src/fixture-${index}${entry.extension}`,
      abs: `/fixture/src/fixture-${index}${entry.extension}`,
      hash: `hash-${index}`,
      text,
      bytes: Buffer.byteLength(text),
      lines: 2,
      isTest: false,
      extension: entry.extension,
      language: entry.language,
      parser: 'text',
      purpose: null
    };
    const symbol = extractTextDeclarations(record).find((candidate) => candidate.name === entry.name);
    assert.ok(symbol, `${entry.language} must locate ${entry.name}`);
    assert.equal(symbol.symbolKind, entry.kind, `${entry.language} kind`);
    assert.equal(symbol.line, 2, `${entry.language} line`);
    assert.equal(symbol.column, 3 + entry.source.indexOf(entry.name), `${entry.language} column`);
  }
});

test('supported polyglot declarations are indexed at literal source locations while binary files are skipped', async () => {
  const root = makeCodeFixture();
  try {
    const fragment = await createCodeGraphExtractor().extract(fixtureInput(root));
    const python = fragment.nodes.find((node) => node.kind === 'symbol' && node.path === 'src/legacy.py' && node.label === 'legacy');
    assert.ok(python, 'a Python declaration must be indexed');
    assert.equal(python.locator?.line, 1);

    const swift = fragment.nodes.find((node) => node.kind === 'symbol' && node.path === 'native/Runner.swift' && node.label === 'Runner');
    assert.ok(swift, 'a Swift declaration must be indexed');
    assert.equal(swift.locator?.line, 2);

    const rust = fragment.nodes.find((node) => node.kind === 'symbol' && node.path === 'crates/engine/src/lib.rs' && node.label === 'evaluate');
    assert.ok(rust, 'a Rust declaration must be indexed');
    assert.equal(rust.locator?.line, 4);

    const rubyClass = fragment.nodes.find((node) => node.kind === 'symbol' && node.path === 'lib/task_runner.rb' && node.label === 'TaskRunner');
    assert.ok(rubyClass, 'a Ruby class declaration must be indexed');
    assert.equal(rubyClass.locator?.line, 2);
    assert.equal(rubyClass.metadata.symbolKind, 'class');
    const rubyMethod = fragment.nodes.find((node) => node.kind === 'symbol' && node.path === 'lib/task_runner.rb' && node.label === 'run_task');
    assert.ok(rubyMethod, 'a Ruby method declaration must be indexed');
    assert.equal(rubyMethod.locator?.line, 3);
    assert.equal(rubyMethod.metadata.symbolKind, 'method');

    const cppStruct = fragment.nodes.find((node) => node.kind === 'symbol' && node.path === 'native/engine.cpp' && node.label === 'EngineState');
    assert.ok(cppStruct, 'a C++ struct declaration must be indexed');
    assert.equal(cppStruct.locator?.line, 2);
    assert.equal(cppStruct.metadata.symbolKind, 'struct');
    const cppFunction = fragment.nodes.find((node) => node.kind === 'symbol' && node.path === 'native/engine.cpp' && node.label === 'run_engine');
    assert.ok(cppFunction, 'a C++ function declaration must be indexed');
    assert.equal(cppFunction.locator?.line, 6);
    assert.equal(cppFunction.metadata.symbolKind, 'function');

    const blob = fragment.skipped.find((skip) => skip.path === 'src/blob.ts');
    assert.ok(blob, 'a binary payload with a source extension must be skipped');
    assert.equal(blob.reason, 'binary');
    assert.ok(!fragment.nodes.some((node) => node.path === 'src/blob.ts'));
    assert.ok(fragment.nodes.some((node) => node.path === 'src/legacy.py'));
  } finally {
    removeFixture(root);
  }
});

test('full extraction retains internal symbols and source directories named build', async () => {
  const root = makeCodeFixture();
  try {
    const fragment = await createCodeGraphExtractor().extract(fixtureInput(root));
    const hidden = fragment.nodes.find((node) => node.kind === 'symbol' && node.path === 'src/internal.ts' && node.label === 'hiddenHelper');
    assert.ok(hidden, 'internal declarations are navigation targets even when they are not exported');
    assert.equal(hidden.metadata.exported, false);
    assert.ok(fragment.nodes.some((node) => node.kind === 'file' && node.path === 'src/core/build/build-once-runner.ts'));
    assert.ok(fragment.nodes.some((node) => node.kind === 'symbol' && node.path === 'src/core/build/build-once-runner.ts' && node.label === 'buildOnce'));
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

test('the inventory bounds directory entries even when they are not supported source files', async () => {
  const root = makeCodeFixture();
  try {
    for (let index = 0; index < 12; index += 1) fs.writeFileSync(path.join(root, `noise-${index}.md`), 'not code\n');
    const fragment = await createCodeGraphExtractor().extract(
      fixtureInput(root, { limits: fixtureLimits({ maxEntries: 4 }) })
    );
    assert.ok(fragment.skipped.some((skip) => skip.reason === 'cap_reached' && (skip.detail ?? '').includes('maxEntries=4')));
  } finally {
    removeFixture(root);
  }
});

test('the inventory walk is iterative and fails closed beyond its directory-depth bound', async () => {
  const root = makeCodeFixture();
  try {
    const deep = path.join(root, 'deep', 'one', 'two', 'three');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'value.ts'), 'export const value = 1;\n');
    const fragment = await createCodeGraphExtractor().extract(
      fixtureInput(root, { limits: fixtureLimits({ maxDepth: 2 }) })
    );
    assert.ok(fragment.skipped.some((skip) => skip.reason === 'cap_reached' && (skip.detail ?? '').includes('maxDepth=2')));
  } finally {
    removeFixture(root);
  }
});

test('a prepared inventory is reused for compilation instead of reading the source tree twice', async () => {
  const root = makeCodeFixture();
  try {
    const limits = fixtureLimits();
    const inventory = walkCodeInventory(root, limits);
    fs.rmSync(path.join(root, 'src', 'internal.ts'));
    const fragment = await createCodeGraphExtractor({ preparedInventory: inventory }).extract(
      fixtureInput(root, { limits })
    );
    assert.ok(fragment.nodes.some((node) => node.path === 'src/internal.ts'));
    assert.equal(fragment.inputHashes['src/internal.ts'], inventory.byRel.get('src/internal.ts')?.hash);
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
