# @mmmnt/feat-types

Shared TypeScript contracts for the Feat toolchain: the BuiltSpec intermediate representation,
`FeatConfig`, capture records, and the three adapter interfaces (`FeatResponseAdapter`,
`FeatServiceAdapter`, `FeatSchemaAdapter`).

Types only — zero dependencies, zero runtime code. The language-neutral source of truth is the
JSON Schema set in the repository (`schemas/`); these types mirror it.

```ts
import type { BuiltSpec, FeatConfig, FeatServiceAdapter } from "@mmmnt/feat-types";
```

Part of [Feature](https://github.com/mmmnt/feature) — the `.feat` execution specification
language. Docs: https://github.com/mmmnt/feature/wiki

MIT
