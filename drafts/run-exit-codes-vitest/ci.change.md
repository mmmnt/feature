# DRAFT: ci.yml and ci-local planner change for SPEC-RT-010 (owner rulings 2026-11-25: "Keep >=3.2.0 open", "CI matrix per major")

Apply after the amended SPEC-RT-010 beside this file is flipped to `agreed`.

## 1. `.github/workflows/ci.yml`: a new job, appended under `jobs:`

```yaml
  runner-vitest:
    # SPEC-RT-010: `feat run` exits 2 on a configuration error under every vitest major the peer range admits.
    # One job per proved major, plus `latest`, which fails SPEC-RT-010 when it resolves to a major the spec has
    # not proved yet (the scenarios' `ran` names the proved majors).
    name: Runner exit codes (Vitest ${{ matrix.vitest }})
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        vitest: ["3.2.7", "4.1.12", "5.1.2", "latest"]
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          cache: pnpm
      - name: Install
        run: pnpm install --frozen-lockfile
      - name: Build
        run: pnpm build
      - name: SPEC-RT-010 under Vitest ${{ matrix.vitest }}
        # The vitest under test goes in a scratch directory, never the workspace: ci-local runs every Node 24 job
        # one after another on one tree.
        run: |
          scratch=$(mktemp -d)
          npm install --prefix "$scratch" --no-save --no-package-lock --ignore-scripts --no-audit --no-fund "vitest@${{ matrix.vitest }}"
          FEAT_PROBE_VITEST="$scratch/node_modules/vitest" node packages/feature/bin/run.js run --spec SPEC-RT-010
```

- Exact versions for the proved majors (3.2.7, 4.1.12, 5.1.2): a CI run of a commit gives the same result
  tomorrow. `latest` is the one floating entry, on purpose: it is how a new major is caught (the spec's real-vitest
  scenarios predict `ran: matching "^(3\.2|4|5)\."`).
- One step for install and run: `GITHUB_ENV` written in one step is not read by the next under `ci-local.sh` (the
  planner writes the file, `scripts/ci-local-plan.mjs:326-327`, and never sources it).
- The vitest goes in `mktemp -d`, not the workspace: the local gate runs every Node 24 job one after another on one
  tree (`ci-local-plan.mjs:295-296`, `:335-338`), so a vitest installed into the workspace would change the jobs after it.
- `--ignore-scripts`: no install script of the fetched vitest runs.

## 2. `scripts/ci-local-plan.mjs`: one fix the job needs

Checked by running the planner on a copy of ci.yml with this job appended (`--node 24`): it expands the matrix to four
instances, all `JOB runner-vitest 24`, and all four in the Node 24 group, so they run locally by default. But every
instance writes its step files as `<key>-step-<n>.sh` and logs to `<key>-<node>.log`, so the four overwrite each other:
the generated driver runs `runner-vitest-step-06.sh` four times, and that file holds the last instance's command
(`vitest@latest`). Today no job has a matrix dimension other than `node`, so this never showed. The fix: name an
instance's files and log by its key and its matrix values other than `node` (`runner-vitest-3.2.7-step-06.sh`,
`runner-vitest-3.2.7-24.log`).

## 3. What runs locally (`scripts/ci-local.sh`)

- The default selection is the Node of `.tool-versions` (24). The job sets `node-version: 24`, so all four
  instances run locally by default, after the other Node 24 jobs, one after another, and each repeats Install and
  Build (they share no prefix with the other jobs' steps). Expect roughly four more install-and-build cycles plus
  four nested `feat run --spec SPEC-RT-010` per gate run.
- `--node 22` or `--node 26` leaves them out as OFF lines (they are Node 24 instances); `--all` runs them once, as
  Node 24.
- Each instance needs the npm registry from the container (`npm install vitest@…`).
- `latest` makes the local gate depend on the registry's `latest` tag: the day a vitest 6 ships, the local gate and
  CI turn red on every commit until SPEC-RT-010 is amended. That is the catch the owner asked for, and its cost.
