/**
 * Architecture Map view registry — WO §12 view IDs.
 */
import type { ArchitectureMapViewId } from '../../architecture/contracts.js';
import { ARCHITECTURE_MAP_VIEW_IDS } from '../../architecture/contracts.js';
import type { MermaidViewSpec } from './contracts.js';

const SPECS: readonly MermaidViewSpec[] = Object.freeze([
  { viewId: 'project-topology', title: 'Project topology', direction: 'LR', filename: 'project-topology.mmd' },
  { viewId: 'module-dependency', title: 'Module dependency', direction: 'TD', filename: 'module-dependency.mmd' },
  { viewId: 'public-surface', title: 'Public surface', direction: 'LR', filename: 'public-surface.mmd' },
  { viewId: 'ssot-provenance', title: 'SSOT provenance', direction: 'TD', filename: 'ssot-provenance.mmd' },
  { viewId: 'runtime-control', title: 'Runtime control', direction: 'TD', filename: 'runtime-control.mmd' },
  { viewId: 'verification-coverage', title: 'Verification coverage', direction: 'LR', filename: 'verification-coverage.mmd' },
  { viewId: 'risk-domains', title: 'Risk domains', direction: 'TD', filename: 'risk-domains.mmd' },
  { viewId: 'change-impact', title: 'Change impact', direction: 'LR', filename: 'change-impact.mmd' },
  { viewId: 'architecture-delta', title: 'Architecture delta', direction: 'TD', filename: 'architecture-delta.mmd' },
  { viewId: 'ownership-workstream', title: 'Ownership workstream', direction: 'LR', filename: 'ownership-workstream.mmd' }
]);

export function architectureMapViewSpecs(): readonly MermaidViewSpec[] {
  return SPECS;
}

export function viewSpecFor(viewId: ArchitectureMapViewId): MermaidViewSpec {
  const spec = SPECS.find((entry) => entry.viewId === viewId);
  if (!spec) throw new Error(`unknown_architecture_map_view: ${viewId}`);
  return spec;
}

export function assertViewIdsMatchWo(): void {
  const fromSpecs = SPECS.map((spec) => spec.viewId);
  if (fromSpecs.length !== ARCHITECTURE_MAP_VIEW_IDS.length) {
    throw new Error('architecture_map_view_id_count_mismatch');
  }
  for (let index = 0; index < ARCHITECTURE_MAP_VIEW_IDS.length; index += 1) {
    if (fromSpecs[index] !== ARCHITECTURE_MAP_VIEW_IDS[index]) {
      throw new Error(`architecture_map_view_id_mismatch: ${fromSpecs[index]}`);
    }
  }
}
