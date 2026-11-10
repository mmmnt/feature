// The peer client install shared by the product probes (kafka, kurrent, neo4j). Part of the build, inside
// touches, not shipped.
//
// A peer container needs the pinned client built for linux, which the host's install cannot give, so a
// one-off container installs it into `.feature/<product>-peer`. Every spec file runs in its own worker
// process and each one asks for that directory at once, so the install must be safe against that:
//   - one installer at a time: a mkdir lock (`<dir>.lock`, owner pid inside, a dead owner's lock is broken)
//   - the install is made in a private directory next to the cache and renamed into place only after the
//     client loaded inside the container, so the cache directory is never half made
//   - a completion marker, written last, names the client and the image; `package.json` alone proves nothing
//     (an interrupted npm leaves it behind), and a cache without the marker is rebuilt
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const MARKER = ".peer-install-complete";

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

async function withLock(lock, work, ms = 600_000) {
  const deadline = Date.now() + ms;
  mkdirSync(path.dirname(lock), { recursive: true });
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(path.join(lock, "pid"), String(process.pid));
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let owner = Number.NaN;
      try {
        owner = Number(readFileSync(path.join(lock, "pid"), "utf8"));
      } catch {
        // The owner has made the directory and not yet written its pid: it is alive, wait.
      }
      if (Number.isFinite(owner) && !alive(owner)) rmSync(lock, { recursive: true, force: true });
      else if (Date.now() > deadline) throw new Error(`the peer install lock ${lock} was not released in ${ms}ms`);
      else await new Promise((r) => setTimeout(r, 250));
    }
  }
  try {
    return await work();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

// Returns when `dir` holds a complete install of `pkg@version`. `track` is told the name of the installer
// container before it starts, so the probe's cleanup removes it if the worker dies.
export async function ensurePeerInstall({ dir, pkg, version, image, name, track }) {
  const stamp = `${pkg}@${version} ${image}`;
  const complete = () => existsSync(path.join(dir, MARKER)) && readFileSync(path.join(dir, MARKER), "utf8") === stamp;
  if (complete()) return;
  await withLock(`${dir}.lock`, () => {
    if (complete()) return;
    const work = `${dir}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    try {
      track(name);
      // The client is loaded inside the container, so a binding that did not build fails here, not in a spec.
      execFileSync(
        "docker",
        ["run", "--rm", "--name", name, "-v", `${work}:/work`, "-w", "/work", image, "sh", "-c",
          `npm install --no-audit --no-fund --prefix /work ${pkg}@${version} && node -e "require('${pkg}')"`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      writeFileSync(path.join(work, MARKER), stamp);
      renameSync(work, dir);
    } catch (e) {
      rmSync(work, { recursive: true, force: true });
      throw e;
    }
  });
}
