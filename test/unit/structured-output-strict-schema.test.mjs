import test from 'node:test';
import assert from 'node:assert/strict';
import { strictJsonSchemaFormat } from '../../dist/core/structured-output-adapter.js';

// Every case here is a rejection the Responses API returned for
// schemas/codex/image-ux-issue-ledger.schema.json, which made structured
// callout extraction impossible: `invalid_json_schema` on the request.
test('a const-only property is given the type strict mode requires', () => {
  const { schema } = strictJsonSchemaFormat('ledger', {
    type: 'object',
    properties: { schema: { const: 'sks.image-ux-issue-ledger.v3' }, count: { type: 'integer' } }
  });
  assert.equal(schema.properties.schema.type, 'string');
  assert.equal(schema.properties.schema.const, 'sks.image-ux-issue-ledger.v3');
});

test('$ref targets in $defs get the same strict treatment as inline schemas', () => {
  const { schema } = strictJsonSchemaFormat('ledger', {
    type: 'object',
    properties: { issues: { type: 'array', items: { $ref: '#/$defs/issue' } } },
    $defs: {
      issue: {
        type: 'object',
        properties: { id: { type: 'string' }, note: { type: 'string' } },
        required: ['id']
      }
    }
  });
  // strict mode: required must list every key in properties, and no extras.
  assert.deepEqual(schema.$defs.issue.required, ['id', 'note']);
  assert.equal(schema.$defs.issue.additionalProperties, false);
});

test('a prefixItems tuple becomes a homogeneous items schema with its arity kept', () => {
  const { schema } = strictJsonSchemaFormat('ledger', {
    type: 'object',
    properties: {
      bbox: {
        type: 'array',
        prefixItems: [{ type: 'number', minimum: 0 }, { type: 'number', minimum: 0 }, { type: 'number' }, { type: 'number' }],
        minItems: 4,
        maxItems: 4
      }
    }
  });
  const bbox = schema.properties.bbox;
  assert.equal(bbox.prefixItems, undefined);
  assert.deepEqual(bbox.items, { type: 'number' });
  assert.equal(bbox.minItems, 4);
  assert.equal(bbox.maxItems, 4);
});

test('a mixed-type tuple is left alone rather than silently widened', () => {
  const { schema } = strictJsonSchemaFormat('ledger', {
    type: 'object',
    properties: {
      pair: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }], minItems: 2, maxItems: 2 }
    }
  });
  assert.deepEqual(schema.properties.pair.prefixItems, [{ type: 'string' }, { type: 'number' }]);
});
