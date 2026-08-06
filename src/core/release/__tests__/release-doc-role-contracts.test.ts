import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { packageRoot } from '../../fsx.js';
import { escapeRegExp } from '../../text/regex.js';

async function source(relative: string): Promise<string> {
  return fsp.readFile(path.join(packageRoot(), relative), 'utf8');
}

function proseContract(phrase: string): RegExp {
  return new RegExp(
    phrase
      .trim()
      .split(/\s+/)
      .map(escapeRegExp)
      .join('\\s+')
  );
}

test('release documentation prose contracts ignore wrapping but preserve exact words and order', () => {
  const contract = proseContract('clean worktree and refreshes the pack after source changes');
  assert.match('clean worktree and refreshes the pack after\nsource changes', contract);
  assert.doesNotMatch('clean worktree and refreshes a different pack after source changes', contract);
  assert.doesNotMatch('source changes after the pack refreshes a clean worktree', contract);
});

test('TriWiki code-pack parent-commit freshness semantics stay documented and code-backed', async () => {
  const [docs, freshness] = await Promise.all([
    source('docs/release-readiness.md'),
    source('src/core/triwiki/code-pack-head-freshness.ts')
  ]);
  assert.match(docs, proseContract('git_head_sha` is the generation parent commit'));
  assert.match(docs, proseContract('metadata-only code-pack commit'));
  assert.match(docs, proseContract('clean worktree and refreshes the pack after source changes'));
  for (const token of [
    'metadata_only_history',
    'source_change_history',
    'pack_not_ancestor',
    'history_truncated',
    'git_timeout'
  ]) assert.match(freshness, new RegExp(token));
});

test('official Remote and SKS proof-aware fleet control remain separate in docs and code', async () => {
  const [docs, worker, command] = await Promise.all([
    source('docs/release-readiness.md'),
    source('src/core/remote/worker.ts'),
    source('src/core/commands/remote-command.ts')
  ]);
  assert.match(docs, proseContract('official Remote transport remains host-owned'));
  assert.match(docs, proseContract('SKS does not implement, proxy, or reverse engineer'));
  assert.match(docs, proseContract('proof-aware fleet control'));
  assert.match(worker, /official_remote_transport_owned:\s*false/);
  assert.match(worker, /official_remote_session_ids_are_sks_session_ids:\s*false/);
  assert.doesNotMatch(worker, /official_remote_transport_owned:\s*true/);
  assert.match(command, /action === 'readiness'/);
  assert.match(command, /action === 'machines'/);
  assert.match(command, /action === 'worker'/);
});
