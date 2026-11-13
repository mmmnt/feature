// The extension finds the project's own feat and never fetches one (ADR-0026, amended). Runs on the built
// output with Node's own test runner: `npm test` (builds first).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const { resolveFeatBin, featNotInstalledMessage } = createRequire(import.meta.url)("../dist/resolve-feat.js");

function install(dir, manifest, files = []) {
  const pkg = path.join(dir, "node_modules", "@mmmnt", "feature");
  mkdirSync(path.join(pkg, "bin"), { recursive: true });
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@mmmnt/feature", ...manifest }));
  for (const f of files) writeFileSync(path.join(pkg, f), "");
  return pkg;
}

test("finds the feat bin installed in the workspace folder", () => {
  const root = mkdtempSync(path.join(tmpdir(), "feat-vscode-"));
  const pkg = install(root, { bin: { feat: "./bin/run.js" } }, ["bin/run.js"]);
  assert.equal(resolveFeatBin(root), path.join(pkg, "bin", "run.js"));
});

test("finds it hoisted to a parent directory, as a workspace installs it", () => {
  const ws = mkdtempSync(path.join(tmpdir(), "feat-vscode-ws-"));
  const pkg = install(ws, { bin: "./bin/run.js" }, ["bin/run.js"]);
  mkdirSync(path.join(ws, "app"));
  assert.equal(resolveFeatBin(path.join(ws, "app")), path.join(pkg, "bin", "run.js"));
});

test("is null without @mmmnt/feature, or with one that names no feat bin, and the message says to install it", () => {
  const root = mkdtempSync(path.join(tmpdir(), "feat-vscode-none-"));
  assert.equal(resolveFeatBin(root), null);
  install(root, {});
  assert.equal(resolveFeatBin(root), null);
  assert.match(featNotInstalledMessage(root), /install it as a dev dependency \(npm install --save-dev @mmmnt\/feature/);
});
