# @mmmnt/feat-adapter-redis — design notes

SPEC-ADPRDS-001, agreed in advance by founder ruling a78f0662 (HELD-78, "Build the adapter").

- **No change feed.** Redis keyspace notifications are pub/sub messages: fire-and-forget, delivered only to a client
  subscribed at that moment, and carrying the key and the command but no value. A window can't be read back from
  them, so the diff is a snapshot comparison (SCAN of `<ns>:*`, each key read by its type), as the Neo4j adapter does
  on Community. It is exact for what is there at the end and blind to a key created and removed inside the window.
- **Namespace = key prefix `<ns>:`.** The runner's namespace (SPEC-RT-006). The system under test writes its keys under
  the prefix; the adapter strips it from what it reports. Keys without it are nobody's effect.
- **Kinds.** string, set (sorted), hash (fields sorted), list (in order), zset ({ member, score } in score order).
  Any other type (stream, module types) is KIND_UNSUPPORTED rather than silently skipped. The client speaks RESP3, so
  hash and zset replies are normalised from either RESP2 or RESP3 shapes.
- **settle.** Redis executes one command at a time; a command the system has had answered is applied before the
  instrument's next read. So settle is true with a window open and false without one. It cannot see a write the
  system has not sent yet (an asynchronous projection), which is the harness's settle budget's business.
- **Faults.** None. Every Redis-level fault (CONFIG, ACL, CLIENT PAUSE, maxmemory) is server-wide and would fault every
  other namespace's run on a shared server. The catalog is empty; any arm is FAULT_UNSUPPORTED.
- **Credentials from files.** url/urlEnv/urlFile, auth `{ username?, password }` (variable names) or
  `{ user, passwordFile }`, `tlsCAFile` with rediss://. Files are read at setup before any connection, one trailing
  LF/CRLF removed (the CA file as is). The password is passed to the client apart from the URL, and a URL carrying
  credentials is refused, so no percent-decoding of user info is involved.
- **TLS, proven live** (founder ruling 2026-11-15, "Add TLS test now"): the probe mints a throwaway CA and a server
  certificate for 127.0.0.1 with @peculiar/x509 (dev dependency, fixtures only) and starts a TLS-only Redis with them;
  a connection verified against `tlsCAFile` succeeds, and one against another CA is refused at setup.
- **The file form of auth names its user** (founder ruling 2026-11-15, "Require a user"), as SPEC-ADPNEO-003's does;
  a requirepass server's user is `default`.
