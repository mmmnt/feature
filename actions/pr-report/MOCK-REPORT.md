<!-- Rendered by fixtures/probe.mjs (SPEC-PRR-001 as amended 2026-11-17): a passing pull request, a pull request whose SBOM was not produced, and main after the merge. -->

<!-- feat-pr-report -->
## ✅ PR #7 — verified

Head `9f2c41d8a07e5b3c6d1f0e2a4b8c7d9e1f3a5b6c` · built `refs/pull/7/merge` @ `c0ffee12a3b4c5d6e7f8091a2b3c4d5e6f708192` · run [1](https://github.com/<owner>/<repo>/actions/runs/1/attempts/1)

### Tests

| Tier | Specs | Scenarios | Evidence bundle |
|---|---|---|---|
| unit | 2 | ✅ 12 / 12 | `sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae` |
| integration | 2 | ✅ 12 / 12 | `sha256:fcde2b2edba56bf408601fb721fe9b5c338d10ee429ea04fae5511b68fbf8fb9` |
| CI jobs | — | ✅ 4 / 4 | — |

### Attestations

| Artifact | Subject digest | Signature | Key | Signer | Source commit | |
|---|---|---|---|---|---|---|
| `SBOM` | `sha256:3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b` | `sha256:29356bdc46d0ab18535ed914ea4fd7e31dd87fab2b18fbc1138a2185883aaf90` | `sha256:18a0c88f7df4a69a62bd0da7af6b6a4c6e882a86cc0b1f634068e57cb7ce98f7` | `ci.yml@refs/pull/7/merge` | `c0ffee12a3b4c5d6e7f8091a2b3c4d5e6f708192` | ✅ |

### Chain

| Check | |
|---|---|
| Built commit's parents = base `4e1a9c3b7d2f6e0a8c5b1d9f3e7a2c6b0d4f8e1a` + head `9f2c41d8a07e5b3c6d1f0e2a4b8c7d9e1f3a5b6c` | ✅ |
| `SBOM` signature verifies | ✅ |
| `SBOM` source commit `c0ffee12a3b4c5d6e7f8091a2b3c4d5e6f708192` = built commit `c0ffee12a3b4c5d6e7f8091a2b3c4d5e6f708192` | ✅ |
| `SBOM` signer = this repository's workflow at `refs/pull/7/merge` | ✅ |
| `SBOM` signed by the repository's key `sha256:18a0c88f7df4a69a62bd0da7af6b6a4c6e882a86cc0b1f634068e57cb7ce98f7` | ✅ |

<details><summary>Verify</summary>

```sh
cosign verify-attestation --key ci/signing/flmnt.pub --insecure-ignore-tlog --type slsaprovenance1 ghcr.io/<owner>/<repo>-sbom@sha256:3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b
```

</details>

---

<!-- feat-pr-report -->
## ❌ PR #7 — incomplete: SBOM not produced (job build)

Head `9f2c41d8a07e5b3c6d1f0e2a4b8c7d9e1f3a5b6c` · built `refs/pull/7/merge` @ `c0ffee12a3b4c5d6e7f8091a2b3c4d5e6f708192` · run [1](https://github.com/<owner>/<repo>/actions/runs/1/attempts/1)

### Tests

| Tier | Specs | Scenarios | Evidence bundle |
|---|---|---|---|
| unit | 2 | ✅ 12 / 12 | `sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae` |
| CI jobs | — | ✅ 4 / 4 | — |

### Attestations

| Artifact | Subject digest | Signature | Key | Signer | Source commit | |
|---|---|---|---|---|---|---|
| `SBOM` | not produced (job build) | — | — | — | — | ❌ |

### Chain

| Check | |
|---|---|
| Built commit's parents = base `4e1a9c3b7d2f6e0a8c5b1d9f3e7a2c6b0d4f8e1a` + head `9f2c41d8a07e5b3c6d1f0e2a4b8c7d9e1f3a5b6c` | ✅ |

---

<!-- feat-pr-report -->
## ✅ main `5e8d1f2a3b4c5d6e7f8091a2b3c4d5e6f7081a2b` — verified

Merged PR #7 · head `9f2c41d8a07e5b3c6d1f0e2a4b8c7d9e1f3a5b6c` · tested `c0ffee12a3b4c5d6e7f8091a2b3c4d5e6f708192` · PR run [44153523061](https://github.com/<owner>/<repo>/actions/runs/44153523061) · main run [1](https://github.com/<owner>/<repo>/actions/runs/1/attempts/1)

### Tests

| Tier | Specs | Scenarios | Evidence bundle |
|---|---|---|---|
| unit | 2 | ✅ 12 / 12 | `sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae` |
| CI jobs | — | ✅ 4 / 4 | — |

### Attestations

| Artifact | Subject digest | Signature | Key | Signer | Source commit | |
|---|---|---|---|---|---|---|
| `SBOM` | `sha256:3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b` | `sha256:29356bdc46d0ab18535ed914ea4fd7e31dd87fab2b18fbc1138a2185883aaf90` | `sha256:18a0c88f7df4a69a62bd0da7af6b6a4c6e882a86cc0b1f634068e57cb7ce98f7` | `ci.yml@refs/pull/7/merge` | `c0ffee12a3b4c5d6e7f8091a2b3c4d5e6f708192` | ✅ |
| `SBOM` | `sha256:9b74c9897bac770ffc029102a200c5de2a4c2a6c2d1e3f4a5b6c7d8e9f0a1b2c` | `sha256:29356bdc46d0ab18535ed914ea4fd7e31dd87fab2b18fbc1138a2185883aaf90` | `sha256:18a0c88f7df4a69a62bd0da7af6b6a4c6e882a86cc0b1f634068e57cb7ce98f7` | `ci.yml@refs/heads/main` | `5e8d1f2a3b4c5d6e7f8091a2b3c4d5e6f7081a2b` | ✅ |

### Chain

| Check | |
|---|---|
| PR `SBOM` source commit = tested `c0ffee12a3b4c5d6e7f8091a2b3c4d5e6f708192` | ✅ |
| main `SBOM` source commit `5e8d1f2a3b4c5d6e7f8091a2b3c4d5e6f7081a2b` = main `5e8d1f2a3b4c5d6e7f8091a2b3c4d5e6f7081a2b` | ✅ |
| `SBOM` signed by the repository's key `sha256:18a0c88f7df4a69a62bd0da7af6b6a4c6e882a86cc0b1f634068e57cb7ce98f7` | ✅ |
| Evidence stored `ghcr.io/<owner>/<repo>-evidence@sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae` | ✅ |
| Merge statement signature `sha256:e3b98a4da31a127d4bde6e43033f66ba274cab0eb7eb1c70ec41402bf6273dd8` | ✅ |

<details><summary>Verify</summary>

```sh
cosign verify-attestation --key ci/signing/flmnt.pub --insecure-ignore-tlog --type slsaprovenance1 ghcr.io/<owner>/<repo>-sbom@sha256:9b74c9897bac770ffc029102a200c5de2a4c2a6c2d1e3f4a5b6c7d8e9f0a1b2c
cosign verify-attestation --key ci/signing/flmnt.pub --insecure-ignore-tlog --type https://feature.mmmnt.dev/attestation/pr-merge/v2 ghcr.io/<owner>/<repo>-sbom@sha256:9b74c9897bac770ffc029102a200c5de2a4c2a6c2d1e3f4a5b6c7d8e9f0a1b2c
```

</details>
