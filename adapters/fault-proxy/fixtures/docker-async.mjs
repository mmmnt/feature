// A docker call that leaves the event loop running, shared by the product probes (kafka, kurrent, fault-proxy). Part of the
// build, inside touches, not shipped, beside peer-install.mjs.
//
// A probe's per-case calls (the container's state before and after every case) must not be execFileSync: a spec file
// whose cases never touch the network (SPEC-ADPKUR-004's rule, target and params steps) would chain one blocking docker
// call after another with no turn of the event loop between them, and under the spec tier's parallel workers each call
// takes seconds. A worker that does not turn its loop for 60 s misses vitest's RPC timeout ("Timeout calling onTaskUpdate")
// and the run ends with an unhandled error, every test passed. The start-up calls are no exception: the peer client's
// install (npm inside a container) blocked its worker 21 s on an idle host, past 60 s in ci-local's container under
// load, and a `docker run` whose image is not pulled yet blocks for the pull. Every docker call a fixture makes is
// asynchronous; only the exit-time cleanup (process.once("exit")), which cannot await, stays synchronous.
import { execFile } from "node:child_process";

export function dockerAsync(args, env) {
  const opts = { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...(env ? { env: { ...process.env, ...env } } : {}) };
  return new Promise((resolve, reject) => {
    execFile("docker", args, opts, (error, stdout, stderr) => {
      if (error) reject(new Error(`docker ${args.join(" ")} failed: ${String(stderr).trim() || error.message}`));
      else resolve(stdout.trim());
    });
  });
}
