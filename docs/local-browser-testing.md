# Private browser fixture procedure

This test-only Linux harness exercises synthetic local fixtures. It does not
implement or qualify an SDK browser adapter, persistent profiles, vault grants,
provider login, takeover, or observation filtering. Host-owned authorization in
`src/server/browser-policy.ts` remains unchanged. Independent native dev QA is
pending; worker success alone must not settle checklist item
`9a6a2d4d-4c5e-494e-ae1e-cbbb4c6bd17a`.

## Prerequisites and safe launch

Use the isolated SDK lane and an already authorized Linux Chromium installation.
Node 22+ and the locked development dependencies are required. Normal dependency
setup is `npm ci --include=dev`; `playwright-core` does not install browsers. Never
run a browser install/download from a read-only validation runner. The browser
must be supplied by the host before that runner starts.

From the repository root:

```sh
npm run test:browser-boundary
HANDRAIL_TEST_BROWSER_EXECUTABLE=/absolute/path/to/authorized/chromium npm run test:browser
```

Alternatively, set `PLAYWRIGHT_BROWSERS_PATH` to an existing Playwright cache.
Without either setting, the Linux default `~/.cache/ms-playwright` is checked.
`HANDRAIL_TEST_BROWSER_EXECUTABLE` takes precedence. No executable discovery
launches a browser installer. A missing/unlaunchable browser returns
`unverified_browser_prerequisite`; a missing automation dependency returns
`unverified_dependency_prerequisite` (or the compile step fails before running).
These are failed, unverified tests, never successful skips. A launch failure can
also indicate missing system libraries or unsupported sandbox/runtime settings;
do not expose the underlying browser error to investigate it.

`npm run build:test-browser` separately typechecks/compiles the helpers into
ignored `.browser-build/`. `tests/helpers/browser.ts` is the safe entrypoint;
`tests/helpers/browser-private.ts` runs only in its private subprocess.
`tests/fixtures/protected-page.html` is the minimal page and frame fixture.
The fixture servers bind ephemeral ports on `127.0.0.1`, remain private, and stop
with each case. No persistent preview service, published URL or manual login is
needed. Run through these commands, never by importing the private entrypoint,
attaching developer tools, exposing a port, or opening the page in a shared
browser profile. `npm test` remains the existing non-browser suite; browser
verification is explicitly `npm run test:browser`.

## Cases and output boundary

Both commands use Node's test runner with `--test-concurrency=1` and
`--test-reporter=tap`. Each case produces only its fixed ID, fixed status and
counts, plus one fixed diagnostic stage. Assertions operate only on those receipts. Browser objects, temporary
paths, URLs, cookies, storage and page text never cross the private subprocess
boundary. Child stdout/stderr are discarded, IPC fields are allowlisted, and
inherited debug/inspector options, credentials and proxy settings are excluded.
Do not add screenshots, video, traces, HAR, DOM/console dumps, raw errors, or
Playwright debug logging, even on failure. Synthetic values are generated inside
the private subprocess, compared there, and never written into source/evidence.

| ID | Required result |
| --- | --- |
| B01_ISOLATION | Two distinct browser contexts; initially empty and subsequently distinct cookies, local/session storage and IndexedDB; reflections in fields, text, attributes, canvas and an HTTP response checked privately; alternate-origin frame loads and has separate origin storage; permitted redirect succeeds; denied redirect, browser-eligible direct destinations (including wrong loopback port 80 and an external hostname) and frame requests increment the destination-specific private proxy denial count; unsafe port 1 separately requires Chromium’s exact unsafe-port failure and no proxy denial increment. |
| B02_PARTIAL_BROWSER | Injected failure after browser startup cleans its process group, browser transport listener and all three HTTP listeners; no contexts were created. |
| B03_PARTIAL_CONTEXT | Injected failure after first context creation closes that context, browser and listeners. |
| B04_TEST_FAILURE | Injected canary-bearing exception after two contexts have stored/reflected values closes both contexts, browser and listeners without exposing the exception. |
| F01_NETWORK_POLICY | Browser-independent transport test allows exactly the two generated fixture origins, serves redirects, denies external hostname, HTTPS, wrong ports 1 and 80, host alias and URL credentials before opening an upstream connection. |
| F02_PARTIAL_LISTENER | Browser-independent injected setup failure removes the first owned listener and temporary artifacts. |
| F03_OUTPUT_GATE | Browser-independent canaries written to discarded child stdout/stderr and thrown in an exception never appear in the returned receipt. |

F cases are infrastructure evidence, **not real-browser isolation proof**.
Cookies are scoped to hosts rather than ports; the two loopback ports test
cross-origin frames/storage, while the two contexts test cookie isolation.
A navigation error alone is never proxy-denial evidence. Browser-eligible wrong-port
and hostname requests must reach the same proxy deny branch. Chromium can reject
unsafe port 1 before that branch: B01 privately checks the exact
`net::ERR_UNSAFE_PORT` request failure and an unchanged destination counter; F01
also sends port 1 directly through the proxy and requires HTTP 403. The raw
browser failure stays inside the private subprocess. Neither check widens the
allowlist. Redirect and denied-frame checks still require proxy counter increments.

The HTTP proxy validates every destination before connecting, including every
redirect hop (Playwright route interception alone does not guarantee that).
Only GET to the exact two loopback origins is forwarded; CONNECT, upgrades and
WebSockets are denied. Chromium background networking, DNS outside loopback,
QUIC and non-proxied WebRTC are disabled. This is a bounded trusted fixture
runner, not an OS sandbox qualification for arbitrary hostile browser code.
The local HTTP exception applies only to these fixtures; SDK production
contracts still require approved HTTPS origins and host authority.

## Teardown and independent receipt

Each run creates one owned mode-0700 temporary directory beneath the runner's
`TMPDIR` (or OS temp directory). Browser home, cache, profile/temp and artifact
paths are confined there; recordings/download acceptance are disabled.
On normal completion, missing prerequisites, partial setup or injected test
failure, the child closes contexts, the browser/process group and HTTP sockets
and listeners. The supervisor removes only that owned directory, verifies its
absence and returns `artifactsRemoved: 1`. Successful browser cases require
`browsersClosed: 1`, `listenersClosed: 3`, and the case-specific context count.
The subprocess deadline is 60 seconds; an overrun fails and kills the known
owned process groups. Abrupt termination of the supervisor itself requires the
host runner's process/artifact janitor; it cannot produce a passing receipt.
Never inspect or retain leftover private profile contents as evidence.

A subsequent independent native dev local-fixture QA campaign should run the
same commands against the exact candidate fingerprint, with an authorized
installed browser. Record base HEAD, uncommitted candidate fingerprint (or exact
later commit plus matching contents), Node/Playwright/browser identity, command,
exit status, TAP totals, safe per-case counts and campaign ID. Require all four
B cases plus all three F cases to pass, zero skips, and cleanup counts to match.
Do not substitute mocked DOM tests, worker completion or non-browser tests.
Do not launch provider workflows, deploy, publish or change live configuration.

The historical initial worker receipt is `docs/evidence/browser-fixtures.json`;
retain it unchanged. The denial repair receipt is
`docs/evidence/browser-fixtures-denial-repair.json`. Its candidate
fingerprint is SHA-256 of canonical JSON with sorted keys and compact separators
containing `base_head` and `files` (a map of scoped candidate paths to file SHA-256).
The repair receipt hashes the complete scoped input set, including inherited
package scripts and compiler options. It does not claim unrelated dirty files
were verified. Those files plus the base define the scoped source candidate. The receipt
itself is excluded to avoid self-reference; no canary or generated artifact is
part of the fingerprint. To verify it without reading private artifacts:

```sh
python3 - <<'PY'
import hashlib, json, pathlib, subprocess
receipt = json.loads(pathlib.Path('docs/evidence/browser-fixtures-denial-repair.json').read_text())
source = receipt['candidate']
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip() == source['base_head']
for name, expected in source['files'].items():
    assert hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest() == expected, name
payload = {key: source[key] for key in ('base_head', 'files')}
assert hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(',', ':')).encode()).hexdigest() == source['sha256']
print('BROWSER_CANDIDATE_FINGERPRINT_VERIFIED')
PY
```

Resume native independent **same-item** dev QA on Change Lane
`convergence-loop-9689ef5f-b976-42ca-97a7-278658db473e`, using
`source_qa_campaign_id=957efda0-6e3c-4081-837e-3ddbac55e732`,
`use_mobile_app=false` and
`local_fixture={repo_id:'e22dd818-166e-4646-b83f-423861de18a6',fixture_path:'tests/fixtures/protected-page.html',procedure_path:'tests/helpers/browser.ts'}`.
Follow this procedure for launch and privacy requirements. Preserve the original
implementation WR `8737bc1f-720e-4b24-bcc9-7b8099a9940d` and zero-run validation
WR `873a8260-1587-462c-9584-aba546c29d6b`; neither is fresh passing acceptance.
Require fresh source attribution, actual browser execution and structured
passing acceptance before settling the item.

## B01 diagnostic continuation

The safe receipt's `stage` is an exact member of `browserDiagnosticStages` in
`tests/helpers/browser.ts`. It identifies the last operation entered, not a raw
error or a confirmed root cause. B01 distinguishes `protected_reload`,
`denied_frame_load` and `denied_frame_assertion`; the earlier context, reflection,
redirect, destination-denial and unsafe-port steps also have fixed labels.
Successful teardown preserves that operation label. Failed teardown reports
`cleanup`; supervisor timeouts retain only the last allowlisted stage and remain
failed. Successful B01 must report `complete`. Expected injected failures retain
their injection stage. The stage adds no browser assertion or acceptance credit.

F03 exercises every allowed label and rejects generated canary strings, label
suffixes and non-string values without coercion. It also sends a tainted IPC
stage with arbitrary fields; the supervisor filters them. Boundary tests check
the exact returned receipt keys and expected stages. No stage may contain a
destination, page value, exception, stack, or dynamically constructed label.

Submit this diagnostic candidate through a separately admitted native read-only
validation request for the **same item**, using `handrail_run_read_only_tests`
with `profile=sdk`. An implementation request must not invoke that tool under
the wrong request kind. Inspect then run the exact returned candidate hash in
the disposable executor. Verify the installed executable and Node, TypeScript,
Playwright and Chromium versions **inside that executor**, without downloads or
filesystem-permission changes. Keep only safe receipts and TAP output. Run:

```sh
npm run build:test-browser
npm run test:browser-boundary
HANDRAIL_TEST_BROWSER_EXECUTABLE=/absolute/path/to/authorized/chromium npm run test:browser
HANDRAIL_TEST_BROWSER_EXECUTABLE=/absolute/path/to/authorized/chromium node --test --test-concurrency=1 --test-reporter=tap --test-name-pattern='^B01_ISOLATION$' tests/browser.test.mjs
```

The diagnostic run is not acceptance, even if it passes. Use the returned stage
and fresh source-bound evidence to guide the smallest supported correction,
then rerun the scoped checks and require fresh independent same-item native dev
QA. Preserve campaign `327025b3-141b-44db-86b8-a142adc398b3` and finding
`1ce783dc-1f1a-4821-822b-1c66692034f6`, in addition to the older identities above.
The diagnostic handoff is recorded in
`docs/evidence/browser-fixtures-b01-diagnostics.json`; it is not a browser pass
or a claim that a native validation request has been admitted.
