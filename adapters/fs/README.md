# @mmmnt/feat-adapter-fs

Filesystem service adapter for Feat: observes a directory tree during the capture window by
snapshotting before and after the stimulus, then reports every created, modified, or deleted
file as a captured effect. Anything a spec didn't predict — a stray temp file, an unexpected
write — surfaces as a prediction violation.

```jsonc
// feat.config.json
"services": {
  "filesystem": {
    "adapter": "@mmmnt/feat-adapter-fs",
    "consistency": "acid",
    "options": { "scope": "output" }
  }
}
```

`scope` is relative to the project root and bounds what the adapter watches. Dependency and
build directories (`node_modules`, `dist`, coverage output, etc.) are excluded.

Part of [Feature](https://github.com/mmmnt/feature) — the `.feat` execution specification
language. Adapter contract: https://github.com/mmmnt/feature/wiki/Architecture

MIT
