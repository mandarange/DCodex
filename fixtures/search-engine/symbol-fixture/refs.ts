import { alphaHelper, alphaConstant } from './defs.js';

export function callAlpha(n: number): number {
  const x = alphaHelper(n);
  return x + alphaConstant;
}

// Comment mentioning alphaHelper should only be text_candidate, never exact_reference.
