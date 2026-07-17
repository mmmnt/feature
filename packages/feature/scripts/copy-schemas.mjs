// The evidence schema's source of truth is the repo-root schemas/ directory
// (language-neutral contract layer). This package ships its own copy so
// programmatic consumers can resolve it from node_modules; evidence.test.ts
// guards drift.
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("schemas", { recursive: true });
copyFileSync("../../schemas/evidence.schema.json", "schemas/evidence.schema.json");
