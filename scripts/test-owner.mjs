// The owner labels every container, network and volume a test fixture starts carries, so scripts/docker-sweep.sh
// can remove what a killed run left and nothing a live run still uses.
//
//   feat-test.owner-pid        ci-local's pid (FEAT_CI_LOCAL_PID), else this process's
//   feat-test.owner-container  the container this process runs in, when it runs in one: ci-local's job container
//                              (FEAT_CI_LOCAL_CONTAINER), else the id Docker mounts this container's files under.
//                              Inside a container the pid is the container's own, which the host cannot see, so
//                              the sweep judges such an owner by whether its container runs.
import { readFileSync } from "node:fs";

/** The container this process runs in, or undefined on a host. */
export function ownerContainer(env = process.env, mountinfo = readMountinfo) {
  if (env.FEAT_CI_LOCAL_CONTAINER) return env.FEAT_CI_LOCAL_CONTAINER;
  const text = mountinfo();
  const m = text && /\/(?:docker\/)?containers\/([0-9a-f]{64})\//.exec(text);
  return m ? m[1] : undefined;
}

function readMountinfo() {
  try {
    return readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    return "";
  }
}

/** `docker run`/`create` arguments that label an object with its owner. */
export function ownerArgs(env = process.env, mountinfo = readMountinfo, pid = process.pid) {
  const args = ["--label", `feat-test.owner-pid=${env.FEAT_CI_LOCAL_PID ?? pid}`];
  const container = ownerContainer(env, mountinfo);
  if (container) args.push("--label", `feat-test.owner-container=${container}`);
  return args;
}

export const OWNER = ownerArgs();
