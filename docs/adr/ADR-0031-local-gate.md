# ADR-0031 — the local gate is an explicit command, the push only checks its record

Status: Accepted (founder rulings 2026-11-17: "Overhaul Feature's gate now", and the five measures below adopted
as proposed; they mirror flmnt's gate rulings b4e3656a and b24b9525).

## Context

Measured on 2026-11-16 (flmnt exploration 7858a34f):

- `.githooks/pre-push` ran the full local CI (`scripts/ci-local.sh`, Node 24) before every push: 350–490 s over
  twelve runs, 655 s at worst, its jobs one after another in one container.
- `git push` opens its connection to the remote (`ssh git@github.com git-receive-pack`) before it runs pre-push,
  and holds it idle while the hook works. On the `feat-adapter-redis` 0.2.0 release push the session was gone
  about six minutes in, the hook ran on to 7.5 minutes, the push exited, and `git ls-remote` showed the remote
  unmoved. That was the silent no-land seen on several releases; a second push landed only because the hook's
  pass record skipped the second run.
- GitHub CI ran the same work, for four Node versions and Windows, in 2–5 minutes: its jobs run in parallel.
- "Timeout calling onTaskUpdate" came back despite the three-worker cap (07dfd95): `turbo run test` runs up to ten
  packages at once, each with up to three vitest workers, beside the tests' product containers.
- Every run rebuilt every package from a fresh `git archive`, with no build cache.
- The spec job ran every adapter's live-container suites on every push: Kafka 122 s, Neo4j 176 s over three files,
  Kurrent 101 s, whatever changed.
- The host rule (8ea670d4) waited for any other runner's test container up to 15 minutes and then polled load
  averages; flmnt measured a 1154 s wait while containers used 0.8–4.4 of 16 cores.

## Decision

1. **The push is instant.** `.githooks/pre-push` runs nothing: it refuses a push unless every commit pushed has a
   full-gate pass record for that exact commit and the current runner (`scripts/ci-local.sh --record-path`). The
   full gate is the explicit command `scripts/ci-local.sh`, run before the push. Nothing reaches the remote that
   has not passed it.
2. **One gate at a time, by a lock and a CPU check.** `scripts/gate-lock.sh` takes `~/.flmnt/gate.lock` with
   flock(2), the same file and lock flmnt's `cargo xtask ci` takes, so Feature's and flmnt's gates queue behind
   each other; a gate that dies releases it. Then it starts while the daemon's containers use under 12 cores
   (`docker stats`, summed; `FLMNT_GATE_CPU_MAX`); an unreadable figure waits. The 30-minute cap per run stays.
   `scripts/ci-local-lock.sh` and its presence wait and load thresholds are removed. Workspace tests run two
   packages at once locally (`FEAT_TEST_CONCURRENCY`, read by the Workspace tests step only; CI keeps turbo's default of ten; not `TURBO_CONCURRENCY`, which turbo itself applies to every task).
3. **Jobs stay one after another, measured.** The ruling made side by side the default only if it measured faster
   with identical results. It did not give identical results: run side by side in one container on 2026-11-17,
   the spec job's filesystem service observed the fixture files the test job's suites write into the same tree,
   and three spec cases (SPEC-FPX-001, SPEC-ADPKUR-004, SPEC-ADPNEO-001) failed with unpredicted
   FILE_WRITTEN/FILE_DELETED records a serial run never shows. It was also barely faster under contention
   (wall 340 s; Typecheck 76 s against 16–22 s serial, Workspace tests 197 s against 60–125 s). CI's jobs run on
   separate runners with separate trees; one tree cannot be shared that way, and a copy of the tree with its
   node_modules per job costs more than it saves on this disk. So the jobs run serially.
4. **Turbo's build cache is kept.** A docker volume per lockfile, `.tool-versions` and Node image
   (`feat-ci-cache-turbo-<key>`) holds turbo's cache. Only `build` is cached: `test` and `typecheck` are marked
   `cache: false` in turbo.json, since a replayed test result proves nothing about the commit. Bounded as flmnt's
   gate caches are (b24b9525): at most four volumes (`CI_LOCAL_TURBO_CACHES_MAX`), the least recently used removed
   past the cap and never one a container has mounted; a run refuses to start while the Docker VM has under
   20 GB free (`CI_LOCAL_DISK_MIN_GB`). The volumes are keyed by lockfile, not by checkout, so a removed
   worktree leaves nothing of its own to sweep.
5. **A scoped check for iterating.** `scripts/ci-local.sh --changed` (against origin/main) or `--since <ref>`
   runs every tier the gate runs, for the packages changed and every package depending on them
   (`scripts/ci-local-scope.mjs`): their build, typecheck and workspace tests, the global `feat verify`, `audit`
   and `lint`, and the generated suites of their specs; a toolchain package in scope runs every spec, a language
   package the corpus validation. A shared root (the lockfile, workspace and build configuration, `scripts/`,
   `.github/`, `schemas/`, `corpus/`, the grammar reference) or a path no rule covers widens to the full gate. A
   change that maps to nothing the gate runs is refused: a check that runs nothing proves nothing. A scoped check
   leaves no pass record. After rebasing a commit that passed the full gate, `--rebased` checks what differs
   between it (ORIG_HEAD) and the rebased commit and, passing, records the rebased commit as passed ("rebased
   from <ORIG_HEAD>"); without ORIG_HEAD's record it refuses.

## Rejected alternatives

- **An SSH keepalive (`ServerAliveInterval`) and keep the gate in pre-push.** It keeps the transport alive, not
  the remote's receive-pack session, and every push would still wait for the whole gate.
- **Run the gate in a `pre-push` that forks into the background.** The hook's verdict must come before the push;
  a background gate cannot block a push it has already let through.
- **Leave the full gate to CI (push first).** Feature main would receive commits nobody had verified.
- **Keep the presence wait and tune its thresholds.** Presence is not use and a load average lags; the measured
  waits happened with most cores idle.
- **Cache `test` and `typecheck` in turbo as well.** A cache hit replays a past result without running anything.
- **Jobs side by side in one tree.** Measured: not identical (above).
- **One volume per checkout, or a seed copy of main's cache per checkout.** A copy per checkout filled flmnt's
  Docker disk (b24b9525); keying by lockfile shares what is identical and needs no copy.
- **A scoped check that skips the spec suites, or a fixed list of what each package touches.** The first misses
  what the specs prove; the second stops covering a package the day it gains a dependency (gates sweep, never
  enumerate).

## Consequences

- A push needs a pass record first; pushing straight after a commit refuses and says what to run.
- `scripts/ci-local.sh` is the command to run before every push; `--changed` is the loop while working.
- The runner hash, which stales every pass record, covers `gate-lock.sh` and `ci-local-watchdog.sh` too.
