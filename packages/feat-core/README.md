# @mmmnt/feat-core

The `.feat` parser: source text → BuiltSpec intermediate representation. Deterministic,
hand-rolled recursive descent; enforces the language's four closed reference spaces (services,
schemas, commands, actors) at parse time with twelve coded errors, each carrying a line number
and a hint.

```ts
import { parse } from "@mmmnt/feat-core";

const result = await parse({ spec: "specs/create-user.feat", config: "feat.config.json" });
// { status: "OK", body: BuiltSpec } | { status: "ERR", body: { code, message, line?, hint? } }
```

The parser's conformance suite is the repository's `corpus/` — nine exemplars, each asserted
against its expected IR. Same spec + config = identical IR, every invocation.

Part of [Feature](https://github.com/mmmnt/feature). Docs: https://github.com/mmmnt/feature/wiki

MIT
