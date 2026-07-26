#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { assertGate, emitGate, importDist, root } from './gate-lib.js';

const mod = await importDist('core/codex/appshots-detector.js');
const notRequired = mod.detectAppshotsCapability({ prompt: 'nonvisual release metadata' });
const visualWithOperator = mod.detectAppshotsCapability({ prompt: 'verify UI with Appshots', operatorActionRecorded: true });
const visualMissing = mod.detectAppshotsCapability({ prompt: 'verify UI with Appshots' });
const report = { schema: 'sks.appshots-capability-check.v1', ok: notRequired.ok && visualWithOperator.ok && !visualMissing.ok, notRequired, visualWithOperator, visualMissing };
const out = path.join(root, '.sneakoscope', 'reports', 'appshots-capability.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

assertGate(notRequired.status === 'not_required', 'nonvisual prompts must not require Appshots', report);
assertGate(visualWithOperator.ok === true, 'operator-recorded visual Appshots must pass', report);
assertGate(visualMissing.ok === false, 'missing visual Appshots operator action must block', report);
emitGate('appshots:capability', { visual_required: visualWithOperator.visual_required });
