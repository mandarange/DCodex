import type { JsonSchemaIssue, JsonSchemaValidation } from './types.js';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function issue(path: string, code: string, message: string): JsonSchemaIssue {
  return { path, code, message };
}

function matchesType(value: unknown, type: string): boolean {
  if (type === 'object') return isObject(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'null') return value === null;
  return typeof value === type;
}

function validateNode(value: unknown, schema: JsonObject, path: string, issues: JsonSchemaIssue[]): unknown {
  if ('const' in schema && !Object.is(schema.const, value)) {
    issues.push(issue(path, 'const', 'Value does not match the required constant'));
  }
  const expectedType = typeof schema.type === 'string' ? schema.type : null;
  if (expectedType && !matchesType(value, expectedType)) {
    issues.push(issue(path, 'type', `Expected ${expectedType}`));
    return value;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    issues.push(issue(path, 'enum', 'Value is not one of the allowed values'));
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      issues.push(issue(path, 'minLength', `String must contain at least ${schema.minLength} characters`));
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      issues.push(issue(path, 'maxLength', `String must contain at most ${schema.maxLength} characters`));
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
      issues.push(issue(path, 'pattern', 'String does not match the required pattern'));
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      issues.push(issue(path, 'minimum', `Number must be at least ${schema.minimum}`));
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      issues.push(issue(path, 'maximum', `Number must be at most ${schema.maximum}`));
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      issues.push(issue(path, 'minItems', `Array must contain at least ${schema.minItems} items`));
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      issues.push(issue(path, 'maxItems', `Array must contain at most ${schema.maxItems} items`));
    }
    const itemSchema = isObject(schema.items) ? schema.items : null;
    return itemSchema
      ? value.map((entry, index) => validateNode(entry, itemSchema, `${path}/${index}`, issues))
      : [...value];
  }

  if (!isObject(value)) {
    validateCompositions(value, schema, path, issues);
    return value;
  }

  const properties = isObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
  const normalized: JsonObject = {};
  for (const name of required) {
    if (!(name in value)) issues.push(issue(`${path}/${name}`, 'required', 'Required property is missing'));
  }
  for (const [name, childValue] of Object.entries(value)) {
    const childSchema = properties[name];
    if (!isObject(childSchema)) {
      if (schema.additionalProperties === false) {
        issues.push(issue(`${path}/${name}`, 'additionalProperties', 'Unknown property is not allowed'));
      } else {
        normalized[name] = childValue;
      }
      continue;
    }
    normalized[name] = validateNode(childValue, childSchema, `${path}/${name}`, issues);
  }
  validateCompositions(value, schema, path, issues);
  return normalized;
}

function validateCompositions(value: unknown, schema: JsonObject, path: string, issues: JsonSchemaIssue[]) {
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) {
      if (isObject(branch)) validateNode(value, branch, path, issues);
    }
  }
  if (Array.isArray(schema.anyOf)) {
    const matches = schema.anyOf.filter((branch) => isObject(branch) && branchMatches(value, branch, path)).length;
    if (matches === 0) issues.push(issue(path, 'anyOf', 'Value must match at least one allowed schema'));
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((branch) => isObject(branch) && branchMatches(value, branch, path)).length;
    if (matches !== 1) issues.push(issue(path, 'oneOf', 'Value must match exactly one allowed schema'));
  }
  if (isObject(schema.not) && branchMatches(value, schema.not, path)) {
    issues.push(issue(path, 'not', 'Value matches a forbidden schema'));
  }
  if (isObject(schema.if)) {
    const selected = branchMatches(value, schema.if, path) ? schema.then : schema.else;
    if (isObject(selected)) validateNode(value, selected, path, issues);
  }
}

function branchMatches(value: unknown, schema: JsonObject, path: string): boolean {
  const branchIssues: JsonSchemaIssue[] = [];
  validateNode(value, schema, path, branchIssues);
  return branchIssues.length === 0;
}

export function validateJsonSchema(input: unknown, schema: Record<string, unknown>): JsonSchemaValidation {
  const value = input === undefined || input === null ? {} : input;
  const issues: JsonSchemaIssue[] = [];
  const normalized = validateNode(value, schema, '$', issues);
  if (issues.length > 0 || !isObject(normalized)) return { ok: false, value: null, issues };
  return { ok: true, value: normalized, issues: [] };
}
