// Unit test for the http adapter against a local Node server (no external network).

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { createAdapter, resolveBaseUrl } from "./src/index.ts";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && req.url === "/flows") {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        if (req.headers.authorization !== "Bearer admin-token") {
          res.statusCode = 401;
          res.end(JSON.stringify({ code: "UNAUTHORIZED", message: "no" }));
          return;
        }
        res.statusCode = 201;
        res.end(JSON.stringify({ flowId: "f-1", name: parsed.name }));
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/flows/f-1")) {
        res.statusCode = 200;
        res.end(JSON.stringify({ flowId: "f-1", name: "Welcome" }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ code: "NOT_FOUND", message: "nope" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("@mmmnt/feat-adapter-http", () => {
  it("routes, substitutes path params, applies actor headers", async () => {
    const adapter = createAdapter({
      commands: {
        CreateFlow: { method: "POST", path: "/flows" },
        GetFlow: { method: "GET", path: "/flows/{flowId}" },
      },
      invoke: { baseUrl },
      actors: { default: "admin", admin: { headers: { authorization: "Bearer admin-token" } } },
    });
    await adapter.setup({});

    const created = await adapter.invoke("CreateFlow", { name: "Welcome" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ flowId: "f-1", name: "Welcome" });

    const fetched = await adapter.invoke("GetFlow", { flowId: "f-1" });
    expect(fetched.status).toBe(200);
    expect(fetched.body).toMatchObject({ name: "Welcome" });

    const anon = await adapter.invoke("CreateFlow", { name: "Nope" }, "anonymous");
    expect(anon.status).toBe(401);

    await adapter.teardown();
  });
});

describe("base URL resolution (API origins belong to the environment)", () => {
  afterEach(() => {
    delete process.env.FEAT_TEST_BASE_URL;
  });

  it("literal passes through; absent means empty (relative fetch)", () => {
    
    expect(resolveBaseUrl({ baseUrl: "http://x" })).toBe("http://x");
    expect(resolveBaseUrl(undefined)).toBe("");
  });

  it("baseUrlEnv reads the named variable; unset is a loud configuration error", () => {
    
    process.env.FEAT_TEST_BASE_URL = "http://localhost:4566/restapis/abc/local/_user_request_";
    expect(resolveBaseUrl({ baseUrlEnv: "FEAT_TEST_BASE_URL" })).toContain("_user_request_");
    delete process.env.FEAT_TEST_BASE_URL;
    expect(() => resolveBaseUrl({ baseUrlEnv: "FEAT_TEST_BASE_URL" })).toThrowError(/FEAT_TEST_BASE_URL is not set/);
  });

  it("both forms at once is a configuration error", () => {
    
    expect(() => resolveBaseUrl({ baseUrl: "http://x", baseUrlEnv: "Y" })).toThrowError(/mutually exclusive/);
  });
});
