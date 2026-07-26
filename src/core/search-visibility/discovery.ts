import fs from 'node:fs/promises';
import path from 'node:path';
import { exists, readJson, readText, sha256 } from '../fsx.js';
import type {
  DetectionResult,
  EvidenceRef,
  HtmlFileSummary,
  LocaleCandidate,
  PolicyFileSummary,
  ProjectContext,
  SearchVisibilityCapabilities,
  SearchVisibilityFramework,
  SearchVisibilityResolvedTarget,
  SiteInventory,
  SiteRoute,
} from './types.js';
import { isRecord } from '../json/records.js';

const MAX_DISCOVERY_FILES = 2500;
const DEFAULT_CAPABILITIES: SearchVisibilityCapabilities = {
  sourceAudit: true,
  builtHtmlAudit: false,
  liveHttpAudit: false,
  renderedBrowserAudit: false,
  metadataMutation: false,
  sitemapMutation: false,
  robotsMutation: false,
  structuredDataMutation: false,
  localeMutation: false,
};

export async function detectProject(ctx: ProjectContext): Promise<DetectionResult> {
  const files = await walkFiles(ctx.root, MAX_DISCOVERY_FILES);
  const rels = new Set(files);
  const packageJson = await readJson(path.join(ctx.root, 'package.json'), {});
  const deps = {
    ...(isRecord(packageJson.dependencies) ? packageJson.dependencies : {}),
    ...(isRecord(packageJson.devDependencies) ? packageJson.devDependencies : {}),
  };
  const hasNext = Object.hasOwn(deps, 'next') || rels.has('next.config.js') || rels.has('next.config.mjs') || rels.has('next.config.ts');
  const appEvidence = files.find((file) => /(?:^|\/)app\/(?:layout|page)\.(?:tsx|ts|jsx|js|mdx)$/.test(file));
  const pagesEvidence = files.find((file) => /(?:^|\/)pages\/(?:index|_app|_document|.+)\.(?:tsx|ts|jsx|js|mdx)$/.test(file));
  const staticEvidence = files.find((file) => /(?:^|\/)(?:public\/)?index\.html$/.test(file));
  const forced = ctx.framework !== 'auto' ? ctx.framework : null;
  if (forced && forced !== 'unsupported') return forcedDetection(forced, files);
  if (hasNext && appEvidence) return detection('next-app', 0.95, [{ path: appEvidence, reason: 'Next.js App Router route source found' }], mutationCapabilities('next-app'));
  if (hasNext && pagesEvidence) return detection('next-pages', 0.9, [{ path: pagesEvidence, reason: 'Next.js Pages Router source found' }], mutationCapabilities('next-pages'));
  if (staticEvidence) return detection('static-site', 0.82, [{ path: staticEvidence, reason: 'Static HTML entry point found' }], mutationCapabilities('static'));
  if (await exists(path.join(ctx.root, 'package.json'))) return detection('package', 0.75, [{ path: 'package.json', reason: 'Package metadata found' }], mutationCapabilities('package'));
  return detection('unsupported', 0.25, [], DEFAULT_CAPABILITIES, ['No package, Next.js, or static HTML evidence found']);
}

export async function discoverSiteInventory(ctx: ProjectContext, detected: DetectionResult): Promise<SiteInventory> {
  const files = await walkFiles(ctx.root, MAX_DISCOVERY_FILES);
  const packageJson = await readJson(path.join(ctx.root, 'package.json'), {});
  const readmePath = await firstExisting(ctx.root, ['README.md', 'readme.md']);
  const readme = readmePath ? await readText(path.join(ctx.root, readmePath), '') : '';
  const htmlFiles = await Promise.all(files.filter((file) => file.endsWith('.html')).slice(0, 200).map((file) => summarizeHtml(ctx.root, file)));
  const routes = discoverRoutes(files, htmlFiles);
  const target = resolveTarget(ctx.target, detected, files);
  const inventory: SiteInventory = {
    schema: 'sks.search-visibility.site-inventory.v1',
    root: ctx.root,
    origin: ctx.origin,
    target,
    detected_adapter: detected,
    package: {
      path: await exists(path.join(ctx.root, 'package.json')) ? 'package.json' : null,
      name: stringOrNull(packageJson.name),
      version: stringOrNull(packageJson.version),
      description: stringOrNull(packageJson.description),
      keywords: Array.isArray(packageJson.keywords) ? packageJson.keywords.map(String) : [],
      repository: repositoryUrl(packageJson.repository),
      homepage: stringOrNull(packageJson.homepage),
      bugs: repositoryUrl(packageJson.bugs),
      bin: isRecord(packageJson.bin) ? Object.keys(packageJson.bin) : (typeof packageJson.bin === 'string' ? [String(packageJson.name || '')].filter(Boolean) : []),
      scripts: isRecord(packageJson.scripts) ? stringifyRecord(packageJson.scripts) : {},
      framework_versions: frameworkVersions(packageJson),
    },
    readme: {
      path: readmePath,
      h1: firstMarkdownHeading(readme, 1),
      headings: markdownHeadings(readme),
      command_mentions: commandMentions(readme),
      links: markdownLinks(readme),
    },
    routes,
    html_files: htmlFiles,
    policy_files: await policyFiles(ctx.root),
    locale_candidates: discoverLocales(files, htmlFiles),
    metadata_helpers: files.filter((file) => /(seo|metadata|schema|json-ld|structured-data|canonical|sitemap|robots)/i.test(file)).slice(0, 100),
    structured_data_sources: files.filter((file) => /(schema|json-ld|structured-data|ld-json)/i.test(file)).slice(0, 100),
    live_url_checked: Boolean(ctx.origin && !ctx.offline),
    browser_checked: false,
    generated_at: new Date().toISOString(),
  };
  return inventory;
}

export function sourceEvidence(pathValue: string, summary: string, hash: string | null = null, line: number | null = null): EvidenceRef {
  return {
    type: 'source',
    path: pathValue,
    line,
    selector: null,
    hash,
    url: null,
    observed_at: new Date().toISOString(),
    summary,
  };
}

export function officialEvidence(url: string, summary: string): EvidenceRef {
  return {
    type: 'official_source',
    path: null,
    line: null,
    selector: null,
    hash: null,
    url,
    observed_at: new Date().toISOString(),
    summary,
  };
}

export async function walkFiles(root: string, maxFiles = MAX_DISCOVERY_FILES): Promise<string[]> {
  const out: string[] = [];
  const ignored = new Set(['.git', 'node_modules', 'dist', '.next', '.sneakoscope', '.codex', '.agents', 'coverage', 'archive']);
  async function walk(dir: string): Promise<void> {
    if (out.length >= maxFiles) return;
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      if (ignored.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(rel);
    }
  }
  await walk(root);
  return out.sort();
}

function forcedDetection(framework: SearchVisibilityFramework, files: string[]): DetectionResult {
  const adapterId = framework === 'static' ? 'static-site' : framework;
  return detection(adapterId, 0.8, [{ path: files[0] || '.', reason: `Framework forced by --framework ${framework}` }], mutationCapabilities(framework));
}

function detection(adapterId: string, confidence: number, evidence: Array<{ path: string; reason: string }>, capabilities: SearchVisibilityCapabilities, blockers: string[] = []): DetectionResult {
  return { adapterId, confidence, evidence, capabilities, blockers };
}

function mutationCapabilities(framework: SearchVisibilityFramework | string): SearchVisibilityCapabilities {
  const base = { ...DEFAULT_CAPABILITIES };
  if (framework === 'next-app' || framework === 'next-pages') {
    return { ...base, metadataMutation: true, sitemapMutation: true, robotsMutation: true, structuredDataMutation: true, localeMutation: true };
  }
  if (framework === 'static' || framework === 'static-site') {
    return { ...base, builtHtmlAudit: true, metadataMutation: true, sitemapMutation: true, robotsMutation: true, structuredDataMutation: true };
  }
  if (framework === 'package') return { ...base };
  return base;
}

function resolveTarget(target: ProjectContext['target'], detected: DetectionResult, files: string[]): SearchVisibilityResolvedTarget {
  if (target !== 'auto') return target;
  if (detected.adapterId === 'package') return 'package';
  if (files.some((file) => /(?:^|\/)(docs|documentation)\//i.test(file))) return 'docs';
  return detected.adapterId === 'unsupported' ? 'package' : 'website';
}

async function summarizeHtml(root: string, rel: string): Promise<HtmlFileSummary> {
  const text = await readText(path.join(root, rel), '');
  const jsonLdBlocks = Array.from(text.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi));
  const jsonLdParseErrors: string[] = [];
  for (const match of jsonLdBlocks) {
    const raw = match[1] || '';
    try {
      JSON.parse(raw.trim());
    } catch (err) {
      jsonLdParseErrors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return {
    path: rel,
    title: tagText(text, 'title'),
    description: metaContent(text, 'description'),
    canonical: linkHref(text, 'canonical'),
    robots: metaContent(text, 'robots'),
    lang: htmlLang(text),
    links: hrefs(text).slice(0, 500),
    jsonLdCount: jsonLdBlocks.length,
    jsonLdParseErrors,
    visibleTextSample: stripTags(text).replace(/\s+/g, ' ').trim().slice(0, 500),
  };
}

function discoverRoutes(files: string[], htmlFiles: HtmlFileSummary[]): SiteRoute[] {
  const routes: SiteRoute[] = [];
  for (const html of htmlFiles) routes.push({ path: routePathFromHtml(html.path), source: html.path, kind: 'static', locale: localeFromPath(html.path) });
  for (const file of files) {
    const app = file.match(/(?:^|\/)app\/(.+)\/page\.(?:tsx|ts|jsx|js|mdx)$/);
    if (app?.[1]) routes.push({ path: `/${normalizeRouteSegments(app[1])}`, source: file, kind: routeKind(app[1]), locale: localeFromPath(app[1]) });
    const appRoot = file.match(/(?:^|\/)app\/page\.(?:tsx|ts|jsx|js|mdx)$/);
    if (appRoot) routes.push({ path: '/', source: file, kind: 'static', locale: null });
    const pages = file.match(/(?:^|\/)pages\/(.+)\.(?:tsx|ts|jsx|js|mdx)$/);
    if (pages?.[1] && !pages[1].startsWith('_')) routes.push({ path: `/${normalizeRouteSegments(pages[1].replace(/\/index$/, ''))}`, source: file, kind: routeKind(pages[1]), locale: localeFromPath(pages[1]) });
  }
  const byKey = new Map<string, SiteRoute>();
  for (const route of routes) byKey.set(`${route.path}:${route.source}`, route);
  return Array.from(byKey.values()).sort((a, b) => a.path.localeCompare(b.path));
}

async function policyFiles(root: string): Promise<PolicyFileSummary[]> {
  const specs: Array<[string, PolicyFileSummary['kind']]> = [
    ['robots.txt', 'robots'],
    ['public/robots.txt', 'robots'],
    ['sitemap.xml', 'sitemap'],
    ['public/sitemap.xml', 'sitemap'],
    ['llms.txt', 'llms'],
    ['public/llms.txt', 'llms'],
    ['site.webmanifest', 'manifest'],
    ['public/site.webmanifest', 'manifest'],
  ];
  const out: PolicyFileSummary[] = [];
  for (const [rel, kind] of specs) {
    const full = path.join(root, rel);
    const present = await exists(full);
    const text = present ? await readText(full, '') : '';
    out.push({
      path: rel,
      kind,
      exists: present,
      managed: /sks-search-visibility|BEGIN SKS SEARCH VISIBILITY/i.test(text),
      hash: present ? sha256(text) : null,
    });
  }
  return out;
}

function discoverLocales(files: string[], htmlFiles: HtmlFileSummary[]): LocaleCandidate[] {
  const candidates = new Map<string, LocaleCandidate>();
  for (const html of htmlFiles) {
    if (html.lang) candidates.set(html.lang, { code: html.lang, source: `${html.path}#html-lang`, confidence: 0.9 });
  }
  for (const file of files) {
    const locale = localeFromPath(file);
    if (locale && !candidates.has(locale)) candidates.set(locale, { code: locale, source: file, confidence: 0.7 });
  }
  return Array.from(candidates.values()).sort((a, b) => a.code.localeCompare(b.code));
}

function routePathFromHtml(rel: string): string {
  const normalized = rel.replace(/^public\//, '').replace(/index\.html$/, '').replace(/\.html$/, '');
  const route = `/${normalized}`.replace(/\/+/g, '/');
  return route === '/' ? '/' : route.replace(/\/$/, '');
}

function normalizeRouteSegments(value: string): string {
  return value
    .replace(/\/index$/, '')
    .replace(/\[(\.\.\.)?([^\]]+)\]/g, ':$2')
    .replace(/^\(([^)]+)\)\//, '')
    .replace(/\/+/g, '/')
    .replace(/^\/|\/$/g, '');
}

function routeKind(value: string): SiteRoute['kind'] {
  if (/\[.+\]|:\w+/.test(value)) return 'parameterized';
  return 'static';
}

function localeFromPath(value: string): string | null {
  const first = value.split('/').find(Boolean) || '';
  return /^[a-z]{2}(?:-[A-Z]{2})?$/.test(first) ? first : null;
}

async function firstExisting(root: string, rels: string[]): Promise<string | null> {
  for (const rel of rels) {
    if (await exists(path.join(root, rel))) return rel;
  }
  return null;
}

function stringifyRecord(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, String(val)]));
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function repositoryUrl(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.url === 'string') return value.url;
  return null;
}

function frameworkVersions(packageJson: Record<string, unknown>): Record<string, string> {
  const deps = {
    ...(isRecord(packageJson.dependencies) ? packageJson.dependencies : {}),
    ...(isRecord(packageJson.devDependencies) ? packageJson.devDependencies : {}),
  };
  const names = ['next', 'react', 'astro', 'nuxt', 'svelte', 'vite'];
  return Object.fromEntries(names.filter((name) => typeof deps[name] === 'string').map((name) => [name, String(deps[name])]));
}

function firstMarkdownHeading(text: string, level: number): string | null {
  const prefix = '#'.repeat(level);
  const line = text.split(/\r?\n/).find((row) => row.startsWith(`${prefix} `));
  return line ? line.replace(/^#+\s*/, '').trim() : null;
}

function markdownHeadings(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => /^#{1,6}\s+/.test(line)).map((line) => line.replace(/^#+\s*/, '').trim()).slice(0, 200);
}

function commandMentions(text: string): string[] {
  return Array.from(new Set(Array.from(text.matchAll(/\b(?:sks|npx|npm|node)\s+[^\n`]{1,80}/g)).map((m) => (m[0] || '').trim()).filter(Boolean))).slice(0, 100);
}

function markdownLinks(text: string): string[] {
  return Array.from(new Set(Array.from(text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)).map((m) => m[1] || '').filter(Boolean))).slice(0, 500);
}

function tagText(text: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = text.match(re);
  return match?.[1] ? stripTags(match[1]).trim() || null : null;
}

function metaContent(text: string, name: string): string | null {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${escapeRegex(name)}["'][^>]*content=["']([^"']+)["'][^>]*>`, 'i');
  const alt = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:name|property)=["']${escapeRegex(name)}["'][^>]*>`, 'i');
  return text.match(re)?.[1] || text.match(alt)?.[1] || null;
}

function linkHref(text: string, rel: string): string | null {
  const re = new RegExp(`<link[^>]+rel=["']${escapeRegex(rel)}["'][^>]*href=["']([^"']+)["'][^>]*>`, 'i');
  const alt = new RegExp(`<link[^>]+href=["']([^"']+)["'][^>]*rel=["']${escapeRegex(rel)}["'][^>]*>`, 'i');
  return text.match(re)?.[1] || text.match(alt)?.[1] || null;
}

function htmlLang(text: string): string | null {
  return text.match(/<html[^>]+lang=["']([^"']+)["']/i)?.[1] || null;
}

function hrefs(text: string): string[] {
  return Array.from(new Set(Array.from(text.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)).map((m) => m[1] || '').filter(Boolean)));
}

function stripTags(text: string): string {
  return text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
