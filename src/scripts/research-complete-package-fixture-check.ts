#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate, importDist } from './gate-lib.js'

const research = await importDist('core/research.js')
const quality = await importDist('core/research/research-report-quality.js')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-research-complete-package-'))
const plan = await research.writeResearchPlan(dir, 'complete package fixture blackbox', { missionId: 'M-COMPLETE-PACKAGE' })
const gate = await research.writeMockResearchResult(dir, plan)
const metrics = gate.metrics || {}
const reportQuality = quality.analyzeResearchReportQuality(fs.readFileSync(path.join(dir, 'research-report.md'), 'utf8'))

assertGate(gate.passed === true, 'complete mock research package must pass', gate)
assertGate(metrics.report_word_count >= 2200, 'report must satisfy word floor', metrics)
assertGate(fs.existsSync(path.join(dir, 'research-synthesis-output.json')), 'synthesis output must exist')
assertGate(metrics.source_entries_total_with_counterevidence >= 12, 'source count must satisfy contract', metrics)
assertGate(metrics.source_layers_covered >= 5, 'source layer coverage must satisfy contract', metrics)
assertGate(metrics.key_claims >= 8, 'key claims must satisfy contract', metrics)
assertGate(metrics.counterevidence_sources >= 2, 'counterevidence count must satisfy contract', metrics)
assertGate(metrics.final_review_approved === true, 'static plus mock Codex final review must approve', metrics)
assertGate(metrics.implementation_blueprint_validation?.ok === true, 'blueprint must validate', metrics)
assertGate(metrics.experiment_plan_validation?.ok === true, 'experiment plan must validate', metrics)
assertGate(metrics.replication_pack_validation?.ok === true, 'replication pack must validate', metrics)
assertGate(reportQuality.ok === true, 'complete package report must pass anti-template quality checks', reportQuality)
assertGate(reportQuality.repetition.repeated_paragraph_ratio <= 0.18, 'complete package must not rely on repeated paragraphs', reportQuality.repetition)
assertGate(reportQuality.repetition.template_phrase_hits.length === 0, 'complete package must not contain template phrases', reportQuality.repetition)

emitGate('research:complete-package-fixture', { dir, metrics, report_quality: reportQuality })
