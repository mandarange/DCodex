/** OpenRouter model metadata shared by Desktop Bridge consumers. */

export const OPENROUTER_DEFAULT_MODEL = 'z-ai/glm-5.2' as const;

export function normalizeOpenRouterModelId(value: unknown): string | null {
  const model = String(value || '').trim();
  if (!model) return null;
  if (model.length > 200) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model)) return null;
  return model;
}
