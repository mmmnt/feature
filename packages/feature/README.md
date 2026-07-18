# @mmmnt/feature

The `feat` CLI — the toolchain for the `.feat` execution specification language. A `.feat` file
instructs how a feature is built, predicts every observable effect it will produce, and compiles
deterministically into complete test suites. Anything unpredicted is a failure.

```sh
npm install --save-dev @mmmnt/feature
npx feat init        # scaffolds config + a first spec, installs everything else

npx feat generate    # compile specs into test files
npx feat run         # execute them with the adapter lifecycle
```

`feat init` detects your package manager (npm/pnpm/yarn) and installs the
runtime, starter adapters, and test runner; `--no-install` prints the command
instead.

## Commands

`init` · `parse` · `generate` · `verify` (CI byte-lock) · `run` (`--spec`, `--coverage`) ·
`report` (`--junit`) · `audit` · `lint` · `fmt` (`--check`) · `watch` · `diff`

Exit codes everywhere: `0` success · `1` validation failure · `2` configuration error.

## Documentation

- Repository: https://github.com/mmmnt/feature
- Getting started, language guide, CLI reference: https://github.com/mmmnt/feature/wiki

MIT
