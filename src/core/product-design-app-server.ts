import { spawn } from 'node:child_process';
import { PACKAGE_VERSION } from './version.js';
import { EMPTY_CODEX_INFO, getCodexInfo } from './codex-adapter.js';
import { PRODUCT_DESIGN_PLUGIN, normalizeProductDesignPluginEvidence } from './product-design-plugin.js';

export const PRODUCT_DESIGN_AUTO_INSTALL_ENV = 'SKS_PRODUCT_DESIGN_AUTO_INSTALL';

export function productDesignAutoInstallRequested(opts: any = {}) {
  const env = opts.env || process.env;
  return opts.autoInstallProductDesign === true
    || opts.installProductDesign === true
    || opts.requireProductDesign === true
    || opts.designRoute === true
    || env?.[PRODUCT_DESIGN_AUTO_INSTALL_ENV] === '1'
    || /^true$/i.test(String(env?.[PRODUCT_DESIGN_AUTO_INSTALL_ENV] || ''));
}

export async function ensureProductDesignPluginInstalled(opts: any = {}) {
  const autoInstallProductDesign = productDesignAutoInstallRequested(opts);
  const injectedRequest = opts.request || opts.appServerRequest;
  if (injectedRequest) {
    return ensureProductDesignPluginInstalledWithRequest(injectedRequest, {
      ...opts,
      autoInstallProductDesign
    });
  }

  const codex = opts.codex || await getCodexInfo().catch(() => EMPTY_CODEX_INFO);
  if (!codex.bin) {
    return productDesignAppServerUnavailable('codex_cli_missing', 'Codex CLI missing.', {
      autoInstallProductDesign
    });
  }

  const client = new CodexAppServerJsonRpcClient({
    command: codex.bin,
    args: opts.appServerArgs || ['app-server', '--stdio'],
    env: opts.env || process.env,
    timeoutMs: opts.timeoutMs || 20000,
    cwd: opts.cwd || process.cwd()
  });

  try {
    await client.initialize();
    const result = await ensureProductDesignPluginInstalledWithRequest(
      (method: any, params: any) => client.request(method, params),
      {
        ...opts,
        autoInstallProductDesign
      }
    );
    return {
      ...result,
      app_server_command: `${codex.bin} ${(opts.appServerArgs || ['app-server', '--stdio']).join(' ')}`
    };
  } catch (err: any) {
    return productDesignAppServerUnavailable('product_design_app_server_request_failed', err?.message || String(err), {
      autoInstallProductDesign,
      stderr: client.stderr.trim()
    });
  } finally {
    await client.close();
  }
}

export async function ensureProductDesignPluginInstalledWithRequest(request: any, opts: any = {}) {
  const autoInstallProductDesign = productDesignAutoInstallRequested(opts);
  const calls: any[] = [];
  const errors: any[] = [];
  const call = async (method: any, params: any) => {
    calls.push({ method, params });
    try {
      return { ok: true, result: await request(method, params) };
    } catch (err: any) {
      const error = err?.message || String(err);
      errors.push({ method, params, error });
      return { ok: false, error };
    }
  };

  const before = await readProductDesignFromAppServer(call);
  if (before.evidence.ok) {
    return productDesignEnsureReport({
      ok: true,
      status: 'ready',
      autoInstallProductDesign,
      installAttempted: false,
      before,
      after: before,
      calls,
      errors,
      blockers: []
    });
  }

  if (!autoInstallProductDesign) {
    return productDesignEnsureReport({
      ok: false,
      status: 'install_not_requested',
      autoInstallProductDesign,
      installAttempted: false,
      before,
      after: before,
      calls,
      errors,
      blockers: uniqueStrings([
        ...before.evidence.blockers,
        'product_design_auto_install_not_requested'
      ])
    });
  }

  const install = await call('plugin/install', before.install_params || PRODUCT_DESIGN_PLUGIN.app_server.install_params);
  const after = await readProductDesignFromAppServer(call, before.read_params || PRODUCT_DESIGN_PLUGIN.app_server.read_params);
  let installedListEvidence: any = null;
  if (!after.evidence.ok) {
    const installedList = await call('plugin/installed', {});
    const summary = installedList.ok ? findProductDesignPluginSummaryFromMarketplaces(installedList.result) : null;
    if (summary) {
      installedListEvidence = normalizeProductDesignPluginEvidence({
        plugin: {
          marketplaceName: summary.marketplaceName,
          summary,
          skills: []
        }
      });
    }
  }

  const ok = after.evidence.ok;
  return productDesignEnsureReport({
    ok,
    status: ok ? 'installed' : 'install_unverified',
    autoInstallProductDesign,
    installAttempted: true,
    installResponse: summarizeProductDesignInstallResponse(install.result),
    installError: install.ok ? null : install.error,
    before,
    after,
    installedListEvidence,
    calls,
    errors,
    blockers: ok ? [] : uniqueStrings([
      ...after.evidence.blockers,
      ...(installedListEvidence?.blockers || []),
      ...(install.ok ? ['product_design_plugin_install_unverified'] : ['product_design_plugin_install_failed'])
    ])
  });
}

export async function readProductDesignFromAppServer(call: any, preferredReadParams: any = PRODUCT_DESIGN_PLUGIN.app_server.read_params) {
  const direct = await call('plugin/read', preferredReadParams);
  if (direct.ok) {
    return {
      read_source: 'plugin/read',
      read_params: preferredReadParams,
      install_params: preferredReadParams,
      evidence: normalizeProductDesignPluginEvidence(direct.result)
    };
  }

  const list = await call('plugin/list', PRODUCT_DESIGN_PLUGIN.app_server.list_params);
  const summary = list.ok ? findProductDesignPluginSummaryFromMarketplaces(list.result) : null;
  const discoveredReadParams = summary
    ? productDesignAppServerReadParamsFromSummary(summary)
    : PRODUCT_DESIGN_PLUGIN.app_server.read_params;

  if (summary) {
    const discoveredRead = await call('plugin/read', discoveredReadParams);
    if (discoveredRead.ok) {
      return {
        read_source: 'plugin/list+plugin/read',
        read_params: discoveredReadParams,
        install_params: discoveredReadParams,
        evidence: normalizeProductDesignPluginEvidence(discoveredRead.result)
      };
    }
  }

  const evidence = summary
    ? normalizeProductDesignPluginEvidence({
        plugin: {
          marketplaceName: summary.marketplaceName,
          summary,
          skills: []
        }
      })
    : normalizeProductDesignPluginEvidence({});

  return {
    read_source: summary ? 'plugin/list_summary' : 'plugin/read_failed',
    read_params: discoveredReadParams,
    install_params: discoveredReadParams,
    evidence: {
      ...evidence,
      blockers: uniqueStrings([
        ...evidence.blockers,
        'product_design_plugin_read_failed'
      ])
    }
  };
}

export function findProductDesignPluginSummaryFromMarketplaces(input: any = {}) {
  const marketplaces = Array.isArray(input?.marketplaces) ? input.marketplaces : [];
  for (const marketplace of marketplaces) {
    const plugins = Array.isArray(marketplace?.plugins) ? marketplace.plugins : [];
    for (const plugin of plugins) {
      const remotePluginId = String(plugin?.remotePluginId || plugin?.remote_plugin_id || '');
      const id = String(plugin?.id || '');
      const name = String(plugin?.name || '');
      const displayName = String(plugin?.displayName || plugin?.display_name || plugin?.interface?.displayName || '');
      const matches = id === PRODUCT_DESIGN_PLUGIN.id
        || name === PRODUCT_DESIGN_PLUGIN.name
        || displayName === PRODUCT_DESIGN_PLUGIN.display_name
        || remotePluginId === PRODUCT_DESIGN_PLUGIN.remote_plugin_id;
      if (matches) {
        return {
          ...plugin,
          displayName,
          marketplaceName: plugin?.marketplaceName || marketplace?.name || PRODUCT_DESIGN_PLUGIN.marketplace,
          remotePluginId
        };
      }
    }
  }
  return null;
}

export function productDesignAppServerReadParamsFromSummary(summary: any = {}) {
  return {
    remoteMarketplaceName: summary.marketplaceName || PRODUCT_DESIGN_PLUGIN.marketplace,
    pluginName: summary.remotePluginId || summary.remote_plugin_id || PRODUCT_DESIGN_PLUGIN.remote_plugin_id
  };
}

function productDesignEnsureReport(input: any) {
  const remoteEvidence = input.after?.evidence || input.before?.evidence || normalizeProductDesignPluginEvidence({});
  return {
    schema: 'sks.product-design-app-server-ensure.v1',
    ok: input.ok,
    checked: true,
    status: input.status,
    auto_install_requested: input.autoInstallProductDesign === true,
    install_attempted: input.installAttempted === true,
    install_response: input.installResponse || null,
    install_error: input.installError || null,
    before_evidence: input.before?.evidence || null,
    after_evidence: input.after?.evidence || null,
    installed_list_evidence: input.installedListEvidence || null,
    remote_evidence: remoteEvidence,
    read_source: input.after?.read_source || input.before?.read_source || null,
    read_params: input.after?.read_params || input.before?.read_params || PRODUCT_DESIGN_PLUGIN.app_server.read_params,
    install_params: input.before?.install_params || PRODUCT_DESIGN_PLUGIN.app_server.install_params,
    calls: input.calls || [],
    errors: input.errors || [],
    blockers: input.blockers || []
  };
}

function productDesignAppServerUnavailable(reason: any, error: any, extra: any = {}) {
  const evidence = normalizeProductDesignPluginEvidence({});
  return {
    schema: 'sks.product-design-app-server-ensure.v1',
    ok: false,
    checked: false,
    status: 'app_server_unavailable',
    auto_install_requested: extra.autoInstallProductDesign === true,
    install_attempted: false,
    install_response: null,
    install_error: error,
    before_evidence: evidence,
    after_evidence: evidence,
    installed_list_evidence: null,
    remote_evidence: evidence,
    read_source: null,
    read_params: PRODUCT_DESIGN_PLUGIN.app_server.read_params,
    install_params: PRODUCT_DESIGN_PLUGIN.app_server.install_params,
    calls: [],
    errors: [{ reason, error }],
    stderr: extra.stderr || '',
    blockers: uniqueStrings([
      ...evidence.blockers,
      reason
    ])
  };
}

function summarizeProductDesignInstallResponse(result: any = {}) {
  if (!result) return null;
  return {
    auth_policy: result.authPolicy || result.auth_policy || null,
    apps_needing_auth: Array.isArray(result.appsNeedingAuth)
      ? result.appsNeedingAuth.map((app: any) => ({
          id: app?.id || null,
          name: app?.name || app?.displayName || app?.display_name || null
        }))
      : []
  };
}

function uniqueStrings(values: any[] = []) {
  return Array.from(new Set(values.filter(Boolean).map((value: any) => String(value))));
}

class CodexAppServerJsonRpcClient {
  command: string;
  args: string[];
  env: any;
  cwd: string;
  timeoutMs: number;
  child: ReturnType<typeof spawn> | null;
  nextId: number;
  pending: Map<number, { resolve: (value: any) => void; reject: (reason?: any) => void; timer: NodeJS.Timeout }>;
  stdoutBuffer: string;
  stderr: string;

  constructor(config: any = {}) {
    this.command = config.command;
    this.args = config.args || ['app-server', '--stdio'];
    this.env = config.env || process.env;
    this.cwd = config.cwd || process.cwd();
    this.timeoutMs = Number(config.timeoutMs || 20000);
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stdoutBuffer = '';
    this.stderr = '';
  }

  async initialize() {
    this.start();
    const result = await this.request('initialize', {
      clientInfo: {
        name: 'sneakoscope-product-design',
        title: 'Sneakoscope Product Design Installer',
        version: PACKAGE_VERSION
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: []
      }
    });
    this.notify('notifications/initialized', {});
    return result;
  }

  start() {
    if (this.child) return;
    this.child = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      env: this.env,
      cwd: this.cwd
    });
    this.child.stdout?.on('data', (chunk: any) => this.handleStdout(chunk));
    this.child.stderr?.on('data', (chunk: any) => {
      this.stderr += chunk.toString('utf8');
      if (this.stderr.length > 64 * 1024) this.stderr = this.stderr.slice(-64 * 1024);
    });
    this.child.on('error', (err: any) => this.rejectAll(err));
    this.child.on('close', (code: any) => {
      this.rejectAll(new Error(`Codex app-server exited before response (code ${code ?? 'signal'}). ${this.stderr.trim()}`.trim()));
    });
  }

  request(method: any, params: any) {
    this.start();
    const id = this.nextId++;
    const message = { jsonrpc: '2.0', id, method, params };
    return new Promise<any>((resolve: any, reject: any) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}. ${this.stderr.trim()}`.trim()));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.child?.stdin?.write(`${JSON.stringify(message)}\n`);
    });
  }

  notify(method: any, params: any) {
    this.start();
    this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  handleStdout(chunk: any) {
    this.stdoutBuffer += chunk.toString('utf8');
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id === undefined || !this.pending.has(message.id)) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result);
    }
  }

  rejectAll(err: any) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
  }

  async close() {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    try { child.stdin?.end(); } catch {}
    try { child.kill('SIGTERM'); } catch {}
  }
}
