# @mmmnt/feat-adapter-fs

Filesystem service adapter for [Feature](https://github.com/mmmnt/feature), the `.feat` execution
specification language. It observes a directory tree during the capture window by taking a
snapshot when the window opens and another when it closes. Every file that was created, modified
or deleted in between is a captured record. A file the spec did not predict, such as a stray temp
file or an unexpected write, fails the case by prediction inversion.

The adapter observes. It never writes to the tree, and it cannot seed it.

## Install

```sh
npm install --save-dev @mmmnt/feat-adapter-fs
```

Requires Node 20 or later and `@mmmnt/feature` in the project. The adapter has no runtime
dependencies beyond `@mmmnt/feat-types`.

## Configuration

```jsonc
// feat.config.json
"services": {
  "filesystem": {
    "adapter": "@mmmnt/feat-adapter-fs",
    "consistency": "acid",
    "options": { "scope": "output" }
  }
}
```

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `options.scope` | string | `"."` | Directory to watch, relative to the project root (the directory holding `feat.config.json`). |

`scope` is the only option. Declare the service `acid`: the adapter reads the tree as soon as the
stimulus returns and does not wait for anything.

These names are never descended into, wherever they appear under `scope`: `node_modules`, `dist`,
`.turbo`, `.git`, `coverage`, `reports`. If your output lives in a directory with one of these
names, point `scope` at a different directory.

## Example

```feat
feat 1.0

spec SPEC-RPT-001 "Export a report"
context Reports
aggregate Report
type command
status agreed

construct:
  handler at src/export.mjs
  touches src/**

enforce:
  an export writes exactly one file

contract:
  input ExportInput
  response ExportResult
  record FileRow

scenario "the export writes one csv":
  when: ExportReport { name: "q3" }
  predict success:
    response 200 ExportResult { name: "q3" }
    filesystem has [ FILE_WRITTEN with FileRow { path: "q3.csv" } ]
```

`path` is relative to `scope`, with `/` separators on POSIX. A scenario that writes nothing
predicts `filesystem has []`. A file the handler writes beyond the one predicted fails the case.

## What it captures

| Record `type` | When | `key` and `payload` |
| --- | --- | --- |
| `FILE_WRITTEN` | A file exists now and either did not exist at `startCapture` or has a different modification time. | `key` is the path relative to `scope`. `payload` is `{ path }`. |
| `FILE_DELETED` | A file existed at `startCapture` and is gone now. | Same shape. |

Directories are not records. Only files are compared, and the comparison is by modification time
(`mtimeMs`), not by content.

## Observation modes

The adapter declares `observes = { diff: "snapshot", state: false }` (SPEC-ADPFS-001).

- **Diff is a snapshot comparison.** A file written and then deleted inside one window cancels out
  and is not reported. A rewrite that lands inside the filesystem's timestamp granularity leaves
  the modification time unchanged, so it is not reported either. Both are what "snapshot" means,
  and the evidence bundle records the mode.
- **State is not observed.** `read()` answers `null`. A `contains` prediction on this service is a
  configuration error, `MODE_UNSUPPORTED`, raised before the case has any effect:

  ```
  [MODE_UNSUPPORTED] SPEC-X-001 › "scenario" › filesystem: 'contains' asserts resulting state,
  which the adapter for 'filesystem' does not serve (observes.state is false).
  ```

  Use `has` on a `filesystem` service. To assert a file's content, have the handler return it in
  the response.

## Peek and settle

- `peekCapture()` takes a snapshot now and returns the `FILE_WRITTEN` and `FILE_DELETED` records
  that `stopCapture()` would return against the same baseline. It does not move the baseline, so
  repeated peeks and the final stop agree. With no window open it returns `[]`. The harness uses
  it for its early-exit check.
- `settle()` always resolves `false`. A completed local write is visible to the next `stat`, but a
  rewrite inside the timestamp granularity is invisible to the diff, so the adapter cannot truthfully
  vouch that every write was captured. The service is `acid`, so the harness reads it at once and
  needs no fence. Content digests in the snapshot would make `settle` answerable. That would change
  the cost and the meaning of the diff, and it is not in this release.

## Errors

| Code | Raised by | Cause |
| --- | --- | --- |
| `MODE_UNSUPPORTED` | The harness, before the case runs. | A prediction uses `contains` on this service. |
| (configuration error, no code) | `seed()` | A `seed` line targets this service: `@mmmnt/feat-adapter-fs does not support seeding`. |

The adapter defines no other codes.

## Limitations

- **No namespace.** The runner hands every adapter a per-file namespace (SPEC-RT-006). This adapter
  accepts it and ignores it: the tree is shared. Spec files that run in parallel and write to the
  same `scope` see each other's writes. Give each file its own subdirectory through the handler,
  or run them serially.
- **No seeding.** Arrange files in a `given:` `execute` step, or write them from the handler.
- **mtime comparison.** See Observation modes.
- **Unreadable paths.** A directory that cannot be listed is skipped silently.

## What changed in this release (v0.1.48, package 0.1.8)

- Declares `observes = { diff: "snapshot", state: false }`, so `contains` is refused by name
  instead of silently reading nothing (SPEC-ADPFS-001, SPEC-RT-002, ADR-0023).
- Adds `peekCapture()` (ADR-0020).
- Adds `settle()`, which always declines (ADR-0021).
- `startCapture` accepts the spec type the harness passes (ADR-0011) and ignores it.

## Specs

- [SPEC-ADPFS-001, peek and settle](https://github.com/mmmnt/feature/blob/main/adapters/fs/observe.feat)
- [Grammar reference, observation modes](https://github.com/mmmnt/feature/blob/main/docs/grammar-reference.md)
- [ADR-0023, adapter interface v2](https://github.com/mmmnt/feature/blob/main/docs/adr/ADR-0023-adapter-interface-v2.md)

Part of [Feature](https://github.com/mmmnt/feature). Adapter contract:
https://github.com/mmmnt/feature/wiki/Architecture

## License

MIT
