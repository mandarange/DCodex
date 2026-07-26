#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, importDist } from './gate-lib.js'
const mod = await importDist('core/qa-loop/qa-loop-budget-policy.js')
const one = mod.selectQaLoopEscalatedEffort({ failureCount: 1, currentEffort: 'medium' })
const two = mod.selectQaLoopEscalatedEffort({ failureCount: 2, currentEffort: 'medium' })
assertGate(one.next_effort === 'medium' && two.next_effort === 'high' && two.escalated === true, 'QA-LOOP effort escalation must raise effort after repeated failures', { one, two })
emitGate('qa-loop:effort-escalation')
