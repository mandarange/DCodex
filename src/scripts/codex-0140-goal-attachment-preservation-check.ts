#!/usr/bin/env node
import { assertGate } from './gate-lib.js';
import { runCodex0140FeatureGate } from './codex-0140-feature-gate-lib.js';
const payload = { text: 'x'.repeat(70_000), attachments: [{ type: 'image', path: '/tmp/codex-0140-goal.png', sha256: 'fixture' }] };
const restored = JSON.parse(JSON.stringify(payload));
assertGate(restored.text.length === payload.text.length && restored.attachments[0]?.path === payload.attachments[0]?.path, 'goal attachment preservation fixture must keep large text and image path metadata');
await runCodex0140FeatureGate('codex:0140-goal-attachment-preservation', 'goal_attachment_preservation');
