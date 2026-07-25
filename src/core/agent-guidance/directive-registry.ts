/**
 * Agent guidance is instruction budget. Every directive an AGENTS.md block
 * spends is context the model reads on each turn, so a directive earns its
 * place only if it says something no other directive already says.
 *
 * Two failures are worth catching mechanically:
 *
 * - Repetition: the same sentence copied into every directory block. It belongs
 *   once, at the broadest scope that covers the readers.
 * - Subsumption: several narrow directives ("document this", "add comments",
 *   "keep modules small", "make it reusable") that a single canonical principle
 *   already implies. SOLID is the canonical form of that whole family, so the
 *   derived phrasings are noise once the principle is stated.
 */

export interface CanonicalDirective {
  readonly id: string;
  /** The one statement that carries the whole family. */
  readonly statement: string;
  /** Phrasings this statement already implies; matched case-insensitively. */
  readonly subsumes: readonly RegExp[];
}

export const CANONICAL_DIRECTIVES: readonly CanonicalDirective[] = [
  {
    id: 'solid',
    statement: 'Follow SOLID: one responsibility per unit, depend on abstractions, extend rather than edit, and reuse instead of duplicating.',
    subsumes: [
      /\bmodular(ise|ize|ity)?\b/i,
      /\breusab(le|ility)\b/i,
      /\bavoid duplicat/i,
      /\bdon'?t repeat yourself\b|\bDRY\b/i,
      /\bkeep (?:functions|modules|files|classes) small\b/i,
      /\bsingle responsibility\b/i,
      /\bloose(ly)? coupl/i,
      /\bseparation of concerns\b/i
    ]
  },
  {
    id: 'self-documenting',
    statement: 'Write code that reads without commentary; comment only what the code cannot state itself.',
    subsumes: [
      /\badd comments?\b/i,
      /\bcomment your code\b/i,
      /\bdocument (?:everything|all|each) (?:function|method|class)/i,
      /\bwrite (?:jsdoc|docstrings?)\b/i
    ]
  },
  {
    id: 'managed-block',
    statement: 'Preserve user-authored content outside managed blocks.',
    subsumes: [/\bpreserve user-authored content\b/i, /\bdo not (?:edit|touch) user content\b/i]
  },
  {
    id: 'hydrate',
    statement: 'Hydrate TriWiki/current source before risky edits, and treat a directory marked `Risk: high` as always risky.',
    subsumes: [/\bhydrate triwiki\b/i, /\bread (?:the )?current source before edit/i]
  },
  {
    id: 'owner-scope',
    statement: 'Follow the conventions of the directory you are editing and keep every change owner-scoped.',
    subsumes: [/\buse local source conventions\b/i, /\bowner-scoped\b/i, /\bmatch (?:the )?surrounding (?:code|style)\b/i]
  }
];

export interface GuidanceFile {
  readonly path: string;
  readonly text: string;
}

export interface RepeatedDirective {
  readonly directive: string;
  readonly paths: readonly string[];
}

export interface SubsumedDirective {
  readonly path: string;
  readonly directive: string;
  readonly canonical: string;
}

export interface AgentGuidanceReport {
  readonly schema: 'sks.agent-guidance-dedup.v1';
  readonly ok: boolean;
  readonly files: number;
  readonly repeated: readonly RepeatedDirective[];
  readonly subsumed: readonly SubsumedDirective[];
  readonly blockers: readonly string[];
}

/** Directive bullets only — headings, metadata rows and prose are not directives. */
export function extractDirectives(text: string): string[] {
  const directives: string[] = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('- ')) continue;
    const body = line.slice(2).trim();
    if (!body) continue;
    // `- Files observed: 79` and friends are observations, not instructions.
    if (/^(files|files observed|languages|generated|local anchors|risk)\b\s*:/i.test(body)) continue;
    // A path listing (`- src/core/daemon`) is an anchor, not an instruction.
    if (!/\s/.test(body)) continue;
    directives.push(body.replace(/^guidance:\s*/i, ''));
  }
  return directives;
}

function canonicalFor(directive: string): CanonicalDirective | null {
  for (const canonical of CANONICAL_DIRECTIVES) {
    if (canonical.statement.toLowerCase() === directive.toLowerCase()) continue;
    if (canonical.subsumes.some((pattern) => pattern.test(directive))) return canonical;
  }
  return null;
}

/**
 * `sharedScopePath` is the file allowed to carry a directive for everyone — the
 * root block. A directive there may also appear nowhere else; anywhere else it
 * must be unique.
 */
export function analyzeAgentGuidance(
  files: readonly GuidanceFile[],
  opts: { readonly sharedScopePath?: string } = {}
): AgentGuidanceReport {
  const seen = new Map<string, string[]>();
  const subsumed: SubsumedDirective[] = [];
  for (const file of files) {
    const directives = extractDirectives(file.text);
    const withinFile = new Map<string, CanonicalDirective>();
    for (const directive of directives) {
      const key = directive.toLowerCase();
      seen.set(key, [...(seen.get(key) || []), file.path]);
      const canonical = canonicalFor(directive);
      if (canonical) withinFile.set(directive, canonical);
    }
    const statements = new Set(directives.map((entry) => entry.toLowerCase()));
    for (const [directive, canonical] of withinFile) {
      // Only a redundant pair is a finding: the derived phrasing plus the
      // canonical statement (or another phrasing of the same family) together.
      const siblings = directives.filter((entry) => entry !== directive && canonicalFor(entry)?.id === canonical.id);
      if (statements.has(canonical.statement.toLowerCase()) || siblings.length) {
        subsumed.push({ path: file.path, directive, canonical: canonical.statement });
      }
    }
  }
  const repeated: RepeatedDirective[] = [];
  for (const [key, paths] of seen) {
    const unique = [...new Set(paths)];
    if (unique.length < 2) continue;
    if (opts.sharedScopePath && unique.length === 1 && unique[0] === opts.sharedScopePath) continue;
    repeated.push({ directive: key, paths: unique.sort() });
  }
  repeated.sort((a, b) => b.paths.length - a.paths.length);
  const blockers = [
    ...repeated.map((entry) => `agent_guidance_repeated:${entry.paths.length}:${entry.directive.slice(0, 60)}`),
    ...subsumed.map((entry) => `agent_guidance_subsumed:${entry.path}:${entry.directive.slice(0, 60)}`)
  ];
  return {
    schema: 'sks.agent-guidance-dedup.v1',
    ok: blockers.length === 0,
    files: files.length,
    repeated,
    subsumed,
    blockers
  };
}
