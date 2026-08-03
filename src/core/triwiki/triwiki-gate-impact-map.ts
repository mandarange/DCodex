import fs from 'node:fs';
import path from 'node:path';
import type { ReleaseGateManifestV2, ReleaseGateNode } from '../release/release-gate-node.js';
import { validateReleaseGateManifest } from '../release/release-gate-node.js';
import { DEFAULT_TRIWIKI_MODULE_CARDS, type TriWikiModuleCard } from './triwiki-module-card.js';

export const TRIWIKI_GATE_IMPACT_MAP_SCHEMA = 'sks.triwiki-gate-impact-map.v1';

export interface TriWikiGateImpact {
  gate_id: string;
  modules: string[];
  gate_pack: string;
  cache_inputs: string[];
  resources: string[];
  semantic_dependencies: string[];
  fixture_dependencies: string[];
  resource_class: string[];
  expected_duration_ms_p50: number;
  expected_duration_ms_p95: number;
  orphan: boolean;
  command: string;
}

export interface TriWikiGateImpactMap {
  schema: typeof TRIWIKI_GATE_IMPACT_MAP_SCHEMA;
  root: string;
  gate_count: number;
  orphan_count: number;
  package_script_orphan_count: number;
  impacts: TriWikiGateImpact[];
  package_script_orphans: string[];
}

export function buildTriWikiGateImpactMap(root: string, cards: TriWikiModuleCard[] = DEFAULT_TRIWIKI_MODULE_CARDS): TriWikiGateImpactMap {
  const manifest = loadReleaseGateManifest(root);
  const scripts = loadPackageScripts(root);
  const impacts = manifest.gates.map((gate) => {
    const modules = modulesForGate(gate, cards);
    return {
      gate_id: gate.id,
      modules,
      gate_pack: gatePackForGate(gate, modules, cards),
      cache_inputs: gate.cache.inputs,
      resources: gate.resource,
      semantic_dependencies: semanticDependenciesForGate(gate),
      fixture_dependencies: fixtureDependenciesForGate(gate),
      resource_class: gate.resource,
      expected_duration_ms_p50: expectedDurationForGate(gate, 0.5),
      expected_duration_ms_p95: expectedDurationForGate(gate, 0.95),
      orphan: !scriptExistsForGateCommand(gate.command, scripts),
      command: gate.command
    };
  });
  const packageScriptOrphans = findPackageScriptOrphans(manifest, scripts);
  const map: TriWikiGateImpactMap = {
    schema: TRIWIKI_GATE_IMPACT_MAP_SCHEMA,
    root,
    gate_count: impacts.length,
    orphan_count: impacts.filter((impact) => impact.orphan).length,
    package_script_orphan_count: packageScriptOrphans.length,
    impacts,
    package_script_orphans: packageScriptOrphans
  };
  writeImpactMap(root, map);
  return map;
}

export function loadReleaseGateManifest(root: string): ReleaseGateManifestV2 {
  const manifestPath = path.join(root, 'release-gates.v2.json');
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
  const validated = validateReleaseGateManifest(raw);
  if (!validated.ok || !validated.manifest) throw new Error(`release-gates.v2.json invalid: ${validated.errors.join(',')}`);
  return validated.manifest;
}

export function loadPackageScripts(root: string): Record<string, string> {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  return pkg.scripts || {};
}

export function modulesForGate(gate: ReleaseGateNode, cards: TriWikiModuleCard[] = DEFAULT_TRIWIKI_MODULE_CARDS): string[] {
  const modules = new Set<string>();
  for (const card of cards) {
    if (card.owns_gate_prefixes.some((prefix) => gate.id.startsWith(prefix))) modules.add(card.module_id);
    if (gate.cache.inputs.some((input) => card.paths.some((pattern) => inputMatches(pattern, input)))) modules.add(card.module_id);
  }
  if (!modules.size) modules.add('release');
  return [...modules].sort();
}

export function gatePackForGate(gate: ReleaseGateNode, modules: string[], cards: TriWikiModuleCard[] = DEFAULT_TRIWIKI_MODULE_CARDS): string {
  const explicitPack = (gate as ReleaseGateNode & { x_sks_pack?: string }).x_sks_pack;
  if (explicitPack) return explicitPack;
  if (gate.id.startsWith('triwiki:')) return 'triwiki';
  if (gate.id.startsWith('gate-pack:') || gate.id.startsWith('release:')) return 'release-parity';
  if (gate.id.startsWith('doctor:')) return 'doctor-production';
  if (gate.id.startsWith('sksd:') || gate.id.startsWith('probes:')) return 'startup-mcp';
  if (gate.id.startsWith('secret:') || gate.id.includes('secret')) return 'secret';
  if (gate.id.startsWith('legacy:') || gate.id.startsWith('orphan:')) return 'release-parity';
  const card = cards.find((candidate) => modules.includes(candidate.module_id) && candidate.gate_packs.length);
  return card?.gate_packs[0] || 'release-parity';
}

export function scriptExistsForGateCommand(command: string, scripts: Record<string, string>): boolean {
  const match = command.match(/^npm run ([^ ]+)/);
  if (!match) return true;
  const scriptName = match[1];
  return scriptName !== undefined && Object.prototype.hasOwnProperty.call(scripts, scriptName);
}

function inputMatches(pattern: string, input: string): boolean {
  const cleanPattern = pattern.replace(/\/\*\*$/, '');
  const cleanInput = input.replace(/\/\*\*.*$/, '');
  return cleanInput === cleanPattern || cleanInput.startsWith(`${cleanPattern}/`);
}

function semanticDependenciesForGate(gate: ReleaseGateNode): string[] {
  const deps = new Set<string>(gate.deps || []);
  for (const input of gate.cache.inputs || []) {
    if (input.includes('package')) deps.add('package-metadata');
    if (input.includes('release-gates')) deps.add('release-gate-manifest');
    if (input.includes('src/core/triwiki')) deps.add('triwiki-runtime');
  }
  return [...deps].sort();
}

function fixtureDependenciesForGate(gate: ReleaseGateNode): string[] {
  return (gate.cache.inputs || []).filter((input) => input.includes('fixture') || input.includes('test/')).sort();
}

function expectedDurationForGate(gate: ReleaseGateNode, quantile: 0.5 | 0.95): number {
  const resources = new Set(gate.resource || []);
  const base = resources.has('cpu-heavy') ? 45_000 : resources.has('remote-model-real') ? 90_000 : 12_000;
  return quantile === 0.95 ? Math.round(base * 2.5) : base;
}

function findPackageScriptOrphans(manifest: ReleaseGateManifestV2, scripts: Record<string, string>): string[] {
  const releaseScripts = new Set(manifest.gates.map((gate) => gate.command.match(/^npm run ([^ ]+)/)?.[1]).filter((value): value is string => Boolean(value)));
  return Object.keys(scripts)
    .filter((name) => /^(triwiki|gate-pack|scheduler|release|doctor|legacy|orphan|sks:401|certificate|build-once|sksd|probes):/.test(name))
    .filter((name) => !releaseScripts.has(name))
    .sort();
}

function writeImpactMap(root: string, map: TriWikiGateImpactMap): void {
  const file = path.join(root, '.sneakoscope', 'reports', 'triwiki-gate-impact-map.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(map, null, 2)}\n`);
}
