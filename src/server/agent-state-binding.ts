/** Canonical private bindings: JSON object key order is not execution identity.
 * Only validated/trusted JSON-compatible data may enter this helper. */
export function canonicalAgentJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalAgentJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalAgentJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
