#!/usr/bin/env node
import { assertGate, emitGate, readText } from './gate-lib.js'

const pane = readText('src/core/zellij/zellij-slot-pane-renderer.ts')
const command = readText('src/commands/zellij-slot-pane.ts')

assertGate(pane.includes('readZellijSlotTelemetrySnapshot'), 'slot pane renderer must read telemetry snapshots')
assertGate(pane.includes('mergeRenderInputWithLiveTelemetry'), 'slot pane renderer must prefer live telemetry over artifact detail')
assertGate(pane.includes('renderInputFromArtifactDir') && pane.includes('stdoutTail'), 'slot pane renderer must preserve artifact/log fallback details')
assertGate(pane.includes('latest_heartbeat') || pane.includes('heartbeat'), 'slot pane renderer must surface heartbeat/progress state')
assertGate(command.includes('artifactRoot') && command.includes('--artifact-root'), 'slot pane command must pass artifact root for telemetry lookup')
assertGate(command.includes('staleTicks') && command.includes('worker heartbeat lost >5m'), 'slot pane command must close zombie panes instead of freezing')
emitGate('zellij:slot-pane-telemetry-renderer', { telemetry_with_artifact_fallback: true })
