// Real-instrument proof (the standing adapter rule): the full contract against
// a genuine DynamoDB with genuine Streams — DynamoDB Local in docker, or a
// pre-provided endpoint via FEAT_DDB_TEST_ENDPOINT. Covers the adapter-kit
// conformance contract, CRUD event mapping, the missing-stream config error,
// and an end-to-end run through the REAL harness including the B1-style
// negative (an unpredicted extra write fails the suite).
//
// Skip discipline (the playwright lesson): unavailability is LOUD — a visible
// notice test runs instead, and CI's Node 24 lane is expected to run the real
// thing (docker is present on ubuntu runners).
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ListTablesCommand,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
} from "@aws-sdk/client-dynamodb";
import { serviceAdapterContract } from "@mmmnt/feat-adapter-kit";
import { createHarness, PredictionViolation, type Harness, type HarnessCase } from "@mmmnt/feat-runtime";
import { createAdapter } from "./src/index.js";

const PKG = path.dirname(fileURLToPath(import.meta.url));
const E2E = path.join(PKG, "fixtures", "e2e");
const PORT = 8321;
const CONTAINER = "feat-ddb-local-test";

process.env.AWS_ACCESS_KEY_ID ??= "local";
process.env.AWS_SECRET_ACCESS_KEY ??= "local";

const presetEndpoint = process.env.FEAT_DDB_TEST_ENDPOINT;
let endpoint = presetEndpoint ?? `http://127.0.0.1:${PORT}`;
let startedContainer = false;

const dockerAvailable = (() => {
  try {
    execFileSync("docker", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const available = Boolean(presetEndpoint) || dockerAvailable;

function client(): DynamoDBClient {
  return new DynamoDBClient({ region: "us-east-1", endpoint });
}

async function waitReady(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await client().send(new ListTablesCommand({}));
      return;
    } catch (e) {
      if (Date.now() > deadline) throw new Error(`DynamoDB Local not ready at ${endpoint}: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

async function createTable(name: string, withStream: boolean): Promise<void> {
  const c = client();
  await c.send(
    new CreateTableCommand({
      TableName: name,
      AttributeDefinitions: [
        { AttributeName: "PK", AttributeType: "S" },
        { AttributeName: "SK", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
      BillingMode: "PAY_PER_REQUEST",
      ...(withStream
        ? { StreamSpecification: { StreamEnabled: true, StreamViewType: "NEW_AND_OLD_IMAGES" } }
        : {}),
    }),
  );
  const deadline = Date.now() + 30_000;
  for (;;) {
    const d = await c.send(new DescribeTableCommand({ TableName: name }));
    if (d.Table?.TableStatus === "ACTIVE") return;
    if (Date.now() > deadline) throw new Error(`table ${name} never became ACTIVE`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const TABLE = "feat-adapter-test";
const options = () => ({ table: TABLE, region: "us-east-1", endpoint });

describe.runIf(available)("dynamodb adapter against real DynamoDB (Local)", () => {
  beforeAll(async () => {
    if (!presetEndpoint) {
      try {
        execFileSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
      } catch {}
      execFileSync(
        "docker",
        ["run", "-d", "--rm", "--name", CONTAINER, "-p", `${PORT}:8000`, "amazon/dynamodb-local"],
        { stdio: "ignore" },
      );
      startedContainer = true;
    }
    await waitReady();
    await createTable(TABLE, true);
    await createTable("feat-adapter-no-stream", false);
  }, 180_000);

  afterAll(async () => {
    if (startedContainer) {
      try {
        execFileSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
      } catch {}
    }
    rmSync(E2E, { recursive: true, force: true });
  });

  // ── The adapter-kit conformance contract, on the real instrument ──────────
  serviceAdapterContract("dynamodb", {
    factory: () => {
      const a = createAdapter({ options: options() });
      return a;
    },
    act: async () => {
      await client().send(
        new PutItemCommand({
          TableName: TABLE,
          Item: { PK: { S: "KIT" }, SK: { S: `ACT#${Date.now()}` }, n: { N: "1" } },
        }),
      );
    },
    seedRecords: [
      { type: "SeedRow", values: { PK: "KIT", SK: "SEED#1", email: "seed@example.com" } },
    ],
  });

  // ── CRUD event mapping through a real capture window ──────────────────────
  it("captures INSERT, MODIFY, and REMOVE with unmarshalled payloads", async () => {
    const a = createAdapter({ options: options() });
    await a.setup();
    await a.reset();
    await a.startCapture();
    const c = client();
    const key = { PK: { S: "CRUD" }, SK: { S: "ROW#1" } };
    await c.send(new PutItemCommand({ TableName: TABLE, Item: { ...key, email: { S: "x@y.z" } } }));
    await c.send(
      new UpdateItemCommand({
        TableName: TABLE,
        Key: key,
        UpdateExpression: "SET email = :e",
        ExpressionAttributeValues: { ":e": { S: "new@y.z" } },
      }),
    );
    await c.send(new DeleteItemCommand({ TableName: TABLE, Key: key }));
    await new Promise((r) => setTimeout(r, 1500)); // stream convergence
    const records = await a.stopCapture();
    await a.teardown();
    const types = records.map((r) => r.type);
    expect(types).toEqual(["INSERT", "MODIFY", "REMOVE"]);
    expect(records[0]!.payload.email).toBe("x@y.z");
    expect(records[1]!.payload.email).toBe("new@y.z");
    expect(records[2]!.payload.email).toBe("new@y.z"); // REMOVE carries OldImage
    expect(records[0]!.key).toBe("PK=CRUD|SK=ROW#1");
  }, 30_000);

  it("a table without a stream is a configuration error at setup()", async () => {
    const a = createAdapter({ options: { ...options(), table: "feat-adapter-no-stream" } });
    await expect(a.setup()).rejects.toThrowError(/no active stream.*configuration error/s);
  });

  it("a missing table name is a configuration error at construction", () => {
    expect(() => createAdapter({ options: { endpoint } })).toThrowError(/no table name/);
  });

  // ── The env-named-credentials rung of the auth ladder, against the real API ─
  it("env-named static credentials authenticate a real capture window", async () => {
    process.env.FEAT_DDB_AK = "local";
    process.env.FEAT_DDB_SK = "local";
    const a = createAdapter({
      options: { ...options(), auth: { accessKeyIdEnv: "FEAT_DDB_AK", secretAccessKeyEnv: "FEAT_DDB_SK" } },
    });
    await a.setup();
    await a.startCapture();
    await client().send(
      new PutItemCommand({
        TableName: TABLE,
        Item: { PK: { S: "AUTH" }, SK: { S: `ENV#${Date.now()}` }, via: { S: "static-env" } },
      }),
    );
    await new Promise((r) => setTimeout(r, 1500));
    const records = await a.stopCapture();
    await a.teardown();
    expect(records.some((r) => r.type === "INSERT" && r.payload.via === "static-env")).toBe(true);
    delete process.env.FEAT_DDB_AK;
    delete process.env.FEAT_DDB_SK;
  }, 30_000);

  // ── Ephemeral mode: the adapter scaffolds its own instrument ───────────────
  it("ephemeral mode scaffolds a private instrument end to end (zero credentials, zero IaC)", async () => {
    const a = createAdapter({ options: { ephemeral: { table: "feat-eph", sortKey: "SK" } } });
    await a.setup(); // spins its own DynamoDB Local container + table + stream
    await a.seed!([{ type: "Row", values: { PK: "SEED", SK: "ROW#1", planted: true } }]);
    await a.startCapture();
    await a.seed!([{ type: "Row", values: { PK: "LIVE", SK: "ROW#2", planted: false } }]);
    await new Promise((r) => setTimeout(r, 1500));
    const records = await a.stopCapture();
    const state = (await a.read({})) as { payload: Record<string, unknown> }[];
    await a.teardown(); // stops and removes the container
    expect(records.map((r) => r.type)).toEqual(["INSERT"]);
    expect(records[0]!.payload).toEqual({ PK: "LIVE", SK: "ROW#2", planted: false });
    expect(state.map((s) => s.payload.PK).sort()).toEqual(["LIVE", "SEED"]);
  }, 180_000);

  // ── End to end through the REAL harness: handler writes, stream captures ──
  describe("harness e2e: prediction inversion over real table writes", () => {
    let h: Harness;
    const INLINE = {
      schemas: {
        BetaRow: {
          type: "object",
          required: ["PK", "SK", "email"],
          properties: { PK: { type: "string" }, SK: { type: "string" }, email: { type: "string" } },
        },
        Receipt: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
      },
      goldens: {},
    };

    beforeAll(async () => {
      rmSync(E2E, { recursive: true, force: true });
      mkdirSync(E2E, { recursive: true });
      writeFileSync(
        path.join(E2E, "handler.mjs"),
        `import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
const c = new DynamoDBClient({ region: "us-east-1", endpoint: ${JSON.stringify(endpoint)} });
export async function requestBeta(payload) {
  await c.send(new PutItemCommand({ TableName: ${JSON.stringify(TABLE)}, Item: {
    PK: { S: "SYSTEM#BETA" }, SK: { S: "REQUEST#" + payload.id }, email: { S: payload.email },
  }}));
  if (payload.leak) {
    await c.send(new PutItemCommand({ TableName: ${JSON.stringify(TABLE)}, Item: {
      PK: { S: "AUDIT" }, SK: { S: "LOG#" + payload.id }, email: { S: payload.email },
    }}));
  }
  return { status: 200, body: { ok: true } };
}
`,
      );
      writeFileSync(
        path.join(E2E, "feat.config.json"),
        JSON.stringify(
          {
            featVersion: "1.0",
            schemas: { adapter: "@mmmnt/feat-schema-json" },
            response: {
              adapter: "@mmmnt/feat-adapter-handler",
              commands: { RequestBeta: { module: "handler.mjs", export: "requestBeta" } },
            },
            services: {
              database: {
                adapter: path.join(PKG, "dist", "index.js"),
                consistency: "eventual",
                convergenceTimeout: 2500,
                options: options(),
              },
            },
            specs: { dir: ".", pattern: "*.feat", contractPattern: "*.contract.json", outputPattern: "{name}.test.ts" },
            report: { format: ["console"] },
          },
          null,
          2,
        ),
      );
      h = await createHarness({ configPath: path.join(E2E, "feat.config.json") });
    }, 60_000);

    afterAll(async () => {
      await h.teardown();
    });

    function betaCase(id: string, leak: boolean): HarnessCase {
      return {
        anchor: `SPEC-DDB-E2E › "beta request"`,
        name: `beta request ${id}`,
        when: { command: "RequestBeta", payload: { id, email: "e2e@example.com", leak } },
        prediction: {
          type: "success",
          response: { status: 200, schemaName: "Receipt" },
          services: {
            database: {
              ordering: "unordered",
              records: [
                {
                  type: "INSERT",
                  schemaName: "BetaRow",
                  valueBlock: {
                    email: { matcher: "literal", value: "e2e@example.com" },
                    SK: { matcher: "literal", value: `REQUEST#${id}` },
                  },
                },
              ],
            },
          },
        },
      } as HarnessCase;
    }

    it("the predicted INSERT is captured from the stream and matches", async () => {
      await h.runCase(betaCase("e2e-1", false), INLINE);
    }, 60_000);

    it("an unpredicted extra write fails the suite (the B1 catch, on DynamoDB)", async () => {
      const c = betaCase("e2e-2", true);
      await expect(h.runCase(c, INLINE)).rejects.toThrowError(PredictionViolation);
    }, 60_000);
  });
});

describe.runIf(!available)("dynamodb adapter (instrument unavailable)", () => {
  it("reports why the real-instrument suite did not run", () => {
    // LOUD skip: neither docker nor FEAT_DDB_TEST_ENDPOINT is available. The
    // CI Node 24 lane runs the real suite; a machine seeing this notice is not
    // proving the adapter. (`docker run -p 8000:8000 amazon/dynamodb-local`.)
    expect(available).toBe(false);
  });
});
