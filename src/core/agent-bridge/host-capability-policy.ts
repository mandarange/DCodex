import { sha256 } from '../fsx.js';
import { testMcpConnection, type McpHealthOptions } from '../mcp-config/health-check.js';
import { listMcpInventory, type McpInventoryOptions } from '../mcp-config/inventory.js';
import { HOST_CAPABILITY_DESCRIPTORS, hostCapabilityDigest, type HostCapabilityDescriptor } from './agent-manifest.js';

export const HOST_CAPABILITY_RUNTIME_SCHEMA = 'sks.host-capability-runtime.v1' as const;
export const HOST_CAPABILITY_MCP_SERVER = 'acas-tools';

const MAX_OBSERVED_TOOL_NAMES = 256;
const EXPLICIT_DENIAL_PATTERN = /(?:^|[_.:-])(?:slack|center|tenant|lease|connector|outbox|message|upload|send|post)(?:$|[_.:-])/i;

export type HostCapabilityState = 'available' | 'missing' | 'unhealthy' | 'not_requested';
export type HostCapabilityWorkflow =
  | 'datasource_sql_generation' | 'datasource_query' | 'spreadsheet_create' | 'spreadsheet_edit'
  | 'document_render' | 'web_capture' | 'workspace_files' | 'artifact_delivery';

export interface HostCapabilityRequest {
  capability_ids: string[];
  workflows: HostCapabilityWorkflow[];
  tool_names?: string[];
}

export interface HostCapabilityRuntimeEntry {
  id: string;
  requested: boolean;
  state: HostCapabilityState;
  expected_tool_names: string[];
  observed_tool_names: string[];
  allowed_tool_names: string[];
  blockers: string[];
}

export interface HostCapabilityRuntime {
  schema: typeof HOST_CAPABILITY_RUNTIME_SCHEMA;
  ok: boolean;
  server: typeof HOST_CAPABILITY_MCP_SERVER;
  server_present: boolean;
  server_enabled: boolean;
  server_scope: 'project' | null;
  inventory_source: string | null;
  health_status: string;
  requested_capability_ids: string[];
  task_workflows: HostCapabilityWorkflow[];
  requested_tool_names: string[];
  observed_tool_names: string[];
  allowed_tool_names: string[];
  denied_tool_names: string[];
  explicit_denied_tool_names: string[];
  allowlist_digest: string;
  capability_digest: string;
  capabilities: HostCapabilityRuntimeEntry[];
  blockers: string[];
}

export interface HostCapabilityRuntimeDependencies {
  inventory?: typeof listMcpInventory;
  health?: typeof testMcpConnection;
  inventoryOptions?: McpInventoryOptions;
  healthOptions?: McpHealthOptions;
}

export interface HostCapabilityBlockedFallback {
  reason: string;
  action: string;
}

export function requestHostCapabilities(goal: unknown): HostCapabilityRequest {
  const text = intentText(String(goal || '').normalize('NFKC'));
  const capabilityIds = new Set<string>();
  const workflows = new Set<HostCapabilityWorkflow>();
  const toolNames = new Set<string>();
  const request = (id: string, tools: readonly string[] = []) => {
    capabilityIds.add(id);
    for (const tool of tools) toolNames.add(tool);
  };
  const blankWorkbook = matches(text, [
    /\b(?:populate|fill)\b.{0,24}\b(?:new|blank|empty)\b.{0,24}\b(?:xlsx|excel|spreadsheet|workbook)\b/i,
    /\b(?:new|blank|empty)\b.{0,24}\b(?:xlsx|excel|spreadsheet|workbook)\b.{0,24}\b(?:populate|fill)\b/i
  ]);
  const spreadsheetCreate = blankWorkbook || matches(text, [
    /\b(?:create|generate|produce|deliver|make|build|prepare|convert|export)\b.{0,48}\b(?:xlsx|excel|spreadsheet|workbook)\b/i, /\b(?:xlsx|excel|spreadsheet|workbook)\b.{0,48}\b(?:create|generate|produce|deliver|make|build|prepare|convert|export)\b/i,
    /(?:엑셀|스프레드시트|xlsx).{0,32}(?:생성|작성|만들|납품)/i, /(?:생성|작성|만들|납품).{0,32}(?:엑셀|스프레드시트|xlsx)/i,
    /(?:엑셀로 정리|엑셀 파일로 저장|엑셀로 내보내|스프레드시트 보고서|xlsx로 변환|표를 엑셀로)/i
  ]);
  const spreadsheetMutation = matches(text, [
    /\b(?:edit|update|modify|populate|fill|append|import)\b.{0,56}\b(?:xlsx|excel|spreadsheet|workbook)\b/i, /\b(?:xlsx|excel|spreadsheet|workbook)\b.{0,56}\b(?:edit|update|modify|populate|fill|append|import)\b/i,
    /(?:엑셀|스프레드시트|xlsx).{0,36}(?:수정|편집|업데이트|입력|채우|반영|추가)/i, /(?:수정|편집|업데이트|입력|채우|반영|추가).{0,36}(?:엑셀|스프레드시트|xlsx)/i,
    /기존 엑셀 수식 오류를 고쳐/i
  ]);
  const spreadsheetInspection = matches(text, [
    /\binspect\b.{0,56}\b(?:xlsx|excel|spreadsheet|workbook)\b/i, /\b(?:xlsx|excel|spreadsheet|workbook)\b.{0,56}\binspect\b/i,
    /(?:엑셀|스프레드시트|xlsx).{0,36}(?:검사|점검)/i, /(?:검사|점검).{0,36}(?:엑셀|스프레드시트|xlsx)/i
  ]);
  const spreadsheetEdit = !blankWorkbook && (spreadsheetMutation || (!spreadsheetCreate && spreadsheetInspection));
  const sqlPatterns = [/\b(?:write|generate|draft|prepare)\b.{0,32}\bsql\b/i, /\bsql\b.{0,32}\b(?:write|generate|draft|prepare)\b/i, /sql.{0,24}(?:작성|생성|초안|준비)/i, /(?:작성|생성|초안|준비).{0,24}sql/i];
  const executionExclusions = [/\b(?:do\s+not|don't|never)\s+(?:actually\s+)?(?:run|execute)\b/i, /\bwithout\s+(?:actually\s+)?(?:running|executing)\b/i, /\b(?:no|without)\s+(?:query|sql)\s+execution\b/i, /\b(?:sql|query)\s+(?:generation|draft|text)\s+only\b/i];
  const queryPatterns = [
    /\b(?:query|retrieve|fetch|load|analy[sz]e|show|list)\b.{0,56}\b(?:database|datasource|data|rows?|records?|results?)\b/i, /\b(?:database|datasource|data|rows?|records?|results?)\b.{0,56}\b(?:query|retrieve|fetch|load|analy[sz]e|show|list)\b/i,
    /\b(?:get|read)\b.{0,56}\b(?:data|rows?|records?|results?)\b.{0,48}\b(?:from|in)\s+(?:the\s+)?(?:database|datasource|db)\b/i, /\bpull\b.{0,64}\b(?:from|out\s+of)\s+(?:the\s+)?(?:database|datasource|db)\b/i,
    /\b(?:from|in)\s+(?:the\s+)?(?:database|datasource|db)\b.{0,56}\b(?:get|read|pull)\b.{0,48}\b(?:data|rows?|records?|results?)\b/i, /(?:db|데이터베이스|데이터소스|데이터).{0,36}(?:조회|가져오|검색|분석|질의)/i, /(?:조회|가져오|검색|분석|질의).{0,36}(?:db|데이터베이스|데이터소스|데이터)/i,
    /(?:DB에서 뽑아|데이터베이스 집계)/i
  ];
  const genericAggregatePatterns = [/(?:월별 합계|통계 내줘|현황 조회|상위\s*(?:N|\d+)\s*건)/i];
  const datasourceCuePatterns = [
    /(?:\bdb\b|데이터베이스|데이터소스|\bmysql\b|\bpostgres(?:ql)?\b|\bsupabase\b|\bconnector\b)/i,
    /\b[a-z][a-z0-9_-]*:[a-z0-9][a-z0-9_.-]*\b/i
  ];
  const fileDataContextPatterns = [
    /(?:\bcsv\b|\bjson\b|\bxlsx\b|문서|파일)(?:\s*(?:안|내부))?(?:의|에서|에\s*있는)\s*(?:데이터|내용|행|레코드)?/i,
    /(?:\bcsv\b|\bjson\b|\bxlsx\b)\s*(?:data|데이터)/i
  ];
  const queryExecutionExclusions = [
    ...executionExclusions,
    /(?:sql|쿼리|질의).{0,24}(?:실행(?:은|을)?\s*(?:금지|하지\s*마|없이)|만\s*(?:작성|생성))/i,
    /(?:실행(?:은|을)?\s*(?:금지|하지\s*마|없이)|만\s*(?:작성|생성)).{0,24}(?:sql|쿼리|질의)/i
  ];
  const sqlGeneration = matches(text, sqlPatterns);
  const clauses = text.split(/\n+/).map((clause) => clause.trim()).filter(Boolean);
  const datasourceQuery = clauses.some((clause, index) => {
    const nearby = [clauses[index - 1], clause, clauses[index + 1]].filter((value): value is string => Boolean(value));
    if (matches(clause, fileDataContextPatterns) || matches(clause, queryExecutionExclusions)) return false;
    if (matches(clause, sqlPatterns) && nearby.some((value) => matches(value, queryExecutionExclusions))) return false;
    return matches(clause, queryPatterns)
      || (matches(clause, genericAggregatePatterns) && matches(clause, datasourceCuePatterns));
  });
  const documentRender = matches(text, [/\b(?:render|generate|create|export|deliver)\b.{0,48}\b(?:pdf|png|document screenshot)\b/i, /\b(?:pdf|png|document screenshot)\b.{0,48}\b(?:render|generate|create|export|deliver)\b/i, /(?:pdf|png|문서).{0,32}(?:렌더|생성|작성|내보내|납품)/i, /(?:렌더|생성|작성|내보내|납품).{0,32}(?:pdf|png|문서)/i, /(?:PDF 파일로 저장|문서를 PDF로|화면을 PNG로)/i, /(?:html|문서|보고서).{0,32}(?:pdf|png|렌더|이미지로)/i]);
  const webCapture = matches(text, [/\b(?:capture|take|create)\b.{0,40}\b(?:url|web|site|page)\b.{0,24}\bscreenshot\b/i, /\b(?:url|web|site|page)\b.{0,40}\bscreenshot\b/i, /(?:url|웹|사이트|페이지).{0,32}(?:스크린샷|캡처|이미지로)/i]);
  const workspace = (action: string, korean: string) => matches(text, [new RegExp(`\\bworkspace\\b.{0,48}\\b(?:${action})\\b`, 'i'), new RegExp(`\\b(?:${action})\\b.{0,48}\\bworkspace\\b`, 'i'), new RegExp(`워크스페이스.{0,36}(?:${korean})`, 'i'), new RegExp(`(?:${korean}).{0,36}워크스페이스`, 'i')]);
  const workspaceRead = workspace('read|open|inspect', '읽|열|검사|점검');
  const workspaceFind = workspace('find|search', '찾|검색');
  const workspaceList = workspace('list', '목록');
  const workspaceWrite = workspace('write|create|save', '쓰|작성|생성|저장');
  const workspaceEdit = workspace('edit|modify|update', '수정|편집|업데이트');
  const workspaceDownload = workspace('download', '다운로드');
  if (sqlGeneration || datasourceQuery) request('host.datasource.schema.v1', ['datasource_schema_context']);
  if (sqlGeneration) workflows.add('datasource_sql_generation');
  if (datasourceQuery) { request('host.datasource.query.readonly.v1', ['datasource_query_readonly']); workflows.add('datasource_query'); }
  if (spreadsheetCreate) { request('host.spreadsheet.workbook.v1', ['spreadsheet_create', 'spreadsheet_inspect', 'spreadsheet_update']); workflows.add('spreadsheet_create'); }
  if (spreadsheetEdit) { request('host.spreadsheet.workbook.v1', ['spreadsheet_inspect', 'spreadsheet_update']); workflows.add('spreadsheet_edit'); }
  if (documentRender) {
    const tools = [...(/\bpdf\b/i.test(text) ? ['html_to_pdf'] : []), ...(/\b(?:png|document screenshot)\b/i.test(text) || /(?:png|문서 스크린샷|화면을 PNG로|페이지 이미지로)/i.test(text) ? ['html_to_screenshot'] : [])];
    request('host.workspace.files.v1', ['write_file']); request('host.document.render.v1', tools.length ? tools : ['html_to_pdf', 'html_to_screenshot']); workflows.add('workspace_files'); workflows.add('document_render');
  }
  if (webCapture) { request('host.web.capture.v1', ['capture_url_screenshot']); workflows.add('web_capture'); }
  const workspaceTools = [...(workspaceRead ? ['read_file'] : []), ...(workspaceFind ? ['find_workspace_files'] : []), ...(workspaceList ? ['list_workspace'] : []), ...(workspaceWrite ? ['write_file'] : []), ...(workspaceEdit ? ['edit_file'] : []), ...(workspaceDownload ? ['download_url_to_workspace'] : [])];
  if (workspaceTools.length) { request('host.workspace.files.v1', workspaceTools); workflows.add('workspace_files'); }
  if (spreadsheetCreate || spreadsheetEdit || documentRender || webCapture || workspaceWrite || workspaceEdit || workspaceDownload) { request('host.artifact.receipt.v1'); workflows.add('artifact_delivery'); }
  return { capability_ids: [...capabilityIds].sort(), workflows: [...workflows].sort(), tool_names: [...toolNames].sort() };
}

export async function inspectHostCapabilityRuntime(input: { root: string; request?: HostCapabilityRequest; projectTrusted?: boolean; dependencies?: HostCapabilityRuntimeDependencies }): Promise<HostCapabilityRuntime> {
  const request = input.request || { capability_ids: [], workflows: [] };
  const knownIds = new Set(HOST_CAPABILITY_DESCRIPTORS.map((capability) => capability.id));
  const knownTools = new Set(HOST_CAPABILITY_DESCRIPTORS.flatMap((capability) => capability.tool_names));
  const requestedIds = uniqueStrings(request.capability_ids);
  const requestedToolNames = uniqueStrings(request.tool_names || []);
  const explicitToolScope = Array.isArray(request.tool_names);
  const unknownIds = requestedIds.filter((id) => !knownIds.has(id));
  const unknownTools = requestedToolNames.filter((name) => !knownTools.has(name));
  const requested = new Set(requestedIds.filter((id) => knownIds.has(id)));
  const requestedTools = new Set(requestedToolNames.filter((name) => knownTools.has(name)));
  const workflows = uniqueWorkflows(request.workflows);
  const descriptorTools = (descriptor: HostCapabilityDescriptor) => explicitToolScope ? descriptor.tool_names.filter((name) => requestedTools.has(name)) : descriptor.tool_names;
  const boundTools = new Set(HOST_CAPABILITY_DESCRIPTORS.filter((descriptor) => descriptor.executable !== false && requested.has(descriptor.id)).flatMap(descriptorTools));
  const unboundTools = requestedToolNames.filter((name) => knownTools.has(name) && !boundTools.has(name));
  const commonBlockers = () => [...unknownIds.map((id) => `host_capability_unknown:${id}`), ...unknownTools.map((name) => `host_capability_tool_unknown:${name}`), ...unboundTools.map((name) => `host_capability_tool_scope_unbound:${name}`)];
  const unavailable = (state: 'missing' | 'unhealthy', detail?: string) => HOST_CAPABILITY_DESCRIPTORS.map((descriptor) => entry(descriptor, requested.has(descriptor.id), requested.has(descriptor.id) ? state : 'not_requested', [], [], requested.has(descriptor.id) ? [`host_capability_${state}:${descriptor.id}${detail || ''}`] : []));
  if (input.projectTrusted !== true) {
    const capabilities = HOST_CAPABILITY_DESCRIPTORS.map((descriptor) => entry(descriptor, requested.has(descriptor.id), requested.has(descriptor.id) ? 'unhealthy' : 'not_requested', [], [], requested.has(descriptor.id) ? [`host_capability_project_trust_missing:${descriptor.id}`] : []));
    const trustRequired = requestedIds.length > 0 || requestedToolNames.length > 0 || workflows.length > 0;
    return result(false, false, null, 'untrusted', requestedIds, workflows, requestedToolNames, [], [], capabilities, [...(trustRequired ? ['host_capability_project_trust_missing'] : []), ...commonBlockers(), ...capabilities.flatMap((value) => value.blockers)]);
  }
  const inventory = await (input.dependencies?.inventory || listMcpInventory)('project', { projectRoot: input.root, ...(input.dependencies?.inventoryOptions || {}), projectTrusted: true });
  const server = inventory.servers.find((value) => value.name === HOST_CAPABILITY_MCP_SERVER) || null;
  const inventoryBlockers = inventory.ok ? [] : ['host_capability_project_mcp_inventory_unhealthy'];
  if (!server) {
    const capabilities = unavailable('missing');
    return result(false, false, inventory.source, 'missing', requestedIds, workflows, requestedToolNames, [], [], capabilities, [...commonBlockers(), ...(requested.size ? inventoryBlockers : []), ...capabilities.flatMap((value) => value.blockers)]);
  }
  if (!server.enabled) {
    const capabilities = unavailable('unhealthy', ':disabled');
    return result(true, false, inventory.source, 'disabled', requestedIds, workflows, requestedToolNames, [], [], capabilities, [...commonBlockers(), ...(requested.size ? inventoryBlockers : []), ...capabilities.flatMap((value) => value.blockers)]);
  }
  const health = await (input.dependencies?.health || testMcpConnection)(HOST_CAPABILITY_MCP_SERVER, 'project', { projectRoot: input.root, ...(input.dependencies?.healthOptions || {}), projectTrusted: true });
  const observedNames = health.status === 'healthy' && Array.isArray(health.tool_names) ? uniqueStrings(health.tool_names).slice(0, MAX_OBSERVED_TOOL_NAMES) : [];
  const observed = new Set(observedNames);
  const enabled = Array.isArray(server.enabled_tools) ? new Set(server.enabled_tools) : null;
  const disabled = new Set(server.disabled_tools || []);
  const available = (name: string) => observed.has(name) && (!enabled || enabled.has(name)) && !disabled.has(name);
  const healthy = health.status === 'healthy' && Array.isArray(health.tool_names);
  const capabilities = HOST_CAPABILITY_DESCRIPTORS.map((descriptor) => {
    const isRequested = requested.has(descriptor.id);
    const required = descriptorTools(descriptor);
    const observedTools = descriptor.tool_names.filter(available);
    const ready = descriptor.executable === false ? observedTools.length > 0 : required.length > 0 && required.every(available);
    const state: HostCapabilityState = !healthy ? isRequested ? 'unhealthy' : 'not_requested' : ready ? 'available' : isRequested ? 'missing' : 'not_requested';
    const blockers = isRequested ? [...(descriptor.executable !== false && required.length === 0 ? [`host_capability_tool_scope_empty:${descriptor.id}`] : []), ...(state !== 'available' ? [`host_capability_${state}:${descriptor.id}${state === 'unhealthy' ? `:${health.status}` : ''}`] : [])] : [];
    return entry(descriptor, isRequested, state, observedTools, isRequested && descriptor.executable !== false ? required.filter(available) : [], blockers);
  });
  const allowedNames = uniqueStrings(HOST_CAPABILITY_DESCRIPTORS.filter((descriptor) => descriptor.executable !== false && requested.has(descriptor.id)).flatMap((descriptor) => descriptorTools(descriptor).filter(available)));
  const allowed = new Set(allowedNames);
  const deniedNames = observedNames.filter((name) => !allowed.has(name));
  return result(true, true, inventory.source, health.status, requestedIds, workflows, requestedToolNames, observedNames, allowedNames, capabilities, [...commonBlockers(), ...(requested.size ? inventoryBlockers : []), ...capabilities.flatMap((value) => value.blockers)], deniedNames);
}

export function hostCapabilityCodexConfigArgs(runtime: HostCapabilityRuntime): string[] {
  if (!runtime.server_present) return [];
  return ['-c', `mcp_servers.${runtime.server}.enabled_tools=${tomlArray(runtime.allowed_tool_names)}`, '-c', `mcp_servers.${runtime.server}.disabled_tools=${tomlArray(runtime.denied_tool_names)}`];
}

export function hostCapabilityRuntimeDigest(runtime: HostCapabilityRuntime): string {
  return `sha256:${sha256(JSON.stringify({ server: runtime.server, server_present: runtime.server_present, server_enabled: runtime.server_enabled, server_scope: runtime.server_scope, inventory_source: runtime.inventory_source, health_status: runtime.health_status, requested_capability_ids: runtime.requested_capability_ids, task_workflows: runtime.task_workflows, requested_tool_names: runtime.requested_tool_names, observed_tool_names: runtime.observed_tool_names, allowed_tool_names: runtime.allowed_tool_names, denied_tool_names: runtime.denied_tool_names, explicit_denied_tool_names: runtime.explicit_denied_tool_names, capability_digest: runtime.capability_digest, capabilities: runtime.capabilities, blockers: runtime.blockers, ok: runtime.ok }))}`;
}

function result(serverPresent: boolean, serverEnabled: boolean, inventorySource: string | null, healthStatus: string, requestedIds: string[], workflows: HostCapabilityWorkflow[], requestedTools: string[], observed: string[], allowed: string[], capabilities: HostCapabilityRuntimeEntry[], inputBlockers: string[], deniedInput?: string[]): HostCapabilityRuntime {
  const observedNames = uniqueStrings(observed).slice(0, MAX_OBSERVED_TOOL_NAMES);
  const allowedNames = uniqueStrings(allowed);
  const denied = uniqueStrings(deniedInput || observedNames.filter((name) => !allowedNames.includes(name)));
  const blockers = uniqueStrings(inputBlockers);
  const runtime: HostCapabilityRuntime = { schema: HOST_CAPABILITY_RUNTIME_SCHEMA, ok: blockers.length === 0, server: HOST_CAPABILITY_MCP_SERVER, server_present: serverPresent, server_enabled: serverEnabled, server_scope: serverPresent ? 'project' : null, inventory_source: inventorySource, health_status: healthStatus, requested_capability_ids: uniqueStrings(requestedIds), task_workflows: uniqueWorkflows(workflows), requested_tool_names: uniqueStrings(requestedTools), observed_tool_names: observedNames, allowed_tool_names: allowedNames, denied_tool_names: denied, explicit_denied_tool_names: denied.filter((name) => EXPLICIT_DENIAL_PATTERN.test(name)), allowlist_digest: '', capability_digest: hostCapabilityDigest(HOST_CAPABILITY_DESCRIPTORS), capabilities, blockers };
  runtime.allowlist_digest = hostCapabilityRuntimeDigest(runtime);
  return runtime;
}

function entry(descriptor: HostCapabilityDescriptor, requested: boolean, state: HostCapabilityState, observed: string[], allowed: string[], blockers: string[]): HostCapabilityRuntimeEntry {
  return { id: descriptor.id, requested, state, expected_tool_names: [...descriptor.tool_names], observed_tool_names: uniqueStrings(observed), allowed_tool_names: uniqueStrings(allowed), blockers: uniqueStrings(blockers) };
}

function intentText(text: string): string {
  return text.split(/(?:\r?\n)+|(?<=[.!?。！？])\s+|;\s+|,\s*(?:and\s+)?then\s+|\b(?:and\s+)?then\s+/i).filter((clause) => !documentationOnly(clause)).filter((clause) => !codeMaintenance(clause) || directExecution(clause)).join('\n');
}

function documentationOnly(text: string): boolean {
  const verbs = '(?:create|generate|produce|deliver|make|build|prepare|convert|export|edit|update|modify|inspect|populate|fill|append|import|query|retrieve|fetch|load|analy[sz]e|show|list|get|read|pull|run|execute|render|capture|write|save|download)';
  return matches(text, [new RegExp(`\\b(?:documentation|docs?|readme|guide|tutorial)\\b.{0,96}\\b(?:explain(?:ing)?|describ(?:e|ing)|document(?:ing)?|show(?:ing)?)\\b.{0,32}\\bhow\\s+to\\b.{0,64}\\b${verbs}\\b`, 'i'), new RegExp(`\\b(?:explain|describe|show)\\b.{0,48}\\bhow\\s+to\\b.{0,64}\\b${verbs}\\b`, 'i'), new RegExp(`\\bhow\\s+(?:do|can|should|would)\\s+(?:i|we|you)\\b.{0,80}\\b${verbs}\\b`, 'i')]);
}

function codeMaintenance(text: string): boolean {
  return matches(text, [/\b(?:tests?|specs?|fixtures?|code[- ]review|implementation|source code|support|policy|contract|workflow)\b/i, /\b(?:database|datasource|spreadsheet|xlsx|excel|workbook|pdf|png)\b.{0,40}\b(?:module|parser|renderer|handler|adapter|client|library|implementation|code|source)\b/i, /\b(?:module|parser|renderer|handler|adapter|library|implementation|code|source)\b.{0,40}\b(?:database|datasource|spreadsheet|xlsx|excel|workbook|pdf|png)\b/i, /(?:테스트|스펙|픽스처|코드\s*리뷰|구현|지원|정책|계약|워크플로|요구사항|가능하게)/i, /(?:데이터베이스|데이터소스|스프레드시트|엑셀|xlsx|pdf|png).{0,28}(?:모듈|파서|렌더러|핸들러|어댑터|라이브러리|구현|코드|소스)/i, /(?:모듈|파서|렌더러|핸들러|어댑터|라이브러리|구현|코드|소스).{0,28}(?:데이터베이스|데이터소스|스프레드시트|엑셀|xlsx|pdf|png)/i]);
}

function directExecution(text: string): boolean {
  return matches(text, [/\b(?:create|generate|make|build|prepare|render)\s+(?:an?\s+|the\s+)?(?:xlsx|excel workbook|excel report|spreadsheet(?: file| report)?|workbook(?: file)?|pdf(?: file| document| report)?|png(?: file| image)?)\b(?!\s+(?:parser|reader|writer|module|tests?|specs?|fixtures?|code|implementation)\b)/i, /\b(?:populate|fill)\b.{0,24}\b(?:new|blank|empty)\b.{0,24}\b(?:xlsx|excel(?: workbook)?|spreadsheet|workbook)\b/i, /\b(?:deliver|export|save|produce)\b.{0,32}\b(?:xlsx|excel|spreadsheet|workbook|pdf|png|artifact|deliverable)\b/i, /\b(?:edit|update|modify|populate|fill|append|import|inspect)\s+(?:the\s+|an?\s+)?(?:existing\s+)?(?:xlsx|excel(?: workbook)?|spreadsheet|workbook)\b(?!\s+(?:parser|reader|writer|module|tests?|specs?|fixtures?|code|implementation)\b)/i, /\b(?:edit|update|modify|populate|fill|append|import)\b.{0,48}\b[A-Za-z0-9._/-]+\.xlsx\b/i, /\b(?:inspect|open)\b.{0,64}\b[A-Za-z0-9._/-]+\.xlsx\b.{0,48}\b(?:and\s+)?(?:edit|update|modify|populate|fill|append|import)\s+(?:it|the\s+(?:file|workbook|spreadsheet))\b/i, /\b(?:run|execute)\b.{0,32}\b(?:read[- ]only\s+)?(?:query|select|cte)\b(?!\s+(?:(?:unit|integration|regression)\s+)?tests?\b)/i, /\b(?:query|retrieve|fetch|load)\b.{0,40}\b(?:database|datasource|rows?|records?|results?|(?:customer|sales|database)?\s*data)\b/i, /\b(?:get|read)\b.{0,56}\b(?:data|rows?|records?|results?)\b.{0,48}\b(?:from|in)\s+(?:the\s+)?(?:database|datasource|db)\b/i, /\bpull\b.{0,64}\b(?:from|out\s+of)\s+(?:the\s+)?(?:database|datasource|db)\b/i, /\b(?:from|in)\s+(?:the\s+)?(?:database|datasource|db)\b.{0,56}\b(?:get|read|pull)\b.{0,48}\b(?:data|rows?|records?|results?)\b/i, /\banaly[sz]e\b.{0,40}\b(?:database\s+data|datasource\s+data|rows?|records?|query\s+results?|customer\s+data|sales\s+data)\b/i, /\b(?:test|inspect|review)\b.{0,32}\b(?:pdf|png)\b.{0,24}\band\s+(?:export|deliver|save|render)\s+(?:it|the\s+(?:file|document|image))\b/i, /(?:엑셀|스프레드시트|xlsx)(?!\s*(?:파서|리더|라이터|모듈|코드|테스트|스펙|픽스처)).{0,20}(?:업데이트|수정|편집|입력|채우|반영)/i, /(?:업데이트|수정|편집|입력|채우|반영).{0,20}(?:엑셀|스프레드시트|xlsx)/i, /(?:엑셀|스프레드시트|xlsx|pdf|png).{0,24}(?:파일|문서|보고서|산출물).{0,24}(?:생성|작성|만들|렌더|내보내|납품|저장)/i, /(?:생성|작성|만들|렌더|내보내|납품|저장).{0,24}(?:엑셀|스프레드시트|xlsx|pdf|png)(?:\s*(?:파일|문서|보고서|산출물))?/i, /(?:실행|조회|가져오).{0,24}(?:읽기\s*전용\s*)?(?:쿼리|질의|행|레코드|결과)/i]);
}

export function renderHostCapabilityBlockedLines(
  blockers: readonly unknown[],
  fallback: HostCapabilityBlockedFallback
): string[] {
  const codes = uniqueStrings(blockers
    .map((value) => String(value || '').trim().split(/\r?\n/, 1)[0] || '')
    .map((value) => value.match(/^[a-z][a-z0-9.-]*(?:_[a-z0-9.-]+)+(?::[a-z0-9_.-]+)*/i)?.[0] || '')
    .map((value) => value.slice(0, 180))
    .filter(Boolean));
  const prioritized = [...codes].sort((left, right) => blockerPriority(left) - blockerPriority(right));
  const primary = prioritized[0] || 'host_capability_blocked';
  const guidance = blockerGuidance(primary, fallback);
  return [
    '상태: 차단',
    `이유: ${guidance.reason}`,
    `조치: ${guidance.action}`,
    `코드: ${primary}`
  ];
}

function blockerPriority(code: string): number {
  if (/^(?:host_capability_project_trust_missing|host_tool_call_not_allowed)/.test(code)) return 0;
  if (/^(?:host_capability_missing|host_capability_unhealthy|host_capability_project_mcp_inventory_unhealthy)|mcp.*(?:connection|inventory|health|missing|tool)/.test(code)) return 1;
  if (/(?:datasource|readonly_query).*(?:mismatch|schema)|spreadsheet.*(?:sequence|inspection_not_completed|resource_mismatch|update_count_invalid)|document.*(?:source|path|required|resource_mismatch)|(?:input|argument|contract).*(?:invalid|required|mismatch)/.test(code)) return 2;
  if (/host_tool_response_malformed|artifact.*missing|receipt.*missing|error_cell/.test(code)) return 3;
  if (/(?:proof|receipt).*mismatch|parent_receipts_mismatch/.test(code)) return 4;
  return 4;
}

function blockerGuidance(code: string, fallback: HostCapabilityBlockedFallback): HostCapabilityBlockedFallback {
  if (code.startsWith('host_tool_call_not_allowed')) {
    const tool = code.split(':')[1] || '요청한 도구';
    return {
      reason: `현재 에이전트에 ${tool === 'spreadsheet_update' ? '엑셀 수정' : '요청한'} 도구가 허용되지 않았습니다.`,
      action: `ACAS 에이전트 도구 권한에서 ${tool}를 허용한 뒤 같은 요청을 다시 실행하세요.`
    };
  }
  if (code.startsWith('host_capability_project_trust_missing')) return {
    reason: '프로젝트 신뢰가 확인되지 않아 호스트 도구를 사용할 수 없습니다.',
    action: '프로젝트를 신뢰한 뒤 --trusted-project로 같은 요청을 다시 실행하세요.'
  };
  if (code.startsWith('host_capability_missing')) return {
    reason: '요청한 호스트 기능이 현재 ACAS 도구 목록에 없습니다.',
    action: 'ACAS 에이전트 도구 권한과 acas-tools 구성을 확인한 뒤 다시 실행하세요.'
  };
  if (blockerPriority(code) === 1) return {
    reason: 'acas-tools MCP 연결 또는 상태 확인에 실패했습니다.',
    action: '프로젝트 MCP inventory와 acas-tools health를 복구한 뒤 다시 실행하세요.'
  };
  if (code.startsWith('host_tool_response_malformed:datasource_query_readonly')) return {
    reason: 'DB 조회 결과가 SKS가 검증할 수 있는 응답 형식을 따르지 않았습니다.',
    action: 'ACAS Agent를 최신 호환 버전으로 업데이트한 뒤 같은 mission을 재실행하세요.'
  };
  if (code.startsWith('host_tool_response_malformed')) return {
    reason: '호스트 도구 결과가 SKS가 검증할 수 있는 응답 형식을 따르지 않았습니다.',
    action: 'ACAS Agent를 최신 호환 버전으로 업데이트한 뒤 같은 mission을 재실행하세요.'
  };
  if (/(?:datasource|readonly_query).*(?:mismatch|schema)/.test(code)) return {
    reason: '데이터 조회가 선행 스키마 정보와 일치하지 않습니다.',
    action: '같은 datasource의 schema context를 다시 받고 matching snapshot으로 조회하세요.'
  };
  if (/spreadsheet.*(?:sequence|inspection_not_completed|resource_mismatch|update_count_invalid)/.test(code)) return {
    reason: '엑셀 작업 순서 또는 대상 파일이 검사 결과와 일치하지 않습니다.',
    action: '같은 파일을 create/update 뒤 inspect하고 허용된 mutation 상한 안에서 다시 실행하세요.'
  };
  if (blockerPriority(code) >= 3) return {
    reason: '최종 산출물 또는 proof receipt 검증이 완료되지 않았습니다.',
    action: '산출물을 다시 생성·검사하고 최종 mutation 또는 render receipt를 제출하세요.'
  };
  return fallback;
}

function matches(text: string, patterns: readonly RegExp[]): boolean { return patterns.some((pattern) => pattern.test(text)); }
function tomlArray(values: readonly string[]): string { return `[${values.map((value) => JSON.stringify(value)).join(', ')}]`; }
function uniqueStrings(values: readonly unknown[]): string[] { return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))].sort(); }
function uniqueWorkflows(values: readonly unknown[]): HostCapabilityWorkflow[] {
  const valid = new Set<HostCapabilityWorkflow>(['datasource_sql_generation', 'datasource_query', 'spreadsheet_create', 'spreadsheet_edit', 'document_render', 'web_capture', 'workspace_files', 'artifact_delivery']);
  return uniqueStrings(values).filter((value): value is HostCapabilityWorkflow => valid.has(value as HostCapabilityWorkflow));
}
