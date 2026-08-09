/**
 * Voxel/Trie architecture context adapter.
 * When no structured provider exists, returns an explicit empty context (provider: none).
 * Never parses generated AGENTS.md for structural facts.
 */
import type { ArchitectureMapProfile, VoxelArchitectureContext } from './contracts.js';
import { hashCanonical } from './fingerprint.js';

export interface VoxelArchitectureContextProvider {
  readonly id: string;
  readonly version: string;
  load(input: {
    root: string;
    missionId?: string;
    taskText?: string;
  }): Promise<VoxelArchitectureContext>;
}

export function emptyVoxelContext(
  profile: ArchitectureMapProfile = 'global'
): VoxelArchitectureContext {
  return Object.freeze({
    provider: 'none',
    version: '0',
    seedNodeIds: Object.freeze([]),
    seedPaths: Object.freeze([]),
    riskDomains: Object.freeze([]),
    profile,
    workstreamHints: Object.freeze([]),
    tokenBudgetHint: null,
    protectedAreaIds: Object.freeze([])
  });
}

export class NoneVoxelArchitectureContextProvider implements VoxelArchitectureContextProvider {
  readonly id = 'none';
  readonly version = '0';

  async load(input: {
    root: string;
    missionId?: string;
    taskText?: string;
    profile?: ArchitectureMapProfile;
  }): Promise<VoxelArchitectureContext> {
    void input.root;
    void input.missionId;
    void input.taskText;
    return emptyVoxelContext(input.profile ?? 'global');
  }
}

const DEFAULT_PROVIDER = new NoneVoxelArchitectureContextProvider();

export async function loadVoxelArchitectureContext(input: {
  root: string;
  missionId?: string;
  taskText?: string;
  profile?: ArchitectureMapProfile;
  provider?: VoxelArchitectureContextProvider;
}): Promise<VoxelArchitectureContext> {
  const provider = input.provider ?? DEFAULT_PROVIDER;
  const loadInput: {
    root: string;
    missionId?: string;
    taskText?: string;
    profile?: ArchitectureMapProfile;
  } = { root: input.root };
  if (input.missionId !== undefined) loadInput.missionId = input.missionId;
  if (input.taskText !== undefined) loadInput.taskText = input.taskText;
  if (input.profile !== undefined) loadInput.profile = input.profile;
  return provider.load(loadInput);
}

export function voxelContextHash(context: VoxelArchitectureContext): string {
  return hashCanonical(context);
}
