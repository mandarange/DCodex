#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { assertGate, emitGate, importDist, root } from './gate-lib.js';

const mod = await importDist('core/source-intelligence/codex-history-search.js');
const codexHome = path.join(root, '.sneakoscope', 'tmp', 'codex-history-fixture');
const sessionDir = path.join(codexHome, 'sessions');
fs.mkdirSync(sessionDir, { recursive: true });
fs.writeFileSync(path.join(sessionDir, 'session.jsonl'), '{"message":"Ultra Stability search target"}\n{"message":"secondary"}\n');
const report = await mod.searchCodexHistory({ codexHome, query: 'ultra stability', maxFiles: 10, maxResults: 5 });
const out = path.join(root, '.sneakoscope', 'reports', 'codex-history-search.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

assertGate(report.ok === true, 'Codex history search report must be ok', report);
assertGate(report.case_insensitive === true, 'Codex history search must default to case-insensitive matching', report);
assertGate(report.results.length === 1, 'Codex history search fixture should find one match', report);
emitGate('source-intelligence:codex-history-search', { results: report.results.length, files_scanned: report.files_scanned });
