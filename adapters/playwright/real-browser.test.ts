// The claim this package makes — "a command is a REAL browser journey" — proven
// with a real chromium against a live local form app, through the full harness:
// journey fills and submits the form, the fs adapter watches the app's data
// directory, and prediction inversion catches a hidden write the page never
// shows (the browser-level B1). Auto-skips when no chromium is installed
// (`npx playwright install chromium`).
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, PredictionViolation, type Harness, type HarnessCase } from "@mmmnt/feat-runtime";

const PKG = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(PKG, "fixtures", "real-e2e");
const DATA = path.join(FIX, "data");

const chromiumAvailable = await (async () => {
  try {
    const { chromium } = (await import("playwright")) as { chromium: { launch(): Promise<{ close(): Promise<void> }> } };
    const b = await chromium.launch();
    await b.close();
    return true;
  } catch {
    return false;
  }
})();

function loadJson(file: string): unknown[] {
  const p = path.join(DATA, file);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as unknown[]) : [];
}

function saveJson(file: string, rows: unknown[]) {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(path.join(DATA, file), JSON.stringify(rows, null, 2));
}

const FORM_PAGE = (action: string) => `<!doctype html><html><body>
  <form method="POST" action="${action}">
    <input id="email" name="email" type="email" />
    <input id="name" name="name" type="text" />
    <button id="submit" type="submit">Sign up</button>
  </form>
</body></html>`;

const CONFIRMATION = (email: string) => `<!doctype html><html><body>
  <div id="confirmation">Welcome! <span id="user-email">${email}</span></div>
</body></html>`;

const JOURNEY = `export async function signUp(page, payload, ctx) {
  await page.goto(ctx.baseUrl + (payload.leaky ? "/?leaky=1" : "/"));
  await page.fill("#email", payload.email);
  await page.fill("#name", payload.name);
  await page.click("#submit");
  await page.waitForSelector("#confirmation");
  return { status: 200, body: { email: await page.textContent("#user-email") } };
}
`;

const INLINE = {
  schemas: {
    SignupReceipt: { type: "object", required: ["email"], properties: { email: { type: "string" } } },
    FileEvent: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
  },
  goldens: {},
};

function signupCase(payload: Record<string, unknown>): HarnessCase {
  return {
    anchor: 'SPEC-PW-001 › "sign up"',
    name: "sign up",
    when: { command: "SignUp", payload },
    prediction: {
      type: "success",
      response: { status: 200, schemaName: "SignupReceipt" },
      services: {
        datastore: {
          ordering: "unordered",
          records: [
            { type: "FILE_WRITTEN", schemaName: "FileEvent", valueBlock: { path: { matcher: "literal", value: "users.json" } } },
          ],
        },
      },
    },
  } as HarnessCase;
}

describe.runIf(chromiumAvailable)("real chromium journey through the full harness", () => {
  let server: Server;
  let h: Harness;

  beforeAll(async () => {
    rmSync(FIX, { recursive: true, force: true });
    mkdirSync(FIX, { recursive: true });
    writeFileSync(path.join(FIX, "package.json"), JSON.stringify({ name: "real-e2e", type: "module" }));
    writeFileSync(path.join(FIX, "journeys.mjs"), JOURNEY);

    server = createServer((req, res) => {
      const url = new URL(req.url!, "http://localhost");
      if (req.method === "GET") {
        res.setHeader("content-type", "text/html");
        res.end(FORM_PAGE(url.searchParams.has("leaky") ? "/signup-leaky" : "/signup"));
        return;
      }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const form = new URLSearchParams(body);
        const user = { email: form.get("email"), name: form.get("name") };
        const users = loadJson("users.json");
        users.push(user);
        saveJson("users.json", users);
        if (req.url === "/signup-leaky") {
          // The hidden write: nothing on the page ever shows this happened.
          const events = loadJson("analytics.json");
          events.push({ event: "signup", email: user.email });
          saveJson("analytics.json", events);
        }
        res.setHeader("content-type", "text/html");
        res.end(CONFIRMATION(user.email ?? ""));
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;

    writeFileSync(
      path.join(FIX, "feat.config.json"),
      JSON.stringify({
        featVersion: "1.0",
        schemas: { adapter: "@mmmnt/feat-schema-json" },
        response: {
          adapter: path.join(PKG, "dist", "index.js"),
          commands: { SignUp: { module: "journeys.mjs", export: "signUp" } },
          invoke: { baseUrl: `http://localhost:${port}`, headless: true },
        },
        services: {
          datastore: {
            adapter: path.join(PKG, "..", "fs", "dist", "index.js"),
            consistency: "acid",
            options: { scope: "data" },
          },
        },
        specs: { dir: ".", pattern: "*.feat", contractPattern: "*.contract.json", outputPattern: "{name}.test.ts" },
        report: { format: ["console"] },
      }),
    );
    h = await createHarness({ configPath: path.join(FIX, "feat.config.json") });
  }, 60_000);

  afterAll(async () => {
    await h?.teardown();
    server?.close();
    rmSync(FIX, { recursive: true, force: true });
  });

  it("drives the form in a real browser and the prediction holds", async () => {
    rmSync(DATA, { recursive: true, force: true });
    await h.runCase(signupCase({ email: "bob@example.com", name: "Bob" }), INLINE);
    expect(loadJson("users.json")).toEqual([{ email: "bob@example.com", name: "Bob" }]);
  }, 30_000);

  it("catches a hidden write the page never shows (browser-level B1)", async () => {
    rmSync(DATA, { recursive: true, force: true });
    const run = h.runCase(signupCase({ email: "eve@example.com", name: "Eve", leaky: true }), INLINE);
    await expect(run).rejects.toThrowError(PredictionViolation);
    await expect(run).rejects.toThrowError(/UNPREDICTED record FILE_WRITTEN \(analytics\.json\)/);
  }, 30_000);
});

describe.runIf(!chromiumAvailable)("real chromium journey", () => {
  it.skip("skipped: chromium not installed (npx playwright install chromium)", () => {});
});
