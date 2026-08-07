/**
 * The Codex SDK publishes one type-only import from its development-only MCP
 * v1 package. SKS does not install or execute that package; bind the leaked
 * ContentBlock type to the current MCP v2 client package until the vendor
 * removes the declaration leak.
 */
declare module '@modelcontextprotocol/sdk/types.js' {
  export type ContentBlock = import('@modelcontextprotocol/client').ContentBlock;
}
