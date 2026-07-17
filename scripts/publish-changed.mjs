// Publish only packages whose local version is not already on the registry.
// Used by release.yml so a tag never republishes unchanged packages.

import { execSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const groups = ["packages", "adapters"];

const dirs = groups.flatMap((g) =>
  readdirSync(path.join(ROOT, g))
    .map((d) => path.join(g, d))
    .filter((d) => existsSync(path.join(ROOT, d, "package.json"))),
);

let published = 0;
let skipped = 0;

for (const dir of dirs) {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, dir, "package.json"), "utf8"));
  if (manifest.private) continue;
  const spec = `${manifest.name}@${manifest.version}`;

  let exists = false;
  try {
    execSync(`npm view ${spec} version`, { stdio: "pipe" });
    exists = true;
  } catch {
    exists = false;
  }

  if (exists) {
    console.log(`skip     ${spec} (already published)`);
    skipped++;
    continue;
  }

  console.log(`publish  ${spec}`);
  execSync("pnpm publish --access public --no-git-checks", {
    cwd: path.join(ROOT, dir),
    stdio: "inherit",
  });
  published++;
}

console.log(`\npublish-changed: ${published} published, ${skipped} skipped.`);
