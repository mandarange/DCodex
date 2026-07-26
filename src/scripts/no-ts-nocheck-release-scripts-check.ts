#!/usr/bin/env node
import { runReleaseScriptLintGate } from './release-script-lint-gate-lib.js'
await runReleaseScriptLintGate('lint:no-ts-nocheck-release-scripts')
