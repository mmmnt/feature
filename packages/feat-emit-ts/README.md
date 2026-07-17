# @mmmnt/feat-emit-ts

Feat's TypeScript emitter: TestTopology + resolved schemas → a complete Vitest test file.
Deterministic to the byte — the header carries the source reference, language and emitter
versions, and a sha256 of the inputs; never a timestamp. That byte-stability is what makes
`feat verify` (regenerate + compare) a CI gate.

Emitted files are self-contained: schemas, golden fixtures, and seed data are inlined, and the
only runtime import is `@mmmnt/feat-runtime`. This package owns no runtime behavior.

```ts
import { emit } from "@mmmnt/feat-emit-ts";
```

Part of [Feature](https://github.com/mmmnt/feature) — the `.feat` execution specification
language. Docs: https://github.com/mmmnt/feature/wiki

MIT
