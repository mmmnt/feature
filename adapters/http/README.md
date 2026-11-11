# @mmmnt/feat-adapter-http

Response adapter for [Feature](https://github.com/mmmnt/feature), the `.feat` execution
specification language. It delivers a spec's `when:` stimulus as an HTTP request to a running
service and reads the reply as the response that predictions match against. Use it to point Feature
at any service that speaks HTTP, whatever language it is written in.

It drives the service. It does not observe what the service does behind the API. Pair it with
service adapters (DynamoDB, Kafka, Kurrent, the filesystem, ...) to predict the full footprint of a
request.

## Install

```sh
npm install --save-dev @mmmnt/feat-adapter-http
```

Requires Node 20 or later (the adapter uses the global `fetch`) and `@mmmnt/feature` in the project.
The service under test must already be running when `feat run` starts. The adapter does not start it.

## Configuration

```jsonc
// feat.config.json
"response": {
  "adapter": "@mmmnt/feat-adapter-http",
  "commands": {
    "CreateUser": { "method": "POST", "path": "/users" },
    "GetUser":    { "method": "GET",  "path": "/users/{userId}" }
  },
  "invoke": {
    "baseUrlEnv": "FEAT_API_URL",
    "headers": { "x-client": "feat" }
  },
  "actors": {
    "default": "admin",
    "admin": { "headers": { "authorization": "Bearer test-admin" } }
  }
}
```

| Key | Type | Meaning |
| --- | --- | --- |
| `commands.<Name>.method` | string | HTTP method. Case-insensitive. |
| `commands.<Name>.path` | string | Path, appended to the base URL. `{param}` placeholders (letters, digits, underscore) are filled from the payload. |
| `invoke.baseUrl` | string | The origin, literally. |
| `invoke.baseUrlEnv` | string | The name of an environment variable that holds the origin. |
| `invoke.headers` | object | Headers sent on every request. |
| `actors.<name>.headers` | object | Headers added for that actor. Actor headers override `invoke.headers`. |
| `actors.default` | string | The actor used when a scenario has no `as` clause. |

Give `baseUrl` or `baseUrlEnv`, not both. Origins belong to the environment (a deployed stage URL, an
emulator gateway), so a per-tier config usually names a variable, and the committed config stays the
same everywhere. With neither set, the base URL is the empty string and the request is sent to the bare
path, which `fetch` rejects. Treat that as a misconfiguration.

## Requests

- **Path parameters.** Each `{name}` is replaced by the URL-encoded payload value `name`. A substituted
  field is removed from the body. A placeholder whose field is missing is replaced by the string
  `undefined`.
- **GET and HEAD.** The remaining payload fields are sent as query parameters, each value converted
  with `String()`. There is no body.
- **Every other method.** The remaining payload is sent as a JSON body with
  `content-type: application/json`.
- **Actors.** The headers are `invoke.headers`, then the actor's `headers` on top. `as anonymous`
  sends no actor headers, only `invoke.headers`. A scenario with no `as` uses `actors.default`. If
  that is unset, only `invoke.headers` are sent. Only `headers` is read from an actor entry. A token
  goes in as a header, such as `authorization`.
- **Redirects, cookies, timeouts.** `fetch` defaults apply. Nothing is configurable here.

## Responses

The reply is normalised to `{ status, body }`:

- `status` is the numeric HTTP status code.
- `body` is the parsed JSON object. An empty body is `null`. A body that is not JSON becomes
  `{ "raw": "<the text>" }`. Response headers are not exposed.

So `response 201 UserResponse { ... }` in a spec is matched against the status code and the parsed
body, and the body is validated against the named schema.

## Example

Against a service on `http://127.0.0.1:3000`:

```sh
FEAT_API_URL=http://127.0.0.1:3000 npx feat run
```

```feat
feat 1.0

spec SPEC-USR-001 "Create and read a user"
context Users
aggregate User
type command
status agreed

construct:
  handler at src/users.ts
  touches src/**

enforce:
  only an admin creates a user

contract:
  input CreateUserInput
  response UserResponse
  error ErrorResponse

scenario "an admin creates a user":
  when: CreateUser { email: "alice@example.com" }
  predict success:
    response 201 UserResponse { userId: "u-1", email: @when.email }
    bus has []

scenario "an anonymous caller is refused":
  when (as anonymous): CreateUser { email: "bob@example.com" }
  predict rejection UNAUTHORIZED:
    response 401 ErrorResponse { error: "UNAUTHORIZED" }
    bus has []
```

`bus` is a service declared under `services` in the same config (a rejection must state zero effects
on every service).

## Errors and refusals

| Message | Cause |
| --- | --- |
| `@mmmnt/feat-adapter-http: invoke.baseUrl and invoke.baseUrlEnv are mutually exclusive — configuration error.` | Both are set. |
| `@mmmnt/feat-adapter-http: environment variable <NAME> is not set (invoke.baseUrlEnv) — configuration error.` | The named variable is unset or empty. Raised on the first request, not at load. |
| `Command '<name>' is not routed in response.commands — configuration error.` | The command is not in `response.commands`. The parser normally catches this first. |

The adapter defines no error codes. A connection failure is the error `fetch` throws and it fails the
case. An HTTP error status is not an error here: it is a response, and a spec predicts it with
`predict rejection` or `predict error`.

## Limitations

- **No clock.** The adapter has no `setClock`, so `clock at` against this adapter is a
  `CLOCK_UNSUPPORTED` configuration error. A remote service needs its own test-time hook.
- **No namespace.** The runner's per-file namespace (SPEC-RT-006) is accepted and ignored. The service
  must isolate its own data. The service runs in another process, so it does not see the runner's
  environment.
- **JSON only.** Request bodies are JSON. Form-encoded or multipart bodies are not supported.
- **No retries, no polling.** One request per stimulus.

## What changed in this release (v0.1.48, package 0.1.9)

No source change in this release. It is republished as 0.1.9 against `@mmmnt/feat-types` 0.2.0, with this README. The behaviour is as of 0.1.8, which added `invoke.baseUrlEnv`
(API origins belong to the environment).

## Specs

- [Grammar reference, command routing and actors](https://github.com/mmmnt/feature/blob/main/docs/grammar-reference.md)
- [ADR-0023, adapter interface v2](https://github.com/mmmnt/feature/blob/main/docs/adr/ADR-0023-adapter-interface-v2.md)

Part of [Feature](https://github.com/mmmnt/feature). Adapter contract:
https://github.com/mmmnt/feature/wiki/Architecture

## License

MIT
