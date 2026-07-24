// @mmmnt/feat-derive — BuiltSpec IR + FeatConfig → TestTopology (PRD §3, ADR-0004/0011/0012/0014).
// Pure and deterministic (INV-2): no I/O, no clock, no randomness. Outline rows expand to
// concrete cases; ordering resolves from the consistency model unless overridden; query
// predictions synthesize implicit `has []` for every configured service (ADR-0011).

import type {
  BuiltSpec, FeatConfig, Given, Invocation, Delivery, Matcher, Prediction,
  PredictedRecord, Scenario, ServicePrediction, SpecVariable, ValueBlock,
} from "@mmmnt/feat-types";

export interface ResolvedServiceAssertion {
  ordering: "ordered" | "unordered";
  records?: PredictedRecord[];
  contains?: PredictedRecord[];
}

export interface ResolvedPrediction {
  type: "success" | "rejection" | "error";
  rejectionId?: string;
  errorCode?: string;
  response?: Prediction["response"];
  services: Record<string, ResolvedServiceAssertion>;
}

export interface TestCase {
  anchor: string;
  name: string;
  given?: Given;
  when?: Invocation;
  delivers?: Delivery[];
  prediction: ResolvedPrediction;
  /** ADR-0017: the spec's variable table — the harness resolves it once per case. */
  variables?: SpecVariable[];
}

export interface TestTopology {
  specId: string;
  specName: string;
  cases: TestCase[];
  serviceKeys: string[];
  maxConvergenceTimeout: number;
}

type Row = Record<string, unknown>;

function isPlaceholder(v: unknown): v is { $placeholder: string } {
  return typeof v === "object" && v !== null && "$placeholder" in v;
}

function substituteValue(v: unknown, row: Row): unknown {
  if (isPlaceholder(v)) {
    if (!(v.$placeholder in row))
      throw new Error(`Outline row is missing a value for placeholder '<${v.$placeholder}>'`);
    return row[v.$placeholder];
  }
  if (Array.isArray(v)) return v.map((x) => substituteValue(x, row));
  if (typeof v === "object" && v !== null)
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substituteValue(x, row)]));
  return v;
}

function substituteMatcher(m: Matcher, row: Row): Matcher {
  if (m.matcher === "placeholder") {
    if (!(m.name in row))
      throw new Error(`Outline row is missing a value for placeholder '<${m.name}>'`);
    return { matcher: "literal", value: row[m.name] as string | number | boolean | null };
  }
  if (m.matcher === "regex" && typeof m.pattern === "object") {
    const name = m.pattern.$placeholder;
    if (!(name in row))
      throw new Error(`Outline row is missing a value for placeholder '<${name}>'`);
    return { matcher: "regex", pattern: String(row[name]) };
  }
  if (m.matcher === "nested") return { matcher: "nested", fields: substituteBlock(m.fields, row) };
  return m;
}

function substituteBlock(block: ValueBlock, row: Row): ValueBlock {
  return Object.fromEntries(Object.entries(block).map(([k, m]) => [k, substituteMatcher(m, row)]));
}

function substituteRecords(records: PredictedRecord[] | undefined, row: Row): PredictedRecord[] | undefined {
  if (!records) return undefined;
  return records.map((r) => {
    const out: PredictedRecord = { type: r.type, schemaName: r.schemaName };
    if (r.golden !== undefined) out.golden = r.golden;
    if (r.valueBlock) out.valueBlock = substituteBlock(r.valueBlock, row);
    return out;
  });
}

function resolvePrediction(
  scenario: Scenario,
  config: FeatConfig,
  specType: string,
  row: Row,
): ResolvedPrediction {
  const p = scenario.prediction;
  const out: ResolvedPrediction = { type: p.type, services: {} };

  if (p.rejectionId !== undefined) {
    const ph = /^<(.+)>$/.exec(p.rejectionId);
    out.rejectionId = ph ? String(row[ph[1]!]) : p.rejectionId;
  }
  if (p.errorCode !== undefined) out.errorCode = p.errorCode;

  if (p.response) {
    const response = { ...p.response };
    if (response.valueBlock) response.valueBlock = substituteBlock(response.valueBlock, row);
    out.response = response;
  }

  const declared: Record<string, ServicePrediction> = p.services ?? {};
  for (const key of Object.keys(config.services).sort()) {
    const svc = config.services[key]!;
    const entry = declared[key];
    const defaultOrdering = svc.consistency === "eventual" ? "unordered" : "ordered";
    if (specType === "query") {
      // ADR-0011: implicit zero side effects, unwritable by grammar.
      out.services[key] = { ordering: defaultOrdering, records: [] };
      continue;
    }
    if (!entry) continue; // parser enforces INV-6; defensive
    const resolved: ResolvedServiceAssertion = {
      ordering: entry.ordering ?? defaultOrdering,
    };
    const records = substituteRecords(entry.records, row);
    if (records !== undefined) resolved.records = records;
    const contains = substituteRecords(entry.contains, row);
    if (contains !== undefined) resolved.contains = contains;
    out.services[key] = resolved;
  }
  return out;
}

function substituteGiven(given: Given | undefined, row: Row): Given | undefined {
  if (!given) return undefined;
  const out: Given = {};
  if (given.clock !== undefined) out.clock = given.clock;
  if (given.context) out.context = given.context;
  if (given.executes)
    out.executes = given.executes.map((e) => ({
      ...e,
      payload: substituteValue(e.payload, row) as Record<string, unknown>,
    }));
  if (given.seeds) out.seeds = given.seeds;
  return out;
}

export function derive(spec: BuiltSpec, config: FeatConfig): TestTopology {
  const cases: TestCase[] = [];
  let maxConvergenceTimeout = 0;
  for (const svc of Object.values(config.services))
    if (svc.consistency === "eventual" && (svc.convergenceTimeout ?? 0) > maxConvergenceTimeout)
      maxConvergenceTimeout = svc.convergenceTimeout ?? 0;

  for (const scenario of spec.scenarios) {
    const rows: (Row | null)[] = scenario.examples ? scenario.examples : [null];
    rows.forEach((rawRow, idx) => {
      const row = rawRow ?? {};
      const isOutline = rawRow !== null;
      const anchor = isOutline
        ? `${spec.identity.id} › "${scenario.name}" › row[${idx + 1}]`
        : `${spec.identity.id} › "${scenario.name}"`;
      const name = isOutline ? `${scenario.name} › row[${idx + 1}]` : scenario.name;

      const testCase: TestCase = {
        anchor,
        name,
        prediction: resolvePrediction(scenario, config, spec.identity.type, row),
      };
      if (spec.variables && spec.variables.length > 0) testCase.variables = spec.variables;
      const given = substituteGiven(scenario.given, row);
      if (given) testCase.given = given;
      if (scenario.when) {
        const when: Invocation = {
          command: scenario.when.command,
          payload: substituteValue(scenario.when.payload, row) as Record<string, unknown>,
        };
        if (scenario.when.actor !== undefined) when.actor = scenario.when.actor;
        testCase.when = when;
      }
      if (scenario.delivers)
        testCase.delivers = scenario.delivers.map((d) => ({
          ...d,
          payload: substituteValue(d.payload, row) as Record<string, unknown>,
        }));
      cases.push(testCase);
    });
  }

  return {
    specId: spec.identity.id,
    specName: spec.identity.name,
    cases,
    serviceKeys: Object.keys(config.services).sort(),
    maxConvergenceTimeout,
  };
}
