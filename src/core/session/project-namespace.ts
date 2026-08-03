import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { nowIso, writeJsonAtomic } from '../fsx.js'

export interface ProjectNamespace {
  schema: 'sks.project-session-namespace.v1'
  generated_at: string
  project_root: string
  project_root_realpath: string
  root_hash: string
  project_namespace_id: string
  mission_id: string | null
  mission_namespace_id: string | null
  orchestrator_id: string
  temp_dir: string
  lock_dir: string
  artifact_dir: string
}

export async function projectRootRealpath(root = process.cwd()): Promise<string> {
  return fsp.realpath(path.resolve(root))
}

export function projectRootHash(realpathRoot: string): string {
  return crypto.createHash('sha256').update(realpathRoot).digest('hex').slice(0, 12)
}

export async function buildProjectNamespace(input: {
  root?: string
  missionId?: string | null
  orchestratorId?: string
} = {}): Promise<ProjectNamespace> {
  const projectRoot = path.resolve(input.root || process.cwd())
  const realpathRoot = await projectRootRealpath(projectRoot)
  const rootHash = projectRootHash(realpathRoot)
  const projectNamespaceId = `sks-${rootHash}`
  const missionId = input.missionId || null
  const missionNamespaceId = missionId ? `${projectNamespaceId}-${missionId}` : null
  const orchestratorId = input.orchestratorId || 'orchestrator'
  const namespaceForPaths = missionNamespaceId || projectNamespaceId
  return {
    schema: 'sks.project-session-namespace.v1',
    generated_at: nowIso(),
    project_root: projectRoot,
    project_root_realpath: realpathRoot,
    root_hash: rootHash,
    project_namespace_id: projectNamespaceId,
    mission_id: missionId,
    mission_namespace_id: missionNamespaceId,
    orchestrator_id: orchestratorId,
    temp_dir: path.join(os.tmpdir(), namespaceForPaths),
    lock_dir: path.join(projectRoot, '.sneakoscope', 'locks', rootHash),
    artifact_dir: missionId
      ? path.join(projectRoot, '.sneakoscope', 'missions', missionId)
      : path.join(projectRoot, '.sneakoscope', 'state', projectNamespaceId),
  }
}

export function namespacedAgentSessionId(input: {
  agentId: string
  missionId: string
  rootHash: string
  index?: number
}): string {
  const suffix = input.index === undefined ? '' : `-${String(input.index).padStart(2, '0')}`
  return `${input.agentId}-${input.missionId}-${input.rootHash}${suffix}`
}

export async function writeProjectNamespaceArtifact(
  artifactRoot: string,
  namespace: ProjectNamespace
): Promise<string> {
  const file = path.join(artifactRoot, 'project-session-namespace.json')
  await writeJsonAtomic(file, namespace)
  return file
}
