#!/usr/bin/env node
// @ts-nocheck
/**
 * latest-version:guidance gate.
 *
 * Fails when a user-facing surface tells someone to be on a specific version
 * number. Historical records, lockfiles, schema ids, fixtures, and the
 * machine-readable compatibility matrix are exempt by design.
 */
import fs from 'node:fs';
import path from 'node:path';
import { assertGate, emitGate, importDist, root } from './gate-lib.js';

const { scanLatestVersionGuidance, latestVersionGuidanceReport } = await importDist('core/policy/latest-version-guidance.js');

/** Docs that record the past or describe machine compatibility rather than advising a user. */
const DOC_EXEMPT_RE = /(?:^|\/)(?:CHANGELOG|RECALLPULSE_[^/]*|known-gaps|release-proof-truth)\.md$|compat|codex-0|migration|legacy-upgrade|sks-4-migration|-tasks\.md$/i;

/** Modules whose numbers exist for machine comparison, not user guidance. */
const SOURCE_EXEMPT = new Set([
  'src/core/codex-compat/codex-runtime-contract.ts',
  'src/core/release/npm-stage-tarball-verifier-support.ts'
]);

const SOURCE_EXEMPT_DIR_RE = /^src\/(?:scripts|vendor|generated)\//;

function walk(dir, accept, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', '.git', '__tests__', 'fixtures'].includes(entry.name)) continue;
      walk(rel, accept, out);
    } else if (accept(rel)) {
      out.push(rel);
    }
  }
  return out;
}

const exemptions = [];
const findings = [];
let scannedFiles = 0;

function scan(rel, options) {
  const absolute = path.join(root, rel);
  if (!fs.existsSync(absolute)) return;
  scannedFiles += 1;
  findings.push(...scanLatestVersionGuidance(rel, fs.readFileSync(absolute, 'utf8'), options));
}

// 1. README — the single most-read user surface.
scan('README.md', {});

// 2. General user documentation. Compatibility and migration records are exempt.
for (const rel of walk('docs', (candidate) => candidate.endsWith('.md') && path.dirname(candidate) === 'docs')) {
  if (DOC_EXEMPT_RE.test(rel)) {
    exemptions.push(rel);
    continue;
  }
  scan(rel, {});
}

// 3. CLI usage/help/error guidance and agent directives: only what the program
//    prints, so a comment justifying a compatibility constant is not a finding.
for (const rel of walk('src', (candidate) => candidate.endsWith('.ts'))) {
  if (SOURCE_EXEMPT.has(rel) || SOURCE_EXEMPT_DIR_RE.test(rel)) {
    exemptions.push(rel);
    continue;
  }
  scan(rel, { stringLiteralsOnly: true });
}

// 4. Menu bar user-visible strings.
for (const rel of walk('native', (candidate) => candidate.endsWith('.swift'))) {
  scan(rel, { stringLiteralsOnly: true });
}

const report = latestVersionGuidanceReport(findings, scannedFiles, exemptions);
const outDir = path.join(root, '.sneakoscope', 'reports');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'latest-version-guidance.json'), `${JSON.stringify(report, null, 2)}\n`);

assertGate(report.ok, 'user_facing_pinned_version_guidance', {
  findings: report.findings.slice(0, 40),
  total: report.findings.length,
  policy: 'Recommend the official latest stable release and let capability probes decide support. See docs/architecture/latest-version-guidance-policy.md.'
});

emitGate('latest-version:guidance', {
  scanned_files: report.scannedFiles,
  exempt_files: report.exemptions.length,
  findings: 0
});
