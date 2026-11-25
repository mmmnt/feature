# @mmmnt/feat-adapter-http

The HTTP response adapter for Feature. It sends a spec's `when:` stimulus (and each `execute` line of a `given:`) as an HTTP request to a running service and normalizes the reply to the `{ status, body }` that a scenario's `response` line is matched against. Use it to run `.feat` specs against any service that speaks HTTP, whatever it is written in.

It drives the service; it does not observe what the service does behind the API. Pair it with service adapters (DynamoDB, Kafka, Kurrent, the filesystem, ...) to predict the full footprint of a request. The service must already be running when `feat run` starts: the adapter does not start it.

## Installation

Requires Node.js 22 or newer.

```bash
npm install -D @mmmnt/feat-adapter-http
```

## Usage

```jsonc
// feat.config.json
{
  "featVersion": "1.0",
  "schemas": { "adapter": "@mmmnt/feat-schema-json" },
  "response": {
    "adapter": "@mmmnt/feat-adapter-http",
    "commands": {
      "CreateUser": { "method": "POST", "path": "/users" },
      "GetUser": { "method": "GET", "path": "/users/{userId}" }
    },
    "invoke": { "baseUrlEnv": "FEAT_API_URL", "headers": { "x-client": "feat" } },
    "actors": {
      "default": "admin",
      "admin": { "headers": { "authorization": "Bearer test-admin" } }
    }
  },
  "services": {
    "bus": { "adapter": "@mmmnt/feat-adapter-memory", "consistency": "acid" }
  },
  "specs": { "dir": "specs", "pattern": "**/*.feat", "contractPattern": "**/*.contract.json", "outputPattern": "{name}.test.ts" }
}
```

```feat
feat 1.0

spec SPEC-USR-001 "CreateUser"
context Users
aggregate User
type command
status agreed

construct:
  handler at src/users.ts
  touches src/**

enforce:
  rejects UNAUTHORIZED when the caller is anonymous

contract:
  input CreateUserInput
  response UserResponse
  error ErrorResponse

scenario "an admin creates a user":
  when: CreateUser { email: "alice@example.com" }
  predict success:
    response 201 UserResponse { userId: any string, email: @when.email }
    bus has []

scenario "an anonymous caller is refused":
  when (as anonymous): CreateUser { email: "bob@example.com" }
  predict rejection UNAUTHORIZED:
    response 401 ErrorResponse { error: "UNAUTHORIZED" }
    bus has []
```

```bash
FEAT_API_URL=http://127.0.0.1:3000 npx feat run
```

`bus` stands for whatever services the config declares: every prediction states the effect on each of them.

## Configuration

| Key | Type | Meaning |
| --- | --- | --- |
| `commands.<Name>.method` | string | HTTP method, case-insensitive. |
| `commands.<Name>.path` | string | Path appended to the base URL. `{param}` placeholders (letters, digits, underscore) are filled from the payload. |
| `invoke.baseUrl` | string | The origin, literally. |
| `invoke.baseUrlEnv` | string | The name of an environment variable that holds the origin. |
| `invoke.headers` | object | Headers sent on every request. |
| `actors.<name>.headers` | object | Headers added for that actor, over `invoke.headers`. Only `headers` is read from an actor entry. |
| `actors.default` | string | The actor used when a trigger has no `as` clause. |

Give `baseUrl` or `baseUrlEnv`, not both. An origin belongs to the environment (a deployed stage, an emulator gateway), so a tier overlay usually names a variable. With neither set the base URL is the empty string and `fetch` rejects the bare path.

## Requests and responses

- **Path parameters.** Each `{name}` is replaced by the URL-encoded payload field `name`, and that field is removed from the body. A placeholder whose field is missing becomes the string `undefined`.
- **GET and HEAD** send the remaining fields as query parameters (`String()` of each value) and no body.
- **Every other method** sends the remaining payload as JSON with `content-type: application/json`.
- **Actors.** `invoke.headers`, then the actor's `headers` on top. `as anonymous` sends only `invoke.headers`. No `as` uses `actors.default`; with no default, only `invoke.headers`.
- **Redirects, cookies, timeouts** are `fetch`'s defaults.
- **The response** is `{ status, body }`: the numeric status code and the parsed JSON body. An empty body is `null`; a body that is not JSON is `{ "raw": "<text>" }`. Response headers are not exposed.

An HTTP error status is a response, not an adapter error: predict it with `predict rejection` or `predict error`. A connection failure is the error `fetch` throws, and it fails the case.

## Errors

| Message | Cause |
| --- | --- |
| `@mmmnt/feat-adapter-http: invoke.baseUrl and invoke.baseUrlEnv are mutually exclusive — configuration error.` | Both are set. |
| `@mmmnt/feat-adapter-http: environment variable <NAME> is not set (invoke.baseUrlEnv) — configuration error.` | The named variable is unset or empty. Raised on the first request, not at load. |
| `Command '<name>' is not routed in response.commands — configuration error.` | The command is not in `response.commands`. The parser normally catches this first. |

## Limitations

- **No clock, no random seed.** The adapter has no `setClock` and no `setSeed`, so a `clock at` precondition is the harness's `CLOCK_UNSUPPORTED` configuration error and a `random seed` precondition is `RANDOM_UNSUPPORTED`.
- **No namespace.** The runner's per-file namespace is accepted and ignored; the service must isolate its own data.
- **JSON bodies only.** No form-encoded or multipart requests.
- **One request per stimulus.** No retries and no polling.

## See also

- [Grammar reference](../../docs/grammar-reference.md): command routing and actors
- [ADR-0023](../../docs/adr/ADR-0023-adapter-interface-v2.md): adapter interface v2

## Changelog

Per-release changes are in [CHANGELOG.md](CHANGELOG.md). Every `@mmmnt` package is released at the same version.

## Contributing

This package is part of the [Feature monorepo](https://github.com/mmmnt/feature). See
[CONTRIBUTING.md](../../CONTRIBUTING.md) for the development setup, the spec-driven rules and the
local gate.

```bash
git clone https://github.com/mmmnt/feature.git
cd feature
pnpm install
pnpm build --filter=@mmmnt/feat-adapter-http
pnpm --filter @mmmnt/feat-adapter-http test
```

## License

BSD-3-Clause. See [LICENSE](LICENSE).

Part of [Feature](../../README.md), the .feat execution specification toolchain.
