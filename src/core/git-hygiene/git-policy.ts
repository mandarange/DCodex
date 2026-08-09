import path from 'node:path';
import { ensureDir, nowIso, PACKAGE_VERSION, readJson, writeJsonAtomic } from '../fsx.js';

export const GIT_POLICY_SCHEMA = 'sks.git-policy.v1';
export const SHARED_MEMORY_MANIFEST_SCHEMA = 'sks.shared-memory-manifest.v1';
export const GIT_HYGIENE_BLOCK = 'SKS MANAGED GIT HYGIENE';
export const GIT_ATTRIBUTES_BLOCK = 'SKS MANAGED GIT ATTRIBUTES';

export type GitPolicyMode = 'solo' | 'work' | 'strict-work' | 'ci';

export interface SksGitPolicy {
  schema: typeof GIT_POLICY_SCHEMA;
  version: string;
  mode: GitPolicyMode;
  shared_memory: {
    track: string[];
    generated_ignore: string[];
  };
  local_runtime: {
    ignore: string[];
  };
  large_artifacts: {
    image_binary_policy: 'off' | 'lfs' | 'manual' | 'lfs_or_manual';
    track_raw_screenshots: boolean;
    max_tracked_file_bytes: number;
  };
  security: {
    require_redaction: boolean;
    block_secret_patterns: boolean;
    block_mock_real_confusion: boolean;
  };
}

export interface SharedMemoryManifest {
  schema: typeof SHARED_MEMORY_MANIFEST_SCHEMA;
  version: string;
  generated_at: string;
  mode: GitPolicyMode;
  source_of_truth: string;
  shared_memory_plane: Array<{
    id: string;
    path: string;
    record_schema: string;
    git: 'tracked';
    merge: 'single-record-json';
  }>;
  generated_indexes: Array<{
    id: string;
    path: string;
    git: 'ignored';
    rebuild: string;
  }>;
  local_runtime_plane: Array<{
    id: string;
    path: string;
    git: 'ignored';
  }>;
  promotion_flow: string[];
  security: SksGitPolicy['security'];
}

export const SHARED_MEMORY_TRACK = [
  '.sneakoscope/wiki/records/**/*.json',
  '.sneakoscope/wiki/wrongness/**/*.json',
  '.sneakoscope/wiki/image-voxels/**/*.json',
  '.sneakoscope/wiki/avoidance-rules/**/*.json',
  '.sneakoscope/wiki/summaries/**/*.md',
  '.sneakoscope/wiki/project-policy.json',
  '.sneakoscope/shared-memory-manifest.json',
  '.sneakoscope/git-policy.json'
];

export const GENERATED_INDEX_IGNORE = [
  '.sneakoscope/wiki/indexes/**/*.json',
  '.sneakoscope/wiki/context-packs/**/*.json',
  '.sneakoscope/wiki/architecture-map/**',
  '.sneakoscope/wiki/architecture-map/**/*.mmd',
  '.sneakoscope/wiki/tmp/**'
];

export const LOCAL_RUNTIME_IGNORE = [
  '.sneakoscope/missions/**',
  '.sneakoscope/reports/**',
  '.sneakoscope/tmp/**',
  '.sneakoscope/cache/**',
  '.sneakoscope/arenas/**',
  '.sneakoscope/processes/**',
  '.sneakoscope/bench/**',
  '.sneakoscope/blackbox/**',
  '.sneakoscope/logs/**',
  '.sneakoscope/state/**',
  '.sneakoscope/db/**',
  '.sneakoscope/evidence/**',
  '.sneakoscope/proof/**',
  '.sneakoscope/perf/**',
  '.sneakoscope/research/**',
  '.sneakoscope/skills/**',
  '.sneakoscope/smoke-archives/**',
  '.sneakoscope/memory/**',
  '.sneakoscope/manifest.json',
  '.sneakoscope/policy.json',
  '.sneakoscope/db-safety.json',
  '.sneakoscope/db-safety-scan.json',
  '.sneakoscope/harness-guard.json',
  '.sneakoscope/managed-paths.json',
  '.sneakoscope/wiki/context-pack.json',
  '.sneakoscope/wiki/image-assets.json',
  '.sneakoscope/wiki/image-voxel-ledger.json',
  '.sneakoscope/wiki/wrongness-ledger.json',
  '.sneakoscope/wiki/wrongness-index.json',
  '.sneakoscope/wiki/wrongness-summary.md',
  '.sneakoscope/wiki/image-wrongness-index.json',
  '.sneakoscope/wiki/visual-anchors.json',
  '.sneakoscope/wiki/last-sweep-report.json',
  '.sneakoscope/wiki/architecture-map/**',
  '.sneakoscope/wiki/architecture-map/**/*.mmd',
  '.sneakoscope/**/*.log'
];

export const SHARED_MEMORY_DIRS = [
  '.sneakoscope/wiki/records/claims',
  '.sneakoscope/wiki/wrongness',
  '.sneakoscope/wiki/image-voxels',
  '.sneakoscope/wiki/avoidance-rules',
  '.sneakoscope/wiki/summaries',
  '.sneakoscope/wiki/indexes',
  '.sneakoscope/wiki/context-packs',
  '.sneakoscope/wiki/tmp'
];

export const LOCAL_RUNTIME_DIRS = [
  '.sneakoscope/missions',
  '.sneakoscope/reports',
  '.sneakoscope/tmp',
  '.sneakoscope/cache',
  '.sneakoscope/arenas',
  '.sneakoscope/processes',
  '.sneakoscope/bench',
  '.sneakoscope/blackbox',
  '.sneakoscope/logs',
  '.sneakoscope/state',
  '.sneakoscope/db',
  '.sneakoscope/evidence',
  '.sneakoscope/proof',
  '.sneakoscope/perf',
  '.sneakoscope/research',
  '.sneakoscope/skills',
  '.sneakoscope/smoke-archives',
  '.sneakoscope/memory'
];

export function normalizeGitPolicyMode(value: unknown = 'work'): GitPolicyMode {
  const mode = String(value || 'work').trim().toLowerCase();
  if (mode === 'solo' || mode === 'work' || mode === 'strict-work' || mode === 'ci') return mode;
  throw new Error(`Invalid SKS git policy mode: ${value}`);
}

export function gitPolicyPath(root: string): string {
  return path.join(root, '.sneakoscope', 'git-policy.json');
}

export function sharedMemoryManifestPath(root: string): string {
  return path.join(root, '.sneakoscope', 'shared-memory-manifest.json');
}

export function defaultGitPolicy(mode: GitPolicyMode = 'work'): SksGitPolicy {
  return {
    schema: GIT_POLICY_SCHEMA,
    version: PACKAGE_VERSION,
    mode,
    shared_memory: {
      track: [...SHARED_MEMORY_TRACK],
      generated_ignore: [...GENERATED_INDEX_IGNORE]
    },
    local_runtime: {
      ignore: [...LOCAL_RUNTIME_IGNORE]
    },
    large_artifacts: {
      image_binary_policy: 'lfs_or_manual',
      track_raw_screenshots: false,
      max_tracked_file_bytes: 262144
    },
    security: {
      require_redaction: true,
      block_secret_patterns: true,
      block_mock_real_confusion: true
    }
  };
}

export function defaultSharedMemoryManifest(policy: SksGitPolicy = defaultGitPolicy()): SharedMemoryManifest {
  return {
    schema: SHARED_MEMORY_MANIFEST_SCHEMA,
    version: policy.version,
    generated_at: nowIso(),
    mode: policy.mode,
    source_of_truth: 'canonical_sharded_records',
    shared_memory_plane: [
      row('claims', '.sneakoscope/wiki/records/claims/<claim-id>.json', 'sks.triwiki-claim-record.v1'),
      row('wrongness', '.sneakoscope/wiki/wrongness/<wrongness-id>.json', 'sks.triwiki-wrongness-record.v1'),
      row('image_voxels', '.sneakoscope/wiki/image-voxels/<image-asset-id>/<anchor-id>.json', 'sks.image-voxel-record.v1'),
      row('avoidance_rules', '.sneakoscope/wiki/avoidance-rules/<rule-id>.json', 'sks.avoidance-rule-record.v1'),
      row('summaries', '.sneakoscope/wiki/summaries/*.md', 'markdown-summary')
    ],
    generated_indexes: [
      generated('project_index', '.sneakoscope/wiki/indexes/project-index.json', 'sks wiki rebuild-index --json'),
      generated('wrongness_index', '.sneakoscope/wiki/indexes/wrongness-index.json', 'sks wiki rebuild-index --json'),
      generated('context_packs', '.sneakoscope/wiki/context-packs/latest.json', 'sks wiki refresh')
    ],
    local_runtime_plane: LOCAL_RUNTIME_DIRS.map((dir) => ({
      id: dir.split('/').at(-1) || dir,
      path: `${dir}/**`,
      git: 'ignored' as const
    })),
    promotion_flow: [
      'mission runtime artifact',
      'validate schema',
      'secret scan',
      'mock/static policy check',
      'redact when requested',
      'write deterministic canonical shard',
      'rebuild ignored indexes',
      'show intended git status'
    ],
    security: policy.security
  };
}

export async function ensureGitPolicy(root: string, opts: { mode?: unknown; write?: boolean; imageBinaryPolicy?: string | null } = {}): Promise<SksGitPolicy> {
  const mode = normalizeGitPolicyMode(opts.mode || 'work');
  const current = await readJson<SksGitPolicy | null>(gitPolicyPath(root), null);
  const policy = normalizeGitPolicy({
    ...(current?.schema === GIT_POLICY_SCHEMA ? current : defaultGitPolicy(mode)),
    version: PACKAGE_VERSION,
    mode
  });
  if (opts.imageBinaryPolicy) {
    const imagePolicy = String(opts.imageBinaryPolicy);
    if (!['off', 'lfs', 'manual', 'lfs_or_manual'].includes(imagePolicy)) throw new Error(`Invalid image binary policy: ${imagePolicy}`);
    policy.large_artifacts.image_binary_policy = imagePolicy as SksGitPolicy['large_artifacts']['image_binary_policy'];
  }
  if (opts.write) {
    await ensureSharedMemoryDirs(root);
    await writeJsonAtomic(gitPolicyPath(root), policy);
    await writeJsonAtomic(sharedMemoryManifestPath(root), defaultSharedMemoryManifest(policy));
  }
  return policy;
}

export async function readGitPolicy(root: string): Promise<SksGitPolicy> {
  const current = await readJson<SksGitPolicy | null>(gitPolicyPath(root), null);
  return normalizeGitPolicy(current?.schema === GIT_POLICY_SCHEMA ? current : defaultGitPolicy());
}

export async function ensureSharedMemoryDirs(root: string): Promise<void> {
  for (const dir of [...SHARED_MEMORY_DIRS, ...LOCAL_RUNTIME_DIRS]) await ensureDir(path.join(root, dir));
}

export function classifySksPath(relPath: string, policy: SksGitPolicy = defaultGitPolicy()): 'shared_memory' | 'generated_index' | 'local_runtime' | 'unknown_sks' | 'not_sks' {
  const rel = normalizeRelPath(relPath);
  if (!rel.startsWith('.sneakoscope/')) return 'not_sks';
  if (isLocalRuntimePath(rel, policy)) return 'local_runtime';
  if (isGeneratedIndexPath(rel, policy)) return 'generated_index';
  if (isSharedMemoryPath(rel, policy)) return 'shared_memory';
  return 'unknown_sks';
}

export function isSharedMemoryPath(relPath: string, _policy: SksGitPolicy = defaultGitPolicy()): boolean {
  const rel = normalizeRelPath(relPath);
  return rel.startsWith('.sneakoscope/wiki/records/')
    || rel.startsWith('.sneakoscope/wiki/wrongness/')
    || rel.startsWith('.sneakoscope/wiki/image-voxels/')
    || rel.startsWith('.sneakoscope/wiki/avoidance-rules/')
    || rel.startsWith('.sneakoscope/wiki/summaries/')
    || rel === '.sneakoscope/wiki/project-policy.json'
    || rel === '.sneakoscope/git-policy.json'
    || rel === '.sneakoscope/shared-memory-manifest.json';
}

export function isGeneratedIndexPath(relPath: string, _policy: SksGitPolicy = defaultGitPolicy()): boolean {
  const rel = normalizeRelPath(relPath);
  return rel.startsWith('.sneakoscope/wiki/indexes/')
    || rel.startsWith('.sneakoscope/wiki/context-packs/')
    || rel.startsWith('.sneakoscope/wiki/tmp/');
}

export function isLocalRuntimePath(relPath: string, _policy: SksGitPolicy = defaultGitPolicy()): boolean {
  const rel = normalizeRelPath(relPath);
  return LOCAL_RUNTIME_DIRS.some((dir) => rel === dir || rel.startsWith(`${dir}/`))
    || LOCAL_RUNTIME_IGNORE.filter((pattern) => !pattern.includes('*')).some((file) => rel === file)
    || /^\.sneakoscope\/.+\.log$/.test(rel);
}

export function normalizeRelPath(value: string): string {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
}

export function normalizeGitPolicy(value: Partial<SksGitPolicy> | null | undefined): SksGitPolicy {
  const base = defaultGitPolicy(normalizeGitPolicyMode(value?.mode || 'work'));
  return {
    ...base,
    ...value,
    schema: GIT_POLICY_SCHEMA,
    version: PACKAGE_VERSION,
    mode: normalizeGitPolicyMode(value?.mode || base.mode),
    shared_memory: {
      track: arrayOr(value?.shared_memory?.track, base.shared_memory.track),
      generated_ignore: arrayOr(value?.shared_memory?.generated_ignore, base.shared_memory.generated_ignore)
    },
    local_runtime: {
      ignore: arrayOr(value?.local_runtime?.ignore, base.local_runtime.ignore)
    },
    large_artifacts: {
      ...base.large_artifacts,
      ...(value?.large_artifacts || {})
    },
    security: {
      ...base.security,
      ...(value?.security || {})
    }
  };
}

function row(id: string, recordPath: string, recordSchema: string): SharedMemoryManifest['shared_memory_plane'][number] {
  return {
    id,
    path: recordPath,
    record_schema: recordSchema,
    git: 'tracked',
    merge: 'single-record-json'
  };
}

function generated(id: string, generatedPath: string, rebuild: string): SharedMemoryManifest['generated_indexes'][number] {
  return {
    id,
    path: generatedPath,
    git: 'ignored',
    rebuild
  };
}

function arrayOr(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? [...value] : [...fallback];
}
