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
    timeout: 10_000,
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
    assert.deepEqual(JSON.parse(output), specifier.endsWith('/server') ? [] : [
      'validateJobCommand', 'validateJobEvent', 'validateJobResult', 'validateJobSnapshot', 'validateJobTransition',
    ]);
  });
}

test('entrypoints and contract import graph have no startup calls or runtime imports', () => {
  for (const path of ['src/index.ts', 'src/server/index.ts', 'dist/index.js', 'dist/server/index.js']) {
    const source = ts.createSourceFile(path, readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest);
    assert.equal(source.statements.length, 1, path);
    const [statement] = source.statements;
    assert.ok(ts.isExportDeclaration(statement), path);
    if (path.includes('/server/')) {
      assert.equal(statement.moduleSpecifier, undefined, path);
      assert.equal(statement.exportClause.elements.length, 0, path);
    } else {
      assert.equal(statement.moduleSpecifier.text, './contracts/job.js', path);
    }
  }
  const source = ts.createSourceFile('job.js', readFileSync(new URL('../dist/contracts/job.js', import.meta.url), 'utf8'), ts.ScriptTarget.Latest);
  for (const statement of source.statements) {
    assert.ok(ts.isFunctionDeclaration(statement) || ts.isVariableStatement(statement));
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        assert.ok(ts.isArrowFunction(declaration.initializer) || ts.isArrayLiteralExpression(declaration.initializer));
      }
    }
  }
});

test('TypeScript consumer resolves both declarations through package exports', () => {
  const output = runNode([
    'node_modules/typescript/bin/tsc', '-p', 'tests/fixtures/tsconfig.json', '--traceResolution',
  ]);
  for (const [specifier, declaration] of [
    ['handrail-agent-sdk', 'dist/index.d.ts'],
    ['handrail-agent-sdk/server', 'dist/server/index.d.ts'],
  ]) {
    assert.ok(output.includes(`Module name '${specifier}' was successfully resolved to '${root}${declaration}'`), output);
  }
});

test('implementation paths are not public package entrypoints', () => {
  runNode(['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    await assert.rejects(import('handrail-agent-sdk/dist/contracts/job.js'), {
      code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
    });
    await assert.rejects(import('handrail-agent-sdk/dist/server/index.js'), {
      code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
    });
  `]);
});
