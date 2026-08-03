export const REFLECTION_SKILL_NAME = 'reflection';
export const SOLUTION_SCOUT_SKILL_NAME = 'solution-scout';
export const SOLUTION_SCOUT_STAGE_ID = 'solution_scout';

export const FROM_CHAT_IMG_COVERAGE_ARTIFACT = 'from-chat-img-coverage-ledger.json';
export const FROM_CHAT_IMG_WORK_ORDER_ARTIFACT = 'from-chat-img-work-order.md';
export const FROM_CHAT_IMG_SOURCE_INVENTORY_ARTIFACT = 'from-chat-img-source-inventory.json';
export const FROM_CHAT_IMG_VISUAL_MAP_ARTIFACT = 'from-chat-img-visual-map.json';
export const FROM_CHAT_IMG_CHECKLIST_ARTIFACT = 'from-chat-img-checklist.md';
export const FROM_CHAT_IMG_TEMP_TRIWIKI_ARTIFACT = 'from-chat-img-temp-triwiki.json';
export const FROM_CHAT_IMG_QA_LOOP_ARTIFACT = 'from-chat-img-qa-loop.json';
export const FROM_CHAT_IMG_TEMP_TRIWIKI_SESSIONS = 5;

export const USAGE_TOPICS = 'install|setup|bootstrap|root|deps|auto-review|naruto|qa-loop|ppt|image-ux-review|computer-use|goal|fast-mode|review|research|seo-geo-optimizer|git|codex|codex-app|codex-native|hooks|features|all-features|dfix|commit|commit-and-push|design|imagegen|dollar|context7|super-search|pipeline|reasoning|guard|conflicts|versioning|eval|harness|hproof|gx|wiki|memory|wrongness|code-structure|proof-field|skill-dream|rust|align';

export const RECOMMENDED_MCP_SERVERS = [
  {
    id: 'context7',
    required: true,
    transport: 'remote',
    url: 'https://mcp.context7.com/mcp',
    remote_url: 'https://mcp.context7.com/mcp',
    local_fallback: {
      transport: 'local',
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp@latest']
    },
    purpose: 'Current library/API/framework documentation for route gates.'
  }
];

export const RECOMMENDED_SKILLS = [
  'sks-reasoning-router',
  'sks-pipeline-runner',
  'sks-solution-scout',
  'sks-context7-docs',
  'sks-super-search',
  'sks-search-visibility-core',
  'sks-seo-geo-optimizer',
  'sks-autoresearch-loop',
  'sks-performance-evaluator',
  'sks-getdesign-reference',
  'sks-imagegen',
  'sks-imagegen-source-scout',
  'sks-image-ux-review',
  'sks-computer-use-fast',
  'sks-db-safety-guard',
  'sks-reflection',
  'sks-honest-mode'
];

// Route-level effort names are scheduling intents, not model compatibility
// claims. Actual per-model options come from Codex runtime metadata; SKS never
// derives them from a model slug.
export const ALLOWED_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
