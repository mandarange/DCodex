export const CODEX_COMPUTER_USE_EVIDENCE_SOURCE = 'codex_computer_use';
export const CODEX_IN_APP_BROWSER_EVIDENCE_SOURCE = 'codex_in_app_browser';
export const CODEX_CHROME_EXTENSION_EVIDENCE_SOURCE = 'codex_chrome_extension';
export const CODEX_WEB_VERIFICATION_EVIDENCE_SOURCE = CODEX_IN_APP_BROWSER_EVIDENCE_SOURCE;
export const CODEX_IMAGEGEN_EVIDENCE_SOURCE = 'codex_app_imagegen_gpt_image_2';

export const CODEX_IN_APP_BROWSER_DOC_URL = 'https://learn.chatgpt.com/docs/browser';
export const CODEX_CHROME_EXTENSION_DOC_URL = 'https://learn.chatgpt.com/docs/chrome-extension';
export const CODEX_COMPUTER_USE_DOC_URL = 'https://learn.chatgpt.com/docs/computer-use';
export const CODEX_RECORD_REPLAY_DOC_URL = 'https://developers.openai.com/codex/record-and-replay';
export const CODEX_APP_SERVER_DOC_URL = 'https://developers.openai.com/codex/app-server';
export const CODEX_APP_IMAGE_GENERATION_DOC_URL = 'https://learn.chatgpt.com/docs/image-generation';
export const OPENAI_IMAGE_GENERATION_DOC_URL = 'https://developers.openai.com/api/docs/guides/image-generation';
export const OPENAI_CHATGPT_IMAGES_2_DOC_URL = 'https://openai.com/index/introducing-chatgpt-images-2-0/';
export const OPENAI_GPT_IMAGE_2_MODEL_DOC_URL = 'https://developers.openai.com/api/docs/models/gpt-image-2';

export type QaInteractionSurface =
  | 'codex_in_app_browser'
  | 'codex_chrome_extension'
  | 'codex_computer_use'
  | 'codex_app_plugin'
  | 'structured_mcp'
  | 'shell_or_api_diagnostic';

export const QA_INTERACTION_SURFACES: readonly QaInteractionSurface[] = Object.freeze([
  'codex_in_app_browser',
  'codex_chrome_extension',
  'codex_computer_use',
  'codex_app_plugin',
  'structured_mcp',
  'shell_or_api_diagnostic'
]);

export const CODEX_QA_SURFACE_ROUTING_POLICY = `Codex QA surface routing follows the official Codex App split: use @Browser / in-app Browser (${CODEX_IN_APP_BROWSER_DOC_URL}) first for localhost, local development servers, file-backed previews, and public pages that do not require sign-in; use @Chrome / Codex Chrome Extension (${CODEX_CHROME_EXTENSION_DOC_URL}) for signed-in websites, cookies, browser profiles, extensions, existing tabs, or internal tools; use @Computer or @AppName (${CODEX_COMPUTER_USE_DOC_URL}) for native macOS/Windows apps, OS settings, cross-app workflows, and GUI-only bugs. Prefer structured Plugins/MCPs for repeatable data operations, then verify rendered user-visible results with Browser, Chrome, or Computer Use. Playwright, Selenium, Puppeteer, Chrome MCP, static screenshots, plugin cache, and final-agent prose are not Codex App live action proof. App Server evidence (${CODEX_APP_SERVER_DOC_URL}) must correlate thread, turn, item/tool events, approvals, diffs, actions, observations, findings, fixes, and same-flow replay before a real QA pass is claimed.`;
export const CODEX_WEB_VERIFICATION_POLICY = CODEX_QA_SURFACE_ROUTING_POLICY;
export const CODEX_COMPUTER_USE_ONLY_POLICY = `Codex Computer Use is a live GUI surface for supported macOS and Windows environments, invoked with @Computer or @AppName for native apps, OS settings, browser contexts that truly require GUI-level operation, and cross-app workflows. Do not replace @Browser localhost/public-page checks or @Chrome signed-in checks with Computer Use unless the surface router records a specific GUI-only/cross-app reason. If live Computer Use tools, permissions, or app access are unavailable, mark the affected native/GUI evidence blocked or unverified instead of fabricating screenshots or actions. Codex App readiness/config checks are capability evidence only, not target interaction proof.`;
export const IMAGEGEN_SOCIAL_SOURCE_POLICY = 'Use public X/social/community reports only as prompt-quality and workflow-sentiment hints after official OpenAI/Codex docs. Social posts are not capability specs, evidence of tool availability, or proof that a generated asset was created.';
export const CODEX_IMAGEGEN_REQUIRED_POLICY = 'Pipeline image generation, raster asset creation/editing, and generated image-review evidence must use gpt-image-2 through the user-selected Codex provider when that evidence is required for full verification: Codex App imagegen/$imagegen, or the selected and ready codex-lb Responses provider. Only completed response output or a final response.output_item.done image result qualifies; streamed partial preview frames never count as generated-image evidence. For newest-model image requests, prompt explicitly for "ChatGPT Images 2.0 / GPT Image 2.0 with gpt-image-2" instead of relying on generic image-generation wording. Do not substitute placeholder SVG/HTML/CSS, prose-only critique, stock-like stand-ins, manually fabricated files, or missing-output ledgers for requested/generated raster assets or required generated review images. If imagegen/gpt-image-2 is unavailable or generated annotated images cannot be created/linked, record the blocker and cap any closeout at verified_partial/reference-only instead of claiming generated-image evidence or full route verification; that partial closeout requires source screenshots plus hashes, docs evidence, source Image Voxel anchors, and Honest Mode evidence. In Codex App prompts, invoke $imagegen when live image generation is needed; SKS hooks and skills can require the policy but cannot attach missing host image-generation tools to an already-started turn. Official OpenAI/Codex docs are authoritative for capabilities, surfaces, limits, and evidence rules; X/social/community reports may inform prompt style only.';

export const DEFAULT_CODEX_APP_PLUGINS = Object.freeze([
  ['browser', 'openai-bundled'],
  ['chrome', 'openai-bundled'],
  ['computer-use', 'openai-bundled'],
  ['latex', 'openai-bundled'],
  ['documents', 'openai-primary-runtime'],
  ['presentations', 'openai-primary-runtime'],
  ['spreadsheets', 'openai-primary-runtime']
]);

export const RESERVED_CODEX_PLUGIN_SKILL_NAMES = Object.freeze([
  'browser-use',
  ...DEFAULT_CODEX_APP_PLUGINS.map(([name]: any) => name)
].sort());

export const FORBIDDEN_BROWSER_AUTOMATION_RE = /\b(playwright|chrome\s+mcp|selenium|puppeteer)\b/i;

export function evidenceMentionsForbiddenBrowserAutomation(value: any, seen: any = new Set()): boolean {
  if (value == null) return false;
  if (typeof value === 'string') return FORBIDDEN_BROWSER_AUTOMATION_RE.test(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item: any) => evidenceMentionsForbiddenBrowserAutomation(item, seen));
  return Object.values(value).some((item: any) => evidenceMentionsForbiddenBrowserAutomation(item, seen));
}

export function evidenceMentionsForbiddenWebComputerUseEvidence(value: any, seen: any = new Set()): boolean {
  if (value == null) return false;
  if (typeof value === 'string') {
    const text = String(value || '');
    const mentionsComputerUse = /\bcomputer\s*use\b|codex[-_\s]*(?:native[-_\s]*)?computer[-_\s]*use/i.test(text);
    if (!mentionsComputerUse) return false;
    if (/\b(?:no|not|never)\s+(?:use|using|required|satisfy|satisfies|used)\b.*\bcomputer\s*use\b|\bcomputer\s*use\b.*\b(?:not|required|unverified|blocked|reserved|native|non-web|nonweb)\b|must\s+not\s+use\s+codex\s+computer\s+use|do\s+not\s+use\s+codex\s+computer\s+use|not_required_for_web_verification/i.test(text)) return false;
    return /\b(?:evidence|screenshot|screen|capture|visual|source|ledger|used|using|from|via|fixture)\b|codex[-_\s]*(?:native[-_\s]*)?computer[-_\s]*use/i.test(text);
  }
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item: any) => evidenceMentionsForbiddenWebComputerUseEvidence(item, seen));
  return Object.values(value).some((item: any) => evidenceMentionsForbiddenWebComputerUseEvidence(item, seen));
}
