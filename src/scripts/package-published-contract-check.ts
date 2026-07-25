#!/usr/bin/env node
import path from 'node:path';
import { assertGate, emitGate, readJson, root } from './gate-lib.js';
import { readCurrentNpmPackProof } from '../core/release/npm-pack-proof.js';

const pkg = readJson('package.json');
const scripts = pkg.scripts || {};
const packProof = readCurrentNpmPackProof(root);
assertGate(packProof.ok && packProof.proof, 'current npm pack proof is required for package contract check', { blockers: packProof.blockers });
const info = packProof.proof!.info;
const files = new Set<string>((info.files || []).map((row: any) => String(row.path || '').replace(/\\/g, '/')));
const missingTargets: Array<{ script: string; target: string }> = [];
for (const [name, command] of Object.entries(scripts)) {
  for (const target of scriptTargets(String(command))) {
    const normalized = target.replace(/^\.\//, '').replace(/\\/g, '/');
    if (normalized.startsWith('dist/') && !files.has(normalized)) missingTargets.push({ script: name, target: normalized });
  }
}
assertGate(missingTargets.length === 0, 'published package scripts must not reference missing tarball files', {
  missingTargets: missingTargets.slice(0, 50),
  missing_count: missingTargets.length
});
emitGate('package:published-contract', {
  files: files.size,
  script_count: Object.keys(scripts).length,
  missing_targets: 0,
  package: path.basename(info.filename || '')
});

function scriptTargets(command: string): string[] {
  const targets: string[] = [];
  const re = /(?:node|tsx|ts-node)\s+((?:\.\/)?dist\/[^\s;&|]+\.js)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command))) {
    if (match[1]) targets.push(match[1]);
  }
  return targets;
}
