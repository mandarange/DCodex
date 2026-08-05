import type { ReleaseGateNode } from './release-gate-node.js';
import { buildTriWikiGateImpactMap } from '../triwiki/triwiki-gate-impact-map.js';

export const GATE_PACK_MANIFEST_SCHEMA = 'sks.gate-pack-manifest.v1';

export interface GatePackDefinition {
  id: string;
  description: string;
  max_parallel: number;
  estimated_ms: number;
  resource_classes: string[];
  gate_ids: string[];
}

export interface GatePackManifest {
  schema: typeof GATE_PACK_MANIFEST_SCHEMA;
  root: string;
  packs: GatePackDefinition[];
}

export const REQUIRED_GATE_PACK_IDS = [
  'release-parity',
  'codex-current',
  'doctor-production',
  'startup-mcp',
  'native-capability',
  'secret',
  'core-skill',
  'skill-dedupe',
  'loop-mesh',
  'qa-research-image',
  'triwiki'
] as const;

export function buildGatePackManifest(root: string, gates?: ReleaseGateNode[]): GatePackManifest {
  const impactMap = buildTriWikiGateImpactMap(root);
  const byPack = new Map<string, string[]>();
  for (const pack of REQUIRED_GATE_PACK_IDS) byPack.set(pack, []);
  for (const impact of impactMap.impacts) {
    const ids = byPack.get(impact.gate_pack) || [];
    ids.push(impact.gate_id);
    byPack.set(impact.gate_pack, ids);
  }
  for (const gate of gates || []) {
    const pack = packForGateId(gate.id);
    const ids = byPack.get(pack) || [];
    if (!ids.includes(gate.id)) ids.push(gate.id);
    byPack.set(pack, ids);
  }
  return {
    schema: GATE_PACK_MANIFEST_SCHEMA,
    root,
    packs: REQUIRED_GATE_PACK_IDS.map((id) => ({
      id,
      description: descriptionForPack(id),
      max_parallel: maxParallelForPack(id),
      estimated_ms: estimatedMsForPack(id),
      resource_classes: resourceClassesForPack(id),
      gate_ids: [...new Set(byPack.get(id) || [])].sort()
    }))
  };
}

export function packForGateId(id: string): string {
  if (id.startsWith('triwiki:')) return 'triwiki';
  if (id.startsWith('codex:')) return 'codex-current';
  if (id.startsWith('doctor:')) return 'doctor-production';
  if (id.startsWith('sksd:') || id.startsWith('probes:') || id.includes('mcp')) return 'startup-mcp';
  if (id.includes('native') || id.startsWith('agent:')) return 'native-capability';
  if (id.startsWith('secret:') || id.includes('secret')) return 'secret';
  if (id.startsWith('core-skill:')) return 'core-skill';
  if (id.includes('skill-dedupe') || id.startsWith('skill:')) return 'skill-dedupe';
  if (id.startsWith('orphan:')) return 'release-parity';
  if (id.startsWith('loop:')) return 'loop-mesh';
  if (id.startsWith('qa-') || id.startsWith('research:') || id.startsWith('image:')) return 'qa-research-image';
  return 'release-parity';
}

function descriptionForPack(id: string): string {
  const descriptions: Record<string, string> = {
    'release-parity': 'Version, DAG, parity, and package release gates.',
    'codex-current': 'Current Codex release capability and integration checks.',
    'doctor-production': 'Doctor repair and production safety checks.',
    'startup-mcp': 'Startup, MCP, daemon, and probe readiness checks.',
    'native-capability': 'Native agent and desktop capability checks.',
    secret: 'Secret-preservation and redaction checks.',
    'core-skill': 'Immutable core skill checks.',
    'skill-dedupe': 'Skill duplication and inventory checks.',
    'loop-mesh': 'Loop mesh runtime checks.',
    'qa-research-image': 'QA, research, and image route checks.',
    triwiki: 'TriWiki proof bank and affected graph checks.'
  };
  return descriptions[id] || id;
}

function maxParallelForPack(id: string): number {
  if (id === 'secret') return 1;
  if (id === 'qa-research-image' || id === 'codex-current') return 2;
  return 4;
}

function estimatedMsForPack(id: string): number {
  if (id === 'release-parity') return 25_000;
  if (id === 'triwiki') return 12_000;
  if (id === 'doctor-production') return 18_000;
  if (id === 'qa-research-image') return 30_000;
  return 15_000;
}

function resourceClassesForPack(id: string): string[] {
  if (id === 'secret') return ['secret-sensitive', 'fs-read'];
  if (id === 'qa-research-image') return ['browser-real', 'cpu-heavy', 'io-heavy'];
  if (id === 'codex-current') return ['remote-model-real'];
  return ['cpu-light', 'fs-read'];
}
