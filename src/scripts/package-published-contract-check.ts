#!/usr/bin/env node
import path from 'node:path';
import { assertGate, emitGate, readJson, root } from './sks-1-18-gate-lib.js';
import { readCurrentNpmPackProof } from '../core/release/npm-pack-proof.js';

const pkg = readJson('package.json');
const scripts = pkg.scripts || {};
const packProof = readCurrentNpmPackProof(root);
assertGate(packProof.ok && packProof.proof, 'current npm pack proof is required for package contract check', { blockers: packProof.blockers });
const info = packProof.proof!.info;
const files = new Set<string>((info.files || []).map((row: any) => String(row.path || '').replace(/\\/g, '/')));

/**
 * Only the scripts npm can run from an installed package are part of the
 * published contract: the lifecycle hooks, plus anything they chain into with
 * `npm run`. Repo-only scripts — builds, release gates, benchmarks — reference
 * dev tooling the tarball deliberately excludes (`!dist/scripts/**` with a
 * narrow allowlist), and requiring their targets to ship would push the entire
 * release-gate surface onto every consumer. A lifecycle script that reaches a
 * non-shipped file is still a hard failure: that is the install-breaking case.
 */
const LIFECYCLE_SCRIPTS = [
  'preinstall', 'install', 'postinstall', 'prepare',
  'prepack', 'postpack', 'prepublish', 'prepublishOnly', 'publish', 'postpublish'
];
const publishedScripts = resolvePublishedScriptClosure();
const missingTargets: Array<{ script: string; target: string }> = [];
for (const name of publishedScripts) {
  for (const target of scriptTargets(String(scripts[name] || ''))) {
    const normalized = target.replace(/^\.\//, '').replace(/\\/g, '/');
    if (normalized.startsWith('dist/') && !files.has(normalized)) missingTargets.push({ script: name, target: normalized });
  }
}
assertGate(missingTargets.length === 0, 'published package scripts must not reference missing tarball files', {
  missingTargets: missingTargets.slice(0, 50),
  missing_count: missingTargets.length,
  published_scripts: [...publishedScripts]
});
emitGate('package:published-contract', {
  files: files.size,
  script_count: Object.keys(scripts).length,
  published_script_count: publishedScripts.size,
  published_scripts: [...publishedScripts],
  missing_targets: 0,
  package: path.basename(info.filename || '')
});

/** Lifecycle hooks plus every script they reach through `npm run`. */
function resolvePublishedScriptClosure(): Set<string> {
  const seen = new Set<string>();
  const queue = LIFECYCLE_SCRIPTS.filter((name) => typeof scripts[name] === 'string');
  while (queue.length) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    for (const next of npmRunTargets(String(scripts[name] || ''))) {
      if (typeof scripts[next] === 'string' && !seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

function npmRunTargets(command: string): string[] {
  const names: string[] = [];
  const re = /npm\s+run\s+([A-Za-z0-9:_-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command))) {
    if (match[1]) names.push(match[1]);
  }
  return names;
}

function scriptTargets(command: string): string[] {
  const targets: string[] = [];
  const re = /(?:node|tsx|ts-node)\s+((?:\.\/)?dist\/[^\s;&|]+\.js)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command))) {
    if (match[1]) targets.push(match[1]);
  }
  return targets;
}
