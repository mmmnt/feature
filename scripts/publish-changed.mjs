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
const failed = [];

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
  try {
    const out = execSync("pnpm publish --access public --no-git-checks", {
      cwd: path.join(ROOT, dir),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    process.stdout.write(out);
    published++;
  } catch (e) {
    const text = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    process.stdout.write(text);
    if (/cannot publish over/i.test(text)) {
      // The registry already has this version but the npm-view existence check
      // missed it (propagation lag after a just-completed publish). That is an
      // already-published state, not a failure — idempotent skip.
      console.log(`skip     ${spec} (registry already has this version — propagation lag)`);
      skipped++;
    } else {
      // Keep publishing the rest; report all failures at the end. A brand-new
      // package fails here until its trusted publisher is configured on npm
      // (first publish is a manual bootstrap, as with v0.1.0).
      console.error(`FAILED   ${spec}`);
      failed.push(spec);
    }
  }
}

console.log(`\npublish-changed: ${published} published, ${skipped} skipped, ${failed.length} failed.`);
if (failed.length > 0) {
  console.error(`failed: ${failed.join(", ")}`);
  process.exit(1);
}
