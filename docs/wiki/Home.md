# Feature Wiki

Feature is the `.feat` execution specification language and toolchain: specs that instruct an
agent how to build, predict every observable effect, and compile deterministically into complete
test suites — then hold the implementation to them in CI.

## Pages

- **[Core Concepts](Core-Concepts)** — prediction inversion, the dual zones, the four closed
  reference spaces, the agent contract, the spec lifecycle.
- **[Language Guide](Language-Guide)** — a guided tour of `.feat` by example; the full normative
  reference lives in-repo at `docs/grammar-reference.md`.
- **[CLI Reference](CLI-Reference)** — every command, flag, exit code, and output shape.
- **[Architecture](Architecture)** — packages, the compile pipeline, the runtime, adapters, and
  the determinism invariants.
- **[Status and Roadmap](Status-and-Roadmap)** — what is built, what is deferred, and what
  ships next.

## The elevator version

Every spec-to-test approach has a translation layer where drift and interpretation creep in —
step definitions, manual test authoring, or a model guessing what your requirements meant.
Feature removes the layer: predictions are quantified measurement contracts, the compiler is
deterministic (same spec = same tests, byte for byte), and `feat verify` makes drift a build
failure. This repository builds Feature with Feature: its components are specified in `.feat`,
their suites are generated, and its CI chain is `feat verify && feat run`.
