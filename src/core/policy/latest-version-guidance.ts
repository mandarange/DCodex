/**
 * Latest-stable version guidance policy.
 *
 * User-facing guidance goes stale the moment it names a number. The rule for
 * every surface a user reads — README, CLI usage/help/error text, agent
 * directives, menu bar strings — is: recommend the official latest stable
 * release and let a capability probe decide what actually works.
 *
 * Historical records, lockfiles, schema revisions, migration fixtures, and
 * machine-readable compatibility matrices are deliberately exempt: they encode
 * facts about the past or about machine comparison, not advice to a user.
 */

export const LATEST_VERSION_GUIDANCE_SCHEMA = 'sks.latest-version-guidance.v1' as const;

export interface LatestVersionGuidanceFinding {
  path: string;
  line: number;
  version: string;
  trigger: string;
  excerpt: string;
}

export interface LatestVersionGuidanceReport {
  schema: typeof LATEST_VERSION_GUIDANCE_SCHEMA;
  ok: boolean;
  scannedFiles: number;
  findings: LatestVersionGuidanceFinding[];
  exemptions: string[];
}

/** A three-part version. Two-part engine ranges (`node >=20.11`) and schema ids (`.v1`) are intentionally not matched. */
const SEMVER_RE = /\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/g;

/**
 * Words that turn a bare number into advice. Matching is case-insensitive and
 * word-boundary anchored so `recurrent` does not trigger on `current`.
 */
export const GUIDANCE_TRIGGERS: readonly string[] = [
  'current release',
  'current version',
  'currently',
  'preferred',
  'minimum',
  'at least',
  'requires',
  'required',
  'require',
  'must be',
  'must use',
  'update to',
  'upgrade to',
  'recommend',
  'recommended',
  'or later',
  'or newer',
  'or above',
  'supported version',
  'baseline remains',
  '이상',
  '권장',
  '최소',
  '필요합니다',
  '사용하세요'
];

/**
 * Phrases that make a number a statement about the past or about machine
 * comparison rather than advice. Any of these in the same line suppresses the
 * finding.
 */
export const HISTORICAL_MARKERS: readonly string[] = [
  'changelog',
  'historical',
  'history',
  'previously',
  'fixed in',
  'regression',
  'released in',
  'shipped in',
  'was released',
  'compatibility matrix',
  'compatibility snapshot',
  'schema revision',
  'fixture',
  'reproduces',
  'as of the',
  'no longer'
];

export interface LatestVersionGuidanceScanOptions {
  /** Only inspect string literals (used for source files, where prose lives in comments). */
  stringLiteralsOnly?: boolean;
}

const STRING_LITERAL_RE = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;

/** How far around a version number counts as its own sentence. */
const WINDOW_CHARS = 90;

function containsTrigger(haystack: string): string | null {
  const lower = haystack.toLowerCase();
  for (const trigger of GUIDANCE_TRIGGERS) {
    if (lower.includes(trigger.toLowerCase())) return trigger;
  }
  return null;
}

function isHistorical(haystack: string): boolean {
  const lower = haystack.toLowerCase();
  return HISTORICAL_MARKERS.some((marker) => lower.includes(marker));
}

function excerpt(line: string): string {
  const compact = line.trim().replace(/\s+/g, ' ');
  return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
}

/**
 * Scan one file's text. Returns a finding per line that pairs a concrete
 * version with guidance wording.
 */
export function scanLatestVersionGuidance(
  relativePath: string,
  text: string,
  options: LatestVersionGuidanceScanOptions = {}
): LatestVersionGuidanceFinding[] {
  const findings: LatestVersionGuidanceFinding[] = [];
  const lines = text.split(/\r?\n/);
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine ?? '';
    const candidates: string[] = [];
    if (options.stringLiteralsOnly) {
      // In source files only what the program prints counts; a comment explaining
      // why a compatibility number exists is not user guidance.
      STRING_LITERAL_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = STRING_LITERAL_RE.exec(line))) candidates.push(match[0]);
    } else {
      candidates.push(line);
    }
    if (!candidates.length) continue;
    let reported = false;
    for (const candidate of candidates) {
      if (reported) break;
      SEMVER_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = SEMVER_RE.exec(candidate))) {
        // Judge each version in its own neighbourhood: a fixed-in sentence must
        // not excuse a different version on the same line that is genuine advice,
        // and a trailing changelog link must not excuse the whole line either.
        const window = candidate.slice(Math.max(0, match.index - WINDOW_CHARS), match.index + match[0].length + WINDOW_CHARS);
        if (isHistorical(window)) continue;
        const trigger = containsTrigger(window);
        if (!trigger) continue;
        findings.push({ path: relativePath, line: index + 1, version: match[0], trigger, excerpt: excerpt(line) });
        reported = true;
        break;
      }
    }
  }
  return findings;
}

/** The wording every user-facing surface should use instead of a number. */
export const LATEST_VERSION_GUIDANCE_TEXT =
  'Use the official latest stable SKS and Codex CLI releases. Run `sks update-check` and read the capability report for the current state — feature support is decided by capability probes, not by a pinned version number.';

export function latestVersionGuidanceReport(
  findings: LatestVersionGuidanceFinding[],
  scannedFiles: number,
  exemptions: string[]
): LatestVersionGuidanceReport {
  return {
    schema: LATEST_VERSION_GUIDANCE_SCHEMA,
    ok: findings.length === 0,
    scannedFiles,
    findings: [...findings].sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line),
    exemptions: [...exemptions].sort()
  };
}
