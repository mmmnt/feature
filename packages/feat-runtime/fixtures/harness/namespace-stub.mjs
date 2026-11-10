// Recording stub for the namespace probe (SPEC-RT-006): remembers the namespace each adapter was created
// with, and plays the part of a spec host (hostKind protocol: validates its setup result like the
// Feat Host Protocol adapter; in-process: a handler adapter with reportedNamespace()).
const state = () => (globalThis.__featNamespaceProbe ??= { trace: [], hostKind: undefined, hostEcho: "ok" });
const PATTERN = /^s[0-9a-f]{12}$/;

export function createAdapter(config) {
  const st = state();
  const role = config.key ?? "response";
  st.trace.push(`create:${role} ns=${config.namespace}`);
  const a = {
    setup: async () => {},
    teardown: async () => {},
    reset: async () => {},
    startCapture: async () => {},
    stopCapture: async () => [],
    read: async () => [],
    invoke: async () => ({ status: "OK", body: {} }),
  };
  if (role !== "response" && st.serviceEcho === "other") a.reportedNamespace = () => "s000000000000";
  if (role !== "response" || st.hostKind === undefined) return a;
  const echoed = () =>
    ({ ok: config.namespace, other: "s000000000000", malformed: "NOT-A-NAMESPACE", none: undefined })[st.hostEcho];
  if (st.hostKind === "protocol") {
    let echo;
    a.setup = async () => {
      echo = echoed();
      if (echo === undefined || !PATTERN.test(echo))
        throw Object.assign(new Error(`setup result: namespace ${echo === undefined ? "missing" : `malformed (${echo})`}; the protocol requires ${PATTERN}`), { code: "PROTOCOL_VIOLATION" });
    };
    a.reportedNamespace = () => echo;
  } else {
    a.reportedNamespace = () => echoed();
  }
  return a;
}
