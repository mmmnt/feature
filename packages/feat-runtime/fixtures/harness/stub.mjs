// A recording stub for the harness probe (SPEC-RT-002). Every adapter in the fixture configs is this
// module: it appends each call it receives to one shared log and answers what its options say.
// Options: clock (bool, offers setClock), observes ({diff,state}, absent = a legacy adapter),
// state (records read() answers), faults (its catalog; absent = no fault() at all), observed (offers
// firedFaults(); default true). The response stub's Ping { appends: n } makes n calls of AppendToStream
// on the `store` service stub, each answering ok or the name of the fault that was consumed.
// Ping { hold: true } blocks inside invoke until the probe calls the shared log's release() (SPEC-RT-007).

const log = () => (globalThis.__featHarnessProbe ??= { calls: [], readHint: undefined });
const note = (s) => log().calls.push(s);
const hint = (q) =>
  (q?.expect ?? [])
    .map((e) => `${e.type}:${Object.entries(e.key ?? {}).map(([k, v]) => `${k}=${v}`).join(",")}`)
    .join(" ");

const stores = () => (log().stores ??= new Map());
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
    adapter.invoke = async (command, input) => {
      note(`${opened ? "invoke" : "execute"}:${command}`);
      if (input?.hold === true) await new Promise((resolve) => (log().release = resolve));
      for (let i = 0; i < (input?.appends ?? 0); i++) stores().get("store")?.consume("AppendToStream");
      return { status: "OK", body: {} };
    };
    return adapter;
  }
  adapter.setup = async () => {};
  adapter.teardown = async () => {};
  let armed = [];
  stores().set(key, {
    consume(operation) {
      const f = armed.find((a) => a.operation === operation && a.remaining > 0);
      if (f) {
        f.remaining -= 1;
        f.fired += 1;
      }
      note(`consume:${key}=${operation}:${f ? f.fault : "ok"}`);
    },
  });
  if (o.faults !== undefined) {
    adapter.faults = o.faults;
    adapter.fault = async (arm) => {
      note(`arm:${key}=${arm.operation}/${arm.fault}/${arm.times}`);
      if (arm.detail !== undefined)
        log().armedDetail = Object.entries(arm.detail).map(([k, v]) => `${k}=${v}`).join(",");
      armed.push({ ...arm, remaining: arm.times === "reset" ? Infinity : arm.times, fired: 0 });
    };
    if (o.observed !== false)
      adapter.firedFaults = async () => {
        note(`fired:${key}`);
        return armed.filter((a) => a.fired > 0).map((a) => ({ operation: a.operation, fault: a.fault, count: a.fired }));
      };
  }
  adapter.reset = async () => {
    armed = [];
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
