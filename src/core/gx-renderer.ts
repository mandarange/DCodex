import path from 'node:path';
import { exists, nowIso, readJson, readText, sha256, writeJsonAtomic, writeTextAtomic } from './fsx.js';
import { buildWikiCoordinateIndex, normalizeWikiCoord, rgbaKey } from './wiki-coordinate.js';

const SVG_WIDTH = 1280;
const SVG_HEIGHT = 820;

function stableJson(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key: any) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function escapeXml(value: any = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function slug(value: any = '') {
  return String(value || 'item').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}

function shortText(value: any = '', max: any = 64) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function splitLabel(value: any = '', maxLine: any = 24, maxLines: any = 3) {
  const words = String(value || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines: any[] = [];
  let current = '';
  for (const word of words.length ? words : ['Untitled']) {
    if (!current) current = word;
    else if (`${current} ${word}`.length <= maxLine) current = `${current} ${word}`;
    else {
      lines.push(current);
      current = word;
    }
    if (lines.length === maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  return lines.slice(0, maxLines);
}

function normalizeNode(node: any, index: any) {
  const id = slug(node?.id || `node-${index + 1}`);
  return {
    ...node,
    id,
    label: node?.label || node?.title || id,
    kind: node?.kind || node?.type || 'component',
    layer: node?.layer || node?.group || 'default',
    risk: node?.risk || 'normal',
    status: node?.status || 'unknown'
  };
}

function normalizeEdge(edge: any, index: any) {
  return {
    ...edge,
    id: slug(edge?.id || `edge-${index + 1}`),
    from: slug(edge?.from || edge?.source || ''),
    to: slug(edge?.to || edge?.target || ''),
    label: edge?.label || edge?.kind || ''
  };
}

export function normalizeVGraph(vgraph: any = {}) {
  const nodes = Array.isArray(vgraph.nodes) ? vgraph.nodes.map(normalizeNode) : [];
  const edges = Array.isArray(vgraph.edges) ? vgraph.edges.map(normalizeEdge) : [];
  return {
    id: slug(vgraph.id || vgraph.name || 'architecture-atlas'),
    title: vgraph.title || vgraph.name || vgraph.id || 'Architecture Atlas',
    version: vgraph.version || 1,
    nodes,
    edges,
    invariants: Array.isArray(vgraph.invariants) ? vgraph.invariants : [],
    tests: Array.isArray(vgraph.tests) ? vgraph.tests : [],
    risks: Array.isArray(vgraph.risks) ? vgraph.risks : [],
    // Conditional on purpose. An unconditional `atlas: ... ?? null` would put
    // `"atlas":null` into stableJson for every existing cartridge, moving every
    // vgraphHash and flipping every already-rendered render.svg to
    // render_svg_stale at driftCartridge:348.
    ...(vgraph.atlas && typeof vgraph.atlas === 'object' && !Array.isArray(vgraph.atlas) ? { atlas: vgraph.atlas } : {})
  };
}

export function vgraphHash(vgraph: any = {}) {
  return sha256(stableJson(normalizeVGraph(vgraph)));
}

function nodeWikiCoord(node: any) {
  return normalizeWikiCoord(node?.coord || {}, `node:${node?.id || node?.label || 'node'}`);
}

function nodeClaims(graph: any) {
  return graph.nodes.map((node: any) => ({
    id: `node:${node.id}`,
    text: node.label,
    authority: 'vgraph',
    source: 'vgraph.json',
    status: node.status === 'blocked' ? 'unsupported' : 'supported',
    risk: node.risk === 'critical' ? 'critical' : (node.risk === 'high' ? 'high' : 'medium'),
    coord: nodeWikiCoord(node)
  }));
}

function nodePalette(node: any) {
  if (node.risk === 'critical' || node.status === 'blocked') return { fill: '#fee2e2', stroke: '#b91c1c', text: '#3b0a0a' };
  if (node.risk === 'high' || node.status === 'warn') return { fill: '#ffedd5', stroke: '#c2410c', text: '#431407' };
  if (node.status === 'passed' || node.status === 'safe') return { fill: '#dcfce7', stroke: '#15803d', text: '#052e16' };
  if (node.kind === 'guard' || node.kind === 'policy') return { fill: '#e0f2fe', stroke: '#0369a1', text: '#082f49' };
  return { fill: '#f8fafc', stroke: '#475569', text: '#0f172a' };
}

function layoutNodes(nodes: any) {
  if (!nodes.length) return new Map();
  const layers = [...new Set(nodes.map((node: any) => node.layer))].sort();
  const byLayer = new Map(layers.map((layer: any) => [layer, nodes.filter((node: any) => node.layer === layer).sort((a: any, b: any) => a.id.localeCompare(b.id))]));
  const positions = new Map();
  const top = 170;
  const bottom = 530;
  const left = 92;
  const right = 1188;
  const layerGap = layers.length > 1 ? (bottom - top) / (layers.length - 1) : 0;
  for (let li = 0; li < layers.length; li++) {
    const layer = layers[li];
    const row = byLayer.get(layer);
    const y = layers.length > 1 ? top + li * layerGap : 300;
    const gap = row.length > 1 ? (right - left) / (row.length - 1) : 0;
    for (let i = 0; i < row.length; i++) {
      const node = row[i];
      const x = row.length > 1 ? left + i * gap : SVG_WIDTH / 2;
      positions.set(node.id, { x, y, w: 196, h: 82, layer });
    }
  }
  return positions;
}

function renderList(items: any, x: any, y: any, title: any) {
  const lines = [`<text x="${x}" y="${y}" class="section-title">${escapeXml(title)}</text>`];
  if (!items.length) {
    lines.push(`<text x="${x}" y="${y + 34}" class="muted">No entries</text>`);
    return lines.join('\n');
  }
  for (let i = 0; i < Math.min(items.length, 5); i++) {
    const item = items[i];
    const label = typeof item === 'string' ? item : (item.label || item.id || item.title || JSON.stringify(item));
    lines.push(`<text x="${x}" y="${y + 34 + i * 28}" class="list-item">- ${escapeXml(shortText(label, 72))}</text>`);
  }
  if (items.length > 5) lines.push(`<text x="${x}" y="${y + 34 + 5 * 28}" class="muted">+ ${items.length - 5} more</text>`);
  return lines.join('\n');
}

export function renderVGraphSvg(vgraph: any = {}, beta: any = {}) {
  const graph = normalizeVGraph(vgraph);
  const hash = vgraphHash(graph);
  const positions = layoutNodes(graph.nodes);
  const layers = [...new Set(graph.nodes.map((node: any) => node.layer))].sort();
  const generatedAt = nowIso();
  const edgeLines = graph.edges.map((edge: any) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) return '';
    const x1 = from.x;
    const y1 = from.y + from.h / 2;
    const x2 = to.x;
    const y2 = to.y - to.h / 2;
    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;
    return `<g class="edge">
      <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#arrow)"/>
      ${edge.label ? `<text x="${midX}" y="${midY - 8}" class="edge-label">${escapeXml(shortText(edge.label, 28))}</text>` : ''}
    </g>`;
  }).join('\n');
  const layerBands = layers.map((layer: any, index: any) => {
    const y = layers.length > 1 ? 132 + index * (398 / Math.max(1, layers.length - 1)) : 250;
    return `<text x="40" y="${y}" class="layer-label">${escapeXml(layer)}</text>`;
  }).join('\n');
  const nodeCards = graph.nodes.map((node: any) => {
    const pos = positions.get(node.id);
    const palette = nodePalette(node);
    const labelLines = splitLabel(node.label);
    const tag = `${node.kind} / ${node.status}`;
    const wikiCoord = nodeWikiCoord(node);
    return `<g class="node" data-wiki-rgba="${rgbaKey(wikiCoord.rgba)}" data-wiki-coord="${wikiCoord.domainAngle},${wikiCoord.layerRadius},${wikiCoord.phase},${wikiCoord.concentration}" transform="translate(${pos.x - pos.w / 2} ${pos.y - pos.h / 2})">
      <rect width="${pos.w}" height="${pos.h}" rx="14" fill="${palette.fill}" stroke="${palette.stroke}" stroke-width="3"/>
      <text x="18" y="27" class="node-title" fill="${palette.text}">${escapeXml(labelLines[0])}</text>
      ${labelLines.slice(1).map((line: any, i: any) => `<text x="18" y="${49 + i * 18}" class="node-title small" fill="${palette.text}">${escapeXml(line)}</text>`).join('\n')}
      <text x="18" y="${pos.h - 14}" class="node-meta" fill="${palette.text}">${escapeXml(shortText(tag, 34))}</text>
    </g>`;
  }).join('\n');
  const wikiStrip = graph.nodes.slice(0, 24).map((node: any, index: any) => {
    const coord = nodeWikiCoord(node);
    const x = 1010 + (index % 12) * 18;
    const y = 36 + Math.floor(index / 12) * 18;
    return `<rect x="${x}" y="${y}" width="14" height="14" rx="2" fill="rgb(${coord.rgba.r},${coord.rgba.g},${coord.rgba.b})" fill-opacity="${(coord.rgba.a / 255).toFixed(3)}" data-node="${escapeXml(node.id)}" data-rgba="${rgbaKey(coord.rgba)}"/>`;
  }).join('\n');
  const emptyState = graph.nodes.length ? '' : `<g class="empty">
    <rect x="332" y="214" width="616" height="178" rx="18"/>
    <text x="640" y="291" text-anchor="middle" class="empty-title">No graph nodes defined</text>
    <text x="640" y="329" text-anchor="middle" class="muted">Edit vgraph.json, then run sks gx render ${escapeXml(graph.id)}</text>
  </g>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_WIDTH}" height="${SVG_HEIGHT}" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}" role="img" aria-labelledby="title desc" data-generator="sneakoscope-codex" data-vgraph-id="${escapeXml(graph.id)}" data-vgraph-hash="${hash}" data-generated-at="${generatedAt}">
  <title id="title">${escapeXml(graph.title)}</title>
  <desc id="desc">Deterministic visual context sheet generated from vgraph.json.</desc>
  <defs>
    <marker id="arrow" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="strokeWidth">
      <path d="M2,2 L10,6 L2,10 Z" fill="#475569"/>
    </marker>
    <style>
      .title { font: 800 38px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #111827; }
      .subtitle, .muted { font: 500 18px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #64748b; }
      .section-title { font: 800 24px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #111827; }
      .list-item { font: 500 18px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #334155; }
      .layer-label { font: 800 17px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #94a3b8; text-transform: uppercase; }
      .node-title { font: 800 17px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .node-title.small { font-size: 15px; font-weight: 700; }
      .node-meta { font: 700 12px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; opacity: .72; text-transform: uppercase; }
      .edge line { stroke: #475569; stroke-width: 2.5; }
      .edge-label { font: 700 13px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #475569; paint-order: stroke; stroke: #f8fafc; stroke-width: 5px; }
      .empty rect { fill: #f8fafc; stroke: #cbd5e1; stroke-width: 2; }
      .empty-title { font: 800 26px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #334155; }
    </style>
  </defs>
  <rect width="${SVG_WIDTH}" height="${SVG_HEIGHT}" fill="#ffffff"/>
  <rect x="0" y="0" width="${SVG_WIDTH}" height="108" fill="#f8fafc"/>
  <text x="42" y="56" class="title">${escapeXml(graph.title)}</text>
  <text x="42" y="86" class="subtitle">vgraph:${escapeXml(graph.id)} hash:${hash.slice(0, 12)} nodes:${graph.nodes.length} edges:${graph.edges.length} generated:${generatedAt}</text>
  <g aria-label="RGBA wiki coordinate atlas">${wikiStrip}</g>
  ${layerBands}
  ${edgeLines}
  ${nodeCards}
  ${emptyState}
  <line x1="42" y1="590" x2="1238" y2="590" stroke="#e2e8f0" stroke-width="2"/>
  ${renderList(graph.invariants, 52, 638, 'Invariants')}
  ${renderList(graph.tests, 690, 638, 'Tests')}
  <text x="52" y="784" class="muted">Source: vgraph.json. Layout/read-order: ${escapeXml(beta?.id || graph.id)}. Renderer: Sneakoscope Codex deterministic GX.</text>
</svg>
`;
}

export function renderVGraphHtml(vgraph: any = {}, beta: any = {}, svg: any = renderVGraphSvg(vgraph, beta)) {
  const graph = normalizeVGraph(vgraph);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeXml(graph.title)} - Sneakoscope Codex</title>
  <style>
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f1f5f9; color: #0f172a; }
    main { max-width: 1320px; margin: 0 auto; padding: 24px; }
    .sheet { background: white; border: 1px solid #cbd5e1; overflow: auto; }
    svg { display: block; width: 100%; height: auto; }
    pre { padding: 16px; background: #0f172a; color: #e2e8f0; overflow: auto; }
  </style>
</head>
<body>
  <main>
    <div class="sheet">${svg.replace(/^<\?xml[^>]*>\s*/, '')}</div>
    <h2>Context Packet</h2>
    <pre>${escapeXml(JSON.stringify({ vgraph: normalizeVGraph(vgraph), beta }, null, 2))}</pre>
  </main>
</body>
</html>
`;
}

export function validateVGraph(vgraph: any = {}, beta: any = {}) {
  const graph = normalizeVGraph(vgraph);
  const issues: any[] = [];
  const warnings: any[] = [];
  const ids = new Set();
  if (!graph.id) issues.push({ id: 'missing_graph_id', severity: 'error', reason: 'vgraph.id is required.' });
  for (const node of graph.nodes) {
    if (ids.has(node.id)) issues.push({ id: 'duplicate_node_id', severity: 'error', node: node.id, reason: 'Node ids must be unique.' });
    ids.add(node.id);
    if (!node.label) warnings.push({ id: 'missing_node_label', severity: 'warning', node: node.id, reason: 'Node has no label.' });
  }
  for (const edge of graph.edges) {
    if (!ids.has(edge.from)) issues.push({ id: 'missing_edge_source', severity: 'error', edge: edge.id, from: edge.from });
    if (!ids.has(edge.to)) issues.push({ id: 'missing_edge_target', severity: 'error', edge: edge.id, to: edge.to });
  }
  if (beta?.read_order && !Array.isArray(beta.read_order)) issues.push({ id: 'invalid_read_order', severity: 'error', reason: 'beta.read_order must be an array when present.' });
  if (!graph.nodes.length) warnings.push({ id: 'empty_graph', severity: 'warning', reason: 'vgraph contains no nodes.' });
  return {
    checked_at: nowIso(),
    ok: issues.length === 0,
    graph_id: graph.id,
    source_hash: vgraphHash(graph),
    counts: { nodes: graph.nodes.length, edges: graph.edges.length, invariants: graph.invariants.length, tests: graph.tests.length },
    wiki_coordinates: buildWikiCoordinateIndex({
      mission: { id: graph.id, coord: beta?.mission_coord || {} },
      claims: nodeClaims(graph),
      q4: { vgraph_hash: vgraphHash(graph) },
      q3: ['gx', 'vgraph', 'wiki-coordinate'],
      maxAnchors: Math.min(32, graph.nodes.length)
    }),
    issues,
    warnings
  };
}

function extractRenderHash(text: any = '') {
  const match = String(text).match(/\bdata-vgraph-hash="([^"]+)"/);
  return match ? match[1] : null;
}

export async function renderCartridge(dir: any, { format = 'all' }: any = {}) {
  const vgraph = await readJson(path.join(dir, 'vgraph.json'));
  const beta = await readJson(path.join(dir, 'beta.json'), {});
  const svg = renderVGraphSvg(vgraph, beta);
  const outputs: any[] = [];
  if (format === 'all' || format === 'svg') {
    await writeTextAtomic(path.join(dir, 'render.svg'), svg);
    outputs.push('render.svg');
  }
  if (format === 'all' || format === 'html') {
    await writeTextAtomic(path.join(dir, 'render.html'), renderVGraphHtml(vgraph, beta, svg));
    outputs.push('render.html');
  }
  if (!outputs.length) throw new Error('Unsupported GX render format. Use svg, html, or all.');
  return { graph_id: normalizeVGraph(vgraph).id, source_hash: vgraphHash(vgraph), outputs };
}

export async function validateCartridge(dir: any) {
  const vgraph = await readJson(path.join(dir, 'vgraph.json'));
  const beta = await readJson(path.join(dir, 'beta.json'), {});
  const validation = validateVGraph(vgraph, beta);
  await writeJsonAtomic(path.join(dir, 'validation.json'), validation);
  return validation;
}

export async function driftCartridge(dir: any) {
  const vgraph = await readJson(path.join(dir, 'vgraph.json'));
  const sourceHash = vgraphHash(vgraph);
  const renderPath = path.join(dir, 'render.svg');
  const renderText = await readText(renderPath, '');
  const renderHash = renderText ? extractRenderHash(renderText) : null;
  const validation = validateVGraph(vgraph, await readJson(path.join(dir, 'beta.json'), {}));
  const reasons: any[] = [];
  if (!renderText) reasons.push('render_svg_missing');
  if (renderText && !renderHash) reasons.push('render_svg_missing_vgraph_hash');
  if (renderHash && renderHash !== sourceHash) reasons.push('render_svg_stale');
  for (const issue of validation.issues) reasons.push(`validation:${issue.id}`);
  const drift = {
    checked_at: nowIso(),
    status: reasons.length ? 'high' : 'low',
    source_hash: sourceHash,
    render_hash: renderHash,
    reasons,
    validation
  };
  await writeJsonAtomic(path.join(dir, 'drift.json'), drift);
  return drift;
}

export async function snapshotCartridge(dir: any) {
  const vgraph = await readJson(path.join(dir, 'vgraph.json'));
  const beta = await readJson(path.join(dir, 'beta.json'), {});
  const validation = await validateCartridge(dir);
  const drift = await driftCartridge(dir);
  const snapshot = {
    created_at: nowIso(),
    graph_id: normalizeVGraph(vgraph).id,
    source_hash: vgraphHash(vgraph),
    files: {
      vgraph: 'vgraph.json',
      beta: 'beta.json',
      svg: await exists(path.join(dir, 'render.svg')) ? 'render.svg' : null,
      html: await exists(path.join(dir, 'render.html')) ? 'render.html' : null
    },
    validation,
    drift,
    wiki_coordinates: buildWikiCoordinateIndex({
      mission: { id: normalizeVGraph(vgraph).id, coord: beta?.mission_coord || {} },
      claims: nodeClaims(normalizeVGraph(vgraph)),
      q4: { vgraph_hash: vgraphHash(vgraph) },
      q3: ['gx', 'vgraph', 'wiki-coordinate'],
      maxAnchors: 32
    }),
    vgraph: normalizeVGraph(vgraph),
    beta
  };
  await writeJsonAtomic(path.join(dir, 'snapshot.json'), snapshot);
  return snapshot;
}
