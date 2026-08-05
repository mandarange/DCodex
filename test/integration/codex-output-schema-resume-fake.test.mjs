import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildCodexExecResumeOutputSchemaArgs, detectCodexExecResumeOutputSchema } from '../../dist/core/codex-exec-output-schema.js';

test('current fake Codex resume path builds --output-schema args', async () => {
  const availability = await detectCodexExecResumeOutputSchema({
    codexBin: process.execPath,
    versionText: 'codex-cli 0.145.0',
    resumeHelpText: '--output-schema <file>'
  });
  assert.equal(availability.output_schema_supported, true);
  const args = await buildCodexExecResumeOutputSchemaArgs({
    sessionId: 'fake-session',
    outputSchemaPath: path.join(process.cwd(), 'schemas/codex/completion-proof.schema.json')
  });
  assert.ok(args.includes('--output-schema'));
});
