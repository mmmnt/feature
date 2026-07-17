# @mmmnt/feat-adapter-handler

Response adapter for Feat: routes a spec's `when:` stimulus to an in-process handler function.
Each command maps to a module path and export; the adapter imports the module, invokes the
export with the payload (and resolved actor context, when present), and expects the
`{ status, body }` shape predictions match against.

```jsonc
// feat.config.json
"response": {
  "adapter": "@mmmnt/feat-adapter-handler",
  "commands": {
    "CreateUser": { "module": "src/handlers/create-user.ts", "export": "createUser" }
  }
}
```

Module paths resolve from the project root (the directory containing `feat.config.json`).
This is the simplest way to run Feat against plain functions — no server required. It is
also the adapter Feature's own toolchain specs run through.

Part of [Feature](https://github.com/mmmnt/feature) — the `.feat` execution specification
language. Adapter contract: https://github.com/mmmnt/feature/wiki/Architecture

MIT
