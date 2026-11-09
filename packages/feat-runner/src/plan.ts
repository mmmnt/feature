// The runner's plan (SPEC-RT-005, ADR-0023): files that arm an EXCLUSIVE fault (BrokerLoss pauses a
// container every other file shares) run in a second, serial pass after the parallel one. The
// partition is swept from the IR, never named: a new spec that arms one cannot be forgotten.

import { EXCLUSIVE_FAULTS } from "@mmmnt/feat-types";

export interface PlannedSpec {
  path: string;
  /** Every fault any scenario of the file arms, as `Operation.Fault`. */
  faults: readonly string[];
}

export interface Plan {
  parallel: string[];
  serial: string[];
  order: "parallel" | "serial" | "parallel then serial";
  /** Workers in the serial pass: 1 when there is one, else 0. */
  serialWorkers: number;
}

export function plan(specs: readonly PlannedSpec[], exclusive: readonly string[] = EXCLUSIVE_FAULTS): Plan {
  const isExclusive = (s: PlannedSpec) => s.faults.some((f) => exclusive.includes(f.slice(f.lastIndexOf(".") + 1)));
  const serial = specs.filter(isExclusive).map((s) => s.path);
  const parallel = specs.filter((s) => !isExclusive(s)).map((s) => s.path);
  const order = serial.length === 0 ? "parallel" : parallel.length === 0 ? "serial" : "parallel then serial";
  return { parallel, serial, order, serialWorkers: serial.length > 0 ? 1 : 0 };
}

/**
 * Run the passes: parallel first, then serial. A failing parallel pass does not skip the serial one,
 * and the run fails if either failed. `runPass` returns that pass's exit code.
 */
export function runPlan(
  p: Plan,
  runPass: (files: string[], opts: { serial: boolean }) => number,
): { exitCode: number } {
  let exitCode = 0;
  if (p.parallel.length > 0) exitCode = Math.max(exitCode, runPass(p.parallel, { serial: false }));
  if (p.serial.length > 0) exitCode = Math.max(exitCode, runPass(p.serial, { serial: true }));
  return { exitCode };
}
