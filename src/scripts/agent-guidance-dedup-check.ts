#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeAgentGuidance, type GuidanceFile } from '../core/agent-guidance/directive-registry.js';
import { renderInitDeepAgentGuidance } from '../core/codex-app/codex-init-deep.js';
import { writeJsonAtomic } from '../core/fsx.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// The on-disk AGENTS.md files are generated per machine and gitignored, so the
// gate checks what the generator PRODUCES for a fixed set of directory shapes.
// That keeps the result identical on every machine and in CI.
const files: GuidanceFile[] = renderInitDeepAgentGuidance([
  { score: 1, dir: '.', file_count: 120, languages: ['ts'], guidance: 'Use local source conventions and keep changes owner-scoped.' },
  { score: 1, dir: 'src/core', file_count: 79, languages: ['ts'], guidance: 'Use local source conventions and keep changes owner-scoped.' },
  { score: 1, dir: 'src/core/release', file_count: 47, languages: ['ts'], guidance: 'High-risk SKS runtime area; hydrate TriWiki/current source before edits.' },
  { score: 1, dir: 'src/cli', file_count: 27, languages: ['ts'], guidance: 'Use local source conventions and keep changes owner-scoped.' },
  { score: 1, dir: 'docs', file_count: 40, languages: ['md'], guidance: 'Use local source conventions and keep changes owner-scoped.' }
]);

const report = analyzeAgentGuidance(files, { sharedScopePath: 'ROOT' });
const output = path.join(root, '.sneakoscope', 'reports', 'agent-guidance-dedup.json');
await writeJsonAtomic(output, report);
console.log(JSON.stringify(report, null, 2));
if (!report.ok) {
  console.error('Agent guidance carries directives that say nothing new.');
  console.error('State a directive once, at the broadest scope that covers its readers, and prefer the canonical principle over its restatements.');
  process.exitCode = 1;
}
