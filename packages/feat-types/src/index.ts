// @mmmnt/feat-types — Feat's shared contracts (DP-8: types only, zero runtime code).
// Source of truth: schemas/builtspec.schema.json, schemas/feat.config.schema.json (F13 hedge:
// the JSON Schemas are the language-neutral contracts; these TS types mirror them).
// TODO(M3): replace hand-authoring with json-schema-to-typescript codegen in the build.

// ── BuiltSpec IR (schemas/builtspec.schema.json) ─────────────────────────────

export type SpecType =
  | "command" | "query" | "policy" | "projection"
  | "saga" | "infrastructure" | "integration" | "scaffold";

export type SpecStatus = "draft" | "agreed" | "built" | "verified";

export interface SpecIdentity {
  id: string;
  name: string;
  context: string;
  aggregate: string;
  type: SpecType;
  status: SpecStatus;
}

export type ConstructInstruction =
  | { kind: "handler"; path: string }
  | { kind: "import"; symbol: string; path: string }
  | { kind: "register"; registrationKind: string; name: string; path: string }
  | { kind: "emitsTo"; streamPattern: string }
  | { kind: "touches"; glob: string }
  | { kind: "needs"; specId: string }
  | { kind: "custom"; text: string };

export interface EnforceStep {
  kind: "validate" | "load" | "apply" | "onSuccess" | "onRejection" | "constraint" | "rejects";
  rejectionId?: string;
  text: string;
}

export type ContractReference =
  | { kind: "input" | "response" | "event" | "record" | "error"; schemaName: string; from?: string }
  | { kind: "stream"; pattern: string };

export interface SourceLoc {
  line: number;
  column?: number;
}

export interface Invocation {
  command: string;
  actor?: string;
  payload: Record<string, unknown>;
}

export interface Delivery {
  event: string;
  payload: Record<string, unknown>;
  service: string;
}

export interface SeedRecord {
  type: string;
  schemaName?: string;
  values: Record<string, unknown>;
}

export type Seed =
  | { service: string; records: SeedRecord[] }
  | { service: string; fixture: string };

/** ADR-0023: a logical fault the named service's adapter arms as a precondition. */
export interface Fault {
  service: string;
  operation: string;
  fault: string;
  detail?: Record<string, unknown>;
  /** Consumption: n calls (1 = once), or "reset" for every call until the case ends. */
  times: number | "reset";
}

export interface Given {
  clock?: string;
  context?: string[];
  executes?: Invocation[];
  seeds?: Seed[];
  faults?: Fault[];
}

export type Matcher =
  | { matcher: "literal"; value: string | number | boolean | null }
  | { matcher: "whenRef"; path: string }
  | { matcher: "deliverRef"; path: string; index?: number }
  | { matcher: "captureRef"; service: string; path: string; index?: number }
  | { matcher: "any"; ofType?: "uuid" | "timestamp" | "string" | "number" | "boolean" }
  | { matcher: "regex"; pattern: string | { $placeholder: string } }
  | { matcher: "absent" }
  | { matcher: "placeholder"; name: string }
  | { matcher: "goldenFixture"; path: string }
  | { matcher: "nested"; fields: ValueBlock };

export interface ValueBlock {
  [field: string]: Matcher;
}

export interface PredictedRecord {
  type: string;
  schemaName: string;
  valueBlock?: ValueBlock;
  golden?: string;
}

export interface ResponsePrediction {
  status: number | string;
  schemaName: string;
  valueBlock?: ValueBlock;
  golden?: string;
}

export interface ServicePrediction {
  ordering?: "ordered" | "unordered";
  records?: PredictedRecord[];
  contains?: PredictedRecord[];
}

export interface Prediction {
  type: "success" | "rejection" | "error";
  rejectionId?: string;
  errorCode?: string;
  response?: ResponsePrediction;
  services?: Record<string, ServicePrediction>;
}

export interface Scenario {
  name: string;
  given?: Given;
  when?: Invocation;
  delivers?: Delivery[];
  prediction: Prediction;
  examples?: Record<string, unknown>[];
  loc?: SourceLoc;
}

// ── Spec variables (ADR-0017) ────────────────────────────────────────────────
// The only expressions in the language, confined to the variables: block.
// Sources are the sole nondeterminism entry, resolved ONCE PER CASE at
// execution start; composition is definition-side template interpolation.
export type VariableType = "string" | "number";
export type VariableDefinition =
  | { kind: "call"; fn: "now" | "unique" }
  | { kind: "number"; value: number }
  | { kind: "template"; parts: (string | { ref: string })[] };
export interface SpecVariable {
  name: string;
  type: VariableType;
  definition: VariableDefinition;
}

export interface BuiltSpec {
  featVersion: string;
  identity: SpecIdentity;
  construct: ConstructInstruction[];
  enforce: EnforceStep[];
  contract: ContractReference[];
  variables?: SpecVariable[];
  scenarios: Scenario[];
}

// ── FeatConfig (schemas/feat.config.schema.json) ─────────────────────────────

export type Consistency = "acid" | "strong" | "eventual";

export interface ServiceConfig {
  adapter: string;
  consistency: Consistency;
  convergenceTimeout?: number;
  absenceTimeout?: number;
  options?: Record<string, unknown>;
}

export interface ResponseConfig {
  adapter: string;
  invoke?: Record<string, unknown>;
  commands: Record<string, Record<string, unknown>>;
  actors?: { default?: string } & Record<string, unknown>;
}

export interface FeatConfig {
  featVersion?: string;
  /**
   * The environment this config verifies (ADR-0016) — stamped into evidence
   * bundles; deliberately outside the derivation-relevant slice (generated
   * suites are environment-agnostic).
   */
  environment?: string;
  /** Tier overlay (ADR-0024): the base this config overrides (kept in the merged result). */
  extends?: string;
  schemas: { adapter: string };
  response?: ResponseConfig;
  services: Record<string, ServiceConfig>;
  specs: { dir: string; pattern: string; contractPattern: string; outputPattern: string; exclude?: string[] };
  report?: { format: ("console" | "junit")[]; junitOutput?: string };
}

// ── Runtime capture contracts (ADR-0001) ─────────────────────────────────────

export interface CapturedResponse {
  status: number | string;
  body: Record<string, unknown> | null;
  headers?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export interface CapturedRecord {
  type: string;
  key?: string;
  payload: Record<string, unknown>;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

// ── Adapter interfaces (ADR-0001: modules export createAdapter(config)) ──────

/** The namespace an adapter (or a spec host) is running under, if it can say (SPEC-RT-006). */
export interface ReportsNamespace {
  reportedNamespace?(): string | undefined | Promise<string | undefined>;
}

export interface FeatResponseAdapter extends ReportsNamespace {
  /**
   * Optional (ADR-0023): receive the scenario clock — an ISO-8601 instant with a zone designator, or
   * null for "no frozen clock". The harness delivers it on every case, after the resets. A response
   * adapter without it cannot run a spec that uses `clock at` (CLOCK_UNSUPPORTED).
   */
  setClock?(clock: string | null): Promise<void>;
  setup(config: Record<string, unknown>): Promise<void>;
  teardown(): Promise<void>;
  invoke(command: string, input: Record<string, unknown>, actor?: string): Promise<CapturedResponse>;
}

/** The query hint `contains` hands to read() (ADR-0023): one entry per predicted record. */
export interface ReadQuery {
  expect?: { type: string; key?: Record<string, string | number | boolean | null> }[];
}

/** Which observation modes an adapter serves (ADR-0023). Diff is never optional (INV-6). */
export interface ObservationSupport {
  /** "native": the product reports writes. "snapshot": two reads compared (cannot see a write undone in the window). */
  diff: "native" | "snapshot";
  /** read() answers the stored records, so `contains` can be asserted. */
  state: boolean;
}

/** How many times a fault may be armed for (ADR-0023): `times` covers every n. */
export type FaultCount = "once" | "times" | "reset";
/** Operation -> fault -> the counts it declares; the array form (fault names) declares all three. */
export type FaultCatalog = Record<string, readonly string[] | Record<string, readonly FaultCount[]>>;
export interface FaultArm {
  operation: string;
  fault: string;
  detail?: Record<string, unknown>;
  times: number | "reset";
}
export interface FaultFiring {
  operation: string;
  fault: string;
  count: number;
}

export interface FeatServiceAdapter extends ReportsNamespace {
  /** What this binding can inject (ADR-0023); a fault outside it, or with an undeclared count, is FAULT_UNSUPPORTED. */
  readonly faults?: FaultCatalog;
  /** Arm a fault as a precondition; reset() MUST disarm everything. The adapter's own capture, read and seed are never faulted. */
  fault?(arm: FaultArm): Promise<void>;
  /** Optional: how often each armed fault was consumed. Absent = consumption is not observed (not checked). */
  firedFaults?(): Promise<FaultFiring[]>;
  /** Declares the observation modes served; an adapter that declares nothing is { diff: "native", state: true }. */
  readonly observes?: ObservationSupport;
  /** Optional (ADR-0023): receive the scenario clock, or null; see FeatResponseAdapter.setClock. */
  setClock?(clock: string | null): Promise<void>;
  setup(): Promise<void>;
  teardown(): Promise<void>;
  reset(): Promise<void>;
  /**
   * Open the capture window. `context.specType` is the running spec's type — an adapter that
   * reports resulting state (so a command can assert a seeded row it correctly left alone) uses
   * it to withhold that state from a QUERY, whose synthesised `records: []` would otherwise read
   * a seeded precondition as a side effect. Optional in both directions: an adapter that does not
   * care ignores the argument, and a harness that does not pass it loses nothing it had.
   */
  startCapture(context?: { specType?: string }): Promise<void>;
  stopCapture(): Promise<CapturedRecord[]>;
  /**
   * Resulting state. `query.expect` is a HINT built from a `contains` assertion: an adapter may use it to
   * narrow its read, may answer more than asked, never less.
   */
  read(query: ReadQuery): Promise<unknown | null>;
  seed?(records: SeedRecord[]): Promise<void>;
  /**
   * Deliver an event as a scenario stimulus (projection/policy/saga triggers,
   * ADR-0011). Delivered stimuli are excluded from capture; only effects the
   * system produces in response are captured. Event-capable adapters only.
   */
  deliver?(event: string, payload: Record<string, unknown>): Promise<void>;
  /**
   * Non-destructively report the records captured so far (ADR-0020:
   * convergence is a ceiling, not a sentence). Adapters that implement this
   * let the harness exit the convergence window early once every predicted
   * record has arrived and the capture has gone quiet; adapters without it
   * keep the full window. Must be callable repeatedly between startCapture
   * and stopCapture, and must not consume what stopCapture will return.
   */
  peekCapture?(): Promise<CapturedRecord[]>;
  /**
   * Prove the capture has caught up with every effect written so far (ADR-0021: the fence).
   * Resolve `true` only when everything the system under test has already written is now
   * visible to stopCapture — the harness then ends the convergence window without waiting out
   * the ceiling, which is what makes an absence proof (`records []`) a fact instead of a
   * timeout. Resolve `false` when that cannot be vouched for (the harness keeps the ceiling).
   * Writes the system starts AFTER its handler returned are outside any fence; an adapter for an
   * in-process instrument should yield the event loop before vouching.
   */
  settle?(): Promise<boolean>;
}

export interface FeatSchemaAdapter {
  resolve(ref: string, fromPath: string): Promise<ResolvedSchema>;
  /**
   * Optional: resolve a schema authored INLINE in the contract at `fromPath`, following the
   * relative file references nested in its properties. Without it the pipeline falls back to
   * resolve("#/schemas/<name>"), which cannot keep the schema's own local pointers.
   */
  resolveInline?(schema: Record<string, unknown>, fromPath: string): Promise<ResolvedSchema>;
  validate(data: unknown, schema: ResolvedSchema): { valid: boolean; errors?: string[] };
}

export interface ResolvedSchema {
  id: string;
  format: string;
  raw: unknown;
  normalized: Record<string, unknown>;
}

/**
 * Faults that cannot share a product with any other spec file (SPEC-RT-005): BrokerLoss pauses a
 * container every namespace shares, so a file arming one runs alone, in the serial pass. Names are
 * the part of `Operation.Fault` after the dot.
 */
export const EXCLUSIVE_FAULTS: readonly string[] = ["BrokerLoss"];
