# @mmmnt/feat-runtime

The library generated Feat tests import: config loading, config-driven adapter loading
(`createAdapter` contract), the capture-window harness, precondition execution, and the
prediction matcher. Deliberately light — it rides in every consumer's test process.

You normally don't use this package directly: `feat generate` emits test files whose only
import is this runtime. Each generated suite creates its own harness, and every test runs the
same choreography — reset, preconditions, capture window, stimulus, consistency-aware capture
sweep, prediction diff — with failures anchored to exact spec coordinates.

```ts
import { createHarness } from "@mmmnt/feat-runtime";
```

Part of [Feature](https://github.com/mmmnt/feature) — the `.feat` execution specification
language. Docs: https://github.com/mmmnt/feature/wiki

MIT
