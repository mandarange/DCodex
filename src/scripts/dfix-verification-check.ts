#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, readMissionJson, runDfixFixture } from './sks-cli-gate-lib.js';

const result = runDfixFixture();
const verification = readMissionJson(result.mission_id, 'dfix-verification.json');
const proof = readMissionJson(result.mission_id, 'completion-proof.json');
assertGate(verification.status === 'passed' && proof.evidence?.dfix?.verification_status === 'passed', 'dfix verification evidence missing from proof', { verification, dfix: proof.evidence?.dfix });
emitGate('dfix:verification', { mission_id: result.mission_id });
