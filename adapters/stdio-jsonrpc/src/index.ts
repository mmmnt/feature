// @mmmnt/feat-adapter-stdio-jsonrpc — the Feat Host Protocol client: SPEC-RPC-001 (one exchange) and
// SPEC-RPC-002 (one shared host per spec file, response and service roles).
export { exchange, exchangeOnce, ExchangeError, DEFAULT_TIMEOUT_MS } from "./exchange.js";
export type { ExchangeInput } from "./exchange.js";
export { createAdapter, StdioResponseAdapter, StdioServiceAdapter, PROTOCOL_VERSION } from "./adapters.js";
export { HostConnection, HostRegistry, defaultRegistry } from "./host.js";
export type { HostConfig } from "./host.js";
