<!-- feat-pr-report -->
## ✅ PR #7 — verified

Head `9f2c41d8a07e5b3c6d1f0e2a4b8c7d9e1f3a5b6c` · built `refs/pull/7/merge` @ `c0ffee12a3b4c5d6e7f8091a2b3c4d5e6f708192` · run [44153523061](https://github.com/mmmnt/flmnt/actions/runs/44153523061/attempts/1)

### Tests

| Tier | Specs | Scenarios | Evidence bundle |
|---|---|---|---|
| Unit | 12 | ✅ 36 / 36 | `sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae` |
| Integration | 6 | ✅ 12 / 12 | `sha256:fcde2b2edba56bf408601fb721fe9b5c338d10ee429ea04fae5511b68fbf8fb9` |
| CI jobs | — | ✅ 9 / 9 | — |

### Attestations

| Artifact | Digest | Signer | Source commit | Rekor | |
|---|---|---|---|---|---|
| `flmnt-sbom.cdx.json` | `sha256:3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b` | `ci.yml@refs/pull/7/merge` | `c0ffee12a3b4c5d6e7f8091a2b3c4d5e6f708192` | `871204553` | ✅ |
| gate image | `sha256:7c5d2b0e9a41f6e3c8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f602` | `gate-image.yml@refs/heads/main` | `4e1a9c3b7d2f6e0a8c5b1d9f3e7a2c6b0d4f8e1a` | `871190127` | ✅ |

### Chain

| Check | |
|---|---|
| Built commit's parents = base `4e1a9c3b7d2f6e0a8c5b1d9f3e7a2c6b0d4f8e1a` + head `9f2c41d8a07e5b3c6d1f0e2a4b8c7d9e1f3a5b6c` | ✅ |
| SBOM source commit = built commit | ✅ |
| Signer = `mmmnt/flmnt` `ci.yml`, issuer GitHub Actions | ✅ |
| Gate image digest = `ci/images.lock.json` | ✅ |

<details><summary>Verify</summary>

```sh
gh run download 44153523061 -R mmmnt/flmnt -n flmnt-sbom
gh attestation verify flmnt-sbom.cdx.json -R mmmnt/flmnt \
  --signer-workflow mmmnt/flmnt/.github/workflows/ci.yml \
  --source-digest c0ffee12a3b4c5d6e7f8091a2b3c4d5e6f708192
```

</details>

---

**After merge**, one line is added:

> Merged as `5e8d1f2a3b4c5d6e7f8091a2b3c4d5e6f7081a2b` · merge attestation `sha256:e3b98a4da31a127d4bde6e43033f66ba274cab0eb7eb1c70ec41402bf6273dd8` · Rekor `871322019` ✅ · [main report](https://github.com/mmmnt/flmnt/commit/5e8d1f2a3b4c5d6e7f8091a2b3c4d5e6f7081a2b/checks)

**On failure**, the header and the failing row change:

> ## ❌ PR #7 — SBOM source commit ≠ built commit
>
> | Check | |
> |---|---|
> | SBOM source commit `0badc0de1a2b3c4d5e6f708192a3b4c5d6e7f809` = built commit `c0ffee12a3b4c5d6e7f8091a2b3c4d5e6f708192` | ❌ |

<sub>Sample data.</sub>
