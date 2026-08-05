import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  buildCodexExecOutputSchemaArgs,
  buildCodexExecResumeOutputSchemaArgs,
  detectCodexExecOutputSchemaSyntax
} from '../../dist/core/codex-exec-output-schema.js';

test('Codex output-schema syntax detection checks fresh exec separately from resume', async () => {
  const availability = await detectCodexExecOutputSchemaSyntax({
    codexBin: process.execPath,
    versionText: 'codex-cli 0.145.0',
    execHelpText: 'Usage: codex exec --output-schema <file> --json <prompt>',
    resumeHelpText: 'Usage: codex exec resume --json --output-schema <file> <session-id>'
  });

  assert.equal(availability.schema, 'sks.codex-exec-output-schema-syntax.v1');
  assert.equal(availability.status, 'available');
  assert.equal(availability.exec.output_schema_supported, true);
  assert.equal(availability.resume.output_schema_supported, true);
  assert.equal(availability.parity, true);
  assert.deepEqual(availability.blockers, []);
});

test('fresh codex exec and exec resume builders preserve their distinct argument order', async () => {
  const schemaPath = path.join(process.cwd(), 'schemas/codex/image-ux-issue-ledger.schema.json');
  const fresh = await buildCodexExecOutputSchemaArgs({
    prompt: 'Return structured issue ledger JSON.',
    outputSchemaPath: schemaPath,
    outputFile: path.join(process.cwd(), '.sneakoscope/tmp/fresh.json')
  });
  const resume = await buildCodexExecResumeOutputSchemaArgs({
    sessionId: 'session-123',
    prompt: 'Continue with structured output.',
    outputSchemaPath: schemaPath,
    outputFile: path.join(process.cwd(), '.sneakoscope/tmp/resume.json')
  });

  assert.deepEqual(fresh.slice(0, 3), ['exec', '--json', '--output-schema']);
  assert.ok(fresh.includes('Return structured issue ledger JSON.'));
  assert.deepEqual(resume.slice(0, 4), ['exec', 'resume', '--json', '--output-schema']);
  assert.ok(resume.includes('session-123'));
});
