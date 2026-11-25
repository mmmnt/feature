# Contributing to Feature

Thank you for your interest in contributing to Feature.

## License

Feature is licensed under the [BSD 3-Clause License](LICENSE). By submitting a contribution (a pull
request, an issue, or any other way), you agree that it is provided under the same license. Every
published `@mmmnt` package ships the same `LICENSE`.

## Development setup

Requirements:

- Node.js 22 or newer (CI tests on Node 22, 24 and 26)
- pnpm 10.33.0 (the version pinned in `packageManager`; `corepack enable` selects it)
- Docker, for the local gate and the adapters' instrument tests

```bash
pnpm install
pnpm build              # every package, through turbo
pnpm typecheck
pnpm test               # each package's own tests
pnpm corpus:validate    # the corpus against schemas/
node packages/feature/bin/run.js verify   # the generated suites match their specs
node packages/feature/bin/run.js run      # and their predictions hold
```

To work on one package, filter by name: `pnpm --filter @mmmnt/feat-core test`.

## Specs are the unit of work

Feature is built spec-driven on itself.

- Build only specs whose status is `agreed`, and only inside their `touches` globs.
- When a spec is ambiguous, stop and ask. Never guess, and never annotate the spec to cover a guess.
- [`docs/grammar-reference.md`](docs/grammar-reference.md) is the source of truth for the language.
- A change to the language is complete only when all four layers close in the same change: the grammar reference, a corpus exemplar in [`corpus/`](corpus), the parser and IR, and the whole corpus re-validated.
- A design change comes with an ADR in [`docs/adr/`](docs/adr) and an entry in its [index](docs/adr/README.md).

## The local gate

Run the full gate before every push:

```bash
git config core.hooksPath .githooks   # once per clone: pre-push and commit-msg
scripts/ci-local.sh                   # the ubuntu jobs of ci.yml, in containers, on HEAD
git push
```

A passing run leaves a pass record for the commit. The `pre-push` hook only checks that the record
exists; it runs nothing. CI also checks the Node versions and the Windows job that the local gate
leaves out.

## Commits and releases

Commit titles follow [Conventional Commits](https://www.conventionalcommits.org/), and they decide
the release. The `commit-msg` hook checks them with commitlint (`commitlint.config.mjs`):

- **Types:** `feat`, `fix`, `perf`, `refactor`, `test`, `spec`, `docs`, `ci`, `build`, `chore`, `revert`
- **Scopes:** optional and free, usually the package or adapter (`fix(kurrent): …`)
- Titles and bodies may be long, and a subject may start with a spec id or an error code.

For example: `feat(stdio-jsonrpc): fault shape C carries untilReset`.

Every `@mmmnt` package is in one fixed version group and is released at the same version.

- After CI passes on `main`, `release.yml` writes a changeset from the commit title:
  - `feat` → minor;
  - `fix`, `perf` or `refactor` → patch;
  - `!` or a `BREAKING CHANGE:` footer → major.
- To describe a change in your own words instead, run `pnpm changeset` and commit the file. A commit that adds a changeset gets no generated one.
- The mmmnt bot opens or updates the **chore: version packages** pull request.
- Merging that pull request publishes every package to npm with provenance. It also creates one `vX.Y.Z` tag and GitHub Release, and publishes the VS Code extension at that version. Never push release tags by hand.

Commits on `main` must be signed, so configure commit signing (GPG or SSH) before you open a pull
request.

## Package READMEs and the wiki

The [wiki](https://github.com/mmmnt/feature/wiki) mirrors the repository on every push to `main`
that changes one of its sources:

- every package README under `packages/`, `adapters/`, `editors/` and `actions/`;
- the ADR index;
- the grammar reference;
- the evidence bundle.

Don't edit a generated page (it starts with "This page is generated from …"); change its source
instead. To preview a sync against a local clone of the wiki, run
`node scripts/wiki-sync.mjs --wiki-dir <path> --dry-run`.

## How to contribute

1. **Fork** the repository.
2. **Create a branch** from `main` for your change.
3. **Make your change** with its spec, tests and docs, and run the local gate.
4. **Open a pull request.** CI must pass, and a pull request needs an approving review before it merges.

## Reporting issues

If you find a bug or have a feature request, please open an issue on the GitHub repository.
Report security issues privately through the repository's
[security advisories](https://github.com/mmmnt/feature/security/advisories/new).
