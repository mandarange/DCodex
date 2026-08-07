import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { bumpProjectVersion } from '../version-manager.js'

test('version bump updates every current release and Codex document surface', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-version-current-docs-'))
  const files: Record<string, string> = {
    'package.json': '{"name":"fixture","version":"1.2.3"}\n',
    'package-lock.json': '{"name":"fixture","version":"1.2.3","packages":{"":{"version":"1.2.3"}}}\n',
    'plugins/sks/.codex-plugin/plugin.json': '{"schema_version":"1.0.0","name":"sks","version":"1.2.3"}\n',
    'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Existing release fix.\n',
    'README.md': 'Current release: **SKS 1.2.3**.\n\n## Naruto In 1.2.3\n',
    'docs/release-readiness.md': [
      '# SKS 1.2.0 Release Readiness',
      '',
      'This document is the current fail-closed release contract for `sneakoscope`',
      '1.2.0. The current package version on this branch is 1.2.3. It is a readiness checklist.',
      'SKS 1.2.3 is ready for publication.',
      'Codex 0.142 references later in this document are historical release records and cannot authorize the 1.2.3 release.',
      '1.2.3 release readiness requires current proof.',
      '## Current publish authorization policy (1.2.3)',
      'The 1.2.3 implementation handoff uses this bounded verification sequence:',
      'the 1.2.3 command surface; affected selection is current.',
      'not the 1.2.3 release procedure.',
      'Historical examples do not satisfy the 1.2.3 official-subagent gate. Current 1.2.3 proof is canonical.',
      'They are not represented as current 1.2.3 completion proof.',
      'For 1.2.3, a selected codex-lb must pass recovery.',
      'The 1.2.3 SKS menu bar exposes status.',
      'the 7.6.0 to 1.2.3 upgrade smoke is current.',
      'Store proof under the 1.2.3 release evidence root.',
      'Do not cut 1.2.3 while a required gate is red.',
      'README and release evidence must agree on 1.2.3.',
      'It must not claim that 1.2.3 is published.',
      'npm view sneakoscope@1.2.3 version',
      'Then install `sneakoscope@1.2.3` into a fresh prefix.',
      'Completion requires the registry version to be',
      '1.2.3, `latest` to resolve to 1.2.3, integrity to match.',
      'A defect requires a higher version; never replace 1.2.3.',
      '# Historical native runtime removal happened in 1.2.3.'
    ].join('\n') + '\n',
    'docs/release-proof-truth.md': [
      'SKS 1.2.3 release proof truth is current; 1.2.3 proof must additionally show current checks.',
      'SKS 1.2.3 must not claim publication.',
      'Legacy aliases cannot serve as 1.2.3 evidence.'
    ].join('\n') + '\n',
    'docs/official-docs-compat.md': [
      'SKS 1.2.3 keeps release-gated behavior current.',
      'official-docs-compat-1.2.3.json',
      'official-docs-compat-1.2.3.md'
    ].join('\n') + '\n',
    'docs/codex-cli-compat.md': 'SKS 1.2.3 targets the current Codex CLI and is not release-authorizing for SKS 1.2.3.\n',
    'docs/codex-app.md': 'SKS 1.2.3 targets the current Codex App.\nSKS 1.2.3 also reports the active auth class.\n',
    'docs/PERFORMANCE.md': 'Sneakoscope Codex 1.2.3 is designed for bounded runtime.\nThe 1.2.3 package pins dependencies.\nThe final 1.2.3 host-capability runtime stays bounded.\n',
    'docs/AGENT-BRIDGE.md': '{"package_version": "1.2.3"}\n'
  }

  try {
    for (const [rel, content] of Object.entries(files)) {
      const file = path.join(root, rel)
      await fsp.mkdir(path.dirname(file), { recursive: true })
      await fsp.writeFile(file, content)
    }
    for (const args of [
      ['init', '-q'],
      ['config', 'user.email', 'fixture@example.invalid'],
      ['config', 'user.name', 'Fixture'],
      ['add', '.'],
      ['commit', '-qm', 'fixture']
    ]) {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
    }

    const result = await bumpProjectVersion(root, { bump: 'patch' })
    assert.equal(result.ok, true)
    assert.equal(result.version, '1.2.4')

    const expected: Record<string, RegExp[]> = {
      'plugins/sks/.codex-plugin/plugin.json': [/"version":"1\.2\.4"/],
      'README.md': [/\*\*SKS 1\.2\.4\*\*/, /## Naruto In 1\.2\.4/],
      'docs/release-readiness.md': [
        /^# SKS 1\.2\.4 Release Readiness$/m,
        /`sneakoscope`\n1\.2\.4\. The current package version on this branch is 1\.2\.4\./,
        /^SKS 1\.2\.4 is ready/m,
        /cannot authorize the 1\.2\.4 release/,
        /^1\.2\.4 release readiness requires/m,
        /## Current publish authorization policy \(1\.2\.4\)/,
        /The 1\.2\.4 implementation handoff/,
        /the 1\.2\.4 command surface/,
        /not the 1\.2\.4 release procedure/,
        /do not satisfy the 1\.2\.4 official-subagent gate\. Current 1\.2\.4 proof/,
        /not represented as current 1\.2\.4 completion proof/,
        /For 1\.2\.4, a selected codex-lb/,
        /The 1\.2\.4 SKS menu bar/,
        /the 7\.6\.0 to 1\.2\.4 upgrade smoke/,
        /under the 1\.2\.4 release evidence root/,
        /Do not cut 1\.2\.4 while/,
        /must agree on 1\.2\.4\./,
        /It must not claim that 1\.2\.4 is/,
        /npm view sneakoscope@1\.2\.4/,
        /install `sneakoscope@1\.2\.4`/,
        /registry version to be\s+1\.2\.4,/,
        /`latest` to resolve to 1\.2\.4,/,
        /never replace 1\.2\.4\./
      ],
      'docs/release-proof-truth.md': [/^SKS 1\.2\.4 release proof truth/m, /1\.2\.4 proof must additionally show/, /^SKS 1\.2\.4 must not claim/m, /1\.2\.4 evidence/],
      'docs/official-docs-compat.md': [/^SKS 1\.2\.4 keeps release-gated behavior/m, /official-docs-compat-1\.2\.4\.json/, /official-docs-compat-1\.2\.4\.md/],
      'docs/codex-cli-compat.md': [/^SKS 1\.2\.4 targets/m, /not release-authorizing for SKS 1\.2\.4/],
      'docs/codex-app.md': [/^SKS 1\.2\.4 targets/m, /^SKS 1\.2\.4 also reports/m],
      'docs/PERFORMANCE.md': [/^Sneakoscope Codex 1\.2\.4 is designed/m, /the 1\.2\.4 package pins/i, /the final 1\.2\.4 host-capability/i],
      'docs/AGENT-BRIDGE.md': [/"package_version": "1\.2\.4"/]
    }
    for (const [rel, patterns] of Object.entries(expected)) {
      const text = await fsp.readFile(path.join(root, rel), 'utf8')
      for (const pattern of patterns) assert.match(text, pattern, rel)
      if (rel === 'docs/release-readiness.md') assert.match(text, /Historical native runtime removal happened in 1\.2\.3/)
      assert.ok(result.synced_files.includes(rel), `${rel} should be reported as synchronized`)
    }
    const changelog = await fsp.readFile(path.join(root, 'CHANGELOG.md'), 'utf8')
    assert.match(changelog, /## \[1\.2\.4\]/)
    assert.match(changelog, /- Existing release fix\./)
    assert.equal((changelog.match(/^### Fixed$/gm) || []).length, 1)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})
