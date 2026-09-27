// Compile the requested .ts suite on all supported Node >=22 versions; do not
// depend on Node's newer built-in type stripping. Generated output stays in dist.
import { readFileSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import ts from 'typescript';
const source = new URL('./vault.test.ts', import.meta.url);
const output = ts.transpileModule(readFileSync(source, 'utf8'), {
  fileName: source.pathname,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  reportDiagnostics: true,
});
if (output.diagnostics?.length) throw new Error('Vault test transpilation failed');
const directory = new URL('../../dist/tests/', import.meta.url);
mkdirSync(directory, { recursive: true });
const target = new URL('vault.test.mjs', directory);
writeFileSync(target, output.outputText);
try { await import(target.href); } finally { unlinkSync(target); }
