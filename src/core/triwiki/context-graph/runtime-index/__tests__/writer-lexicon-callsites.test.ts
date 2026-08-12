import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Every production caller of `encodeContextIndex` must pass a lexicon.
 *
 * `lexicon` is optional with no default, deliberately: an absent lexicon is a
 * real state, not a defaulted one, and giving it a default would silently
 * change the bytes of every index built by a caller that meant to omit it.
 *
 * The cost of that choice is that forgetting it is invisible. An index built
 * without one carries four empty dictionary sections, so only the anchor lane
 * can answer — a search that resolves a pasted path and nothing else. It
 * already happened once: a lane concluded text retrieval was impossible,
 * wrote only anchor-lane assertions, and shipped a green suite that would have
 * locked zero recall in as the expected result. Nothing in the type system or
 * the test output would have said otherwise.
 *
 * So the guard is here rather than in a reviewer's memory. It scans source
 * rather than behaviour because the failure is an omission: there is no wrong
 * value to assert against, only a missing argument.
 */

/**
 * The compiled test runs from `dist/`, which holds no `.ts` at all. Resolving
 * to the repository's `src/` keeps the scan pointed at the source it is making
 * a claim about — and the empty-scan assertion below is what turns a wrong path
 * into a failure rather than a vacuous pass.
 */
const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../../..');
const SOURCE_ROOT = path.join(REPO_ROOT, 'src');

/**
 * Fixtures may omit it. A test that builds an index to exercise the reader's
 * bounds checks has no business carrying a dictionary, and requiring one would
 * make every fixture slower and none of them clearer.
 */
function isTestSource(file: string): boolean {
  return file.includes('/__tests__/') || file.endsWith('.test.ts') || file.endsWith('-fixtures.ts');
}

async function collectSources(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await collectSources(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * True when the offset sits on a comment line.
 *
 * A module that documents its own pipeline writes the call shape in its header,
 * and that is worth keeping — but a doc line is not a call site, and flagging
 * one teaches the next reader to distrust the guard. Checked per line rather
 * than by stripping comments wholesale, because a stripper that mishandles a
 * string containing `//` would silently drop a real call and the guard would
 * pass by seeing less.
 */
function isCommentLine(source: string, at: number): boolean {
  const lineStart = source.lastIndexOf('\n', at) + 1;
  const prefix = source.slice(lineStart, at).trimStart();
  return prefix.startsWith('*') || prefix.startsWith('//') || prefix.startsWith('/*');
}

/** The call's argument object, from `encodeContextIndex({` to its matching brace. */
function encodeCallArguments(source: string): string[] {
  const calls: string[] = [];
  const marker = 'encodeContextIndex({';
  for (let at = source.indexOf(marker); at >= 0; at = source.indexOf(marker, at + 1)) {
    if (isCommentLine(source, at)) continue;
    let depth = 0;
    let end = at + marker.length - 1;
    for (; end < source.length; end += 1) {
      if (source[end] === '{') depth += 1;
      else if (source[end] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push(source.slice(at, end + 1));
  }
  return calls;
}

test('every production caller of encodeContextIndex passes a lexicon', async () => {
  const sources = await collectSources(SOURCE_ROOT);
  const offenders: string[] = [];
  let checked = 0;

  for (const file of sources) {
    if (isTestSource(file)) continue;
    const source = await fsp.readFile(file, 'utf8');
    for (const call of encodeCallArguments(source)) {
      checked += 1;
      if (!/\blexicon\s*:/.test(call)) offenders.push(path.relative(SOURCE_ROOT, file));
    }
  }

  assert.ok(checked > 0, 'the scan found no call sites at all, so it is proving nothing');
  assert.deepEqual(
    offenders,
    [],
    `these build an index with four empty dictionary sections, so only the anchor lane can answer: ${offenders.join(', ')}`,
  );
});

test('the scan can actually see a missing lexicon', async () => {
  // A guard that cannot fail is a guard that has stopped working. This pins the
  // detector against the two shapes that matter: an omission, and a call that
  // merely mentions the word somewhere unrelated.
  const withLexicon = 'encodeContextIndex({ snapshot, configHash, schemaRevision, lexicon: CONFIG })';
  const without = 'encodeContextIndex({ snapshot, configHash, schemaRevision })';
  const nested = 'encodeContextIndex({ snapshot, configHash, extra: { nested: 1 }, lexicon: CONFIG })';
  const mentionsOnly = '// lexicon\nencodeContextIndex({ snapshot, configHash })';
  const documented = ' * pipeline: encodeContextIndex({ snapshot, configHash })';

  assert.match(encodeCallArguments(withLexicon)[0] as string, /\blexicon\s*:/);
  assert.doesNotMatch(encodeCallArguments(without)[0] as string, /\blexicon\s*:/);
  assert.match(encodeCallArguments(nested)[0] as string, /\blexicon\s*:/, 'a nested object must not truncate the call');
  assert.doesNotMatch(
    encodeCallArguments(mentionsOnly)[0] as string,
    /\blexicon\s*:/,
    'a comment above the call is not an argument to it',
  );
  // A module documenting its own pipeline is not a call site.
  assert.equal(encodeCallArguments(documented).length, 0, 'a doc line must not read as a call');
});
