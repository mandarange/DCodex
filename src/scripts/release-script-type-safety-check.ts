#!/usr/bin/env node
import { runReleaseScriptLintGate } from './release-script-lint-gate-lib.js'
await runReleaseScriptLintGate('release-scripts:type-safe')
