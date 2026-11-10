# Protocol impact of the runner namespace (SPEC-RT-006) on the Feat Host Protocol — list only

Nothing in this directory is edited by this note. Changes the namespace ruling (c7af7871 item 2) implies:

1. `schemas/feat-host-protocol.schema.json`: `requests.setup` gains a required `namespace` string
   (pattern `^s[0-9a-f]{12}$`, ruling a59656b7; closed params stay closed).
2. `results.setup` gains a required `namespace` string: the host echoes the namespace it is running under.
   The adapter compares it with the one it sent and fails setup with `NAMESPACE_NOT_HONOURED` (SPEC-RT-006)
   before any case; a host that does not echo is a protocol violation (result closed shape).
3. `setup` is additive per role (ADR decision 3); every role of the file sends the same value, the host
   keeps the first and answers `-32602` to a later role that sends a different one.
4. `reset` does not change the namespace; `teardown` forgets it only when the last role leaves.
5. Host obligation (Sift side): apply the namespace to every key, stream, topic, label, alias or tag it
   writes, in the product-specific forms of drafts/product-adapters (`<ns>.` stream and topic prefix,
   `<ns>#` partition key prefix, `ns_<ns>` node label, `feat:namespace` tag or `alias/<ns>/`).
6. Conformance suite (decision 10): add cases for setup with and without namespace, with a bad pattern,
   the echo, and a second role with a different value.
7. `fault` method: unaffected, but its `kind` vocabulary may now carry the `Connection` pseudo-operation
   only through product adapters, never through the host; no change.
8. Host registry (decision 7): the key (command, cwd, env) must not include the namespace; one host per
   file already means one namespace per host. `FEAT_NAMESPACE` is also placed in the host's environment at
   spawn as a convenience; the `setup` value is authoritative.
9. ADR text: decision 3 (`setup {services}`) and the Consequences list need one sentence each.
10. Version: adding required fields to `setup` is a breaking protocol change; bump the protocol version
    with the rename, since nothing has shipped.
