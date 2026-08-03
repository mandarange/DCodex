export interface LoopDomainRule {
  id: string;
  dirs: string[];
  gates: string[];
}

export interface LoopDomain {
  id: string;
  dirs: string[];
  files: string[];
  gates: string[];
  covers_work_order_items: string[];
}

export const LOOP_DOMAIN_RULES: LoopDomainRule[] = [
  { id: 'release', dirs: ['src/core/release', 'src/scripts/release-', 'release-gates.v2.json'], gates: ['release:*'] },
  { id: 'research', dirs: ['src/core/research', 'src/scripts/research-'], gates: ['research:*'] },
  { id: 'qa-loop', dirs: ['src/core/qa-loop', 'src/core/commands/qa-loop-command.ts'], gates: ['qa-loop:*'] },
  { id: 'naruto', dirs: ['src/core/naruto', 'src/core/commands/naruto-command.ts'], gates: ['naruto:*'] },
  { id: 'codex-control', dirs: ['src/core/codex-control', 'src/scripts/codex-'], gates: ['codex:*', 'codex-sdk:*'] },
  { id: 'image', dirs: ['src/core/image', 'src/core/image-generation'], gates: ['image:*'] },
  { id: 'mad-sks-sql-plane', dirs: ['src/core/mad-sks/sql-plane', 'src/core/db-safety.ts'], gates: ['mad-sks:sql-plane-*'] },
  { id: 'docs', dirs: ['docs', 'README.md', 'CHANGELOG.md'], gates: ['docs:*', 'changelog:check'] }
];

export function decomposeRequestIntoLoopDomains(request: string, changedFiles: string[] = []): LoopDomain[] {
  const text = `${request} ${changedFiles.join(' ')}`.toLowerCase();
  const explicitFiles = extractFilePaths(request).concat(changedFiles).filter(Boolean);
  const selected = new Map<string, LoopDomain>();
  for (const rule of LOOP_DOMAIN_RULES) {
    const matchedByText = [rule.id, ...domainAliases(rule.id)].some((needle) => text.includes(needle))
      || rule.dirs.some((dir) => text.includes(dir.toLowerCase()) || text.includes(lastPart(dir)));
    const matchedFiles = explicitFiles.filter((file) => rule.dirs.some((dir) => file === dir || file.startsWith(dir.replace(/\*+$/, ''))));
    if (!matchedByText && matchedFiles.length === 0) continue;
    selected.set(rule.id, {
      id: rule.id,
      dirs: rule.dirs.filter((dir) => !dir.includes('*')),
      files: matchedFiles,
      gates: rule.gates,
      covers_work_order_items: []
    });
  }
  if (selected.size === 0 && explicitFiles.length) {
    selected.set('loop-general-coding', { id: 'loop-general-coding', dirs: [], files: explicitFiles, gates: ['loop:affected'], covers_work_order_items: [] });
  }
  if (selected.size === 0) {
    selected.set('loop-general-coding', { id: 'loop-general-coding', dirs: ['src'], files: [], gates: ['loop:affected'], covers_work_order_items: [] });
  }
  return [...selected.values()];
}

function extractFilePaths(request: string): string[] {
  return [...request.matchAll(/(?:^|\s)([A-Za-z0-9_.@/-]+\.(?:ts|tsx|js|mjs|json|md|toml|yml|yaml))(?:\s|$)/g)]
    .map((match) => match[1])
    .filter((value): value is string => Boolean(value));
}

function lastPart(value: string): string {
  return value.split('/').at(-1)?.replace(/[^a-z0-9-]/gi, '').toLowerCase() || value.toLowerCase();
}

function domainAliases(id: string): string[] {
  if (id === 'codex-control') return ['codex', 'probe', 'capability'];
  if (id === 'release') return ['cache', 'gate', 'dag'];
  if (id === 'docs') return ['doc', 'docs', 'readme', 'changelog'];
  if (id === 'qa-loop') return ['qa'];
  return [];
}
