#!/usr/bin/env node
import { assertGate, emitGate, makeTempRoot } from './skill-fixture-check-lib.js';
import { repairNativeCapabilities } from '../core/codex-native/native-capability-repair.js';

const root = await makeTempRoot('sks-native-image-');
const report = await repairNativeCapabilities({ root, fix: true, yes: true, capabilities: ['image_generation', 'image_followup_edit', 'saved_artifact_path_contract'], fixture: 'all-repairable' });
assertGate(report.capabilities.some((state) => state.id === 'image_generation' && state.after === 'verified'), 'image generation fixture should verify after repair', report);
assertGate(report.capabilities.some((state) => state.id === 'saved_artifact_path_contract' && state.after === 'verified'), 'saved artifact path contract should verify after repair', report);
emitGate('native:image-generation-repair');
