// The config schema's source of truth is the repo-root schemas/ directory
// (language-neutral contract). This package ships its own copy so runtime
// resolution works from node_modules; schema-sync.test.ts guards drift.
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("schemas", { recursive: true });
copyFileSync("../../schemas/feat.config.schema.json", "schemas/feat.config.schema.json");
