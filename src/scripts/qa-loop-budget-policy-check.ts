#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, importDist } from './gate-lib.js'
const mod = await importDist('core/qa-loop/qa-loop-budget-policy.js')
const policy = mod.buildQaLoopBudgetPolicy({ usage: { source: 'fake', token_usage: { total_tokens: 95 }, usage_limit_tokens: 100 } })
assertGate(policy.near_limit === true && policy.local_llm_draft_preferred === true && policy.final_reviewer_gpt_backed === true, 'QA budget policy must reduce remote concurrency near account limit while keeping GPT final reviewer', policy)
emitGate('qa-loop:budget-policy')
