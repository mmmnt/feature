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
  /** ADR-0029: a seed per case, sent to the response role after the clocks (absent: no setSeed at all). */
  seeds?: (number | null)[];
  secondHost?: { command: string[] };
  /** The request limit of this file's registry (the adapters' own stays 30 s). */
  requestTimeoutMs?: number;
  /** A role that sets up right after the first HOST_TIMEOUT, while the ended host may still be running. */
  lateRole?: string;
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
  const registry = new HostRegistry(f.requestTimeoutMs);
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
  let late: Role | undefined;
  let lateFacts: Record<string, unknown> = {};

  const pids = (): number[] => [...new Set(readFileSync(logFile, "utf8").split("\n").filter((l) => l.startsWith("pid ")).map((l) => Number(l.slice(4))))];
  const hostAlive = (): boolean => pids().some(alive);
  const received = (): string[] => readFileSync(logFile, "utf8").split("\n").filter((l) => l.startsWith("recv ")).map((l) => l.slice(5));
  let receivedAtTimeout: number | undefined;
  const note = (role: string, e: unknown) => {
    if (!(e instanceof ExchangeError)) throw e;
    if (e.code === "HOST_TIMEOUT" && receivedAtTimeout === undefined) receivedAtTimeout = received().length;
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
      let caseIndex = 0;
      for (const clock of f.clocks ?? [null]) {
        const seed = f.seeds?.[caseIndex++];
        casesRun++;
        for (const r of services) await guard(r.name, () => (r.adapter as never as { reset(): Promise<void> }).reset());
        const before = readFileSync(logFile, "utf8").split("\n").filter((l) => l.startsWith("clock ")).length;
        void before;
        for (const r of [...(response ? [response] : []), ...services]) {
          clockRoles.push(r.name);
          await (r.adapter as never as { setClock(c: string | null): Promise<void> }).setClock(clock);
        }
        if (response && seed !== undefined)
          await (response.adapter as never as { setSeed(s: number | null): Promise<void> }).setSeed(seed);
        for (const r of services) await guard(r.name, () => (r.adapter as never as { startCapture(c: object): Promise<void> }).startCapture({ specType: "command" }));
        if (response) await guard("response", () => (response.adapter as never as { invoke(c: string, i: object): Promise<unknown> }).invoke("Ping", {}));
        if (f.lateRole !== undefined && receivedAtTimeout !== undefined && late === undefined) {
          const endedAlive = pids().slice(0, 1).some(alive);
          const before = registry.spawned;
          late = make(f.lateRole, hostConfig);
          let outcome = "ok";
          try {
            await (late.adapter as never as { setup(): Promise<void> }).setup();
          } catch (e) {
            if (!(e instanceof ExchangeError)) throw e;
            outcome = e.code;
          }
          lateFacts = { lateRoleOutcome: outcome, lateRoleSpawnedHost: registry.spawned > before, endedHostAliveAtLateSetup: endedAlive };
        }
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
    if (late) {
      const l = late;
      await guard(l.name, () => l.adapter.teardown()).catch(() => undefined);
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
  const seedsSent = lines.filter((l) => l.startsWith("seed ")).map((l) => JSON.parse(l.slice(5)) as number | null);
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
    ...(f.seeds !== undefined ? { seeds: seedsSent } : {}),
    clockRoles,
    resetsBeforeClock,
    settled,
    peeks,
    ...(stopped !== undefined ? { stopped } : {}),
    ...(receivedAtTimeout !== undefined ? { receivedAfterTimeout: received().slice(receivedAtTimeout) } : {}),
    ...lateFacts,
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
