/**
 * Hermetic fixture workspaces for the code graph extractor tests.
 *
 * Every fixture lives under `os.tmpdir()` and is removed by the test that made
 * it; nothing here touches the real HOME or the repository under test.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ContextGraphEdge,
  ContextGraphExtractionInput,
  ContextGraphExtractionLimits,
  ContextGraphFragment,
  ContextGraphNode
} from '../../../contracts.js';

export function fixtureLimits(overrides: Partial<ContextGraphExtractionLimits> = {}): ContextGraphExtractionLimits {
  return {
    maxFiles: 500,
    maxFileBytes: 512 * 1024,
    maxNodes: 5000,
    maxEdges: 20000,
    timeoutMs: 60_000,
    ...overrides
  };
}

export function fixtureInput(
  root: string,
  overrides: Partial<ContextGraphExtractionInput> = {}
): ContextGraphExtractionInput {
  return {
    root,
    changedPaths: null,
    limits: fixtureLimits(),
    observedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

function write(root: string, relative: string, contents: string): void {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, contents);
}

function lateImportSource(): string {
  const filler: string[] = [];
  for (let index = 1; index <= 125; index += 1) filler.push(`const pad${index} = ${index};`);
  filler.push("import { VERSION } from './alpha/index.js';");
  filler.push('export const lateVersion = `${VERSION}:${pad125}`;');
  filler.push('');
  return filler.join('\n');
}

/**
 * A small but load-bearing workspace: a path alias, a two-hop barrel chain, two
 * modules that both export `parse`, a literal and a computed dynamic import, an
 * import below line 120, a test file, and two unparseable files.
 */
export function makeCodeFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-code-graph-'));
  write(root, 'package.json', `${JSON.stringify({ name: 'code-graph-fixture', version: '0.0.0', private: true, type: 'module' }, null, 2)}\n`);
  write(
    root,
    'tsconfig.json',
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          baseUrl: '.',
          paths: { '@app/*': ['src/*'] },
          allowJs: true
        },
        include: ['src/**/*.ts']
      },
      null,
      2
    )}\n`
  );
  write(
    root,
    'src/alpha/index.ts',
    ["export const VERSION = 'alpha';", '', 'export function parse(input: string): string {', '  return `${VERSION}:${input}`;', '}', ''].join('\n')
  );
  write(
    root,
    'src/beta/index.ts',
    ['export function parse(input: string): string {', '  return input.trim();', '}', ''].join('\n')
  );
  write(
    root,
    'src/barrel/inner.ts',
    ['export function deepHelper(value: number): number {', '  return value * 2;', '}', ''].join('\n')
  );
  write(root, 'src/barrel/index.ts', ["export * from './inner.js';", ''].join('\n'));
  write(root, 'src/barrel/outer.ts', ["export { deepHelper } from './index.js';", ''].join('\n'));
  write(
    root,
    'src/consumer.ts',
    [
      "import { parse } from '@app/alpha/index.js';",
      "import { deepHelper } from './barrel/outer.js';",
      "import * as beta from '@app/beta/index.js';",
      '',
      'export async function run(value: string): Promise<string> {',
      '  const doubled = deepHelper(2);',
      "  const lazy = await import('./barrel/inner.js');",
      '  const computedSpecifier = `./barrel/${value}.js`;',
      '  const computed = await import(computedSpecifier);',
      '  return [parse(value), beta.parse(value), String(doubled), String(lazy.deepHelper(1)), String(computed)].join(":");',
      '}',
      ''
    ].join('\n')
  );
  write(root, 'src/late-import.ts', lateImportSource());
  write(
    root,
    'src/__tests__/consumer.test.ts',
    [
      "import { run } from '../consumer.js';",
      "import { parse } from '../alpha/index.js';",
      '',
      'export async function check(): Promise<boolean> {',
      "  return (await run('x')).length > 0 && parse('y').length > 0;",
      '}',
      ''
    ].join('\n')
  );
  write(root, 'src/legacy.py', 'def legacy():\n    return 1\n');
  write(
    root,
    'lib/task_runner.rb',
    ['# Runs a repository maintenance task.', 'class TaskRunner', '  def run_task(value)', '    value + 1', '  end', 'end', ''].join('\n')
  );
  write(
    root,
    'native/engine.cpp',
    ['// Executes the native graph engine.', 'struct EngineState {', '  int value;', '};', '', 'int run_engine(int value) {', '  return value + 1;', '}', ''].join('\n')
  );
  write(
    root,
    'native/Runner.swift',
    ['/// Runs the native menu-bar command.', 'public struct Runner {', '  public func start() {}', '}', ''].join('\n')
  );
  write(
    root,
    'crates/engine/src/lib.rs',
    ['//! Evaluates the native graph accelerator.', 'pub struct Engine;', '', 'pub fn evaluate() -> bool { true }', ''].join('\n')
  );
  write(root, 'src/internal.ts', ['function hiddenHelper(): number {', '  return 1;', '}', '', 'export const publicValue = hiddenHelper();', ''].join('\n'));
  write(root, 'src/core/build/build-once-runner.ts', 'export function buildOnce(): boolean { return true; }\n');
  // A source file that legitimately uses a raw NUL as a key separator, exactly
  // like `context-graph/ids.ts` does. It must still be parsed.
  write(
    root,
    'src/nul-key.ts',
    [
      'export function cacheKey(left: string, right: string): string {',
      `  return \`\${left}${String.fromCharCode(0)}\${right}\`;`,
      '}',
      ''
    ].join('\n')
  );
  fs.writeFileSync(path.join(root, 'src', 'blob.ts'), binaryPayload());
  return root;
}

/** Undecodable bytes carrying a source extension: a PNG header plus high-bit noise. */
function binaryPayload(): Buffer {
  const header = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const noise: number[] = [];
  for (let index = 0; index < 128; index += 1) noise.push((index * 7 + 0x80) % 256);
  return Buffer.from([...header, ...noise]);
}

export function removeFixture(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

export function nodesOfKind(fragment: ContextGraphFragment, kind: ContextGraphNode['kind']): ContextGraphNode[] {
  return fragment.nodes.filter((node) => node.kind === kind);
}

export function edgesOfType(fragment: ContextGraphFragment, type: ContextGraphEdge['type']): ContextGraphEdge[] {
  return fragment.edges.filter((edge) => edge.type === type);
}

export function findSymbol(fragment: ContextGraphFragment, relativePath: string, name: string): ContextGraphNode | undefined {
  return fragment.nodes.find((node) => node.kind === 'symbol' && node.path === relativePath && node.label === name);
}

export function hasEdge(
  fragment: ContextGraphFragment,
  type: ContextGraphEdge['type'],
  from: string,
  to: string
): boolean {
  return fragment.edges.some((edge) => edge.type === type && edge.from === from && edge.to === to);
}
