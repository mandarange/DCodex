#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import https from 'node:https';
import { assertGate, emitGate, importDist, root } from './gate-lib.js';

const mod = await importDist('core/codex/codex-0-134-compat.js');
const versionRun = spawnSync('codex', ['--version'], { encoding: 'utf8' });
const execHelp = spawnSync('codex', ['exec', '--help'], { encoding: 'utf8', maxBuffer: 256 * 1024 });
const mcpHelp = spawnSync('codex', ['mcp', '--help'], { encoding: 'utf8', maxBuffer: 256 * 1024 });
const searchHelp = spawnSync('codex', ['search', '--help'], { encoding: 'utf8', maxBuffer: 256 * 1024 });
const release = await fetchJson('https://api.github.com/repos/openai/codex/releases/tags/rust-v0.134.0');
const releaseBody = String(release.json?.body || '');
const matrix = mod.codex0134Matrix({
  version: `${versionRun.stdout || ''}${versionRun.stderr || ''}`,
  available: versionRun.status === 0,
  execHelp: `${execHelp.stdout || ''}${execHelp.stderr || ''}`,
  mcpHelp: `${mcpHelp.stdout || ''}${mcpHelp.stderr || ''}`,
  historyHelp: `${searchHelp.stdout || ''}${searchHelp.stderr || ''}`,
  historyCommandAvailable: searchHelp.status === 0 && /^\s*Usage:\s+codex\s+search\b/m.test(`${searchHelp.stdout || ''}${searchHelp.stderr || ''}`),
  schemaPolicyText: '$ref $defs readOnlyHint'
});

const topics = {
  local_conversation_history_search: ['search across local conversation history', 'case-insensitive content matches'],
  profile_primary_selector: ['--profile', 'primary profile selector'],
  mcp_per_server_environment: ['per-server environment targeting'],
  mcp_streamable_http_oauth: ['OAuth options', 'streamable HTTP servers'],
  connector_schema_refs_defs_compaction: ['$ref', '$defs', 'compacting oversized schemas'],
  mcp_readonly_parallel_hint: ['readOnlyHint'],
  hook_subagent_context: ['subagent identity in hook inputs'],
  managed_network_proxy_env: ['managed network proxy environment']
};
const rows = Object.entries(topics).map(([topic, needles]) => {
  const capability = matrix.capabilities.find((item) => item.id === topic);
  const missingOfficialNeedles = release.ok === true ? needles.filter((needle) => !releaseBody.includes(needle)) : [];
  return {
    topic,
    result: capability?.status || 'missing',
    official_source_checked: release.ok === true,
    official_release_needles: needles,
    official_release_missing: missingOfficialNeedles,
    release_readiness_row_added: true,
    notes: capability?.notes || ['capability row missing']
  };
});
const blockers = [
  ...rows.filter((row) => row.result === 'missing').map((row) => `missing:${row.topic}`),
  ...rows.filter((row) => row.official_release_missing.length > 0).map((row) => `official_release_topic_missing:${row.topic}:${row.official_release_missing.join('|')}`)
];
const warnings = [
  ...(release.ok ? [] : [`official_release_fetch_unavailable:${release.error || release.statusCode || 'unknown'}`])
];
const report = {
  schema: 'sks.codex-0-134-official-compat.v1',
  ok: blockers.length === 0 && matrix.ok === true,
  status: versionRun.status === 0 ? 'checked' : 'integration_optional',
  release_source_url: mod.CODEX_0_134_RELEASE_EVIDENCE.tag_url,
  release_tag: mod.CODEX_0_134_RELEASE_EVIDENCE.tag,
  release_date: release.json?.published_at || mod.CODEX_0_134_RELEASE_EVIDENCE.release_date,
  official_source: {
    api_url: 'https://api.github.com/repos/openai/codex/releases/tags/rust-v0.134.0',
    ok: release.ok,
    status_code: release.statusCode || null,
    tag_name: release.json?.tag_name || null,
    html_url: release.json?.html_url || mod.CODEX_0_134_RELEASE_EVIDENCE.tag_url
  },
  source_delta: rows,
  local_codex_version: `${versionRun.stdout || versionRun.stderr || ''}`.trim() || null,
  matrix,
  blockers: [...blockers, ...(matrix.blockers || [])],
  warnings
};
const out = path.join(root, '.sneakoscope', 'reports', 'codex-0-134-official-compat.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
assertGate(report.ok, 'Codex 0.134 official compatibility report has blockers', report);
emitGate('codex:0.134-official-compat', { topics: rows.length, version: report.local_codex_version });

function fetchJson(url) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'sneakoscope-release-check',
        Accept: 'application/vnd.github+json'
      },
      timeout: 20000
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, statusCode: res.statusCode, json });
        } catch (err) {
          resolve({ ok: false, statusCode: res.statusCode, error: err.message, body: body.slice(0, 1000) });
        }
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (err) => {
      resolve({ ok: false, error: err.message });
    });
  });
}
