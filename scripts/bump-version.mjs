#!/usr/bin/env node
// Sets one version everywhere it is declared: the root, cli, daemon, extension and shared
// package.json files, extension/manifest.json, and the matching package-lock.json entries.
// Usage: node scripts/bump-version.mjs 0.5.0   (then commit, `git tag v0.5.0`, `git push --tags`)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("usage: node scripts/bump-version.mjs <major.minor.patch>");
  console.error("(Chrome extension versions must be 1-4 dot-separated integers, so no pre-release suffix)");
  process.exit(2);
}

const workspaces = ["cli", "daemon", "extension", "relay", "shared"];
const files = ["package.json", ...workspaces.map((w) => `${w}/package.json`), "extension/manifest.json"];

function update(rel, mutate) {
  const path = join(root, rel);
  const text = readFileSync(path, "utf8");
  const json = JSON.parse(text);
  mutate(json);
  const indent = /^(\s+)"/m.exec(text)?.[1] ?? "  ";
  writeFileSync(path, `${JSON.stringify(json, null, indent)}\n`);
  console.log(`  ${rel}`);
}

console.log(`Setting version ${version} in:`);
for (const rel of files) {
  // Replace only the top-level "version" line so the rest of the file keeps its formatting.
  const path = join(root, rel);
  const text = readFileSync(path, "utf8");
  const next = text.replace(/^(  "version":\s*)"[^"]*"/m, `$1"${version}"`);
  if (JSON.parse(next).version !== version) throw new Error(`${rel}: no top-level "version" field`);
  writeFileSync(path, next);
  console.log(`  ${rel}`);
}
update("package-lock.json", (lock) => {
  lock.version = version;
  for (const key of ["", ...workspaces]) {
    if (lock.packages?.[key]) lock.packages[key].version = version;
  }
});
console.log(`Next: npm run build && npm test, commit, then git tag v${version} && git push --tags`);
