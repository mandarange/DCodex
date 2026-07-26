#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, importDist, root } from './gate-lib.js'

const { runRetentionBudget } = await importDist('core/retention/retention-budget.js')
const report = await runRetentionBudget(root)
assertGate(report.ok, 'retention_budget_failed', report)
emitGate('retention:budget', { budgets: report.budgets.length, oversized_jsonl: report.oversized_jsonl.length })
