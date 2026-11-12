// The harness's configuration errors (exit 2): a file or a case asks for something the adapters or the
// config in front of it cannot give. Raised BEFORE anything has an effect, never a silent pass.

import type { ConfigErrorCode } from "./load-config.js";

export type HarnessConfigurationCode =
  | ConfigErrorCode // a config createHarness cannot load keeps the loader's code (loadConfig's ERR body)
  | "CLOCK_UNSUPPORTED"
  | "MODE_UNSUPPORTED"
  | "FAULT_UNSUPPORTED"
  | "FAULT_REQUIRES_SERIAL"
  | "NAMESPACE_COLLISION"
  | "NAMESPACE_NOT_HONOURED"
  | "NAMESPACE_CONFIGURED"
  | "SEED_UNSUPPORTED"
  | "DELIVER_UNSUPPORTED"
  | "NO_ENVIRONMENT"
  | "ROUTE_UNLOADABLE"; // SPEC-RT-008: a response adapter's setup() could not load a route the file invokes

export class HarnessConfigurationError extends Error {
  /** The refusal without the `Configuration error (exit 2): [CODE]` prefix, for a caller that prints its own. */
  public readonly detail: string;
  constructor(
    public code: HarnessConfigurationCode,
    message: string,
    public service?: string,
    public mode?: "state",
  ) {
    super(`Configuration error (exit 2): [${code}] ${message}`); // the runner prints only the message
    this.detail = message;
  }
}

/**
 * SPEC-RT-007: a case resumed after the next case on its harness had started. The runner had already
 * given up on it (its test timed out), so this is its record, not a configuration error: it made no
 * adapter call after the next case started.
 */
export class CaseSupersededError extends Error {
  public readonly code = "CASE_SUPERSEDED";
  constructor(
    public anchor: string,
    public by: string,
  ) {
    super(`[CASE_SUPERSEDED] ${anchor}: the next case (${by}) started on this harness while this one was still running, so it made no further adapter call`);
  }
}
