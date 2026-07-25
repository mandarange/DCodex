#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertGate, emitGate, readJson, root } from './gate-lib.js';
import { writeJsonAtomic } from '../core/fsx.js';

interface ReleaseGateScriptParityReport {
  schema: 'sks.release-gate-script-parity.v1';
  ok: boolean;
  release_gate_count: number;
  package_script_count: number;
  checked_required_ids: number;
  missing_entry_scripts: string[];
  missing_gates: string[];
  missing_release_preset: string[];
  missing_real_check_preset: string[];
  wrong_commands: Array<{ id: string; reason: string; actual: string }>;
  missing_source_targets: string[];
  missing_dist_targets: string[];
}

interface PackageJson {
  scripts?: Record<string, string>;
}

interface ReleaseGate {
  id: string;
  command: string;
  preset?: string[];
}

interface ReleaseGateManifest {
  gates?: ReleaseGate[];
}

export const REQUIRED_3110_RELEASE_IDS = [
  'core-skill:manifest',
  'core-skill:immutable-sync',
  'core-skill:no-drift',
  'core-skill:integrity-blackbox',
  'skill:name-canonicalizer',
  'skill:registry-ledger',
  'skill:dedupe',
  'skill:sync-atomic',
  'skill:dedupe-blackbox',
  'native-capability:repair-matrix',
  'native-capability:repair',
  'native-capability:postcheck',
  'native:image-generation-repair',
  'native:computer-use-repair',
  'native:chrome-web-review-repair',
  'native:app-screenshot-repair',
  'doctor:native-capability-repair',
  'doctor:native-repair-output',
  'doctor:native-capability-repair-blackbox',
  'secret:preservation',
  'config:managed-merge',
  'secret:preservation-guard',
  'secret:supabase-preservation-blackbox',
  'update:preserves-supabase-keys',
  'update:secret-preservation-guard',
  'update:secret-migration-journal',
  'safety:mutation-callsite-coverage',
  'release:gate-script-parity',
  'release:wiring-3110-blackbox',
  'sks:3112-all-feature-regression'
];

if (isMain()) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.stack || err.message : String(err));
    process.exit(1);
  });
}

export async function main(): Promise<void> {
  const report = buildReleaseGateScriptParityReport();
  const out = path.join(root, '.sneakoscope', 'reports', 'release-gate-script-parity.json');
  await writeJsonAtomic(out, report);

  assertGate(report.ok, 'release gate script parity failed', report);
  emitGate('release:gate-script-parity', {
    release_gate_count: report.release_gate_count,
    checked_required_ids: report.checked_required_ids
  });
}

export function buildReleaseGateScriptParityReport(): ReleaseGateScriptParityReport {
  const pkg = readJson('package.json') as PackageJson;
  const manifest = readJson('release-gates.v2.json') as ReleaseGateManifest;
  const scripts = pkg.scripts || {};
  const gates = Array.isArray(manifest.gates) ? manifest.gates : [];
  const gateById = new Map(gates.map((gate) => [gate.id, gate]));
  const releaseGateIds = gates.filter((gate) => gate.preset?.includes('release')).map((gate) => gate.id);
  const requiredReleaseIds = releaseGateIds;
  const requiredRealCheckIds = gates.filter((gate) => gate.preset?.includes('real-check')).map((gate) => gate.id);
  const requiredAllIds = [...new Set([...requiredReleaseIds, ...requiredRealCheckIds])];
  const requiredEntryScripts = [
    'build',
    'build:incremental',
    'typecheck',
    'release:check',
    'release:metadata',
    'release:check:affected',
    'release:check:fast',
    'release:check:confidence',
    'release:check:full',
    'prepublishOnly',
    'release:file-ownership',
    'release:macos-menubar-proof',
    'release:main-push-guard',
    'release:main-push-receipt',
    'release:pack-receipt',
    'runtime:installed-smoke',
    'gates:run',
    'policy:gate-audit'
  ];
  const missingEntryScripts = requiredEntryScripts.filter((id) => !scripts[id]).sort();
  const missingGates = requiredAllIds.filter((id) => !gateById.has(id)).sort();
  const missingReleasePreset = requiredReleaseIds.filter((id) => !gateById.get(id)?.preset?.includes('release')).sort();
  const missingRealCheckPreset = requiredRealCheckIds.filter((id) => !gateById.get(id)?.preset?.includes('real-check')).sort();
  const wrongCommands = requiredAllIds
    .map((id) => {
      const actual = gateById.get(id)?.command || '';
      return { id, actual, reason: directManifestCommandIssue(actual) };
    })
    .filter((row) => row.reason);
  const missingSourceTargets = requiredAllIds
    .map((id) => ({ id, source: sourceTargetForScript(gateById.get(id)?.command) }))
    .filter((row) => row.source && !fs.existsSync(path.join(root, row.source)))
    .map((row) => row.source as string)
    .sort();
  const missingDistTargets = requiredAllIds
    .map((id) => ({ id, dist: distTargetForScript(gateById.get(id)?.command) }))
    .filter((row) => row.dist && fs.existsSync(path.join(root, 'dist')) && !fs.existsSync(path.join(root, row.dist)))
    .map((row) => row.dist as string)
    .sort();
  return {
    schema: 'sks.release-gate-script-parity.v1',
    ok: missingEntryScripts.length === 0 && missingGates.length === 0 && missingReleasePreset.length === 0 && missingRealCheckPreset.length === 0 && wrongCommands.length === 0 && missingSourceTargets.length === 0 && missingDistTargets.length === 0,
    release_gate_count: releaseGateIds.length,
    package_script_count: Object.keys(scripts).length,
    checked_required_ids: requiredAllIds.length,
    missing_entry_scripts: missingEntryScripts,
    missing_gates: missingGates,
    missing_release_preset: missingReleasePreset,
    missing_real_check_preset: missingRealCheckPreset,
    wrong_commands: wrongCommands,
    missing_source_targets: missingSourceTargets,
    missing_dist_targets: missingDistTargets
  };
}

function directManifestCommandIssue(command: string | undefined): string {
  const text = String(command || '');
  if (!text) return 'missing_command';
  if (/\bnpm\s+run\b/.test(text)) return 'gate_command_must_not_require_package_script_alias';
  const segments = text.split(/\s+(?:&&|\|\|)\s+/).map((part) => part.trim()).filter(Boolean);
  const invalid = segments.find((part) => !(
    /^node\s+\.\/dist\/scripts\/[^\s]+\.js\b/.test(part)
    || /^node\s+\.\/dist\/bin\/sks\.js\b/.test(part)
    || /^node\s+\.\/node_modules\/typescript\/bin\/tsc\s+-p\s+tsconfig\.json\s+--noEmit$/.test(part)
    || /^node\s+--test\b/.test(part)
  ));
  if (invalid) {
    return 'gate_command_must_execute_dist_script_or_typecheck_directly';
  }
  return '';
}

function distTargetForScript(script: string | undefined): string | null {
  const match = String(script || '').match(/node\s+\.\/dist\/scripts\/([^\s]+\.js)/);
  return match ? `dist/scripts/${match[1]}` : null;
}

function sourceTargetForScript(script: string | undefined): string | null {
  const dist = distTargetForScript(script);
  if (!dist) return null;
  return dist.replace(/^dist\/scripts\//, 'src/scripts/').replace(/\.js$/, '.ts');
}

function isMain(): boolean {
  return path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url);
}
