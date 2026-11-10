// Runs runTests (built output) in its own process so the test that asserts on it never blocks its vitest
// worker: runTests uses spawnSync, and a worker whose event loop is blocked for tens of seconds under load
// loses its RPC channel to the parent ("Timeout calling onTaskUpdate").
import { runTests } from "../dist/index.js";
const r = runTests(JSON.parse(process.argv[2]));
process.exit(r.exitCode === 0 ? 0 : 1);
