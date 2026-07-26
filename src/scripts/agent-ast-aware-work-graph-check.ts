#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { assertGate, emitGate, importDist, root, readJson } from './gate-lib.js';

const inventoryMod = await importDist('core/agents/work-partition/repo-inventory.js');
const depsMod = await importDist('core/agents/work-partition/dependency-graph.js');
const graphMod = await importDist('core/agents/intelligent-work-graph.js');
const inventory = await inventoryMod.collectRepoInventory(root, { maxFiles: 2000 });
const dependencyGraph = depsMod.buildDependencyGraph(inventory);
const graph = await graphMod.buildIntelligentWorkGraph({ root, inventory, dependencyGraph, route: '$Naruto', prompt: '6.3.0 AST-aware work graph release gate' });
const releaseVersion = readJson('package.json').version;

assertGate(graph.schema === 'sks.intelligent-work-graph.v2', 'intelligent work graph schema must be v2', graph);
assertGate(graph.ast_coverage > 0, 'AST-aware work graph must record AST coverage', graph);
assertGate(Object.keys(graph.file_to_symbols).length > 0, 'AST-aware work graph must build file-to-symbol map', graph);
assertGate(Object.keys(graph.symbol_to_files).length > 0, 'AST-aware work graph must build symbol-to-file map', graph);
assertGate(Object.keys(graph.exported_symbols).length > 0, 'AST-aware work graph must build exported symbol map', graph);
assertGate(Object.keys(graph.imported_symbols).length > 0, 'AST-aware work graph must build imported symbol map', graph);
assertGate(Object.keys(graph.command_to_module_ownership).length > 0, 'AST-aware work graph must build command ownership map', graph);
assertGate(graph.test_ownership_confidence >= 0, 'AST-aware work graph must record test ownership confidence', graph);
assertGate(['proven', 'partial', 'blocked'].includes(graph.proof_level), 'AST-aware work graph must report an honest proof level', graph);
fs.mkdirSync(path.join(root, '.sneakoscope', 'reports'), { recursive: true });
fs.writeFileSync(path.join(root, '.sneakoscope', 'reports', `agent-intelligent-work-graph-v2-${releaseVersion}.json`), `${JSON.stringify(graphMod.compactIntelligentWorkGraph(graph), null, 2)}\n`);
emitGate('agent:ast-aware-work-graph', { score: graph.work_graph_quality_score, ast_coverage: graph.ast_coverage, proof_level: graph.proof_level });
