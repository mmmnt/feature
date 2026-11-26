# @mmmnt/feature

## 0.18.1

### Patch Changes

- fix(core): a second given: in a scenario, and a second ordering for one service across its has and contains lines, are MALFORMED_SYNTAX at the second line naming the first (ADR-0040 amendment)
- Updated dependencies []:
  - @mmmnt/feat-analyze@0.18.1
  - @mmmnt/feat-core@0.18.1
  - @mmmnt/feat-derive@0.18.1
  - @mmmnt/feat-emit-ts@0.18.1
  - @mmmnt/feat-runner@0.18.1
  - @mmmnt/feat-runtime@0.18.1
  - @mmmnt/feat-types@0.18.1

## 0.18.0

### Minor Changes

- feat(grammar): the TextMate grammar scopes every keyword the parser reads, in the forms it reads it, and leaves the same word in prose alone (SPEC-GRM-001): variables:, an indented given: and examples:, random seed, a given's seed and its from, needs, register … in, emit to, a contract's stream and from, imports … from, a fault's once, times and until reset, dotted and lowercase record types, a bare any, when (as <actor>):, touches without indentation; strings are JSON strings with their escapes and the ${name} reference inside them; deliver … to response is the response role, never a service; a comment is # as the first non-blank character only

- feat(stdio-jsonrpc): SPEC-RPC-002, HostRegistry takes an injected Clock as its second constructor parameter, and the timeout scenarios advance a manual clock on events instead of racing wall time (ADR-0041, owner ruling 13)

- feat(init): SPEC-INIT-001 agreed and built: feat init scaffolds a starter handler that loads in any package

- feat(core): the parser refuses what it silently dropped, replaced or rewrote (ADR-0040): a scenario with no predict is MISSING_MINIMUM at its opener; every quoted string is a JSON string, \uXXXX decoded and any other escape MALFORMED_SYNTAX; a second when:, predict, response, has or contains for one service, clock at, random seed or header directive is MALFORMED_SYNTAX naming the first; a trailing # comment on a line read by keyword is MALFORMED_SYNTAX; header directives are read in the header only

### Patch Changes

- fix(fault-proxy): SPEC-FPX-001, the probe reads traffic only after the echo server has seen each proxied connection close, and a send's outcome is its first client event, with the 300 ms bound only where a Timeout is armed (owner rulings 14 and 15; issue [#4](https://github.com/mmmnt/feature/issues/4))

- fix(runner): SPEC-RT-010 amended and agreed: feat run exits 2 on a configuration error under vitest 4 and 5, as under 3.2
- Updated dependencies []:
  - @mmmnt/feat-analyze@0.18.0
  - @mmmnt/feat-core@0.18.0
  - @mmmnt/feat-derive@0.18.0
  - @mmmnt/feat-emit-ts@0.18.0
  - @mmmnt/feat-runner@0.18.0
  - @mmmnt/feat-runtime@0.18.0
  - @mmmnt/feat-types@0.18.0

## 0.17.1

### Patch Changes

- fix(extension): the marketplace listing is Feature's, its links resolve, and it carries a changelog
- Updated dependencies []:
  - @mmmnt/feat-analyze@0.17.1
  - @mmmnt/feat-core@0.17.1
  - @mmmnt/feat-derive@0.17.1
  - @mmmnt/feat-emit-ts@0.17.1
  - @mmmnt/feat-runner@0.17.1
  - @mmmnt/feat-runtime@0.17.1
  - @mmmnt/feat-types@0.17.1

## 0.17.0

### Minor Changes

- [#22](https://github.com/mmmnt/feature/pull/22) [`41c416f`](https://github.com/mmmnt/feature/commit/41c416fc5880ed3d9d48b3b81e90175dbfcb6cad) Thanks [@listenrightmeow](https://github.com/listenrightmeow)! - Every @mmmnt/feat\* package and @mmmnt/feature is licensed BSD-3-Clause, as the repository is, and they are released together at one version from now on.

### Patch Changes

- Updated dependencies []:
  - @mmmnt/feat-analyze@0.17.0
  - @mmmnt/feat-core@0.17.0
  - @mmmnt/feat-derive@0.17.0
  - @mmmnt/feat-emit-ts@0.17.0
  - @mmmnt/feat-runner@0.17.0
  - @mmmnt/feat-runtime@0.17.0
  - @mmmnt/feat-types@0.17.0
