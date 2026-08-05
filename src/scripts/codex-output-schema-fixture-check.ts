#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const mod = await import(pathToFileURL(path.join(root, 'dist/core/codex-exec-output-schema.js')));

const availability = await mod.detectCodexExecResumeOutputSchema({
  codexBin: process.execPath,
  versionText: 'codex-cli 0.145.0',
  resumeHelpText: 'Usage: codex exec resume [OPTIONS]\n      --output-schema <FILE>\n  -o, --output-last-message <FILE>'
});
assert.equal(availability.output_schema_supported, true);
assert.equal(availability.status, 'available');

const schemaPath = path.join(root, 'schemas/codex/image-ux-issue-ledger.schema.json');
const args = await mod.buildCodexExecResumeOutputSchemaArgs({
  sessionId: 'fixture-session-123',
  prompt: 'return fixture json',
  outputSchemaPath: schemaPath,
  outputFile: path.join(root, '.sneakoscope/tmp/codex-output-schema-fixture.json')
});
assert.ok(args.includes('--output-schema'));
assert.ok(args.includes(schemaPath));

console.log(JSON.stringify({ schema: 'sks.codex-output-schema-fixture.v1', ok: true, args }, null, 2));
