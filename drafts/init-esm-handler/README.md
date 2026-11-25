# `feat init` and `"type": "module"` (DRAFT)

Status: draft, awaiting the owner. Nothing is built.

| File | |
| --- | --- |
| `packages/feature/init.feat` | SPEC-INIT-001, new, `status draft`, written for option B |
| `packages/feature/init.contract.json` | its contract (validates against `schemas/contract.schema.json`) |

## Which spec owns it

None. `feat init` (`packages/feature/src/commands/init.ts`) was built without a spec; its tests are
`packages/feature/init.test.ts` (network-free, `--no-install`). The draft is a new spec that states what init
does today and the fix, so "the init spec amendment" is the spec's first version.

## Root cause

- `packages/feature/src/commands/init.ts:12-37`: the scaffold's config routes `Greet` to `src/greet.ts` (`:19`), and
  the spec it writes says `handler at src/greet.ts` (`:48`). The README's starter handler is an ES module
  (`packages/feature/README.md:79-84`, `export async function greet`); init does not write it, "Next steps"
  tells the user to (`init.ts:196`).
- `init.ts:155-162`: a package.json init creates has no `"type"`; an existing one is left as it is.
- `adapters/handler/src/index.ts:112`: the handler adapter imports a route natively, so Node applies the
  nearest package.json's `"type"` to `src/greet.ts`.

## Reproduction (Node 24.19.0, npm 11.17.0, the worktree's CLI at main 72f71de)

```sh
mkdir app && cd app
npm init -y                       # npm 11 writes "type": "commonjs"
node <worktree>/packages/feature/bin/run.js init      # installed @mmmnt/* 0.17.0 and vitest 5.1.2
# write the README's handler to src/greet.ts; change `status draft` to `status agreed` in specs/greet.feat
node <worktree>/packages/feature/bin/run.js generate
node <worktree>/packages/feature/bin/run.js run; echo "exit=$?"
```

Output: `[ROUTE_UNLOADABLE] Route 'Greet' (module 'src/greet.ts', export 'greet') cannot be imported:
Unexpected token 'export' — configuration error.`, `Tests 2 skipped (2)`, `exit=1`. (Exit 1 rather than 2 is
the Vitest 5 reporter defect in `drafts/run-exit-codes-vitest`.)

Controls, same steps:

| package.json before `feat init` | Result |
| --- | --- |
| none (init writes one with no `"type"`) | 2 passed, exit 0, with Node's `MODULE_TYPELESS_PACKAGE_JSON` warning (module-syntax detection) |
| `npm init -y`, then `npm pkg set type=module` | 2 passed, exit 0 |
| `npm init -y`, handler written as `src/greet.mts`, the route and `handler at` changed to it | 2 passed, exit 0, no warning |

## Decisions for the owner

1. **When init creates package.json.** Set `"type": "module"`. (Recommended; no alternative proposed: init
   owns that file, and the scaffold is an ES module.)
2. **When package.json exists and is not `"type": "module"` (`"commonjs"`, or no `"type"`).**
   - **B. Scaffold the handler as an ES module whatever the package says: route and `handler at` are
     `src/greet.mts`, package.json is untouched, and init prints why (Recommended).** The project's module
     system is the project's: init does not change how its other files load, and `feat init` still ends
     in a project that runs. `.mts` because the starter handler is TypeScript; `.mjs` if the owner wants a
     JavaScript starter.
   - A. Refuse before writing anything: exit 2 with a new code, e.g. `PACKAGE_NOT_ESM`, and the guidance
     `set "type": "module" in package.json (npm pkg set type=module) and run feat init again`. Under A the
     spec's scenarios 2 and 3 become rejections:

     ```
     scenario "a CommonJS package.json is refused before anything is written":
       when: InitProject { packageJson: "commonjs" }
       predict rejection PACKAGE_NOT_ESM:
         response ERR InitProjectError { code: "PACKAGE_NOT_ESM", detail: matching "npm pkg set type=module", exit: 2, type: "commonjs" }
         filesystem has []
     ```

     and a typeless package.json is refused the same way (or let through, relying on Node's detection and its
     warning: a sub-decision).
   - Not proposed: init writing `"type": "module"` into an existing package.json. It changes how every `.js`
     file of the project loads.
3. **A package.json with no `"type"`.** Under B it is treated as not-module (`.mts`), which avoids Node's
   detection and its warning. The alternative is to treat it as module (`.ts`), as it works today on Node 24
   by detection.
4. **Should init write the starter handler?** Today the user writes it from the README. Writing it (at the
   routed path) would make the scaffold run with no copy and paste; it is a scope addition, not part of the
   bug, and the spec as drafted does not do it.
5. **Vitest range.** If the owner takes decision 2A of `drafts/run-exit-codes-vitest` (peer range
   `>=3.2.0 <6`), init should install `vitest@">=3.2.0 <6"` instead of `latest`. Not in this draft's scenarios.
6. **ADR.** Not needed: no language change; the scaffold's file name is a CLI behaviour stated by this spec.
