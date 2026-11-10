# BrokerLoss runs serially — options and recommendation (DRAFT)

Ruling (Sift decision c7af7871): BrokerLoss runs serially. BrokerLoss pauses a product container that
every namespace and every parallel spec file shares, so a file that arms it fails unrelated files.
Namespaces isolate data, not availability.

| Option | How | Verdict |
| --- | --- | --- |
| Tag (`@serial` on a spec or scenario) | needs a grammar/IR change for tags (not in the grammar today) and the author must remember it | no: forgettable, and a grammar change |
| Separate spec pattern (`**/*.serial.feat` run second with one worker) | pure convention; a BrokerLoss scenario in an ordinary file runs in parallel and breaks neighbours silently | no alone |
| Lock (file or container-name lock taken by `arm(BrokerLoss)`) | serialises only BrokerLoss users against each other; an ordinary file running at the same time against the same product still fails | no: protects the wrong party |
| **Swept partition (recommended)** | `EXCLUSIVE_FAULTS = ["BrokerLoss"]` in feat-types; `feat run` reads the IR it already parses, puts every file that arms one into a second vitest run with one worker after the parallel pass; the harness preflight additionally refuses an exclusive fault when `FEAT_SERIAL` is not 1 (`FAULT_REQUIRES_SERIAL`) | **yes** |

Why: it sweeps instead of enumerating (nothing to keep in sync), needs no grammar change, needs no
naming convention, and fails closed (the preflight refuses a mis-routed run). The cost is a second
vitest invocation when any exclusive file exists, and file granularity: a file with one BrokerLoss
scenario waits whole, so the product specs keep BrokerLoss in `broker-loss.feat`. Specs:
SPEC-RT-005 (`drafts/adapter-interface/packages/feat-runner/serial-faults.feat`), SPEC-ADPKUR-003,
SPEC-ADPKFK-003. Open: other exclusive faults added later go into the same constant.
