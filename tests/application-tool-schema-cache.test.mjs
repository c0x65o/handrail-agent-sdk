import test from 'node:test';
import assert from 'node:assert/strict';
import {createApplicationAgentTools} from '../dist/server/application-tools.js';

const adapt = (schema, result = 'first') => createApplicationAgentTools({
  definitions: [{name: 'lookup', description: 'Lookup', input_schema: schema}],
  isReadOnly: () => true, read: async () => result,
  bind: async () => { throw Error('unused'); }, result: async () => result,
})[0];
const schema = () => ({type: 'object', properties: {value: {type: 'string'}}, required: ['value'], additionalProperties: false});

test('equivalent discovered schemas reuse immutable validators while execution remains instance-bound', async () => {
  const first = adapt(schema(), 'first'), second = adapt(schema(), 'second');
  assert.equal(first.parameters, second.parameters);
  assert.equal(await first.execute({}, new AbortController().signal), 'first');
  assert.equal(await second.execute({}, new AbortController().signal), 'second');
  assert.deepEqual(second.parameters.parse({value: 'valid'}), {value: 'valid'});
  assert.throws(() => second.parameters.parse({value: 12}), /agent_tool_arguments_invalid/);
  assert.throws(() => { second.parameters.jsonSchema.properties.value.type = 'number'; });
});

test('a changed schema recompiles without changing the original validator or sharing its id namespace', () => {
  const source = {...schema(), $id: 'https://fixture.invalid/schema'};
  const first = adapt(source);
  source.properties.value.type = 'number';
  const second = adapt(source);
  assert.notEqual(first.parameters, second.parameters);
  assert.deepEqual(first.parameters.parse({value: 'original'}), {value: 'original'});
  assert.throws(() => first.parameters.parse({value: 12}), /agent_tool_arguments_invalid/);
  assert.deepEqual(second.parameters.parse({value: 12}), {value: 12});
  assert.throws(() => second.parameters.parse({value: 'original'}), /agent_tool_arguments_invalid/);
});

test('cached schemas do not hide unsupported semantics or caller-controlled serialization', () => {
  adapt(schema());
  for (const invalid of [
    {...schema(), madeUpValidation: true},
    {...schema(), $async: true},
    {...schema(), $schema: 'https://fixture.invalid/unsupported'},
    {...schema(), toJSON: () => schema()},
  ]) assert.throws(() => adapt(invalid));
});
