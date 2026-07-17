# @mmmnt/feat-runner

Feat's test runner orchestration: a thin `vitest run` subprocess wrapper with file selection,
JUnit reporter wiring, coverage passthrough, and exit-code passthrough. Generated tests own
their lifecycle — the runner deliberately does nothing else.

You normally reach this through `feat run` rather than directly.

```ts
import { runTests } from "@mmmnt/feat-runner";

const result = runTests({ files, root, junitOutput: "reports/feat-junit.xml" });
```

Part of [Feature](https://github.com/mmmnt/feature) — the `.feat` execution specification
language. Docs: https://github.com/mmmnt/feature/wiki

MIT
