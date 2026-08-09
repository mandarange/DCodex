import assert from 'node:assert/strict';
import test from 'node:test';
import { ALIGN_OUTPUT_ARTIFACTS } from '../align-route.js';
import { ARCHITECTURE_MAP_ARTIFACT_RELS } from '../../triwiki/context-graph/store/architecture-map-store.js';

test('ALIGN_OUTPUT_ARTIFACTS includes every ARCHITECTURE_MAP_ARTIFACT_RELS path', () => {
  assert.ok(ARCHITECTURE_MAP_ARTIFACT_RELS.length > 0);
  for (const rel of ARCHITECTURE_MAP_ARTIFACT_RELS) {
    assert.ok(
      ALIGN_OUTPUT_ARTIFACTS.includes(rel),
      `missing architecture-map artifact in ALIGN_OUTPUT_ARTIFACTS: ${rel}`
    );
  }
});

test('architecture-map artifacts nest under architecture-map/ with views/', () => {
  for (const rel of ARCHITECTURE_MAP_ARTIFACT_RELS) {
    assert.ok(rel.startsWith('.sneakoscope/wiki/architecture-map/'));
  }
  assert.ok(ARCHITECTURE_MAP_ARTIFACT_RELS.some((rel) => rel.includes('/views/')));
  assert.equal(new Set(ARCHITECTURE_MAP_ARTIFACT_RELS).size, ARCHITECTURE_MAP_ARTIFACT_RELS.length);
});

test('ALIGN_OUTPUT_ARTIFACTS remains unique after architecture-map expansion', () => {
  assert.equal(new Set(ALIGN_OUTPUT_ARTIFACTS).size, ALIGN_OUTPUT_ARTIFACTS.length);
  assert.ok(
    ALIGN_OUTPUT_ARTIFACTS.length >= 5 + ARCHITECTURE_MAP_ARTIFACT_RELS.length
  );
});
