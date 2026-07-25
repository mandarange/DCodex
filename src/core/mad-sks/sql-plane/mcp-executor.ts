import { performance } from 'node:perf_hooks';
import { nowIso, sha256 } from '../../fsx.js';
import { PACKAGE_VERSION } from '../../version.js';
import type { MadSksSqlPlaneRuntimeProfile } from './runtime-profile.js';

export interface MadSksSqlPlaneToolInventory {
  schema: 'sks.mad-sks-sql-plane-tool-inventory.v1';
  checked_at: string;
  ok: boolean;
  tool_names: string[];
  execute_sql_available: boolean;
  apply_migration_available: boolean;
  duration_ms: number;
  error_digest: string | null;
  error_summary: string | null;
  error_kind: string | null;
  retry_guidance: string | null;
}

export interface MadSksSqlPlaneToolResult {
  schema: 'sks.mad-sks-sql-plane-tool-result.v1';
  ok: boolean;
  tool_name: string;
  result_digest: string | null;
  row_count: number | null;
  is_error: boolean;
  duration_ms: number;
  error_summary: string | null;
  error_kind: string | null;
  retry_guidance: string | null;
}

export class MadSksSqlPlaneMcpExecutor {
  private client: any = null;
  private transport: any = null;
  // A successful inventory() result is cached for this executor instance's
  // lifetime (one DB operation cycle) — previously every executeSql/
  // applyMigration call re-fetched the full tool list from the MCP server
  // via callToolWithFallback, on top of whatever explicit inventory() the
  // caller had already done to prepare the mission, doubling the
  // connect+listTools round trip per SQL call for no reason the available
  // tool set can't change mid-cycle (20차 P2-5b). Failures are never
  // cached, so a transient listTools error doesn't get stuck.
  private cachedInventory: MadSksSqlPlaneToolInventory | null = null;

  constructor(private readonly profile: MadSksSqlPlaneRuntimeProfile, private readonly opts: { timeoutMs?: number } = {}) {}

  async connect(): Promise<void> {
    if (this.client) return;
    const { Client, StreamableHTTPClientTransport } = await loadMcpSdk();
    this.client = new Client({ name: 'sneakoscope-mad-sks-sql-plane', version: PACKAGE_VERSION });
    const headers = authHeaders();
    const options = headers ? { requestInit: { headers } } : {};
    this.transport = new StreamableHTTPClientTransport(new URL(this.profile.server_url), options);
    await this.client.connect(this.transport);
  }

  async inventory(): Promise<MadSksSqlPlaneToolInventory> {
    if (this.cachedInventory) return this.cachedInventory;
    const started = performance.now();
    try {
      await this.connect();
      const result = await this.client!.listTools({}, { timeout: this.opts.timeoutMs || 10_000 });
      const names = (result.tools || []).map((tool: any) => String(tool?.name || '')).filter(Boolean).sort();
      const inventory: MadSksSqlPlaneToolInventory = {
        schema: 'sks.mad-sks-sql-plane-tool-inventory.v1',
        checked_at: nowIso(),
        ok: hasTool(names, 'execute_sql') && hasTool(names, 'apply_migration'),
        tool_names: names,
        execute_sql_available: hasTool(names, 'execute_sql'),
        apply_migration_available: hasTool(names, 'apply_migration'),
        duration_ms: Math.round(performance.now() - started),
        error_digest: null,
        error_summary: null,
        error_kind: null,
        retry_guidance: null
      };
      if (inventory.ok) this.cachedInventory = inventory;
      return inventory;
    } catch (err: unknown) {
      const summary = summarizeMadSksSqlPlaneError(err);
      const kind = classifyMadSksSqlPlaneError(summary);
      return {
        schema: 'sks.mad-sks-sql-plane-tool-inventory.v1',
        checked_at: nowIso(),
        ok: false,
        tool_names: [],
        execute_sql_available: false,
        apply_migration_available: false,
        duration_ms: Math.round(performance.now() - started),
        error_digest: sha256(summary).slice(0, 32),
        error_summary: summary,
        error_kind: kind,
        retry_guidance: madSksSqlPlaneRetryGuidance(kind)
      };
    }
  }

  async executeSql(sql: string): Promise<MadSksSqlPlaneToolResult> {
    return this.callToolWithFallback(['execute_sql', 'supabase.execute_sql'], [{ query: sql }, { sql }]);
  }

  async applyMigration(name: string, sql: string): Promise<MadSksSqlPlaneToolResult> {
    return this.callToolWithFallback(['apply_migration', 'supabase.apply_migration'], [{ name, query: sql }, { name, sql }]);
  }

  async close(): Promise<void> {
    /* intentional: best-effort teardown on close, session/client are being discarded either way */
    await this.transport?.terminateSession().catch(() => undefined);
    await this.client?.close().catch(() => undefined);
    this.client = null;
    this.transport = null;
    this.cachedInventory = null;
  }

  private async callToolWithFallback(toolNames: string[], argsList: Array<Record<string, unknown>>): Promise<MadSksSqlPlaneToolResult> {
    await this.connect();
    const inventory = await this.inventory();
    const tool = toolNames.find((name) => hasTool(inventory.tool_names, name)) || toolNames[0] || '';
    let lastError: unknown = null;
    for (const args of argsList) {
      const started = performance.now();
      try {
        const result = await this.client!.callTool(
          { name: tool, arguments: args },
          undefined,
          { timeout: this.opts.timeoutMs || 60_000, resetTimeoutOnProgress: true, maxTotalTimeout: 10 * 60_000 }
        );
        return {
          schema: 'sks.mad-sks-sql-plane-tool-result.v1',
          ok: result.isError !== true,
          tool_name: tool,
          result_digest: sha256(JSON.stringify(redactToolResult(result))).slice(0, 32),
          row_count: extractRowCount(result),
          is_error: result.isError === true,
          duration_ms: Math.round(performance.now() - started),
          error_summary: result.isError === true ? summarizeMadSksSqlPlaneToolError(result) : null,
          error_kind: result.isError === true ? classifyMadSksSqlPlaneError(summarizeMadSksSqlPlaneToolError(result)) : null,
          retry_guidance: result.isError === true ? madSksSqlPlaneRetryGuidance(classifyMadSksSqlPlaneError(summarizeMadSksSqlPlaneToolError(result))) : null
        };
      } catch (err: unknown) {
        lastError = err;
      }
    }
    const summary = summarizeMadSksSqlPlaneError(lastError);
    const kind = classifyMadSksSqlPlaneError(summary);
    return {
      schema: 'sks.mad-sks-sql-plane-tool-result.v1',
      ok: false,
      tool_name: tool,
      result_digest: sha256(summary).slice(0, 32),
      row_count: null,
      is_error: true,
      duration_ms: 0,
      error_summary: summary,
      error_kind: kind,
      retry_guidance: madSksSqlPlaneRetryGuidance(kind)
    };
  }
}

async function loadMcpSdk(): Promise<{ Client: any; StreamableHTTPClientTransport: any }> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    dynamicImport('@modelcontextprotocol/sdk/client/index.js'),
    dynamicImport('@modelcontextprotocol/sdk/client/streamableHttp.js')
  ]);
  return { Client, StreamableHTTPClientTransport };
}

function hasTool(names: string[], name: string): boolean {
  return names.some((candidate) => candidate === name || candidate.endsWith(`.${name}`) || candidate.endsWith(`__${name}`));
}

function authHeaders(): HeadersInit | undefined {
  const token = process.env.SUPABASE_ACCESS_TOKEN || process.env.SKS_MAD_SKS_SQL_PLANE_SUPABASE_ACCESS_TOKEN || '';
  if (!token) return undefined;
  return { Authorization: `Bearer ${token}` };
}

export function summarizeMadSksSqlPlaneError(err: unknown): string {
  const text = err instanceof Error ? `${err.name}:${err.message}` : String(err);
  return redactErrorText(text).slice(0, 1200);
}

function summarizeMadSksSqlPlaneToolError(result: unknown): string {
  return redactErrorText(JSON.stringify(redactToolResult(result))).slice(0, 1200);
}

function redactErrorText(text: string): string {
  return String(text || '')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>')
    .replace(/(token|password|secret|apikey)=([^&\s]+)/gi, '$1=<redacted>')
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)([^@\s]+)(@)/gi, '$1<redacted>$3');
}

export function classifyMadSksSqlPlaneError(summary: string): string {
  const text = String(summary || '').toLowerCase();
  if (/read[_ -]?only|read only|permission denied.+read/i.test(text)) return 'supabase_mcp_read_only_transport';
  if (/timeout|timed out|etimedout|i\/o timeout|aborterror|deadline/i.test(text)) return 'supabase_sql_plane_timeout';
  if (/connection terminated|econnreset|unexpected eof|socket hang up|server closed/i.test(text)) return 'supabase_sql_plane_connection_interrupted';
  if (/sasl|password authentication failed|invalid login|authentication failed|sqlstate 28p01/i.test(text)) return 'supabase_sql_plane_auth_failed';
  if (/fetch failed|enotfound|econnrefused|network|dns/i.test(text)) return 'supabase_mcp_transport_unreachable';
  return 'supabase_mcp_tool_error';
}

export function madSksSqlPlaneRetryGuidance(kind: string): string {
  if (kind === 'supabase_mcp_read_only_transport') return 'The active MAD-SKS SQL-plane cycle must use the mission-local write-capable MCP URL. Pass --mcp-url or SKS_MAD_SKS_SQL_PLANE_MCP_URL if a project-local read-only Supabase MCP config is shadowing the intended transport.';
  if (kind === 'supabase_sql_plane_timeout') return 'Retry with an explicit Supabase pooler/session/direct MCP transport if available; Supabase CLI docs also support --db-url for CLI migration paths when pooler/direct connectivity differs.';
  if (kind === 'supabase_sql_plane_connection_interrupted') return 'Treat this as a SQL-plane connectivity interruption, not a DB safety denial. Retry after checking Supabase project health, pooler/direct connection mode, and network reachability.';
  if (kind === 'supabase_sql_plane_auth_failed') return 'Check SUPABASE_ACCESS_TOKEN and the project/database credentials used by the Supabase MCP server; do not retry destructive SQL until auth is corrected.';
  if (kind === 'supabase_mcp_transport_unreachable') return 'Check access to https://mcp.supabase.com/mcp or pass a trusted local MCP URL with --mcp-url for the active MAD-SKS SQL-plane cycle.';
  return 'Inspect error_summary in the SQL-plane result receipt; the failure occurred after MAD-SKS capability gating, so do not report it as a safety-gate denial.';
}

function redactToolResult(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return value.replace(/(token|password|secret|apikey)["'=:\s]+[A-Za-z0-9._~+/=-]+/gi, '$1=<redacted>');
  if (Array.isArray(value)) return value.map(redactToolResult);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (/token|password|secret|apikey|service_role/i.test(key)) out[key] = '<redacted>';
      else if (/rows|data|records/i.test(key) && Array.isArray(entry)) out[key] = `<redacted:${entry.length}:rows>`;
      else out[key] = redactToolResult(entry);
    }
    return out;
  }
  return value;
}

function extractRowCount(value: any): number | null {
  const candidates = [
    value?.row_count,
    value?.rowCount,
    value?.rows_affected,
    value?.structuredContent?.row_count,
    value?.structuredContent?.rowCount,
    value?.structuredContent?.rows_affected
  ];
  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
