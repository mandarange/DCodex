#!/usr/bin/env node
import { assertGate, emitGate, readText } from './gate-lib.js'

const pane = readText('src/core/zellij/zellij-slot-pane-renderer.ts')
const command = readText('src/commands/zellij-slot-pane.ts')
const anchor = readText('src/core/zellij/zellij-slot-column-anchor.ts')
assertGate(pane.includes('readZellijSlotTelemetrySnapshot') && pane.includes('mergeRenderInputWithLiveTelemetry'), 'slot pane must read telemetry first and merge it with artifact detail')
assertGate(pane.includes('renderInputFromArtifactDir') && pane.includes('stdoutTail'), 'slot pane must preserve artifact/log fallback while live telemetry wins')
assertGate(command.includes('staleTicks') && command.includes('worker heartbeat lost >5m'), 'slot pane watch loop must close frozen heartbeat panes')
assertGate(anchor.includes('readZellijSlotTelemetrySnapshot') && anchor.includes('SLOTS telemetry stale'), 'slot anchor must render telemetry snapshot and stale state')
assertGate(anchor.includes('update-notice.json') && anchor.includes('MAD-SKS SQL-PLANE ACTIVE'), 'anchor must surface update notice and MAD-SKS SQL-plane state')
emitGate('zellij:slot-telemetry-renderer', { telemetry_with_artifact_fallback: true })
