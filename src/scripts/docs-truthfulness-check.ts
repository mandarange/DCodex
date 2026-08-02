#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_UPGRADE_BASELINE_VERSION } from '../core/release/release-upgrade-baseline.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const packageVersion = String(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || '').trim();
const files = [
  'README.md',
  'CHANGELOG.md',
  'docs/computer-use-evidence.md',
  'docs/codex-lb.md',
  'docs/codex-0.136-compat.md',
  'docs/codex-0.135-compat.md',
  'docs/codex-cli-compat.md',
  'docs/codex-app.md',
  'docs/official-docs-compat.md',
  'docs/hooks-pat.md',
  'docs/goal-to-loop-migration.md',
  'docs/known-gaps.md',
  'docs/release-readiness.md'
];

const required = {
  'README.md': ['CHANGELOG.md', 'docs/release-readiness.md', 'gpt-image-2', 'Telegram Bot API', '`sks telegram pair`'],
  'CHANGELOG.md': ['1.14.0', 'DFix Extreme Speed Kernel', 'hook trust doctor', 'warning-zero'],
  'docs/computer-use-evidence.md': ['sks.computer-use-live-evidence.v1', 'probe_only', 'live_capture_blocked', 'local-only', 'Codex Chrome Extension'],
  'docs/codex-lb.md': ['durable_env_file', 'durable_keychain', 'shell_profile', 'process_only_ephemeral', 'base URL only'],
  'docs/codex-0.136-compat.md': ['rust-v0.136.0', 'codex:0.136-compat', 'codex archive', 'codex app-server --stdio', 'CODEX_API_KEY', 'server tokens'],
  'docs/codex-0.135-compat.md': ['rust-v0.135.0', 'codex:0.135-compat', 'named permission profiles'],
  'docs/codex-cli-compat.md': ['rust-v0.145.0', 'sks codex 0.144', 'Inherited Codex 0.136 Capabilities', 'session_archive_restore', 'profile_primary_selector', 'managed_network_proxy_env', 'goals_default_enabled', 'permission_profiles_requirements', 'SubagentStart', 'sks_zero_warning_disallowed', 'strict subset'],
  'docs/codex-app.md': ['rust-v0.145.0', 'sks codex 0.144', 'App Server v2', 'Codex Chrome Extension', 'gpt-image-2'],
  'docs/official-docs-compat.md': ['official-docs-compat-report.js', 'rust-v0.145.0', 'gpt-image-2', 'input_fidelity', 'additionalProperties:false'],
  'docs/hooks-pat.md': ['SubagentStop', 'strict subset', 'zero-warning'],
  'docs/goal-to-loop-migration.md': ['only persisted goal owner', 'creates no SKS mission', '--legacy-goal-runtime', 'fail with an instruction'],
  'docs/known-gaps.md': ['No P0', 'P1'],
  'docs/release-readiness.md': [
    `SKS ${packageVersion} Release Readiness`,
    '$sks-naruto',
    '$sks-work',
    'sks doctor --fix',
    'sks.update-status.v3',
    'generation parent commit',
    'metadata-only code-pack commit',
    'official Remote transport remains host-owned',
    'SKS does not implement',
    'proxy, or reverse engineer',
    'proof-aware fleet control',
    'npm stage publish',
    'npm stage approve <stage-id>',
    `${RELEASE_UPGRADE_BASELINE_VERSION} to ${packageVersion} upgrade smoke`
  ]
};

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
  'docs/codex-app.md',
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
  const missing = (required[file] || []).filter((needle) => !text.includes(needle));
  const forbiddenMatches = forbidden.filter((pattern) => pattern.test(text)).map(String);
  results.push({
    file,
    ok: Boolean(text) && missing.length === 0 && forbiddenMatches.length === 0,
    missing,
    forbidden: forbiddenMatches
  });
}

const readmeText = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const telegramOnboardingSteps = [
  'sks telegram setup --token-stdin',
  'sks menubar restart',
  'sks telegram pair --json',
  '/sks status {}'
];
const telegramOnboardingIndexes = telegramOnboardingSteps.map((step) => readmeText.indexOf(step));
const telegramOnboardingOrdered = telegramOnboardingIndexes.every((index, position) =>
  index >= 0 && (position === 0 || index > telegramOnboardingIndexes[position - 1])
);
results.push({
  file: 'README.md#telegram-onboarding-order',
  ok: telegramOnboardingOrdered,
  missing: telegramOnboardingOrdered ? [] : telegramOnboardingSteps,
  forbidden: []
});

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
