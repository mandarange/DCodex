/**
 * Staging path helper for Architecture Map Align artifacts.
 * wiki-relative staging path rule shared with publishArchitectureMapToStage:
 * strip the `.sneakoscope/wiki/` prefix — never path.basename for nested wiki paths.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  ARCHITECTURE_MAP_ARTIFACT_RELS,
  ARCHITECTURE_MAP_DIR_REL
} from '../../triwiki/context-graph/store/architecture-map-store.js';

const WIKI_PREFIX = '.sneakoscope/wiki/';

function wikiRelativeStagingPath(artifactRel: string): string {
  if (!artifactRel.startsWith(WIKI_PREFIX)) {
    throw new Error(`artifact_outside_wiki:${artifactRel}`);
  }
  return artifactRel.slice(WIKI_PREFIX.length);
}

test('architecture-map staging paths nest under architecture-map/, matching ARTIFACT_RELS', () => {
  const mapUnder = ARCHITECTURE_MAP_DIR_REL.slice(WIKI_PREFIX.length);
  assert.equal(mapUnder, 'architecture-map');
  for (const rel of ARCHITECTURE_MAP_ARTIFACT_RELS) {
    const staged = wikiRelativeStagingPath(rel);
    assert.ok(staged.startsWith(`${mapUnder}/`), staged);
    assert.notEqual(path.basename(rel), staged);
  }
});

test('basename-only staging would collide for nested view files', () => {
  const names = ARCHITECTURE_MAP_ARTIFACT_RELS.map((rel) => path.basename(rel));
  // basenames alone lose the views/ directory — prove wiki-relative is required
  assert.ok(names.includes('manifest.json'));
  assert.ok(names.some((name) => name.endsWith('.mmd')));
  for (const rel of ARCHITECTURE_MAP_ARTIFACT_RELS) {
    if (rel.includes('/views/')) {
      assert.notEqual(wikiRelativeStagingPath(rel), path.basename(rel));
    }
  }
});
