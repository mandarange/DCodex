import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { exists, runProcess } from './fsx.mjs';
import { getCodexInfo } from './codex-adapter.mjs';

export const CODEX_APP_DOCS_URL = 'https://developers.openai.com/codex/app/features';

export function codexAppCandidatePaths(home = os.homedir(), env = process.env) {
  const candidates = [];
  if (env.SKS_CODEX_APP_PATH) candidates.push(env.SKS_CODEX_APP_PATH);
  if (process.platform === 'darwin') {
    candidates.push('/Applications/Codex.app');
    candidates.push(path.join(home || '', 'Applications', 'Codex.app'));
  }
  if (process.platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home || '', 'AppData', 'Local');
    candidates.push(path.join(local, 'Programs', 'Codex', 'Codex.exe'));
    candidates.push(path.join(local, 'Codex', 'Codex.exe'));
  }
  return Array.from(new Set(candidates.filter(Boolean)));
}

export async function findCodexApp(opts = {}) {
  for (const candidate of codexAppCandidatePaths(opts.home || os.homedir(), opts.env || process.env)) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

async function findPluginCache(pluginName, opts = {}) {
  const home = opts.home || os.homedir();
  const roots = [
    path.join(home || '', '.codex', 'plugins', 'cache'),
    path.join(home || '', '.agents', 'plugins', 'cache')
  ];
  const needle = String(pluginName || '').toLowerCase();
  const maxEntries = Number(opts.maxEntries || 3000);
  let seen = 0;

  async function walk(dir, depth = 0) {
    if (!dir || seen > maxEntries || depth > 6 || !(await exists(dir))) return null;
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) {
      if (seen++ > maxEntries) return null;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.toLowerCase() === needle) return full;
        const hit = await walk(full, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  }

  for (const root of roots) {
    const hit = await walk(root);
    if (hit) return hit;
  }
  return null;
}

export async function codexMcpList(opts = {}) {
  const codex = opts.codex || await getCodexInfo().catch(() => ({}));
  if (!codex.bin) return { ok: false, checked: false, stdout: '', stderr: 'Codex CLI missing.' };
  const out = await runProcess(codex.bin, ['mcp', 'list'], {
    timeoutMs: opts.timeoutMs || 10000,
    maxOutputBytes: 64 * 1024
  }).catch((err) => ({ code: 1, stdout: '', stderr: err.message }));
  return {
    ok: out.code === 0,
    checked: true,
    stdout: out.stdout || '',
    stderr: out.stderr || ''
  };
}

export async function codexAppIntegrationStatus(opts = {}) {
  const appPath = await findCodexApp(opts);
  const codex = opts.codex || await getCodexInfo().catch(() => ({}));
  const mcpList = await codexMcpList({ ...opts, codex });
  const mcpText = `${mcpList.stdout}\n${mcpList.stderr}`;
  const browserUsePath = await findPluginCache('browser-use', opts);
  const computerUsePath = await findPluginCache('computer-use', opts);
  const computerUseReady = /computer[-_ ]?use/i.test(mcpText) || Boolean(computerUsePath);
  const browserUseReady = /browser[-_ ]?use/i.test(mcpText) || Boolean(browserUsePath);
  const appInstalled = Boolean(appPath);
  const ready = appInstalled && Boolean(codex.bin) && mcpList.ok && computerUseReady && browserUseReady;
  return {
    ok: ready,
    app: {
      installed: appInstalled,
      path: appPath,
      docs_url: CODEX_APP_DOCS_URL
    },
    codex_cli: {
      ok: Boolean(codex.bin),
      bin: codex.bin || null,
      version: codex.version || null
    },
    mcp: {
      checked: mcpList.checked,
      ok: mcpList.ok,
      has_computer_use: computerUseReady,
      has_browser_use: browserUseReady,
      stdout: mcpList.stdout,
      stderr: mcpList.stderr
    },
    plugins: {
      computer_use_cache: computerUsePath,
      browser_use_cache: browserUsePath
    },
    guidance: codexAppGuidance({ appInstalled, codex, mcpList, computerUseReady, browserUseReady })
  };
}

export function codexAppGuidance({ appInstalled, codex, mcpList, computerUseReady, browserUseReady }) {
  const lines = [];
  if (!appInstalled) {
    lines.push('Install and open Codex App for first-party MCP/plugin tools. SKS cmux launch can still run with Codex CLI alone, but Browser Use and Computer Use evidence will be unavailable until Codex App is ready.');
    lines.push(`Docs: ${CODEX_APP_DOCS_URL}`);
  }
  if (!codex?.bin) lines.push('Install Codex CLI too: npm i -g @openai/codex, or set SKS_CODEX_BIN.');
  if (mcpList?.checked && !mcpList.ok) {
    lines.push(`Codex MCP/config check failed: ${summarizeCodexMcpError(mcpList.stderr || mcpList.stdout)}`);
    lines.push('Verify with: codex mcp list');
  }
  if (appInstalled && (!computerUseReady || !browserUseReady)) {
    lines.push('Open Codex App settings, enable recommended MCP/plugin tools, then restart Codex CLI sessions.');
    lines.push('Required for SKS QA-LOOP priority order: Browser Use for local browser targets, Computer Use for desktop/app/browser evidence.');
    lines.push('Verify with: codex mcp list');
  }
  if (!lines.length) lines.push('Codex App, Codex CLI, Computer Use, and Browser Use checks look ready.');
  return lines;
}

export function formatCodexAppStatus(status, { includeRaw = false } = {}) {
  const lines = [
    'Codex App / MCP Plugin Readiness',
    '',
    `Codex App:   ${status.app.installed ? 'ok' : 'missing'}${status.app.path ? ` ${status.app.path}` : ''}`,
    `Codex CLI:   ${status.codex_cli.ok ? 'ok' : 'missing'}${status.codex_cli.version ? ` ${status.codex_cli.version}` : ''}`,
    `Computer Use:${status.mcp.has_computer_use ? ' ok' : ' missing'}`,
    `Browser Use: ${status.mcp.has_browser_use ? 'ok' : 'missing'}`,
    `Ready:       ${status.ok ? 'yes' : 'no'}`,
    '',
    ...status.guidance.map((line) => `- ${line}`)
  ];
  if (includeRaw && status.mcp.stdout) lines.push('', status.mcp.stdout.trim());
  return lines.join('\n');
}

function summarizeCodexMcpError(text) {
  const cleanLines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('WARNING: proceeding'));
  const variantLine = cleanLines.find((line) => line.includes('unknown variant'));
  const errorLine = cleanLines.find((line) => line.startsWith('Error:'));
  if (errorLine && variantLine && errorLine !== variantLine) return `${errorLine}; ${variantLine}`;
  return variantLine || errorLine || cleanLines[0] || 'codex mcp list failed';
}
