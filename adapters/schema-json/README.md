# @mmmnt/feat-schema-json

Schema adapter for Feat: resolves the JSON Schema (draft-07) contracts a spec references and
validates payloads against them with Ajv. Contract files live beside their specs; `$ref`s are
inlined at generation time so emitted tests stay self-contained.

```jsonc
// feat.config.json
"schemas": {
  "adapter": "@mmmnt/feat-schema-json"
}
```

Schema references in a `.feat` file form one of the language's four closed reference spaces —
naming a schema this adapter can't resolve is a parse error, not a runtime surprise.

Part of [Feature](https://github.com/mmmnt/feature) — the `.feat` execution specification
language. Adapter contract: https://github.com/mmmnt/feature/wiki/Architecture

MIT
