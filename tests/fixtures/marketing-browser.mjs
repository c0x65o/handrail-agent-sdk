import assert from 'node:assert/strict';
import { build } from 'esbuild';

for (const specifier of ['handrail-agent-sdk', 'handrail-agent-sdk/marketing', '@handrail/marketing/core', '@handrail/marketing/react']) {
  const result = await build({ stdin: { contents: `import * as sdk from '${specifier}'; console.log(sdk);`, resolveDir: process.cwd() },
    bundle: true, platform: 'browser', write: false, metafile: true, logLevel: 'silent' });
  for (const input of Object.keys(result.metafile.inputs))
    assert.doesNotMatch(input, /(?:\/server\/|\/reference\/|\bpg\b|sharp|openai|node:)/);
}
for (const [contents, reason] of [["import 'handrail-agent-sdk/server/marketing';", /explicitly disabled by the package author/],
  ["import '@handrail/marketing/server';", /is built into node/],
  ["import { marketingAgentPort, marketingExtension } from './out/marketing-onboarding.mjs'; console.log(marketingAgentPort, marketingExtension);",
    /explicitly disabled by the package author/]]) {
  await assert.rejects(build({ stdin: { contents, resolveDir: process.cwd() }, bundle: true,
    platform: 'browser', write: false, logLevel: 'silent' }), error => {
    assert.match(JSON.stringify(error.errors), reason);
    return true;
  });
}
console.log('4 isolated browser graphs passed; both server imports and the example were rejected.');
