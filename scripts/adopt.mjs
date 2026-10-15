#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { parse } from "@babel/parser";

const PACKAGE = "handrail-agent-sdk";
const LEGACY_PACKAGE = "@handrail/ai-assistant";
const LEGACY_PACKAGES = [LEGACY_PACKAGE, "@handrail/ai"];
const DEPENDENCY_GROUPS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const SOURCE_PATTERN = /^git\+https:\/\/(?:git@)?github\.com\/c0x65o\/handrail-agent-sdk\.git#[0-9a-f]{40}$/u;
const TEXT_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const RELEASE_VERSION_PATTERN = /^(?:0\.(?:[2-9]|[1-9]\d+)\.\d+|[1-9]\d*\.\d+\.\d+)(?:[-+].*)?$/u;
const TEMPLATE_ROOT = fileURLToPath(new URL("../templates/standard-react-node", import.meta.url));
const SDK_REPOSITORY = "https://github.com/c0x65o/handrail-agent-sdk.git";

function usage(message) {
  if (message) console.error(message);
  console.error("Usage: handrail-agent-sdk check <directory>\n       handrail-agent-sdk migrate-package <directory> --sdk-revision <full-sha> [--write]\n       handrail-agent-sdk scaffold <empty-directory> [--sdk-revision <full-sha>]");
  process.exit(2);
}

function extension(path) {
  const match = /(?:\.[^./]+)$/u.exec(path);
  return match?.[0] ?? "";
}

function sourceFiles(root) {
  const start = join(root, "src");
  if (!existsSync(start)) return [];
  const found = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory)) {
      if (["node_modules", "dist", "build", ".git"].includes(entry)) continue;
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) visit(path);
      else if (TEXT_EXTENSIONS.has(extension(path))) found.push(path);
    }
  };
  visit(start);
  return found;
}

// Parse module specifiers, never package catalog values, comments or example strings.
function moduleSpecifiers(source, path) {
  const ext = extension(path);
  const plugins = ["decorators-legacy"];
  if ([".ts", ".tsx", ".mts", ".cts"].includes(ext)) plugins.push(["typescript", { dts: /\.d\.[cm]?ts$/u.test(path) }]);
  if ([".js", ".jsx", ".tsx"].includes(ext)) plugins.push("jsx");
  let ast;
  try { ast = parse(source, { sourceType: "unambiguous", sourceFilename: path,
    createImportExpressions: true, allowReturnOutsideFunction: true, plugins }); }
  catch (error) { throw new SyntaxError(`${path}: ${error.message}`); }
  const found = [];
  const visit = node => {
    if (!node || typeof node !== "object") return;
    let specifier;
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"].includes(node.type)) specifier = node.source;
    else if (node.type === "TSImportType") specifier = node.argument;
    else if (node.type === "TSExternalModuleReference") specifier = node.expression;
    else if (node.type === "CallExpression" && node.callee?.type === "Identifier" && node.callee.name === "require") specifier = node.arguments[0];
    if (specifier?.type === "StringLiteral") found.push(specifier);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object" && typeof value.type === "string") visit(value);
    }
  };
  visit(ast);
  return found;
}

function migratedSpecifier(value) {
  const legacy = LEGACY_PACKAGES.find(name => value === name || value.startsWith(`${name}/`));
  return legacy ? `${PACKAGE}/assistant${value.slice(legacy.length)}` : value;
}

function manifestAt(root) {
  const path = join(root, "package.json");
  if (!existsSync(path)) usage(`No package.json exists under ${root}`);
  return { path, value: JSON.parse(readFileSync(path, "utf8")) };
}

function dependency(manifest, name) {
  for (const group of DEPENDENCY_GROUPS) {
    if (manifest[group]?.[name]) return { group, source: manifest[group][name] };
  }
  return null;
}

function inspect(root) {
  const { value: manifest } = manifestAt(root);
  const files = sourceFiles(root);
  const source = files.map((path) => readFileSync(path, "utf8")).join("\n");
  const specifiers = files.flatMap(path => moduleSpecifiers(readFileSync(path, "utf8"), path).map(node => node.value));
  const legacyImports = specifiers.some(value => migratedSpecifier(value) !== value);
  const importsSdkPath = path => specifiers.some(value => migratedSpecifier(value) === `${PACKAGE}/assistant/${path}`);
  const current = dependency(manifest, PACKAGE);
  const legacy = LEGACY_PACKAGES.some(name => dependency(manifest, name));
  const standardUi = importsSdkPath("react/styled") &&
    (source.includes("HandrailAssistantLauncher") || source.includes("HandrailAssistantWorkspace"));
  const explicitHeadless = importsSdkPath("react/headless");
  const lockPath = join(root, "package-lock.json");
  const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, "utf8")) : null;
  const locked = lock?.packages?.[`node_modules/${PACKAGE}`];
  const legacyLocked = Object.entries(lock?.packages ?? {}).some(([path, entry]) => LEGACY_PACKAGES.some(name => path.endsWith(`node_modules/${name}`)) || /handrail-sdk-ai-assistant/.test(entry.resolved ?? ""));
  const canonicalNodes = Object.keys(lock?.packages ?? {}).filter((path) => path.endsWith(`node_modules/${PACKAGE}`));
  const sourcesMatch = current && DEPENDENCY_GROUPS.every((group) => !manifest[group]?.[PACKAGE] ||
    (manifest[group][PACKAGE] === current.source && lock?.packages?.[""]?.[group]?.[PACKAGE] === current.source));
  const lockCurrentSource = current ? lock?.packages?.[""]?.[current.group]?.[PACKAGE] : undefined;
  const lockMatches = Boolean(lock && locked && RELEASE_VERSION_PATTERN.test(locked.version ?? "")
    && !locked.link && SOURCE_PATTERN.test(locked.resolved ?? "")
    && locked.resolved === current?.source && lockCurrentSource === current?.source && !legacyLocked
    && sourcesMatch && canonicalNodes.length === 1);
  const recovery = source.includes("flushUsage") && (source.includes("stopUsageWorker") || source.includes("stopBackgroundWorkers")) &&
    (source.includes("recoverPendingOnContext") ||
      (source.includes("recoveryContexts") && source.includes("recoverPending")));
  const findings = [
    { id: "package", ok: Boolean(current), detail: current ? `${current.group}: ${current.source}` : `${PACKAGE} is missing` },
    { id: "immutable-source", ok: Boolean(current && SOURCE_PATTERN.test(current.source)), detail: current && SOURCE_PATTERN.test(current.source) ? "full immutable Git SHA" : "dependency must use the approved Git URL and a full SHA" },
    { id: "lockfile", ok: lockMatches, detail: lockMatches ? `${locked.version}, resolved Git SHA and identity match` : "package-lock must resolve one canonical package at version 0.2.0 or newer from the exact manifest Git URL/SHA in every dependency group, with no legacy, duplicate or linked node" },
    { id: "legacy-package-removed", ok: !legacy && !legacyImports, detail: !legacy && !legacyImports ? "no legacy dependency/imports" : `${LEGACY_PACKAGE} remains` },
    { id: "high-level-server", ok: importsSdkPath("server/assistant") && source.includes("createHandrailAssistant"), detail: "standard server assembly" },
    { id: "telemetry", ok: importsSdkPath("server/usage-control") && source.includes("usageFromEnvironment"), detail: "automatic Handrail usage binding" },
    { id: "recovery", ok: recovery, detail: recovery
      ? "trusted-context or startup recovery plus graceful shutdown"
      : "configure trusted-context recovery or recoveryContexts, then flush usage and stop background workers on shutdown" },
    { id: "ui", ok: standardUi || explicitHeadless, detail: standardUi ? "standard styled assistant" : explicitHeadless ? "explicit headless integration" : "use HandrailAssistantLauncher, HandrailAssistantWorkspace, or explicitly select react/headless" },
  ];
  return { schemaVersion: 1, qualification: "static-source-and-lockfile-only", package: PACKAGE, host: basename(root), root, passed: findings.every((item) => item.ok), findings };
}

function scaffold(target, frozenRevision) {
  if (!existsSync(TEMPLATE_ROOT)) throw new Error(`Packaged template is missing: ${TEMPLATE_ROOT}`);
  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new Error(`Scaffold target must be absent or empty: ${target}`);
  }
  if (frozenRevision !== undefined && !/^[0-9a-f]{40}$/u.test(frozenRevision)) throw new TypeError("--sdk-revision requires a full lowercase 40-character Git SHA.");
  // New installs resolve public HEAD once, then freeze it in the manifest.
  // An explicit frozen upgrade revision is never replaced with a newer one.
  const revision = frozenRevision ?? execFileSync("git", ["ls-remote", "--exit-code", SDK_REPOSITORY, "HEAD"],
    { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim().split(/\s+/u)[0];
  if (!/^[0-9a-f]{40}$/u.test(revision ?? "")) throw new Error("Could not resolve a committed public SDK revision. No scaffold was written.");
  mkdirSync(target, { recursive: true });
  const created = [];
  const copy = (sourceDirectory, targetDirectory) => {
    mkdirSync(targetDirectory, { recursive: true });
    for (const entry of readdirSync(sourceDirectory)) {
      const sourcePath = join(sourceDirectory, entry);
      const targetPath = join(targetDirectory, entry === "npmrc.template" ? ".npmrc" : entry === "gitignore.template" ? ".gitignore" : entry);
      if (statSync(sourcePath).isDirectory()) copy(sourcePath, targetPath);
      else {
        mkdirSync(dirname(targetPath), { recursive: true });
        copyFileSync(sourcePath, targetPath);
        created.push(targetPath);
      }
    }
  };
  copy(TEMPLATE_ROOT, target);
  const manifestPath = join(target, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.dependencies[PACKAGE] = `git+${SDK_REPOSITORY}#${revision}`;
  // npm 12 matches Git build permissions by resolved source, not package name.
  manifest.allowScripts = { ...manifest.allowScripts, [manifest.dependencies[PACKAGE]]: true };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { schemaVersion: 1, action: "scaffold", target, sdkRevision: revision, installed: false,
    next: ["npm install --include=dev", "npm run check", "Connect src/assistant/host/identity.ts to trusted application authentication", "Configure declared server environment; run npm run doctor", "Apply SDK migrations through the authorized database workflow"], created };
}

function migrate(root, write, frozenRevision) {
  if (!/^[0-9a-f]{40}$/u.test(frozenRevision ?? "")) throw new TypeError("migrate-package requires --sdk-revision with a full lowercase 40-character Git SHA from the Agent repository.");
  const { path, value: manifest } = manifestAt(root);
  const beforeManifest = JSON.stringify(manifest);
  const source = `git+${SDK_REPOSITORY}#${frozenRevision}`;
  for (const group of DEPENDENCY_GROUPS) {
    if (!manifest[group]) continue;
    const hasLegacy = LEGACY_PACKAGES.some(name => manifest[group][name]);
    if (hasLegacy || manifest[group][PACKAGE]) manifest[group][PACKAGE] = source;
    for (const name of LEGACY_PACKAGES) delete manifest[group][name];
  }
  // Remove the old Agent -> Assistant identity override and build permissions.
  if (manifest.overrides?.[PACKAGE] && typeof manifest.overrides[PACKAGE] === 'object') {
    for (const name of LEGACY_PACKAGES) delete manifest.overrides[PACKAGE][name];
    if (!Object.keys(manifest.overrides[PACKAGE]).length) delete manifest.overrides[PACKAGE];
  }
  if (manifest.allowScripts) {
    for (const key of Object.keys(manifest.allowScripts)) if (/handrail-sdk-ai-assistant|handrail-agent-sdk\.git#/.test(key)) delete manifest.allowScripts[key];
    manifest.allowScripts[source] = true;
  }
  const replacements = sourceFiles(root).flatMap(sourcePath => {
    const before = readFileSync(sourcePath, "utf8");
    let after = before;
    for (const node of moduleSpecifiers(before, sourcePath).sort((a, b) => b.start - a.start)) {
      const replacement = migratedSpecifier(node.value);
      if (replacement !== node.value) after = after.slice(0, node.start) + JSON.stringify(replacement) + after.slice(node.end);
    }
    return before === after ? [] : [{path:sourcePath, after}];
  });
  const changed = beforeManifest !== JSON.stringify(manifest);
  if (write) {
    for (const item of replacements) writeFileSync(item.path, item.after);
    if (changed) writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return {schemaVersion:1, action:'migrate-package', write, root, manifestChanged:changed,
    sourceFiles:replacements.map(item=>item.path), sdkRevision:frozenRevision,
    next:['Regenerate the package-manager lockfile with the pinned public Agent revision', 'Run application checks and review remaining legacy references']};
}

const [command, directory, ...flags] = process.argv.slice(2);
if (!command || !directory) usage();
if (command === "check" && flags.length) usage();
const root = resolve(directory);
if (command === "check") {
  const result = inspect(root);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.passed ? 0 : 1);
}
if (command === "migrate-package") {
  const remaining = flags.filter(flag => flag !== "--write");
  if (remaining.length !== 2 || remaining[0] !== "--sdk-revision" || flags.filter(flag=>flag === "--write").length > 1) usage("migrate-package requires --sdk-revision <full-sha> [--write]");
  console.log(JSON.stringify(migrate(root, flags.includes("--write"), remaining[1]), null, 2));
  process.exit(0);
}
if (command === "scaffold") {
  if (flags.length && (flags.length !== 2 || flags[0] !== "--sdk-revision")) usage("scaffold accepts only --sdk-revision <full-sha>");
  console.log(JSON.stringify(scaffold(root, flags[1]), null, 2));
  process.exit(0);
}
usage(`Unknown command: ${command}`);
