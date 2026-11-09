// A recording stub for the harness probe (SPEC-RT-002). Every adapter in the fixture configs is this
// module: it appends each call it receives to one shared log and answers what its options say.
// Options: clock (bool, offers setClock), observes ({diff,state}, absent = a legacy adapter),
// state (records read() answers).

const log = () => (globalThis.__featHarnessProbe ??= { calls: [], readHint: undefined });
const note = (s) => log().calls.push(s);
const hint = (q) =>
  (q?.expect ?? [])
    .map((e) => `${e.type}:${Object.entries(e.key ?? {}).map(([k, v]) => `${k}=${v}`).join(",")}`)
    .join(" ");

let opened = false; // true once any service opened its capture window in this case

export function createAdapter(config) {
  const key = config.key ?? "response";
  const o = config.key === undefined ? (config.invoke ?? {}) : (config.options ?? {});
  const adapter = {};
  if (o.observes !== undefined) adapter.observes = o.observes;
  if (o.clock === true) adapter.setClock = async (c) => note(`clock:${key}=${c}`);
  if (config.key === undefined) {
    // the response adapter
    adapter.setup = async () => {};
    adapter.teardown = async () => {};
    adapter.invoke = async (command) => {
      note(`${opened ? "invoke" : "execute"}:${command}`);
      return { status: "OK", body: {} };
    };
    return adapter;
  }
  adapter.setup = async () => {};
  adapter.teardown = async () => {};
  adapter.reset = async () => {
    opened = false;
    note(`reset:${key}`);
  };
  adapter.seed = async () => note(`seed:${key}`);
  adapter.startCapture = async () => {
    opened = true;
    note(`start:${key}`);
  };
  adapter.stopCapture = async () => {
    note(`stop:${key}`);
    return [];
  };
  adapter.read = async (query) => {
    note(`read:${key}`);
    log().readHint = hint(query);
    return o.state ?? [];
  };
  return adapter;
}
