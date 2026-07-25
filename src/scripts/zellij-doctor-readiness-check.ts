#!/usr/bin/env node
// @ts-nocheck
// zellij:doctor-readiness (1.20.2 Area 5.1/5.2).
//
// Verifies: (1) the doctor readiness matrix exposes only the current Zellij
// block with mad_ready=false-while-cli_ready-can-stay-true semantics, and
// (2) the screen-proof scrapeable section set is a strict SUBSET of the composed
// lane section superset (so the two layers can never silently diverge).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertGate, emitGate, importDist, root } from './gate-lib.js';

const { buildDoctorReadinessMatrix } = await importDist('core/doctor/doctor-readiness-matrix.js');
const { ZELLIJ_LANE_SECTIONS, ZELLIJ_SCREEN_SCRAPEABLE_SECTIONS } = await importDist('core/zellij/zellij-lane-renderer.js');

// --- Matrix readiness semantics (synthetic inputs, hermetic) ---
const baseConfig = { ok: true, checks: [
  { name: 'node_process_read', ok: true },
  { name: 'spawned_child_read', ok: true },
  { name: 'actual_codex_cli_config_load', ok: true, status: 'passed' }
], blockers: [] };

// Zellij missing → mad_ready false, cli_ready can stay true.
const missing = buildDoctorReadinessMatrix({
  codex: { bin: '/usr/bin/codex', available: true },
  codex_config: baseConfig,
  zellij: { status: 'missing', ok: false }
});
assertGate(missing.mad_ready === false, 'zellij missing must make mad_ready=false', { missing });
assertGate(missing.cli_ready === true, 'zellij missing must NOT block cli_ready', { missing });
assertGate(!Object.hasOwn(missing, 'tmux_removed_runtime') && !Object.hasOwn(missing, 'tmux'), 'readiness must expose only the current terminal runtime', { missing });
assertGate(missing.zellij && Array.isArray(missing.zellij.required_for), 'matrix must carry a zellij block with required_for', { missing });

// Zellij ok → mad_ready true (config readable).
const okMatrix = buildDoctorReadinessMatrix({
  codex: { bin: '/usr/bin/codex', available: true },
  codex_config: baseConfig,
  zellij: { status: 'ok', ok: true, version: '0.44.0', bin: 'zellij', min_version: '0.41.0' }
});
assertGate(okMatrix.mad_ready === true, 'zellij ok + readable config must make mad_ready=true', { okMatrix });

// --- Section subset invariant (5.2) ---
const superset = new Set(ZELLIJ_LANE_SECTIONS);
const missingFromSuperset = ZELLIJ_SCREEN_SCRAPEABLE_SECTIONS.filter((s) => !superset.has(s));
assertGate(missingFromSuperset.length === 0, 'screen-proof scrapeable sections must be a strict subset of lane sections', { missingFromSuperset });
assertGate(ZELLIJ_SCREEN_SCRAPEABLE_SECTIONS.length < ZELLIJ_LANE_SECTIONS.length, 'scrapeable subset must be smaller than the composed superset', {
  scrapeable: ZELLIJ_SCREEN_SCRAPEABLE_SECTIONS.length, lane: ZELLIJ_LANE_SECTIONS.length
});

// --- doctor source exposes the zellij_readiness block ---
const doctorSource = fs.readFileSync(path.join(root, 'src/commands/doctor.ts'), 'utf8');
assertGate(/zellij_readiness\s*:/.test(doctorSource), 'doctor result must expose a zellij_readiness block', {});

// --- built dist smoke: JSON and human output must expose the Zellij section ---
const doctorJson = spawnSync(process.execPath, ['dist/bin/sks.js', 'doctor', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
assertGate(doctorJson.stdout.trim().startsWith('{'), 'built doctor --json must print JSON', { stderr: doctorJson.stderr.slice(-2000), status: doctorJson.status });
const parsedDoctor = JSON.parse(doctorJson.stdout);
assertGate(parsedDoctor.zellij_readiness && parsedDoctor.zellij_readiness.schema === 'sks.zellij-readiness.v1', 'built doctor --json must carry zellij_readiness block', { zellij_readiness: parsedDoctor.zellij_readiness || null });

const doctorHuman = spawnSync(process.execPath, ['dist/bin/sks.js', 'doctor'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
assertGate(/(^|\n)Zellij:\n/.test(doctorHuman.stdout), 'built doctor human output must include Zellij section', { stdout_tail: doctorHuman.stdout.slice(-2000), stderr_tail: doctorHuman.stderr.slice(-2000), status: doctorHuman.status });

emitGate('zellij:doctor-readiness', {
  mad_ready_when_missing: false,
  cli_ready_when_missing: true,
  built_json_smoke: true,
  built_human_smoke: true,
  lane_sections: ZELLIJ_LANE_SECTIONS.length,
  scrapeable_sections: ZELLIJ_SCREEN_SCRAPEABLE_SECTIONS.length
});
