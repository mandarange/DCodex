/**
 * Compatibility shim — prefer `./view-builder.js`.
 */
export {
  buildMermaidView,
  emptyMermaidView,
  emptyProjection,
  projectFilteredView,
  type BuildMermaidViewInput,
  type MermaidViewBuildResult,
  type ProjectionRequest,
  type ViewFilter
} from './view-builder.js';
