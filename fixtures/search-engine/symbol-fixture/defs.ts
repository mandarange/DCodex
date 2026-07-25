export function alphaHelper(value: number): number {
  return value + 1;
}

export const alphaConstant = 42;

export function usesAlpha(input: number): number {
  return alphaHelper(input) + alphaConstant;
}
