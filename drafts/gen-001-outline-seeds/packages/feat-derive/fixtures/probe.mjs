// The probe behind `DeriveSeeds` (SPEC-DRV-001): parse one spec against a fixture config, derive its
// topology with the config as read, and answer what derive made of the given seeds, as data.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "../../feat-core/src/index.ts";
import { derive } from "../src/index.ts";

export async function deriveSeeds(input) {
  const configAbs = path.resolve(process.cwd(), input.config);
  const specAbs = path.resolve(process.cwd(), input.spec);
  const parsed = await parse({ spec: specAbs, config: configAbs });
  if (parsed.status === "ERR") return { status: "ERR", body: { code: "PARSE_FAILED", detail: JSON.stringify(parsed.body) } };
  let topology;
  try {
    topology = derive(parsed.body, JSON.parse(readFileSync(configAbs, "utf8")));
  } catch (e) {
    // Derive throws a plain Error today; DERIVE_THREW names the probe's wrapper, not a derive code.
    return { status: "ERR", body: { code: "DERIVE_THREW", detail: String(e?.message ?? e) } };
  }
  const arrays = topology.cases.map((c) => c.given?.seeds).filter(Boolean);
  const seedsShared = arrays.some((a, i) => arrays.indexOf(a) !== i);
  return {
    status: "OK",
    body: { cases: topology.cases.map((c) => ({ name: c.name, seeds: c.given?.seeds ?? [] })), seedsShared },
  };
}
