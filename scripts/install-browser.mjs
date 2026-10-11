import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// Runs in normal Git-dependency prepare. Server images may provide their own
// pinned Chromium and opt out; no download or process launch occurs on import.
if (process.env.HANDRAIL_AGENT_SKIP_BROWSER_INSTALL !== '1') {
  const require = createRequire(import.meta.url);
  const cli = join(dirname(require.resolve('playwright-core/package.json')), 'cli.js');
  const result = spawnSync(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('SDK_BROWSER_INSTALL_FAILED: install Chromium in the build image, or explicitly provide an executable and set HANDRAIL_AGENT_SKIP_BROWSER_INSTALL=1.');
    process.exitCode = 1;
  }
}
