#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate, importDist } from './gate-lib.js'

const research = await importDist('core/research.js')
const reviewer = await importDist('core/research/research-final-reviewer.js')
const fsx = await importDist('core/fsx.js')

const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-research-final-review-bad-'))
await research.writeResearchPlan(badDir, 'bad final reviewer fixture', { missionId: 'M-FINAL-BAD' })
await fsx.writeTextAtomic(path.join(badDir, 'research-report.md'), '# Bad\n\nToo short.\n')
const bad = await reviewer.runResearchFinalReviewer(badDir, { codexRequired: true })
assertGate(bad.approved === false, 'static failure must not approve final review', bad)

const templateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-research-final-review-template-'))
const templatePlan = await research.writeResearchPlan(templateDir, 'template final reviewer fixture', { missionId: 'M-FINAL-TEMPLATE' })
await research.writeMockResearchResult(templateDir, templatePlan)
await fsx.writeTextAtomic(path.join(templateDir, 'research-report.md'), [
  '# SKS Research Report',
  '',
  '## Question',
  'Runtime evidence note: This paragraph exists to make report quality measurable.',
  '',
  '## Methodology',
  'Runtime evidence note: This paragraph exists to make report quality measurable.',
  '',
  '## Source Map',
  'mock-source-1 mock-source-2 mock-source-3 mock-source-4 mock-source-5 mock-source-6 mock-source-7 mock-source-8.',
  '',
  '## Key Claims',
  '- mock-claim-1 cites mock-source-1 and mock-counter-1.',
  '',
  '## Evidence Matrix Summary',
  Array.from({ length: 36 }, () => 'Runtime evidence note: This paragraph exists to make report quality measurable while deterministic fixture text repeats the same sentence for mock-claim-1 using mock-source-1 and mock-counter-1.').join('\n\n'),
  '',
  '## Counterevidence',
  'mock-counter-1 and mock-counter-2 challenge the report.',
  '',
  '## Falsification',
  'Runtime evidence note: This paragraph exists to make report quality measurable.',
  '',
  '## Implementation Blueprint',
  'Runtime evidence note: This paragraph exists to make report quality measurable.',
  '',
  '## Experiment / Validation Plan',
  'Runtime evidence note: This paragraph exists to make report quality measurable.',
  '',
  '## Limitations',
  'Runtime evidence note: This paragraph exists to make report quality measurable.',
  '',
  '## References',
  '- mock-source-1',
  '- mock-counter-1'
].join('\n\n'))
await fsx.rmrf(path.join(templateDir, 'research-final-review.codex.json'))
const template = await reviewer.runResearchFinalReviewer(templateDir, { codexRequired: true })
assertGate(template.approved === false, 'template/repeated report must not approve final review', template)
assertGate((template.blockers || []).some((reason) => String(reason).includes('research_report_repeated_paragraphs') || String(reason).includes('research_report_template_phrase_hit')), 'template blockers must include repetition/template reasons', template)

const goodDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-research-final-review-good-'))
const plan = await research.writeResearchPlan(goodDir, 'good final reviewer fixture', { missionId: 'M-FINAL-GOOD' })
await research.writeMockResearchResult(goodDir, plan)
const good = JSON.parse(fs.readFileSync(path.join(goodDir, 'research-final-review.json'), 'utf8'))
assertGate(good.approved === true, 'complete package must approve final review with mock Codex reviewer', good)
assertGate(good.codex_review?.verdict === 'approve', 'merged final review must include Codex/mock approval', good)
assertGate(good.codex_review?.template_like_prose === false, 'mock Codex review must preserve template_like_prose=false', good)
assertGate(good.codex_review?.source_density_ok === true, 'mock Codex review must preserve source_density_ok=true', good)
assertGate(good.codex_review?.implementation_concreteness_ok === true, 'mock Codex review must preserve implementation_concreteness_ok=true', good)
assertGate(good.codex_review?.evidence_bound_synthesis_ok === true, 'mock Codex review must preserve evidence_bound_synthesis_ok=true', good)

emitGate('research:final-reviewer-blackbox', { bad_dir: badDir, template_dir: templateDir, good_dir: goodDir })
