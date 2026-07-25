#!/usr/bin/env node
import { assertGate, emitGate } from './gate-lib.js'
import { buildZellijSlotColumnAnchorCommand, renderZellijSlotColumnAnchor } from '../core/zellij/zellij-slot-column-anchor.js'

const rendered = renderZellijSlotColumnAnchor({
  activeWorkers: 3,
  visiblePaneCap: 8,
  headlessWorkers: 12,
  queueDepth: 44,
  mode: 'compact-slots'
})
const roster = renderZellijSlotColumnAnchor({
  activeWorkers: 1,
  visiblePaneCap: 5,
  headlessWorkers: 0,
  queueDepth: 0,
  mode: 'compact-slots',
  workerRows: [
    {
      slotId: 'slot-004',
      generationIndex: 1,
      placement: 'zellij-pane',
      status: 'running',
      backend: 'codex-sdk',
      task: 'Inspect Zellij slot UI assignment',
      heartbeatAgeMs: 900
    }
  ]
})
const overflow = renderZellijSlotColumnAnchor({
  activeWorkers: 6,
  visiblePaneCap: 5,
  headlessWorkers: 1,
  queueDepth: 0,
  mode: 'compact-slots',
  workerRows: [
    {
      slotId: 'slot-009',
      generationIndex: 1,
      placement: 'headless',
      status: 'running',
      backend: 'local-llm',
      task: 'Waiting for a visible slot pane',
      heartbeatAgeMs: 1200
    }
  ]
})
const command = buildZellijSlotColumnAnchorCommand({
  nodePath: '/usr/bin/node',
  cliPath: '/repo/dist/bin/sks.js',
  missionId: 'M-check',
  mode: 'compact-slots',
  artifactRoot: '/repo/.sneakoscope/missions/M-check/agents',
  watch: true
})
const ok = rendered.includes('SLOTS active 3/8 · headless 12 · q 44')
  && rendered.includes('visible slot panes stack below this anchor')
  && roster.includes('SLOTS active 1/5 · headless 0 · q 0')
  && roster.includes('visible slot panes stack below this anchor')
  && !roster.includes('slot-004 g1 running codex-sdk')
  && overflow.includes('slot-009 g1 running local-llm')
  && overflow.includes('Waiting for a visible slot pane')
  && command.includes('zellij-slot-column-anchor')
  && command.includes('--watch')
assertGate(ok, 'Zellij slot-column anchor must stay an anchor while slot workers render in dedicated stacked panes', { rendered, roster, overflow, command })
emitGate('zellij:slot-column-anchor', { rendered, roster, overflow, command })
