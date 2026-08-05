import test from 'node:test';
import assert from 'node:assert/strict';
import { rebuildMemorySummaries, TRIWIKI_SUMMARY_SCHEMA_VERSION, WRONGNESS_SUMMARY_SCHEMA_VERSION } from '../../dist/core/memory-summary.js';
import { tempImageRoot } from '../helpers/ux-review-1-0-8-fixtures.mjs';

test('memory summary rebuild writes current schema v2 summaries', async () => {
  const { root } = await tempImageRoot('sks-memory-summary-');
  const summary = await rebuildMemorySummaries(root);
  assert.equal(summary.schema, 'sks.memory-summary.v2');
  assert.equal(summary.codex_0_133_behavior, 'versioned_summary_rebuild');
  assert.equal(summary.summaries.triwiki.schema_version, TRIWIKI_SUMMARY_SCHEMA_VERSION);
  assert.equal(summary.summaries.wrongness.schema_version, WRONGNESS_SUMMARY_SCHEMA_VERSION);
});
