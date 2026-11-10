// SPEC-RPC-002 — RunFiles: drive the real adapter classes against the fake host, one simulated spec file
// per entry of `files` (each with its own host registry, as a vitest worker's module gives its file).
// Per file, per case (one per entry of `clocks`, default one case with null): reset every service role;
// setClock on the response role first, then each service role in listed order; startCapture on every
// service role; one invoke from the response role; then on every service role settle, peekCapture
// twice and stopCapture. Teardown runs every role in order. What reached the host is read back from
// the log the fake host keeps (FAKE_HOST_LOG), so the answer is the host's view, not the client's.

import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAdapter } from "./adapters.js";
import { HostRegistry, type HostConfig } from "./host.js";
import { ExchangeError } from "./protocol.js";

interface FileSpec {
  name: string;
  namespace: string;
  host: { command: string[] };
  roles: string[];
  roleNamespaces?: Record<string, string>;
  cycles?: number;
  clocks?: (string | null)[];
  secondHost?: { command: string[] };
}

type Role = { name: string; adapter: ReturnType<typeof createAdapter> & Record<string, (...a: never[]) => Promise<unknown>> };

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function runFile(f: FileSpec, tmp: string) {
  const registry = new HostRegistry();
  const logFile = path.join(tmp, `${f.name}.log`);
  writeFileSync(logFile, "");
  const hostConfig: HostConfig = { command: f.host.command, env: { FAKE_HOST_LOG: logFile } };
  const make = (name: string, host: HostConfig): Role => {
    const namespace = f.roleNamespaces?.[name] ?? f.namespace;
    const config = name === "response" ? { invoke: { host }, namespace, registry } : { key: name, options: { host }, namespace, registry };
    return { name, adapter: createAdapter(config) as Role["adapter"] };
  };
  const roles = f.roles.map((r) => make(r, hostConfig));
  const services = roles.filter((r) => r.name !== "response");
  const response = roles.find((r) => r.name === "response");

  const outcomes: Record<string, string> = Object.fromEntries(f.roles.map((r) => [r, "ok"]));
  const out: Record<string, unknown> = {};
  const settled: Record<string, boolean> = {};
  const peeks: number[] = [];
  const clockRoles: string[] = [];
  let stopped: number | undefined;
  let resetsBeforeClock = true;
  let casesRun = 0;
  const aliveAfterTeardown: boolean[] = [];
  let endedBy: string | undefined;
  let failure: ExchangeError | undefined;

  const pids = (): number[] => [...new Set(readFileSync(logFile, "utf8").split("\n").filter((l) => l.startsWith("pid ")).map((l) => Number(l.slice(4))))];
  const hostAlive = (): boolean => pids().some(alive);
  const note = (role: string, e: unknown) => {
    if (!(e instanceof ExchangeError)) throw e;
    if (outcomes[role] === "ok") outcomes[role] = e.code;
  };
  const guard = async (role: string, fn: () => Promise<unknown>): Promise<unknown> => {
    try {
      return await fn();
    } catch (e) {
      note(role, e);
      return undefined;
    }
  };

  const cycles = f.cycles ?? 1;
  for (let cycle = 0; cycle < cycles && failure === undefined; cycle++) {
    const joined: Role[] = [];
    try {
      for (const r of roles) {
        await (r.adapter as never as { setup(): Promise<void> }).setup();
        joined.push(r);
      }
      if (f.secondHost) {
        const second = make("second", { command: f.secondHost.command, env: { FAKE_HOST_LOG: logFile } });
        await (second.adapter as never as { setup(): Promise<void> }).setup();
      }
      for (const clock of f.clocks ?? [null]) {
        casesRun++;
        for (const r of services) await guard(r.name, () => (r.adapter as never as { reset(): Promise<void> }).reset());
        const before = readFileSync(logFile, "utf8").split("\n").filter((l) => l.startsWith("clock ")).length;
        void before;
        for (const r of [...(response ? [response] : []), ...services]) {
          clockRoles.push(r.name);
          await (r.adapter as never as { setClock(c: string | null): Promise<void> }).setClock(clock);
        }
        for (const r of services) await guard(r.name, () => (r.adapter as never as { startCapture(c: object): Promise<void> }).startCapture({ specType: "command" }));
        if (response) await guard("response", () => (response.adapter as never as { invoke(c: string, i: object): Promise<unknown> }).invoke("Ping", {}));
        for (const r of services) {
          const a = r.adapter as never as { settle(): Promise<boolean>; peekCapture(): Promise<unknown[]>; stopCapture(): Promise<unknown[]> };
          const s = await guard(r.name, () => a.settle());
          if (s !== undefined) settled[r.name] = s as boolean;
          if (r === services[0]) {
            peeks.length = 0;
            for (let i = 0; i < 2; i++) {
              const p = await guard(r.name, () => a.peekCapture());
              if (p !== undefined) peeks.push((p as unknown[]).length);
            }
            const st = await guard(r.name, () => a.stopCapture());
            if (st !== undefined) stopped = (st as unknown[]).length;
          } else {
            await guard(r.name, () => a.stopCapture());
          }
        }
      }
    } catch (e) {
      if (!(e instanceof ExchangeError)) throw e;
      failure = e;
    }
    for (const r of roles) {
      await guard(r.name, () => r.adapter.teardown());
      aliveAfterTeardown.push(hostAlive());
      if (endedBy === undefined && !hostAlive()) endedBy = r.name;
    }
    void joined;
  }

  const lines = readFileSync(logFile, "utf8").split("\n");
  const setups = lines.filter((l) => l.startsWith("setup ")).map((l) => JSON.parse(l.slice(l.indexOf(" ", 6) + 1)) as string[]);
  const setupNamespaces = lines.filter((l) => l.startsWith("setup ")).map((l) => l.split(" ")[1]!);
  const clocks = lines.filter((l) => l.startsWith("clock ")).map((l) => JSON.parse(l.slice(6)) as string | null);
  await new Promise((r) => setTimeout(r, 20));
  const all = pids();
  const base = { hostsSpawned: all.length, hostsAlive: all.filter(alive).length };
  if (failure) {
    return {
      error: { code: failure.code, detail: failure.detail, ...failure.extra, casesRun, ...base },
      pids: all,
    };
  }
  Object.assign(out, base, {
    spawnedBy: f.roles[0],
    ...(endedBy !== undefined ? { endedBy } : {}),
    aliveAfterTeardown: aliveAfterTeardown.slice(-roles.length),
    roleOutcomes: outcomes,
    setups: setups.slice(0, roles.length),
    setupNamespaces: setupNamespaces.slice(0, roles.length),
    hostEnvNamespace: (lines.find((l) => l.startsWith("env ")) ?? "env ").slice(4),
    clocks,
    clockRoles,
    resetsBeforeClock,
    settled,
    peeks,
    ...(stopped !== undefined ? { stopped } : {}),
    ...(settled[services[0]?.name ?? ""] !== undefined && peeks.length > 0 ? { recordsVisibleAfterSettle: peeks[0] } : {}),
  });
  return { file: out, pids: all };
}

export async function runFiles(input: { files: FileSpec[] }): Promise<{ status: "OK" | "ERR"; body: Record<string, unknown> }> {
  const tmp = mkdtempSync(path.join(tmpdir(), "feat-rpc-"));
  const results: Record<string, unknown> = {};
  const allPids = new Set<number>();
  for (const f of input.files) {
    const r = await runFile(f, tmp);
    for (const p of r.pids) allPids.add(p);
    if ("error" in r && r.error) return { status: "ERR", body: r.error as Record<string, unknown> };
    results[f.name] = (r as { file: Record<string, unknown> }).file;
  }
  void existsSync;
  return { status: "OK", body: { files: results, distinctHosts: allPids.size } };
}
