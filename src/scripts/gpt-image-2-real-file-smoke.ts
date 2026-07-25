#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { escapeRegExp } from '../core/text/regex.js';

const root = process.cwd();
const enabled = process.env.SKS_TEST_REAL_IMAGEGEN === '1'
  || process.env.SKS_REAL_IMAGEGEN === '1'
  || process.env.SKS_GPT_IMAGE_2_REAL_FILE_SMOKE === '1';
const reportDir = path.join(root, '.sneakoscope', 'reports');
const imageDir = path.join(reportDir, 'generated-images');
const reportPath = path.join(reportDir, 'gpt-image-2-real-file-smoke.json');
fs.mkdirSync(imageDir, { recursive: true });

function writeReport(report) {
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, report_path: reportPath }, null, 2));
}

function verifyImageFile(file) {
  const bytes = fs.readFileSync(file);
  const dimensions = pngDimensions(bytes);
  const ok = bytes.length > 0 && dimensions.format !== 'unknown';
  return {
    ok,
    output_image_path: file,
    output_image_sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    output_image_bytes: bytes.length,
    dimensions
  };
}

function redact(text) {
  return String(text || '')
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, '[REDACTED_KEY]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [REDACTED]');
}

function parseShellEnvValue(text, key) {
  const re = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?${escapeRegExp(key)}\\s*=\\s*([^\\n#]+)`);
  const raw = String(text || '').match(re)?.[1]?.trim();
  if (!raw) return '';
  if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) return raw.slice(1, -1);
  return raw;
}

function tomlString(text, key) {
  const re = new RegExp(`(?:^|\\n)\\s*${escapeRegExp(key)}\\s*=\\s*"([^"]*)"`);
  return String(text || '').match(re)?.[1] || '';
}

function tomlBoolean(text, key) {
  const re = new RegExp(`(?:^|\\n)\\s*${escapeRegExp(key)}\\s*=\\s*(true|false)\\b`);
  const value = String(text || '').match(re)?.[1];
  return value === 'true' ? true : value === 'false' ? false : null;
}

function tomlTableBlock(text, table) {
  const re = new RegExp(`(^|\\n)\\[${escapeRegExp(table)}\\]([\\s\\S]*?)(?=\\n\\[[^\\]]+\\]|\\s*$)`);
  return String(text || '').match(re)?.[2] || '';
}

function readCodexLbAuth() {
  const home = process.env.HOME || os.homedir();
  const configPath = path.join(home, '.codex', 'config.toml');
  const envPath = path.join(home, '.codex', 'sks-codex-lb.env');
  const configText = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  const envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const block = tomlTableBlock(configText, 'model_providers.codex-lb');
  const selected = tomlString(configText.split(/\n\s*\[/)[0] || '', 'model_provider') === 'codex-lb';
  const envKey = tomlString(block, 'env_key') || 'CODEX_LB_API_KEY';
  const baseUrl = process.env.CODEX_LB_BASE_URL || tomlString(block, 'base_url');
  const key = process.env[envKey] || parseShellEnvValue(envText, envKey);
  return {
    selected,
    provider_configured: Boolean(block),
    requires_openai_auth: tomlBoolean(block, 'requires_openai_auth'),
    env_key: envKey,
    base_url: baseUrl,
    env_path: envPath,
    key
  };
}

function authState() {
  const openAiKey = String(process.env.OPENAI_API_KEY || '').trim();
  if (openAiKey) {
    return {
      ok: true,
      provider: 'openai_images_api',
      auth_source: 'OPENAI_API_KEY',
      key: openAiKey,
      endpoint: `${String(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '')}/images/generations`
    };
  }
  const codexLb = readCodexLbAuth();
  if (codexLb.selected && codexLb.provider_configured && codexLb.requires_openai_auth === true && codexLb.key && codexLb.base_url) {
    return {
      ok: true,
      provider: 'openai_responses_image_generation',
      auth_source: codexLb.env_key,
      key: String(codexLb.key).trim(),
      endpoint: `${String(codexLb.base_url).replace(/\/+$/, '')}/responses`,
      codex_lb: {
        selected: true,
        provider_configured: true,
        requires_openai_auth: true,
        base_url: codexLb.base_url,
        env_key: codexLb.env_key,
        env_path: codexLb.env_path,
        api_key_present: true
      }
    };
  }
  return {
    ok: false,
    provider: null,
    blocker: openAiKey ? null : 'openai_api_key_missing_and_codex_lb_unavailable',
    codex_lb: {
      selected: codexLb.selected,
      provider_configured: codexLb.provider_configured,
      requires_openai_auth: codexLb.requires_openai_auth,
      base_url_present: Boolean(codexLb.base_url),
      env_key: codexLb.env_key,
      api_key_present: Boolean(codexLb.key)
    }
  };
}

async function fetchJson(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`gpt_image_2_smoke_timeout_${timeoutMs}ms`)), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    const payload = parsePayload(text);
    return { response, payload, text };
  } finally {
    clearTimeout(timeout);
  }
}

function parsePayload(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}
  const events = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      events.push(JSON.parse(data));
    } catch {}
  }
  return events.length ? events[events.length - 1] : { raw_text: raw.slice(0, 2000) };
}

function findImageBase64(payload) {
  const direct = payload?.data?.[0]?.b64_json || payload?.data?.[0]?.b64;
  if (typeof direct === 'string') return { b64: direct, output_id: payload?.data?.[0]?.id || payload?.id || null };
  const outputs = Array.isArray(payload?.output) ? payload.output : [];
  for (const output of outputs) {
    if (output?.type === 'image_generation_call') {
      if (typeof output.result === 'string') return { b64: output.result, output_id: output.id || payload?.id || null };
      if (typeof output.result?.b64_json === 'string') return { b64: output.result.b64_json, output_id: output.id || payload?.id || null };
      if (typeof output.b64_json === 'string') return { b64: output.b64_json, output_id: output.id || payload?.id || null };
    }
  }
  return { b64: null, output_id: null };
}

function pngDimensions(buffer) {
  if (buffer.length >= 24
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), format: 'png' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    return { width: null, height: null, format: 'jpeg' };
  }
  return { width: null, height: null, format: 'unknown' };
}

function summarizePayload(payload) {
  const outputs = Array.isArray(payload?.output) ? payload.output : [];
  return {
    id: payload?.id || null,
    object: payload?.object || null,
    status: payload?.status || null,
    model: payload?.model || null,
    error_type: payload?.error?.type || null,
    error_code: payload?.error?.code || null,
    error_message: payload?.error?.message ? redact(payload.error.message).slice(0, 1000) : null,
    data_count: Array.isArray(payload?.data) ? payload.data.length : null,
    output_count: outputs.length,
    output: outputs.slice(0, 8).map((output) => ({
      id: output?.id || null,
      type: output?.type || null,
      status: output?.status || null,
      result_present: typeof output?.result === 'string' || Boolean(output?.result?.b64_json || output?.b64_json),
      result_chars: typeof output?.result === 'string' ? output.result.length : null
    }))
  };
}

function generatedImagesDir() {
  return path.join(process.env.CODEX_HOME || process.env.HOME && path.join(process.env.HOME, '.codex') || path.join(os.homedir(), '.codex'), 'generated_images');
}

function newestGeneratedImageSince(sinceMs) {
  const dir = generatedImagesDir();
  const found = [];
  function walk(current) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/^ig_.*\.(png|jpe?g|webp)$/i.test(entry.name)) continue;
      const stat = fs.statSync(full);
      if (!stat.isFile() || stat.size <= 0 || stat.mtimeMs < sinceMs - 2000) continue;
      found.push({ path: full, size: stat.size, mtime_ms: stat.mtimeMs });
    }
  }
  walk(dir);
  found.sort((a, b) => b.mtime_ms - a.mtime_ms);
  return found[0] || null;
}

function runCodexBuiltinImagegen({ prompt, started }) {
  const codexPrompt = [
    'Use ChatGPT Images 2.0 / GPT Image 2.0 with gpt-image-2.',
    prompt,
    'Use Codex built-in image generation. Do not write SVG, HTML, CSS, or a manually generated placeholder.',
    'Reply only with the generated image file path if available.'
  ].join(' ');
  const run = spawnSync('codex', [
    'exec',
    '--ignore-user-config',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--enable',
    'image_generation',
    '-C',
    root,
    codexPrompt
  ], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    timeout: Number(process.env.SKS_GPT_IMAGE_2_CODEX_EXEC_TIMEOUT_MS || 240000),
    maxBuffer: 8 * 1024 * 1024
  });
  const selected = newestGeneratedImageSince(started);
  if (!selected) {
    return {
      ok: false,
      status: 'blocked',
      blocker: run.error?.message ? 'codex_builtin_imagegen_exec_failed' : 'codex_builtin_imagegen_output_missing',
      provider: 'codex_builtin_imagegen',
      process_status: run.status,
      process_signal: run.signal,
      process_error: run.error?.message || null,
      stdout_tail: String(run.stdout || '').slice(-3000),
      stderr_tail: String(run.stderr || '').slice(-3000),
      generated_images_dir: generatedImagesDir()
    };
  }
  const dest = path.join(imageDir, `gpt-image-2-codex-built-in-smoke-${new Date().toISOString().replace(/[:.]/g, '-')}${path.extname(selected.path) || '.png'}`);
  fs.copyFileSync(selected.path, dest);
  const image = verifyImageFile(dest);
  return {
    schema: 'sks.gpt-image-2-real-file-smoke.v1',
    ok: image.ok,
    status: image.ok ? 'passed' : 'blocked',
    blocker: image.ok ? null : 'generated_file_invalid',
    live_generation_attempted: true,
    real_generated_output_verified: image.ok,
    provider: 'codex_builtin_imagegen',
    auth_source: 'Codex App built-in image_gen',
    request: { model: 'gpt-image-2', prompt_chars: prompt.length, output_format: path.extname(dest).replace(/^\./, '') || 'png' },
    discovered_from: selected.path,
    output_image_path: dest,
    output_image_sha256: image.output_image_sha256,
    output_image_bytes: image.output_image_bytes,
    dimensions: image.dimensions,
    latency_ms: Date.now() - started,
    local_only: true,
    fake_adapter: false,
    mock: false,
    process_status: run.status,
    process_signal: run.signal,
    stdout_tail: String(run.stdout || '').slice(-3000),
    stderr_tail: String(run.stderr || '').slice(-3000)
  };
}

async function run() {
  if (!enabled) {
    return writeReport({
      schema: 'sks.gpt-image-2-real-file-smoke.v1',
      ok: true,
      status: 'skipped',
      reason: 'Set SKS_GPT_IMAGE_2_REAL_FILE_SMOKE=1 or SKS_TEST_REAL_IMAGEGEN=1 to run a live gpt-image-2 file generation smoke.',
      live_generation_attempted: false
    });
  }
  const auth = authState();
  const started = Date.now();
  const prompt = process.env.SKS_GPT_IMAGE_2_SMOKE_PROMPT || 'Generate a tiny clean product-style PNG icon: a blue square with the text OK centered, white background.';
  const surface = String(process.env.SKS_GPT_IMAGE_2_SMOKE_SURFACE || 'codex_builtin').trim();
  const size = process.env.SKS_GPT_IMAGE_2_SMOKE_SIZE || '512x512';
  const quality = process.env.SKS_GPT_IMAGE_2_SMOKE_QUALITY || 'low';
  const timeoutMs = Number(process.env.SKS_GPT_IMAGE_2_REAL_SMOKE_TIMEOUT_MS || 360000);
  if (surface !== 'api' && surface !== 'openai_api' && surface !== 'responses') {
    const codexBuiltin = runCodexBuiltinImagegen({ prompt, started });
    writeReport(codexBuiltin);
    if (codexBuiltin.ok || surface === 'codex_builtin') return;
  }
  if (!auth.ok) {
    return writeReport({
      schema: 'sks.gpt-image-2-real-file-smoke.v1',
      ok: false,
      status: 'blocked',
      blocker: auth.blocker,
      live_generation_attempted: false,
      auth: auth.codex_lb
    });
  }
  const request = auth.provider === 'openai_images_api'
    ? {
        model: 'gpt-image-2',
        prompt,
        size,
        quality,
        output_format: 'png',
        n: 1
      }
    : {
        model: process.env.SKS_IMAGEGEN_RESPONSES_MODEL || process.env.OPENAI_MODEL || '',
        input: prompt,
        tools: [{
          type: 'image_generation',
          action: 'generate',
          size,
          quality,
          output_format: 'png'
        }],
        tool_choice: { type: 'image_generation' }
      };
  if (auth.provider !== 'openai_images_api' && !request.model) {
    return writeReport({
      schema: 'sks.gpt-image-2-real-file-smoke.v1',
      ok: false,
      status: 'blocked',
      blocker: 'imagegen_responses_model_missing',
      live_generation_attempted: false,
      setup_guidance: 'Set SKS_IMAGEGEN_RESPONSES_MODEL to a model available through the configured Responses provider.'
    });
  }
  let response;
  let payload;
  let text;
  try {
    const fetched = await fetchJson(auth.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${auth.key}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(request)
    }, timeoutMs);
    response = fetched.response;
    payload = fetched.payload;
    text = fetched.text;
  } catch (err) {
    return writeReport({
      schema: 'sks.gpt-image-2-real-file-smoke.v1',
      ok: false,
      status: 'blocked',
      blocker: /timeout|abort/i.test(String(err?.message || err)) ? 'imagegen_remote_timeout' : 'imagegen_request_failed',
      live_generation_attempted: true,
      provider: auth.provider,
      auth_source: auth.auth_source,
      endpoint: auth.endpoint,
      request: { model: request.model, image_model: 'gpt-image-2', size, quality, output_format: 'png' },
      latency_ms: Date.now() - started,
      redacted_error: redact(err?.message || err)
    });
  }
  const { b64, output_id } = findImageBase64(payload);
  if (!response.ok || !b64) {
    return writeReport({
      schema: 'sks.gpt-image-2-real-file-smoke.v1',
      ok: false,
      status: 'blocked',
      blocker: !response.ok ? `http_${response.status}` : 'missing_b64_image_output',
      live_generation_attempted: true,
      provider: auth.provider,
      auth_source: auth.auth_source,
      endpoint: auth.endpoint,
      request: { model: request.model, image_model: 'gpt-image-2', size, quality, output_format: 'png' },
      latency_ms: Date.now() - started,
      response_status: response.status,
      payload_summary: summarizePayload(payload),
      response_text_tail: redact(text).slice(-2000)
    });
  }
  const bytes = Buffer.from(String(b64), 'base64');
  const dims = pngDimensions(bytes);
  const filename = `gpt-image-2-real-file-smoke-${new Date().toISOString().replace(/[:.]/g, '-')}.${dims.format === 'jpeg' ? 'jpg' : 'png'}`;
  const outputPath = path.join(imageDir, filename);
  fs.writeFileSync(outputPath, bytes);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const ok = fs.existsSync(outputPath) && bytes.length > 0 && dims.format !== 'unknown';
  return writeReport({
    schema: 'sks.gpt-image-2-real-file-smoke.v1',
    ok,
    status: ok ? 'passed' : 'blocked',
    blocker: ok ? null : 'generated_file_invalid',
    live_generation_attempted: true,
    real_generated_output_verified: ok,
    provider: auth.provider,
    auth_source: auth.auth_source,
    endpoint: auth.endpoint,
    request: { model: request.model, image_model: 'gpt-image-2', size, quality, output_format: 'png' },
    output_image_path: outputPath,
    output_image_sha256: sha256,
    output_image_bytes: bytes.length,
    output_id,
    dimensions: dims,
    latency_ms: Date.now() - started,
    payload_summary: summarizePayload(payload),
    local_only: true,
    fake_adapter: false,
    mock: false
  });
}

await run();
