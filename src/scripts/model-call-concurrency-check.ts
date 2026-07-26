#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { withModelCallSlot } from '../core/codex-control/model-call-concurrency.js'
import { writeParallelRuntimeProof } from '../core/agents/parallel-runtime-proof.js'
import { assertGate, emitGate } from './gate-lib.js'
const missionId = 'M-model-call-concurrency'
const ledgerRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-model-call-'))
await Promise.all(Array.from({ length: 8 }, (_, i) => withModelCallSlot({ root: ledgerRoot, missionId, provider: 'codex-sdk', budget: 3, slotId: `slot-${i}`, generationIndex: 1, sessionId: `s-${i}`, backend: 'codex-sdk' }, () => new Promise((resolve) => setTimeout(resolve, 80)))))
const proof = await writeParallelRuntimeProof(ledgerRoot, missionId, { requestedWorkers: 1, targetActiveSlots: 1, minActiveWorkers: 0, minSpeedupRatio: 0 })
assertGate(proof.max_observed_model_calls <= 3 && proof.unique_model_call_ids === 8, 'model-call semaphore did not enforce/record concurrency', proof)
emitGate('model-call:concurrency', proof)
