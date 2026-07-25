import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { search, searchCapabilities, SEARCH_SCHEMA_VERSION } from '../index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('SearchProvider', () => {
  it('reports capabilities without requiring rg or ast-grep', async () => {
    const caps = await searchCapabilities(root);
    assert.equal(caps.schemaVersion, 1);
    assert.equal(caps.modes.files.externalBinaryRequired, false);
    assert.equal(caps.modes.text.externalBinaryRequired, false);
    assert.equal(caps.modes.structure.externalBinaryRequired, false);
  });

  it('finds files by query', async () => {
    const resp = await search({
      schemaVersion: SEARCH_SCHEMA_VERSION,
      mode: 'files',
      root,
      query: 'package.json',
      limits: { maxMatches: 20 }
    });
    assert.equal(resp.ok, true);
    assert.ok(resp.matches.some((m) => m.path.endsWith('package.json')));
    assert.equal(resp.matches[0]?.confidence, 'file_path');
  });

  it('text search labels confidence as text_candidate', async () => {
    const resp = await search({
      schemaVersion: SEARCH_SCHEMA_VERSION,
      mode: 'text',
      root,
      pattern: 'SEARCH_PROVIDER_SCHEMA',
      include: ['src/core/search/**'],
      limits: { maxMatches: 20 }
    });
    assert.equal(resp.ok, true);
    assert.ok(resp.matches.length > 0);
    assert.ok(resp.matches.every((m) => m.confidence === 'text_candidate'));
  });

  it('structure search returns capability error for unsupported language', async () => {
    const resp = await search({
      schemaVersion: SEARCH_SCHEMA_VERSION,
      mode: 'structure',
      root,
      pattern: 'function_declaration foo',
      language: 'python',
      limits: { maxMatches: 5 }
    });
    assert.equal(resp.ok, false);
    assert.ok(resp.errors.some((e) => e.includes('structure_unsupported_language')));
    assert.equal(resp.matches.length, 0);
  });

  it('symbol search never labels text hits as exact_reference', async () => {
    const resp = await search({
      schemaVersion: SEARCH_SCHEMA_VERSION,
      mode: 'symbol',
      root,
      query: 'search',
      include: ['src/core/search/**'],
      limits: { maxMatches: 80 }
    });
    assert.equal(resp.ok, true);
    assert.ok(!resp.matches.some((m) => m.confidence === 'exact_reference'));
  });
});
