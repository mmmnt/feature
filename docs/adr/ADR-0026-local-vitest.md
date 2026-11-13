# ADR-0026 — the runner runs the project's own vitest and never fetches one

Status: Accepted (founder ruling 9ec54eb1, 2026-11-13: "Fix in Feature (Recommended)"). Built in
SPEC-RT-010 (new).

## Context

`feat run` hands the generated suites to `@mmmnt/feat-runner`, which spawned `npx vitest run` from the
project root. npx runs a locally installed vitest when there is one. When there is none it does not fail:
it prints `npm warn exec The following package was not found and will be installed: vitest@<latest>` and
fetches the latest vitest from the registry, at run time. That code is outside the project's lockfile,
its release-age policy and any review of its supply chain, and it is a different version on every day a
new vitest is published. A consumer on pnpm with a strict lockfile and a release-age policy found it:
`feat run` printed the warning and ran vitest 5.1.0, which the project had never installed.

vitest was declared nowhere a consumer would see it: a devDependency of `@mmmnt/feature`, not a
dependency or a peer of `@mmmnt/feature` or `@mmmnt/feat-runner`. `feat init` installs it, so a project
that started there has it; one that added Feature by hand need not.

## Decision

1. The runner resolves vitest from the project root as an ES module `import "vitest"` from a file at the
   root would: `<dir>/node_modules/vitest/package.json` for the root and then each parent directory, the
   first found. A workspace that hoists vitest to its root is served. `NODE_PATH` and the global folders
   are not read, since the generated suites' own `import "vitest"` never reads them.
2. It runs the file the package's `bin` names (`bin.vitest`, or `bin` when it is a string) with the Node
   that runs the runner, `process.execPath`. No npx, `npm exec`, `pnpm dlx` or shell is involved, on any
   platform, so the Windows `npx.cmd` shell path goes too.
3. When vitest is not found, the runner spawns and writes nothing and refuses with a configuration error,
   `Configuration error (exit 2): [VITEST_NOT_INSTALLED] ...`, which tells the user to add vitest as a dev
   dependency of the project. `runTests` returns `exitCode: 2`, `configurationError: true` and
   `refusal: { code, message }`; `feat run` exits 2. It is checked once per run, after the zero-files
   check and before the first pass.
4. vitest is a peer dependency of `@mmmnt/feat-runner` and `@mmmnt/feature`, range `>=3.2.0`. The
   repository tests against 3.2; the runner's config-error reporter uses `onFinished`, which vitest 5.1
   still calls. The range has no upper bound because the runner pins nothing of vitest's beyond its CLI
   flags and that reporter hook; a consumer's lockfile decides the version.

## Consequences

- A project without vitest that ran green through a fetched vitest now exits 2 until it adds vitest as a
  dev dependency. That is the fix: what runs is what the project installed.
- Package managers that install peers (pnpm by default, npm 7 and later) add vitest to a consumer's
  lockfile when they install Feature, where its version and age are under the project's policy; one that
  does not warns about the missing peer.
- Other places that started a tool through npx follow the same rule (amendment below).

## Amendment (founder rulings 2026-11-13, "Ship v0.1.54 (Recommended)" and "Fix both in v0.1.54 (Recommended)")

The same rule holds wherever Feature starts a tool on the user's behalf:

1. `@mmmnt/feat-cdk`'s SynthStack handler fell back to `npx cdk synth` when `aws-cdk` did not resolve, and
   npx fetched the npm package `cdk`, which is not `aws-cdk`. It now finds `aws-cdk` from the app directory
   upward as the runner finds vitest, runs its `cdk` bin with `process.execPath`, and otherwise throws
   `Configuration error (exit 2): [AWS_CDK_NOT_INSTALLED] ...` before writing or spawning anything. An
   explicit `invoke.cdkBin` is the user's own choice and still runs (SPEC-CDK-001).
