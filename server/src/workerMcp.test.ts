import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jsonSchemaToZod, jsonSchemaToZodShape } from './workerMcp.ts';
import type { JsonSchemaNode } from './workerProtocol.ts';

test('every node type in the closed subset converts and parses', () => {
  const cases: [JsonSchemaNode, unknown][] = [
    [{ type: 'string' }, 'hi'],
    [{ type: 'number' }, 1.5],
    [{ type: 'integer' }, 3],
    [{ type: 'boolean' }, true],
    [{ type: 'array', items: { type: 'string' } }, ['a', 'b']],
    [{ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }, { a: 'x' }],
  ];
  for (const [node, value] of cases) {
    assert.deepEqual(jsonSchemaToZod(node).parse(value), value, JSON.stringify(node));
  }
});

test('an integer node rejects a fractional value', () => {
  assert.equal(jsonSchemaToZod({ type: 'integer' }).safeParse(1.5).success, false);
});

test('an array without items accepts any element', () => {
  assert.deepEqual(jsonSchemaToZod({ type: 'array' }).parse([1, 'a', null]), [1, 'a', null]);
});

test('an enum pins the value regardless of declared type', () => {
  const schema = jsonSchemaToZod({ type: 'string', enum: ['owned', 'shared'] });
  assert.equal(schema.parse('shared'), 'shared');
  assert.equal(schema.safeParse('all').success, false);
});

test('nested properties and items convert recursively', () => {
  const node: JsonSchemaNode = {
    type: 'object',
    required: ['steps'],
    properties: {
      steps: {
        type: 'array',
        items: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' }, version: { type: 'integer' } },
        },
      },
    },
  };
  const value = { steps: [{ name: 'Plan', version: 2 }] };
  assert.deepEqual(jsonSchemaToZod(node).parse(value), value);
});

test('only `required` properties are mandatory', () => {
  const shape = jsonSchemaToZodShape({
    type: 'object',
    required: ['a'],
    properties: { a: { type: 'string' }, b: { type: 'string' } },
  });
  assert.deepEqual(Object.keys(shape), ['a', 'b']);
  assert.equal(shape.a!.safeParse(undefined).success, false);
  assert.equal(shape.b!.safeParse(undefined).success, true);
});

test('a non-object node yields an empty shape rather than throwing', () => {
  assert.deepEqual(jsonSchemaToZodShape({ type: 'string' }), {});
});

/**
 * The converter runs at ensureSession time, where a throw kills the turn that
 * triggered it instead of surfacing a bad manifest. Degrading is the contract.
 */
test('an unrecognised node degrades to unknown and never throws', () => {
  const weird = { type: 'null', properties: { a: { type: 'tuple' } } } as unknown as JsonSchemaNode;
  const schema = jsonSchemaToZod(weird);
  assert.equal(schema.safeParse({ anything: true }).success, true);
  assert.equal(schema.safeParse(undefined).success, true);
  // And nested through a shape.
  const shape = jsonSchemaToZodShape({
    type: 'object',
    required: ['a'],
    properties: { a: { type: 'tuple' } as unknown as JsonSchemaNode },
  });
  assert.equal(shape.a!.safeParse('whatever').success, true);
});

test('descriptions ride along without changing parsing', () => {
  const schema = jsonSchemaToZod({ type: 'string', description: 'a label' });
  assert.equal(schema.description, 'a label');
  assert.equal(schema.parse('x'), 'x');
});

/**
 * The SDK reads the description off the outermost type, so an optional() wrapper
 * around a described type hides it and the model is shown a bare `{type}`. Most
 * of what a tool has to say about an argument (its default, when it applies) is
 * on an optional one.
 */
test('an optional property keeps its description on the outside', () => {
  const shape = jsonSchemaToZodShape({
    type: 'object',
    required: ['kept'],
    properties: {
      kept: { type: 'string', description: 'required one' },
      dropped: { type: 'string', description: 'optional one' },
      bare: { type: 'string' },
    },
  });
  assert.equal(shape.kept!.description, 'required one');
  assert.equal(shape.dropped!.description, 'optional one');
  assert.equal(shape.bare!.description, undefined);
  assert.equal(shape.dropped!.safeParse(undefined).success, true, 'still optional');
});
