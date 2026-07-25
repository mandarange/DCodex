#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises';
import path from 'node:path';
import { root, assertGate, emitGate, importDist, readText } from './gate-lib.js';

// Validates the lane UI design constraints: no line overflow at common widths,
// all required sections present, blocker cap + report pointer, middle-ellipsis
// for long paths, NO_COLOR / color-strippability, and that footer `sks ...`
// commands are really registered.

const ESC = '';
const ANSI_RE = /\[[0-9;]*m/g;

const mod = await importDist('core/zellij/zellij-lane-renderer.js');
const { composeLaneFrame, ZELLIJ_LANE_FOOTER_KEYS, ZELLIJ_LANE_MAX_BLOCKERS, ZELLIJ_LANE_SECTIONS } = mod;

assertGate(typeof composeLaneFrame === 'function', 'composeLaneFrame export missing', {});
assertGate(Array.isArray(ZELLIJ_LANE_FOOTER_KEYS), 'ZELLIJ_LANE_FOOTER_KEYS export missing', {});
assertGate(ZELLIJ_LANE_MAX_BLOCKERS === 3, 'ZELLIJ_LANE_MAX_BLOCKERS should be 3', { actual: ZELLIJ_LANE_MAX_BLOCKERS });

const longPath = `src/core/${'deep/'.repeat(40)}final-file.ts`;
const view = {
  missionId: 'M-ui',
  slot: 'slot-001',
  updatedAt: '2026-05-30T00:00:00.000Z',
  mode: 'Naruto',
  fast: 'on · service_tier=fast',
  workers: 'active 5/20 · workers 003/100 · pending 12',
  codexChild: 'active 5',
  currentFile: longPath,
  queue: 'pending 12 · applying 2 · verified 8 · blocked 0',
  patch: 'apply ok · verify ok · model-authored 3',
  lease: 'ok',
  protectedPaths: 'ok',
  rollback: 'ready',
  blockers: ['blocker_one', 'blocker_two', 'blocker_three', 'blocker_four', 'blocker_five', 'blocker_six'],
  reports: '.sneakoscope/reports/agent-proof-evidence.json',
  laneNote: 'fixture'
};

// Canonical composed-frame superset (shared with screen-proof's scrapeable subset).
const REQUIRED_SECTIONS = ZELLIJ_LANE_SECTIONS;

// No-overflow + all-sections across the common Zellij pane widths.
for (const width of [80, 100, 120]) {
  const frame = composeLaneFrame(view, { width, color: false });
  const lines = frame.split('\n');
  for (const line of lines) {
    assertGate(line.length <= width, `line_overflow_at_${width}`, { width, line, length: line.length });
  }
  for (const token of REQUIRED_SECTIONS) {
    assertGate(frame.includes(token), `missing section "${token}" at width ${width}`, { width, token });
  }
}

// Blocker cap at width 100: first 3 shown + "+3 more" + report path; the rest hidden.
const frame100 = composeLaneFrame(view, { width: 100, color: false });
for (const shown of ['blocker_one', 'blocker_two', 'blocker_three']) {
  assertGate(frame100.includes(shown), `blocker "${shown}" should be shown`, {});
}
assertGate(frame100.includes('+3 more'), 'should summarize "+3 more" overflow blockers', {});
assertGate(frame100.includes(view.reports), 'overflow summary should point at the report path', {});
for (const hidden of ['blocker_four', 'blocker_five', 'blocker_six']) {
  assertGate(!frame100.includes(hidden), `blocker "${hidden}" should be capped/hidden`, {});
}

// Middle-ellipsis: long path is truncated with '…' and the full run is gone.
const frame80 = composeLaneFrame(view, { width: 80, color: false });
assertGate(frame80.includes('…'), 'long path should be middle-ellipsized', {});
assertGate(!frame80.includes(longPath), 'full long path should not appear (truncated)', {});

// NO_COLOR respect: when color is derived from NO_COLOR, no ESC bytes appear.
process.env.NO_COLOR = '1';
const frameA = composeLaneFrame(view, { width: 100 });
assertGate(!frameA.includes(ESC), 'NO_COLOR=1 must suppress ANSI escape bytes', {});
const frameB = composeLaneFrame(view, { width: 100, color: false });
assertGate(!frameB.includes(ESC), 'color:false must suppress ANSI escape bytes', {});
delete process.env.NO_COLOR;

// With color on, stripping ANSI must still leave all sections readable.
const frameC = composeLaneFrame(view, { width: 100, color: true });
const stripped = frameC.replace(ANSI_RE, '');
for (const token of REQUIRED_SECTIONS) {
  assertGate(stripped.includes(token), `section "${token}" must survive ANSI strip`, { token });
}

// Footer `sks ...` commands must be real registry keys.
const registry = readText('src/cli/command-registry.ts');
const footerCommands = [];
for (const key of ZELLIJ_LANE_FOOTER_KEYS) {
  if (!key.startsWith('sks ')) continue;
  const cmd = key.split(/\s+/)[1];
  if (cmd) footerCommands.push(cmd);
}
for (const cmd of footerCommands) {
  const registered =
    registry.includes(`\n  ${cmd}:`) ||
    registry.includes(`'${cmd}':`) ||
    registry.includes(`"${cmd}":`);
  assertGate(registered, `footer command "${cmd}" is not a registered CLI command`, { cmd });
}
for (const required of ['doctor', 'zellij', 'naruto']) {
  assertGate(footerCommands.includes(required), `expected footer command "${required}" not found`, { footerCommands });
}

const report = {
  schema: 'sks.zellij-ui-design.v1',
  ok: true,
  widths: [80, 100, 120],
  sections: REQUIRED_SECTIONS.length,
  footer_commands: footerCommands
};
await fs.mkdir(path.join(root, '.sneakoscope', 'reports'), { recursive: true });
await fs.writeFile(
  path.join(root, '.sneakoscope', 'reports', 'zellij-ui-design.json'),
  `${JSON.stringify(report, null, 2)}\n`
);

emitGate('zellij:ui-design', { widths: [80, 100, 120], sections: REQUIRED_SECTIONS.length });
