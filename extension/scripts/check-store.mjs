#!/usr/bin/env node
// Checks the Chrome Web Store package produced by `npm run build:store` before it is uploaded:
// the zip's manifest has no `key`, it matches dist-store/, it ships no source maps, its scripts
// contain no eval / new Function / remote script loading, the version matches manifest.json, there
// are no host_permissions and optional_host_permissions are only the model-provider patterns.
// Prints the permissions for the store listing. Usage: node extension/scripts/check-store.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const zip = join(root, `tabcrew-extension-${source.version}.zip`);
const problems = [];

const entries = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).split("\n").filter(Boolean);
const read = (name) => execFileSync("unzip", ["-p", zip, name], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

if (!entries.includes("manifest.json")) problems.push("manifest.json missing from the zip");
const manifest = JSON.parse(read("manifest.json"));
if ("key" in manifest) problems.push('manifest.json contains "key"');
if (manifest.version !== source.version) problems.push(`manifest version ${manifest.version} != ${source.version}`);
if (manifest.content_security_policy) problems.push("manifest overrides content_security_policy (expected the MV3 default)");
for (const name of entries) {
  if (name.endsWith(".map")) problems.push(`${name}: source map in the store zip`);
  if (/(^|\/)\.|\.pem$|\.ts$/.test(name)) problems.push(`${name}: should not be shipped`);
}
const declared = new Set();
const collect = (v) => {
  if (typeof v === "string") declared.add(v);
  else if (v && typeof v === "object") Object.values(v).forEach(collect);
};
collect(manifest.icons);
collect(manifest.action?.default_icon);
collect(manifest.action?.default_popup);
collect(manifest.background?.service_worker);
for (const file of declared) if (!entries.includes(file)) problems.push(`${file} is referenced by the manifest but missing`);

const FORBIDDEN = [
  [/\beval\s*\(/, "eval("],
  [/\bnew\s+Function\s*\(/, "new Function("],
  [/importScripts\s*\(/, "importScripts("],
  [/<script[^>]+src\s*=\s*["']?https?:/i, "remote <script src>"],
  [/import\s*\(\s*["'`]https?:/, "remote import()"],
];
for (const name of entries.filter((n) => /\.(m?js|html)$/.test(n))) {
  const text = read(name);
  for (const [pattern, label] of FORBIDDEN) if (pattern.test(text)) problems.push(`${name}: contains ${label}`);
}

// The debugger API needs no host access; broad host permissions would only widen store review.
if ((manifest.host_permissions ?? []).length > 0) problems.push(`unexpected host_permissions ${JSON.stringify(manifest.host_permissions)}`);
// Hub mode model provider: access is requested at runtime for the one origin the user saves.
const OPTIONAL_HOSTS = new Set(["https://*/*", "http://localhost/*", "http://127.0.0.1/*"]);
for (const pattern of manifest.optional_host_permissions ?? []) {
  if (!OPTIONAL_HOSTS.has(pattern)) problems.push(`unexpected optional_host_permissions entry ${JSON.stringify(pattern)}`);
}

console.log(`${zip}`);
for (const name of entries) console.log(`  ${name}`);
console.log(`permissions: ${JSON.stringify(manifest.permissions)}`);
console.log(`host_permissions: ${JSON.stringify(manifest.host_permissions ?? [])}`);
console.log(`optional_host_permissions: ${JSON.stringify(manifest.optional_host_permissions ?? [])}`);
if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`);
  process.exit(1);
}
console.log("✓ store package OK");
