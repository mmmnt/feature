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

export interface Given {
  clock?: string;
  context?: string[];
  executes?: Invocation[];
  seeds?: Seed[];
}

export type Matcher =
  | { matcher: "literal"; value: string | number | boolean | null }
  | { matcher: "whenRef"; path: string }
  | { matcher: "deliverRef"; path: string; index?: number }
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

export interface BuiltSpec {
  featVersion: string;
  identity: SpecIdentity;
  construct: ConstructInstruction[];
  enforce: EnforceStep[];
  contract: ContractReference[];
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
  schemas: { adapter: string };
  response?: ResponseConfig;
  services: Record<string, ServiceConfig>;
  specs: { dir: string; pattern: string; contractPattern: string; outputPattern: string };
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

export interface FeatResponseAdapter {
  setup(config: Record<string, unknown>): Promise<void>;
  teardown(): Promise<void>;
  invoke(command: string, input: Record<string, unknown>, actor?: string): Promise<CapturedResponse>;
}

export interface FeatServiceAdapter {
  setup(): Promise<void>;
  teardown(): Promise<void>;
  reset(): Promise<void>;
  startCapture(): Promise<void>;
  stopCapture(): Promise<CapturedRecord[]>;
  read(query: Record<string, unknown>): Promise<unknown | null>;
  seed?(records: SeedRecord[]): Promise<void>;
}

export interface FeatSchemaAdapter {
  resolve(ref: string, fromPath: string): Promise<ResolvedSchema>;
  validate(data: unknown, schema: ResolvedSchema): { valid: boolean; errors?: string[] };
}

export interface ResolvedSchema {
  id: string;
  format: string;
  raw: unknown;
  normalized: Record<string, unknown>;
}
