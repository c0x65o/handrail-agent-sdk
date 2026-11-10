import { Ajv } from 'ajv';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { serialize } from 'node:v8';

/** JSON Schema is the model contract; parse is the server validation boundary.
 * Unlike strict Structured Outputs, this representation preserves absence and
 * explicit null independently. It never inserts defaults or coerces values. */
export interface AgentJsonSchemaParameters {
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  parse(input: unknown): Record<string, unknown>;
}

// Agent instances bind their own execution and authority callbacks. Only the
// immutable schema/validator is reusable across equivalent catalog discoveries.
// Weak entries release unused schemas instead of retaining every tenant catalog.
const parametersCache = new Map<string, WeakRef<AgentJsonSchemaParameters>>();
const parametersCleanup = new FinalizationRegistry<{ key: string; ref: WeakRef<AgentJsonSchemaParameters> }>(({ key, ref }) => {
  if (parametersCache.get(key) === ref) parametersCache.delete(key);
});

function freeze(value: unknown): void {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
}

export function applicationToolParameters(schema: Readonly<Record<string, unknown>>): AgentJsonSchemaParameters {
  const jsonSchema = structuredClone(schema);
  if (jsonSchema.type !== 'object') throw Error('agent_tool_requires_object_schema');
  // Serialize the cloned value, not caller-controlled toJSON output. Unlike
  // JSON.stringify this also distinguishes unsupported/non-JSON schema values.
  const key = serialize(jsonSchema).toString('base64');
  const cached = parametersCache.get(key)?.deref();
  if (cached) return cached;
  // A validator per definition isolates $id namespaces between independent
  // application tools. No remote reference loading or custom executable keywords.
  const dialect = jsonSchema.$schema;
  const Validator = dialect === 'http://json-schema.org/draft-07/schema#' ? Ajv
    : dialect === 'https://json-schema.org/draft/2019-09/schema' ? Ajv2019
    : dialect === undefined || dialect === 'https://json-schema.org/draft/2020-12/schema' ? Ajv2020
    : null;
  if (!Validator) throw Error('agent_tool_schema_dialect_unsupported');
  const validator = new Validator({ strictSchema: true, strictTypes: false, strictTuples: false,
    strictRequired: false, strictNumbers: true, validateFormats: true, ownProperties: true,
    coerceTypes: false, useDefaults: false, removeAdditional: false });
  // CJS plugin's callable default is exposed as .default under NodeNext types.
  addFormats.default(validator);
  const validate = validator.compile(jsonSchema);
  if ('$async' in validate && validate.$async) throw Error('agent_tool_async_schema_unsupported');
  freeze(jsonSchema);
  const parameters = Object.freeze({ jsonSchema, parse(input: unknown): Record<string, unknown> {
    if (input === null || typeof input !== 'object' || Array.isArray(input) || !validate(input))
      throw Error('agent_tool_arguments_invalid');
    return input as Record<string, unknown>;
  } });
  const ref = new WeakRef(parameters);
  parametersCache.set(key, ref);
  parametersCleanup.register(parameters, { key, ref });
  return parameters;
}
