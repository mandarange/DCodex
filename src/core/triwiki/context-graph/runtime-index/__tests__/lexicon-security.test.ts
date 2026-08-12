import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONTEXT_LEXICON_FIELD_COUNT,
  CONTEXT_LEXICON_SCHEMA,
  ContextLexiconError,
  bm25fScore,
  bm25fWeightedTermFrequency,
  isWorkspaceRelativeLexiconPath,
  lexiconFieldMask,
  looksLikeSecretToken,
  redactMachinePaths,
  tokenizeLexiconField,
} from '../lexicon.js';
import { CONFIG, FIELD, build, docs, serialize, terms } from './lexicon-fixtures.js';

/**
 * Two ceilings that the rest of the system depends on and cannot re-check:
 *
 *   - **Confidence.** §4 of the contract fixes lexical results at
 *     `text_candidate` at any magnitude. The tempting way to "fix" the v1
 *     Korean and jargon misses is to let a strong text match claim `exact`, so
 *     the canonical-id field is made structurally untokenizable and postings
 *     are given no confidence field to promote into.
 *   - **Content.** Work order §1.4: absolute, home and temp paths, and secret
 *     material, must never be interned. Once a term is in the index it is
 *     indistinguishable from legitimate workspace text, so these are decided
 *     before tokenizing, and a refusal must not echo what it refused.
 */

// ---------------------------------------------------------------------------
// Confidence ceiling
// ---------------------------------------------------------------------------

test('the canonical id field cannot be tokenized at all', () => {
  // §4: a canonical id is an anchor-lane fact. If BM25F could reach it, a text
  // overlap could be reported as an exact relation.
  assert.throws(
    () => tokenizeLexiconField('gate:release:proof', FIELD.CANONICAL_ID, CONFIG),
    (error: unknown) => error instanceof ContextLexiconError && error.code === 'field_not_lexical',
  );
  const canonical = CONFIG.fields[FIELD.CANONICAL_ID];
  assert.ok(canonical);
  assert.equal(canonical.lexical, false);
  assert.equal(canonical.weight, 0);
});

test('a posting carries no confidence field for a score to be promoted into', () => {
  const built = build(docs([
    { node: 0, fields: [{ field: FIELD.EXACT_LABEL, text: 'queryContextGraphSnapshot' }] },
  ]));
  const posting = built.postings[0];
  assert.ok(posting);
  assert.deepEqual(Object.keys(posting).sort(), ['fieldMask', 'node', 'score', 'termFrequency']);
  assert.equal(built.schema, CONTEXT_LEXICON_SCHEMA);
});

test('no posting anywhere claims the canonical id field', () => {
  const built = build(docs([
    { node: 0, fields: [
      { field: FIELD.CANONICAL_ID, text: 'gate:release:proof' },
      { field: FIELD.EXACT_LABEL, text: 'release gate proof' },
    ] },
  ]));
  const canonicalBit = lexiconFieldMask(FIELD.CANONICAL_ID);
  for (const posting of built.postings) {
    assert.equal(posting.fieldMask & canonicalBit, 0);
  }
});

test('a non-lexical field contributes nothing to the weighted term frequency', () => {
  const perField = new Array<number>(CONTEXT_LEXICON_FIELD_COUNT).fill(0);
  const lengths = new Array<number>(CONTEXT_LEXICON_FIELD_COUNT).fill(4);
  const averages = new Array<number>(CONTEXT_LEXICON_FIELD_COUNT).fill(4);
  perField[FIELD.CANONICAL_ID] = 99;
  assert.equal(bm25fWeightedTermFrequency(perField, lengths, averages, CONFIG), 0);
  assert.equal(bm25fScore(0, 10, CONFIG), 0);
});

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

test('a path-shaped field refuses anything that is not workspace-relative POSIX', () => {
  for (const bad of ['/Users/alice/repo/a.ts', '~/repo/a.ts', 'C:\\Users\\alice\\a.ts', '../outside/a.ts']) {
    assert.throws(
      () => tokenizeLexiconField(bad, FIELD.PATH_SEGMENT, CONFIG),
      (error: unknown) => error instanceof ContextLexiconError && error.code === 'machine_path',
      bad,
    );
  }
  assert.ok(isWorkspaceRelativeLexiconPath('src/core/a.ts'));
  assert.ok(!isWorkspaceRelativeLexiconPath('/etc/passwd'));
  assert.ok(!isWorkspaceRelativeLexiconPath(''));
});

test('free text has machine paths redacted before it is split', () => {
  // Splitting first would leave the username behind as an ordinary-looking
  // term, which is the leak the rule exists to prevent.
  const emitted = terms('see /Users/weklem/Desktop/notes.md for detail', FIELD.EVIDENCE);
  assert.ok(!emitted.includes('weklem'));
  assert.ok(!emitted.includes('desktop'));
  assert.ok(emitted.includes('see'));
  assert.ok(emitted.includes('detail'));

  for (const shape of ['/home/bob/x', '/private/tmp/y', '/var/folders/ab/cd', '/tmp/z', '~/secrets']) {
    assert.ok(redactMachinePaths(`prefix ${shape} suffix`).redactedSpans >= 1, shape);
  }
  const scan = redactMachinePaths('/Users/alice/a /home/bob/b');
  assert.equal(scan.redactedSpans, 2);
  assert.ok(!scan.text.includes('alice'));
  assert.ok(!scan.text.includes('bob'));
});

test('high-entropy tokens are dropped whole, segments and acronym included', () => {
  const tokenized = tokenizeLexiconField(
    'key AKIAJ7Xk3mQpZ2rLvNb8 hash deadbeefdeadbeefdeadbeefdeadbeef end',
    FIELD.EVIDENCE,
    CONFIG,
  );
  assert.deepEqual([...tokenized.terms], ['key', 'hash', 'end']);
  // The camel segments of a key are as much of a leak as the key.
  assert.ok(!tokenized.terms.some((term) => term.includes('akiaj')));
  assert.ok(tokenized.omissions.secretTokens >= 2);
});

test('an ordinary long identifier is not mistaken for a secret', () => {
  assert.equal(looksLikeSecretToken('ContextGraphSnapshotBuilderFactory', CONFIG), false);
  assert.equal(looksLikeSecretToken('shortToken1A', CONFIG), false);
  assert.equal(looksLikeSecretToken('deadbeefdeadbeefdeadbeefdeadbeef', CONFIG), true);
});

test('errors carry a code and integers, never the rejected text', () => {
  try {
    tokenizeLexiconField('/Users/alice/secret-project/a.ts', FIELD.PATH_SEGMENT, CONFIG);
    assert.fail('expected a refusal');
  } catch (error) {
    assert.ok(error instanceof ContextLexiconError);
    assert.equal(error.message, 'machine_path');
    assert.equal(error.publicCode, 'context_lexicon_machine_path');
    assert.ok(error.repairCommand.length > 0);
    for (const value of Object.values(error.detail)) assert.equal(typeof value, 'number');
    assert.ok(!serialize(error.detail).includes('alice'));
  }
});
