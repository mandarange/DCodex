#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate, importDist, root } from './gate-lib.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-seo-marketing-truth-'))
try {
  seedFixture(tmp)
  const searchVisibility = await importDist('core/search-visibility/index.js')
  const options = {
    root: tmp,
    url: null,
    target: 'package',
    framework: 'package',
    offline: true,
    strict: true,
    json: true,
    apply: false,
    yes: false,
    allowDirtyTouched: false,
    browser: false,
    includeLlmsTxt: false,
    includeMarketing: true,
    includeCompetitors: false,
    strategyRef: null,
    maxMarketingSources: 4,
    observeQueries: false,
    queryFile: null,
    scope: []
  }
  const research = await searchVisibility.runSearchVisibilityResearch('seo', null, options)
  assertGate(research.ok === true, 'offline marketing research must pass with internal source-backed claims', research)
  const strategy = await searchVisibility.runSearchVisibilityStrategy('seo', research.mission_id, options)
  assertGate(strategy.ok === true, 'marketing strategy must pass truthfulness gate', strategy)
  const missionDir = path.join(tmp, '.sneakoscope', 'missions', research.mission_id)
  const artifactDir = path.join(missionDir, 'search-visibility')
  const strategyArtifact = JSON.parse(fs.readFileSync(path.join(artifactDir, 'marketing-strategy.json'), 'utf8'))
  assertGate(strategyArtifact.strategy_quality?.score >= 80, 'marketing strategy quality score must pass threshold', strategyArtifact.strategy_quality)
  assertGate(strategyArtifact.strategy_quality?.unsupported_claims === 0, 'marketing strategy quality must have zero unsupported claims', strategyArtifact.strategy_quality)
  assertGate(Array.isArray(strategyArtifact.competitor_contrast), 'marketing strategy must expose competitor_contrast array', strategyArtifact)
  const gate = JSON.parse(fs.readFileSync(path.join(artifactDir, 'marketing-truthfulness-gate.json'), 'utf8'))
  assertGate(gate.schema === 'sks.search-visibility.marketing-truthfulness-gate.v1', 'truthfulness gate schema mismatch', gate)
  assertGate(gate.ok === true, 'truthfulness gate must pass safe source-backed strategy', gate)
  const unsafe = await importDist('core/search-visibility/marketing-truthfulness.js')
  const badGate = unsafe.evaluateMarketingTruthfulness({
    claims: [{
      id: 'bad-guarantee',
      text: 'guaranteed ranking and guaranteed traffic for every Codex project',
      claim_type: 'unsupported',
      source_ids: [],
      publishable: true,
      blockers: []
    }]
  })
  assertGate(badGate.ok === false, 'truthfulness gate must block forbidden/source-less marketing claims', badGate)
  const report = {
    schema: 'sks.seo-marketing-truthfulness-check.v1',
    ok: true,
    generated_at: new Date().toISOString(),
    mission_id: research.mission_id,
    strategy_quality: strategyArtifact.strategy_quality,
    blocked_forbidden_fixture: badGate.ok === false,
    blockers: []
  }
  const reportPath = path.join(root, '.sneakoscope', 'reports', 'seo-marketing-truthfulness.json')
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  emitGate('seo:marketing-truthfulness', {
    mission_id: research.mission_id,
    blocked_forbidden_fixture: badGate.ok === false,
    gate: 'search-visibility/marketing-truthfulness-gate.json',
    report: '.sneakoscope/reports/seo-marketing-truthfulness.json'
  })
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

function seedFixture(dir) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({
    name: 'sks-seo-marketing-fixture',
    version: '0.0.0',
    private: true,
    description: 'Proof-first Codex trust layer fixture.',
    keywords: ['sks', 'codex', 'seo']
  }, null, 2)}\n`)
  fs.writeFileSync(path.join(dir, 'README.md'), '# SKS SEO Marketing Fixture\n\nSuper-Search and SEO/GEO artifacts keep source-backed release evidence.\n')
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## Fixture\n\n- Source-backed release evidence.\n')
  fs.mkdirSync(path.join(dir, 'src/core'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src/core/routes.ts'), 'export const ROUTES = []\n')
  fs.mkdirSync(path.join(dir, 'src/core/agents'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src/core/agents/agent-orchestrator.ts'), 'export async function runNativeAgentOrchestrator() {}\n')
  fs.mkdirSync(path.join(dir, 'src/cli'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src/cli/command-manifest-lite.ts'), 'export const COMMAND_MANIFEST_LITE = []\n')
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'config/perf-budgets.v1.json'), '{"schema":"sks.perf-budgets.v1","commands":[]}\n')
  fs.mkdirSync(path.join(dir, '.sneakoscope/reports'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.sneakoscope/reports/super-search-local-http-smoke.json'), '{"ok":true,"verified_content":true}\n')
}
