# Changesets

Every `@mmmnt/feat*` package and `@mmmnt/feature` share one version (the `fixed` group in
`config.json`). You rarely write a changeset by hand: after CI passes on `main`, `release.yml`
writes one from the commit title (`feat` → minor; `fix`, `perf`, `refactor` → patch; `!` or a
`BREAKING CHANGE:` footer → major) and the mmmnt bot opens or updates the
`chore: version packages` pull request. Merging that pull request publishes every package to npm
and creates one `vX.Y.Z` tag and GitHub Release.

To describe a change in your own words instead, run `pnpm changeset` and commit the file it
writes; a commit that adds a changeset gets no generated one.
