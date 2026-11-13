// The probe behind `ArmFault` (SPEC-RPC-001, fault shape C): the stdio service adapter against the fake host,
// asked the harness's own question (faultProblem) before arming, and read back from the host's log.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAdapter } from "../src/adapters.ts";
import { HostRegistry } from "../src/host.ts";
import { faultProblem } from "../../../packages/feat-runtime/src/index.ts";

export async function armFault(input) {
  const dir = mkdtempSync(path.join(tmpdir(), "feat-arm-"));
  const logFile = path.join(dir, "host.log");
  writeFileSync(logFile, "");
  const host = { command: input.host.command, env: { FAKE_HOST_LOG: logFile } };
  const adapter = createAdapter({
    key: "kv",
    options: { host, ...(input.catalog ? { faults: input.catalog } : {}) },
    namespace: "s0599e33863c1",
    registry: new HostRegistry(),
  });
  const seen = () => readFileSync(logFile, "utf8").split("\n").filter((l) => l.startsWith("fault "));
  await adapter.setup();
  try {
    const problem = faultProblem(adapter, { service: "kv", ...input.arm });
    if (problem !== undefined) return { status: "ERR", body: { code: "FAULT_UNSUPPORTED", detail: problem, hostSawFault: seen().length > 0 } };
    await adapter.fault(input.arm);
    const [, kind, times, ...rest] = seen()[0].split(" ");
    const detail = rest.join(" ").trim();
    return {
      status: "OK",
      body: {
        armed: true,
        hostSawKind: kind,
        hostSawTimes: times === "reset" ? "reset" : Number(times),
        ...(detail !== "" ? { hostSawDetail: JSON.parse(detail) } : {}),
      },
    };
  } finally {
    await adapter.teardown();
  }
}
