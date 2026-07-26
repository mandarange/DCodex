import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  MULTI_PROVIDER_ROUTER_DEFAULT_BASE_URL,
  MULTI_PROVIDER_ROUTER_ID
} from '../multi-provider-router.js';
export { escapeRegExp } from '../../text/regex.js';

export async function makeMultiProviderRouterHarness() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-multi-provider-router-'));
  const home = path.join(temp, 'home');
  const codexHome = path.join(home, '.codex');
  const configPath = path.join(codexHome, 'config.toml');
  const catalogPath = path.join(codexHome, 'opencodex-catalog.json');
  const env = { HOME: home, CODEX_HOME: codexHome } as NodeJS.ProcessEnv;
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(catalogPath, `${JSON.stringify({
    models: [
      catalogModel('anthropic/claude-sonnet', 'Claude Sonnet', ['medium', 'high']),
      catalogModel('google/gemini-pro', 'Gemini Pro', ['low', 'high'])
    ]
  })}\n`, { mode: 0o600 });
  return { temp, home, codexHome, configPath, catalogPath, env };
}

export function routerModelsFetch(
  models = ['anthropic/claude-sonnet', 'google/gemini-pro']
): typeof fetch {
  return async () => new Response(JSON.stringify({
    data: models.map((id) => ({ id }))
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

export function configuredRouterToml(catalogPath: string): string {
  return [
    `model_provider = ${JSON.stringify(MULTI_PROVIDER_ROUTER_ID)}`,
    'model = "anthropic/claude-sonnet"',
    `model_catalog_json = ${JSON.stringify(catalogPath)}`,
    '',
    `[model_providers.${MULTI_PROVIDER_ROUTER_ID}]`,
    'name = "SKS Multi-Provider Router"',
    `base_url = ${JSON.stringify(MULTI_PROVIDER_ROUTER_DEFAULT_BASE_URL)}`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    ''
  ].join('\n');
}

export async function skippedRouterRestart() {
  return {
    schema: 'sks.codex-app-restart.v1' as const,
    ok: true,
    status: 'skipped',
    skipped: true,
    reason: 'disabled',
    app_name: 'Codex',
    blockers: []
  };
}

export function catalogModel(
  slug: string,
  displayName: string,
  efforts: string[],
  extra: Record<string, unknown> = {}
) {
  return {
    slug,
    display_name: displayName,
    description: `${displayName} routed model`,
    default_reasoning_level: efforts[0] || null,
    supported_reasoning_levels: efforts.map((effort) => ({ effort, description: effort })),
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority: 1,
    base_instructions: 'Follow the active SKS role contract.',
    supports_reasoning_summaries: true,
    support_verbosity: true,
    truncation_policy: { mode: 'tokens', limit: 10_000 },
    supports_parallel_tool_calls: true,
    experimental_supported_tools: [],
    multi_agent_version: 'v1',
    ...extra
  };
}
