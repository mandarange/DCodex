import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allRegexMatchIndexes,
  buildMutationAstIndex,
  mutationAstContextAt,
  mutationCallsiteOccurrences,
  mutationCallsiteSha256
} from '../mutation-callsite-analysis.js';

test('mutation scope comes from the TypeScript AST rather than prose or string contents', () => {
  const source = [
    '// fs.rm(commentTarget);',
    'const prose = "first-class MAD-DB and class Forged";',
    'const fake = "fs.rm(fakeTarget)";',
    'export async function realOwner() {',
    '  await fs.rm(realTarget);',
    '}'
  ].join('\n');
  const index = buildMutationAstIndex('fixture.ts', source);
  const fakeOffset = source.indexOf('fs.rm(fakeTarget)');
  const realOffset = source.indexOf('fs.rm(realTarget)');
  const fake = mutationAstContextAt(index, fakeOffset, 'fs.rm(fakeTarget)');
  const real = mutationAstContextAt(index, realOffset, 'fs.rm(realTarget)');

  assert.equal(fake.code_offset, false);
  assert.equal(real.code_offset, true);
  assert.equal(real.symbol, 'realOwner');
  assert.notEqual(real.symbol, 'MAD');
  assert.notEqual(real.symbol, 'Forged');
  assert.equal(index.calls.filter((call) => call.canonical_callee === 'fs.rm').length, 1);
});

test('identical mutations in one reviewed scope receive distinct occurrence identities', () => {
  const scopeContractSha256 = 'a'.repeat(64);
  const normalizedCall = 'fs.rm(target)';
  const hash = mutationCallsiteSha256({
    file: 'fixture.ts',
    symbol: 'owner',
    token: 'fs.rm',
    normalizedCall,
    scopeContractSha256
  });
  assert.deepEqual(mutationCallsiteOccurrences([hash, hash]), [1, 2]);
});

test('every risky token on one source line is enumerated', () => {
  assert.deepEqual(
    allRegexMatchIndexes(/\bfs\.rm\(/, 'await fs.rm(first); await fs.rm(second);'),
    [6, 26]
  );
});

test('AST discovery resolves bind, named-import, destructuring, and multiline mutation aliases', () => {
  const source = [
    "import fs from 'node:fs';",
    "import { rm as removeImported } from 'node:fs/promises';",
    'const removeTempDir = fs.rm.bind(fs);',
    'const { unlink: removeLink } = fs.promises;',
    'export async function clean(target: string) {',
    "  const dynamicFsp = await import('node:fs/promises');",
    '  await removeTempDir(',
    '    target,',
    '    { recursive: true, force: true }',
    '  );',
    '  await removeImported(target);',
    '  await removeLink(target);',
    '  await dynamicFsp.rm(target);',
    '}'
  ].join('\n');
  const calls = buildMutationAstIndex('fixture.ts', source).calls;
  const discovered = calls
    .filter((call) => ['fs.rm', 'fsp.rm', 'fs.promises.unlink'].includes(call.canonical_callee || ''))
    .map((call) => ({
      callee: call.canonical_callee,
      normalized: call.normalized_call,
      symbol: call.symbol
    }));

  assert.deepEqual(discovered, [
    {
      callee: 'fs.rm',
      normalized: 'removeTempDir( target, { recursive: true, force: true } )',
      symbol: 'clean'
    },
    { callee: 'fsp.rm', normalized: 'removeImported(target)', symbol: 'clean' },
    { callee: 'fs.promises.unlink', normalized: 'removeLink(target)', symbol: 'clean' },
    { callee: 'fsp.rm', normalized: 'dynamicFsp.rm(target)', symbol: 'clean' }
  ]);
});

test('AST discovery resolves call/apply, assignment aliases, and function-scoped var aliases', () => {
  const source = [
    "import fs from 'node:fs';",
    'let assignedRemove;',
    'assignedRemove = fs.rm;',
    'export async function clean(target: string, enabled: boolean) {',
    '  if (enabled) {',
    '    var blockDeclaredRemove = fs.rm;',
    '  }',
    '  await fs.rm.call(fs, target);',
    '  await fs.rm.apply(fs, [target]);',
    '  await assignedRemove(target);',
    '  await blockDeclaredRemove(target);',
    '}'
  ].join('\n');
  const discovered = buildMutationAstIndex('fixture.ts', source).calls
    .filter((call) => call.canonical_callee === 'fs.rm')
    .map((call) => ({
      normalized: call.normalized_call,
      symbol: call.symbol
    }));

  assert.deepEqual(discovered, [
    { normalized: 'fs.rm.call(fs, target)', symbol: 'clean' },
    { normalized: 'fs.rm.apply(fs, [target])', symbol: 'clean' },
    { normalized: 'assignedRemove(target)', symbol: 'clean' },
    { normalized: 'blockDeclaredRemove(target)', symbol: 'clean' }
  ]);
});

test('removing an enclosing validation guard changes the approved callsite fingerprint', () => {
  const guardedSource = [
    "import fs from 'node:fs';",
    'export async function clean(target: string) {',
    "  if (!target.startsWith('/tmp/sks-')) throw new Error('unsafe target');",
    '  await fs.rm(target, { recursive: true, force: true });',
    '}'
  ].join('\n');
  const weakenedSource = [
    "import fs from 'node:fs';",
    'export async function clean(target: string) {',
    '  await fs.rm(target, { recursive: true, force: true });',
    '}'
  ].join('\n');
  const guarded = buildMutationAstIndex('fixture.ts', guardedSource).calls.find((call) => call.canonical_callee === 'fs.rm');
  const weakened = buildMutationAstIndex('fixture.ts', weakenedSource).calls.find((call) => call.canonical_callee === 'fs.rm');
  assert.ok(guarded);
  assert.ok(weakened);

  const fingerprint = (call: NonNullable<typeof guarded>) => mutationCallsiteSha256({
    file: 'fixture.ts',
    symbol: call.symbol,
    token: 'fs.rm',
    normalizedCall: call.normalized_call,
    scopeContractSha256: call.scope_contract_sha256
  });
  assert.notEqual(guarded.scope_contract_sha256, weakened.scope_contract_sha256);
  assert.notEqual(fingerprint(guarded), fingerprint(weakened));
});
