# Feat for VS Code

Syntax highlighting for `.feat` execution specifications, plus live
spec-anchored feedback: the extension runs `feat watch --json` behind the
scenes and paints prediction violations **in the spec** — a failing scenario
squiggles its `scenario "…"` line, not the generated test file. The spec
becomes a live document of whether the implementation currently honors it.

## Setup

1. Install this extension.
2. Open a project with a `feat.config.json` and `@mmmnt/feature` installed.

That's the whole setup. The watch process starts automatically (disable with
`feat.watch.autoStart`), regenerates on spec changes, reruns affected suites,
and the status bar shows green / violation count. `Feat: Start watch` /
`Feat: Stop watch` control it manually.

Part of [Feature](https://github.com/mmmnt/feature) — the `.feat` execution
specification language.
