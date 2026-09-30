import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));

function runNode(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

for (const specifier of ['handrail-agent-sdk', 'handrail-agent-sdk/server']) {
  test(`${specifier} imports by package name and exits naturally`, () => {
    // No process.exit: an import that leaves a worker or timer running times out.
    const output = runNode(['--input-type=module', '--eval', `
      const entry = await import(${JSON.stringify(specifier)});
      console.log(JSON.stringify(Object.keys(entry)));
    `]);
    assert.deepEqual(JSON.parse(output), specifier.endsWith('/server') ? ['createEffects', 'createJobAdmission', 'createJobAnswer', 'createJobCancellation', 'createJobLease', 'createPaymentFillExecutor', 'createPaymentVault', 'createVaultEntry', 'createVaultRequestExecutor', 'createVaultUse', 'validateVaultCardValue'] : [
      'validateBrowserLease', 'validateBrowserLeaseSuccessor', 'validateBrowserObservation',
      'validateBrowserOperation', 'validateBrowserOperationSchema', 'validateBrowserProfile',
      'validateBrowserRevocationResult', 'validateBrowserTakeover', 'validateBrowserTakeoverTransition',
      'validateConnectionEnsureInput', 'validateConnectionEnsureResult', 'validateConnectionReconnect',
      'validateJobCommand', 'validateJobEvent', 'validateJobResult', 'validateJobSnapshot', 'validateJobTransition',
      'validateVaultBrokerResult', 'validateVaultEntryCompletion', 'validateVaultEntryRequest', 'validateVaultItem', 'validateVaultOperation', 'validateVaultOperationSchema',
    ]);
  });
}

test('entrypoints and contract import graph have no startup calls or external runtime imports', () => {
  for (const path of ['src/index.ts', 'src/server/index.ts', 'dist/index.js', 'dist/server/index.js']) {
    const source = ts.createSourceFile(path, readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest);
    if (path.includes('/server/')) {
      assert.ok(source.statements.every(ts.isExportDeclaration), path);
      const runtime = source.statements.filter(s => !s.isTypeOnly);
      assert.equal(runtime.length, 9, path);
      assert.equal(runtime[0].moduleSpecifier.text, './submit.js', path);
      assert.equal(runtime[1].moduleSpecifier.text, './job-lease.js', path);
      assert.equal(runtime[2].moduleSpecifier.text, './cancel.js', path);
      assert.equal(runtime[3].moduleSpecifier.text, './answer.js', path);
      assert.equal(runtime[4].moduleSpecifier.text, './effects.js', path);
      assert.equal(runtime[5].moduleSpecifier.text, './vault-use.js', path);
      assert.equal(runtime[6].moduleSpecifier.text, './vault-entry.js', path);
      assert.equal(runtime[7].moduleSpecifier.text, './payment-vault.js', path);
      assert.equal(runtime[8].moduleSpecifier.text, './vault-request.js', path);
      assert.deepEqual(runtime[1].exportClause.elements.map(e => e.name.text), ['createJobLease']);
      assert.deepEqual(runtime[0].exportClause.elements.map(e => e.name.text), ['createJobAdmission']);
      assert.deepEqual(runtime[2].exportClause.elements.map(e => e.name.text), ['createJobCancellation']);
      assert.deepEqual(runtime[3].exportClause.elements.map(e => e.name.text), ['createJobAnswer']);
    } else {
      assert.ok(source.statements.every(ts.isExportDeclaration), path);
      assert.deepEqual(source.statements.map(s => s.moduleSpecifier.text), ['./contracts/job.js', './contracts/connection.js', './contracts/vault.js', './contracts/browser.js'], path);
    }
  }
  for (const name of ['submit', 'job-lease']) {
    const admission = ts.createSourceFile(`${name}.js`, readFileSync(new URL(`../dist/server/${name}.js`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest);
    for (const statement of admission.statements) {
      if (ts.isImportDeclaration(statement)) {
        assert.equal(statement.moduleSpecifier.text, '../contracts/job.js');
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          assert.ok(ts.isArrowFunction(declaration.initializer) || ts.isObjectLiteralExpression(declaration.initializer));
        }
      } else assert.ok(ts.isFunctionDeclaration(statement));
    }
  }
  for (const name of ['job', 'connection', 'vault', 'browser']) {
    const source = ts.createSourceFile(`${name}.js`, readFileSync(new URL(`../dist/contracts/${name}.js`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest);
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement)) {
        const expectedImports = {
          connection: { './job.js': ['validateJobCommand'] },
          vault: { './job.js': ['validateJobCommand', 'validateJobSnapshot'] },
          browser: { './job.js': ['validateJobCommand', 'validateJobSnapshot'], './vault.js': ['validateVaultOperation'] },
        };
        assert.deepEqual(statement.importClause.namedBindings.elements.map(e => e.name.text), expectedImports[name]?.[statement.moduleSpecifier.text]);
        continue;
      }
      assert.ok(ts.isFunctionDeclaration(statement) || ts.isVariableStatement(statement));
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          const init = declaration.initializer;
          const literalChoice = node => ts.isCallExpression(node) && node.expression.text === 'oneOf'
            && node.arguments.every(ts.isStringLiteral);
          const fields = ['connection', 'vault', 'browser'].includes(name)
            && ['effectFields', 'contextFields'].includes(declaration.name.text)
            && ts.isObjectLiteralExpression(init)
            && init.properties.every(p => ts.isShorthandPropertyAssignment(p)
              || (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.initializer) || literalChoice(p.initializer))));
          assert.ok(ts.isArrowFunction(init) || ts.isArrayLiteralExpression(init) || fields
            || (name === 'vault' && declaration.name.text === 'identityField' && literalChoice(init)));
        }
      }
    }
  }
});

test('TypeScript consumer resolves both declarations through package exports', () => {
  runNode(['node_modules/typescript/bin/tsc', '-p', 'tests/fixtures/tsconfig.json']);
  const config = ts.readConfigFile(`${root}tests/fixtures/tsconfig.json`, ts.sys.readFile);
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
  for (const [specifier, declaration] of [
    ['handrail-agent-sdk', 'dist/index.d.ts'],
    ['handrail-agent-sdk/server', 'dist/server/index.d.ts'],
    ['handrail-agent-sdk/server/agents', 'dist/server/agent-runtime.d.ts'],
  ]) {
    const resolved = ts.resolveModuleName(specifier, `${root}tests/fixtures/consumer.mts`, options, ts.sys, undefined, undefined, ts.ModuleKind.ESNext);
    assert.equal(resolved.resolvedModule?.resolvedFileName, `${root}${declaration}`);
  }
});

test('implementation paths are not public package entrypoints', () => {
  runNode(['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    await assert.rejects(import('handrail-agent-sdk/dist/contracts/job.js'), {
      code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
    });
    await assert.rejects(import('handrail-agent-sdk/dist/contracts/connection.js'), {
      code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
    });
    await assert.rejects(import('handrail-agent-sdk/reference/node/vault-store.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    await assert.rejects(import('handrail-agent-sdk/dist/contracts/vault.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    await assert.rejects(import('handrail-agent-sdk/dist/contracts/browser.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    await assert.rejects(import('handrail-agent-sdk/dist/server/browser-policy.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    await assert.rejects(import('handrail-agent-sdk/dist/server/vault-policy.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    await assert.rejects(import('handrail-agent-sdk/dist/server/index.js'), {
      code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
    });
  `]);
});

test('lease and reference factories are inert on import and construction', () => {
  runNode(['--input-type=module', '--eval', `
    import { createJobLease, createVaultEntry, createPaymentVault } from 'handrail-agent-sdk/server';
    import { createJobLeaseStore } from './.reference-build/reference/node/job-lease.js';
    import { createJobJournal } from './.reference-build/reference/node/job-journal.js';
    import { createVaultStore } from './.reference-build/reference/node/vault-store.js';
    const untouched = new Proxy({}, { get() { throw Error('FACTORY_STARTED_WORK'); } });
    createJobLease(untouched, untouched);
    createVaultEntry(untouched, untouched);
    createPaymentVault(untouched, untouched);
    createJobLeaseStore(untouched);
    createJobJournal(untouched);
    createVaultStore(untouched, untouched, untouched);
  `]);
});

test('OpenAI Agents server entrypoint imports without starting a worker or provider request', () => {
  const output = runNode(['--input-type=module', '--eval', `
    const entry = await import('handrail-agent-sdk/server/agents');
    console.log(JSON.stringify(Object.keys(entry)));
  `]);
  assert.deepEqual(JSON.parse(output), ['createAgentRuntime']);
});

test('assistance/application public subpaths import without background services', () => {
  const output=runNode(['--input-type=module','--eval',`
    const result={};
    for(const path of ['assistance','assistance/postgres','assistance/notifications','handrail-feedback','application','application-tools']) {
      result[path]=Object.keys(await import('handrail-agent-sdk/server/'+path));
    }
    console.log(JSON.stringify(result));
  `]);
  const entries=JSON.parse(output);
  assert.ok(entries.assistance.includes('createAssistance'));
  assert.ok(entries['assistance/postgres'].includes('createPostgresAssistanceStore'));
  assert.ok(entries.application.includes('createAgentCheckpointReader'));
  assert.ok(entries['application-tools'].includes('createApplicationAgentTools'));
});

test('public PostgreSQL factories are inert and their implementation never imports the reference host', () => {
  runNode(['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import pg from 'pg';
    import * as stores from 'handrail-agent-sdk/server/postgres';
    const pool=new pg.Pool({host:'fixture.invalid'});
    pool.on('connect',()=>{throw Error('UNEXPECTED_CONNECTION');});
    const keys={current:async()=>{throw Error('UNEXPECTED_KEY_READ');},resolve:async()=>{throw Error('UNEXPECTED_KEY_READ');}};
    const composed=stores.createPostgresAgentStores({client:pool,schema:'fixture_app',keys});
    assert.deepEqual(Object.keys(composed).sort(),['admission','answer','cancellation','effects','journal','lease','states']);
    for(const name of ['createJobAdmissionStore','createJobJournal','createJobLeaseStore','createEffectStore','createJobCancellationStore','createJobAnswerStore']) stores[name](pool,'fixture_app');
    stores.createAgentStateStore(pool,keys,'fixture_app');
    stores.createPostgresAssistanceDatabase(pool);
    await pool.end();
  `]);
  const visit = path => {
    const source=ts.createSourceFile(path,readFileSync(path,'utf8'),ts.ScriptTarget.Latest);
    for(const statement of source.statements) if(ts.isImportDeclaration(statement))
      assert.ok(!/reference/.test(statement.moduleSpecifier.text),path);
  };
  for(const name of ['index','job-admission','job-journal','job-lease','job-answer','job-cancellation','effects','agent-state-store','migrate'])
    visit(`${root}dist/server/postgres/${name}.js`);
});
