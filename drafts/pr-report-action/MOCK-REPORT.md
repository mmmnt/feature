<!-- feat-pr-report -->
## ✅ Build report — ready for review

**PR #7** · head `abc1234` · run [#1482](https://github.com/o/r/actions/runs/1) (attempt 1) · 14 min 2 s

| | Result |
|---|---|
| Specs | **48 / 48 scenarios passed** across 2 tiers · generated tests match specs |
| CI jobs | **9 / 9 succeeded** |
| Attestations | **2 / 2 verified** (build provenance) |

<details><summary><b>Specs — unit tier</b>: 36 passed · 0 failed · 12 specs</summary>

| Spec | Status | Scenarios | Time |
|---|---|---|---|
| SPEC-MEM-022 SearchEvents | agreed | 9 / 9 ✅ | 1.2 s |
| SPEC-PRJ-004 Rebuild | agreed | 4 / 4 ✅ | 0.9 s |
| … | | | |

</details>

<details><summary><b>Specs — integration tier</b>: 12 passed · 0 failed · bound to real stores (eventstore, graph, cache)</summary>

| Spec | Status | Scenarios | Time |
|---|---|---|---|
| SPEC-MEM-022 SearchEvents | agreed | 3 / 3 ✅ | 4.8 s |
| … | | | |

</details>

<details><summary><b>CI jobs</b>: 9 succeeded</summary>

| Job | Result | Duration |
|---|---|---|
| [install](https://github.com/o/r/actions/runs/1/job/11) | ✅ | 1 m 44 s |
| [unit](https://github.com/o/r/actions/runs/1/job/12) | ✅ | 9 m 19 s |
| [harness](https://github.com/o/r/actions/runs/1/job/13) | ✅ | 13 m 45 s |
| … | | |

</details>

<details><summary><b>Attestations</b>: 2 verified</summary>

| Artifact | Subject digest | Provenance |
|---|---|---|
| `sbom.json` | `sha256:a1…9f` | ✅ verified · signed by this repository's workflow `ci.yml` at `abc1234` |
| `gate image` | `sha256:7c…02` | ✅ verified |

</details>

<sub>Toolchain: @mmmnt/feature 0.10.0 · feat-runtime 0.6.0 · evidence feat-evidence/2 · digests in the uploaded bundles. Updated on every run; this comment is replaced, never duplicated.</sub>

---

### What a failing run looks like (same comment, replaced)

<!-- feat-pr-report -->
## ❌ Build report — 1 scenario failed

**PR #7** · head `def5678` · run [#1483](https://github.com/o/r/actions/runs/2)

| | Result |
|---|---|
| Specs | **47 / 48 passed** · **1 failed** (integration tier) |
| CI jobs | **8 / 9 succeeded** · harness failed |
| Attestations | 2 / 2 verified |

**What failed**

> **SPEC-MEM-022 SearchEvents** — integration tier — *"a trailing '?' is punctuation, not a wildcard"*
>
> | Prediction | Expected | Observed |
> |---|---|---|
> | response OK `items` | 1 entry containing "kafka" | 0 entries |

<sub>The check `feat report` is marked failed with the same summary.</sub>
