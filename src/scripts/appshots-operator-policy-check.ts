#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { assertGate, emitGate, importDist, root } from './gate-lib.js';

const detector = await importDist('core/codex/appshots-detector.js');
const policyMod = await importDist('core/codex/appshots-operator-policy.js');
const fixture = writeAppshotFixture('operator-policy');
const capability = detector.detectAppshotsCapability({ prompt: 'visual Appshots check', operatorActionRecorded: true });
const policy = policyMod.buildAppshotsOperatorPolicy(capability, { operatorActionRecorded: true, sourcePaths: [fixture.rel] });
const report = { schema: 'sks.appshots-operator-policy-check.v1', ok: policy.ok, policy };
const out = path.join(root, '.sneakoscope', 'reports', 'appshots-operator-policy.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

assertGate(policy.ok === true, 'Appshots operator policy must pass when action is recorded', report);
assertGate(policy.privacy_safety.no_background_screen_capture === true, 'Appshots policy must prevent background capture', report);
emitGate('appshots:operator-policy', { mode: policy.mode });

function writeAppshotFixture(name) {
  const dir = path.join(root, '.sneakoscope', 'reports', 'appshots-fixtures');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.redacted-appshot.json`);
  fs.writeFileSync(file, `${JSON.stringify({ fixture: true, redacted: true, text: '[redacted appshot fixture]' })}\n`);
  return { rel: path.relative(root, file).split(path.sep).join('/') };
}
