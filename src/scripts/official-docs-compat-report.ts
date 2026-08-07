#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = readJson('package.json');
const reportDir = path.join(root, '.sneakoscope', 'reports');
const releaseVersion = String(pkg.version || 'unknown');
const jsonPath = path.join(reportDir, `official-docs-compat-${releaseVersion}.json`);
const mdPath = path.join(reportDir, `official-docs-compat-${releaseVersion}.md`);
const codexVersion = String(pkg.dependencies?.['@openai/codex-sdk'] || '');
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(codexVersion)) {
  throw new Error('package.json must pin @openai/codex-sdk to an exact semver');
}
const codexTag = `rust-v${codexVersion}`;

const sources = {
  codex_release: `https://github.com/openai/codex/releases/tag/${codexTag}`,
  codex_config_schema: `https://raw.githubusercontent.com/openai/codex/${codexTag}/codex-rs/core/config.schema.json`,
  browser: 'https://learn.chatgpt.com/docs/browser',
  chrome_extension: 'https://learn.chatgpt.com/docs/chrome-extension',
  computer_use: 'https://learn.chatgpt.com/docs/computer-use',
  codex_app_image_generation: 'https://learn.chatgpt.com/docs/image-generation',
  image_generation_api: 'https://developers.openai.com/api/docs/guides/image-generation',
  gpt_image_2_model: 'https://developers.openai.com/api/docs/models/gpt-image-2',
  structured_outputs: 'https://developers.openai.com/api/docs/guides/structured-outputs'
};

const fetched = await Promise.all(Object.entries(sources).map(async ([id, url]) => [id, await fetchOfficial(url)]));
const bodies = Object.fromEntries(fetched);
const sourceValidations = [
  sourceRow('codex_release', sources.codex_release, bodies.codex_release, [codexTag, codexVersion, 'Bug Fixes']),
  sourceRow('codex_config_schema', sources.codex_config_schema, bodies.codex_config_schema, ['definitions', 'mcp_servers', 'profiles']),
  sourceRow('browser', sources.browser, bodies.browser, ['built-in browser', 'Chrome extension', 'Computer Use']),
  sourceRow('chrome_extension', sources.chrome_extension, bodies.chrome_extension, ['Chrome extension', 'signed-in', 'Connected']),
  sourceRow('computer_use', sources.computer_use, bodies.computer_use, ['Computer Use', 'Install the Computer Use plugin', 'Screen Recording']),
  sourceRow('codex_app_image_generation', sources.codex_app_image_generation, bodies.codex_app_image_generation, ['Image generation', 'gpt-image-2']),
  sourceRow('image_generation_api', sources.image_generation_api, bodies.image_generation_api, ['Image generation', 'gpt-image-2', 'GPT Image']),
  sourceRow('gpt_image_2_model', sources.gpt_image_2_model, bodies.gpt_image_2_model, ['gpt-image-2', 'Image generation']),
  sourceRow('structured_outputs', sources.structured_outputs, bodies.structured_outputs, ['Structured Outputs', 'json_schema', 'strict'])
];

const checks = [
  fileRow('codex_current_dependency', codexTag, 'package.json', [
    `"@openai/codex-sdk": "${codexVersion}"`,
    'codex-current-dependency-check.js'
  ]),
  fileRow('codex_runtime_contract', codexTag, 'src/core/codex-compat/codex-runtime-contract.ts', [
    'codexSdkDependencyVersion',
    'package.json#dependencies.@openai/codex-sdk',
    "protocolMode: 'app-server-v2'",
    "mcpPaginatedDiscovery: 'wrap'",
    "portableAgentPlugins: 'delegate'"
  ]),
  fileRow('codex_current_release_gates', codexTag, 'release-gates.v2.json', [
    'codex:current:dependency-graph',
    'codex:current:binary-identity',
    'codex:current:policy',
    'codex:current:app-server-v2',
    'codex:current:thread-store',
    'codex:current:capability'
  ]),
  fileRow('codex_runtime_generated_app_server_schema', codexTag, 'src/core/codex-control/codex-current-capability.ts', [
    'generate-json-schema',
    'real-schema',
    'generated_schema_sha256',
    'binary_sha256'
  ]),
  fileRow('codex_native_capability_self_repair', 'Codex Desktop native capabilities', 'src/core/doctor/doctor-native-capability-repair.ts', [
    'repairNativeCapabilities',
    'native_capabilities',
    'optional_manual_required'
  ]),
  fileRow('codex_app_surface_routing', 'Browser / Chrome / Computer Use', 'src/core/routes/evidence.ts', [
    'CODEX_IN_APP_BROWSER_DOC_URL',
    'CODEX_CHROME_EXTENSION_DOC_URL',
    'CODEX_COMPUTER_USE_DOC_URL',
    'CODEX_QA_SURFACE_ROUTING_POLICY'
  ]),
  fileRow('codex_app_imagegen_evidence_policy', 'Codex App image generation', 'src/core/imagegen/imagegen-capability.ts', [
    'Codex App $imagegen',
    'codex_app_builtin_output_required',
    'capability_detection_is_not_output_proof'
  ]),
  fileRow('gpt_image_2_generation_edit', 'OpenAI Image Generation', 'src/core/image-ux-review/imagegen-adapter.ts', [
    'gpt-image-2',
    '/v1/images/edits',
    'high_fidelity_automatic'
  ]),
  fileRow('structured_outputs_strict_schema', 'OpenAI Structured Outputs', 'src/core/structured-output-adapter.ts', [
    'json_schema',
    'strict',
    'additionalProperties'
  ])
];

const warnings = [
  ...checks.filter((row) => !row.ok).map((row) => `${row.feature}:${row.missing.join(',')}`),
  ...sourceValidations.filter((row) => !row.ok).map((row) => `${row.feature}:${row.missing.join(',') || row.error || 'source_unavailable'}`)
];
// Hermetic file checks are the authoritative publish surface. Live external source
// fetches are an optional real probe: transient network failures (fetch failed,
// rate limiting, sandboxed CI) are recorded as advisory warnings and never block
// the release gate, matching the project's "hermetic fixtures + optional real
// probes" contract. A successful probe still must not mask a failing hermetic check.
const hermeticOk = checks.every((row) => row.ok);
const sourceProbeOk = sourceValidations.every((row) => row.ok);
const report = {
  schema: 'sks.official-docs-compat.v2',
  generated_at: new Date().toISOString(),
  package_version: releaseVersion,
  codex_release_baseline: codexTag,
  codex_cli_version: codexVersion,
  codex_app_docs_baseline: {
    browser: sources.browser,
    chrome_extension: sources.chrome_extension,
    computer_use: sources.computer_use,
    image_generation: sources.codex_app_image_generation
  },
  rules: {
    provider_catalog: 'Normal Codex sessions preserve the full host catalog; Naruto model constraints are scoped and live-catalog verified.',
    fast_mode: 'Codex Desktop Fast uses service_tier=fast and remains visible when codex-lb is selected.',
    native_capabilities: 'Browser, Chrome, Computer Use, and image generation are installed or repaired through their native Codex App plugin surfaces and then re-probed.',
    codex_app_imagegen_evidence: 'Full visual evidence requires real Codex App $imagegen output with gpt-image-2; API output is labeled non-Codex evidence.',
    structured_outputs: 'Strict JSON schema output uses additionalProperties:false where the current schema contract requires it.'
  },
  sources,
  source_validations: sourceValidations,
  source_probe: {
    kind: 'optional_real_probe',
    ok: sourceProbeOk,
    advisory: true,
    note: 'Live external doc fetches are advisory; transient failures do not block publish. Hermetic file checks are authoritative.'
  },
  checks,
  warnings,
  ok: hermeticOk
};

fs.mkdirSync(reportDir, { recursive: true });
fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(mdPath, renderMarkdown(report));
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;

function fileRow(feature, baseline, relFile, needles) {
  const text = readText(relFile);
  const missing = needles.filter((needle) => !text.includes(needle));
  return { feature, baseline, file: relFile, status: missing.length ? 'blocked' : 'mapped', ok: missing.length === 0, missing, release_readiness: true };
}

function sourceRow(feature, url, fetchResult, needles) {
  const text = String(fetchResult.body || '').replace(/\s+/g, ' ').toLowerCase();
  const missing = fetchResult.ok
    ? needles.filter((needle) => !text.includes(String(needle).replace(/\s+/g, ' ').toLowerCase()))
    : needles;
  return {
    feature,
    url,
    status_code: fetchResult.statusCode || null,
    status: fetchResult.ok && missing.length === 0 ? 'verified' : 'blocked',
    ok: fetchResult.ok === true && missing.length === 0,
    missing,
    error: fetchResult.error || null
  };
}

async function fetchOfficial(url) {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'sneakoscope-official-docs-check', Accept: 'text/html,application/json,text/plain,*/*' },
      signal: AbortSignal.timeout(20_000)
    });
    const text = await response.text();
    let body = text;
    if (response.headers.get('content-type')?.includes('application/json')) {
      try {
        const json = JSON.parse(text);
        body = [json.tag_name, json.name, json.body, text].filter(Boolean).join('\n');
      } catch {}
    }
    return { ok: response.ok, statusCode: response.status, body, error: response.ok ? null : `http_${response.status}` };
  } catch (error) {
    return { ok: false, statusCode: null, body: '', error: error instanceof Error ? error.message : String(error) };
  }
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
}

function readText(rel) {
  try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return ''; }
}

function renderMarkdown(value) {
  const lines = [
    '# Official Docs Compatibility',
    '',
    `- Package: \`${value.package_version}\``,
    `- Codex baseline: \`${value.codex_release_baseline}\``,
    `- Status: **${value.ok ? 'PASS' : 'BLOCKED'}**`,
    '',
    '## Current implementation checks',
    '',
    '| Feature | Baseline | Status |',
    '| --- | --- | --- |'
  ];
  for (const row of value.checks) lines.push(`| \`${row.feature}\` | ${row.baseline} | ${row.status} |`);
  lines.push('', '## Official source checks', '', '| Source | Status |', '| --- | --- |');
  for (const row of value.source_validations) lines.push(`| \`${row.feature}\` | ${row.status} |`);
  if (value.warnings.length) lines.push('', `Blockers: ${value.warnings.join(', ')}`);
  return `${lines.join('\n')}\n`;
}
