#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const files = [
  'README.md',
  'CHANGELOG.md',
  'docs/computer-use-evidence.md',
  'docs/codex-lb.md',
  'docs/codex-cli-compat.md',
  'docs/codex-app.md',
  'docs/official-docs-compat.md',
  'docs/hooks-pat.md',
  'docs/goal-to-loop-migration.md',
  'docs/known-gaps.md',
  'docs/release-readiness.md'
];


const forbidden = [
  /Computer Use is always available/i,
  /live evidence is guaranteed/i,
  /Browser Use evidence is Computer Use evidence/i,
  /process-only setup is durable/i,
  /screenshots are published to shared TriWiki automatically/i
];

const currentDollarSurfaceFiles = [
  'README.md',
  'AGENTS.md',
  '.codex/SNEAKOSCOPE.md',
  'docs/codex-app.md',
  'docs/STOP_GATE_CONTRACT.md',
  'docs/completion-proof.md',
  'docs/computer-use-evidence.md',
  'docs/fast-mode-default.md',
  'docs/feature-inventory.md',
  'docs/naruto-worktree-parallelism.md',
  'docs/naruto.md',
  'docs/native-agent-kernel.md',
  'docs/native-agent-orchestration.md',
  'docs/no-subagent-scaling.md',
  'docs/orchestration-layers.md',
  'docs/release-readiness.md',
  'docs/research-implementation-handoff.md',
  'docs/research-pipeline.md',
  'docs/route-finalization.md',
  'docs/triwiki-wrongness-memory.md',
  'docs/ux-review-real-loop.md'
];
const legacyDollarCommandPattern = /\$(?:Agent|Team|MAD-DB|Swarm|ShadowClone|Kagebunshin|Ralph|Naruto|Work|DFix|Answer|Plan|Review|Fast-Mode|Fast-On|Fast-Off|Release-Review|QA-LOOP|PPT|Image-UX-Review|UX-Review|Visual-Review|UI-UX-Review|Computer-Use|CU|Goal|Commit|Commit-And-Push|Research|Super-Search|SEO-GEO-OPTIMIZER|AutoResearch|DB|MAD-SKS|GX|Wiki|Help|From-Chat-IMG)\b/g;

const results = [];
for (const file of files) {
  const full = path.join(root, file);
  const text = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
  const missing = text ? [] : ['file'];
  const forbiddenMatches = forbidden.filter((pattern) => pattern.test(text)).map(String);
  results.push({
    file,
    ok: Boolean(text) && missing.length === 0 && forbiddenMatches.length === 0,
    missing,
    forbidden: forbiddenMatches
  });
}

for (const file of currentDollarSurfaceFiles) {
  const full = path.join(root, file);
  const text = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
  const legacyDollarCommands = [...new Set(text.match(legacyDollarCommandPattern) || [])];
  results.push({
    file: `${file}#dollar-surface`,
    ok: Boolean(text) && legacyDollarCommands.length === 0,
    missing: text ? [] : ['file'],
    forbidden: legacyDollarCommands
  });
}

const ok = results.every((row) => row.ok);
console.log(JSON.stringify({
  schema: 'sks.docs-truthfulness-check.v1',
  ok,
  results
}, null, 2));
if (!ok) process.exitCode = 1;
