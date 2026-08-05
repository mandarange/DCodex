import { compactMcpToolSchema } from '../mcp/mcp-tool-policy.js'

export function buildCodexCurrentCoreRichToolSchemaFixture() {
  return {
    type: 'object',
    description: 'Current Codex rich tool schema preservation fixture',
    oneOf: [
      { required: ['mode'], properties: { mode: { const: 'guided' } } },
      { required: ['query'], properties: { query: { type: 'string' } } }
    ],
    allOf: [
      { required: ['kind'] },
      { properties: { kind: { enum: ['search', 'inspect'] } } }
    ],
    required: ['kind', 'payload'],
    properties: {
      kind: { enum: ['search', 'inspect'] },
      payload: {
        type: 'object',
        required: ['target'],
        properties: {
          target: { type: 'string' },
          filters: {
            type: 'object',
            properties: {
              depth: { enum: ['shallow', 'deep'] }
            }
          }
        }
      }
    }
  }
}

export function passCodexCurrentCoreRichToolSchemaThroughBridge(schema: any = buildCodexCurrentCoreRichToolSchemaFixture()) {
  return compactMcpToolSchema(schema, 128).schema
}

export function evaluateCodexCurrentCoreRichToolSchemaPreservation(schema: any = buildCodexCurrentCoreRichToolSchemaFixture()) {
  const bridged = passCodexCurrentCoreRichToolSchemaThroughBridge(schema)
  const required = Array.isArray(bridged?.required) ? bridged.required : []
  const result = {
    schema: 'sks.codex-current-core-rich-tool-schema-preservation.v1',
    ok: Array.isArray(bridged?.oneOf)
      && Array.isArray(bridged?.allOf)
      && Boolean(bridged?.properties?.payload?.properties?.target)
      && required.includes('kind')
      && required.includes('payload'),
    top_level_oneOf_preserved: Array.isArray(bridged?.oneOf),
    top_level_allOf_preserved: Array.isArray(bridged?.allOf),
    nested_structure_preserved: Boolean(bridged?.properties?.payload?.properties?.target),
    required_fields_retained: required.includes('kind') && required.includes('payload'),
    bridged_schema: bridged
  }
  return {
    ...result,
    blockers: result.ok ? [] : ['codex_rich_tool_schema_preservation_failed']
  }
}
