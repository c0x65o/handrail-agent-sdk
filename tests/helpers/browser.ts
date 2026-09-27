import { fork } from 'node:child_process';
import { access, chmod, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// This is the only observation surface. The child has no inherited stdout,
// stderr, inspector, NODE_OPTIONS, DEBUG, proxy credentials or provider env.
export const browserCases = ['B01_ISOLATION', 'B02_PARTIAL_BROWSER', 'B03_PARTIAL_CONTEXT', 'B04_TEST_FAILURE'] as const;
export const boundaryCases = ['F01_NETWORK_POLICY', 'F02_PARTIAL_LISTENER', 'F03_OUTPUT_GATE'] as const;
export type BrowserCase = typeof browserCases[number] | typeof boundaryCases[number];
const statuses = ['passed', 'failed', 'unverified_browser_prerequisite', 'unverified_dependency_prerequisite'] as const;
export interface BrowserReceipt {
  caseId: BrowserCase;
  status: typeof statuses[number];
  checks: number;
  contextsClosed: number;
  browsersClosed: number;
  listenersClosed: number;
  artifactsRemoved: number;
}

/** Trusted tests only. Never returns a browser, URL, profile, DOM or raw error. */
export async function runPrivateBrowserCase(caseId: BrowserCase): Promise<BrowserReceipt> {
  if (![...browserCases, ...boundaryCases].includes(caseId)) throw new Error('BROWSER_CASE_INVALID');
  const result: BrowserReceipt = {
    caseId, status: 'failed', checks: 0, contextsClosed: 0,
    browsersClosed: 0, listenersClosed: 0, artifactsRemoved: 0,
  };
  if (process.platform !== 'linux') return result;
  let root: string | undefined;
  try {
    root = await mkdtemp(join(tmpdir(), 'sdk-private-browser-'));
    await chmod(root, 0o700);
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root,
      XDG_CACHE_HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root,
      // Explicit host-selected, preinstalled executable/cache only. No installs.
      ...(process.env.HANDRAIL_TEST_BROWSER_EXECUTABLE ? {
        HANDRAIL_TEST_BROWSER_EXECUTABLE: process.env.HANDRAIL_TEST_BROWSER_EXECUTABLE,
      } : {}),
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache/ms-playwright'),
    };
    await new Promise<void>(resolve => {
      const child = fork(new URL('./browser-private.js', import.meta.url), [caseId, root!], {
        env, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], detached: true,
      });
      let receipt: Record<string, unknown> | undefined;
      let browserPid: number | undefined;
      let forced = false;
      const kill = () => {
        forced = true;
        // Playwright starts Chromium in its own process group on Linux.
        if (browserPid) { try { process.kill(-browserPid, 'SIGKILL'); } catch {} }
        if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      };
      const timer = setTimeout(kill, 60_000);
      child.on('message', message => {
        if (!message || typeof message !== 'object') return;
        const m = message as Record<string, unknown>;
        if (m.kind === 'browser_pid' && Number.isSafeInteger(m.pid) && (m.pid as number) > 1) {
          browserPid = m.pid as number;
        } else if (m.kind === 'receipt') receipt = m;
      });
      child.on('error', kill);
      child.once('close', async code => {
        clearTimeout(timer);
        // No child content, arbitrary fields, error strings or labels cross here.
        if (code === 0 && !forced && receipt && statuses.includes(receipt.status as typeof statuses[number])) {
          result.status = receipt.status as typeof statuses[number];
          for (const key of ['checks', 'contextsClosed', 'browsersClosed', 'listenersClosed'] as const) {
            const value = receipt[key];
            if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 100) {
              result.status = 'failed'; break;
            }
            result[key] = value as number;
          }
        } else kill();
        // Independently check the browser group even if child cleanup failed.
        // A surviving group must never turn into a successful receipt.
        if (browserPid) {
          for (let attempt = 0; attempt < 50; attempt++) {
            try { process.kill(-browserPid, 0); }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ESRCH') result.status = 'failed';
              break;
            }
            result.status = 'failed';
            result.browsersClosed = 0;
            try { process.kill(-browserPid, 'SIGKILL'); } catch {}
            await delay(20);
          }
        }
        resolve();
      });
    });
  } catch { result.status = 'failed'; }
  finally {
    if (root) {
      try {
        await rm(root, { recursive: true, force: true });
        try { await access(root); result.status = 'failed'; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') result.artifactsRemoved = 1;
          else result.status = 'failed';
        }
      } catch { result.status = 'failed'; }
    }
  }
  return Object.freeze(result);
}
