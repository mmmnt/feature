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
  | "NO_ENVIRONMENT";

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
