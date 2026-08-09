/**
 * Architecture Map wiki artifact layout and Align staging publish.
 *
 * Paths are wiki-relative after stripping `.sneakoscope/wiki/` — never
 * `path.basename` for nested artifacts (Align staging trap).
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ArchitectureMapPolicy } from '../architecture/policy.js';
import { loadArchitectureMapPolicy } from '../architecture/policy.js';
import type { ContextGraphSnapshot } from '../contracts.js';
import {
  buildArchitectureMapViews,
  type ArchitectureMapViewsResult
} from '../projections/mermaid/index.js';

const WIKI_PREFIX = '.sneakoscope/wiki/';

/** Workspace-relative root for global Architecture Map cache. */
export const ARCHITECTURE_MAP_DIR_REL = '.sneakoscope/wiki/architecture-map';

export const ARCHITECTURE_MAP_GLOBAL_VIEW_FILES = Object.freeze([
  'project-topology.mmd',
  'module-dependency.mmd',
  'public-surface.mmd',
  'ssot-provenance.mmd',
  'runtime-control.mmd',
  'verification-coverage.mmd',
  'risk-domains.mmd'
] as const);

export const ARCHITECTURE_MAP_ARTIFACT_RELS: readonly string[] = Object.freeze([
  `${ARCHITECTURE_MAP_DIR_REL}/manifest.json`,
  `${ARCHITECTURE_MAP_DIR_REL}/metrics.json`,
  `${ARCHITECTURE_MAP_DIR_REL}/findings.json`,
  ...ARCHITECTURE_MAP_GLOBAL_VIEW_FILES.map((name) => `${ARCHITECTURE_MAP_DIR_REL}/views/${name}`)
]);

export interface PublishArchitectureMapResult {
  readonly written: readonly string[];
  readonly stageMapDir: string;
  readonly built: ArchitectureMapViewsResult;
}

function byCodePoint(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

function wikiRelative(artifactRel: string): string {
  if (!artifactRel.startsWith(WIKI_PREFIX)) {
    throw new Error(`architecture_map_publish_artifact_outside_wiki:${artifactRel}`);
  }
  return artifactRel.slice(WIKI_PREFIX.length);
}

export async function publishArchitectureMapToStage(
  stageWikiAbs: string,
  snapshot: ContextGraphSnapshot,
  options: { root: string; policy?: ArchitectureMapPolicy; missionId?: string | null }
): Promise<PublishArchitectureMapResult> {
  const policy = options.policy ?? loadArchitectureMapPolicy(options.root);
  const built = buildArchitectureMapViews(snapshot, policy, {
    rootId: options.root,
    missionId: options.missionId ?? null
  });

  const written: string[] = [];
  const writeJson = async (rel: string, value: unknown) => {
    const dest = path.join(stageWikiAbs, wikiRelative(rel));
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    written.push(rel);
  };
  const writeText = async (rel: string, text: string) => {
    const dest = path.join(stageWikiAbs, wikiRelative(rel));
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
    written.push(rel);
  };

  await writeJson(`${ARCHITECTURE_MAP_DIR_REL}/manifest.json`, built.manifest);
  await writeJson(`${ARCHITECTURE_MAP_DIR_REL}/metrics.json`, built.metrics);
  await writeJson(`${ARCHITECTURE_MAP_DIR_REL}/findings.json`, { findings: built.findings });
  for (const view of built.views) {
    await writeText(`${ARCHITECTURE_MAP_DIR_REL}/views/${view.filename}`, view.text);
  }

  const expected = new Set(ARCHITECTURE_MAP_ARTIFACT_RELS);
  for (const rel of written) {
    if (!expected.has(rel)) throw new Error(`architecture_map_publish_unexpected_artifact:${rel}`);
  }
  if (written.length !== ARCHITECTURE_MAP_ARTIFACT_RELS.length) {
    throw new Error(
      `architecture_map_publish_incomplete:${written.length}/${ARCHITECTURE_MAP_ARTIFACT_RELS.length}`
    );
  }
  return {
    written: [...written].sort(byCodePoint),
    stageMapDir: path.join(stageWikiAbs, wikiRelative(ARCHITECTURE_MAP_DIR_REL)),
    built
  };
}
