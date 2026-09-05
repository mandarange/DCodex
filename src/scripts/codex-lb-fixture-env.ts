// @ts-nocheck
import path from 'node:path';

const preload = `const models=['gpt-5.6-luna','gpt-5.6-terra','gpt-5.6-sol','gpt-6-astra'].map(slug=>({slug,display_name:slug,supported_reasoning_levels:[],shell_type:'shell_command',visibility:'list',supported_in_api:true,priority:1,base_instructions:'',supports_reasoning_summaries:true,support_verbosity:true,truncation_policy:{mode:'tokens',limit:10000},supports_parallel_tool_calls:true,experimental_supported_tools:[],service_tiers:['priority'],tool_mode:'code_mode_only'}));globalThis.fetch=async input=>{const url=String(input?.url||input);if(url.endsWith('/health'))return new Response('{}',{status:200,headers:{'x-app-version':'1.21.0-beta.3'}});if(url.endsWith('/models'))return new Response(JSON.stringify({models}),{status:200,headers:{'content-type':'application/json'}});throw new Error('unexpected fixture fetch '+url)}`;

export function codexLbFixtureEnv(home, overrides = {}) {
  return {
    ...process.env,
    HOME: home,
    CODEX_HOME: path.join(home, '.codex'),
    CODEX_LB_API_KEY: '',
    CODEX_LB_BASE_URL: '',
    OPENAI_API_KEY: '',
    OPENROUTER_API_KEY: '',
    CI: 'true',
    SKS_GLOBAL_ROOT: path.join(home, '.sneakoscope-global'),
    SKS_UPDATE_MIGRATION_GATE_DISABLED: '1',
    SKS_ALLOW_UNVERIFIED_CODEX_LB_RECOVERY: '',
    SKS_CODEX_LB_CHAIN_CHECK: '0',
    SKS_SKIP_CODEX_LB_LAUNCH_ENV: '1',
    SKS_SKIP_CODEX_APP_RESTART: '1',
    NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(preload)}`,
    ...overrides
  };
}
