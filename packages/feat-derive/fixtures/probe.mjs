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
    body: {
      cases: topology.cases.map((c) => ({ name: c.name, seeds: c.given?.seeds ?? [], ...(c.given?.random !== undefined ? { random: c.given.random } : {}) })),
      seedsShared,
    },
  };
}

// The probe behind `DeriveServices` (SPEC-DRV-002): parse against `config`, derive against `deriveConfig` (default
// `config`), and answer the topology's observes and, per case, the services its resolved prediction names and those
// whose `has []` derive synthesised (resolved `records` where the written prediction has none).
export async function deriveServices(input) {
  const configAbs = path.resolve(process.cwd(), input.config);
  const deriveAbs = path.resolve(process.cwd(), input.deriveConfig ?? input.config);
  const parsed = await parse({ spec: path.resolve(process.cwd(), input.spec), config: configAbs });
  if (parsed.status === "ERR") return { status: "ERR", body: { code: "PARSE_FAILED", detail: JSON.stringify(parsed.body) } };
  let topology;
  try {
    topology = derive(parsed.body, JSON.parse(readFileSync(deriveAbs, "utf8")));
  } catch (e) {
    if (typeof e?.code === "string") return { status: "ERR", body: { code: e.code, detail: String(e.message) } };
    return { status: "ERR", body: { code: "DERIVE_THREW", detail: String(e?.message ?? e) } };
  }
  const written = new Map(parsed.body.scenarios.map((s) => [s.name, s.prediction.services ?? {}]));
  const body = {
    cases: topology.cases.map((c) => {
      const keys = Object.keys(c.prediction.services).sort();
      const mine = written.get(c.name) ?? {};
      return {
        name: c.name,
        services: keys.join(","),
        implicit: keys.filter((k) => mine[k]?.records === undefined && c.prediction.services[k].records !== undefined).join(","),
      };
    }),
  };
  if (topology.observes !== undefined) body.observes = topology.observes.join(",");
  return { status: "OK", body };
}
