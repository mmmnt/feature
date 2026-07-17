# @mmmnt/feat-adapter-http

Response adapter for Feat: delivers a spec's `when:` stimulus as an HTTP request to a running
service. Commands map to `{ method, path }` routes with `{param}` substitution from the
payload (substituted params leave the body; GET/HEAD send the rest as query params). Actors
resolve to header sets; `anonymous` sends no auth headers.

```jsonc
// feat.config.json
"response": {
  "adapter": "@mmmnt/feat-adapter-http",
  "commands": {
    "CreateUser": { "method": "POST", "path": "/users" },
    "GetUser":    { "method": "GET",  "path": "/users/{userId}" }
  },
  "invoke": { "baseUrl": "http://localhost:3000" },
  "actors": { "admin": { "headers": { "authorization": "Bearer …" } } }
}
```

The HTTP response is normalized to the `{ status, body }` shape predictions match against.
Use this to point Feat at any service that speaks HTTP, regardless of implementation language.

Part of [Feature](https://github.com/mmmnt/feature) — the `.feat` execution specification
language. Adapter contract: https://github.com/mmmnt/feature/wiki/Architecture

MIT
