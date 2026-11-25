# @mmmnt/feat-adapter-fs

The filesystem service adapter for Feature. It snapshots a directory tree when the capture window opens and again when it closes, and reports every file created, modified or deleted in between as a captured record. A file the spec did not predict (a stray temp file, an unexpected write) fails the case by prediction inversion. The adapter observes; it writes to the tree only when `clearOnReset` is on, and it cannot seed.

## Installation

Requires Node.js 22.15 or newer (archive members need `zlib.zstdDecompressSync`).

```bash
npm install -D @mmmnt/feat-adapter-fs
```

`feat init` installs it as the starter project's `filesystem` service.

## Usage

```jsonc
// feat.config.json, under "services"
"filesystem": {
  "adapter": "@mmmnt/feat-adapter-fs",
  "consistency": "acid",
  "options": { "scope": "output" }
}
```

```feat
scenario "the export writes one csv":
  when: ExportReport { name: "q3" }
  predict success:
    response 200 ExportResult { name: "q3" }
    filesystem has [ FILE_WRITTEN with FileRow { path: "q3.csv" } ]
```

`path` is relative to `scope`, `/`-separated on POSIX. A scenario that writes nothing predicts `filesystem has []`. Declare the service `acid`: the tree is read as soon as the stimulus returns.

## Options

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `scope` | string | `"."` | Directory to watch, relative to the project root (the directory holding `feat.config.json`). |
| `archives` | string[] | none | Globs (`path.posix.matchesGlob`, against the path relative to `scope`). A written file that matches one is read as a tar+zstd archive and reported with its members. |
| `clearOnReset` | boolean | `false` | Empty the scope at every reset, so each case starts from an empty tree. The scope must be strictly inside the project root. |

These names are never descended into, at any depth under `scope`: `node_modules`, `dist`, `.turbo`, `.git`, `coverage`, `reports`.

## Records

| `type` | When | `key` and `payload` |
| --- | --- | --- |
| `FILE_WRITTEN` | A file exists now and did not at `startCapture`, or its `mtimeMs` changed. | `key` is the path relative to `scope`; `payload` is `{ path }`, or `{ path, members }` for a matching archive. |
| `FILE_DELETED` | A file existed at `startCapture` and is gone. | Same shape, `{ path }`. |
| `ARCHIVE_UNREADABLE` | A written file matches `archives` but cannot be read in full. | `payload` is `{ path, reason, member? }`. |

Records come in path order, the written ones first, then the deleted ones. Directories are not records. The comparison is by modification time, not content.

### Archive members

`members` lists the archive's regular files in archive order, each named by its path in the archive:

| Member name | Member |
| --- | --- |
| ends `.json` | `{ name, json: <the parsed value> }` |
| ends `.jsonl` | `{ name, lines: [<each line parsed>] }`; a final newline adds no line, `\r\n` is accepted |
| anything else | `{ name, text: <the content as UTF-8> }` |

Long names are read from a ustar prefix, a GNU long-name entry or a pax `path` header.

```feat
files has [ FILE_WRITTEN with ArchiveRow { path: "export.flmnt", members: [
  { name: "workspaces.jsonl", lines: [{ id: "w-1" }] }
] } ]
```

An archive is never skipped or partly reported. `reason` is one of:

| `reason` | Cause |
| --- | --- |
| `zstd` | The file cannot be read, or is not whole zstd frames (not zstd, cut short, empty). |
| `tar` | A header checksum is wrong, a size runs past the data, or an entry is neither a regular file nor a directory (`member` names it). |
| `json` | A `.json` member, or a line of a `.jsonl` member, does not parse (`member` names it). |
| `utf8` | A text member is not valid UTF-8 (`member` names it). |

## Observation

The adapter declares `observes = { diff: "snapshot", state: false }` (ADR-0023).

- **Snapshot diff.** A file written and deleted inside one window cancels out. A rewrite inside the filesystem's timestamp granularity leaves the mtime unchanged and is not reported.
- **No state.** `read()` answers `null`, so a `contains` prediction on this service is the harness's `MODE_UNSUPPORTED` configuration error, raised before the case runs. Use `has`; to assert a file's content, return it in the response.
- `peekCapture()` returns what `stopCapture()` would, without moving the baseline. Both return `[]` with no window open.
- `settle()` always resolves `false`: an mtime diff cannot vouch that every write was seen.

## Errors

| Code | Raised by | Cause |
| --- | --- | --- |
| `OPTIONS_INVALID` | `setup()` | `archives` is not an array of non-empty strings, or `clearOnReset` is not a boolean. |
| `CLEAR_SCOPE_UNSAFE` | `setup()` | `clearOnReset` is on and `scope` is the project root, an ancestor of it, or outside it. |
| `CLEAR_FAILED` | `reset()` | `clearOnReset` is on and the scope is not a directory, or an entry cannot be removed. |
| `MODE_UNSUPPORTED` | The harness | A `contains` prediction on this service. |
| (no code) | `seed()` | `@mmmnt/feat-adapter-fs does not support seeding — configuration error.` |

The coded refusals are `FsAdapterError`s carrying `code`.

## Limitations

- **No namespace.** The runner's per-file namespace is accepted and ignored; spec files that run in parallel against the same `scope` see each other's writes.
- **No seeding.** Arrange files with a `given:` `execute` step.
- **Unlistable directories** are skipped silently.

## See also

- Specs: [observe.feat](observe.feat) (SPEC-ADPFS-001), [archive.feat](archive.feat) (SPEC-ADPFS-002)
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
pnpm build --filter=@mmmnt/feat-adapter-fs
pnpm --filter @mmmnt/feat-adapter-fs test
```

## License

BSD-3-Clause. See [LICENSE](LICENSE).

Part of [Feature](../../README.md), the .feat execution specification toolchain.
