# @mmmnt/feat-derive

Feat's derivation stage: BuiltSpec IR + FeatConfig → TestTopology. Pure and deterministic —
no I/O, no clock, no randomness. Expands scenario outlines (placeholder substitution in
payloads, value blocks, rejection IDs, and matching-arguments), resolves ordering semantics
from each service's consistency model, and synthesizes the implicit zero-side-effect
assertions for query specs.

```ts
import { derive } from "@mmmnt/feat-derive";

const topology = derive(builtSpec, featConfig);
```

Part of [Feature](https://github.com/mmmnt/feature) — the `.feat` execution specification
language. Docs: https://github.com/mmmnt/feature/wiki

MIT
