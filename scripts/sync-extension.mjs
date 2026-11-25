// Keeps the VS Code extension in step with the toolchain release: its version is @mmmnt/feature's
// version, and its CHANGELOG.md is the toolchain's changelog under the extension's own heading.
// Run by the root changeset:version script, after `changeset version`, so the version PR carries both.
import { readFileSync, writeFileSync } from "node:fs";

const feature = JSON.parse(readFileSync("packages/feature/package.json", "utf8"));
const manifestPath = "editors/vscode/package.json";
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.version = feature.version;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

const changelog = readFileSync("packages/feature/CHANGELOG.md", "utf8").replace(
  /^# @mmmnt\/feature\n/,
  "# Changelog\n\nThe extension is released at the toolchain's version; these are the toolchain's changes (`@mmmnt/feature`).\n",
);
writeFileSync("editors/vscode/CHANGELOG.md", changelog);
console.log(`sync-extension: editors/vscode at ${feature.version}`);
