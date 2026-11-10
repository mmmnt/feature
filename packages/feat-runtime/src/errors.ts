// The harness's configuration errors (exit 2): a file or a case asks for something the adapters or the
// config in front of it cannot give. Raised BEFORE anything has an effect, never a silent pass.

export type HarnessConfigurationCode =
  | "CLOCK_UNSUPPORTED"
  | "MODE_UNSUPPORTED"
  | "FAULT_UNSUPPORTED"
  | "FAULT_REQUIRES_SERIAL"
  | "NAMESPACE_COLLISION"
  | "NAMESPACE_NOT_HONOURED"
  | "NAMESPACE_CONFIGURED";

export class HarnessConfigurationError extends Error {
  constructor(
    public code: HarnessConfigurationCode,
    message: string,
    public service?: string,
    public mode?: "state",
  ) {
    super(`Configuration error (exit 2): [${code}] ${message}`); // the runner prints only the message
  }
}
