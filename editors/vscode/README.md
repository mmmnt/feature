# Feat for VS Code

Syntax highlighting and live, spec-anchored test feedback for `.feat` execution
specifications. The extension runs your project's `feat watch --json` and puts
each failed prediction on the `scenario` line of the spec that made it, not in
the generated test file.

## Installation

Install **Feat — execution specifications** (`mmmnt.feat-vscode`) from the
[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=mmmnt.feat-vscode),
or from [Open VSX](https://open-vsx.org/extension/mmmnt/feat-vscode) for Cursor,
Windsurf and other VS Code forks. The release workflow also builds the `.vsix` as
an artifact, which installs with `code --install-extension <file>.vsix`.

Requires VS Code 1.85 or newer. The live feedback also needs Node.js 22 or newer
on your `PATH` and [`@mmmnt/feature`](../../packages/feature/README.md) installed
in the project:

```sh
npm install --save-dev @mmmnt/feature
```

## What it does

- **Highlighting.** Registers the `feat` language for `.feat` files, with the
  TextMate grammar `source.feat` from
  [`@mmmnt/feat-grammar`](../../packages/feat-grammar/README.md) (copied in at
  build time), and comment, bracket, auto-closing and surrounding pairs from
  `language-configuration.json`.
- **Live feedback.** The extension activates in a workspace that contains a
  `feat.config.json`. It takes the first workspace folder that has a
  `feat.config.json` **at its root** and runs `node <bin> watch --json` there,
  where `<bin>` is the `feat` bin of the first `node_modules/@mmmnt/feature`
  found from that folder upward. It never fetches one with `npx`.
  - Each `run` event repaints the diagnostics of the specs it ran: every failed
    case is an error, with source `feat`, on the line `scenario "<name>"` (or
    `scenario outline "<name>"`) of its spec, carrying the first six lines of the
    violation. A case whose line cannot be found is marked at the top of the file.
  - The status bar shows `feat: starting`, `feat: green`,
    `feat: <n> violation(s)`, `feat: stopped` or `feat: not installed`.
    Clicking it starts the watch.
  - The watch's stderr and its exit go to the **Feat** output channel.
- **Without `@mmmnt/feature`** it shows an error asking you to install it as a
  dev dependency, and starts nothing.

## Commands and settings

| Command | Id | Effect |
| --- | --- | --- |
| Feat: Start watch | `feat.watch.start` | Start the watch in the folder found above. Does nothing while one runs, or when no folder has a root `feat.config.json`. |
| Feat: Stop watch | `feat.watch.stop` | Stop the watch and clear every `feat` diagnostic. |

| Setting | Type | Default | Meaning |
| --- | --- | --- | --- |
| `feat.watch.autoStart` | boolean | `true` | Start the watch when the extension activates. |

## Example

With this scenario in a spec and a handler that answers `409`, the first run (at
start) and every run after a change to a `.feat` or `.contract.json` file mark
the `scenario` line with the violation. The extension starts `feat watch`
without `--src`, so a change to the handler alone does not re-run anything:
save the spec, or stop and start the watch.

```feat
scenario "successful user creation":
  when: CreateUser { email: "alice@example.com", name: "Alice" }
  predict success:
    response 201 UserResponse { id: any uuid, email: @when.email }
    database has [ INSERT with UserRow { email: @when.email, status: "active" } ]
```

## Releases

The extension is versioned with the toolchain: when the release workflow
publishes the `@mmmnt/feat*` packages and `@mmmnt/feature`, it publishes the
extension at the same version, with that release's grammar.

## License

BSD-3-Clause. See [LICENSE](LICENSE).

Part of [Feature](../../README.md), the .feat execution specification toolchain.
