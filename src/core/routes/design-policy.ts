import { PRODUCT_DESIGN_PLUGIN, PRODUCT_DESIGN_REQUIRED_SKILLS, productDesignPluginPolicyText } from '../product-design-plugin.js';
import { CODEX_APP_IMAGE_GENERATION_DOC_URL, CODEX_COMPUTER_USE_ONLY_POLICY, CODEX_IMAGEGEN_REQUIRED_POLICY, CODEX_WEB_VERIFICATION_POLICY } from './evidence.js';

export { productDesignPluginPolicyText };

const GETDESIGN_CODEX_SKILL_REPOSITORY = 'MohtashamMurshid/getdesign';
const GETDESIGN_CODEX_SKILL_REF = '83e9840d4a5744b5f10117ec00b855059e5abc25';

export const GETDESIGN_REFERENCE = {
  id: 'getdesign',
  url: 'https://getdesign.md/',
  docs_url: 'https://docs.getdesign.app/',
  official_urls_url: 'https://docs.getdesign.app/resources/official-urls/',
  codex_guide_url: 'https://docs.getdesign.app/guides/use-with-codex/',
  codex_skill_repository: GETDESIGN_CODEX_SKILL_REPOSITORY,
  codex_skill_ref: GETDESIGN_CODEX_SKILL_REF,
  codex_skill: GETDESIGN_CODEX_SKILL_REPOSITORY,
  codex_skill_install: `skills add ${GETDESIGN_CODEX_SKILL_REPOSITORY} --global --agent codex --yes`,
  codex_skill_install_mode: 'manual_only',
  npm_cli: '@getdesign/cli',
  npm_sdk: '@getdesign/sdk',
  official_mcp_available: false,
  surfaces: ['web', 'api', 'cli', 'sdk', 'skill'],
  purpose: 'Ground DESIGN.md, UI/UX design systems, and presentation-like HTML/PDF artifacts in current design references.'
};

export const DESIGN_SYSTEM_SSOT = {
  id: 'design-system-ssot',
  authority_file: 'design.md',
  builder_prompt: 'docs/Design-Sys-Prompt.md',
  rule: `Product Design plugin (${PRODUCT_DESIGN_PLUGIN.id}) is the primary design authority when available. design.md is a project-local cache/compatibility authority only when already present or when Product Design is unavailable; if fallback is needed, synthesize it from the builder prompt plus approved source inputs and fuse external references into design.md or route artifacts instead of keeping parallel authorities.`
};

export const AWESOME_DESIGN_MD_REFERENCE = {
  id: 'awesome-design-md',
  url: 'https://github.com/VoltAgent/awesome-design-md',
  purpose: 'Curated ready-to-use DESIGN.md examples extracted from public brand and product websites; use only as source input to the design SSOT, not as a parallel authority.'
};

export const RECOMMENDED_DESIGN_REFERENCES = [GETDESIGN_REFERENCE, AWESOME_DESIGN_MD_REFERENCE];
export const PRODUCT_DESIGN_PLUGIN_TOOL_ALLOWLIST = PRODUCT_DESIGN_REQUIRED_SKILLS;

export function getdesignReferencePolicyText() {
  return `Design authority policy: ${PRODUCT_DESIGN_PLUGIN.id} is the first design surface for Codex App design routes. ${DESIGN_SYSTEM_SSOT.authority_file} is a project-local design cache/compatibility authority when already present or when Product Design is unavailable. If fallback creation is needed, create or update it through ${DESIGN_SYSTEM_SSOT.builder_prompt}; getdesign.md (${GETDESIGN_REFERENCE.url}), its official docs, and curated DESIGN.md examples at ${AWESOME_DESIGN_MD_REFERENCE.url} are source inputs to fuse into that fallback SSOT or into route-local style tokens, not parallel authorities. Prefer Product Design plugin tools for design context, ideation, prototype, audit, and QA; use the generated getdesign-reference skill only as fallback/source grounding. Do not claim an official getdesign MCP server is configured unless a current official MCP surface is actually available. ${productDesignPluginPolicyText()}`;
}

export function imageUxReviewPipelinePolicyText() {
  return `Image UX review pipeline: the core mechanism is not text-only screenshot critique. Capture or receive source UI screenshots; web/browser/webapp capture must pass the Codex Chrome Extension readiness gate first, while Computer Use is only for native Mac/non-web app surfaces. Use Product Design plugin audit/design-qa when available to structure UX issue framing, but still require the imagegen visual evidence route. Then use Codex App imagegen/$imagegen with gpt-image-2 (${CODEX_APP_IMAGE_GENERATION_DOC_URL}) to create new annotated review images from those screenshots as reference inputs. The generated review image must visibly mark numbered callouts, P0/P1/P2/P3 labels, eye-flow, hierarchy, contrast, alignment, density, affordance problems, and a small corrected mini-comp or before/after strip when useful. Then analyze that generated review image with vision/OCR and convert the visible callouts into image-ux-issue-ledger.json rows. Missing generated review images block full Image UX verification, but the route may close as verified_partial/reference-only when source screenshots plus hashes, docs evidence, source Image Voxel anchors, and Honest Mode evidence exist and the gate records that no annotated image, callout extraction, or full UX review evidence exists. Never pass this route from a direct API fallback, hand-written text-only substitute, placeholder asset, or fabricated ledger. ${productDesignPluginPolicyText()} ${CODEX_WEB_VERIFICATION_POLICY} ${CODEX_COMPUTER_USE_ONLY_POLICY} ${CODEX_IMAGEGEN_REQUIRED_POLICY}`;
}
